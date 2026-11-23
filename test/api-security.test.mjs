import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/app-server.mjs';
import { apiRequest, tempDir } from './helpers.mjs';

const members = [{ engine: 'claude-code', name: 'Alice' }];
const workspace = (dir) => ({ type: 'folder', path: dir });
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

async function serve(t, options = {}) {
  const server = await startServer({ dataDir: tempDir(), port: 0, mock: true, hooks: { locales: () => ['en'] }, ...options });
  t.after(() => server.close());
  return server;
}

async function status(server, route, method, headers = {}) {
  const res = await fetch(server.url + route, { method, headers });
  await res.body?.cancel(); // Also release SSE connections on assertion failures.
  return res.status;
}

async function json(request, expected) {
  const res = await request;
  const data = await res.json();
  assert.equal(res.status, expected, JSON.stringify(data));
  return data;
}

const createSpace = (server, options) => apiRequest(server, '/api/spaces', 'POST', { members, ...options });

test('create-only writes use filesystem identity even for unlisted files', async t => {
  const server = await serve(t);
  const space = await json(createSpace(server, {}), 201);
  const route = '/api/spaces/' + space.id + '/file';
  const put = (file, content, createOnly) => apiRequest(server, route, 'PUT', { path: file, content, createOnly });
  const root = space.workspacePath;
  fs.mkdirSync(path.join(root, 'build'));
  const fixtures = [
    ['large.txt', './large.txt', Buffer.alloc(1024 * 1024 + 1, 65)],
    ['binary.dat', 'binary.dat', Buffer.from([0, 7, 255])],
    ['build/note.md', '.\\build\\note.md', Buffer.from('keep')],
  ];
  if (process.platform === 'win32') fixtures.push(['Case.txt', 'case.TXT', Buffer.from('case')]);
  for (const [name, alias, bytes] of fixtures) {
    fs.writeFileSync(path.join(root, name), bytes);
    assert.deepEqual(await json(put(alias, '', true), 409), { error: 'File already exists', conflict: true });
    assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes);
  }
  const writes = await Promise.all(['first', 'second'].map(content => put('new/path.txt', content, true)));
  assert.deepEqual(writes.map(r => r.status).sort(), [200, 409]);
  const winner = writes[0].ok ? 'first' : 'second';
  assert.equal(fs.readFileSync(path.join(root, 'new/path.txt'), 'utf8'), winner);
  await json(put('new/path.txt', 'saved', false), 200);
  assert.equal(fs.readFileSync(path.join(root, 'new/path.txt'), 'utf8'), 'saved');
});

test('task creation, settings and schedules reject read-only access before saving changes', async (t) => {
  const server = await serve(t);
  server.registry.runTurn = async () => ({ text: JSON.stringify({ tasks: [{ id: 'T1', title: 'Review', assignee: 'Alice', spec: 'Review notes' }] }) });
  const task = { kind: 'task', title: 'Review', objective: 'Review notes', clarify: false, discuss: false };
  const error = 'Task spaces need to edit files to deliver results and cannot be set to read-only.';
  assert.equal((await json(createSpace(server, { ...task, access: 'read' }), 400)).error, error);
  assert.deepEqual(await json(apiRequest(server, '/api/spaces'), 200), []);

  const created = await json(createSpace(server, task), 201);
  assert.equal(created.access, 'edit');
  const route = '/api/spaces/' + created.id;
  assert.equal((await json(apiRequest(server, route, 'PATCH', { title: 'Rejected', access: 'read' }), 400)).error, error);
  const saved = await json(apiRequest(server, route), 200);
  assert.deepEqual([saved.title, saved.access], ['Review', 'edit']);

  const chat = await json(createSpace(server, { access: 'read' }), 201);
  assert.equal(chat.access, 'read');
  const schedule = { spaceId: chat.id, enabled: false, rule: { type: 'interval', minutes: 5 } };
  const action = (access) => ({ type: 'task', template: { goal: task.objective, members, access } });
  const schedules = '/api/schedules';
  assert.equal((await json(apiRequest(server, schedules, 'POST', { ...schedule, action: action('read') }), 400)).error, error);
  assert.deepEqual(await json(apiRequest(server, schedules), 200), []);
  const valid = await json(apiRequest(server, schedules, 'POST', { ...schedule, action: action('run') }), 201);
  const scheduleRoute = schedules + '/' + valid.id;
  assert.equal((await json(apiRequest(server, scheduleRoute, 'PATCH', { action: action('read') }), 400)).error, error);
  assert.equal((await json(apiRequest(server, scheduleRoute), 200)).action.template.access, 'run');
});

test('all API routes authenticate before dispatch and static HTML supplies the CSP', async (t) => {
  const server = await serve(t);
  const space = '/api/spaces/00000000-0000-0000-0000-000000000000';
  for (const [method, route] of [
    ['GET', '/api/spaces'], ['GET', '/api/events'], ['GET', '/api/import/sessions'],
    ['GET', space + '/events'], ['GET', space + '/attachments/image'], ['GET', space + '/export'],
    ['GET', '/api/library/roles'], ['POST', '/api/library/skills/install'], ['POST', '/api/acp/test'], ['PUT', '/api/settings'],
  ]) {
    assert.equal(await status(server, route, method), 401, method + ' ' + route);
  }
  const error = await json(fetch(server.url + '/api/spaces'), 401);
  assert.deepEqual(error, { error: 'Unauthorized request' });
  for (const page of ['/', '/index.html']) {
    const res = await fetch(server.url + page);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Security-Policy'), "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    await res.body.cancel();
  }
  assert.equal(await status(server, '/', 'POST'), 405);
});

test('read cookies are port scoped and require same-origin or absent fetch metadata', async (t) => {
  const server = await serve(t);
  assert.match(server.token, /^[a-f0-9]{64}$/);
  assert.match(server.cookieToken, /^[a-f0-9]{64}$/);
  assert.notEqual(server.cookieToken, server.token);
  assert.equal(server.cookieName, 'agenda_sid_' + server.port);
  const cookie = `${server.cookieName}=${server.cookieToken}`;
  for (const route of ['/api/spaces', '/api/events']) {
    const headers = { Cookie: 'unrelated=1; ' + cookie + '; theme=light' };
    assert.equal(await status(server, route, 'GET', headers), 200);
    assert.equal(await status(server, route, 'GET', { ...headers, 'Sec-Fetch-Site': 'same-origin' }), 200);
    for (const site of ['cross-site', 'same-site', 'none']) {
      assert.equal(await status(server, route, 'GET', { ...headers, 'Sec-Fetch-Site': site }), 401);
    }
    assert.equal(await status(server, route, 'GET', { 'X-Agenda-Token': server.token, 'Sec-Fetch-Site': 'cross-site' }), 200);
  }
  for (const headers of [
    { Cookie: 'other_' + cookie }, { Cookie: server.cookieName + '=' + server.token },
    { 'X-Agenda-Token': server.cookieToken }, { 'X-Agenda-Token': 'é'.repeat(server.token.length) },
  ]) assert.equal(await status(server, '/api/spaces', 'GET', headers), 401);

  const second = await serve(t, { auth: { cookieToken: server.cookieToken } });
  assert.notEqual(second.token, server.token);
  assert.notEqual(second.cookieName, server.cookieName);
  assert.equal(await status(second, '/api/spaces', 'GET', { Cookie: cookie }), 401);
  assert.equal(await status(second, '/api/spaces', 'GET', { Cookie: second.cookieName + '=' + server.cookieToken }), 200);
});

test('writes require the header token, matching HTTP origin and JSON in that order', async (t) => {
  const auth = { token: 'header-secret', cookieToken: 'read-secret' };
  const server = await serve(t, { auth });
  const token = { 'X-Agenda-Token': auth.token };
  const headers = { Origin: server.url, 'Content-Type': 'application/json' };
  const cookie = { Cookie: server.cookieName + '=' + auth.cookieToken };
  for (const [method, route] of [['POST', '/api/spaces'], ['PUT', '/api/settings'], ['PATCH', '/api/schedules/id'], ['DELETE', '/api/spaces/id']]) {
    assert.equal(await status(server, route, method, { ...headers, ...cookie }), 401);
    assert.equal(await status(server, route, method, { ...cookie, 'X-Agenda-Token': 'invalid' }), 401);
    assert.equal(await status(server, route, method, token), 403);
    for (const origin of ['http://evil.example', 'null', `https://localhost:${server.port}`, `http://127.0.0.1:${server.port}`, server.url + '/path']) {
      assert.equal(await status(server, route, method, { ...token, Origin: origin }), 403);
    }
    assert.equal(await status(server, route, method, { ...token, Origin: server.url }), 415);
  }
  await json(fetch(server.url + '/api/settings', { method: 'PUT', headers: { ...token, ...headers }, body: '{}' }), 200);
  const ipv4 = 'http://127.0.0.1:' + server.port;
  await json(fetch(ipv4 + '/api/settings', { method: 'PUT', headers: { ...token, ...headers, Origin: ipv4 }, body: '{}' }), 200);
});

test('folder grants match exact physical directories and exclude protected roots', async (t) => {
  const root = tempDir();
  const dataDir = path.join(root, 'data');
  const systemDir = path.join(root, 'system');
  fs.mkdirSync(path.join(systemDir, 'System32'), { recursive: true });
  const priorSystemRoot = process.env.SystemRoot;
  process.env.SystemRoot = systemDir;
  t.after(() => { if (priorSystemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = priorSystemRoot; });
  const server = await serve(t, { dataDir });
  const project = path.join(root, 'project');
  const child = path.join(project, 'child');
  fs.mkdirSync(child, { recursive: true });
  const alias = path.join(root, 'picked');
  fs.symlinkSync(project, alias, linkType);
  const use = (dir) => createSpace(server, { workspace: workspace(dir) });
  const denied = await json(use(project), 403);
  assert.equal(denied.error, 'This shared folder is not authorized. Please select it again.');
  server.allowFolder(alias);
  assert.equal((await json(use(alias), 201)).workspacePath, fs.realpathSync.native(project));
  await json(use(project), 201);
  await json(use(child), 403);
  await json(use(root), 403);
  fs.unlinkSync(alias);
  fs.symlinkSync(child, alias, linkType);
  await json(use(alias), 403);

  const dataAlias = path.join(root, 'data-link');
  fs.symlinkSync(dataDir, dataAlias, linkType);
  for (const blocked of [path.parse(root).root, root, dataDir, dataAlias, path.join(dataAlias, 'spaces'),
    systemDir, path.join(systemDir, 'System32')]) {
    assert.throws(() => server.allowFolder(blocked), { status: 403 });
    await json(use(blocked), 403);
  }
  const file = path.join(project, 'file.txt');
  fs.writeFileSync(file, '');
  for (const invalid of [file, path.join(root, 'missing'), '.']) {
    assert.throws(() => server.allowFolder(invalid), { status: 403 });
  }
});

test('saved spaces and task templates restore folder grants and schedule edits cannot introduce a folder', async (t) => {
  const root = tempDir();
  const dataDir = path.join(root, 'data');
  const first = await serve(t, { dataDir });
  const owner = await json(createSpace(first, {}), 201);
  assert.throws(() => first.allowFolder(owner.workspacePath), { status: 403 });
  await json(createSpace(first, { workspace: workspace(owner.workspacePath) }), 403);
  const task = { kind: 'task', objective: 'Review', workspace: workspace(owner.workspacePath), source: { spaceId: owner.id } };
  const derived = await json(createSpace(first, task), 201);
  assert.equal(derived.workspacePath, owner.workspacePath);
  // Load the original transfer format, from before tasks recorded managedSpaceId.
  const taskFile = path.join(dataDir, 'spaces', derived.id + '.json');
  const fileRoute = '/api/spaces/' + derived.id + '/file';
  await json(apiRequest(first, fileRoute, 'PUT', { path: 'shared.txt', content: 'shared' }), 200);
  await json(createSpace(first, { ...task, source: { spaceId: 'missing' } }), 403);
  const scheduled = path.join(root, 'scheduled');
  const other = path.join(root, 'other');
  fs.mkdirSync(scheduled);
  fs.mkdirSync(other);
  const action = (dir) => ({ type: 'task', template: { goal: 'Review notes', members, workspace: workspace(dir) } });
  const schedule = { spaceId: owner.id, enabled: false, rule: { type: 'interval', minutes: 5 }, action: action(scheduled) };
  await json(apiRequest(first, '/api/schedules', 'POST', schedule), 403);
  assert.deepEqual(await json(apiRequest(first, '/api/schedules'), 200), []);
  first.allowFolder(scheduled);
  const saved = await json(apiRequest(first, '/api/schedules', 'POST', schedule), 201);
  const route = '/api/schedules/' + saved.id;
  await json(apiRequest(first, route, 'PATCH', { action: action(other) }), 403);
  assert.deepEqual((await json(apiRequest(first, route), 200)).action, saved.action);
  first.allowFolder(other);
  first.close();
  const savedTask = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  delete savedTask.workspace.managedSpaceId;
  fs.writeFileSync(taskFile, JSON.stringify(savedTask));

  const restored = await serve(t, { dataDir });
  assert.equal((await json(apiRequest(restored, fileRoute + '?path=shared.txt'), 200)).content, 'shared');
  assert.equal((await json(apiRequest(restored, '/api/spaces/' + owner.id), 200)).workspacePath, owner.workspacePath);
  await json(apiRequest(restored, '/api/spaces/' + owner.id, 'DELETE'), 200);
  assert.equal((await json(apiRequest(restored, fileRoute + '?path=shared.txt'), 200)).content, 'shared');
  await json(createSpace(restored, { workspace: workspace(scheduled) }), 201);
  await json(createSpace(restored, { workspace: workspace(other) }), 403);
  restored.close();
  const orphan = await serve(t, { dataDir });
  assert.equal((await json(apiRequest(orphan, fileRoute + '?path=shared.txt'), 200)).content, 'shared');
});

test('stored workspace types do not grant access to another space or its metadata', async t => {
  const dataDir = tempDir();
  const first = await serve(t, { dataDir });
  const owner = await json(createSpace(first, {}), 201);
  first.close();
  const spaces = path.join(dataDir, 'spaces');
  const seed = JSON.parse(fs.readFileSync(path.join(spaces, owner.id + '.json'), 'utf8'));
  const denied = [
    { kind: 'chat', workspace: { type: 'managed', path: owner.workspacePath } },
    { kind: 'task', workspace: workspace(owner.workspacePath) },
    { kind: 'task', workspace: workspace(path.dirname(owner.workspacePath)), source: { spaceId: owner.id } },
  ];
  for (const [i, record] of denied.entries()) {
    const id = 'rejected-' + i;
    fs.writeFileSync(path.join(spaces, id + '.json'), JSON.stringify({ ...seed, ...record, id }));
  }
  const restored = await serve(t, { dataDir });
  assert.deepEqual((await json(apiRequest(restored, '/api/spaces'), 200)).map(s => s.id), [owner.id]);
});

test('local session metadata authorizes its cwd and a direct topic child before directory creation', async (t) => {
  const root = tempDir();
  const project = path.join(root, 'project');
  const outside = path.join(root, 'other');
  const dataDir = path.join(root, 'data');
  const config = path.join(root, 'claude');
  const sessions = path.join(config, 'projects', 'fixture');
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  fs.mkdirSync(sessions, { recursive: true });
  const sessionId = '11111111-2222-4333-8444-555555555555';
  fs.writeFileSync(path.join(sessions, sessionId + '.jsonl'), JSON.stringify({
    type: 'user', uuid: 'u1', cwd: project, message: { role: 'user', content: 'Review the notes' },
  }));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; });
  const server = await serve(t, { dataDir });
  server.registry.runTurn = async () => ({ text: 'Review the notes.' });
  const local = { source: 'claude-code', sessionId };
  const topic = { ...local, mode: 'topic', topic: 'Notes' };
  const use = (dir, imp) => createSpace(server, { workspace: workspace(dir), import: imp });
  await json(use(outside, { ...local, cwd: outside }), 403);
  const nested = path.join(project, 'nested', 'Notes');
  const unrelated = path.join(outside, 'Notes');
  for (const target of [nested, unrelated]) {
    await json(use(target, { ...topic, cwd: path.dirname(target) }), 403);
    assert.equal(fs.existsSync(target), false);
  }
  const link = path.join(project, 'linked');
  fs.symlinkSync(outside, link, linkType);
  await json(use(link, topic), 403);
  await json(use(path.join(link, 'Notes'), topic), 403);
  assert.equal(fs.existsSync(unrelated), false);

  // Even a saved pasted conversation containing a cwd cannot authorize that path.
  fs.mkdirSync(path.join(dataDir, 'imports'));
  fs.writeFileSync(path.join(dataDir, 'imports', sessionId + '.json'), JSON.stringify({ id: sessionId, cwd: outside, entries: [] }));
  await json(use(outside, { ...local, source: 'pasted' }), 403);
  await json(use(unrelated, { ...topic, source: 'pasted' }), 403);
  assert.equal(fs.existsSync(unrelated), false);

  const imported = await json(use(project, local), 201);
  assert.equal(imported.importError, undefined);
  assert.equal(imported.messages.find((m) => m.kind === 'import').cwd, project);
  const alias = path.join(root, 'project-link');
  fs.symlinkSync(project, alias, linkType);
  const brief = await json(use(path.join(alias, 'Notes'), topic), 201);
  assert.equal(brief.importError, undefined);
  assert.equal(brief.workspacePath, fs.realpathSync.native(path.join(project, 'Notes')));
  await json(createSpace(server, { workspace: workspace(brief.workspacePath) }), 201);
});
