// 记忆库和空间的接线：消息编号、空闲时整理、排队、失败不影响聊天、删空间、只读路由。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testInChinese as test, tempDir, makeSpace, until, settleSpace, beginTask } from './helpers.mjs';
import { Space } from '../src/space.mjs';
import { Store } from '../src/store.mjs';
import { createSettings } from '../src/settings.mjs';
import { createRegistry } from '../src/engines/index.mjs';
import { startServer } from '../src/app-server.mjs';

// 这个文件的测试都要看自动整理：打开开关（node --test 每个文件单独一个进程，不影响别的测试）
Space.memoryAuto = true;

const isOrganize = (opts) => opts.system.includes('记忆库的整理者');
const idle = (space) => until(() => !!space.memoryRun, (busy) => !busy, { message: '记忆库一直在整理' });

test('新消息按顺序编号，编号不复用', async (t) => {
  const space = makeSpace(tempDir(t), { access: 'read' });
  t.after(() => settleSpace(space));
  await space.userMessage('第一条');
  await until(() => space.running, (r) => !r);
  const seqs = space.data.messages.map((m) => m.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
  assert.equal(space.data.nextSeq, seqs.length + 1);
  // 删掉最后一条（导入整理会这样改消息列表），新消息也不会用回它的编号
  space.data.messages.pop();
  space.receive({ id: 'x-1', kind: 'task', ts: Date.now(), name: 'Alice', text: '发回的总结' });
  assert.equal(space.data.messages.at(-1).seq, seqs.length + 1);
  await idle(space);
});

test('打开旧空间时按顺序补上编号，已有的编号不动', (t) => {
  const root = tempDir(t);
  const dataDir = path.join(root, 'data');
  const registry = createRegistry(createSettings(path.join(dataDir, 'settings.json')), { mock: true });
  const store = new Store(path.join(dataDir, 'spaces'));
  const old = makeSpace(root);
  const data = JSON.parse(JSON.stringify(old.data));
  delete data.nextSeq;
  data.messages = [
    { id: 'm-1', kind: 'user', name: '我', text: '旧消息一', ts: 1 },
    { id: 'm-2', kind: 'ai', memberId: 'member-a', name: 'Alice', text: '旧回复', ts: 2 },
    { id: 'm-3', kind: 'user', name: '我', text: '旧消息二', ts: 3 },
  ];
  const space = new Space(data, { registry, store, dataDir });
  assert.deepEqual(space.data.messages.map((m) => m.seq), [1, 2, 3]);
  assert.equal(space.data.nextSeq, 4);

  // 部分有编号（比如中途升级）：缺的接在最大编号之后
  const mixed = JSON.parse(JSON.stringify(data));
  delete mixed.nextSeq;
  mixed.messages[0].seq = 7;
  delete mixed.messages[1].seq;
  delete mixed.messages[2].seq;
  const again = new Space(mixed, { registry, store, dataDir });
  assert.deepEqual(again.data.messages.map((m) => m.seq), [7, 8, 9]);
});

test('一轮结束后在后台整理记忆库，整理成员默认第一个成员', async (t) => {
  const space = makeSpace(tempDir(t), { access: 'read' });
  t.after(() => settleSpace(space));
  const writers = [];
  const run = space.registry.runTurn;
  space.registry.runTurn = (engine, opts) => {
    if (isOrganize(opts)) writers.push(opts.system);
    return run(engine, opts);
  };
  await space.userMessage('登录就用短信验证码，定了。因为目标用户多数没有邮箱');
  await until(() => space.running, (r) => !r);
  await until(() => space.memory.lastSeq, (n) => n >= 3, { message: '没有整理到最新的消息' });
  await idle(space);
  assert.equal(writers.length, 1);
  assert.match(writers[0], /Alice/);
  const entries = space.memory.entries();
  assert.ok(entries.some((e) => e.type === 'decision' && e.origin === 'user'), JSON.stringify(entries));
  const log = space.memory.logs(5).at(-1);
  assert.ok(log.usage?.input > 0, '整理用的 token 要记下来');
  assert.ok(fs.existsSync(path.join(space.dir, 'memory', 'memory.md')));
  assert.ok(fs.existsSync(path.join(space.dir, 'memory', 'messages', '1.md')));

  // 指定别的成员整理；不在空间里的退回第一个
  space.update({ memoryWriterId: 'member-b' });
  assert.equal(space.memoryWriter.id, 'member-b');
  space.update({ memoryWriterId: 'nobody' });
  assert.equal(space.memoryWriter.id, 'member-a');
});

test('整理失败不影响聊天，下次接着整理同一批', async (t) => {
  const space = makeSpace(tempDir(t), { access: 'read' });
  t.after(() => settleSpace(space));
  const run = space.registry.runTurn;
  let fail = true;
  space.registry.runTurn = (engine, opts) => {
    if (isOrganize(opts) && fail) return Promise.reject(new Error('整理成员出错了'));
    return run(engine, opts);
  };
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = warn; });

  await space.userMessage('第一轮');
  await until(() => space.running, (r) => !r);
  await until(() => space.memory.logs(5).length, (n) => n >= 1);
  await idle(space);
  assert.equal(space.memory.logs(5).at(-1).error, '整理成员出错了');
  assert.equal(space.memory.lastSeq, 0);
  assert.ok(!space.data.messages.some((m) => m.error), '聊天消息不受影响');

  fail = false;
  await space.userMessage('第二轮');
  await until(() => space.running, (r) => !r);
  await until(() => space.memory.lastSeq, (n) => n === space.data.messages.at(-1).seq);
  await idle(space);
  assert.equal(space.memory.logs(5).at(-1).fromSeq, 0, '失败的那批要重新整理');
  assert.equal(space.data.messages.filter((m) => m.kind === 'ai').length, 4);
});

test('正在整理时又来新内容，排到下一次，只多整理一次', async (t) => {
  const space = makeSpace(tempDir(t), { access: 'read' });
  t.after(() => settleSpace(space));
  const run = space.registry.runTurn;
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  space.registry.runTurn = async (engine, opts) => {
    if (isOrganize(opts)) { calls.push(opts.prompt); if (calls.length === 1) await gate; return { text: '```json\n{"ops":[]}\n```' }; }
    return run(engine, opts);
  };
  space.data.messages.push({ id: 'u-1', kind: 'user', name: '我', text: '第一条', ts: 1 });
  space.save();
  const first = space.organizeMemory();
  await until(() => calls.length, (n) => n === 1);
  space.data.messages.push({ id: 'u-2', kind: 'user', name: '我', text: '第二条', ts: 2 });
  space.save();
  assert.equal(space.organizeMemory(), first, '整理中再触发不另起一次');
  assert.equal(space.organizeMemory(), first);
  release();
  await until(() => calls.length, (n) => n === 2);
  await idle(space);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /第二条/);
  assert.doesNotMatch(calls[1], /第一条/, '下一次只整理新的');
  assert.equal(space.memory.lastSeq, 2);
});

test('子任务通过后由程序记下任务结果', async (t) => {
  const space = makeSpace(tempDir(t));
  t.after(() => settleSpace(space));
  await beginTask(space, { objective: '写一份方案', autoApprove: true });
  const run = space.run.data;
  await until(() => run.status, (s) => s === 'plan_review');
  await space.runAction('approve-plan');
  await until(() => run.status, (s) => s === 'done');
  await until(() => space.memory.entries().filter((e) => e.type === 'result').length, (n) => n === 3, { message: '三个子任务的结果都要记下' });
  await idle(space);
  const results = space.memory.entries().filter((e) => e.type === 'result');
  assert.deepEqual(results.map((e) => e.task).sort(), ['T1', 'T2', 'T3']);
  for (const e of results) assert.deepEqual(e.source.tasks, [`${e.task}/1`]);
});

test('删空间时记忆库跟着删，删除中不再整理', async (t) => {
  const space = makeSpace(tempDir(t), { access: 'read' });
  await space.userMessage('随便聊聊');
  await until(() => space.running, (r) => !r);
  await until(() => fs.existsSync(path.join(space.dir, 'memory', 'entries.jsonl')) || space.memory.logs(1).length > 0, Boolean);
  const dir = path.join(space.dir, 'memory');
  await space.remove();
  assert.equal(fs.existsSync(dir), false);
  assert.equal(space.organizeMemory(), null);
});

test('只读路由返回记忆库的条目、渲染文字和整理记录', async (t) => {
  const dataDir = path.join(tempDir(t), 'data');
  const server = await startServer({ port: 0, dataDir, mock: true });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const call = (url, method = 'GET', body) => fetch(base + url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const created = (await call('/api/spaces', 'POST', { title: '路由', members: [{ engine: 'claude-code' }], access: 'read', maxTurns: 1 })).body;
  const url = `/api/spaces/${created.id}/memory`;
  const empty = await call(url);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.entries, []);
  await call(`/api/spaces/${created.id}/messages`, 'POST', { text: '就用 Vue 3，定了。因为团队熟悉' });
  const view = (await until(() => call(url), (r) => r.body.entries.length > 0 && !r.body.organizing)).body;
  assert.equal(view.writerId, created.members[0].id);
  assert.ok(view.lastSeq > 0);
  assert.ok(view.text.includes(`#${view.entries[0].id} `));
  assert.ok(view.logs.length > 0);
  assert.notEqual((await call(url, 'POST', {})).status, 200, '只读，不能写');
});
