import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { en, t } from '../public/i18n.js';
import { AUTO_HANDOFF_PRESETS, MEMORY_FILTERS, MEMORY_FILTER_LABELS, MEMORY_TYPE_LABELS, computeBreakdownRows,
  countMemoryFilters, filterMemoryEntries, formatActionSummary, formatCountCompact, formatHandoffReason,
  formatMemoryOrigin, formatMemorySources, handoffButtonState, matchesMemoryFilter, normalizeAutoHandoffPct,
  normalizeContextResponse, statelessContextTip } from '../public/js/context-memory-format.js';
import { startServer } from '../src/app-server.mjs';
import { openMemory } from '../src/memory/store.mjs';
import { apiRequest, tempDir } from './helpers.mjs';

const asset = (file) => readFile(new URL('../public/' + file, import.meta.url), 'utf8');
const modules = ['context-panel', 'memory-view', 'recap', 'context-memory-format'];
const styles = ['context-panel', 'memory-view'];

test('panel registrations, module imports, stylesheets and theme tokens are wired', async () => {
  const [index, app, tokens] = await Promise.all(['index.html', 'app.js', 'css/tokens.css'].map(asset));
  for (const name of styles) {
    assert.ok(index.includes('href="/css/' + name + '.css"'));
    assert.ok(app.includes("import './js/" + name + ".js'"));
    const css = await asset('css/' + name + '.css');
    assert.doesNotMatch(css, /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i);
    assert.match(css, /prefers-reduced-motion: reduce/);
    const defined = tokens + css;
    for (const [, key] of css.matchAll(/var\((--[\w-]+)/g)) assert.ok(defined.includes(key + ':'), key);
    const module = await asset('js/' + name + '.js');
    assert.ok(module.includes("register('panels', { id: '" + name.split('-')[0] + "'"));
  }
});

test('all literal UI keys and dynamic memory labels have English translations with identical placeholders', async () => {
  const keys = new Set([...Object.values(MEMORY_TYPE_LABELS), ...Object.values(MEMORY_FILTER_LABELS)]);
  const placeholders = (s) => s.match(/\{\d+\}/g)?.sort() || [];
  for (const name of [...modules, 'usage-meter', 'settings/general', 'chat']) {
    const js = await asset('js/' + name + '.js');
    for (const [, key] of js.matchAll(/\btr\('([^']+)'\s*[,)]/g)) keys.add(key);
  }
  for (const key of keys) {
    assert.ok(Object.hasOwn(en, key) && en[key].length > 0, key);
    assert.deepEqual(placeholders(en[key]), placeholders(key), key);
  }
});

const emptyRecap = { text: '', uptoSeq: 0, version: 0, editedByUser: false, updatedAt: null };
const breakdown = {
  system: { tokens: 20, chars: 40 }, memory: { tokens: 30, chars: 30, entryIds: [1, 12] },
  recap: { tokens: 5, chars: 5 }, imports: { tokens: 40, chars: 40 },
  recent: { tokens: 3, chars: 5, count: 12 }, files: { tokens: 2, chars: 10 },
  omitted: { tokens: 900, chars: 1800, count: 38 },
};

test('normalizeContextResponse tolerates old, missing and malformed fields and preserves the full contract', () => {
  for (const raw of [null, undefined, {}, { members: [] }, { members: null }]) {
    assert.deepEqual(normalizeContextResponse(raw), { recap: emptyRecap, members: {} });
  }
  const raw = { recap: { text: '# Decisions', uptoSeq: 42, version: 2, editedByUser: true, updatedAt: 12345 },
    members: { a: { mode: 'session', lastTurnAt: 12500, canHandoff: true, running: false, breakdown,
      handoffs: [{ at: 10, reason: 'manual', summary: 'Start over' }] } } };
  assert.deepEqual(normalizeContextResponse(raw), raw);
  const { recap, members } = normalizeContextResponse({ recap: { version: -1, text: 3 }, members: {
    empty: null, b: { handoffs: [null, {}], breakdown: { files: { tokens: Infinity }, memory: { chars: 8, entryIds: [1, 0, null, 1, -1, 4] } } },
  } });
  assert.deepEqual(recap, emptyRecap);
  assert.equal(members.empty.mode, 'stateless');
  assert.equal(members.empty.canHandoff, false);
  assert.deepEqual(members.b.handoffs, [{ at: 0, reason: '', summary: '' }]);
  assert.deepEqual(members.b.breakdown.memory, { chars: 8, tokens: 0, entryIds: [1, 4] });
  assert.deepEqual(members.b.breakdown.files, { chars: 0, tokens: 0 });
  assert.deepEqual(members.b.breakdown.recent, { chars: 0, tokens: 0, count: 0 });
});

const entries = [
  { id: 1, type: 'preference', origin: 'user', files: ['src/Login.js'], scope: 'mobile' },
  { id: 2, type: 'fact', text: 'Uses SQLite' }, { id: 3, type: 'question', status: 'resolved', by: 9 },
  { id: 4, type: 'proposal' }, { id: 5, type: 'disagreement' }, { id: 6, type: 'question' },
  { id: 7, type: 'rejected', reason: 'Too slow' }, { id: 8, type: 'constraint', topics: ['Design'] },
  { id: 9, type: 'decision', task: 'T3', origin: 'default' }, { id: 10, type: 'decision', origin: 'user' },
  { id: 11, type: 'result', source: { files: ['demo.zip'] } }, { id: 12, type: 'decision', status: 'superseded', by: 10 },
].map((e) => ({ status: 'active', ...e }));

test('all eight filters count matching entries, prioritize active entries and sort by descending ID', () => {
  const expected = { all: [11, 10, 9, 8, 7, 6, 5, 4, 2, 1, 12, 3], decision: [10, 9], constraint: [8], preference: [1],
    rejected: [7], open: [6, 5, 4], result: [11], superseded: [12, 3] };
  assert.deepEqual(MEMORY_FILTERS, Object.keys(expected));
  assert.equal(Object.keys(MEMORY_TYPE_LABELS).length, 9);
  for (const [key, ids] of Object.entries(expected)) {
    assert.deepEqual(filterMemoryEntries(entries, key).map((e) => e.id), ids);
    assert.equal(countMemoryFilters(entries)[key], ids.length);
    assert.equal(countMemoryFilters(null)[key], 0);
    for (const e of entries) assert.equal(matchesMemoryFilter(e, key), ids.includes(e.id));
  }
  assert.deepEqual(entries.map((e) => e.id), Array.from({ length: entries.length }, (_, i) => i + 1));
  assert.deepEqual(filterMemoryEntries(undefined), []);
  assert.deepEqual(filterMemoryEntries([null, 7, { id: 1, type: 'decision' }], 'decision').map((e) => e.id), [1]);
});

test('memory search covers IDs, text, reason, topics, files, task and scope within the selected filter', () => {
  for (const [query, id] of [['#1', 1], ['10', 10], [' SQLitE ', 2], ['SLOW', 7], ['design', 8],
    ['LOGIN.JS', 1], ['t3', 9], ['mobile', 1], ['demo.zip', 11]]) {
    assert.deepEqual(filterMemoryEntries(entries, 'all', query).map((e) => e.id), [id], query);
  }
  assert.deepEqual(filterMemoryEntries(entries, 'decision', '#12'), []);
  assert.deepEqual(filterMemoryEntries(entries, 'all', '#99'), []);
});

for (const lang of ['zh', 'en']) {
  const tr = (key, vars) => t(key, vars, lang);
  test(lang + ' · breakdown excludes omitted content and uses characters only when tokens are unavailable', () => {
    const { rows, totalTokens, totalChars, omitted, hasData } = computeBreakdownRows(breakdown, tr);
    assert.deepEqual([totalTokens, totalChars, hasData], [100, 130, true]);
    assert.deepEqual(omitted, breakdown.omitted);
    assert.deepEqual(rows.map((r) => r.tone), ['system', 'memory', 'recap', 'imports', 'recent', 'files']);
    assert.deepEqual(rows.map((r) => r.pct), [20, 30, 5, 40, 3, 2]);
    assert.deepEqual(rows[1].entryIds, [1, 12]);
    assert.equal(rows[4].count, 12);
    assert.equal(rows[4].label, tr('最近 {0} 条聊天', [12]));
    const empty = computeBreakdownRows({ omitted: breakdown.omitted }, tr);
    assert.equal(empty.hasData, false);
    assert.ok(empty.rows.every((r) => r.pct === 0));
    assert.equal(empty.rows[4].label, tr('最近聊天'));
    const chars = computeBreakdownRows({ files: { chars: 8 }, system: { chars: 12 } }, tr);
    assert.equal(chars.totalChars, 20);
    assert.deepEqual(chars.rows.map((r) => r.pct), [60, 0, 0, 0, 0, 40]);
    assert.equal(formatCountCompact(12000, lang), lang === 'zh' ? '1.2万' : '12K');
    assert.equal(formatCountCompact(null, lang), '0');
  });

  test(lang + ' · handoff availability obeys closed, speaking, and session capability in priority order', () => {
    const member = { mode: 'session', canHandoff: true };
    for (const [ctx, flags, reason] of [
      [null, { spaceClosed: true, speaking: true }, '这个任务已经结束，无法重开会话'],
      [member, { speaking: true }, '正在发言，说完后才能重开会话'],
      [{ running: true, canHandoff: false }, {}, '正在发言，说完后才能重开会话'],
      [null, {}, '当前成员不保持长会话，每轮已自动重新组装上下文'],
      [{ canHandoff: false }, {}, '当前成员不保持长会话，每轮已自动重新组装上下文'],
    ]) assert.deepEqual(handoffButtonState(ctx, flags, tr), { disabled: true, reason: tr(reason) });
    assert.deepEqual(handoffButtonState(member, {}, tr), { disabled: false, reason: '' });
    for (const [key, label] of Object.entries({ auto: '自动交接', manual: '手动重开', config_changed: '设置变更', unknown: '换了新会话' })) {
      assert.equal(formatHandoffReason(key, tr), tr(label));
    }
  });

  test(lang + ' · stateless context hints and command summaries preserve counts and command order', () => {
    const member = { breakdown };
    assert.equal(statelessContextTip(member, true, tr), tr('最近 {0} 条在、更早的 {1} 条已压进前情提要', [12, 38]));
    assert.equal(statelessContextTip(member, undefined, tr), statelessContextTip(member, true, tr));
    assert.equal(statelessContextTip(member, false, tr), tr('最近 {0} 条在、更早的 {1} 条已省略', [12, 38]));
    assert.equal(statelessContextTip({ breakdown: { recent: { count: 3 } } }, false, tr), tr('最近 {0} 条在上下文中', [3]));
    assert.equal(statelessContextTip(null, false, tr), '');
    for (const v of [[], null, [false, 4, ' '], 'npm test']) assert.equal(formatActionSummary(v, tr), null);
    for (const [actions, items] of [[[' cmd '], ['cmd']], [[' one', 4, ' ', 'one', 'two', 'one'], ['one', 'two', 'one']]]) {
      assert.deepEqual(formatActionSummary(actions, tr), { items, text: tr('运行了：{0}', [items.join(' · ')]) });
    }
  });

  test(lang + ' · origin and source chips distinguish decisions, attempts and original messages', () => {
    for (const type of ['decision', 'constraint', 'preference']) {
      assert.deepEqual(formatMemoryOrigin({ type, origin: 'user' }, tr), { kind: 'user', label: tr('你定的') });
    }
    assert.deepEqual(formatMemoryOrigin({ type: 'decision' }, tr), { kind: 'default', label: tr('默认通过的') });
    assert.equal(formatMemoryOrigin({ type: 'preference', origin: 'default' }, tr), null);
    assert.equal(formatMemoryOrigin({ type: 'fact', origin: 'user' }, tr), null);
    assert.deepEqual(formatMemorySources({ messages: [128, null], tasks: ['T3', 'T3/2', null], files: ['src/login.js'] }, tr), [
      { kind: 'message', seq: 128, label: tr('消息 {0}', [128]) },
      { kind: 'task', ref: 'T3', taskId: 'T3', label: tr('任务 {0}', ['T3']) },
      { kind: 'task', ref: 'T3/2', taskId: 'T3', label: tr('任务 {0} 第 {1} 次执行', ['T3', 2]) },
      { kind: 'file', file: 'src/login.js', label: 'src/login.js' },
    ]);
    assert.deepEqual(formatMemorySources(null, tr), []);
  });
}

test('thresholds preserve disabled and custom values, round, clamp, and default invalid input', () => {
  assert.deepEqual(AUTO_HANDOFF_PRESETS, [0, 30, 40, 50, 60, 70, 80, 90]);
  for (const invalid of [undefined, null, '', '  ', true, {}, -1, 'x', Infinity, NaN]) assert.equal(normalizeAutoHandoffPct(invalid), 50);
  for (const [value, expected] of [[0, 0], ['0', 0], [0.1, 1], [55, 55], ['55', 55], [59.5, 60], [101, 100]]) {
    assert.equal(normalizeAutoHandoffPct(value), expected);
  }
});

// Exercise the actual request handlers in Node. Only the DOM surfaces used by
// the editor and the member chips are replaced; fetch still returns HTTP Responses.
test('recap editor keeps its base version, handles both conflict responses, and ignores obsolete reads', async (testCase) => {
  const toasts = [];
  let textarea;
  const slot = {
    html: '',
    set innerHTML(html) { this.html = html; textarea = html.includes('<textarea') ? { focus() {} } : null; },
    replaceChildren() { this.innerHTML = ''; },
    querySelector(selector) { return selector === 'textarea' ? textarea : null; },
  };
  const doc = { documentElement: {}, querySelectorAll: () => [], createElement: () => ({ remove() {} }),
    querySelector: (key) => key === '#recapSlot' ? slot : { appendChild: (el) => toasts.push(el.textContent) } };
  globalThis.document = doc;
  globalThis.window = new EventTarget();
  testCase.after(() => { delete globalThis.window; delete globalThis.document; });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const click = (recap) => slot.onclick({ target: { closest: () => ({ dataset: { recap } }) } });
  const type = (value) => { textarea.value = value; textarea.oninput(); };
  const update = () => window.dispatchEvent(new CustomEvent('agenda:context-updated', { detail: { spaceId: 'a' } }));
  let latest = { text: 'First', version: 1, uptoSeq: 9 };
  let putStatus = 409, includeLatest = true, getStatus = 200, reads = 0, nextRead;
  const puts = [];
  testCase.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (url === '/api/app') return Response.json({ language: 'en' });
    if (url.endsWith('/context')) {
      reads++;
      if (nextRead) { const pending = nextRead; nextRead = null; return pending; }
      return Response.json({ recap: latest }, { status: getStatus });
    }
    assert.equal(url, '/api/spaces/a/recap');
    assert.equal(opts.method, 'PUT');
    const payload = JSON.parse(opts.body);
    puts.push(payload);
    if (putStatus === 200) latest = { ...latest, text: payload.text, version: latest.version + 1 };
    return Response.json({ error: 'Save failed', ...(includeLatest || putStatus === 200 ? { recap: latest } : {}) }, { status: putStatus });
  });
  // Toast expiry is independent of the editor; avoid retaining a Node timer after this test.
  const schedule = globalThis.setTimeout;
  testCase.mock.method(globalThis, 'setTimeout', (...args) => schedule(...args).unref());
  const { state, api } = await import('../public/js/util.js');
  const { resetRecap, syncRecapSlot } = await import('../public/js/recap.js');
  testCase.after(resetRecap);
  state.space = { id: 'a' };
  getStatus = 404;
  syncRecapSlot(state.space);
  await settle();
  assert.equal(slot.hidden, true);
  assert.deepEqual(toasts, []);
  await assert.rejects(api('/api/spaces/a/context'), (e) => e.status === 404 && e.data.recap.version === 1);
  getStatus = 200;
  update();
  await settle();
  assert.match(slot.html, /aria-expanded="false"/);
  assert.match(slot.html, /Through message #9/);
  click('toggle');
  click('edit');
  type('User draft');
  const editor = textarea;
  latest = { text: 'Background version', version: 2 };
  update();
  await settle();
  assert.equal(textarea, editor);
  assert.equal(textarea.value, 'User draft');
  click('save');
  await settle();
  assert.deepEqual(puts.at(-1), { text: 'User draft', version: 1 });
  assert.match(slot.html, /role="alert"/);
  assert.equal(textarea.value, 'User draft');
  const beforeLoad = reads;
  click('latest');
  await settle();
  assert.equal(reads, beforeLoad);
  assert.equal(textarea.value, 'Background version');
  assert.doesNotMatch(slot.html, /role="alert"/);
  type('Another draft');
  latest = { text: 'Third', version: 3 };
  includeLatest = false;
  click('save');
  await settle();
  assert.equal(puts.at(-1).version, 2);
  assert.equal(textarea.value, 'Another draft');
  click('latest');
  await settle();
  assert.equal(reads, beforeLoad + 1);
  assert.equal(textarea.value, 'Third');
  type('Final text');
  putStatus = 500;
  click('save');
  await settle();
  assert.equal(textarea.value, 'Final text');
  assert.doesNotMatch(slot.html, /disabled/);
  assert.equal(toasts.at(-1), 'Save failed');
  let updates = 0;
  window.addEventListener('agenda:context-updated', () => updates++);
  putStatus = 200;
  click('save');
  await settle();
  assert.deepEqual(puts.at(-1), { text: 'Final text', version: 3 });
  assert.equal(updates, 1);
  assert.equal(textarea, null);
  assert.match(slot.html, /Final text/);
  assert.equal(toasts.at(-1), 'Recap saved');

  let release;
  nextRead = new Promise((resolve) => { release = resolve; });
  update();
  resetRecap();
  state.space = { id: 'b' };
  latest = { text: '   ', version: 0 };
  syncRecapSlot(state.space);
  await settle();
  release(Response.json({ recap: { text: 'Stale space A' } }));
  await settle();
  assert.equal(slot.hidden, true);
  assert.equal(slot.html, '');
});

test('usage rings, quota and stateless tips tolerate independent context and usage endpoint failures', async (testCase) => {
  // Importing the meter normally also starts the chat UI. Stub just its chip painter.
  const painter = 'data:text/javascript,export const meters=new Map();export function setMemberMeter(id,meter){meters.set(id,meter)}';
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === './chat.js' && context.parentURL.endsWith('/usage-meter.js')) {
      return { url: painter, shortCircuit: true };
    }
    return next(specifier, context);
  } });
  globalThis.window = new EventTarget();
  const bar = { querySelectorAll: () => [], querySelector: () => null };
  globalThis.document = { documentElement: {}, querySelector: () => bar, querySelectorAll: () => [] };
  globalThis.CSS = { escape: String };
  let barChanged, usageStatus = 200, contextStatus = 404;
  globalThis.MutationObserver = class { constructor(callback) { barChanged = callback; } observe() {} };
  testCase.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/api/app') return Response.json({ language: 'en' });
    if (url.endsWith('/usage')) return Response.json({ members: { m: { latest: { contextUsed: 1, contextWindow: 4 } } } }, { status: usageStatus });
    assert.ok(url.endsWith('/context'));
    return Response.json({ recap: { uptoSeq: 9 }, members: { m: { mode: 'stateless', breakdown } } }, { status: contextStatus });
  });
  testCase.after(() => {
    hooks.deregister();
    delete globalThis.window; delete globalThis.document; delete globalThis.MutationObserver; delete globalThis.CSS;
  });
  const { meterFor } = await import('../public/js/usage-meter.js');
  const now = Date.now();
  const entry = { latest: { contextUsed: 8, contextWindow: 10, quota: { usedPct: 80, resetsAt: now + 10000 } },
    total: { input: 30, output: 29, cacheRead: 1 }, today: { input: 3 } };
  assert.equal(meterFor(null), null);
  assert.equal(meterFor(entry).ratio, 0.8);
  assert.equal(meterFor(entry, now).warn, true);
  const member = { mode: 'stateless', breakdown };
  const m = meterFor(entry, now, member, false);
  assert.equal(m.ratio, null);
  assert.equal(m.warn, true);
  assert.match(m.tip, /^In context: 12 recent messages\. Omitted 38 earlier messages\.\nQuota 80%, resets /);
  const expired = meterFor(entry, entry.latest.quota.resetsAt, member);
  assert.equal(expired.warn, false);
  assert.match(expired.tip, /The recap covers 38 earlier messages\.\nThis space: 60 tokens, today: 3/);
  assert.equal(meterFor(null, now, member).tip, statelessContextTip(member));
  assert.equal(meterFor({ latest: { contextWindow: 0 } }, now, { breakdown }).ratio, null);
  assert.equal(meterFor({ latest: { quota: { usedPct: 79 } } }).warn, false);

  const { state } = await import('../public/js/util.js');
  const { meters } = await import(painter);
  const changeSpace = async (id) => {
    state.space = { id, members: [{ id: 'm' }] };
    barChanged();
    window.dispatchEvent(new CustomEvent('agenda:context-updated', { detail: { spaceId: id } }));
    await new Promise((resolve) => setImmediate(resolve));
  };
  await changeSpace('old-server');
  assert.deepEqual(meters.get('m'), { ratio: 0.25, tip: 'Context 25%' });
  usageStatus = 503; contextStatus = 200;
  await changeSpace('context-only');
  assert.deepEqual(meters.get('m'), { ratio: null, tip: statelessContextTip(member, true) });
});

test('settings preserve sorted custom thresholds and roll back failed or unsupported saves', async (testCase) => {
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === '../sidebar.js' && context.parentURL.endsWith('/settings/general.js')) {
      return { url: 'data:text/javascript,export const theme="light";export function applyTheme(){}', shortCircuit: true };
    }
    return next(specifier, context);
  } });
  const messages = [];
  const notifications = { appendChild: (el) => messages.push(el.textContent) };
  globalThis.document = { documentElement: {}, querySelector: () => notifications, querySelectorAll: () => [], createElement: () => ({ remove() {} }) };
  testCase.after(() => { hooks.deregister(); delete globalThis.document; });
  const schedule = globalThis.setTimeout;
  testCase.mock.method(globalThis, 'setTimeout', (...args) => schedule(...args).unref());
  let status = 200, supported = true;
  const writes = [];
  testCase.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (url === '/api/app') return Response.json({ language: 'en' });
    assert.equal(url, '/api/settings');
    if (opts.method === 'GET') return Response.json({ autoHandoffPct: 55, language: 'en' });
    assert.equal(opts.method, 'PUT');
    const update = JSON.parse(opts.body);
    writes.push(update);
    return Response.json(supported ? update : {}, { status });
  });
  await import('../public/js/settings/general.js');
  const { list } = await import('../public/js/slots.js');
  const select = {};
  const el = { querySelector: (sel) => sel === '#autoHandoffPct' ? select : {}, querySelectorAll: () => [] };
  await list('settings').find((s) => s.id === 'general').render(el);
  const options = el.innerHTML.split('id="autoHandoffPct">')[1].split('</select>')[0];
  assert.deepEqual([...options.matchAll(/value="(\d+)"/g)].map((m) => +m[1]), [0, 30, 40, 50, 55, 60, 70, 80, 90]);
  assert.match(options, /value="55" selected/);
  const change = async (n) => {
    select.value = String(n);
    const saving = select.onchange({ target: select });
    assert.equal(select.disabled, true);
    await saving;
    assert.equal(select.disabled, false);
    assert.deepEqual(writes.at(-1), { autoHandoffPct: n });
  };
  await change(0);
  assert.equal(select.value, '0');
  assert.equal(messages.at(-1), 'Saved');
  status = 500;
  await change(70);
  assert.equal(select.value, '0');
  status = 200; supported = false;
  await change(60);
  assert.equal(select.value, '0');
  assert.equal(messages.at(-1), en['当前服务器不支持自动交接设置']);
});

test('live server serves the new modules and styles and exposes searchable, status-aware memory', async (t) => {
  const dataDir = tempDir(t);
  const server = await startServer({ port: 0, dataDir, mock: true });
  try {
    for (const file of [...modules.map((m) => 'js/' + m + '.js'), ...styles.map((m) => 'css/' + m + '.css')]) {
      const res = await fetch(server.url + '/' + file);
      assert.equal(res.status, 200, file);
      assert.match(res.headers.get('content-type'), file.endsWith('.js') ? /javascript/ : /text\/css/);
      assert.equal(await res.text(), await asset(file));
    }
    const created = await apiRequest(server, '/api/spaces', 'POST', { title: 'Memory contract', members: [{ engine: 'codex' }], access: 'read' });
    assert.equal(created.status, 201);
    const space = await created.json();
    const read = async () => {
      const res = await apiRequest(server, '/api/spaces/' + space.id + '/memory');
      assert.equal(res.status, 200);
      return res.json();
    };
    assert.deepEqual(filterMemoryEntries((await read()).entries), []);
    openMemory(path.join(dataDir, 'spaces', space.id, 'memory')).append([
      { type: 'decision', text: 'Use SMS', source: { messages: [1] } },
      { type: 'decision', text: 'Use email', source: { messages: [2] }, supersedes: [1] },
    ]);
    const { entries, writerId } = await read();
    assert.equal(writerId, space.members[0].id);
    assert.deepEqual(filterMemoryEntries(entries, 'decision', 'EMAIL').map((e) => e.id), [2]);
    assert.equal(countMemoryFilters(entries).superseded, 1);
    assert.equal(filterMemoryEntries(entries, 'superseded')[0].by, 2);
  } finally { server.close(); }
});
