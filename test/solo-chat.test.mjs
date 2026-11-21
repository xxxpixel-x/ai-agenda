import assert from 'node:assert/strict';
import { runTurn as demo } from '../src/engines/mock.mjs';
import { isMemoryCall, MEMORY_IDLE, isHandoffCall, HANDOFF_IDLE } from './helpers.mjs';
import { makeSpace, settleSpace, tempDir, testInChinese as test, until } from './helpers.mjs';

const alice = { id: 'member-a', engine: 'claude-code', name: 'Alice' };
const bob = { id: 'member-b', engine: 'codex', name: 'Bob' };

function makeChat(t, { members = [alice], maxTurns = 4, capability, reply = (n) => `答复第${n}题` } = {}) {
  const space = makeSpace(tempDir(t), { members, maxTurns });
  t.after(() => settleSpace(space));
  const calls = [];
  space.registry.supportsResume = (engine) => engine === alice.engine && capability === 'resume';
  space.registry.supportsPrivateSessions = (engine) => engine === alice.engine && capability === 'privateSessions';
  space.registry.runTurn = async (engine, opts) => {
    if (isMemoryCall(opts)) return MEMORY_IDLE;
    if (isHandoffCall(opts)) return HANDOFF_IDLE;
    calls.push({ engine, ...opts });
    const n = calls.length;
    const text = reply(n);
    opts.onDelta(text);
    return { text, sessionId: `sess-${n}` };
  };
  return { space, calls };
}

function waitForRound(space) {
  return until(() => space.running, (running) => !running, { message: '本轮发言未结束' });
}

async function sendOne({ space, calls }, text, opts) {
  const before = calls.length;
  space.userMessage(text, [], opts);
  await waitForRound(space);
  assert.equal(calls.length, before + 1, `「${text}」应当只收到一次回复`);
  return calls[before];
}

function assertSoloPrompt({ system, prompt }) {
  assert.match(system, /一对一/);
  assert.doesNotMatch(system, /参与者|其他成员|轮流|轮到|\[跳过\]|\[结束\]/);
  assert.equal(prompt.split('\n').at(-1), '现在请你（「Alice」）回复。');
}

test('单人聊天逐条回复，发言中插话也不受轮数上限影响', async (t) => {
  const replies = ['收到甲 [跳过]', '收到乙 [结束]', '[跳过]', '[结束]'];
  const chat = makeChat(t, { maxTurns: 1, capability: 'resume', reply: (n) => replies[n - 1] });
  const { space, calls } = chat;
  const questions = ['问题甲', '问题乙', '问题丙', '问题丁'];

  // 同一轮内发两条才能越过上限；每次等整轮结束再发会重置轮数。
  space.userMessage(questions[0]);
  assert.equal(space.running, true);
  space.userMessage(questions[1]);
  await waitForRound(space);
  assert.equal(calls.length, 2);
  await sendOne(chat, questions[2], { only: alice.id });
  await sendOne(chat, questions[3]);

  for (const [i, call] of calls.entries()) {
    assertSoloPrompt(call);
    assert.ok(call.prompt.includes(questions[i]));
    assert.doesNotMatch(call.prompt, /轮流|轮到|\[跳过\]|\[结束\]|只问/);
  }
  const users = space.data.messages.filter((m) => m.kind === 'user');
  assert.ok(users.every((m) => !Object.hasOwn(m, 'only')));
  const answers = space.data.messages.filter((m) => m.kind === 'ai');
  assert.deepEqual(answers.map((m) => m.text), ['收到甲', '收到乙', '[跳过]', '[结束]']);
  for (const answer of answers) {
    assert.equal(answer.memberId, alice.id);
    assert.equal(answer.passed, false);
    assert.equal(answer.done, false);
  }
});

for (const capability of ['resume', 'privateSessions']) {
  test(`${capability} 引擎只续接同一聊天模式的会话`, async (t) => {
    const chat = makeChat(t, { capability });
    const { space } = chat;
    const first = await sendOne(chat, '给花园取个名字');
    assert.equal(first.sessionId, undefined);
    assert.match(first.prompt, /# 空间：/);
    const state = space.data.memberState[alice.id];
    assert.equal(state.sessionId, 'sess-1');
    assert.equal(state.seen, space.data.messages.length);
    assert.ok(typeof state.sig === 'string' && state.sig.length > 0);

    const second = await sendOne(chat, '再取一个湖泊名');
    assert.equal(second.sessionId, 'sess-1');
    assert.match(second.prompt, /你上次发言之后的新消息/);
    assert.match(second.prompt, /再取一个湖泊名/);
    assert.doesNotMatch(second.prompt, /给花园取个名字|答复第1题|# 空间：/);

    space.update({ members: [alice, bob] });
    const group = await sendOne(chat, '@Alice 给步道命名');
    assert.equal(group.sessionId, undefined);
    assert.match(group.system, /参与者/);
    assert.match(group.system, /@Bob/);
    assert.match(group.system, /\[跳过\]/);
    if (capability === 'privateSessions') {
      assert.ok(!Object.hasOwn(space.data.memberState, alice.id));
    }
    const nextGroup = await sendOne(chat, '@Alice 换个名字');
    assert.equal(nextGroup.sessionId, capability === 'resume' ? 'sess-3' : undefined);

    space.update({ members: [alice] });
    const solo = await sendOne(chat, '最后给亭子命名');
    assertSoloPrompt(solo);
    assert.equal(solo.sessionId, undefined);
    assert.equal((await sendOne(chat, '还有别的名字吗')).sessionId, 'sess-5');
  });
}

for (const [setting, change] of [
  ['设定', (space) => space.update({ members: [{ ...alice, persona: '用诗句答题' }] })],
  ['型号', (space) => space.updateMember(alice.id, { model: 'fixture-model' })],
  ['档位', (space) => space.updateMember(alice.id, { effort: 'high' })],
  ['权限', (space) => space.update({ access: 'read' })],
]) {
  test(`修改${setting}后新开单人会话，从倒数第三条用户消息开始带原文`, async (t) => {
    const chat = makeChat(t, { capability: 'privateSessions' });
    for (let n = 1; n <= 4; n++) await sendOne(chat, `问题第${n}题`);
    assert.equal(chat.calls[3].sessionId, 'sess-3');
    change(chat.space);
    const fresh = await sendOne(chat, '问题第5题');
    assert.equal(fresh.sessionId, undefined);
    assert.match(fresh.prompt, /# 空间：/);
    assert.match(fresh.prompt, /（更早的 4 条已省略）/);
    assert.deepEqual(fresh.prompt.match(/(?:问题|答复)第\d+题/g), [
      '问题第3题', '答复第3题', '问题第4题', '答复第4题', '问题第5题',
    ]);
    assert.equal((await sendOne(chat, '问题第6题')).sessionId, 'sess-5');
  });
}

test('只问指定成员时双方的 @ 都不会让别人接话，其他成员后来能看到问答', async (t) => {
  const chat = makeChat(t, { members: [alice, bob], reply: (n) => n === 1 ? '建议湖蓝色。@Alice 你觉得呢？' : '我也赞同。' });
  const { space } = chat;
  assert.throws(() => space.userMessage('问一个不存在的成员', [], { only: 'member-absent' }), { message: '没有这个成员' });
  assert.equal(space.data.messages.length, 0);

  const question = '给 @Alice 的杯子选个颜色';
  const target = await sendOne(chat, question, { only: bob.id });
  assert.equal(target.engine, bob.engine);
  assert.equal(target.prompt.split('\n').at(-1), '「我」这条只问你（「Bob」），其他成员这次不接话。现在请你回应。');
  const [user, answer] = space.data.messages;
  assert.equal(user.only, bob.id);
  assert.equal(answer.memberId, bob.id);

  const later = await sendOne(chat, '@Alice 你也说说看');
  assert.equal(later.engine, alice.engine);
  assert.ok(later.prompt.includes(`<消息 来自="我">\n（只问 Bob）\n${question}\n</消息>`));
  assert.ok(later.prompt.includes('<消息 来自="Bob">\n建议湖蓝色。@Alice 你觉得呢？\n</消息>'));
});

test('演示引擎连续四轮单聊保留会话，只回复正文', async () => {
  let sessionId, prompt = '';
  const ids = [];
  for (let n = 0; n < 4; n++) {
    prompt += '\n<消息 来自="我">\n问题\n</消息>';
    const result = await demo({ system: '你是「Alice」，正在一对一聊天。', prompt, access: 'read', keepSession: true, sessionId });
    assert.ok(result.text.trim());
    assert.doesNotMatch(result.text, /\[(?:跳过|结束|Skip|Done)\]/i);
    sessionId = result.sessionId;
    ids.push(sessionId);
    prompt += '\n<消息 来自="Alice">\n' + result.text + '\n</消息>';
  }
  assert.match(sessionId, /^mock-session-/);
  assert.equal(new Set(ids).size, 1);
});
