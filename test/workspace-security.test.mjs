import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testInChinese as test, tempDir } from './helpers.mjs';
import { Workspace, isSensitiveFile } from '../src/workspace.mjs';
import { containsPath, insideDir, pathsOverlap, physicalPath } from '../src/paths.mjs';
import { filesForPrompt } from '../src/engines/file-blocks.mjs';
import { runAgentTurn } from '../src/turn-runner.mjs';
import { withLanguage } from '../src/i18n.mjs';

const dirLink = process.platform === 'win32' ? 'junction' : 'dir';

test('workspace and Pi use the physical root, including for missing descendants', (t) => {
  const root = tempDir(t);
  const files = path.join(root, 'files');
  const alias = path.join(root, 'alias');
  const outside = path.join(root, 'files-other');
  fs.mkdirSync(files);
  fs.mkdirSync(outside);
  fs.symlinkSync(files, alias, dirLink);
  const ws = new Workspace(alias, path.join(root, 'history.json'));

  assert.ok(containsPath(files, files));
  assert.ok(insideDir('.', alias));
  assert.ok(insideDir('nested/new/file', alias));
  assert.equal(physicalPath(path.join(alias, 'not/yet')), path.join(fs.realpathSync.native(files), 'not/yet'));
  assert.ok(pathsOverlap(path.join(alias, 'not/yet'), path.join(files, 'not/yet/deeper')));
  assert.equal(pathsOverlap(alias, outside), false);
  assert.equal(insideDir(files, alias), false, 'a physical match alone does not grant access');

  const [created] = ws.write('nested/keep.txt', 'inside', 'Alice');
  assert.equal(ws.read('nested/keep.txt'), 'inside');
  fs.renameSync(path.join(files, 'nested'), path.join(files, 'saved'));
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside');
  fs.symlinkSync(outside, path.join(files, 'nested'), dirLink);
  const targets = ['nested/keep.txt', 'nested/new/deep.txt'];
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(outside, 'keep.txt'), path.join(files, 'linked.txt'));
    targets.push('linked.txt');
  }
  for (const rel of targets) {
    assert.equal(insideDir(rel, alias), false);
    for (const operation of [() => ws.resolve(rel), () => ws.read(rel), () => ws.write(rel, 'changed', 'Alice'),
      () => ws.writeRaw(rel, 'changed'), () => ws.acceptCopy(rel)]) {
      assert.throws(operation, { message: '只能访问共享文件夹里的文件' }, rel);
    }
  }
  assert.throws(() => ws.undo(created.id, { force: true }), { message: '只能访问共享文件夹里的文件' });
  assert.deepEqual(ws.list().map((f) => f.path), ['saved/keep.txt']);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside');
  assert.equal(fs.existsSync(path.join(outside, 'new')), false);
});

test('create-only protects files beyond the 3000-entry scan limit', t => {
  const root = tempDir(t);
  const ws = new Workspace(path.join(root, 'files'), path.join(root, 'history.json'));
  for (let i = 0; i < 3001; i++) fs.writeFileSync(path.join(ws.root, `note-${i}.txt`), 'keep');
  const listed = new Set(ws.list().map(f => f.path));
  assert.equal(ws.truncated, true);
  const missing = fs.readdirSync(ws.root).find(name => !listed.has(name));
  assert.ok(missing);
  assert.throws(() => ws.write(missing, '', '我', { createOnly: true }), { status: 409, conflict: true });
  assert.equal(ws.read(missing), 'keep');
});

test('snapshots redact credentials while the file editor and history retain their contents', (t) => {
  const root = tempDir(t);
  const ws = new Workspace(path.join(root, 'files'), path.join(root, 'history.json'));
  const sensitive = ['.env', '.env.local', '.envrc', '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'id_rsa', 'id_ecdsa.pub',
    'config/ID_ED25519_backup', 'config/.ENV.PROD', 'cert.pem', 'app.KEY', 'cert.p12', 'cert.PFX', 'app.jks', 'app.keystore'];
  const visible = ['.env.example', '.env.sample', '.env.template', 'config/.ENV.EXAMPLE', 'notes.env', 'my_id_rsa', 'cert.key.md'];
  for (const name of sensitive) ws.writeRaw(name, 'private fixture');
  ws.writeRaw('cert.p12', Buffer.from([0, 1]));
  for (const name of visible) ws.writeRaw(name, 'public fixture');
  assert.equal(isSensitiveFile('config\\.ENV.LoCaL'), true);
  assert.equal(isSensitiveFile('config\\.EnV.TeMpLaTe'), false);

  const snapshot = ws.snapshot();
  assert.deepEqual(snapshot, [
    ...sensitive.map((path) => ({ path, sensitive: true, content: null })),
    ...visible.map((path) => ({ path, content: 'public fixture' })),
  ].sort((a, b) => a.path.localeCompare(b.path, 'zh-CN')));
  const hiddenPaths = snapshot.filter((f) => f.sensitive).map((f) => f.path);
  const notice = '（以下文件可能含密钥，没有附上内容：' + hiddenPaths.join('、') + '）';
  const prompt = filesForPrompt(snapshot, { maxTotal: 0 });
  assert.equal(prompt.split('\n\n').at(-1), notice);
  assert.ok(prompt.includes('（以下文件太大或太多，没有附上内容：' + snapshot.filter((f) => !f.sensitive).map((f) => f.path).join('、') + '）'));
  assert.doesNotMatch(filesForPrompt(snapshot), /private fixture/);
  assert.ok(ws.list().some((f) => f.path === '.env'));
  assert.equal(ws.read('.env'), 'private fixture');
  const [edit] = ws.write('.env', 'edited fixture', '我');
  assert.equal(ws.change(edit.id).before, 'private fixture');
  assert.equal(ws.change(edit.id).after, 'edited fixture');
});

test('a secrets-only prompt keeps the header and a bounded, localized list even at zero budget', () => {
  const files = Array.from({ length: 51 }, (_, i) => ({ path: '.env.' + i, sensitive: true, content: 'private fixture' }));
  const prompt = filesForPrompt(files, { maxTotal: 0 });
  assert.ok(prompt.startsWith('## 共享文件夹里的文件（最新内容）'));
  assert.ok(prompt.endsWith('.env.49 等）'));
  assert.doesNotMatch(prompt, /private fixture|\.env\.50|目前是空的|太大或太多/);
  withLanguage('en', () => {
    assert.match(filesForPrompt(files.slice(0, 2)), /may contain secrets: \.env\.0, \.env\.1\)/);
  });
});

test('API file blocks protect existing and new secret files and still apply allowed blocks', async (t) => {
  const root = tempDir(t);
  const ws = new Workspace(path.join(root, 'files'), path.join(root, 'history.json'));
  ws.writeRaw('.env', 'original');
  const targets = ['.env', 'config\\app.KEY', '.env/.'];
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(ws.root, '.env'), path.join(ws.root, 'alias.txt'));
    targets.push('alias.txt');
  }
  for (const target of targets) {
    const sink = {};
    const text = ['Done', '<<<File: ' + target, 'replacement', '>>>', '<<<File: .env.example', 'template', '>>>'].join('\n');
    const registry = { isApi: () => true, runTurn: async () => ({ text }) };
    const reply = await runAgentTurn(registry, { name: 'Alice' }, { access: 'edit', ws, sink });
    assert.equal(reply.text, 'Done');
    assert.equal(sink.note, '出于安全考虑，不允许直接覆盖密钥文件 ' + target + '。');
    assert.deepEqual(sink.activities, [{ kind: 'edit', label: '修改 .env.example' }]);
    assert.equal(ws.read('.env'), 'original');
    assert.equal(ws.read('.env.example'), 'template\n');
    assert.equal(fs.existsSync(path.join(ws.root, 'config', 'app.KEY')), false);
  }
});
