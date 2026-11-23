import test from 'node:test';
import assert from 'node:assert/strict';
import { isMemoryCall, MEMORY_IDLE } from './helpers.mjs';
import { t } from '../public/i18n.js';
import { formatNotes, lineLabel, locateNotes, notesByMember, quoteLine } from '../public/js/notes-format.js';
import { startServer } from '../src/app-server.mjs';
import { apiRequest, beginTask, makeSpace, settleSpace, tempDir, until } from './helpers.mjs';
import { withLanguage } from '../src/i18n.mjs';

const zh = (key, args) => t(key, args, 'zh');
const en = (key, args) => t(key, args, 'en');
const note = (to, path, start, end, text) => ({ to, path, from: { start, end }, quote: '+example', text });

test('diff quotes preserve signs, blank lines and embedded backtick fences', () => {
  const rows = [
    { type: 'add', nb: 12, t: 'added' }, { type: 'del', na: 12, t: 'old' },
    { type: 'same', nb: 13, t: '````' }, { type: 'same', nb: 14, t: '' },
  ];
  const quote = rows.map(quoteLine).join('\n');
  assert.equal(quote, '+added\n-old\n ````\n ');
  const n = { ...note('b', 'example.md', 12, 14, 'Revise this.'), quote };
  assert.equal(formatNotes([n], en), '`example.md` lines 12–14:\n`````diff\n' + quote + '\n`````\nRevise this.');
  assert.equal(lineLabel(n.from, zh), '第 12–14 行');
  assert.equal(lineLabel({ start: 12, end: 12 }, en), 'line 12');
  const removed = { ...n, from: { start: 12, end: 12 }, quote: '-old' };
  const changed = { ...removed, quote: '-different' };
  const { marked, ending } = locateNotes(rows, [removed, changed, n]);
  assert.deepEqual(ending.get(1), [removed]);
  assert.deepEqual(ending.get(3), [n]);
  assert.deepEqual(marked, new Set([0, 1, 2, 3]));
});

test('chat groups by recipient and orders each message by path and displayed line', () => {
  const notes = [note('b', 'z.md', 2, 2, 'Last'), note('a', 'other.md', 7, 7, 'Separate'), note('b', 'a.md', 10, 10, 'Second'), note('b', 'a.md', 2, 2, 'First')];
  const groups = notesByMember(notes);
  const block = (path, line, text) => `\`${path}\` 第 ${line} 行：\n\`\`\`diff\n+example\n\`\`\`\n${text}`;
  const expected = [block('a.md', 2, 'First'), block('a.md', 10, 'Second'), block('z.md', 2, 'Last')].join('\n\n');
  assert.equal(groups.size, 2);
  assert.equal(formatNotes(groups.get('b'), zh, 'Birch'), '@Birch\n' + expected);
  assert.equal(formatNotes(groups.get('a'), zh, 'Aster'), '@Aster\n' + block('other.md', 7, 'Separate'));
  assert.equal(formatNotes(groups.get('b'), zh), expected);
});

test('posting a formatted diff comment calls its mentioned mock member next', async (t) => {
  let server;
  t.after(() => server?.close());
  server = await startServer({ port: 0, dataDir: tempDir(t), mock: true });
  const base = '/api/spaces';
  const post = async (url, body) => {
    const res = await apiRequest(server, url, 'POST', body);
    assert.equal(res.status, 201);
    return res.json();
  };
  const space = await post(base, { members: [{ engine: 'codex', name: 'Aster' }, { engine: 'gemini', name: 'Birch' }], access: 'read' });
  const to = space.members[1];
  const text = formatNotes([note(to.id, 'example.md', 3, 3, 'Check the units.')], en, to.name);
  const url = base + '/' + space.id;
  assert.equal((await post(url + '/messages', { text })).text, text);
  const finished = await until(async () => (await apiRequest(server, url)).json(), (s) => !s.running && s.messages.some((m) => m.kind === 'ai'));
  assert.deepEqual(finished.messages.filter((m) => m.kind === 'ai').map((m) => m.memberId), [to.id]);
});

test('rejecting a reviewed task keeps long feedback in the retry prompt', async (t) => withLanguage('zh', async () => {
  const space = makeSpace(tempDir(t));
  t.after(() => settleSpace(space));
  const prompts = [];
  space.registry.runTurn = async (_engine, opts) => {
    if (isMemoryCall(opts)) return MEMORY_IDLE;
    prompts.push(opts.prompt);
    if (prompts.length === 1) return { text: JSON.stringify({ tasks: [{ id: 'T1', title: '样例', assignee: 'Alice', spec: '整理样例' }] }) };
    return { text: '整理好了。\n结果：完成' };
  };
  await beginTask(space, { objective: '整理示例文件', discuss: false });
  await until(() => space.run.data.status, (s) => s === 'plan_review');
  await space.runAction('approve-plan');
  const task = space.run.data.tasks[0];
  await until(() => task.status, (s) => s === 'review');
  const feedback = formatNotes([{ ...note(task.assigneeId, 'example.md', 1, 1, '请拆行'), quote: '+' + 'sample'.repeat(1000) }], zh);
  await space.runAction('reject-task', { taskId: task.id, feedback });
  assert.equal(task.feedbacks.at(-1).text, feedback);
  await until(() => task.status, (s) => s === 'review');
  const prompt = prompts.at(-1);
  assert.ok(prompt.split('# 用户的意见（请按意见修改）')[1]?.includes(feedback));
}));
