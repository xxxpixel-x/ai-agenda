import assert from 'node:assert/strict';
import path from 'node:path';
import { createSettings } from '../src/settings.mjs';
import { startServer } from '../src/app-server.mjs';
import { runTurn as demo } from '../src/engines/mock.mjs';
import { apiRequest, isHandoffCall, HANDOFF_IDLE, isMemoryCall, MEMORY_IDLE, makeSpace, tempDir, until, settleSpace, testInChinese as test } from './helpers.mjs';

const alice = { id: 'member_a', engine: 'claude-code', name: 'Alice' };
const bob = { id: 'member-b', engine: 'codex', name: 'Bob' };
const idle = (s) => until(() => s.pendingOperations.size, (n) => n === 0);
const gate = () => Promise.withResolvers();

test('context settings validate bounds, preserve provider windows and persist learned limits separately', (t) => {
  const file = path.join(tempDir(t), 'settings.json');
  const settings = createSettings(file);
  assert.equal(settings.publicView().autoHandoffPct, 50);
  for (const n of [0, 10, 95, 51]) assert.equal(settings.update({ autoHandoffPct: n }).autoHandoffPct, n);
  for (const n of [5, 99, -1, '50', 10.5]) assert.throws(() => settings.update({ autoHandoffPct: n }));
  const [provider] = settings.update({ providers: [{ name: 'Example', model: 'm', contextWindow: 12345 }] }).providers;
  settings.rememberContextLimit('provider:' + provider.id + ':m', 6000);
  settings.update({ providers: [{ name: 'Example', id: provider.id }] });
  assert.equal(settings.publicView().providers[0].contextWindow, 12345);
  for (const n of [-1, 1023, 4000001, '20000']) assert.throws(() => settings.update({ providers: [{ name: 'Example', contextWindow: n }] }));
  assert.equal(createSettings(file).publicView().autoHandoffPct, 51);
  assert.deepEqual(createSettings(file).get().contextLimits, { ['provider:' + provider.id + ':m']: 6000 });
});

test('rollover compacts once and combines memory with a numbered recap; a concurrent edit wins', async (t) => {
  const space = makeSpace(tempDir(t), { members: [bob] });
  t.after(() => settleSpace(space));
  space.registry.settings.rememberContextLimit('codex:default', 110000);
  const compact = t.mock.method(space.memory, 'compact');
  const started = gate(), release = gate();
  const organizer = [];
  let pause = true;
  space.registry.runTurn = async (_engine, opts) => {
    if (!isMemoryCall(opts)) return { text: 'answer' };
    organizer.push(opts);
    if (pause) { started.resolve(); await release.promise; }
    return demo(opts);
  };
  space.data.messages.push(...Array.from({ length: 25 }, (_, i) => ({ kind: 'user', text: '第' + i + '条' + '字'.repeat(2500), ts: i })));
  space.save();
  space.userMessage('continue');
  await started.promise;
  // 解耦 recapTargetSeq 与 compact：无足够可清理 L1 失效/撤回条目时不触发 compact
  assert.equal(compact.mock.callCount(), 0);
  assert.equal(space.data.recapTargetSeq, 10);
  assert.equal(space.data.lastCompactedSeq, 0);
  assert.match(organizer[0].prompt, /## 移出聊天记录的消息[\s\S]*消息 10/);
  assert.match(organizer[0].prompt, /<消息 1 /);
  const edit = space.updateRecap('Keep this edit', 0);
  pause = false;
  release.resolve();
  // 若同批消息有积压，下一批可基于新版本追加；并发的旧版本必须跳过。
  await idle(space);
  assert.ok(space.data.organizeLogs[0].note);
  assert.ok(space.data.recap.text.startsWith(edit.text));
  // 写入 ≥3 条已失效 L1 条目后再触发挪档，此时应执行 compact
  const [d1, d2, d3] = space.memory.append([
    { type: 'decision', origin: 'user', text: '旧规则 1', reason: '旧', source: { messages: [1] } },
    { type: 'decision', origin: 'user', text: '旧规则 2', reason: '旧', source: { messages: [1] } },
    { type: 'decision', origin: 'user', text: '旧规则 3', reason: '旧', source: { messages: [1] } },
  ]);
  space.memory.retract(d1.id, { seqAt: 1 });
  space.memory.retract(d2.id, { seqAt: 1 });
  space.memory.retract(d3.id, { seqAt: 1 });
  space.data.messages.push(...Array.from({ length: 10 }, () => ({ kind: 'user', text: '新'.repeat(3000) })));
  space.save();
  space.userMessage('continue again');
  await idle(space);
  const recap = space.recapView();
  assert.ok(recap.text.startsWith(edit.text + '\n\n'));
  assert.match(recap.text, /消息 20/);
  assert.equal(recap.uptoSeq, space.data.recapTargetSeq);
  assert.ok(recap.editedByUser && recap.version > edit.version && recap.updatedAt);
  assert.equal(compact.mock.callCount(), 1);
  const [saved] = space.store.loadAll();
  assert.deepEqual(saved.recap, recap);
  assert.ok(saved.organizeLogs.some((r) => r.memberId === bob.id && r.usage.input > 0 && r.recapUptoSeq === recap.uptoSeq));
});

test('auto-handoff uses old session, files failed approaches, then hands three recent rounds to a fresh session', async (t) => {
  const space = makeSpace(tempDir(t), { members: [alice] });
  t.after(() => settleSpace(space));
  const calls = [], handoffs = [];
  let usage = {};
  space.registry.runTurn = async (_engine, opts) => {
    if (isMemoryCall(opts)) return demo(opts);
    if (isHandoffCall(opts)) {
      handoffs.push(opts);
      assert.equal(space.running, false);
      return { text: '索引方案失败，因为目录只读。未完成：检查消息 6。' };
    }
    calls.push(opts);
    return { text: '答复-' + calls.length, sessionId: opts.sessionId || 'session-' + calls.length, usage };
  };
  space.registry.settings.update({ autoHandoffPct: 0 });
  usage = { contextUsed: 99, contextWindow: 100 };
  space.userMessage('第1题');
  await idle(space);
  space.registry.settings.update({ autoHandoffPct: 50 });
  for (const [i, incomplete] of [[2, {}], [3, { contextWindow: 100 }], [4, { contextUsed: 98 }]]) {
    usage = incomplete;
    space.userMessage('第' + i + '题');
    await idle(space);
  }
  assert.equal(handoffs.length, 0);
  usage = { contextUsed: 50, contextWindow: 100 };
  space.userMessage('第5题');
  await idle(space);
  assert.equal(handoffs.length, 1);
  assert.deepEqual([handoffs[0].sessionId, handoffs[0].access, handoffs[0].keepSession], ['session-1', 'read', true]);
  const [handoff] = space.data.handoffs[alice.id];
  assert.equal(handoff.reason, 'auto');
  assert.equal(space.data.memberState[alice.id].pendingHandoff, handoff.summary);
  assert.equal(space.data.messages.length, 10);
  const rejected = space.memory.active().find((e) => e.type === 'rejected');
  assert.match(rejected.text, /索引方案失败/);
  assert.equal(rejected.origin, 'attempt');
  assert.deepEqual(rejected.attempt, { memberId: alice.id, engine: alice.engine });
  assert.deepEqual(rejected.source.messages, [10]);
  usage = {};
  space.userMessage('第6题');
  await idle(space);
  const next = calls.at(-1);
  assert.equal(next.sessionId, undefined);
  assert.ok(next.prompt.includes(handoff.summary));
  assert.deepEqual(next.prompt.match(/第\d题/g), ['第4题', '第5题', '第6题']);
  assert.match(next.prompt, /# 空间记忆库[\s\S]*索引方案失败/);
  assert.equal(space.data.memberState[alice.id].pendingHandoff, undefined);
  assert.equal(space.data.memberState[alice.id].sessionId, 'session-6');
});

test('handoff failures and aborts preserve the old session; configuration changes use the old member', async (t) => {
  const space = makeSpace(tempDir(t), { members: [alice] });
  t.after(() => settleSpace(space));
  const state = { sessionId: 'old', seen: 2, sig: 'old-sig' };
  space.data.memberState[alice.id] = { ...state };
  let fail = true;
  const old = [];
  space.registry.runTurn = async (_engine, opts) => {
    if (isMemoryCall(opts)) return MEMORY_IDLE;
    assert.ok(isHandoffCall(opts));
    old.push(opts);
    if (fail) throw Object.assign(new Error('interrupted'), { aborted: true });
    return { text: '待办：核对任务 T2' };
  };
  await assert.rejects(space.handoffMember(alice.id), /interrupted/);
  assert.deepEqual(space.data.memberState[alice.id], state);
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(await space.handoffMember(alice.id, 'auto'), null);
  assert.ok(warn.mock.callCount() > 0);
  assert.deepEqual(space.data.memberState[alice.id], state);
  fail = false;
  space.update({ members: [{ ...alice, model: 'new' }] });
  assert.equal(space.data.memberState[alice.id], undefined);
  await idle(space);
  assert.equal(old.at(-1).model, '');
  assert.equal(old.at(-1).sessionId, 'old');
  assert.match(space.data.memberState[alice.id].pendingHandoff, /T2/);
  space.data.memberState[alice.id] = state;
  space.update({ members: [alice, bob] });
  assert.equal(space.data.memberState[alice.id], undefined);
  await idle(space);
  assert.equal(space.data.memberState[alice.id], undefined);
  assert.deepEqual(space.data.handoffs[alice.id].map((h) => h.reason), ['config_changed', 'config_changed']);
});

test('context, recap, settings and manual handoff HTTP responses have the exact contract', async (t) => {
  const server = await startServer({ port: 0, mock: true, dataDir: tempDir(t) });
  t.after(() => server.close());
  const call = async (url, method = 'GET', body) => {
    const r = await apiRequest(server, url, method, body);
    return { status: r.status, data: await r.json() };
  };
  const empty = { text: '', uptoSeq: 0, version: 0, editedByUser: false, updatedAt: null };
  const created = await call('/api/spaces', 'POST', { members: [alice], access: 'read' });
  assert.equal(created.status, 201);
  const url = '/api/spaces/' + created.data.id;
  const preview = (await call(url + '/context')).data;
  assert.deepEqual(Object.keys(preview).sort(), ['members', 'recap']);
  assert.deepEqual(preview.recap, empty);
  const p = preview.members[alice.id];
  assert.deepEqual(Object.keys(p).sort(), ['breakdown', 'canHandoff', 'handoffs', 'lastTurnAt', 'mode', 'running']);
  assert.deepEqual([p.lastTurnAt, p.mode, p.canHandoff, p.running, p.handoffs], [0, 'session', true, false, []]);
  for (const [section, fields] of Object.entries({ system: [], recap: [], imports: [], files: [], recent: ['count'], omitted: ['count'], memory: ['entryIds'] })) {
    assert.deepEqual(Object.keys(p.breakdown[section]).sort(), ['chars', 'tokens', ...fields].sort());
  }
  assert.deepEqual(p.breakdown.memory.entryIds, []);
  assert.equal((await call('/api/spaces/00000000-0000-0000-0000-000000000000/context')).status, 404);
  for (const body of [{}, { text: 3 }]) assert.equal((await call(url + '/recap', 'PUT', body)).status, 400);
  const saved = await call(url + '/recap', 'PUT', { text: '  edited  ', version: 0 });
  assert.deepEqual(Object.keys(saved.data), ['recap']);
  assert.equal(saved.status, 200);
  const conflict = await call(url + '/recap', 'PUT', { text: 'stale', version: 0 });
  assert.equal(conflict.status, 409);
  assert.deepEqual(Object.keys(conflict.data).sort(), ['error', 'recap']);
  assert.deepEqual(conflict.data.recap, saved.data.recap);
  assert.equal(conflict.data.recap.text, 'edited');
  assert.equal((await call('/api/settings')).data.autoHandoffPct, 50);
  assert.equal((await call('/api/settings', 'PUT', { autoHandoffPct: 5 })).status, 400);
  assert.equal((await call('/api/settings', 'PUT', { autoHandoffPct: 0 })).data.autoHandoffPct, 0);

  const started = gate(), release = gate(), handoffStarted = gate(), finishHandoff = gate();
  server.registry.runTurn = async (_engine, opts) => {
    if (isMemoryCall(opts)) return MEMORY_IDLE;
    if (isHandoffCall(opts)) { handoffStarted.resolve(); await finishHandoff.promise; return HANDOFF_IDLE; }
    started.resolve();
    await release.promise;
    opts.onActivity({ kind: 'command', label: 'Run npm test' });
    return { text: 'answer', sessionId: 'first' };
  };
  await call(url + '/messages', 'POST', { text: 'hello' });
  await started.promise;
  const route = url + '/members/' + alice.id + '/handoff';
  const busy = await call(route, 'POST');
  assert.equal(busy.status, 409);
  assert.deepEqual(Object.keys(busy.data), ['error']);
  release.resolve();
  await until(async () => (await call(url)).data.running, (v) => !v);
  const handoff = call(route, 'POST');
  await handoffStarted.promise;
  assert.equal((await call(route, 'POST')).status, 409);
  finishHandoff.resolve();
  const done = await handoff;
  assert.equal(done.status, 200);
  assert.equal(done.data.ok, true);
  assert.deepEqual(done.data.handoff, { at: done.data.handoff.at, summary: '', reason: 'manual' });
  const unknown = await call(url + '/members/no_such_id/handoff', 'POST');
  assert.equal(unknown.status, 404);
  assert.deepEqual(Object.keys(unknown.data), ['error']);
  const view = (await call(url + '/context')).data.members[alice.id];
  assert.deepEqual(view.handoffs, [done.data.handoff]);
  assert.ok(view.lastTurnAt > 0);
  assert.equal(view.breakdown.recent.count, 1);
  assert.deepEqual((await call(url)).data.messages.at(-1).actions, ['npm test']);
});

