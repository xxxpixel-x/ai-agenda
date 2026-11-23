// 记忆库和空间的接线：消息编号、空闲时整理、排队、失败不影响聊天、删空间、只读路由。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { apiRequest, testInChinese as test, tempDir, makeSpace, until, settleSpace, beginTask } from './helpers.mjs';
import { Space } from '../src/space.mjs';
import { Store } from '../src/store.mjs';
import { createSettings } from '../src/settings.mjs';
import { createRegistry } from '../src/engines/index.mjs';
import { startServer } from '../src/app-server.mjs';
import { replaySpace, taskSnapshotAt } from '../scripts/replay-memory.mjs';

// 这个文件的原有测试看即时触发；第四批节流测试会在对应 case 里单独测默认防抖与阈值。
Space.memoryAuto = true;
Space.memoryDebounceMs = 0;
Space.memoryMinUserMessages = 1;
Space.memoryMinChars = 0;

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
  const call = async (url, method, body) => {
    const r = await apiRequest(server, url, method, body);
    return { status: r.status, body: await r.json() };
  };
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
  assert.notEqual((await call(url, 'POST', {})).status, 200, '裸 POST /memory 不能写');
  // 第四批路由：手动触发整理 + 白名单动作路由（含并发 409 与防伪造 result）
  const org = await call(url + '/organize', 'POST', {});
  assert.equal(org.status, 200);
  assert.equal(org.body.ok, true);
  const firstId = view.entries[0].id;
  assert.equal((await call(`${url}/entries/${firstId}/action`, 'POST', { action: 'edit', type: 'result', text: 'x' })).status, 400);
  const edited = await call(`${url}/entries/${firstId}/action`, 'POST', { action: 'edit', text: '就用 Vue 3', reason: '补充原因' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.entry.confirmedBy, 'user');
  const retracted = await call(`${url}/entries/${edited.body.entry.id}/action`, 'POST', { action: 'retract' });
  assert.equal(retracted.status, 200);
  assert.equal((await call(`${url}/entries/${edited.body.entry.id}/action`, 'POST', { action: 'retract' })).status, 409);
});

test('第四批接线：写完即归档、可控时钟防抖节流、空间开关、全局整理模型优先级与重启补欠账', async (t) => {
  const prevDebounce = Space.memoryDebounceMs;
  const prevMinUsers = Space.memoryMinUserMessages;
  const prevMinChars = Space.memoryMinChars;
  const prevClock = Space.clock;
  t.after(() => {
    Space.memoryDebounceMs = prevDebounce;
    Space.memoryMinUserMessages = prevMinUsers;
    Space.memoryMinChars = prevMinChars;
    Space.clock = prevClock;
  });

  // 可控假时钟
  let now = 1000;
  let nextTimerId = 1;
  const timers = new Map();
  Space.clock = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = nextTimerId++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  const advance = (ms) => {
    now += ms;
    for (const [id, item] of [...timers]) {
      if (item.at <= now) { timers.delete(id); item.fn(); }
    }
  };
  Space.memoryDebounceMs = 60_000;
  Space.memoryMinUserMessages = 2;
  Space.memoryMinChars = 3000;

  const root = tempDir(t);
  const space = makeSpace(root, { access: 'read' });
  t.after(() => settleSpace(space));
  const orgCalls = [];
  const baseRun = space.registry.runTurn;
  space.registry.runTurn = (engine, opts) => {
    if (isOrganize(opts)) { orgCalls.push({ engine, opts }); return Promise.resolve({ text: '{"ops":[]}' }); }
    return baseRun(engine, opts);
  };

  // 第 1 条短用户消息：未达阈值不触发整理，但已立即归档 messages/1.md（零 token）
  await space.userMessage('第一条短消息');
  await until(() => space.running, (r) => !r);
  assert.equal(orgCalls.length, 0);
  assert.equal(timers.size, 0);
  assert.ok(fs.existsSync(path.join(space.dir, 'memory', 'messages', '1.md')), '消息写完即归档');

  // 第 2 条用户消息：达到 2 条用户消息下限，进入 60s 空闲防抖，不立刻调用
  await space.userMessage('第二条短消息');
  await until(() => space.running, (r) => !r);
  assert.equal(orgCalls.length, 0);
  assert.equal(timers.size, 1);

  // 新轮次状态取消计时器
  space.emitEvent({ type: 'state', running: true });
  assert.equal(timers.size, 0);
  space.scheduleMemoryOrganize();
  assert.equal(timers.size, 1);

  // 快进 60s 触发整理
  advance(60_000);
  await until(() => orgCalls.length, (n) => n === 1);
  await idle(space);

  // 空间关闭自动整理：清计时器，不再自动触发，手动仍可整理
  space.update({ memoryAuto: false });
  assert.equal(space.memoryView().memoryAuto, false);
  await space.userMessage('关闭后消息 A');
  await until(() => space.running, (r) => !r);
  await space.userMessage('关闭后消息 B');
  await until(() => space.running, (r) => !r);
  assert.equal(timers.size, 0);
  assert.equal(orgCalls.length, 1);
  await space.organizeMemory({ manual: true });
  await idle(space);
  assert.equal(orgCalls.length, 2);

  // 全局整理模型优先级：space.memoryWriterId > settings.memoryOrganizer > 第一个成员
  space.registry.settings.update({ memoryOrganizer: { engine: 'gemini', model: 'gemini-2.5-flash' } });
  assert.equal(space.resolveMemoryWriter().source, 'global');
  assert.equal(space.memoryWriter.engine, 'gemini');
  assert.equal(space.memoryWriter.model, 'gemini-2.5-flash');
  space.update({ memoryWriterId: 'member-b' });
  assert.equal(space.resolveMemoryWriter().source, 'space');
  assert.equal(space.memoryWriter.id, 'member-b');
  space.update({ memoryWriterId: '' });
  assert.equal(space.resolveMemoryWriter().source, 'global');

  // 重启补欠账：重新打开仍有未整理欠账的空间应自动排上防抖整理
  space.update({ memoryAuto: true });
  space.data.messages.push({ id: 'u-x1', seq: 100, kind: 'user', name: '我', text: '重启前 1', ts: 100 },
    { id: 'u-x2', seq: 101, kind: 'user', name: '我', text: '重启前 2', ts: 101 });
  space.save();
  const reopened = new Space(JSON.parse(JSON.stringify(space.data)), { registry: space.registry, store: space.store, dataDir: path.join(root, 'data') });
  t.after(() => settleSpace(reopened));
  assert.equal(timers.size, 1, '重启后检测到欠账应挂上整理定时器');
  reopened.shutdown();
  assert.equal(timers.size, 0, 'shutdown 必须清掉定时器');
});

test('第四批人工纠偏：采纳分歧原子写入、编辑改理由、问答与并发 409、白名单防伪造、离线时序回放', async (t) => {
  const space = makeSpace(tempDir(t), { access: 'read' });
  t.after(() => settleSpace(space));
  space.data.messages.push({ id: 'u1', seq: 1, kind: 'user', name: '我', text: '讨论登录', ts: 100 });
  space.data.nextSeq = 2;
  const events = [];
  space.on('event', (ev) => events.push(ev.type));

  // 预置条目：#1 强确认决定（带 plan 出处），#2 冲突分歧（带 conflicts + proposed），#3 提议，#4 问题
  space.memory.append([
    { type: 'decision', origin: 'user', confirmedBy: 'user', text: '登录用短信', reason: '老方案', scope: '', source: { tasks: ['plan'] }, at: 10 },
    { type: 'disagreement', ask: true, text: '和 #1 不一致：登录改用邮箱', conflicts: [1], proposed: { type: 'constraint', text: '登录改用邮箱', reason: '企业内网' }, source: { messages: [1] }, at: 20 },
    { type: 'proposal', text: '支持暗色模式', source: { messages: [1] }, at: 20 },
    { type: 'question', text: '是否支持离线缓存？', source: { messages: [1] }, at: 20 },
  ]);
  assert.equal(space.memoryAskCount, 1);
  assert.equal(space.listItem().needsYou, true);

  // 1. 采纳分歧 #2：原子写单条业务记录，resolves:[2] + supersedes:[1]，恢复 proposed.type='constraint'，不伪造 plan 出处
  const acc = space.applyMemoryAction(2, { action: 'accept' });
  assert.equal(acc.entry.type, 'constraint');
  assert.equal(acc.entry.confirmedBy, 'user');
  assert.deepEqual(acc.entry.resolves, [2]);
  assert.deepEqual(acc.entry.supersedes, [1]);
  assert.ok(!acc.entry.source.tasks?.includes('plan'), '不继承 plan 伪造出处');
  assert.equal(space.memory.get(1).status, 'superseded');
  assert.equal(space.memory.get(2).status, 'resolved');
  assert.equal(space.memoryAskCount, 0);
  // 并发双击同一个分歧应返回 409
  assert.throws(() => space.applyMemoryAction(2, { action: 'accept' }), (e) => e.status === 409);

  // 2. 编辑同文改理由不撞去重；禁止改 type 为 result
  assert.throws(() => space.applyMemoryAction(acc.entry.id, { action: 'edit', type: 'result', text: '伪造结果' }), (e) => e.status === 400);
  const edited = space.applyMemoryAction(acc.entry.id, { action: 'edit', text: '登录改用邮箱', reason: '补充最新安全要求' });
  assert.equal(edited.entry.reason, '补充最新安全要求');
  assert.deepEqual(edited.entry.supersedes, [acc.entry.id]);
  assert.equal(edited.entry.confirmedBy, 'user');

  // 3. 驳回提议 #3
  const rej = space.applyMemoryAction(3, { action: 'reject', reason: '暂不需要' });
  assert.equal(rej.entry.type, 'rejected');
  assert.equal(rej.entry.origin, 'user');
  assert.equal(rej.entry.confirmedBy, 'user');
  assert.deepEqual(rej.entry.resolves, [3]);

  // 4. 回答问题 #4：空答案被拒，有效答案解决 #4
  assert.throws(() => space.applyMemoryAction(4, { action: 'answer', text: '  ' }), (e) => e.status === 400);
  const ans = space.applyMemoryAction(4, { action: 'answer', text: '暂不做离线缓存', type: 'decision' });
  assert.equal(ans.entry.type, 'decision');
  assert.equal(ans.entry.confirmedBy, 'user');
  assert.deepEqual(ans.entry.resolves, [4]);

  // 5. 撤回已取代链顶层条目，返回 hadSupersedes=true，重复撤回返回 409
  const ret = space.applyMemoryAction(edited.entry.id, { action: 'retract' });
  assert.equal(ret.hadSupersedes, true);
  assert.throws(() => space.applyMemoryAction(edited.entry.id, { action: 'retract' }), (e) => e.status === 409);
  assert.ok(events.includes('memory_changed'));

  // 6. 离线时序回放脚本：不泄露未来验收状态
  const snapEarly = taskSnapshotAt([{ id: 'T1', status: 'approved', approvedAt: 5000, attempts: [{ startedAt: 1000, endedAt: 2000, outcome: 'done' }] }], 2500);
  assert.equal(snapEarly[0].status, 'review');
  const snapLate = taskSnapshotAt([{ id: 'T1', status: 'approved', approvedAt: 5000, attempts: [{ startedAt: 1000, endedAt: 2000, outcome: 'done' }] }], 6000);
  assert.equal(snapLate[0].status, 'approved');
  const replay = await replaySpace({
    spaceData: {
      kind: 'chat',
      members: [{ id: 'm1', name: 'Alice', engine: 'codex' }],
      messages: [
        { seq: 1, kind: 'user', name: '我', text: '登录定了用短信，因为人人都有手机。', ts: 1000 },
        { seq: 2, kind: 'user', name: '我', text: '登录改成邮箱，因为已有企业邮箱。', ts: 2000 },
      ],
    },
    registry: space.registry,
    writer: { id: 'm1', name: 'Alice', engine: 'codex' },
    batchSize: 1,
  });
  assert.equal(replay.batchCount, 2);
  assert.equal(replay.totalAdded, 2);
  assert.equal(replay.totalToolCalls, 0);
  assert.ok(replay.usage.input > 0);
});
