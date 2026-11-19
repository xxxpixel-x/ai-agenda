import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testInChinese as test, tempDir, makeSpace, until } from './helpers.mjs';
import { startServer } from '../src/app-server.mjs';
import { createSettings } from '../src/settings.mjs';
import { createRegistry } from '../src/engines/index.mjs';
import { runAgentTurn } from '../src/turn-runner.mjs';
import { setFetch } from '../src/engines/http.mjs';
import { git, excludeFolder } from '../src/git.mjs';
import { runJsonl } from '../src/engines/proc.mjs';
import { withLanguage } from '../src/i18n.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k9ZkAAAAASUVORK5CYII=', 'base64');
const image = { name: 'a.png', type: 'application/octet-stream', data: png.toString('base64') };
const file = { name: 'x.txt', type: 'text/plain', data: Buffer.from('fixture').toString('base64') };
const members = [{ engine: 'codex', name: 'Alice' }];
const stage = (space, body) => space.attachments.stage(body);
const idle = (space) => until(() => space.running, (running) => !running);

test('attachment HTTP lifecycle and new images in mock chat', async (t) => {
  const root = tempDir(t);
  const server = await startServer({ port: 0, dataDir: root, mock: true, hooks: { locales: () => ['zh'] } });
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.port;
  const api = (url, method = 'GET', body) => fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const { id } = await (await api('/api/spaces', 'POST', { members, access: 'read' })).json();
  const space = '/api/spaces/' + id;
  const uploads = space + '/attachments';
  const upload = async (body) => {
    const res = await api(uploads, 'POST', body);
    assert.equal(res.status, 201);
    return res.json();
  };
  const a = await upload(image);
  assert.deepEqual(a, { id: a.id, kind: 'image', name: image.name, type: 'image/png', size: png.length });
  const res = await api(uploads + '/' + a.id);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
  const fake = await upload({ ...file, name: 'fake.png', type: 'text/html' });
  assert.equal(fake.kind, 'file');
  assert.equal((await api(uploads + '/' + fake.id)).status, 404);
  assert.equal((await api(uploads + '/' + fake.id, 'DELETE')).status, 200);
  assert.equal((await api(space + '/messages', 'POST', { attachments: [fake.id] })).status, 404);

  const send = async (body) => {
    const res = await api(space + '/messages', 'POST', body);
    assert.equal(res.status, 201);
    return res.json();
  };
  assert.deepEqual((await send({ attachments: [a.id] })).attachments, [a]);
  const finished = () => until(async () => (await api(space)).json(), (s) => !s.running);
  assert.match((await finished()).messages.at(-1).text, /看到了 1 张图片/);
  assert.equal((await api(uploads + '/' + a.id, 'DELETE')).status, 400);
  await send({ text: '再说一句' });
  assert.doesNotMatch((await finished()).messages.at(-1).text, /张图片/);
  assert.match(await (await api(space + '/export')).text(), /\[图片：a.png\]/);
  assert.equal((await api(space, 'DELETE')).status, 200);
  assert.ok(!fs.existsSync(path.join(root, 'spaces', id, 'attachments')));
});

test('attachment limits and unsupported member', async (t) => {
  const space = makeSpace(tempDir(t), { members });
  const big = Buffer.alloc(5 * 1024 * 1024 + 1);
  png.copy(big);
  assert.throws(() => stage(space, { ...image, data: big.toString('base64') }), /5 MB/);
  assert.throws(() => stage(space, { ...file, data: 'AAAA'.repeat(Math.ceil(50 * 1024 * 1024 / 3) + 1) }), /50 MB/);
  const staged = Array.from({ length: 11 }, () => stage(space, image));
  await assert.rejects(space.userMessage('', staged.map((a) => a.id)), /10 张/);
  space.registry.supportsImages = () => false;
  const calls = [];
  space.registry.runTurn = async (_id, opts) => { calls.push(opts); return { text: '照常回答' }; };
  await space.userMessage('', [staged[0].id]);
  await idle(space);
  assert.equal(space.data.messages.at(-1).noImages, true);
  assert.equal(calls[0].images, undefined);
  assert.match(calls[0].prompt, /\[图片：a.png\]/);
});

test('file copies use unique names, anchored git excludes and a user baseline during an active turn', async (t) => {
  const root = tempDir(t);
  const project = path.join(root, 'sub', 'dir');
  fs.mkdirSync(project, { recursive: true });
  await git(['init', '-q'], { cwd: root });
  const space = makeSpace(root, { members, workspace: { type: 'folder', path: project } });
  const calls = [];
  let release;
  space.registry.runTurn = async (_id, opts) => {
    calls.push(opts);
    if (calls.length === 1) await new Promise((resolve) => { release = resolve; });
    return { text: '收到' };
  };
  const first = stage(space, file);
  const a = stage(space, image);
  await space.userMessage('', [first.id, a.id]);
  assert.match(calls[0].prompt, /\[附件：附件\/x.txt\]\n\[图片：a.png\]/);
  assert.ok(!fs.existsSync(space.attachments.pathOf(first)));
  assert.deepEqual(calls[0].images, [{ path: space.attachments.pathOf(a), type: 'image/png', name: 'a.png' }]);
  fs.writeFileSync(path.join(project, 'ai.txt'), 'member edit');
  const second = await space.userMessage('', [stage(space, file).id]);
  assert.deepEqual(second.attachments, [{ kind: 'file', path: '附件/x (2).txt', name: 'x (2).txt', size: 7 }]);
  release();
  await idle(space);
  assert.equal(fs.readFileSync(path.join(project, second.attachments[0].path), 'utf8'), 'fixture');
  assert.deepEqual(space.ws.historyList().map((c) => [c.path, c.by]), [['ai.txt', 'Alice']]);
  const exclude = fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split(/\r?\n/).filter((s) => s === '/sub/dir/附件/').length, 1);
  assert.ok((await git(['check-ignore', '附件/x.txt'], { cwd: project })).ok);

  const pending = stage(space, file);
  space.hooks.folderLock = () => ({ title: '示例任务' });
  assert.throws(() => stage(space, file), /示例任务.*不能加附件/);
  await assert.rejects(space.userMessage('', [pending.id]), /示例任务.*不能加附件/);
  assert.equal(stage(space, image).kind, 'image');
  delete space.hooks.folderLock;
  await withLanguage('en', async () => {
    assert.equal((await space.userMessage('', [pending.id])).attachments[0].path, 'attachments/x.txt');
    await idle(space);
  });
});

test('git worktrees share the exclude file and match only the intended project subfolder', async (t) => {
  const root = tempDir(t);
  const repo = path.join(root, 'project');
  const wt = path.join(root, 'copy');
  fs.mkdirSync(repo);
  await git(['init', '-q'], { cwd: repo });
  await git(['commit', '--allow-empty', '-m', 'fixture'], { cwd: repo });
  await git(['worktree', 'add', '--detach', wt], { cwd: repo });
  const cwd = path.join(wt, 'sub [1]');
  fs.mkdirSync(cwd);
  await Promise.all([excludeFolder(cwd, 'attachments'), excludeFolder(cwd, 'attachments')]);
  const patterns = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').split(/\r?\n/);
  assert.equal(patterns.filter((p) => p === '/sub \\[1\\]/attachments/').length, 1);
  assert.ok((await git(['check-ignore', 'attachments/x.txt'], { cwd })).ok);
});

test('one-shot stream-json input reaches EOF after the last image message', async () => {
  const input = [{ type: 'user', message: { content: [{ type: 'text', text: 'fixture' }, { type: 'image' }] } }];
  const seen = [];
  const result = await runJsonl({
    cmd: process.execPath, args: ['-e', 'process.stdin.on("data", b => process.stdout.write(b))'],
    input, idleMs: 3000, onEvent: (m) => seen.push(m),
  });
  assert.equal(result.code, 0);
  assert.deepEqual(seen, input);
});

test('OpenAI-compatible 4xx retries text once and persists image support per connection', async (t) => {
  const root = tempDir(t);
  const config = path.join(root, 'fixture.json');
  const settings = createSettings(config);
  const providers = settings.update({ providers: ['First', 'Second'].map((name) => ({ name, baseUrl: 'https://fixture.invalid', model: 'test' })) }).providers;
  const registry = createRegistry(settings);
  const member = { engine: 'openai:' + providers[0].id };
  const img = path.join(root, 'a.png');
  fs.writeFileSync(img, png);
  const sent = [];
  setFetch(async (_url, req) => {
    sent.push(JSON.parse(req.body).messages.at(-1).content);
    if (sent.length === 1) return new Response('fixture error', { status: 400 });
    return new Response('data: {"choices":[{"delta":{"content":"fixture reply"}}]}\n');
  });
  t.after(() => setFetch((...args) => globalThis.fetch(...args)));
  const sink = {};
  const opts = { prompt: 'fixture', images: [{ path: img, type: 'image/png', name: 'a.png' }], sink };
  assert.equal((await runAgentTurn(registry, member, opts)).text, 'fixture reply');
  assert.equal(sink.noImages, true);
  assert.deepEqual(sent, [[{ type: 'text', text: 'fixture' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + image.data } }], 'fixture']);
  settings.update({ providers });
  const reloaded = createRegistry(createSettings(config));
  assert.equal(reloaded.supportsImages(member.engine), false);
  assert.equal(reloaded.supportsImages('openai:' + providers[1].id), true);
  await runAgentTurn(reloaded, member, opts);
  assert.equal(sent[2], 'fixture');
});
