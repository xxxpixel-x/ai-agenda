import assert from 'node:assert/strict';
import { testInChinese as test, tempDir, makeSpace, until, beginTask, settleSpace } from './helpers.mjs';
import { latest, summarize } from '../src/usage.mjs';
import { runAgentTurn } from '../src/turn-runner.mjs';

// 按测试中已知的发言顺序手动分组，再对照空间汇总。
function mockTotal(...usages) {
  return {
    input: usages.reduce((n, u) => n + u.input, 0),
    output: usages.reduce((n, u) => n + u.output, 0),
    cacheRead: 0, cacheWrite: 0, turns: usages.length,
  };
}

test('模拟聊天的回复记录完整用量，按发言成员汇总', async (t) => {
  const space = makeSpace(tempDir(t), { access: 'read' });
  t.after(() => settleSpace(space));
  await space.userMessage('一起讨论一下这个方案');
  await until(() => space.running, (running) => !running);
  const replies = space.data.messages.filter((m) => m.kind === 'ai');
  const [alice, bob] = space.data.members;
  assert.deepEqual(replies.map((m) => m.memberId), [alice.id, bob.id]);
  for (const { text, usage } of replies) {
    assert.ok(usage.input > 0);
    assert.equal(usage.output, Math.ceil(text.length / 4));
    assert.equal(usage.cacheRead, 0);
    assert.equal(usage.cacheWrite, 0);
    assert.equal(usage.contextUsed, usage.input + usage.output);
    assert.equal(usage.contextWindow, 200000);
    assert.deepEqual(usage.quota, { usedPct: 12, resetsAt: Date.UTC(2030, 0, 1) });
  }
  assert.deepEqual(summarize(space.data), {
    [alice.id]: mockTotal(replies[0].usage),
    [bob.id]: mockTotal(replies[1].usage),
  });
});

test('模拟 AI 直接跳过也按输入和返回文字的长度计算用量', async (t) => {
  const space = makeSpace(tempDir(t));
  const system = '你是「Alice」';
  const prompt = '<消息 来自="Alice">一\n<消息 来自="Alice">二';
  const { text, usage } = await space.registry.runTurn('claude-code', { system, prompt, access: 'read' });
  assert.equal(text, '[跳过]');
  assert.equal(usage.input, Math.ceil((system.length + prompt.length) / 4));
  assert.equal(usage.output, Math.ceil(text.length / 4));
});

test('任务的规划、派活和总结分别记到执行成员名下', async (t) => {
  const space = makeSpace(tempDir(t));
  t.after(() => settleSpace(space));
  await beginTask(space, { objective: '写一份方案', autoApprove: true });
  const run = space.run.data;
  await until(() => run.status, (s) => s === 'plan_review');
  await space.runAction('approve-plan');
  await until(() => run.status, (s) => s === 'done');

  const [alice, bob] = space.data.members;
  assert.deepEqual(run.planning.messages.map((m) => m.memberId), [alice.id, bob.id]);
  const [plan, review] = run.planning.messages;
  const attempts = run.tasks.map((task) => {
    assert.equal(task.status, 'approved');
    assert.equal(task.attempts.length, 1);
    assert.equal(task.attempts[0].memberId, task.assigneeId);
    return task.attempts[0];
  });
  assert.deepEqual(attempts.map((a) => a.memberId), [alice.id, bob.id, alice.id]);
  for (const sink of [plan, review, ...attempts, run.summary]) {
    assert.ok(sink.usage?.input > 0 && sink.usage.output > 0);
  }
  assert.deepEqual(summarize(space.data), {
    [alice.id]: mockTotal(plan.usage, attempts[0].usage, attempts[2].usage, run.summary.usage),
    [bob.id]: mockTotal(review.usage, attempts[1].usage),
  });
});

test('旧空间和未完成的任务可以没有用量', () => {
  for (const data of [undefined, {}, { messages: [{ memberId: 'a' }] },
    { runs: [null, {}, { planning: {}, tasks: [null, {}], summary: null }] }]) {
    assert.deepEqual(summarize(data), {});
    assert.equal(latest(data, 'a'), null);
  }
});

test('汇总处理缺失字段、改派和时间筛选，最近用量按时间再按遍历顺序取', () => {
  const data = {
    messages: [
      { memberId: 'a', ts: 20, usage: { input: 3, output: NaN, cacheRead: '9' } },
      { memberId: 'a', usage: { input: 5 } },
      { ts: 50, usage: { input: 99 } },
    ],
    runs: [{
      coordinatorId: 'a', finishedAt: 20, updatedAt: 40,
      tasks: [{ assigneeId: 'b', attempts: [
        { memberId: 'a', startedAt: 10, usage: { cacheRead: 7 } },
        { startedAt: 30, usage: { output: 2 } },
      ] }],
      summary: { usage: { cacheWrite: 4 } },
    }, {
      coordinatorId: 'b', updatedAt: 25, summary: { usage: {} },
    }],
  };
  assert.deepEqual(summarize(data), {
    a: { input: 8, output: 0, cacheRead: 7, cacheWrite: 4, turns: 4 },
    b: { input: 0, output: 2, cacheRead: 0, cacheWrite: 0, turns: 2 },
  });
  assert.deepEqual(summarize(data, { since: 20 }), {
    a: { input: 3, output: 0, cacheRead: 0, cacheWrite: 4, turns: 2 },
    b: { input: 0, output: 2, cacheRead: 0, cacheWrite: 0, turns: 2 },
  });
  assert.deepEqual(summarize(data, { since: 26 }), {
    b: { input: 0, output: 2, cacheRead: 0, cacheWrite: 0, turns: 1 },
  });
  assert.deepEqual(latest(data, 'a'), { cacheWrite: 4 });
  assert.deepEqual(latest(data, 'b'), { output: 2 });
  assert.equal(latest(data, 'c'), null);
});

test('单轮调用按需写入用量，保留已有成员', async () => {
  const member = { id: 'a', engine: 'mock' };
  const registry = { runTurn: async () => ({ text: 'hi' }), isApi: () => false };
  const sink = {};
  await runAgentTurn(registry, member, { sink });
  assert.equal(Object.hasOwn(sink, 'usage'), false);

  const usage = { input: 3 };
  registry.runTurn = async () => ({ text: 'hi', usage });
  await runAgentTurn(registry, member, { sink });
  assert.deepEqual(sink.usage, usage);
  assert.equal(sink.memberId, 'a');
  const existing = { memberId: 'b' };
  await runAgentTurn(registry, member, { sink: existing });
  assert.deepEqual(existing.usage, usage);
  assert.equal(existing.memberId, 'b');
});
