// 提醒与防睡眠：服务器在什么时候叫桌面版弹通知、阻止睡眠
import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../src/app-server.mjs';
import { testInChinese as test, tempDir, until } from './helpers.mjs';

async function boot(t) {
  const notes = [];
  const awake = [];
  const server = await startServer({
    port: 0, dataDir: path.join(tempDir(t), 'data'), mock: true,
    hooks: { locales: () => ['zh-CN'], notify: (n) => notes.push(n), keepAwake: (on) => awake.push(on) },
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const api = async (p, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const read = async (p) => (await api(p)).body;
  return { notes, awake, api, read };
}

test('chat rounds: notify when the round ends, keep awake while running, not when you stop it', { timeout: 30000 }, async (t) => {
  const { notes, awake, api, read } = await boot(t);
  assert.equal((await read('/api/settings')).notify, true, 'On by default');
  assert.equal((await read('/api/settings')).keepAwake, true, 'On by default');

  const members = [{ id: 'member-a', engine: 'claude-code', name: 'Alice' }];
  const sp = (await api('/api/spaces', { title: '讨论', members, access: 'edit', maxTurns: 1 })).body;
  await api(`/api/spaces/${sp.id}/messages`, { text: '你好' });
  await until(() => read(`/api/spaces/${sp.id}`), (s) => !s.running);
  await until(() => awake, (a) => a.at(-1) === false, { message: 'Keep-awake released after the round' });
  assert.deepEqual(awake, [true, false]);
  assert.deepEqual(notes, [{ spaceId: sp.id, title: '讨论', body: '讨论告一段落，轮到你了' }]);

  // 你自己点停止：不提醒
  await api(`/api/spaces/${sp.id}/messages`, { text: '再说说' });
  await api(`/api/spaces/${sp.id}/control`, { action: 'stop' });
  await until(() => read(`/api/spaces/${sp.id}`), (s) => !s.running);
  await sleep(100);
  assert.equal(notes.length, 1);

  // 关掉提醒和防睡眠
  await api('/api/settings', { notify: false, keepAwake: false }, 'PUT');
  const before = awake.length;
  await api(`/api/spaces/${sp.id}/messages`, { text: '还有吗' });
  await until(() => read(`/api/spaces/${sp.id}`), (s) => !s.running);
  await sleep(400);
  assert.equal(notes.length, 1);
  assert.equal(awake.length, before, 'Never asked to stay awake');
});

test('approvals and task plans waiting for you send a notification', { timeout: 30000 }, async (t) => {
  const { notes, api, read } = await boot(t);
  const members = [{ id: 'member-a', engine: 'claude-code', name: 'Alice' }, { id: 'member-b', engine: 'codex', name: 'Bob' }];

  const chat = (await api('/api/spaces', { title: '跑命令', members: members.slice(0, 1), access: 'run', maxTurns: 1 })).body;
  await api(`/api/spaces/${chat.id}/messages`, { text: '跑一下测试' });
  await until(() => notes, (n) => n.length >= 1);
  assert.equal(notes[0].body, 'Alice 想运行命令，等你确认');

  const task = (await api('/api/spaces', { kind: 'task', title: '写方案', objective: '写一份方案', members, planConfirm: 'manual', discuss: false })).body;
  await until(() => read(`/api/spaces/${task.id}`), (s) => s.run?.status === 'plan_review');
  const plan = await until(() => notes.filter((n) => n.spaceId === task.id), (n) => n.length >= 1);
  assert.deepEqual(plan, [{ spaceId: task.id, title: '写方案', body: '任务计划等你确认' }]);
});
