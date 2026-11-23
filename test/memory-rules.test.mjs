import assert from 'node:assert/strict';
import { testInChinese as test } from './helpers.mjs';
import { check, normalizeOps } from '../src/memory/rules.mjs';

const ctx = {
  messages: new Map([
    [1, { kind: 'user', ts: 10 }], [2, { kind: 'ai', ts: 20 }],
    [3, { kind: 'ai', ts: 30, changes: true }], [4, { kind: 'ai', ts: 40, activities: true }],
    [5, { kind: 'import', ts: 50, originalTs: 5 }],
  ]),
  tasks: new Map([['T1', { status: 'approved', approvedAt: 29, attempts: [
    { n: 1, endedAt: 21, error: '未完成' }, { n: 2, endedAt: 28, outcome: 'done' },
  ] }], ['T2', { status: 'review', attempts: [{ n: 1, endedAt: 31 }] }]]),
};
const messages = (...seq) => ({ messages: seq });
const tasks = (...refs) => ({ tasks: refs });
const decision = { type: 'decision', text: '登录用短信', reason: '人人都有手机', topics: ['登录'], source: messages(1) };
const old = { ...decision, origin: 'user', status: 'active', at: 10, id: 12 };
const change = { ...decision, text: '登录改用邮箱', reason: '已有企业邮箱', answers: '员工均配了邮箱', op: 'supersede', target: 12 };
const run = (patch, entries = []) => check({ ...decision, ...patch }, entries, ctx);

test('拒绝无出处、虚构消息、任务和执行，以及缺失的必填项', () => {
  for (const [patch, reason] of [
    [{ source: { messages: [], tasks: [], files: [] } }, '没有出处'],
    [{ source: messages(999) }, '出处里的消息 999 不存在'],
    [{ source: tasks('T7') }, '出处里的任务 T7 不存在'],
    [{ source: tasks('T1/3') }, '出处里的执行 T1/3 不存在'],
    [{ type: 'draft' }, '未知的条目类型'], [{ text: ' \n ' }, '条目内容为空'],
    [{ type: 'result' }, '任务结果没有子任务编号'],
    ...['decision', 'constraint', 'rejected'].map((type) => [{ type, reason: ' ' }, '没有写原因']),
  ]) assert.deepEqual(run(patch), { ok: false, reason });
  assert.equal(check(null, []).ok, false);
  assert.equal(run({ op: 'erase' }).ok, false);
});

test('规范化字段，去掉自报状态和编号，只保留存在的相关编号', () => {
  const items = Array.from({ length: 12 }, (_, i) => '文件' + i);
  const { entry } = run({ op: 'add', id: 99, at: 99, status: 'resolved', supersededBy: 12, text: '长'.repeat(320),
    reason: '长'.repeat(220), topics: [' ', ...items, ...items], files: [...items, ...items], related: [2, 12, 12] }, [old]);
  assert.equal(entry.text.length, 300);
  assert.equal(entry.reason.length, 200);
  assert.deepEqual(entry.topics, items.slice(0, 10));
  assert.deepEqual(entry.files, entry.topics);
  assert.deepEqual(entry.related, [12]);
  for (const key of ['id', 'op', 'status', 'supersededBy']) assert.ok(!(key in entry));
  assert.equal(entry.at, 10);
  assert.equal(run({ source: messages(1, 3) }).entry.at, 30);
  assert.equal(check({ ...decision, at: 6 }).entry.at, 6);
  assert.equal(check(decision).entry.origin, 'default');
  assert.equal(check({ ...decision, origin: 'user' }).entry.origin, 'user');
});

test('决定区分用户原话、已经照做的出处、单纯的 AI 建议', () => {
  assert.equal(run({}).entry.origin, 'user');
  for (const source of [messages(3), tasks('T1'), tasks('T2/1')]) {
    assert.equal(run({ source, origin: 'user' }).entry.origin, 'default');
    assert.equal(run({ source, origin: 'default' }).entry.type, 'decision');
  }
  for (const source of [messages(2), tasks('T1/1'), tasks('T2')]) {
    const r = run({ source, origin: 'default' });
    assert.equal(r.entry.type, 'proposal');
    assert.equal(r.entry.origin, undefined);
    assert.equal(r.entry.reason, decision.reason);
    assert.match(r.note, /提议/);
  }
  assert.equal(run({ source: tasks('T1') }).entry.at, 29);
  assert.equal(run({ source: tasks('T1/2') }).entry.at, 28);
  for (const type of ['constraint', 'preference']) {
    assert.equal(run({ type }).entry.origin, 'user');
    assert.equal(run({ type, source: messages(3) }).entry.type, 'proposal');
  }
});

test('项目事实需要用户、文件、任务或实际工具操作的证据', () => {
  for (const source of [messages(1), messages(3), messages(4), tasks('T2'), { files: ['模拟.js'] }]) {
    const { entry } = run({ type: 'fact', source, origin: 'user' });
    assert.equal(entry.type, 'fact');
    assert.equal(entry.origin, undefined);
  }
  assert.equal(run({ type: 'fact', source: messages(2) }).reason, 'AI 没验证过的说法不算项目事实');
});

test('取代要求有效目标、相同主题、兼容类型、同范围和回应旧原因', () => {
  for (const [patch, reason] of [
    [{ target: 15 }, /不存在/], [{ text: '新增图表', topics: [] }, /同一件事/],
    [{ type: 'fact' }, /同一件事/], [{ scope: 'T1' }, /适用范围不同/], [{ answers: ' ' }, /没有回应 #12/],
  ]) assert.match(run({ ...change, ...patch }, [old]).reason, reason);
  assert.match(run(change, [{ ...old, status: 'superseded', by: 18 }]).reason, /已经被取代/);
  assert.deepEqual(run({ ...change, scope: '  ', topics: [] }, [old]).entry.supersedes, [12]);
  assert.deepEqual(run({ ...change, type: 'constraint' }, [old]).entry.supersedes, [12]);
  const fact = { ...old, type: 'fact', reason: '', origin: undefined };
  assert.deepEqual(run({ ...change, type: 'fact' }, [fact]).entry.supersedes, [12]);
});

test('AI 做法可以更改默认决定；用户定的保留，另记分歧', () => {
  const r = run({ ...change, source: messages(3) }, [old]);
  assert.equal(r.entry.type, 'disagreement');
  assert.equal(r.entry.text, '和 #12 不一致：登录改用邮箱');
  assert.equal(r.entry.ask, true);
  assert.deepEqual(r.entry.related, [12]);
  assert.equal(r.entry.supersedes, undefined);
  assert.equal(r.entry.origin, undefined);
  assert.equal(r.note, '你定的 #12 只有你能改，记成分歧');
  assert.equal(old.status, 'active');
  const replacement = run({ ...change, source: messages(3) }, [{ ...old, origin: 'default' }]).entry;
  assert.equal(replacement.origin, 'default');
  assert.deepEqual(replacement.supersedes, [12]);
});

test('补导原话按原时间归档，旧目标沿取代链定位当前条目', () => {
  const r = run({ ...change, source: messages(5) }, [old]);
  assert.deepEqual([r.entry.at, r.entry.importedAt, r.entry.supersededBy], [5, 50, 12]);
  assert.equal(r.entry.supersedes, undefined);
  assert.match(r.note, /历史/);
  assert.equal(run({ source: messages(5), at: 60 }).entry.at, 5);
  assert.equal(run({ source: messages(5), at: 7 }).entry.at, 7);
  const latest = { ...old, id: 18, at: 25 };
  assert.equal(run({ ...change, source: messages(5) }, [{ ...old, status: 'superseded', by: 18 }, latest]).entry.supersededBy, 18);
});

test('解决问题、提议和分歧；降级的提议不能解决目标', () => {
  for (const type of ['question', 'proposal', 'disagreement']) {
    const target = { ...old, type, text: '登录是否支持短信？' };
    assert.deepEqual(run({ op: 'resolve', target: 12 }, [target]).entry.resolves, [12]);
    const r = run({ supersedes: [12] }, [target]);
    assert.deepEqual(r.entry.resolves, [12]);
    assert.equal(r.entry.supersedes, undefined);
    const downgraded = run({ resolves: [12], source: messages(2) }, [target]);
    assert.equal(downgraded.entry.resolves, undefined);
    assert.match(downgraded.note, /不能解决/);
    assert.equal(run({ resolves: [12] }, [{ ...target, status: 'resolved' }]).ok, false);
  }
  assert.equal(run({ resolves: [12] }, [old]).ok, false);
  assert.equal(run({ op: 'disagree' }).entry.ask, true);
  assert.equal(run({ op: 'disagree' }).entry.type, 'disagreement');
});

test('否决必须有原因和用户或任务出处，可同时解决被否的提议', () => {
  assert.equal(run({ op: 'reject', reason: '' }).ok, false);
  assert.equal(run({ op: 'reject', source: messages(3) }).ok, false);
  const { entry } = run({ op: 'reject', source: tasks('T1/1'), target: 12 }, [{ ...old, type: 'proposal' }]);
  assert.equal(entry.type, 'rejected');
  assert.deepEqual(entry.resolves, [12]);
});

test('打回重做只取代同任务的有效结果，同一次执行不重复记', () => {
  const v1 = run({ task: 'T1', type: 'result', source: tasks('T1/1') }).entry;
  const saved = { ...v1, id: 1, status: 'active' };
  const redo = { task: 'T1', type: 'result', text: '重新设计接口', source: tasks('T1/2') };
  assert.deepEqual(run(redo, [saved]).entry.supersedes, [1]);
  assert.match(run({ ...redo, source: tasks('T1/1') }, [{ ...saved, status: 'superseded' }]).reason, /已经记为 #1/);
  assert.equal(run({ ...redo, task: 'T2', supersedes: [1] }, [saved]).ok, false);
  assert.deepEqual(run({ ...redo, source: messages(1) }).entry.source.tasks, ['T1']);
  assert.equal(run({ text: '登 录用 短信' }, [old]).reason, '和 #12 重复');
});

test('读取整段 JSON 和 JSON 围栏，无法解析或缺少操作数组时返回 null', () => {
  const ops = [{ type: 'proposal' }];
  for (const value of [ops, { ops }]) {
    const json = JSON.stringify(value);
    for (const raw of [json, '```json\n' + json + '\n```', '说明\n```\n' + json + '\n```']) assert.deepEqual(normalizeOps(raw), ops);
  }
  for (const value of ['', '坏 JSON', '{}', 'null', '{"ops":{}}', null]) assert.equal(normalizeOps(value), null);
});

test('第四批规则：confirmedBy 硬保护、inBatch 与交接隔离、rejected 分源与冲突提案', () => {
  const richCtx = {
    messages: new Map([
      [1, { kind: 'user', ts: 10, inBatch: false }],
      [2, { kind: 'user', ts: 20, inBatch: true }],
      [3, { kind: 'ai', ts: 30, changes: true, inBatch: true }],
      [4, { kind: 'user', ts: 40, inBatch: true }],
    ]),
    handoffSeqs: new Set([4]),
    handoffs: new Map([[4, { memberId: 'm1', engine: 'claude-code', model: 'sonnet' }]]),
    knownFiles: new Set(['src/login.js']),
    tasks: new Map([['T1', { status: 'review', attempts: [{ n: 1, endedAt: 25, error: 'boom', memberId: 'm2', engine: 'codex', model: 'gpt-5' }] }]]),
  };
  // 非本批旧用户消息不能刷 proof.user
  const staleUser = check({ ...decision, source: messages(1) }, [], richCtx);
  assert.equal(staleUser.entry.type, 'proposal');
  // 强鉴证目标即使本批有用户消息也一律转分歧，并保存 conflicts + proposed
  const confirmed = { ...old, id: 12, confirmedBy: 'user', at: 10 };
  const conflict = check({ ...change, source: messages(2) }, [confirmed], richCtx);
  assert.equal(conflict.entry.type, 'disagreement');
  assert.equal(conflict.entry.ask, true);
  assert.deepEqual(conflict.entry.conflicts, [12]);
  assert.deepEqual(conflict.entry.proposed, { type: 'decision', text: '登录改用邮箱', reason: '已有企业邮箱' });
  // 交接锚点虽是用户消息，rejected 仍归为 origin:'attempt' 并带交接成员快照
  const handoffRej = check({ op: 'reject', text: '索引方案走不通', reason: '目录只读', source: messages(4) }, [], richCtx);
  assert.equal(handoffRej.entry.origin, 'attempt');
  assert.deepEqual(handoffRej.entry.attempt, { memberId: 'm1', engine: 'claude-code', model: 'sonnet' });
  // 任务试错带 attempt 快照；用户否决受保护，试错可被新理由推翻
  const taskRej = check({ op: 'reject', text: '方案 A 不行', reason: '报错', topics: ['登录'], source: tasks('T1/1') }, [], richCtx);
  assert.equal(taskRej.entry.origin, 'attempt');
  assert.deepEqual(taskRej.entry.attempt, { memberId: 'm2', engine: 'codex', model: 'gpt-5' });
  const userRej = { id: 20, type: 'rejected', origin: 'user', text: '不用邮箱', reason: '没人用', topics: ['登录'], scope: '', at: 10, status: 'active' };
  const aiOverrideUserRej = check({ type: 'decision', text: '改用邮箱', reason: '新需求', answers: '有了', topics: ['登录'], op: 'supersede', target: 20, source: messages(3) }, [userRej], richCtx);
  assert.equal(aiOverrideUserRej.entry.type, 'disagreement');
  const attemptRej = { ...userRej, id: 21, origin: 'attempt' };
  const aiOverrideAttempt = check({ type: 'decision', text: '改用邮箱', reason: '换引擎可行', answers: '已验证', topics: ['登录'], op: 'supersede', target: 21, source: messages(3) }, [attemptRej], richCtx);
  assert.equal(aiOverrideAttempt.entry.type, 'decision');
  assert.deepEqual(aiOverrideAttempt.entry.supersedes, [21]);
  // fact 核对 knownFiles
  assert.equal(check({ type: 'fact', text: '假文件', source: { files: ['fake.js'] } }, [], richCtx).ok, false);
  assert.equal(check({ type: 'fact', text: '真文件', source: { files: ['src\\login.js'] } }, [], richCtx).ok, true);
});

test('第四批规则：先找链头再比时间、resolve 范围与时间校验、跨 scope 共存与 seqAt 撤回防重', () => {
  const a = { ...old, id: 1, at: 10, status: 'superseded', by: 2 };
  const b = { ...old, id: 2, at: 30, origin: 'user', status: 'active' };
  // 链中补导（at=20 指向已被 #2(at=30) 取代的 #1）应归入 #2 历史
  const mid = check({ ...change, target: 1, source: messages(2) }, [a, b], ctx);
  assert.equal(mid.entry.supersededBy, 2);
  // 较新操作指向旧 #1，必须按链头 #2 的保护规则校验
  const newerAi = check({ ...change, target: 1, source: messages(3) }, [a, { ...b, at: 25 }], ctx);
  assert.equal(newerAi.entry.type, 'disagreement');
  assert.deepEqual(newerAi.entry.conflicts, [2]);
  // 混合历史和冲突目标必须拆开
  const c = { ...old, id: 3, at: 10, origin: 'user', status: 'active' };
  const mixed = check({ ...change, target: undefined, supersedes: [2, 3], source: messages(3) }, [b, c], {
    ...ctx, messages: new Map([[3, { kind: 'ai', ts: 20, changes: true }]]),
  });
  assert.equal(mixed.ok, false);
  assert.match(mixed.reason, /拆分/);
  // resolve 校验 scope 与时间
  const q = { id: 9, type: 'question', text: '用啥库？', scope: 'T1', at: 20, status: 'active', source: messages(2) };
  assert.equal(check({ type: 'fact', text: '用 sqlite', scope: '', resolves: [9], source: messages(3) }, [q], ctx).ok, false);
  assert.equal(check({ type: 'fact', text: '用 sqlite', scope: 'T1', resolves: [9], source: messages(1) }, [q], ctx).ok, false);
  assert.equal(check({ type: 'fact', text: '用 sqlite', scope: 'T1', resolves: [9], source: messages(3) }, [q], ctx).ok, true);
  // 跨 scope 同文共存 & 同文取代改理由不撞去重
  const scoped = { ...old, id: 12, scope: 'T1' };
  assert.equal(check({ ...decision, scope: 'T2' }, [scoped], ctx).ok, true);
  assert.equal(check({ ...decision, scope: 'T1', reason: '补充新理由', answers: '更清晰', op: 'supersede', target: 12 }, [scoped], ctx).ok, true);
  // 撤回防重按 seqAt
  const retracted = { ...old, id: 12, status: 'retracted', by: 13, retractedSeqAt: 2, retractedAt: 25 };
  assert.equal(check({ ...decision, source: messages(1) }, [retracted], ctx).ok, false);
  const freshCtx = { ...ctx, messages: new Map([...ctx.messages, [6, { kind: 'user', ts: 60, inBatch: true }]]) };
  assert.equal(check({ ...decision, source: messages(6) }, [retracted], freshCtx).ok, true);
});
