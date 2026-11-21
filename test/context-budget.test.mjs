import assert from 'node:assert/strict';
import path from 'node:path';
import { estimateTokens, limitKeyFor, contextWindowFor, isContextLengthError } from '../src/context.mjs';
import { buildTurnContext } from '../src/prompts.mjs';
import { importBlocks } from '../src/imports.mjs';
import { openMemory } from '../src/memory/store.mjs';
import { createSettings } from '../src/settings.mjs';
import { runTurn as mockTurn } from '../src/engines/mock.mjs';
import { runAgentTurn } from '../src/turn-runner.mjs';
import { testInChinese as test, isMemoryCall, MEMORY_IDLE, makeSpace, tempDir, until, settleSpace } from './helpers.mjs';

const member = { id: 'member-a', engine: 'codex', name: 'Alice' };
const chat = (messages) => ({ title: 'Notes', members: [member], messages });

test('token estimation counts Unicode code points and Han, with learned and provider overrides', () => {
  for (const [text, expected] of [['', 0], [null, 0], ['汉字', 2], ['abcde', 2], ['汉🙂abc', 2], ['𠀀一A', 3]]) {
    assert.equal(estimateTokens(text), expected);
  }
  for (const [model, window] of [['CLAUDE-Fable', 200000], ['Gemini-3', 1000000], ['o3-mini', 200000],
    ['gpt-5-codex', 272000], ['gpt-4.1-mini', 1000000], ['gpt-4-turbo', 128000], ['gpt-4o-mini', 128000],
    ['deepseek-chat', 128000], ['qwen', 128000], ['moonshot', 128000], ['other', 64000]]) {
    assert.equal(contextWindowFor({ engine: 'api', model }), window, model);
  }
  for (const [engine, window] of [['dsh', 128000], ['gemini-cli', 1000000], ['codex', 272000], ['claude-code', 200000]]) {
    assert.equal(contextWindowFor({ engine }), window);
  }
  const provider = { id: 'p1', model: 'Kimi', contextWindow: 50000 };
  assert.equal(limitKeyFor(member, provider), 'provider:p1:Kimi');
  assert.equal(contextWindowFor(member, { provider }), 50000);
  assert.equal(contextWindowFor(member, { provider, learnedLimits: { 'provider:p1:Kimi': 16000 } }), 16000);
  assert.equal(limitKeyFor(member), 'codex:default');
  for (const e of [new Error('maximum context length exceeded'), new Error('超出上下文'), { contextOverflow: true }]) assert.ok(isContextLengthError(e));
  assert.ok(!isContextLengthError(new Error('network timeout')));
});

test('old imports condense individually before stepped history, memory, then files', (t) => {
  const memory = openMemory(path.join(tempDir(t), 'memory'));
  memory.append([{ type: 'decision', text: '规定'.repeat(130), source: { tasks: ['plan'] } }]);
  const imported = (id) => ({ kind: 'import', id, name: 'AI', title: id, sourceLabel: 'Archive', summary: id + '-summary',
    entries: [{ role: 'user', text: id + '-verbatim' + '字'.repeat(1000), acts: [] }] });
  const blocks = importBlocks([imported('old'), imported('new')]);
  assert.ok(!blocks[0].summaryText.includes('old-verbatim'));
  assert.ok(importBlocks([{ ...imported('doc'), summary: '', handoff: 'notes.md' }])[0].summaryText.includes('notes.md'));
  const excerpt = importBlocks([{ ...imported('full'), summary: '' }])[0];
  assert.ok(excerpt.summaryText.length < excerpt.fullText.length);
  const space = chat(Array.from({ length: 13 }, (_, i) => ({ kind: 'user', seq: i + 1, text: '第' + i + ' ' + '字'.repeat(120) })));
  const opts = { system: 'system', memory, importBlocks: blocks, recap: '消息 1 有过讨论', files: [{ path: 'a.md', content: '附'.repeat(500) }], api: true };
  const build = (tokenBudget) => buildTurnContext(space, member, { ...opts, tokenBudget });
  const full = build(10000);
  const size = (ctx) => estimateTokens(ctx.system) + estimateTokens(ctx.prompt);
  const condensed = build(size(full) - 500);
  assert.match(condensed.prompt, /old-summary/);
  assert.doesNotMatch(condensed.prompt, /old-verbatim/);
  assert.match(condensed.prompt, /new-verbatim/);
  assert.equal(condensed.breakdown.omitted.count, 0);
  const history = build(size(full) - 2100);
  assert.equal(history.meta.omittedSeq, 10);
  assert.equal(history.breakdown.recent.count, 3);
  assert.ok(history.prompt.indexOf('# 前情提要') < history.prompt.indexOf('# 聊天记录'));
  assert.deepEqual(history.breakdown.memory.entryIds, [1]);
  assert.equal(history.breakdown.files.tokens, full.breakdown.files.tokens);
  const minimal = build(950);
  assert.equal(minimal.breakdown.recent.count, 1);
  assert.deepEqual(minimal.breakdown.memory.entryIds, []);
  assert.equal(minimal.breakdown.files.chars, full.breakdown.files.chars);
  const tiny = build(520);
  assert.doesNotMatch(tiny.prompt, /附{500}/);
  assert.match(tiny.prompt, /第12/);
  assert.ok(size(tiny) <= 520);
});

test('API original lookup uses both archived and live messages, while file readers get a directory hint', (t) => {
  const memory = openMemory(path.join(tempDir(t), 'memory'));
  memory.append([{ type: 'constraint', text: 'Always test', source: {} },
    { type: 'fact', text: 'Widget uses maple', source: { messages: [41] } },
    { type: 'question', text: 'Which branch?', source: { messages: [17] } }]);
  memory.archive([{ seq: 41, kind: 'user', text: 'archived original' }]);
  const space = chat([{ kind: 'user', seq: 17, text: 'live fallback' }, { kind: 'user', seq: 55, text: 'widget #3 消息 17' }]);
  const opts = { memory, memoryDir: memory.dir, recent: 1, recap: 'message 41', api: true };
  const api = buildTurnContext(space, member, opts);
  assert.match(api.prompt.split('# 相关原文')[1], /archived original/);
  assert.match(api.prompt.split('# 相关原文')[1], /live fallback/);
  assert.match(api.prompt, /Which branch/);
  assert.deepEqual(api.breakdown.memory.entryIds, [1, 2, 3]);
  assert.ok(!api.system.includes('Widget'));
  const cli = buildTurnContext(space, member, { ...opts, api: false });
  assert.ok(cli.prompt.includes(memory.dir));
  assert.doesNotMatch(cli.prompt, /archived original/);
  assert.match(cli.prompt, /messages\/<seq>\.md/);
  memory.append([{ type: 'decision', text: 'Use the new branch', supersedes: [1], source: {} }]);
  const resumed = buildTurnContext(space, member, { ...opts, since: 2, lastMemoryId: 3 });
  assert.doesNotMatch(resumed.prompt, /Always test/);
  assert.match(resumed.prompt, /#4 取代 #1/);
  assert.deepEqual(resumed.breakdown.memory.entryIds, [4]);
});

test('an oversized recap or single message stays within budget with a valid speaker envelope', () => {
  const space = chat([{ kind: 'ai', name: 'Alice', text: 'older', seq: 1 },
    { kind: 'user', text: 'first' + '字'.repeat(10000) + 'last', seq: 2 }]);
  const ctx = buildTurnContext(space, member, { tokenBudget: 500, system: 'rules', recap: '前情'.repeat(3000) });
  assert.ok(estimateTokens(ctx.prompt) + estimateTokens(ctx.system) <= 500);
  assert.equal(ctx.breakdown.recent.count, 1);
  assert.match(ctx.prompt, /<消息 来自="我">\nfirst[\s\S]*last\n<\/消息>/);
  assert.equal(ctx.meta.omittedSeq, 1);
});

test('overflow rebuilds once, discards partial output and persists the reduced model window', async (t) => {
  const space = makeSpace(tempDir(t), { members: [member] });
  t.after(() => settleSpace(space));
  const prompts = [];
  let fail = true;
  space.registry.runTurn = async (_engine, opts) => {
    if (isMemoryCall(opts)) return MEMORY_IDLE;
    prompts.push(opts.prompt);
    if (fail) {
      opts.onDelta('partial');
      fail = false;
      throw Object.assign(new Error('prompt is too long'), { contextOverflow: true });
    }
    return { text: 'complete' };
  };
  space.data.messages.push(...Array.from({ length: 18 }, (_, i) => ({ kind: 'user', seq: i + 1, text: '长'.repeat(500) })));
  space.data.nextSeq = 19;
  space.userMessage('finish');
  await until(() => space.running, (v) => !v);
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].length < prompts[0].length);
  assert.equal(space.data.messages.at(-1).text, 'complete');
  const learned = space.registry.settings.get().contextLimits['codex:default'];
  assert.ok(learned < 10000);
  assert.equal(createSettings(path.join(space.registry.settings.dir, 'settings.json')).get().contextLimits['codex:default'], learned);
  space.userMessage('continue');
  await until(() => space.running, (v) => !v);
  assert.ok(prompts[2].length < prompts[0].length);
  space.registry.runTurn = async (_engine, opts) => {
    if (isMemoryCall(opts)) return MEMORY_IDLE;
    prompts.push(opts.prompt);
    return mockTurn({ ...opts, prompt: '[TEST_CONTEXT_OVERFLOW]' });
  };
  space.userMessage('overflow again');
  await until(() => space.running, (v) => !v);
  assert.equal(prompts.length, 5);
  assert.match(space.data.messages.at(-1).error, /context_length_exceeded/);
});

test('the turn runner forwards session and read options and records up to five distinct commands', async () => {
  const sink = {};
  await runAgentTurn({ isApi: () => false, runTurn: (_, o) => {
    assert.deepEqual([o.keepSession, o.imported, o.readOnlyDirs], [true, false, ['/memory']]);
    for (const activity of [{ kind: 'edit', label: 'edit a' }, { kind: 'read' }, { kind: 'search' }, { kind: 'command' },
      { kind: 'command', label: '运行 npm test' }, { kind: 'command', label: 'Run npm test' },
      ...['x'.repeat(100), 'three', 'four', 'five', 'six'].map((command) => ({ kind: 'command', command }))]) o.onActivity(activity);
    return { text: 'done' };
  } }, member, { sink, keepSession: true, imported: false, readOnlyDirs: ['/memory'] });
  assert.deepEqual(sink.actions, ['npm test', 'x'.repeat(80), 'three', 'four', 'five']);
});

