import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../src/app-server.mjs';
import { detect, runTurn, parseModels, supportsPermissions, splitArgs, formatArgs, resolveCommand, classifyPermission } from '../src/engines/acp.mjs';
import { AbortedError } from '../src/engines/proc.mjs';
import { createRegistry, CLI_ENGINE_IDS } from '../src/engines/index.mjs';
import { createSettings } from '../src/settings.mjs';
import { Space } from '../src/space.mjs';
import { Store } from '../src/store.mjs';
import { tempDir, until, settleSpace } from './helpers.mjs';

const fixture = fileURLToPath(new URL('./fixtures/mock-acp.mjs', import.meta.url));
const config = (...args) => ({ name: 'Fixture', command: process.execPath, args: [fixture, ...args] });
const turn = (acp, opts = {}) => runTurn({ acp, prompt: 'Hello', ...opts });

test('arguments round-trip whitespace, quotes, empty strings and Windows paths', () => {
  const args = ['--agent', 'two words', 'a"b', "it's here", 'C:\\Users\\foo\\script.mjs', 'C:\\my dir\\', '', 'a\\"b'];
  assert.deepEqual(splitArgs(formatArgs(args)), args);
  assert.deepEqual(splitArgs('node "one two" three\' and four\' "C:\\Users\\foo\\script.mjs"'), ['node', 'one two', 'three and four', args[4]]);
  assert.deepEqual(splitArgs(['  one', 'two  ']), ['one', 'two']);
  assert.ok(resolveCommand('node').bin);
  assert.equal(resolveCommand('agenda-missing-executable'), null);
  assert.deepEqual(resolveCommand(process.execPath, ['a b']).args, ['a b']);
});

test('Windows npm shims resolve to the JS entry with literal argv', { skip: process.platform !== 'win32' }, (t) => {
  const dir = tempDir(t);
  const shim = path.join(dir, 'demo.cmd');
  const js = path.join(dir, 'demo entry.mjs');
  fs.writeFileSync(js, '');
  fs.writeFileSync(shim, '@node "%~dp0\\demo entry.mjs" %*');
  const resolved = resolveCommand(shim, ['a b']);
  assert.equal(resolved.bin, shim);
  assert.deepEqual(resolved.args, [js, 'a b']);
  assert.match(resolved.cmd, /node\.exe$/i);
});

test('custom ACP settings create, edit, reload and delete atomically', (t) => {
  const file = path.join(tempDir(t), 'settings.json');
  fs.writeFileSync(file, '{"notify":false}');
  const settings = createSettings(file);
  assert.deepEqual(settings.publicView().customAcp, []);
  const c = { id: 'invented', name: ' @My AI ', command: ' node ', args: '"C:\\My Tools\\ai" --acp' };
  const [saved] = settings.update({ customAcp: [c] }).customAcp;
  assert.match(saved.id, /^[0-9a-f]{8}$/);
  assert.deepEqual(saved, { id: saved.id, name: 'MyAI', command: 'node', args: ['C:\\My Tools\\ai', '--acp'], color: '#6366f1' });
  const patch = { ...saved, args: ['  --stdio  '], color: '#a0F', name: 'Editor' };
  const [edited] = settings.update({ customAcp: [patch] }).customAcp;
  assert.deepEqual(edited, { ...patch, args: ['--stdio'], color: '#aa00FF' });
  assert.deepEqual(createSettings(file).publicView().customAcp, [edited]);
  settings.publicView().customAcp[0].args.pop();
  for (const invalid of [{ name: ' @ ' }, { command: ' ' }, { command: 'node\nscript' }, { command: 'node\0' }, { command: 'node\r' }, { args: ['a\0b'] }, { color: 'green' }]) {
    assert.throws(() => settings.update({ notify: true, customAcp: [edited, { ...c, ...invalid }] }), /name|command|argument|color/i);
    assert.equal(settings.get().notify, false);
    assert.deepEqual(settings.get().customAcp, [edited]);
    assert.deepEqual(createSettings(file).get().customAcp, [edited]);
  }
  const many = Array.from({ length: 21 }, () => ({ ...c, name: 'x'.repeat(40), args: Array(51).fill('a'.repeat(1001)) }));
  const limited = settings.update({ customAcp: many }).customAcp;
  assert.equal(limited.length, 20);
  assert.equal(new Set(limited.map((v) => v.id)).size, 20);
  assert.equal(limited[0].name.length, 30);
  assert.equal(limited[0].args.length, 50);
  assert.equal(limited[0].args[0].length, 1000);
  settings.update({ customAcp: [] });
  assert.deepEqual(createSettings(file).get().customAcp, []);
});

test('model catalogs and explicit permission declarations', () => {
  const models = [['a', 'a'], ['b', 'B'], ['c', 'C'], ['d', 'D']];
  assert.deepEqual(parseModels({ currentModelId: 'c', availableModels: ['a', ['b', 'B'], { id: 'c', label: 'C' }, { modelId: 'd', name: 'D' }, null] }), { models, defaultModel: 'c' });
  for (const permissions of [true, {}, { supported: true, request: true }]) assert.equal(supportsPermissions({ capabilities: { permissions } }), true);
  for (const permissions of [false, undefined, null, 'yes', { supported: false }, { request: false }]) assert.equal(supportsPermissions({ agentCapabilities: { permissions } }), false);
  for (const caps of [{ permissionRequests: true }, { requestPermission: true }]) assert.equal(supportsPermissions({ agentCapabilities: caps }), true);
  assert.equal(supportsPermissions({ permissions: true }), true);
});

test('handshake discovers models at initialization or new session and reports actionable failures', async (t) => {
  for (const flag of [[], ['--models-in-session']]) {
    const status = await detect({ acp: config('--models', 'fast:Fast Model,pro:Pro Model', '--default-model', 'pro', ...flag) });
    assert.equal(status.available, true);
    assert.equal(status.ready, true);
    assert.equal(status.version, '1.2.3');
    assert.equal(status.unverifiedPermissions, false);
    assert.deepEqual(status.models, [['fast', 'Fast Model'], ['pro', 'Pro Model']]);
    assert.equal(status.defaultModel, 'pro');
  }
  for (const [name, acp, available, reason] of [
    ['missing', {}, false, /launch command/i], ['missing file', { command: 'agenda-no-such-cli' }, false, /agenda-no-such-cli/],
    ['rpc', config('--fail-init', 'fixture handshake error'), true, /fixture handshake error/],
    ['exit', config('--crash-init'), true, /code 1.*fixture crashed/],
    ['timeout', config('--hang-init'), true, /timed out.*initialize/],
    ['auth', config('--auth-error'), true, /Login required/],
  ]) await t.test(name, async () => {
    const status = await detect({ acp, timeoutMs: name === 'timeout' ? 200 : 5000 });
    assert.equal(status.available, available);
    assert.equal(status.ready, false);
    assert.match(status.note, reason);
  });
  assert.equal((await detect({ acp: config('--fail-new') })).ready, true);
  const status = await detect({ acp: config('--no-permissions') });
  assert.equal(status.ready, true);
  assert.equal(status.unverifiedPermissions, true);
  assert.match(status.note, /without permission/);
});

test('stdio streams text blocks, deduplicates activities and reports usage, model and session', async (t) => {
  const cwd = tempDir(t), deltas = [], activities = [], raw = [];
  const acp = config('--request-edit', 'notes.md', '--request-command', 'echo ok', '--activities', '--echo-model', '--stream', 'A|B|C', '--flat', '--aliases', '--unknown-request');
  const reply = await turn(acp, { cwd, model: 'fast', access: 'run', onDelta: (s) => deltas.push(s), onActivity: (a) => activities.push(a), onRaw: (s) => raw.push(s) });
  assert.deepEqual(deltas.slice(-3), ['A', 'B', 'C']);
  assert.equal(reply.text, deltas.join(''));
  assert.match(reply.text, /unknown=-32601.*model=fastABC/);
  assert.equal(reply.sessionId, 'fixture-session');
  assert.deepEqual(reply.usage, { input: 11, output: 5 });
  assert.equal(reply.unverifiedPermissions, undefined);
  assert.ok(raw.some((s) => s.includes('session/updateNotification')));
  assert.deepEqual(activities, [
    { kind: 'edit', label: 'Edit notes.md' }, { kind: 'command', label: 'Run echo ok' },
    { kind: 'read', label: 'Read notes.md' }, { kind: 'search', label: 'Search agenda' }, { kind: 'tool', label: 'Inspect' },
  ]);
  const loaded = await turn(config('--echo-model'), { cwd, sessionId: 'previous', model: 'chosen' });
  assert.equal(loaded.text, 'model=chosen');
  assert.equal(loaded.sessionId, 'previous');
  const fresh = await turn(config('--fail-load', '--echo-model', '--no-set-model'), { cwd, sessionId: 'previous', model: 'new' });
  assert.equal(fresh.text, 'model=new');
  assert.equal(fresh.sessionId, 'fixture-session');
  assert.equal((await turn(config('--echo-prompt'), { cwd, system: 'system', prompt: 'question', access: 'read' })).text, 'system\n\nquestion access=read');
  const fallback = [];
  assert.equal((await turn(config('--output', 'final'), { onDelta: (s) => fallback.push(s) })).text, 'final');
  assert.deepEqual(fallback, ['final']);
  await assert.rejects(turn(config('--empty')), /no text.*end_turn/i);
});

test('abort and idle timeouts end the child, including during a pending approval', async (t) => {
  const cwd = tempDir(t);
  const pidFile = path.join(cwd, 'pid');
  const dead = async () => {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await until(() => { try { process.kill(pid, 0); return false; } catch (err) { return err.code === 'ESRCH'; } }, Boolean);
  };
  let controller = new AbortController();
  const acp = config('--stream', 'first|second', '--delay-ms', '60000', '--pid-file', pidFile);
  await assert.rejects(turn(acp, { cwd, signal: controller.signal, onDelta: () => controller.abort() }), AbortedError);
  await dead();
  await assert.rejects(turn(acp, { cwd, idleMs: 1500 }), (err) => err.stalled === true);
  await dead();
  controller = new AbortController();
  await assert.rejects(turn(config('--pid-file', pidFile, '--request-command', 'echo ok'), {
    cwd, access: 'run', signal: controller.signal, onApproval() { controller.abort(); return new Promise(() => {}); },
  }), AbortedError);
  await dead();
  await assert.rejects(turn(acp, { signal: AbortSignal.abort() }), AbortedError);
});

for (const access of ['read', 'edit', 'run', 'full']) {
  test(access + ' access maps file and command decisions and forwards notes', async (t) => {
    for (const allow of [true, false]) {
      const cwd = tempDir(t);
      const calls = [];
      const note = allow ? 'go ahead' : 'wait';
      const reply = await turn(config('--request-edit', 'file.md', '--request-command', 'echo ok'), {
        cwd, access, onApproval(req) { calls.push(req); return { allow, note }; },
      });
      const askEdit = access === 'read' || access === 'edit';
      const askCommand = access !== 'full';
      assert.deepEqual(calls, [
        ...(askEdit ? [{ kind: 'edit', command: 'Edit file.md', path: 'file.md' }] : []),
        ...(askCommand ? [{ kind: 'command', command: 'echo ok' }] : []),
      ]);
      for (const [kind, ask] of [['edit', askEdit], ['execute', askCommand]]) {
        const verdict = allow || !ask ? 'allow' : 'reject';
        assert.ok(reply.text.includes(kind + ' opt-' + verdict + '_once' + (ask ? ' ' + note : '')));
      }
      assert.equal(reply.text.split(note).length - 1, calls.length * 2);
      assert.equal(fs.existsSync(path.join(cwd, 'file.md')), !askEdit || allow);
      assert.equal(reply.unverifiedPermissions, undefined);
    }
    const cwd = tempDir(t);
    const unattended = await turn(config('--request-edit', 'file.md', '--request-command', 'echo ok'), { access, cwd });
    assert.equal(fs.existsSync(path.join(cwd, 'file.md')), access !== 'read');
    assert.ok(unattended.text.includes('execute opt-' + (['run', 'full'].includes(access) ? 'allow_once' : 'reject_once')));
  });
}

test('permission classification, cancellation without a reject option, and idle hold', async (t) => {
  for (const kind of ['delete', 'move', 'patch', 'file_write', 'fs_write']) assert.equal(classifyPermission({ toolCall: { kind } }).action, 'edit');
  for (const kind of ['bash', 'shell', 'terminal', 'powershell']) assert.equal(classifyPermission({ toolCall: { name: kind } }).action, 'command');
  for (const kind of ['read', 'search', 'think', 'fetch']) assert.equal(classifyPermission({ toolCall: { kind } }).action, 'read');
  assert.equal(classifyPermission({ toolCall: { kind: 'read', rawInput: { cmd: 'echo hi' } } }).action, 'command');
  assert.equal(classifyPermission({ toolCall: { title: 'Unrecognized' } }).action, 'other');
  const reply = await turn(config('--request-edit', 'note.md', '--no-reject'), {
    cwd: tempDir(t), idleMs: 1000, onApproval: async () => { await delay(1200); return { allow: false, note: 'later' }; },
  });
  assert.match(reply.text, /edit cancelled later/);
});

test('ACP correlates partial permission requests with announced tools and remembers mutations after an early exit', async (t) => {
  const cwd = tempDir(t), calls = [];
  const reply = await turn(config('--announce-first', '--request-edit', 'file.md', '--request-command', 'echo ok'), {
    cwd, access: 'run', onApproval(req) { calls.push(req); return { allow: false }; },
  });
  assert.deepEqual(calls, [{ kind: 'command', command: 'echo ok' }]);
  assert.equal(reply.unverifiedPermissions, undefined);
  assert.equal(fs.readFileSync(path.join(cwd, 'file.md'), 'utf8'), 'ACP fixture edit\n');
  const acp = config('--bypass-permissions', '--crash-prompt');
  await assert.rejects(turn(acp, { cwd, access: 'read' }), /code 2.*fixture crashed during prompt/);
  assert.equal((await detect({ acp })).unverifiedPermissions, true);
});

test('runtime bypass warnings persist only for the matching ACP configuration, even with a warm registry cache', async (t) => {
  const dir = tempDir(t);
  const settings = createSettings(path.join(dir, 'settings.json'));
  const [c] = settings.update({ customAcp: [config('--bypass-permissions', '--models', 'fast:Fast')] }).customAcp;
  const key = 'acp:' + c.id;
  const registry = createRegistry(settings);
  const engine = registry.list().find((e) => e.id === key);
  assert.equal(engine.acpId, c.id);
  assert.equal(engine.kind, 'acp');
  assert.equal(engine.defaultName, c.name);
  assert.equal(CLI_ENGINE_IDS.includes('acp'), false);
  assert.equal(registry.isApi(key), false);
  assert.equal(registry.supportsApproval(key), true);
  assert.equal((await registry.detect(key)).unverifiedPermissions, false);
  assert.equal((await registry.runTurn(key, { cwd: dir, access: 'full', prompt: 'a' })).unverifiedPermissions, undefined);
  assert.equal((await registry.runTurn(key, { cwd: dir, access: 'edit', prompt: 'b' })).unverifiedPermissions, true);
  assert.equal((await registry.detect(key)).unverifiedPermissions, true);
  const row = (await registry.detectAll()).find((e) => e.id === key);
  assert.equal(row.status.ready, true);
  assert.deepEqual(row.status.models, [['fast', 'Fast']]);
  assert.equal((await detect({ acp: c })).unverifiedPermissions, true);
  assert.equal((await detect({ acp: { ...c, args: [fixture] } })).unverifiedPermissions, false);
});

function spaceWithAgent(t, input, ...flags) {
  let space;
  // Stop background turns before tempDir's cleanup removes their cwd.
  t.after(() => space && settleSpace(space));
  const dataDir = tempDir(t);
  const settings = createSettings(path.join(dataDir, 'settings.json'));
  const [c] = settings.update({ customAcp: [config(...flags)] }).customAcp;
  const registry = createRegistry(settings);
  const store = new Store(path.join(dataDir, 'spaces'));
  space = Space.create({ title: 'ACP workspace', members: [{ engine: 'acp:' + c.id, name: 'Agent' }], ...input }, { dataDir, registry, store });
  return space;
}

test('chat streams ACP text, tracks permitted workspace edits and resolves approval cards with notes', async (t) => {
  const space = spaceWithAgent(t, { kind: 'chat', access: 'run' }, '--request-edit', 'chat.md', '--request-command', 'echo ok', '--stream', 'first|last');
  const chunks = [];
  space.on('event', (ev) => { if (ev.type === 'delta') chunks.push(ev.text); });
  for (const decision of ['allow', 'deny']) {
    space.userMessage('Work on the file');
    const card = await until(() => [...space.approvals.values()][0]?.ap, Boolean);
    assert.equal(card.command, 'echo ok');
    assert.equal(space.ws.read('chat.md'), 'ACP fixture edit\n');
    const note = decision + ' with a note';
    space.decideApproval(card.id, decision, note);
    await until(() => space.running, (busy) => !busy);
    const msg = space.data.messages.at(-1);
    assert.equal(msg.error, undefined);
    assert.equal(msg.approvals.length, 1);
    assert.equal(msg.approvals[0].note, note);
    assert.ok(msg.text.includes(note));
    assert.match(msg.text, decision === 'allow' ? /execute opt-allow_once/ : /execute opt-reject_once/);
    assert.deepEqual(chunks.slice(-2), ['first', 'last']);
    const [change] = space.ws.historyList();
    assert.equal(change.path, 'chat.md');
    assert.equal(change.by, 'Agent');
  }
});

test('task space plans, waits for both approvals, writes a file and summarizes over ACP', async (t) => {
  const space = spaceWithAgent(t, { kind: 'task', objective: 'Write a report', access: 'edit', clarify: false, discuss: false }, '--scenario', 'task');
  await space.startTask();
  await until(() => space.run.data.status, (s) => s === 'plan_review');
  assert.equal(space.run.data.tasks.length, 1);
  await space.runAction('approve-plan');
  const task = await until(() => space.run.task('T1'), (v) => v.status === 'review');
  assert.equal(space.ws.read('acp-report.md'), 'ACP fixture edit\n');
  assert.match(task.attempts.at(-1).report, /edit opt-allow_once/);
  await space.runAction('approve-task', { taskId: task.id });
  await until(() => space.run.data.status, (s) => s === 'done');
  assert.equal(task.status, 'approved');
  assert.match(space.run.data.summary.text, /completed acp-report\.md/);
});

async function apiServer(t) {
  const dataDir = tempDir(t);
  const server = await startServer({ dataDir, port: 0, mock: false });
  t.after(() => server.close());
  return async (url, method = 'GET', body, expected = 200) => {
    const response = await fetch('http://127.0.0.1:' + server.port + url, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, expected, JSON.stringify(data));
    return data;
  };
}

test('settings save and handshake endpoints probe live processes and expose their discovered models and failures', async (t) => {
  const api = await apiServer(t);
  const configs = [config('--models-in-session', '--models', 'x:Model X', '--default-model', 'x'), config('--fail-init', 'broken fixture'), config('--no-permissions')];
  const view = await api('/api/settings', 'PUT', { customAcp: configs });
  const ids = view.customAcp.map((c) => c.id);
  const [good, bad, unverified] = ids.map((id) => view.acpStatuses['acp:' + id]);
  assert.equal(good.ready, true);
  assert.equal(bad.ready, false);
  assert.match(bad.note, /broken fixture/);
  assert.equal(unverified.unverifiedPermissions, true);
  assert.deepEqual((await api('/api/settings')).customAcp, view.customAcp);
  for (const [i, expected] of [good, bad, unverified].entries()) {
    const saved = await api('/api/acp/test', 'POST', { id: ids[i] });
    const unsaved = await api('/api/acp/test', 'POST', { ...configs[i], args: formatArgs(configs[i].args) });
    assert.deepEqual(saved, expected);
    assert.deepEqual(unsaved, expected);
  }
  await api('/api/acp/test', 'POST', { id: 'deleted' }, 404);
  await api('/api/acp/test', 'POST', { id: ids[0], command: ' ' }, 400);
  await api('/api/acp/test', 'POST', {}, 400);
  const engines = await api('/api/engines?refresh=1');
  const rows = ids.map((id) => engines.find((e) => e.id === 'acp:' + id));
  assert.deepEqual(rows.map((e) => e.status.ready), [true, false, true]);
  assert.deepEqual(rows[0].status.models, [['x', 'Model X']]);
  assert.equal(rows[0].status.defaultModel, 'x');
  assert.equal(rows[2].status.unverifiedPermissions, true);
  const partial = await api('/api/settings', 'PUT', { notify: false });
  assert.equal(partial.acpStatuses, undefined);
  assert.deepEqual(partial.customAcp, view.customAcp);
});

test('read and edit chat spaces show one-off cards for each ACP mutation', async (t) => {
  const api = await apiServer(t);
  const { customAcp: [c] } = await api('/api/settings', 'PUT', { customAcp: [config('--request-edit', 'change.md', '--request-command', 'echo ok')] });
  for (const access of ['read', 'edit']) {
    const space = await api('/api/spaces', 'POST', { kind: 'chat', title: 'Interactive approvals', access, members: [{ engine: 'acp:' + c.id, name: 'Agent' }] }, 201);
    const url = '/api/spaces/' + space.id;
    await api(url + '/messages', 'POST', { text: 'Check the workspace' }, 201);
    for (const kind of ['edit', 'command']) {
      const card = await until(async () => (await api(url)).messages.at(-1).approvals?.find((a) => a.status === 'pending'), Boolean);
      assert.equal(card.kind, kind);
      assert.deepEqual(card.programs, []);
      await api(url + '/approvals/' + card.id, 'POST', { decision: kind === 'edit' ? 'deny' : 'allow', note: 'only this time' });
    }
    const final = await until(() => api(url), (sp) => !sp.running);
    assert.match(final.messages.at(-1).text, /edit opt-reject_once only this time.*execute opt-allow_once only this time/);
    assert.equal(fs.existsSync(path.join(space.workspace.path, 'change.md')), false);
    await until(() => api(url + '/memory'), (memory) => !memory.organizing);
  }
});
