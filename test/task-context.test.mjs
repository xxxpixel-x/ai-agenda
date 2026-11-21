import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer } from '../src/app-server.mjs';
import { openMemory } from '../src/memory/store.mjs';
import { recordPlanDecisions } from '../src/memory/organize.mjs';
import { t as tr, withLanguage } from '../src/i18n.mjs';
import { keyRule } from '../src/prompts.mjs';
import { plannerSystem, plannerPrompt, reviewerPrompt, workerPrompt, summaryPrompt, triagePrompt, commitPrompt } from '../src/task-prompts.mjs';
import { isMemoryCall, MEMORY_IDLE, testInChinese as test, tempDir, until } from './helpers.mjs';

const members = [{ id: 'member-a', name: 'Alice', engine: 'claude-code', engineLabel: 'Claude' },
  { id: 'member-b', name: 'Bob', engine: 'codex', engineLabel: 'Codex' }];
const host = { members, access: 'edit' };
const task = (id, title, deps, assigneeId) => ({ id, title, deps, assigneeId, spec: 'Build ' + title, status: 'approved', attempts: [], changes: [] });

test('worker and coordinator prompts have a stable prefix, one-session plans and cited dependency reports in both languages', () => {
  for (const lang of ['zh', 'en']) withLanguage(lang, () => {
    const first = task('T1', 'Index', [], members[0].id), mine = task('T2', 'Search', ['T1'], members[1].id);
    first.attempts = [{ error: 'failed', report: 'obsolete implementation' }, { outcome: 'done', report: 'approved implementation ' + 'Z'.repeat(2000) + ' report tail' },
      { outcome: 'stopped', report: 'aborted version' }];
    const run = { tasks: [first, mine], mode: 'direct', objective: 'Original request', assumptions: ['Offline'], status: 'executing' };
    const calls = [
      (key) => workerPrompt(host, run, mine, { key, memory: 'Team memory', files: [{ path: 'readme', content: 'file contents' }], maxDepReport: 120 }),
      (key) => plannerPrompt(run, { key, previous: run.tasks, memory: 'Team memory' }),
      (key) => reviewerPrompt(run, run.tasks, { key, memory: 'Team memory' }),
      (key) => summaryPrompt(host, run, { key, memory: 'Team memory' }),
      (key) => triagePrompt(host, run, 'Next?', { key, memory: 'Team memory' }),
      (key) => commitPrompt(run, { key, summary: 'Finished', commits: ['first commit'], files: [{ path: 'readme' }] }),
    ];
    for (const [i, make] of calls.entries()) {
      const a = make('key-a'), before = a.split(keyRule('key-a'))[0];
      assert.equal(before, make('key-b').split(keyRule('key-b'))[0]);
      assert.ok(before.length > 0);
      assert.match(before, i === 5 ? /Finished/ : /Team memory/);
      assert.ok(!/<(?:消息|message) /.test(before));
      assert.ok(a.indexOf(keyRule('key-a')) < a.indexOf(tr('# 总目标\n{0}', [''])));
      if (lang === 'en') assert.doesNotMatch(a, /[\u3400-\u9fff]/);
    }
    const worker = calls[0]('key-a');
    const fixed = worker.split(keyRule('key-a'))[0];
    for (const text of ['Build Search', 'approved implementation', 'file contents', 'T1', 'T2']) assert.ok(fixed.includes(text));
    assert.doesNotMatch(worker, /obsolete implementation|aborted version|report tail/);
    assert.match(fixed, lang === 'zh' ? /任务 T1 第 2 次执行/ : /task T1, attempt 2/);
    assert.match(fixed, lang === 'zh' ? /更早的 1 个版本已被取代/ : /preceding 1 versions are superseded/);
    assert.match(plannerSystem(host, run, members[0]), lang === 'zh' ? /一个会话就能做完/ : /in a single session/);
  });
});

test('answered, defaulted and assumed plan decisions are idempotent across replans and reopening', (t) => {
  const dir = tempDir(t);
  const run = { clarify: { resolvedAt: 123, questions: [{ id: 'a', text: 'Which? ' }, { id: 'b', text: 'Color?', default: 'Blue' },
    { id: 'c', text: 'Icon?' }], answers: { a: 'Maple' } }, assumptions: ['Color：按默认处理（Blue）', 'Use SQLite'] };
  const memory = openMemory(dir);
  recordPlanDecisions(memory, run);
  recordPlanDecisions(openMemory(dir), run);
  const entries = memory.entries();
  assert.deepEqual(entries.map((e) => e.text), ['Which：Maple', 'Color：按默认处理（Blue）', 'Icon：按默认处理', 'Use SQLite']);
  assert.deepEqual(entries.map((e) => e.origin), ['user', 'default', 'default', 'default']);
  for (const e of entries) {
    assert.equal(e.type, 'decision');
    assert.deepEqual(e.source.tasks, ['plan']);
    assert.ok(e.reason);
  }
  assert.equal(entries[0].at, 123);
});

test('auto planning records decisions before dispatch, workers and coordinators expose their actual context over HTTP', async (t) => {
  const dataDir = tempDir(t);
  const server = await startServer({ port: 0, dataDir, mock: true });
  t.after(() => server.close());
  const call = async (url, method = 'GET', body) => {
    const r = await fetch('http://127.0.0.1:' + server.port + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  await call('/api/settings', 'PUT', { language: 'zh' });
  const workers = [], planners = [];
  const hold = Promise.withResolvers();
  const tasks = [task('T1', 'Index', [], members[0].id), task('T2', 'Search', ['T1'], members[1].id)];
  server.registry.runTurn = async (_engine, opts) => {
    if (isMemoryCall(opts)) return MEMORY_IDLE;
    if (opts.system.includes('这次任务协作的协调者')) {
      planners.push(opts);
      if (planners.length === 1) return { text: JSON.stringify({ questions: [{ id: 'a', text: '语言？' }, { id: 'b', text: '配色？', default: '蓝色' }] }) };
      return { text: JSON.stringify({ tasks, assumptions: ['允许离线使用'] }) };
    }
    if (opts.system.includes('子任务 T2')) {
      workers.push(opts);
      if (workers.length === 1) {
        opts.onDelta('discarded partial');
        throw new Error('maximum context length exceeded');
      }
      await hold.promise;
    }
    return { text: 'Built index.\n结果：完成' };
  };
  const created = await call('/api/spaces', 'POST', { kind: 'task', objective: 'Build search', members, clarify: true, planConfirm: 'auto', discuss: false, autoApprove: true });
  assert.equal(created.status, 201);
  const url = '/api/spaces/' + created.data.id;
  await until(async () => (await call(url)).data.run.status, (s) => s === 'clarifying');
  const mem = openMemory(path.join(dataDir, 'spaces', created.data.id, 'memory'));
  mem.append([{ type: 'constraint', text: 'No network', source: {} }, { type: 'preference', text: 'Per-worker preference', scope: 'T2', source: {} },
    { type: 'fact', text: 'Search uses SQLite', source: {} }]);
  const resolution = await call(url + '/run/clarify-answer', 'POST', { answers: { a: 'English' } });
  assert.equal(resolution.status, 200);
  await until(() => workers.length, (n) => n === 2);
  assert.match(planners.at(-1).prompt, /# 空间记忆库[\s\S]*No network/);
  const worker = workers[0];
  assert.deepEqual(worker.readOnlyDirs, [mem.dir]);
  assert.match(worker.prompt, /### 全员都要遵守[\s\S]*语言：English[\s\S]*配色：按默认处理（蓝色）[\s\S]*允许离线使用[\s\S]*### 你的子任务 T2[\s\S]*Per-worker preference[\s\S]*### 前置任务的结果[\s\S]*### 相关[\s\S]*Search uses SQLite/);
  const busy = await call(url + '/members/' + members[1].id + '/handoff', 'POST');
  assert.equal(busy.status, 409);
  hold.resolve();
  await until(async () => (await call(url)).data.run.status, (s) => s === 'done');
  const view = (await call(url + '/context')).data;
  for (const m of members) {
    const context = view.members[m.id];
    assert.equal(context.mode, 'stateless');
    assert.ok(context.lastTurnAt > 0);
    assert.ok(context.breakdown.system.tokens > 0);
    assert.ok(context.breakdown.memory.entryIds.length >= 1);
  }
  const learned = (await call('/api/settings')).data.contextLimits;
  assert.ok(learned['codex:default'] < 272000);
  assert.doesNotMatch(workers[1].prompt, /discarded partial/);
  const detail = (await call(url + '/task/T2')).data;
  assert.equal(detail.attempts.length, 1);
  assert.doesNotMatch(detail.attempts[0].text, /discarded partial/);
});

