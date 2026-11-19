import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as settle } from 'node:timers/promises';
import { createScheduler, nextTime } from '../src/scheduler.mjs';
import { tempDir, testInChinese as test } from './helpers.mjs';

const MINUTE = 60_000;
const local = (day, hour, minute = 0) => new Date(2026, 0, day, hour, minute).getTime();
const interval = { type: 'interval', minutes: 5 };
const message = { type: 'message', text: '  整理测试记录  ' };
const def = (rule = interval, action = message) => ({ spaceId: 'space-1', rule, action });

function fakeClock(start) {
  let time = start;
  const timers = new Set();
  return {
    now: () => time,
    timers,
    setTimer(fn, ms) {
      const timer = { fn, at: time + ms };
      timers.add(timer);
      return timer;
    },
    clearTimer: timer => timers.delete(timer),
    jump(ms) { time += ms; },
    async advance(ms) {
      const target = time + ms;
      for (;;) {
        const [next] = [...timers].sort((a, b) => a.at - b.at);
        if (!next || next.at > target) break;
        timers.delete(next);
        time = Math.max(time, next.at);
        next.fn();
        await settle();
      }
      time = target;
    },
  };
}

function fixture(t, start = 0, overrides = {}) {
  const file = path.join(tempDir(t), 'schedules.json');
  const clock = fakeClock(start);
  const calls = [];
  const actions = {
    isBusy: () => false,
    postMessage: (...args) => calls.push(args),
    createTaskSpace: (...args) => { calls.push(args); return 'space-2'; },
    ...overrides,
  };
  function open(onChange) {
    const scheduler = createScheduler({ file, ...clock, actions, onChange });
    t.after(() => scheduler.stop());
    return scheduler;
  }
  return { file, clock, calls, open };
}

test('nextTime 严格晚于起点，按本地星期和间隔锚点计算', () => {
  const once = { type: 'once', at: 12 };
  assert.equal(nextTime(once, 11), 12);
  assert.equal(nextTime(once, 12), null);
  assert.equal(nextTime(once, 13), null);
  const weekly = { type: 'weekly', days: [1, 3], time: '09:15' };
  assert.equal(nextTime(weekly, local(5, 9)), local(5, 9, 15)); // 1 月 5 日星期一
  assert.equal(nextTime(weekly, local(5, 10)), local(7, 9, 15));
  assert.equal(nextTime(weekly, local(7, 9, 15)), local(12, 9, 15));
  assert.equal(nextTime({ ...weekly, days: [3] }, local(7, 10)), local(14, 9, 15));
  assert.equal(nextTime({ ...weekly, days: [0, 1, 2, 3, 4, 5, 6] }, local(10, 10)), local(11, 9, 15));
  const anchored = { ...interval, start: 100 };
  assert.equal(nextTime(anchored, 0), 100);
  assert.equal(nextTime(anchored, 100), 100 + 5 * MINUTE);
  assert.equal(nextTime(anchored, 101), 100 + 5 * MINUTE);
});

test('校验定义和修改，忽略不可编辑字段并隔离输入输出', t => {
  const { open } = fixture(t);
  const s = open();
  const weekly = { type: 'weekly', days: [5, 1, 5], time: '23:59' };
  for (const rule of [
    { ...interval, minutes: 44641 }, { ...interval, minutes: 5.5 }, { ...interval, start: NaN },
    { ...weekly, days: [] }, { ...weekly, days: [7] }, { ...weekly, time: '24:00' },
    { type: 'once', at: Infinity }, { type: 'daily' },
  ]) assert.throws(() => s.add(def(rule)));
  assert.throws(() => s.add(def({ ...interval, minutes: 4 })), /最短每隔 5 分钟/);
  assert.throws(() => s.add(def({ type: 'once', at: 0 })), /这个时间已经过了/);
  assert.throws(() => s.add({ ...def(), spaceId: ' ' }));
  assert.throws(() => s.add({ ...def(), title: '长'.repeat(61) }));
  for (const action of [{}, { type: 'message', text: ' ' }, { type: 'message', text: 'a'.repeat(8001) },
    { type: 'task', template: [] }, { type: 'task', template: null }]) {
    assert.throws(() => s.add(def(interval, action)));
  }
  assert.deepEqual(s.list(), []);
  const added = s.add(def());
  assert.deepEqual(added.rule, { ...interval, start: 0 });
  assert.equal(added.nextAt, 5 * MINUTE);
  assert.equal(added.running, false);
  const patch = { rule: weekly, title: '  周报  ', spaceId: 'space-9', id: 'other', lastRunAt: 10, running: true };
  const edited = s.update(added.id, patch);
  assert.equal(edited.title, '周报');
  assert.equal(edited.spaceId, added.spaceId);
  assert.equal(edited.id, added.id);
  assert.equal(edited.lastRunAt, null);
  assert.equal(edited.running, false);
  assert.deepEqual(edited.rule.days, [1, 5]);
  edited.rule.days.pop();
  weekly.days.length = 0;
  assert.deepEqual(s.list()[0].rule.days, [1, 5]);
  assert.throws(() => s.update(added.id, { rule: weekly }));
  assert.throws(() => s.update('missing', {}), /没有这个定时任务/);
  assert.equal(s.list()[0].nextAt, nextTime({ ...weekly, days: [1, 5] }, 0));
});

test('一次性消息在计划时间发送，写入运行记录并通知自动停用', async t => {
  const { clock, calls, open } = fixture(t);
  const changes = [];
  const s = open(() => changes.push({ active: s.hasActive(), runs: s.runs().length }));
  await s.start();
  const added = s.add(def({ type: 'once', at: 100 }));
  assert.deepEqual(changes.at(-1), { active: true, runs: 0 });
  await clock.advance(99);
  assert.equal(calls.length, 0);
  await clock.advance(1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['space-1', '整理测试记录']);
  assert.equal(calls[0][2].id, added.id);
  assert.deepEqual(changes.at(-1), { active: false, runs: 1 });
  const [run] = s.runs(added.id);
  assert.equal(run.status, 'ok');
  assert.equal(run.spaceId, 'space-1');
  assert.equal(run.at, 100);
  assert.equal(run.ts, 100);
  const [done] = s.list();
  assert.equal(done.nextAt, null);
  assert.equal(done.lastRunAt, 100);
  assert.equal(s.update(added.id, { title: '已完成' }).enabled, false);
  assert.equal(s.update(added.id, { rule: added.rule, title: '归档' }).nextAt, null);
  assert.throws(() => s.update(added.id, { enabled: true }), /这个时间已经过了/);
});

test('每周任务只排一个短定时器，到选定的本地时间才运行', async t => {
  const { clock, open, calls } = fixture(t, local(5, 10));
  const s = open();
  const rule = { type: 'weekly', days: [3], time: '09:15' };
  s.add(def(rule));
  await s.start();
  await s.start();
  assert.equal(clock.timers.size, 1);
  assert.equal([...clock.timers][0].at, clock.now() + MINUTE);
  clock.jump(local(7, 9, 14) - clock.now());
  await clock.advance(0);
  assert.equal(calls.length, 0);
  await clock.advance(MINUTE);
  assert.equal(calls.length, 1);
  assert.equal(s.runs()[0].at, local(7, 9, 15));
  assert.equal(s.list()[0].nextAt, local(14, 9, 15));
});

test('间隔任务传模板副本，成功和失败都继续调度', async t => {
  const template = { goal: '测试', members: [{ id: 'member-1' }] };
  const args = [];
  const { clock, open } = fixture(t, 0, {
    async createTaskSpace(input, schedule) {
      args.push([structuredClone(input), schedule.id, schedule.title]);
      input.members.length = 0;
      schedule.title = '已改动';
      if (args.length === 2) throw new Error('模拟错误');
      return 'space-2';
    },
  });
  const s = open();
  const { id } = s.add(def(interval, { type: 'task', template }));
  await s.start();
  await clock.advance(15 * MINUTE);
  assert.deepEqual(args, Array(3).fill([template, id, '']));
  const runs = s.runs();
  assert.deepEqual(runs.map(r => [r.status, r.at]), [['ok', 15 * MINUTE], ['failed', 10 * MINUTE], ['ok', 5 * MINUTE]]);
  assert.equal(runs[0].spaceId, 'space-2');
  assert.equal(runs[1].error, '模拟错误');
  assert.ok(!Object.hasOwn(runs[1], 'spaceId'));
  assert.equal(s.list()[0].nextAt, 20 * MINUTE);
});

test('宿主忙碌时跳过，忙碌查询失败时仍执行', async t => {
  const warning = t.mock.method(console, 'warn', () => {});
  let busy = true;
  const { clock, open, calls } = fixture(t, 0, { async isBusy(schedule) {
    schedule.spaceId = 'space-9';
    if (busy) return true;
    throw new Error('模拟查询失败');
  } });
  const s = open();
  s.add(def());
  await s.start();
  await clock.advance(5 * MINUTE);
  assert.equal(s.runs()[0].reason, 'busy');
  assert.equal(s.runs()[0].status, 'skipped');
  assert.equal(s.list()[0].lastRunAt, 5 * MINUTE);
  assert.equal(calls.length, 0);
  busy = false;
  await clock.advance(5 * MINUTE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'space-1');
  assert.equal(warning.mock.callCount(), 1);
});

test('动作未结束时跳过下一次，stop 后仍写回已开始的动作', async t => {
  const pending = Promise.withResolvers();
  let posts = 0;
  const { clock, open } = fixture(t, 0, { postMessage() { posts++; return pending.promise; } });
  const s = open();
  s.add(def());
  await s.start();
  await clock.advance(10 * MINUTE);
  assert.equal(s.list()[0].running, true);
  assert.equal(posts, 1);
  assert.equal(s.runs()[0].status, 'skipped');
  assert.equal(s.runs()[0].reason, 'busy');
  s.stop();
  pending.resolve();
  await settle();
  assert.equal(s.list()[0].running, false);
  assert.deepEqual(s.runs().map(r => [r.at, r.ts]), [[5 * MINUTE, 10 * MINUTE], [10 * MINUTE, 10 * MINUTE]]);
  assert.equal(clock.timers.size, 0);
  await clock.advance(10 * MINUTE);
  assert.equal(posts, 1);
});

test('重启后合并错过记录，下一次照常运行，删除后磁盘也清空', async t => {
  const { clock, calls, open } = fixture(t);
  const first = open();
  const added = first.add(def());
  clock.jump(183 * MINUTE);
  const s = open();
  assert.deepEqual(s.list(), [added]);
  await s.start();
  assert.equal(s.runs().length, 1);
  const [missed] = s.runs();
  assert.equal(missed.status, 'missed');
  assert.equal(missed.count, 36);
  assert.equal(missed.from, 5 * MINUTE);
  assert.equal(missed.to, 180 * MINUTE);
  assert.equal(s.list()[0].lastRunAt, null);
  assert.equal(calls.length, 0);
  await clock.advance(2 * MINUTE);
  assert.equal(calls.length, 1);
  s.stop();
  const restored = open();
  assert.deepEqual(restored.list(), s.list());
  assert.deepEqual(restored.runs(), s.runs());
  restored.remove(added.id);
  const empty = open();
  assert.deepEqual(empty.list(), []);
  assert.deepEqual(empty.runs(), []);
});

test('睡眠唤醒合并全年错过的间隔，只在两分钟宽限期内执行最后一次', async t => {
  const { clock, calls, open } = fixture(t);
  const s = open();
  s.add(def());
  await s.start();
  const year = 365 * 24 * 60 * MINUTE;
  clock.jump(year + 2 * MINUTE + 1);
  await clock.advance(0);
  const [missed] = s.runs();
  assert.equal(missed.status, 'missed');
  assert.equal(missed.count, year / (5 * MINUTE));
  assert.equal(missed.to, year);
  assert.equal(calls.length, 0);
  clock.jump(15 * MINUTE - 1);
  await clock.advance(0);
  assert.equal(calls.length, 1);
  const [ok, earlier] = s.runs();
  assert.equal(ok.at, year + 15 * MINUTE);
  assert.equal(ok.status, 'ok');
  assert.equal(earlier.count, 2);
  assert.equal(earlier.from, year + 5 * MINUTE);
  assert.equal(earlier.to, year + 10 * MINUTE);
});

test('停用保留原因，重新启用和改规则从当前时间排起', async t => {
  const { clock, open, calls } = fixture(t);
  let changes = 0;
  const s = open(() => changes++);
  const { id } = s.add(def());
  s.disable(id, 'space_deleted');
  s.disable(id, 'again');
  assert.equal(changes, 3);
  assert.equal(s.list()[0].nextAt, null);
  assert.deepEqual(s.runs(id).map(r => [r.status, r.reason]), [['disabled', 'again'], ['disabled', 'space_deleted']]);
  clock.jump(22 * MINUTE);
  assert.equal(s.update(id, { enabled: true }).nextAt, 25 * MINUTE);
  clock.jump(20 * MINUTE);
  assert.equal(s.update(id, { rule: { ...interval, minutes: 6 } }).nextAt, 48 * MINUTE);
  await s.start();
  assert.equal(s.runs().length, 2);
  await clock.advance(6 * MINUTE);
  assert.equal(calls.length, 1);
  const before = changes;
  s.remove(id);
  assert.equal(changes, before + 1);
});

test('同一次唤醒合并跨周错过的日期，并停用错过或忙碌的一次性任务', async t => {
  const { clock, open, calls } = fixture(t, local(5, 8), { isBusy: s => s.rule.type === 'once' });
  const s = open();
  const early = s.add(def({ type: 'once', at: local(5, 9) }));
  const busy = s.add(def({ type: 'once', at: local(14, 9) }));
  const weekly = s.add(def({ type: 'weekly', days: [1, 3], time: '09:00' }));
  await s.start();
  clock.jump(local(14, 9, 1) - clock.now());
  await clock.advance(0);
  const [ok, missed] = s.runs(weekly.id);
  assert.equal(ok.at, local(14, 9));
  assert.equal(ok.status, 'ok');
  assert.equal(missed.count, 3);
  assert.equal(missed.from, local(5, 9));
  assert.equal(missed.to, local(12, 9));
  assert.equal(calls.length, 1);
  assert.equal(s.runs(early.id)[0].status, 'missed');
  assert.equal(s.runs(busy.id)[0].status, 'skipped');
  assert.deepEqual(s.list().filter(item => item.rule.type === 'once').map(item =>
    [item.enabled, item.nextAt, item.lastRunAt]), [[false, null, null], [false, null, local(14, 9)]]);
});

test('删除进行中的任务后，动作结束也不会重新写入它的记录', async t => {
  const pending = Promise.withResolvers();
  const { open, clock } = fixture(t, 0, { postMessage: () => pending.promise });
  const s = open();
  const { id } = s.add(def());
  await s.start();
  await clock.advance(5 * MINUTE);
  assert.equal(s.list()[0].running, true);
  s.remove(id);
  pending.resolve();
  await settle();
  assert.deepEqual(open().runs(), []);
});

test('每个任务保留最近 200 条，重启后仍按同毫秒内的插入顺序返回副本', t => {
  const { open } = fixture(t);
  const s = open();
  const a = s.add(def()).id;
  const b = s.add(def()).id;
  for (let i = 0; i < 201; i++) {
    s.disable(a, String(i));
    if (i === 199) s.disable(b, 'between');
  }
  const restored = open();
  assert.equal(restored.runs(a).length, 200);
  assert.equal(restored.runs(a).at(-1).reason, '1');
  const all = restored.runs();
  assert.equal(all.length, 201);
  assert.deepEqual(all.slice(0, 3).map(r => r.reason), ['200', 'between', '199']);
  all[0].reason = 'modified';
  assert.equal(restored.runs(a)[0].reason, '200');
});

test('等待忙碌查询时 stop 取消触发，重新启动后可以处理该时间点', async t => {
  const pending = Promise.withResolvers();
  const { open, clock, calls } = fixture(t, 0, { isBusy: () => pending.promise });
  const s = open();
  s.add(def({ type: 'once', at: 100 }));
  await s.start();
  await clock.advance(100);
  s.stop();
  pending.resolve(false);
  await settle();
  assert.equal(calls.length, 0);
  assert.deepEqual(s.runs(), []);
  assert.equal(clock.timers.size, 0);
  await s.start();
  await settle();
  assert.equal(calls.length, 1);
});

test('读坏的文件从空状态开始，写失败后仍通知并保留内存状态', t => {
  const { file, open } = fixture(t);
  fs.writeFileSync(file, '{');
  const warn = t.mock.method(console, 'warn', () => {});
  const error = t.mock.method(console, 'error', () => {});
  let changes = 0;
  const s = open(() => changes++);
  assert.deepEqual(s.list(), []);
  assert.equal(warn.mock.callCount(), 1);
  fs.mkdirSync(file + '.tmp');
  const added = s.add(def());
  assert.deepEqual(s.list(), [added]);
  assert.equal(error.mock.callCount(), 1);
  assert.equal(changes, 1);
});

// ---------- 接到空间上：app-server 的两种动作、跳过重叠、删空间停用、重启 ----------
test('app-server 到点发消息和建任务空间，上一次没跑完就跳过，删空间停用', { timeout: 30000 }, async t => {
  const { startServer } = await import('../src/app-server.mjs');
  const { until } = await import('./helpers.mjs');
  const root = tempDir(t);
  const dataDir = path.join(root, 'data');
  const folder = path.join(root, 'project');
  fs.mkdirSync(folder);
  const clock = fakeClock(Date.now());
  const active = [];
  const hooks = { locales: () => ['zh-CN'], scheduleActive: on => active.push(on) };
  let server = await startServer({ port: 0, dataDir, mock: true, hooks, clock });
  t.after(() => server.close());
  let hold = true; // 聊天成员一直说不完，直到放开
  const holdTurn = (opts) => new Promise((resolve, reject) => {
    const tick = setInterval(() => { if (!hold) { clearInterval(tick); resolve({ text: '收到。' }); } }, 20);
    opts.signal?.addEventListener('abort', () => { clearInterval(tick); reject(new Error('aborted')); });
  });
  const plan = { text: '```json\n{"tasks":[{"id":"T1","title":"整理","assignee":"Alice","deps":[],"spec":"整理资料"}]}\n```' };
  const fakeTurn = async (_engine, opts) => (opts.system.includes('这次任务协作的协调者') ? plan : holdTurn(opts));
  server.registry.runTurn = fakeTurn;
  const api = async (url, method = 'GET', body) => {
    const r = await fetch(`http://127.0.0.1:${server.port}${url}`, {
      method, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const members = [{ engine: 'claude-code', name: 'Alice' }, { engine: 'codex', name: 'Bob' }];
  const chat = (await api('/api/spaces', 'POST', { title: '早会', members, maxTurns: 1 })).body;
  assert.deepEqual(active, [false]);

  // 间隔下限在接口上也生效
  const tooShort = await api('/api/schedules', 'POST', { spaceId: chat.id, rule: { type: 'interval', minutes: 4 }, action: { type: 'message', text: '早' } });
  assert.equal(tooShort.status, 400);
  assert.match(tooShort.body.error, /5 分钟/);

  // 1. 在聊天空间发消息
  const msg = (await api('/api/schedules', 'POST', { spaceId: chat.id, rule: { type: 'interval', minutes: 5 }, action: { type: 'message', text: '大家早，说说今天的计划' } })).body;
  assert.deepEqual(active, [false, true]);
  await clock.advance(5 * MINUTE);
  const posted = await until(() => api(`/api/spaces/${chat.id}`).then(r => r.body), s => s.messages.some(m => m.kind === 'user' && m.text === '大家早，说说今天的计划'));
  assert.equal(posted.messages.filter(m => m.kind === 'user').length, 1);
  await until(() => api('/api/spaces').then(r => r.body.find(s => s.id === chat.id)), s => s.running);
  // 这一轮还没说完：下一次跳过
  await clock.advance(5 * MINUTE);
  await until(() => api(`/api/schedules/${msg.id}/runs`).then(r => r.body), runs => runs.some(r => r.status === 'skipped'));
  hold = false;
  await until(() => api('/api/spaces').then(r => r.body.find(s => s.id === chat.id)), s => !s.running);
  assert.deepEqual((await api(`/api/schedules/${msg.id}/runs`)).body.map(r => r.status), ['skipped', 'ok']);
  await api(`/api/schedules/${msg.id}`, 'PATCH', { enabled: false });

  // 2. 照模板新建任务空间
  const template = { title: '每日整理', goal: '整理今天的资料', members, workspace: { type: 'folder', path: folder }, access: 'edit', planConfirm: 'manual', reviewPlan: false };
  const task = (await api('/api/schedules', 'POST', { spaceId: chat.id, rule: { type: 'interval', minutes: 5 }, action: { type: 'task', template } })).body;
  await clock.advance(5 * MINUTE);
  const runs = await until(() => api(`/api/schedules/${task.id}/runs`).then(r => r.body), list => list.length === 1);
  assert.equal(runs[0].status, 'ok', JSON.stringify(runs[0]));
  const created = await until(() => api(`/api/spaces/${runs[0].spaceId}`).then(r => r.body), s => s.run?.status === 'plan_review');
  assert.equal(created.kind, 'task');
  assert.equal(created.scheduleId, task.id);
  assert.equal(created.workspacePath, folder);
  assert.equal(created.run.objective, '整理今天的资料');
  assert.equal((await api('/api/spaces')).body.find(s => s.id === created.id).scheduleId, task.id);
  // 计划还等你确认，算没跑完：跳过
  await clock.advance(5 * MINUTE);
  await until(() => api(`/api/schedules/${task.id}/runs`).then(r => r.body), list => list[0]?.status === 'skipped');
  // 结束了就算跑完：下一次照常建
  await api(`/api/spaces/${created.id}/run/finish`, 'POST', {});
  await clock.advance(5 * MINUTE);
  await until(() => api(`/api/schedules/${task.id}/runs`).then(r => r.body), list => list[0]?.status === 'ok' && list[0].spaceId !== created.id);

  // 3. 重启：定时任务和运行记录还在
  server.close();
  server = await startServer({ port: 0, dataDir, mock: true, hooks, clock });
  server.registry.runTurn = fakeTurn;
  const listed = (await api(`/api/schedules?spaceId=${chat.id}`)).body;
  assert.deepEqual(listed.map(s => [s.id, s.enabled]).sort(), [[msg.id, false], [task.id, true]].sort());
  assert.equal((await api('/api/schedules/runs')).body.length, 5);

  // 4. 所属空间删掉：停用并记录，没有启用的定时任务了
  const before = active.length;
  assert.equal((await api(`/api/spaces/${chat.id}`, 'DELETE')).status, 200);
  const after = (await api(`/api/schedules/${task.id}`)).body;
  assert.equal(after.enabled, false);
  assert.equal((await api(`/api/schedules/${task.id}/runs`)).body[0].reason, 'space_deleted');
  assert.equal(active.at(-1), false);
  assert.ok(active.length > before);
  assert.equal((await api('/api/schedules', 'POST', { spaceId: chat.id, rule: { type: 'interval', minutes: 5 }, action: { type: 'message', text: '早' } })).status, 400);
  // 停掉剩下的任务空间，别让后台规划留到测试结束
  for (const s of (await api('/api/spaces')).body) await api(`/api/spaces/${s.id}`, 'DELETE');
});
