import assert from 'node:assert/strict';
import { testInChinese as test, makeSpace, tempDir, settleSpace, until, beginTask } from './helpers.mjs';
import { parseClarify, parsePlan, extractPlan } from '../src/task-prompts.mjs';
import { runNeedsUser } from '../src/space.mjs';
import { CLARIFY_WAIT, TaskRun, clock } from '../src/taskrun.mjs';

const heading = '## 先问还是直接规划';
const questions = [
  { id: 'Q1', text: '登录方式？', default: '账号密码' },
  { id: 'Q2', text: '配色？', default: '蓝色' },
];
const tasks = [{ id: 'T1', title: '写方案', assignee: 'Alice', spec: '写一页登录方案' }];
const assumptions = ['沿用现有文件结构'];
const block = (obj) => '```json\n' + JSON.stringify(obj) + '\n```';
const isPlanner = (o) => o.system.includes('这次任务协作的协调者');
const isTriage = (o) => o.system.includes('又发来一条消息');
const waitStatus = (space, status) => until(() => space.run.data.status, (s) => s === status);

// 每个空间有自己的假时钟；测试决定何时触发，不必真的等十分钟。
function setup(t, { input, plan } = {}) {
  const space = makeSpace(tempDir(t), input);
  const original = { ...clock };
  const time = { now: 1_000_000, timers: [] };
  Object.assign(clock, {
    now: () => time.now,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      time.timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; },
  });
  t.after(async () => {
    try {
      space.run?.stopForRemoval();
      await settleSpace(space);
    } finally { Object.assign(clock, original); }
  });
  const calls = [];
  space.registry.runTurn = async (_engine, opts) => {
    calls.push(opts);
    if (isPlanner(opts)) {
      if (opts.system.includes(heading) && opts.prompt.includes('含糊')) return { text: block({ questions }) };
      return { text: plan ? plan(opts) : block({ tasks, assumptions }) };
    }
    if (isTriage(opts)) return { text: block({ type: 'answer', reply: '收到了。' }) };
    if (opts.system.includes('请你审阅计划')) return { text: '请写明验收要求。' };
    return { text: '写好了。\n结果：完成' };
  };
  return { space, calls, time };
}

async function start(t, { objective = '目标含糊', planConfirm = 'manual', discuss = false, plan } = {}) {
  const fixture = setup(t, { plan });
  await beginTask(fixture.space, { objective, planConfirm, discuss });
  await until(() => fixture.space.run.data.status, (s) => s !== 'planning');
  return fixture;
}

test('解析澄清问题：倒序找代码块，补齐 id，只取三个，计划优先', () => {
  const raw = { questions: [{ text: ' 登录方式？ ', default: ' 账号密码 ' }, questions[1], { id: 'Q2', text: '语言？' }, { text: '多余的' }] };
  assert.deepEqual(parseClarify(block({ questions: [questions[1]] }) + '\n' + block(raw)), {
    questions: [...questions, { id: 'Q3', text: '语言？', default: '' }],
  });
  assert.deepEqual(parseClarify('两个问题 ' + JSON.stringify({ questions })), { questions });
  assert.equal(parseClarify(block({ questions, tasks })), null);
  assert.equal(parseClarify('只有文字'), null);
  assert.equal(parseClarify(block({ questions: [null, { text: '  ' }] })), null);
  const q = { id: 'a_*' + '1'.repeat(15), text: '问'.repeat(320), default: '答'.repeat(220) };
  assert.deepEqual(parseClarify(block({ questions: [q] })).questions[0], {
    id: 'a' + '1'.repeat(11), text: '问'.repeat(300), default: '答'.repeat(200),
  });
});

test('解析计划：清理和限制假设，兼容旧数组格式', () => {
  const items = [null, '  ', ' 甲 ', '乙'.repeat(350), ...Array(10).fill('丙')];
  assert.deepEqual(parsePlan(block({ tasks, assumptions: items })), {
    tasks, assumptions: ['甲', '乙'.repeat(300), ...Array(8).fill('丙')],
  });
  assert.deepEqual(parsePlan(block(tasks)), { tasks, assumptions: [] });
  assert.deepEqual(extractPlan(block(tasks)), tasks);
  assert.equal(parsePlan(block({ questions })), null);
});

test('目标清楚时一次调用直接给计划和假设', async (t) => {
  const { space, calls } = await start(t, { objective: '写出账号密码登录的步骤' });
  assert.equal(space.run.data.status, 'plan_review');
  assert.equal(space.run.data.clarify, undefined);
  assert.deepEqual(space.run.data.assumptions, assumptions);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].system.includes(heading));
});

test('手动确认时等回答，一直不排计时器', async (t) => {
  const { space, time } = await start(t);
  const d = space.run.data;
  assert.deepEqual(d.clarify, { questions, answers: {}, askedAt: time.now });
  time.now += CLARIFY_WAIT * 2;
  assert.equal(time.timers.length, 0);
  assert.equal(d.status, 'clarifying');
  assert.ok(space.run.active);
  assert.ok(runNeedsUser(d));
});

test('部分回答带进下一轮规划，默认项和用户回答也交给工作者', async (t) => {
  const { space, calls, time } = await start(t);
  await space.runAction('clarify-answer', { answers: { Q1: ' 短信验证码 ', Q2: ' ', Q3: '无关' } });
  await waitStatus(space, 'plan_review');
  const d = space.run.data;
  assert.deepEqual(d.clarify.answers, { Q1: '短信验证码' });
  assert.deepEqual(d.clarify.defaulted, ['Q2']);
  assert.equal(d.clarify.resolvedAt, time.now);
  assert.deepEqual(d.assumptions, ['配色？：按默认处理（蓝色）', ...assumptions]);
  const second = calls.filter(isPlanner)[1];
  assert.ok(!second.system.includes(heading));
  assert.match(second.prompt, /# 规划前的澄清[\s\S]*Q1 登录方式？\n  用户的回答：<消息 [^>]+>\n短信验证码\n<\/消息>/);
  assert.match(second.prompt, /Q2 配色？\n  没回答，按默认：蓝色/);
  await assert.rejects(space.runAction('clarify-defaults'), /现在没有在等你回答问题/);
  await space.runAction('approve-plan');
  await until(() => space.run.task('T1').status, (s) => s === 'review');
  const worker = calls.find((o) => o.system.includes('子任务 T1'));
  assert.match(worker.prompt, /# 已经定下的[\s\S]*<消息 [^>]+>\n短信验证码\n<\/消息>[\s\S]*按默认处理（蓝色）[\s\S]*# 整体计划/);
});

test('选择全部默认，重新规划保留协调者假设且不重复默认项', async (t) => {
  let items = assumptions;
  const { space, calls } = await start(t, { plan: () => block({ tasks, assumptions: items }) });
  await space.runAction('clarify-defaults');
  await waitStatus(space, 'plan_review');
  assert.deepEqual(space.run.data.clarify.defaulted, ['Q1', 'Q2']);
  const expected = ['登录方式？：按默认处理（账号密码）', '配色？：按默认处理（蓝色）', ...assumptions];
  assert.deepEqual(space.run.data.assumptions, expected);
  items = [];
  await space.runAction('replan');
  await waitStatus(space, 'plan_review');
  assert.deepEqual(space.run.data.assumptions, expected);
  space.userMessage('还有哪些步骤？');
  await until(() => space.data.messages.some((m) => m.decision), Boolean);
  assert.ok(calls.some(isTriage));
  assert.ok(calls.slice(1).every((o) => !o.system.includes(heading)));
});

test('自动开始的任务在十分钟后按默认规划并执行', async (t) => {
  const { space, time } = await start(t, { planConfirm: 'auto' });
  const c = space.run.data.clarify;
  assert.equal(CLARIFY_WAIT, 600_000);
  assert.equal(c.deadline, c.askedAt + CLARIFY_WAIT);
  assert.equal(time.timers.length, 1);
  assert.equal(time.timers[0].ms, CLARIFY_WAIT);
  time.now = c.deadline;
  time.timers[0].fn();
  await waitStatus(space, 'executing');
  assert.equal(c.timedOut, true);
  assert.equal(c.resolvedAt, time.now);
  assert.deepEqual(c.defaulted, ['Q1', 'Q2']);
  assert.match(space.run.data.assumptions[0], /按默认处理/);
  assert.ok(time.timers[0].cleared);
});

test('新建任务默认允许问，从聊天转来或显式关闭则直接规划', async (t) => {
  const root = tempDir(t);
  for (const [options, expected] of [[{}, true], [{ source: { spaceId: 'x' }, clarify: true }, false], [{ clarify: false }, false]]) {
    const space = makeSpace(root, { kind: 'task', objective: '目标含糊', discuss: false, ...options });
    t.after(() => settleSpace(space));
    assert.equal(space.data.pendingTask.clarify, expected);
    if (expected) continue;
    let system;
    space.registry.runTurn = async (_engine, opts) => {
      system = opts.system;
      return { text: block(opts.system.includes(heading) ? { questions } : { tasks }) };
    };
    await space.startTask();
    await waitStatus(space, 'plan_review');
    assert.ok(!system.includes(heading));
  }
});

test('软件重开按剩余时间排计时器，过期的下一次回调就开始', async (t) => {
  const { space, time } = await start(t, { planConfirm: 'auto' });
  const data = space.run.data;
  for (const [elapsed, remaining] of [[240_000, 360_000], [660_000, 0]]) {
    space.run.stopForRemoval();
    assert.ok(time.timers.at(-1).cleared);
    time.now = data.clarify.askedAt + elapsed;
    space.run = new TaskRun(space.runHost, data);
    assert.equal(data.status, 'clarifying');
    assert.equal(time.timers.at(-1).ms, remaining);
  }
  time.timers.at(-1).fn();
  await waitStatus(space, 'executing');
  assert.ok(data.clarify.timedOut);
});

test('切换确认方式按最初提问时间计时，手动确认和结束会清除计时器', async (t) => {
  const { space, time } = await start(t);
  const run = space.run;
  time.now += 60_000;
  run.updateSettings({ planConfirm: 'auto' });
  const timer = time.timers[0];
  assert.equal(timer.ms, CLARIFY_WAIT - 60_000);
  run.updateSettings({ planConfirm: 'manual' });
  assert.ok(timer.cleared);
  assert.equal(run.data.clarify.deadline, undefined);
  timer.fn();
  assert.equal(run.data.status, 'clarifying');
  time.now += CLARIFY_WAIT;
  run.updateSettings({ planConfirm: 'auto' });
  assert.equal(time.timers.at(-1).ms, 0);
  await space.runAction('finish');
  assert.ok(time.timers.at(-1).cleared);
  time.timers.at(-1).fn();
  assert.equal(run.data.status, 'cancelled');
  assert.ok(!runNeedsUser(run.data));
});

test('澄清时的输入排队，计划出来后按中途消息处理', async (t) => {
  const { space, calls } = await start(t);
  const msg = space.userMessage('方案要能打印。');
  assert.ok(msg.queued);
  assert.equal(calls.length, 1);
  await space.runAction('clarify-answer', { answers: [{ id: 'Q1', text: '短信验证码' }] });
  await until(() => space.data.messages.find((m) => m.decision), Boolean);
  assert.equal(space.run.data.status, 'plan_review');
  assert.ok(!msg.queued);
  assert.equal(calls.length, 3);
  assert.ok(isPlanner(calls[1]));
  assert.ok(isTriage(calls[2]));
  assert.match(calls[2].prompt, /# 已经定下的[\s\S]*短信验证码[\s\S]*按默认处理（蓝色）[\s\S]*# 计划和进展[\s\S]*方案要能打印/);
});

test('先商量时审阅和定稿都看到澄清，定稿可以替换草案假设', async (t) => {
  const { space, calls } = await start(t, {
    discuss: true,
    plan: (o) => block({ tasks, assumptions: o.prompt.includes('# 意见') ? ['定稿假设'] : ['草案假设'] }),
  });
  await space.runAction('clarify-answer', { answers: [{ id: 'Q1', text: '甲'.repeat(2001) }] });
  await waitStatus(space, 'plan_review');
  assert.equal(space.run.data.clarify.answers.Q1.length, 2000);
  assert.deepEqual(space.run.data.assumptions, ['配色？：按默认处理（蓝色）', '定稿假设']);
  assert.equal(calls.length, 4);
  assert.ok(calls.slice(1).every((o) => !o.system.includes(heading) && o.prompt.includes('# 规划前的澄清')));
});

test('首次规划失败后重新规划也不会再问', async (t) => {
  let reply = '没有计划';
  const { space, calls } = await start(t, { objective: '写步骤', plan: () => reply });
  assert.equal(space.run.data.status, 'failed');
  reply = block({ tasks });
  await space.runAction('replan');
  await waitStatus(space, 'plan_review');
  assert.ok(!calls[1].system.includes(heading));
});
