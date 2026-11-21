import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/app-server.mjs';
import { tempDir } from './helpers.mjs';

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };

test('GET /api/spaces/:id/usage 按成员给出最近一次、合计和今天的用量', { timeout: 30000 }, async (t) => {
  const dataDir = path.join(tempDir(t), 'data');
  const hooks = { locales: () => ['zh-CN'] };
  let server = await startServer({ port: 0, dataDir, mock: true, hooks });
  t.after(() => server.close());
  const api = async (url, method = 'GET', body) => {
    const r = await fetch(`http://127.0.0.1:${server.port}${url}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  const members = [{ engine: 'claude-code', name: 'Alice' }, { engine: 'codex', name: 'Bob' }, { engine: 'claude-code', name: 'Carol' }];
  const created = await api('/api/spaces', 'POST', { title: '用量', members });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const space = created.body;
  const [alice, bob, carol] = space.members;
  // 还没有任何用量
  assert.deepEqual((await api(`/api/spaces/${space.id}/usage`)).body, { members: {} });

  // 编造的用量：Alice 昨天一轮、今天两轮（最近一次带上下文和额度），Bob 只有 token，Carol 没发过言
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const ai = (memberId, ts, usage) => ({ id: `m-${ts}-${memberId}`, kind: 'ai', memberId, name: 'x', text: 'ok', ts, usage });
  const aliceLatest = { input: 30, output: 7, cacheRead: 100, cacheWrite: 5, contextUsed: 142, contextWindow: 200000, quota: { usedPct: 83, resetsAt: midnight + 86400000 } };
  const file = path.join(dataDir, 'spaces', `${space.id}.json`);
  server.close();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.messages.push(
    ai(alice.id, midnight - 3600_000, { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 }),
    ai(alice.id, midnight + 60_000, { input: 10, output: 3, cacheRead: 50, cacheWrite: 0, contextUsed: 63, contextWindow: 200000 }),
    ai(bob.id, midnight + 120_000, { input: 400, output: 40 }),
    ai(alice.id, midnight + 180_000, aliceLatest),
    { id: 'u1', kind: 'user', text: '你好', ts: midnight + 30_000 },
  );
  fs.writeFileSync(file, JSON.stringify(data));
  server = await startServer({ port: 0, dataDir, mock: true, hooks });

  const r = await api(`/api/spaces/${space.id}/usage`);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.members).sort(), [alice.id, bob.id].sort());
  assert.ok(!(carol.id in r.body.members));
  assert.deepEqual(r.body.members[alice.id], {
    latest: aliceLatest,
    total: { input: 1040, output: 210, cacheRead: 150, cacheWrite: 5, turns: 3 },
    today: { input: 40, output: 10, cacheRead: 150, cacheWrite: 5, turns: 2 },
  });
  assert.deepEqual(r.body.members[bob.id], {
    latest: { input: 400, output: 40 },
    total: { input: 400, output: 40, cacheRead: 0, cacheWrite: 0, turns: 1 },
    today: { input: 400, output: 40, cacheRead: 0, cacheWrite: 0, turns: 1 },
  });

  // 只有昨天的用量：today 是全 0
  server.close();
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  old.messages = old.messages.filter((m) => m.ts < midnight);
  fs.writeFileSync(file, JSON.stringify(old));
  server = await startServer({ port: 0, dataDir, mock: true, hooks });
  assert.deepEqual((await api(`/api/spaces/${space.id}/usage`)).body.members[alice.id].today, zero);

  // 不存在的空间
  assert.equal((await api('/api/spaces/00000000-0000-0000-0000-000000000000/usage')).status, 404);
});
