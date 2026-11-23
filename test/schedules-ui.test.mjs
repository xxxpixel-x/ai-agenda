import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer } from '../src/app-server.mjs';
import { apiRequest, tempDir, until } from './helpers.mjs';

// 定时标签照搬空间时发的模板（public/js/schedules.js 的 spaceTemplate）：成员带 id，协调者按 id 指定，
// 托管文件夹也写成 folder，到点建出来的任务空间要用同一个协调者和同一个文件夹
test('照界面的模板格式建任务空间：协调者和文件夹都照搬', { timeout: 30000 }, async (t) => {
  const dataDir = path.join(tempDir(t), 'data');
  const server = await startServer({ port: 0, dataDir, mock: true, hooks: { locales: () => ['zh-CN'] } });
  t.after(() => server.close());
  const api = async (url, method = 'GET', body) => {
    const r = await apiRequest(server, url, method, body);
    return { status: r.status, body: await r.json() };
  };
  const chat = (await api('/api/spaces', 'POST', { title: '早会', members: [{ engine: 'claude-code', name: 'Alice' }, { engine: 'codex', name: 'Bob' }] })).body;
  const template = {
    title: chat.title,
    goal: '整理今天的资料',
    members: chat.members.map(({ engine, name, model, effort, persona, color, id }) => ({ engine, name, model, effort, persona, color, id })),
    coordinatorId: chat.members[1].id,
    workspace: { type: 'folder', path: chat.workspacePath },
    access: chat.access,
    planConfirm: 'manual',
    reviewPlan: false,
    autoApprove: false,
    maxParallel: 3,
  };
  const created = await api('/api/schedules', 'POST', {
    spaceId: chat.id, rule: { type: 'interval', minutes: 5, start: Date.now() + 500 }, action: { type: 'task', template },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const runs = await until(() => api(`/api/schedules/${created.body.id}/runs`).then((r) => r.body), (list) => list.length > 0);
  assert.equal(runs[0].status, 'ok', JSON.stringify(runs[0]));
  const space = (await api(`/api/spaces/${runs[0].spaceId}`)).body;
  assert.equal(space.scheduleId, created.body.id);
  assert.equal(space.workspacePath, chat.workspacePath);
  assert.equal(space.run.coordinatorId, chat.members[1].id);
  assert.deepEqual(space.members.map((m) => m.name), ['Alice', 'Bob']);
  // 修改时只改目标和计划确认方式，其余照旧
  const patched = await api(`/api/schedules/${created.body.id}`, 'PATCH', { action: { type: 'task', template: { ...template, goal: '换个目标', planConfirm: 'auto' } } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.action.template.coordinatorId, chat.members[1].id);
  assert.equal(patched.body.action.template.planConfirm, 'auto');
  await api(`/api/schedules/${created.body.id}`, 'DELETE');
});
