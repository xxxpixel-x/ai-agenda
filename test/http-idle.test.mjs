import assert from 'node:assert/strict';
import { getEventListeners, once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { AbortedError } from '../src/engines/proc.mjs';
import { cancelBody, errorText, readJson, readSse, readText, request, setFetch } from '../src/engines/http.mjs';
import * as gemini from '../src/engines/gemini.mjs';
import * as openai from '../src/engines/openai-compat.mjs';

afterEach(() => setFetch((...args) => globalThis.fetch(...args)));
const idleMs = 40;
const clock = t => t.mock.timers.enable({ apis: ['setTimeout'] });
const listeners = signal => getEventListeners(signal, 'abort').length;
const aborted = err => err instanceof AbortedError && err.aborted === true && !err.stalled;

// A transport with independently controlled headers and chunks, including one that ignores abort.
function transport(body, status = 200) {
  const state = { cancelled: 0 };
  setFetch((_url, { signal }) => {
    state.signal = signal;
    return new Response(new ReadableStream({
      start(controller) { state.stream = controller; if (body) controller.enqueue(Buffer.from(body)); },
      cancel() { state.cancelled++; },
    }), { status });
  });
  return state;
}

test('CLI, Pi and API idle defaults and explicit RT_IDLE_MINUTES', async (t) => {
  const old = process.env.RT_IDLE_MINUTES;
  t.after(() => { if (old === undefined) delete process.env.RT_IDLE_MINUTES; else process.env.RT_IDLE_MINUTES = old; });
  for (const [value, cli, api] of [[undefined, 20, 10], ['invalid', 20, 10], ['-1', 20, 10], ['0', 0, 0], ['0.5', 0.5, 0.5]]) {
    if (value === undefined) delete process.env.RT_IDLE_MINUTES;
    else process.env.RT_IDLE_MINUTES = value;
    const { IDLE_MS, API_IDLE_MS } = await import('../src/engines/proc.mjs?idle=' + value);
    assert.deepEqual([IDLE_MS, API_IDLE_MS], [cli * 60_000, api * 60_000]);
  }
});

test('header deadline aborts an unresponsive fetch and removes the caller listener', async (t) => {
  clock(t);
  const { signal } = new AbortController();
  let internal;
  setFetch((_url, opts) => { internal = opts.signal; return new Promise(() => {}); });
  const pending = request('test:', { signal, idleMs, name: 'Fixture' });
  assert.equal(listeners(signal), 1);
  t.mock.timers.tick(idleMs);
  await assert.rejects(pending, { stalled: true, message: /Fixture.*1/ });
  assert.ok(internal.aborted);
  assert.equal(listeners(signal), 0);
});

test('a stalled SSE connection is closed after partial data', { timeout: 10_000 }, async (t) => {
  const closed = Promise.withResolvers();
  const server = createServer((_req, res) => {
    res.on('close', closed.resolve);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"part":1}\n\n');
  });
  server.listen(0, '127.0.0.1');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  await once(server, 'listening');
  const caller = new AbortController();
  const res = await request('http://127.0.0.1:' + server.address().port, { signal: caller.signal, idleMs: 0 });
  clock(t);
  const first = Promise.withResolvers();
  const reading = readSse(res, first.resolve, caller.signal, { idleMs, name: 'Stream' });
  assert.deepEqual(await first.promise, { part: 1 });
  t.mock.timers.tick(idleMs);
  await assert.rejects(reading, { stalled: true, message: /Stream/ });
  await closed.promise;
  assert.equal(listeners(caller.signal), 0);
});

test('SSE comments reset the inherited deadline, even without a data callback', async (t) => {
  clock(t);
  const state = transport();
  const { signal } = new AbortController();
  const res = await request('test:', { idleMs, signal });
  t.mock.timers.tick(2 * idleMs); // the headers timer is already cleared
  const data = [];
  const reading = readSse(res, obj => data.push(obj));
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(idleMs - 1);
    state.stream.enqueue(Buffer.from(': keep-alive\n\n'));
    await setImmediate();
  }
  state.stream.enqueue(Buffer.from('data: {"ok":true}\n\n'));
  state.stream.close();
  await reading;
  t.mock.timers.tick(idleMs);
  assert.deepEqual(data, [{ ok: true }]);
  assert.equal(state.signal.aborted, false);
  assert.equal(listeners(signal), 0);
});

test('caller cancellation is distinct from idle while awaiting headers or streaming', async () => {
  const caller = new AbortController();
  setFetch(() => new Promise(() => {}));
  const headers = request('test:', { signal: caller.signal, idleMs: 0 });
  caller.abort();
  await assert.rejects(headers, aborted);
  await assert.rejects(request('test:', { signal: caller.signal }), aborted);
  for (const abortReader of [false, true]) {
    const source = new AbortController(), reader = new AbortController();
    const state = transport();
    const res = await request('test:', { signal: source.signal, idleMs: 0 });
    const reading = readSse(res, () => {}, reader.signal);
    (abortReader ? reader : source).abort();
    await assert.rejects(reading, aborted);
    assert.ok(state.signal.aborted);
    assert.equal(state.cancelled, 1);
    assert.equal(listeners(source.signal) + listeners(reader.signal), 0);
  }
});

for (const read of [readText, readJson, errorText]) {
  test(read.name + ' cancels a stalled body and cleans up the request', async t => {
    clock(t);
    const { signal } = new AbortController();
    const state = transport('{');
    const res = await request('test:', { signal, idleMs: 0, name: 'Probe' });
    const reading = read(res, ...(read === errorText ? [] : [{ idleMs }]));
    const timeout = read === errorText ? 30_000 : idleMs;
    t.mock.timers.tick(timeout - 1);
    state.stream.enqueue(Buffer.from('"ok":'));
    await setImmediate();
    t.mock.timers.tick(timeout - 1);
    assert.equal(state.signal.aborted, false);
    t.mock.timers.tick(1);
    await assert.rejects(reading, { stalled: true, message: /Probe/ });
    assert.ok(state.signal.aborted);
    assert.equal(state.cancelled, 1);
    assert.equal(listeners(signal), 0);
    assert.equal(res.body.locked, false);
  });
}

test('completed, invalid, cancelled and synthetic bodies release their listeners', async () => {
  const { signal } = new AbortController();
  setFetch(() => new Response('{"ok":true}'));
  assert.deepEqual(await readJson(await request('test:', { signal })), { ok: true });
  assert.equal(listeners(signal), 0);
  setFetch(() => new Response('{'));
  await assert.rejects(readJson(await request('test:', { signal })), SyntaxError);
  assert.equal(listeners(signal), 0);
  const state = transport();
  await cancelBody(await request('test:', { signal }));
  assert.equal(state.cancelled, 1);
  assert.equal(listeners(signal), 0);
  setFetch(() => new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), { status: 401 }));
  const probe = await openai.detect({ conn: { baseUrl: 'http://localhost' } });
  assert.equal(probe.ready, false);
  assert.match(probe.note, /API key/);
  assert.equal(await readText(new Response('你好')), '你好');
  assert.equal(await errorText(new Response('{"error":{"message":"fixture"}}', { status: 400 })), '400 fixture');
});

test('model probes have a 30-second header deadline and Gemini model selection honours caller abort', async t => {
  clock(t);
  setFetch(() => new Promise(() => {}));
  const conn = { name: 'Probe', baseUrl: 'https://fixture.invalid', apiKey: 'fixture' };
  const probes = [openai.detect({ conn }), gemini.detect({ conn })];
  t.mock.timers.tick(30_000);
  for (const status of await Promise.all(probes)) {
    assert.equal(status.ready, false);
    assert.match(status.note, /(?:Probe|Gemini).*1/);
  }
  const caller = new AbortController();
  const state = transport('{');
  const turn = gemini.runTurn({ conn, signal: caller.signal });
  await setImmediate();
  caller.abort();
  await assert.rejects(turn, aborted);
  assert.equal(state.cancelled, 1);
  assert.equal(listeners(caller.signal), 0);
});
