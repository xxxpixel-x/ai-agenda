import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ACCESS_RANK, resolveTurnAccess } from '../src/access.mjs';
import { t as tr } from '../src/i18n.mjs';
import { ACCESS } from '../src/prompts.mjs';
import { Space } from '../src/space.mjs';
import { isMemoryCall, makeSpace, MEMORY_IDLE, settleSpace, tempDir } from './helpers.mjs';

test('turn access defaults to edit and rejects unknown access levels before applying caps', () => {
  assert.deepEqual(ACCESS_RANK, { read: 0, edit: 1, run: 2, full: 3 });
  assert.deepEqual(resolveTurnAccess({}), { access: 'edit', asks: false });
  for (const invalid of ['', 'write', 'constructor', '__proto__', null, ['run']]) {
    assert.throws(() => resolveTurnAccess({ spaceAccess: invalid, folderLocked: true }), {
      message: tr('无效的空间权限'),
    });
  }
});

test('turn access respects the space ceiling, role, approval channel and folder lock in every combination', () => {
  const readOnlyRoles = ['coordinator', 'organizer', 'distill', 'handoff', 'import'];
  const flags = [false, true];
  const axes = {
    spaceKind: ['chat', 'task'], spaceAccess: Object.keys(ACCESS_RANK), role: ['chat', 'task-worker', ...readOnlyRoles],
    isApi: flags, supportsApproval: flags, folderLocked: flags,
  };
  let cases = [{}];
  for (const [key, values] of Object.entries(axes)) {
    cases = cases.flatMap((partial) => values.map((value) => ({ ...partial, [key]: value })));
  }
  for (const options of cases) {
    const { spaceKind, spaceAccess, role, isApi, supportsApproval, folderLocked } = options;
    const label = JSON.stringify(options);
    if (role === 'task-worker' && spaceAccess === 'read') {
      assert.throws(() => resolveTurnAccess(options), { message: tr('任务空间不能使用只读权限') }, label);
      continue;
    }
    const result = resolveTurnAccess(options);
    assert.ok(ACCESS_RANK[result.access] <= ACCESS_RANK[spaceAccess], label);
    if (folderLocked || readOnlyRoles.includes(role)) {
      assert.deepEqual(result, { access: 'read', asks: false }, label);
    } else if (spaceKind === 'chat' && role === 'chat' && spaceAccess === 'run' && !isApi) {
      assert.deepEqual(result, supportsApproval ? { access: 'run', asks: true } : { access: 'edit', asks: false }, label);
    } else {
      assert.deepEqual(result, { access: spaceAccess, asks: false }, label);
    }
  }
});

test('a live folder lock caps both the chat preview and the engine turn', async (t) => {
  const space = makeSpace(tempDir(), { access: 'run' });
  const [member] = space.data.members;
  t.mock.method(space.registry, 'supportsApproval', () => true);
  const engine = t.mock.method(space.registry, 'runTurn', async () => ({ text: 'Done' }));
  for (const locked of [true, false]) {
    space.hooks.folderLock = () => locked ? { title: 'Task', spaceId: 'task' } : null;
    const expected = locked ? 'read' : 'run';
    const preview = space.chat.buildContext(member);
    assert.ok(preview.system.includes(ACCESS[expected].desc));
    const result = await space.chat.runTurn(member, 'turn');
    assert.equal(result.error, false);
    const [, opts] = engine.mock.calls.at(-1).arguments;
    assert.ok(opts.system.includes(ACCESS[expected].desc));
    assert.equal(opts.access, expected);
    assert.equal(typeof opts.onApproval === 'function', !locked);
    assert.equal(space.toJSON().access, 'run');
  }
});

test('a persisted read-only task keeps its access until the user explicitly changes it', () => {
  const root = tempDir();
  const seed = makeSpace(root, { kind: 'task', objective: 'Prepare notes' });
  const { store, registry } = seed;
  store.save({ ...seed.data, access: 'read' });
  const [persisted] = store.loadAll();
  assert.equal(persisted.access, 'read');
  const loaded = new Space(persisted, { store, registry, dataDir: path.join(root, 'data') });
  assert.equal(loaded.toJSON().access, 'read');
  assert.equal(loaded.runHost.access, 'read');
  loaded.update({ title: 'Renamed', access: 'read' });
  assert.equal(store.loadAll()[0].access, 'read');
  loaded.update({ access: 'edit' });
  assert.equal(store.loadAll()[0].access, 'edit');
});

test('worker dispatch refuses invalid read-only state before calling the engine', async (t) => {
  const space = makeSpace(tempDir(), { kind: 'task', objective: 'Prepare notes', clarify: false, discuss: false });
  t.after(() => settleSpace(space));
  const calls = [];
  space.registry.runTurn = async (_engine, opts) => {
    if (isMemoryCall(opts)) return MEMORY_IDLE;
    calls.push(opts);
    return { text: JSON.stringify({ tasks: [{ id: 'T1', title: 'Draft', assignee: 'Alice', spec: 'Draft the notes' }] }) };
  };
  await space.startTask();
  await Promise.all(space.pendingOperations);
  assert.equal(space.run.data.status, 'plan_review');
  space.store.save({ ...space.data, access: 'read' });
  const restored = new Space(space.store.loadAll()[0], { registry: space.registry, store: space.store, dataDir: path.dirname(space.store.dir) });
  t.after(() => settleSpace(restored));
  await restored.runAction('approve-plan');
  await Promise.all(restored.pendingOperations);
  const task = restored.run.task('T1');
  assert.equal(task.status, 'failed');
  assert.equal(task.attempts[0].error, tr('任务空间不能使用只读权限'));
  assert.deepEqual(calls.map((call) => call.access), ['read']);
});
