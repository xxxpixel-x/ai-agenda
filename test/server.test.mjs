import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startServer } from '../src/app-server.mjs';
import { tempDir, until } from './helpers.mjs';

test('local HTTP service', { timeout: 30000 }, async (t) => {
  let server;
  t.after(() => server?.close());
  const root = tempDir(t);
  const dataDir = path.join(root, 'data');
  server = await startServer({ port: 0, dataDir, mock: true });
  const base = `http://127.0.0.1:${server.port}`;
  function request(url, { method = 'GET', body, raw, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
      const req = http.request(`${base}${url}`, {
        method,
        headers: { ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          let result = text;
          if (res.headers['content-type']?.includes('application/json')) result = JSON.parse(text);
          resolve({ status: res.statusCode, body: result });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }
  const read = async (url) => {
    const r = await request(url);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const members = [{ engine: 'claude-code', name: 'Alice' }, { engine: 'codex', name: 'Bob' }];
  const created = await request('/api/spaces', { method: 'POST', body: { title: '接口测试', members, maxTurns: 2 } });
  assert.equal(created.status, 201);
  const spaceUrl = `/api/spaces/${created.body.id}`;

  await t.test('serves the application and mock engine catalog', async () => {
    assert.equal((await read('/api/app')).mock, true);
    assert.match(await read('/'), /<title>Agenda<\/title>/);
    const engines = await read('/api/engines');
    assert.ok(engines.length >= 3);
    assert.ok(engines.every((e) => e.status.ready));
    assert.equal((await read('/api/spaces')).length, 1);
  });

  await t.test('rejects untrusted hosts, cross-site writes, bad content types and malformed JSON', async () => {
    assert.equal((await request('/api/app', { headers: { Host: 'untrusted.example' } })).status, 403);
    assert.equal((await request('/api/settings', { method: 'PUT', body: {}, headers: { Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await request('/api/settings', { method: 'PUT', raw: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await request('/api/settings', { method: 'PUT', raw: '{invalid' })).status, 400);
    assert.equal((await request('/%2e%2e%2fpackage.json')).status, 403);
  });

  await t.test('validates members and rejects empty messages', async () => {
    assert.equal((await request('/api/spaces', { method: 'POST', body: { members: [] } })).status, 400);
    assert.equal((await request('/api/spaces', { method: 'POST', body: { members: [members[0], members[0]] } })).status, 400);
    assert.equal((await request(`${spaceUrl}/messages`, { method: 'POST', body: { text: '  ' } })).status, 400);
    assert.equal((await read('/api/spaces')).length, 1);
  });

  await t.test('writes, reads and undoes files through the API', async () => {
    const write = await request(`${spaceUrl}/file`, { method: 'PUT', body: { path: 'note.md', content: 'hello' } });
    assert.equal(write.status, 200);
    assert.equal((await read(`${spaceUrl}/file?path=note.md`)).content, 'hello');
    const history = await read(`${spaceUrl}/history`);
    assert.equal(history[0].by, '我');
    const undo = await request(`${spaceUrl}/history/${history[0].id}/undo`, { method: 'POST', body: {} });
    assert.equal(undo.status, 200);
    assert.ok(!(await read(`${spaceUrl}/files`)).files.some((f) => f.path === 'note.md'));
    assert.equal((await request(`${spaceUrl}/file`, { method: 'PUT', body: { path: '../escape.txt', content: 'invalid' } })).status, 400);
  });

  await t.test('SSE begins with a snapshot and releases the connection on cancellation', async () => {
    const response = await fetch(`${base}${spaceUrl}/events`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    try {
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      assert.match(text, /"type":"snapshot"/);
      assert.ok(text.includes(created.body.id));
    } finally {
      await reader.cancel();
    }
  });

  await t.test('a mention calls only the selected member and records its file changes', async () => {
    const sent = await request(`${spaceUrl}/messages`, { method: 'POST', body: { text: '@Alice 帮我整理想法' } });
    assert.equal(sent.status, 201);
    const finished = await until(() => read(spaceUrl), (s) => !s.running && s.messages.some((m) => m.kind === 'ai'));
    const replies = finished.messages.filter((m) => m.kind === 'ai');
    assert.deepEqual(replies.map((m) => m.name), ['Alice']);
    assert.ok(!replies[0].error);
    assert.ok(replies[0].changes.some((c) => c.path === '共享文档.md'));
    assert.ok((await read(`${spaceUrl}/export`)).includes('@Alice'));
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'spaces', `${created.body.id}.json`), 'utf8'));
    assert.ok(persisted.messages.some((m) => m.name === 'Alice'));
  });

  await t.test('read-only mock discussion does not modify workspace files', async () => {
    assert.equal((await request(spaceUrl, { method: 'PATCH', body: { access: 'read' } })).status, 200);
    const before = (await read(`${spaceUrl}/file?path=${encodeURIComponent('共享文档.md')}`)).content;
    await request(`${spaceUrl}/messages`, { method: 'POST', body: { text: '@Bob 请只阅读' } });
    await until(() => read(spaceUrl), (s) => !s.running && s.messages.some((m) => m.name === 'Bob'));
    assert.equal((await read(`${spaceUrl}/file?path=${encodeURIComponent('共享文档.md')}`)).content, before);
  });

  await t.test('deleting a space preserves an external workspace', async () => {
    const external = path.join(root, 'external');
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, 'keep.txt'), 'keep me');
    const r = await request('/api/spaces', { method: 'POST', body: { members, workspace: { type: 'folder', path: external } } });
    assert.equal(r.status, 201);
    const deleted = await request(`/api/spaces/${r.body.id}`, { method: 'DELETE', body: {} });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8'), 'keep me');
  });
});
