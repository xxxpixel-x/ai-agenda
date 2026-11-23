import { testInChinese as test } from './helpers.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseCommand, isPreapproved, normalizeAllowed } from '../src/approvals.mjs';
import { approvalCommand } from '../src/engines/codex.mjs';
import { apiRequest, isMemoryCall, MEMORY_IDLE, tempDir, makeSpace, until, settleSpace } from './helpers.mjs';

test('commands are split into the programs they run', () => {
  assert.deepEqual(parseCommand('npm test && git status').programs, ['npm', 'git']);
  assert.deepEqual(parseCommand('"C:\\Program Files\\nodejs\\npm.cmd" run build').programs, ['c:\\program files\\nodejs\\npm.cmd']);
  assert.deepEqual(parseCommand('GiT.EXE status').programs, ['git']);
  assert.deepEqual(parseCommand('FOO=1 BAR="a b" make all').programs, ['make']);
  assert.deepEqual(parseCommand('cat a.txt | grep x; ls\nnode -v').programs, ['cat', 'grep', 'ls', 'node']);
  assert.equal(parseCommand('echo $(whoami)').nested, true);
  assert.equal(parseCommand('echo $(whoami)').canAlways, false);

  assert.equal(isPreapproved('npm test', ['npm']), true);
  assert.equal(isPreapproved('npm test | grep ok', ['npm']), false);
  assert.equal(isPreapproved('npm test; rm -rf build', ['npm']), false);
  assert.equal(isPreapproved('npm run $(whoami)', ['npm']), false);
  assert.equal(isPreapproved('', ['npm']), false);
  assert.deepEqual(normalizeAllowed(['npm', 'NPM', 'git', 'bad name', 3]), ['git', 'npm']);
});

test('qualified programs and shell wrappers always need one-time approval', () => {
  for (const program of ['.\\git', './git', 'bin/git', 'C:\\x\\git.exe', '"C:\\Program Files\\Git\\git.exe"']) {
    const command = program + ' status';
    assert.equal(parseCommand(command).canAlways, false, command);
    assert.equal(isPreapproved(command, ['git', ...parseCommand(command).programs]), false, command);
  }
  const mixed = 'npm test && .\\git status';
  assert.equal(parseCommand(mixed).canAlways, false);
  assert.equal(isPreapproved(mixed, ['npm', 'git']), false);
  const shells = ['sh', 'bash', 'zsh', 'cmd', 'powershell', 'pwsh'];
  for (const shell of shells) {
    const command = shell + (shell === 'cmd' ? ' /c ' : ' -c ') + '"git status"';
    assert.equal(parseCommand(command).canAlways, false, command);
    assert.equal(isPreapproved(command, shells), false, command);
  }
  assert.deepEqual(normalizeAllowed(['GiT', './git', ...shells, 'PowerShell.EXE', 'BASH']), ['git']);
});

test('Windows checks every bare program for a workspace-local executable', (t) => {
  const cwd = tempDir(t);
  const opts = { cwd, platform: 'win32' };
  assert.equal(isPreapproved('git status', ['git'], opts), true);
  assert.equal(parseCommand('git status', opts).canAlways, true);
  for (const ext of ['cmd', 'exe', 'bat', 'com']) {
    const file = path.join(cwd, 'git.' + ext);
    fs.writeFileSync(file, '');
    for (const command of ['git status', 'npm test && GIT.EXE status']) {
      assert.equal(isPreapproved(command, ['git', 'npm'], opts), false, file);
      assert.equal(parseCommand(command, opts).canAlways, false, file);
    }
    assert.equal(isPreapproved('git status', ['git'], { cwd, platform: 'linux' }), true);
    fs.unlinkSync(file);
  }
  fs.mkdirSync(path.join(cwd, 'git.cmd'));
  assert.equal(isPreapproved('git status', ['git'], opts), true);
});

test('Codex preserves the original command when its action summary omits the shell', () => {
  const commandActions = [{ command: 'git status' }];
  const command = 'powershell.exe -Command "git status"';
  assert.equal(approvalCommand({ command, commandActions }), command);
  assert.equal(isPreapproved(approvalCommand({ command }), ['git']), false);
  assert.equal(approvalCommand({ commandActions }), 'git status');
});

test('an always decision on an ineligible card grants only that request', async (t) => {
  const space = makeSpace(tempDir(t), { access: 'run' });
  space.update({ allowedPrograms: ['git'] });
  const msg = { id: 'approval-fixture' };
  const pending = space.chat.requestApproval(msg, { command: 'npm test && .\\git status' });
  const [card] = msg.approvals;
  assert.equal(card.canAlways, false);
  space.decideApproval(card.id, 'always', 'once');
  assert.deepEqual(await pending, { allow: true, note: 'once' });
  assert.equal(card.status, 'allowed');
  assert.deepEqual(space.data.allowedPrograms, ['git']);
});

async function waitForCard(space) {
  await until(() => space.approvals.size, (n) => n === 1, { message: 'no approval card' });
  return [...space.approvals.values()][0].ap;
}
const replies = (space) => space.data.messages.filter((m) => m.kind === 'ai');

test('run access: a command waits for the user, and a refusal reason reaches the AI', { timeout: 30000 }, async (t) => {
  const space = makeSpace(tempDir(t), { access: 'run', maxTurns: 1 });
  t.after(() => settleSpace(space));
  space.userMessage('@Alice 跑一下测试');
  const ap = await waitForCard(space);
  assert.equal(ap.command, 'npm test && git status');
  assert.deepEqual(ap.programs, ['npm', 'git']);
  assert.equal(ap.canAlways, true);
  assert.equal(space.listItem().waiting, true);
  assert.equal(space.running, true, 'the turn is paused, not finished');

  space.decideApproval(ap.id, 'deny', '先别跑');
  await until(() => space.running, (r) => !r);
  const [reply] = replies(space);
  assert.match(reply.text, /先别跑/);
  assert.equal(reply.approvals[0].status, 'denied');
  assert.equal(reply.approvals[0].note, '先别跑');
  assert.equal(space.listItem().waiting, false);
  assert.throws(() => space.decideApproval(ap.id, 'allow'), /处理过了/);
});

test('"always allow" remembers the programs for the rest of the space', { timeout: 30000 }, async (t) => {
  const space = makeSpace(tempDir(t), { access: 'run', maxTurns: 2 });
  t.after(() => settleSpace(space));
  space.userMessage('大家跑一下测试');
  const ap = await waitForCard(space);
  space.decideApproval(ap.id, 'always', '跑完告诉我耗时');
  assert.deepEqual(space.data.allowedPrograms, ['git', 'npm']);

  // 第二位成员运行同样的命令：不再出卡片
  await until(() => space.running, (r) => !r);
  const [first, second] = replies(space);
  assert.equal(first.approvals[0].status, 'always');
  assert.equal(first.approvals[0].note, '跑完告诉我耗时');
  assert.match(first.text, /测试跑过了.*跑完告诉我耗时/s, 'a note given with an approval reaches the AI too');
  assert.equal(second.approvals, undefined);
  assert.match(second.text, /测试跑过了/);

  space.update({ allowedPrograms: ['npm'] });
  assert.deepEqual(space.data.allowedPrograms, ['npm']);
});

test('stopping while a card waits cancels it', { timeout: 30000 }, async (t) => {
  const space = makeSpace(tempDir(t), { access: 'run', maxTurns: 1 });
  t.after(() => settleSpace(space));
  space.userMessage('@Bob 跑一下');
  const ap = await waitForCard(space);
  space.updateMember('member-b', { effort: 'high' }); // 讨论进行中也能换档位
  assert.equal(space.data.members[1].effort, 'high');
  space.stop();
  await until(() => space.running, (r) => !r);
  assert.equal(ap.status, 'cancelled');
  assert.equal(space.approvals.size, 0);
});

test('one-off commands require a card even for a previously allowed program', async () => {
  const space = makeSpace(tempDir());
  space.data.allowedPrograms = ['npm'];
  const msg = {};
  const decision = space.chat.requestApproval(msg, { command: 'npm test', canAlways: false });
  const [card] = msg.approvals;
  assert.equal(card.canAlways, false);
  space.decideApproval(card.id, 'deny');
  assert.equal((await decision).allow, false);
});

test('a card still waiting when the turn ends on its own is cancelled', { timeout: 30000 }, async (t) => {
  const space = makeSpace(tempDir(t), { access: 'run', maxTurns: 1 });
  t.after(() => settleSpace(space));
  // 像 AI 进程自己退出了：发出审批请求后不等结果就结束这一轮
  space.registry = { ...space.registry, runTurn: async (_id, opts) => { if (isMemoryCall(opts)) return MEMORY_IDLE; opts.onApproval({ command: 'npm test' }); return { text: '进程退出了' }; } };
  space.userMessage('@Alice 跑一下');
  await until(() => space.running, (r) => !r);
  const [reply] = replies(space);
  assert.equal(reply.approvals[0].status, 'cancelled');
  assert.equal(space.approvals.size, 0);
  assert.equal(space.listItem().waiting, false);
});

test('an AI that cannot ask only gets file access at the run level', { timeout: 30000 }, async (t) => {
  const space = makeSpace(tempDir(t), { access: 'run', maxTurns: 1 });
  t.after(() => settleSpace(space));
  const calls = [];
  const real = space.registry;
  space.registry = { ...real, supportsApproval: () => false, runTurn: (id, opts) => { if (isMemoryCall(opts)) return MEMORY_IDLE; calls.push(opts); return real.runTurn(id, opts); } };
  space.userMessage('@Alice 你好');
  await until(() => space.running, (r) => !r);
  assert.equal(calls[0].access, 'edit');
  assert.equal(calls[0].onApproval, undefined);
  assert.doesNotMatch(calls[0].system, /先请「我」确认/);
  assert.equal(replies(space)[0].approvals, undefined);
});

test('approvals and member changes over the local HTTP API', { timeout: 30000 }, async (t) => {
  const { startServer } = await import('../src/app-server.mjs');
  const flashes = [];
  const server = await startServer({ port: 0, dataDir: path.join(tempDir(t), 'data'), mock: true, hooks: { attention: () => flashes.push(Date.now()) } });
  t.after(() => server.close());
  const call = async (url, method = 'GET', body) => {
    const r = await apiRequest(server, url, method, body);
    return { status: r.status, body: await r.json() };
  };
  const members = [{ id: 'member-a', engine: 'claude-code', name: 'Alice' }];
  const sp = (await call('/api/spaces', 'POST', { members, access: 'run', maxTurns: 1 })).body;
  const url = `/api/spaces/${sp.id}`;

  await call(`${url}/messages`, 'POST', { text: '跑一下测试' });
  const waiting = await until(async () => (await call(url)).body, (s) => s.messages.some((m) => m.approvals?.[0]?.status === 'pending'));
  const ap = waiting.messages.find((m) => m.approvals).approvals[0];
  assert.equal((await call('/api/spaces')).body[0].waiting, true);
  assert.equal(flashes.length, 1);

  const changed = await call(`${url}/members/member-a`, 'PATCH', { model: 'claude-opus-5-5' });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.model, 'claude-opus-5-5');

  assert.equal((await call(`${url}/approvals/${ap.id}`, 'POST', { decision: 'allow' })).status, 200);
  const done = await until(async () => (await call(url)).body, (s) => !s.running);
  assert.equal(done.messages.find((m) => m.approvals).approvals[0].status, 'allowed');
  assert.equal((await call(`${url}/approvals/${ap.id}`, 'POST', { decision: 'allow' })).status, 400);
  assert.equal((await call('/api/spaces')).body[0].waiting, false);
});
