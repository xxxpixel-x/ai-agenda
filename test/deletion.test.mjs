import { isMemoryCall, MEMORY_IDLE } from './helpers.mjs';
import { testInChinese as test } from './helpers.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { recompressImport } from '../src/imports.mjs';
import { startServer } from '../src/app-server.mjs';
import { apiRequest, makeSpace, tempDir, until, beginTask } from './helpers.mjs';

for (const relation of ['subdirectory', 'ancestor', 'directory link']) {
  test(`deleting a managed space preserves another space using its ${relation}`, async (t) => {
    const root = tempDir(t);
    const owner = makeSpace(root);
    const sub = path.join(owner.workspacePath, 'sub');
    owner.writeFile('sub/keep.txt', 'keep');
    let folder = sub;
    if (relation === 'ancestor') folder = path.dirname(owner.workspacePath);
    if (relation === 'directory link') {
      folder = path.join(tempDir(t), 'alias');
      fs.symlinkSync(sub, folder, process.platform === 'win32' ? 'junction' : 'dir');
    }
    // Older versions granted these folders. Even a space now skipped on load owns its files.
    const other = makeSpace(root, { workspace: { type: 'folder', path: folder } });
    other.writeFile('reader.txt', 'reader file');
    const server = await startServer({ port: 0, dataDir: path.join(root, 'data'), mock: true });
    t.after(() => server.close());
    assert.throws(() => server.allowFolder(folder), { status: 403 });
    const response = await apiRequest(server, '/api/spaces/' + owner.id, 'DELETE');
    assert.equal(response.status, 200);
    assert.equal(fs.readFileSync(path.join(sub, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(folder, 'reader.txt'), 'utf8'), 'reader file');
    assert.equal(fs.existsSync(path.join(owner.dir, 'history.json')), relation === 'ancestor');
    assert.ok(fs.existsSync(other.store.file(other.id)));
  });
}

test('legacy cleanup rejects malformed IDs, mismatched records and redirected directories before removal', async t => {
  const root = tempDir(t);
  const dataDir = path.join(root, 'data');
  const spaces = path.join(dataDir, 'spaces');
  fs.mkdirSync(spaces, { recursive: true });
  const ids = ['', '.', '..', '../other', null, 12345678, ['valid-id']];
  const record = (name, data) => fs.writeFileSync(path.join(spaces, name + '.json'), JSON.stringify(data));
  for (const [i, id] of ids.entries()) {
    record('bad-space-' + i, { id });
    const valid = 'bad-runs-' + i;
    record(valid, { id: valid, runs: [{ id: 'valid-run' }, { id }] });
  }
  record('mismatch', { id: 'another-space' });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  for (const name of ['linked-space', 'linked-runs', 'linked-run', 'linked-worktree']) {
    const run = path.join(spaces, name, 'runs', 'valid-run');
    const linked = { 'linked-space': path.join(spaces, name), 'linked-runs': path.dirname(run),
      'linked-run': run, 'linked-worktree': path.join(run, 'integration') }[name];
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.symlinkSync(outside, linked, linkType);
    record(name, { id: name, runs: [{ id: 'valid-run', mode: 'git', git: { intPath: path.join(run, 'integration') }, tasks: [] }] });
  }
  const remove = t.mock.method(fs.promises, 'rm', async () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const server = await startServer({ port: 0, dataDir, mock: true });
  t.after(() => server.close());
  assert.equal(remove.mock.callCount(), 0);
  assert.equal(warn.mock.callCount(), ids.length * 2 + 5);
  assert.equal(fs.readdirSync(spaces).filter(name => name.endsWith('.json')).length, warn.mock.callCount());
});

test('startup cleanup also preserves a legacy managed folder used by a current space', async (t) => {
  const root = tempDir(t);
  const owner = makeSpace(root);
  const sub = path.join(owner.workspacePath, 'sub');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'keep.txt'), 'keep');
  makeSpace(root, { workspace: { type: 'folder', path: sub } });
  delete owner.data.kind;
  owner.save();
  const server = await startServer({ port: 0, dataDir: path.join(root, 'data'), mock: true });
  t.after(() => server.close());
  assert.equal(fs.existsSync(owner.store.file(owner.id)), false);
  assert.equal(fs.readFileSync(path.join(sub, 'keep.txt'), 'utf8'), 'keep');
});

for (const activity of ['chat', 'planning', 'worker', 'topic import']) {
  test(`deleting a space waits for ${activity} to stop and prevents resurrection`, async (t) => {
    const root = tempDir(t);
    const external = path.join(root, 'external');
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, 'keep.txt'), 'keep me');
    const space = makeSpace(root, activity === 'worker' ? { workspace: { type: 'folder', path: external } } : {});
    let started = false;
    let stopped = false;
    space.registry.runTurn = async (_engine, opts) => {
    if (isMemoryCall(opts)) return MEMORY_IDLE;
      if (activity === 'worker' && opts.system.includes('这次任务协作的协调者')) {
        return { text: JSON.stringify({ tasks: [{ id: 'T1', title: '测试', assignee: 'Alice', deps: [], spec: '等待中止' }] }) };
      }
      started = true;
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          // 模拟进程收到中止后还需要一点时间退出。
          setTimeout(() => { stopped = true; reject(Object.assign(new Error('已中止'), { aborted: true })); }, 15);
        }, { once: true });
      });
    };
    if (activity === 'chat') space.userMessage('@Alice 等待中止');
    else if (activity === 'topic import') {
      space.data.messages.push({ id: 'topic-a', kind: 'import', mode: 'topic', status: 'error', topic: '接口', name: 'Bob', sourceLabel: 'Codex', writerId: 'member-b', entries: [{ role: 'user', text: '整理接口', acts: [] }] });
      recompressImport(space.importHost, 'topic-a');
    } else {
      await beginTask(space, { objective: '等待中止', discuss: false });
      if (activity === 'worker') {
        await until(() => space.run.data.status, (s) => s === 'plan_review');
        await space.runAction('approve-plan');
      }
    }
    await until(() => started, Boolean);
    const firstDelete = space.remove();
    assert.equal(space.remove(), firstDelete, 'Repeated deletion shares the same operation');
    await firstDelete;
    assert.ok(stopped, 'Deletion must wait for the active engine to exit');
    assert.equal(space.pendingOperations.size, 0);
    assert.equal(fs.existsSync(space.store.file(space.id)), false);
    assert.equal(fs.existsSync(space.dir), false);
    space.save();
    assert.equal(fs.existsSync(space.store.file(space.id)), false, 'A late save cannot restore the space');
    assert.equal(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8'), 'keep me');
  });
}
