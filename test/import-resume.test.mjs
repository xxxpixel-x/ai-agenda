// 接续导入的 Claude Code 对话：只复制到导入时的最后一条，导入后在原软件里接着聊的不带进来
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { importSession } from '../src/imports.mjs';
import { makeSpace, settleSpace, tempDir, testInChinese as test, until } from './helpers.mjs';

const ID = '11111111-2222-4333-8444-555555555555';
const line = (type, uuid, parentUuid, content, cwd) => JSON.stringify({
  type, uuid, parentUuid, cwd, sessionId: ID, timestamp: '2026-11-19T10:00:00Z',
  message: { role: type, content: type === 'user' ? content : [{ type: 'text', text: content }] },
});

/** 在临时的 CLAUDE_CONFIG_DIR 里放一段 Claude Code 对话，返回追加内容的函数。 */
function fixture(t, root) {
  const config = path.join(root, 'claude');
  const dir = path.join(config, 'projects', 'p');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ID}.jsonl`);
  fs.writeFileSync(file, [line('user', 'u1', null, '记住数字 7', root), line('assistant', 'a1', 'u1', '好的', root)].join('\n') + '\n');
  const old = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  t.after(() => { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; });
  return (...lines) => fs.appendFileSync(file, lines.join('\n') + '\n');
}

/** 记下发给 Claude Code 的会话参数；fail(opts) 返回真时模拟接不上原会话。 */
function record(space, fail = () => false) {
  const calls = [];
  const run = space.registry.runTurn;
  space.registry.runTurn = async (engine, opts) => {
    if (engine !== 'claude-code') return run(engine, opts);
    calls.push({ sessionId: opts.sessionId, fork: opts.fork, resumeAt: opts.resumeAt });
    if (fail(opts)) throw Object.assign(new Error('No message found with message.uuid of: a1'), { resumeFailed: true });
    const r = await run(engine, opts);
    return { ...r, sessionId: opts.sessionId ? 'forked-1' : undefined };
  };
  return calls;
}

async function speak(space, memberId) {
  space.ask(memberId);
  await until(() => space.running, (r) => r, { message: 'turn did not start' });
  await until(() => space.running, (r) => !r, { message: 'turn did not finish' });
}

test('the first fork stops at the last imported message, even if the original session grew', { timeout: 30000 }, async (t) => {
  const root = tempDir(t);
  const append = fixture(t, root);
  const space = makeSpace(root);
  t.after(() => settleSpace(space));
  const calls = record(space);

  importSession(space.importHost, { source: 'claude-code', sessionId: ID });
  assert.equal(space.importHost.memberState['member-a'].resumeAt, 'a1');

  // 导入后在 Claude Code 里接着聊（补聊）
  append(line('user', 'u2', 'a1', '再记住数字 9', root), line('assistant', 'a2', 'u2', '好的', root));

  await speak(space, 'member-a');
  assert.deepEqual(calls[0], { sessionId: ID, fork: true, resumeAt: 'a1' }, 'Fork pinned to the import point');
  const st = space.importHost.memberState['member-a'];
  assert.equal(st.sessionId, 'forked-1');
  assert.equal(st.fork, false);

  await speak(space, 'member-a');
  assert.deepEqual(calls[1], { sessionId: 'forked-1', fork: false, resumeAt: undefined }, 'Later turns use its own copy');
});

test('when the pinned fork fails, the member falls back to a plain member', { timeout: 30000 }, async (t) => {
  const root = tempDir(t);
  fixture(t, root);
  const space = makeSpace(root);
  t.after(() => settleSpace(space));
  const calls = record(space, (opts) => !!opts.resumeAt);

  importSession(space.importHost, { source: 'claude-code', sessionId: ID });
  await speak(space, 'member-a');

  assert.equal(calls.length, 2);
  assert.equal(calls[1].sessionId, undefined, 'Retried without the original session');
  assert.equal(space.importHost.memberState['member-a'], undefined, 'No longer resumes');
  assert.equal(space.importHost.messages.findLast((m) => m.kind === 'ai').error, undefined, 'The turn still succeeded');
});
