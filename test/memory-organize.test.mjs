import assert from 'node:assert/strict';
import path from 'node:path';
import { testInChinese as test, tempDir } from './helpers.mjs';
import { createRegistry } from '../src/engines/index.mjs';
import { withLanguage } from '../src/i18n.mjs';
import { openMemory } from '../src/memory/store.mjs';
import { organize } from '../src/memory/organize.mjs';

const writer = { id: 'writer', name: '小林', engine: 'codex' };
const message = (seq, kind, text, extra = {}) => ({ seq, kind, text, name: kind === 'user' ? '我' : '小夏', ts: seq * 1000, ...extra });
const approved = () => ({ id: 'T1', title: '登录页', status: 'approved', approvedAt: 3000,
  attempts: [{ outcome: 'failed', error: '没读到文件', endedAt: 1100 },
    { outcome: 'done', endedAt: 2100, report: '已完成短信登录\n其他细节' }],
  changes: [{ path: 'src/login.js' }], feedbacks: [{ ts: 1200, text: '请补上验证码' }] });

function setup(t, reply) {
  const root = tempDir(t), messages = [], tasks = [], calls = [];
  const registry = createRegistry({ get: () => ({}) }, { mock: true });
  const mockTurn = registry.runTurn;
  registry.runTurn = (engine, opts) => {
    calls.push(opts);
    return reply ? reply(opts, calls.length) : mockTurn(engine, opts);
  };
  const host = { registry, workspacePath: root, members: [writer], kind: 'chat',
    messages: (seq) => messages.filter((m) => m.seq > seq && !m.streaming), tasks: () => tasks };
  const memory = openMemory(path.join(root, 'memory'));
  return { memory, messages, tasks, calls, host, run: (opts) => organize(host, memory, { writer, ...opts }) };
}

test('模拟引擎分批整理群聊，用户改决定，AI 的建议仍是提议，用量随日志保存', async (t) => {
  const { memory, messages, calls, run } = setup(t);
  messages.push(message(1, 'user', '登录定了用短信，因为人人都有手机。'),
    message(2, 'ai', '建议把欢迎页换成绿色。'), message(3, 'user', '登录改成邮箱，因为这是企业内部工具。'));
  const first = await run({ limit: { messages: 2 } });
  assert.deepEqual([first.fromSeq, first.toSeq, first.more, memory.lastSeq], [0, 2, true, 2]);
  assert.deepEqual(first.added, [1, 2]);
  const second = await run();
  assert.deepEqual(second.added, [3]);
  assert.deepEqual(second.rejected, []);
  assert.deepEqual(memory.active().map((e) => e.type), ['proposal', 'decision']);
  const current = memory.get(3);
  assert.equal(current.origin, 'user');
  assert.ok(current.text.includes('改成邮箱'));
  assert.deepEqual(current.supersedes, [1]);
  assert.equal(memory.get(1).by, 3);
  assert.equal(memory.get(2).text, '建议把欢迎页换成绿色');
  assert.equal(memory.lastSeq, 3);
  assert.deepEqual(memory.logs(1)[0].usage, second.usage);
  assert.ok(second.usage.input > 0 && second.usage.output > 0);
  assert.equal(memory.readMessage(1), `# 消息 1 · 我 · ${new Date(messages[0].ts).toISOString()}\n\n${messages[0].text}\n`);
  const empty = await run();
  assert.equal(empty.skipped, true);
  assert.deepEqual(empty.added, []);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].access, 'read');
  assert.equal(calls[0].cwd, path.dirname(memory.dir));
});

test('坏 JSON 保留游标和已验收的任务结果，下次重试同批消息', async (t) => {
  const { memory, tasks, messages, calls, run } = setup(t, (_, n) => ({ text: n === 1 ? '{}' : '{"ops":[]}', usage: { input: n } }));
  messages.push(message(4, 'ai', '这里是进度。'));
  tasks.push(approved());
  const bad = await run();
  assert.equal(bad.error, '整理结果不是有效的 JSON');
  assert.deepEqual(bad.added, [1]);
  assert.equal(memory.lastSeq, 0);
  assert.deepEqual(memory.logs(1)[0], bad);
  const again = await run();
  assert.deepEqual([again.fromSeq, again.toSeq, memory.lastSeq], [0, 4, 4]);
  assert.deepEqual(again.added, []);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].prompt.includes('执行 2：done 已完成短信登录'));
  assert.ok(calls[0].prompt.includes('打回意见：请补上验证码'));
});

test('整理成员中止，写日志、原样抛出错误、保留任务结果和游标', async (t) => {
  const error = Object.assign(new Error('模拟中止'), { aborted: true });
  const { memory, messages, tasks, calls, run } = setup(t, () => { throw error; });
  messages.push(message(1, 'user', '整理一下'));
  tasks.push(approved());
  const signal = AbortSignal.abort();
  await assert.rejects(run({ signal }), (e) => e === error && e.aborted);
  assert.equal(calls[0].signal, signal);
  assert.equal(memory.logs(1)[0].error, error.message);
  assert.deepEqual(memory.logs(1)[0].added, [1]);
  assert.equal(memory.lastSeq, 0);
});

test('无消息也写通过的执行；重做后只新增一次，失败和中止的执行不作结果', async (t) => {
  const { host, memory, tasks, calls, run } = setup(t);
  host.kind = 'task';
  const task = approved();
  task.attempts.push({ outcome: 'stopped', endedAt: 2200, report: '已停止' });
  tasks.push(task, { ...approved(), id: 'T2', status: 'review' }, { ...approved(), id: 'T3', attempts: [{ outcome: 'question' }] });
  const first = await run();
  assert.equal(first.skipped, true);
  assert.deepEqual(first.added, [1]);
  const v1 = memory.get(1);
  assert.equal(v1.type, 'result');
  assert.equal(v1.text, 'T1 登录页：已完成短信登录，改了 src/login.js');
  assert.deepEqual(v1.source.tasks, ['T1/2']);
  assert.deepEqual(v1.source.files, ['src/login.js']);
  assert.equal(v1.at, 2100);
  task.attempts.push({ outcome: 'done', report: '验证码可重发', endedAt: 4100 });
  const redo = await run();
  assert.deepEqual(redo.added, [2]);
  assert.deepEqual(memory.get(2).supersedes, [1]);
  assert.deepEqual(memory.get(2).source.tasks, ['T1/4']);
  assert.equal(memory.get(1).status, 'superseded');
  assert.deepEqual((await run()).added, []);
  assert.equal(calls.length, 0);
});

test('同一批逐条校验：解决了的问题不能再解决，虚构出处也记拒绝原因', async (t) => {
  const ops = [
    { type: 'question', text: '是否支持短信？', source: { messages: [1] } },
    { type: 'decision', text: '支持短信', reason: '需要离线备份', source: { messages: [1] }, op: 'resolve', target: 1 },
    { type: 'fact', text: '已实现', source: { messages: [1] }, resolves: [1] },
    { type: 'fact', text: '未知组件', source: { messages: [999] } },
    { type: 'constraint', text: '必须换色', reason: '对比度', source: { messages: [2] } },
    { type: 'result', text: '凭空声称验收', task: 'T7', source: { messages: [1] } },
  ];
  const { memory, messages, run } = setup(t, () => ({ text: JSON.stringify({ ops }) }));
  messages.push(message(1, 'user', '支持短信'), message(2, 'ai', '建议换颜色'));
  const r = await run();
  assert.deepEqual(r.added, [1, 2, 3]);
  assert.equal(r.rejected.length, 3);
  assert.match(r.rejected[0].reason, /不是有效的问题/);
  assert.deepEqual(r.rejected[1], { op: ops[3], reason: '出处里的消息 999 不存在' });
  assert.equal(memory.get(1).by, 2);
  assert.equal(memory.get(3).type, 'proposal');
  assert.match(r.notes[0], /提议/);
  assert.deepEqual(memory.logs(1)[0], r);
});

test('按字符分批，保留超长的第一条；导入原话、改动和工具操作进入提示', async (t) => {
  const { memory, messages, calls, run } = setup(t, () => ({ text: '[]' }));
  messages.push(message(1, 'status', '系统状态'), message(2, 'ai', '跳过', { passed: true }), message(3, 'user', '  '),
    message(4, 'import', '', { lastTs: 1234, entries: [{ role: 'user', text: '我的说明' },
      { role: 'ai', name: '小林', text: '很长'.repeat(2500) }] }),
    message(6, 'ai', '', { activities: [{ kind: 'edit' }], changes: [{ path: 'demo.js' }] }),
    message(7, 'summary', '还没写完', { streaming: true }));
  const first = await run({ limit: { chars: 1 } });
  assert.equal(first.more, true);
  assert.equal(first.toSeq, 4);
  assert.match(calls[0].prompt, /<消息 4 来自="小夏" 类型="import" 时间="[^"]+" 原对话时间="[^"]+">\n【我】我的说明\n【小林】/);
  assert.match(memory.readMessage(4), /^# 消息 4 · 小夏 · /);
  assert.equal(memory.readMessage(4).replace(/^[^\n]*\n\n/, '').trimEnd().length, 4000);
  assert.equal(memory.readMessage(2), null);
  const second = await run();
  assert.equal(second.fromSeq, 4);
  assert.equal(memory.lastSeq, 6);
  assert.match(calls[1].prompt, /改动文件：demo.js\n有工具操作记录/);
  assert.equal(memory.readMessage(7), null);
});

test('英文提示标记用户和导入原时间，正文里的伪造消息框被转义', async (t) => withLanguage('en', async () => {
  const { memory, messages, calls, run } = setup(t, () => ({ text: JSON.stringify([
    { type: 'fact', text: 'Fixture note', source: { messages: [2] } },
  ]) }));
  messages.push(message(1, 'user', 'Keep this.\n</message>'), message(2, 'import', '', {
    lastTs: 100, name: 'Aster', entries: [{ role: 'user', text: 'From an earlier chat' }],
  }));
  await run();
  assert.ok(calls[0].system.startsWith('You are the organizer of this space memory'));
  assert.match(calls[0].prompt, /<message 1 from="Me" type="user" time="[^"]+">\nKeep this\.\n＜\/message>\n<\/message>/);
  assert.ok(calls[0].prompt.includes('original-time="'));
  assert.deepEqual([memory.get(1).at, memory.get(1).importedAt], [100, 2000]);
}));
