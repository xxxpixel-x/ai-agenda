import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const spaceId = '11111111-1111-4111-8111-111111111111';
const space = () => ({
  id: spaceId, kind: 'chat', title: 'Chat', workspacePath: 'work', messages: [],
  members: [{ id: 'm', engine: 'probe', name: 'Member', skills: ['review'] }],
});

// The real modules bind their handlers to the page on import. Each test supplies
// the dynamic children it exercises; replacing innerHTML replaces those nodes.
class Element extends EventTarget {
  dataset = {};
  style = {};
  classList = { toggle() {}, add() {}, remove() {} };
  querySelector() { return null; }
  querySelectorAll() { return []; }
  setAttribute() {}
  prepend() {}
  appendChild() {}
  replaceChildren() { this.innerHTML = ''; }
  focus() { document.activeElement = this; }
}
const elements = new Map();
function element(selector) {
  if (!elements.has(selector)) elements.set(selector, new Element());
  return elements.get(selector);
}
let state, files, tasks, rightbar;
before(async () => {
  globalThis.document = Object.assign(new Element(), {
    documentElement: new Element(), querySelector: element, hasFocus: () => true, createElement: () => new Element(),
  });
  globalThis.window = new EventTarget();
  globalThis.matchMedia = () => ({ matches: true });
  element('#memberPop').hidden = true;
  const fetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ language: 'zh' });
    await import('../public/js/chat.js');
    ({ state } = await import('../public/js/util.js'));
    files = await import('../public/js/files.js');
    tasks = await import('../public/js/tasks.js');
    rightbar = await import('../public/js/rightbar.js');
  } finally { globalThis.fetch = fetch; }
});
after(() => {
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.matchMedia;
});

test('language bootstrap and JSON requests send the desktop token when available', async (t) => {
  const { initLanguage } = await import('../public/i18n.js');
  const { api } = await import('../public/js/util.js');
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, { headers }) => {
    requests.push({ url, headers });
    return Response.json({ language: 'zh' });
  });
  t.after(() => { delete window.desktop; });
  for (const token of ['desktop-token', '']) {
    window.desktop = { apiToken: token };
    await initLanguage();
    await api('/api/settings', { method: 'PUT', body: {} });
    const [bootstrap, settings] = requests.splice(0);
    assert.equal(bootstrap.url, '/api/app');
    assert.equal(bootstrap.headers['X-Agenda-Languages'], navigator.languages.join(','));
    assert.equal(settings.headers['Content-Type'], 'application/json');
    for (const { headers } of [bootstrap, settings]) assert.equal(headers['X-Agenda-Token'], token || undefined);
  }
});

function editorFixture(t) {
  const body = element('#filesBody');
  const nodes = new Map();
  const add = (selector) => {
    const node = new Element();
    nodes.set(selector, node);
    return node;
  };
  Object.defineProperty(body, 'innerHTML', { configurable: true, set(html) {
    nodes.clear();
    if (!html.includes('class="editor"')) return;
    add('.ep');
    add('[data-act=save-file]');
    add('.editor-head').insertAdjacentHTML = () => {
      add('.editor-warn').remove = () => nodes.delete('.editor-warn');
      add('.editor-warn .hint');
    };
    const text = html.match(/<textarea\b[^>]*>(.*?)<\/textarea>/s);
    if (text) add('#editorText').value = text[1];
  } });
  t.after(() => {
    state.space = null;
    files.resetViews();
    rightbar.setRightbarSpace(null);
    delete body.innerHTML;
  });
  t.mock.method(body, 'querySelector', (selector) => nodes.get(selector) || null);
  const writes = [];
  let disk = '';
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (opts.method === 'PUT') {
      const { promise, resolve } = Promise.withResolvers();
      const payload = JSON.parse(opts.body);
      writes.push({ url, payload, finish() { disk = payload.content; resolve(Response.json({})); } });
      return promise;
    }
    if (url.endsWith('/files')) return Response.json({ files: [] });
    if (url.endsWith('/history')) return Response.json([]);
    assert.ok(url.includes('/file?path='), url);
    return Response.json({ content: disk });
  });
  t.mock.method(globalThis, 'setTimeout', () => 1); // Toast expiry.
  state.space = space();
  files.resetViews();
  rightbar.setRightbarSpace(state.space);
  const open = (path, content) => {
    const view = { type: 'file', path, content, draft: content, stale: false };
    files.showView(view);
    return view;
  };
  const textarea = () => body.querySelector('#editorText');
  const type = (value) => {
    textarea().value = value;
    textarea().dispatchEvent(new Event('input'));
  };
  const save = () => textarea().dispatchEvent(Object.assign(new Event('keydown'), { key: 's', ctrlKey: true }));
  return { body, open, textarea, type, save, writes, setDisk(value) { disk = value; } };
}

test('creating a file opens the existing content on conflict without retrying a write', async t => {
  const { textarea } = editorFixture(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push([url, opts.method || 'GET']);
    if (opts.method === 'PUT') {
      assert.deepEqual(JSON.parse(opts.body), { path: 'dir/file.txt', content: '', createOnly: true });
      return Response.json({ error: 'File already exists', conflict: true }, { status: 409 });
    }
    return Response.json({ content: 'existing text' });
  });
  await files.createFile('./dir\\file.txt');
  const route = '/api/spaces/' + spaceId + '/file';
  assert.deepEqual(calls, [[route, 'PUT'], [route + '?path=dir%2Ffile.txt', 'GET']]);
  assert.equal(textarea().value, 'existing text');
});

test('Ctrl+S acknowledges only the submitted text and preserves the focused editor across file-change events', async (t) => {
  const { body, open, textarea, type, save, writes, setDisk } = editorFixture(t);
  const v = open('note.txt', 'original');
  const input = textarea();
  input.focus();
  type('v1');
  setDisk('external change');
  await files.onFilesChanged([{ path: 'note.txt' }]);
  assert.ok(body.querySelector('.editor-warn'));
  assert.equal(textarea(), input);
  save();
  save();
  type('v2');
  input.selectionStart = 1;
  input.selectionEnd = 2;
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, '/api/spaces/' + spaceId + '/file');
  assert.deepEqual(writes[0].payload, { path: 'note.txt', content: 'v1' });
  setDisk('v1');
  await files.onFilesChanged([{ path: 'note.txt' }]);
  writes[0].finish();
  await settle();
  assert.equal(v.content, 'v1');
  assert.equal(v.draft, 'v2');
  assert.equal(v.stale, false);
  assert.equal(body.querySelector('.editor-warn'), null);
  assert.equal(body.querySelector('.ep').textContent, 'note.txt ●');
  assert.equal(body.querySelector('[data-act=save-file]').disabled, false);
  assert.equal(textarea(), input);
  assert.equal(input.value, 'v2');
  assert.deepEqual([input.selectionStart, input.selectionEnd], [1, 2]);

  save();
  writes[1].finish();
  await settle();
  await files.onFilesChanged([{ path: 'note.txt' }]); // This notification arrived after the PUT.
  assert.equal(v.content, 'v2');
  assert.equal(body.querySelector('.ep').textContent, 'note.txt');
  assert.equal(body.querySelector('[data-act=save-file]').disabled, true);
  assert.equal(textarea(), input);
  assert.equal(document.activeElement, input);
});

test('an outstanding save follows its space and path across navigation', async (t) => {
  const { body, open, textarea, type, save, writes } = editorFixture(t);
  for (const destination of ['different file', 'different space', 'reopened file']) {
    state.space = space();
    const old = open('a.txt', 'a');
    type('v1');
    save();
    if (destination === 'different space') state.space = { ...space(), id: 'other' };
    const next = open(destination === 'different file' ? 'b.txt' : 'a.txt', 'b');
    type('my edit');
    const input = textarea();
    writes.at(-1).finish();
    await settle();
    assert.equal(old.content, 'v1');
    assert.deepEqual([next.content, next.draft], [destination === 'reopened file' ? 'v1' : 'b', 'my edit']);
    assert.equal(textarea(), input);
    assert.equal(body.querySelector('.ep').textContent, next.path + ' ●');
  }
});

test('a second explicit save waits for the first write and keeps its own snapshot', async (t) => {
  const { open, type, save, writes } = editorFixture(t);
  const v = open('notes', '');
  type('one'); save();
  type('two'); save(); save();
  type('three');
  assert.equal(writes.length, 1);
  writes[0].finish();
  await settle();
  assert.equal(v.content, 'one');
  assert.deepEqual(writes.map((w) => w.payload.content), ['one', 'two']);
  writes[1].finish();
  await settle();
  assert.deepEqual([v.content, v.draft], ['two', 'three']);
});

test('only running attempts with a numeric start tick, sharing one interval until removal or completion', (t) => {
  let now = 65_000;
  const timers = new Map();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setInterval', (fn, delay) => {
    assert.equal(delay, 10_000);
    const id = Symbol();
    timers.set(id, fn);
    return id;
  });
  t.mock.method(globalThis, 'clearInterval', (id) => timers.delete(id));
  let spans;
  const body = {
    set innerHTML(html) {
      this.html = html;
      spans = [...html.matchAll(/data-attempt-elapsed="([^"]+)">([^<]*)<\/span>/g)]
        .map(([, start, text]) => ({ dataset: { attemptElapsed: start }, textContent: text }));
    },
    querySelector: (s) => s === '[data-attempt-elapsed]' ? spans[0] : null,
  };
  t.mock.method(document, 'querySelectorAll', (s) => s === '[data-attempt-elapsed]' ? spans : []);
  state.space = space();
  const detail = { id: 'T1', title: 'Task', deps: [], status: 'running',
    attempts: [{ startedAt: 1000, endedAt: 3000 }, {}, { startedAt: 7000 }, { startedAt: 70_000 }] };
  const draw = () => tasks.renderTaskDetail(body, { detail });
  draw();
  draw();
  assert.equal(timers.size, 1);
  assert.match(body.html, /<span>2 秒<\/span>/);
  assert.match(body.html, /class="typing"><i><\/i><i><\/i><i><\/i><\/span><span data-attempt-elapsed="7000">58 秒/);
  assert.deepEqual(spans.map((el) => el.textContent), ['0 秒', '58 秒']);
  const originalSpans = spans;
  now += 10_000;
  for (const tick of timers.values()) tick();
  assert.equal(spans, originalSpans);
  assert.deepEqual(spans.map((el) => el.textContent), ['5 秒', '1.1 分钟']);
  body.innerHTML = '';
  for (const tick of timers.values()) tick();
  assert.equal(timers.size, 0);
  draw();
  assert.equal(timers.size, 1);
  detail.attempts = [{ startedAt: 7000, endedAt: now }];
  draw();
  assert.equal(timers.size, 0);
  assert.deepEqual(spans, []);
  assert.match(body.html, /<span>1.1 分钟<\/span>/);
});

const detected = [{ id: 'probe', label: 'Probe CLI', defaultName: 'Probe', kind: 'cli', logo: 'codex',
  skills: false, models: ['probe-model'], status: { ready: true, available: true } }];

test('startup routes on the spaces response and the pending probe updates the open space and popover', async (t) => {
  const engines = Promise.withResolvers();
  const spaces = Promise.withResolvers();
  const requests = [];
  const sp = space();
  globalThis.location = { hash: '#/space/' + sp.id };
  globalThis.EventSource = class { constructor(url) { this.url = url; } close() {} };
  globalThis.MutationObserver = class { observe() {} };
  globalThis.innerWidth = 1024;
  t.after(() => {
    delete globalThis.location; delete globalThis.EventSource; delete globalThis.MutationObserver; delete globalThis.innerWidth;
  });
  t.mock.method(globalThis, 'setInterval', () => 1);
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(url);
    if (url === '/api/engines') return engines.promise;
    if (url === '/api/spaces') return spaces.promise;
    if (url.endsWith('/files')) return Response.json({ files: [] });
    if (url.endsWith('/context')) return Response.json({});
    assert.ok(url.endsWith('/history'), url);
    return Response.json([]);
  });
  state.space = null;
  await import('../public/app.js');
  assert.equal(state.enginesLoaded, false);
  assert.deepEqual(requests, ['/api/engines', '/api/spaces']);
  assert.match(element('#engineSummary').textContent, /正在检测/);
  spaces.resolve(Response.json([sp]));
  await settle();
  assert.equal(state.es?.url, '/api/spaces/' + sp.id + '/events');
  state.es.onmessage({ data: JSON.stringify({ type: 'snapshot', space: sp }) });
  const bar = element('#membersBar');
  assert.match(bar.innerHTML, /Member/);
  assert.doesNotMatch(bar.innerHTML, /不支持 skill\/MCP|has-logo/);
  const chip = { dataset: { id: 'm' }, getBoundingClientRect: () => ({ left: 0, bottom: 20 }) };
  const click = new Event('click');
  Object.defineProperty(click, 'target', { value: { closest: () => chip } });
  bar.dispatchEvent(click);
  const pop = element('#memberPop');
  assert.equal(pop.hidden, false);
  assert.match(pop.innerHTML, /正在检测/);
  assert.doesNotMatch(pop.innerHTML, /暂不支持|还不能用/);

  engines.resolve(Response.json(detected));
  await settle();
  assert.equal(state.enginesLoaded, true);
  assert.match(bar.innerHTML, /<small>不支持 skill\/MCP<\/small>/);
  assert.match(bar.innerHTML, /has-logo/);
  assert.match(pop.innerHTML, /probe-model/);
  assert.doesNotMatch(pop.innerHTML, /正在检测/);
  assert.match(element('#spaceList').innerHTML, /has-logo/);
  assert.equal(element('#engineSummary').innerHTML, '');
});

test('an open connections page updates its pending badges when the first probe settles', async (t) => {
  const engines = Promise.withResolvers();
  const settings = { paths: {}, gemini: {}, providers: [{ id: 'p', name: 'Provider' }], customAcp: [{ id: 'test', name: 'ACP' }] };
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/api/engines') return engines.promise;
    assert.equal(url, '/api/settings');
    return Response.json(settings);
  });
  state.space = null;
  state.enginesLoaded = false;
  state.engines = [];
  const { refreshEngines } = await import('../public/js/engines.js');
  const pending = refreshEngines();
  await import('../public/js/settings/connections.js');
  const { list } = await import('../public/js/slots.js');
  const connections = list('settings').find((s) => s.id === 'connections');
  t.after(() => connections.dispose());
  const panel = new Element();
  await connections.render(panel);
  assert.match(panel.innerHTML, /Provider/);
  assert.match(panel.innerHTML, /正在检测/);
  assert.doesNotMatch(panel.innerHTML, /未安装|不可用/);
  engines.resolve(Response.json(detected));
  await pending;
  assert.match(panel.innerHTML, /Probe CLI/);
  assert.match(panel.innerHTML, /conn-state ok">可用/);
  assert.doesNotMatch(panel.innerHTML, /正在检测/);
});

class AccessGroup extends Element {
  set innerHTML(html) {
    this.html = html;
    this.radios = [...html.matchAll(/<input\b[^>]*name="access"[^>]*>/g)].map(([input]) => ({
      value: input.match(/\bvalue="([^"]+)"/)[1], checked: /\bchecked\b/.test(input),
    }));
  }
  get innerHTML() { return this.html; }
}

function modalFixture(t) {
  const shown = [];
  class Dialog extends Element {
    fields = new Map();
    querySelector(s) {
      if (s === 'input[name=access]:checked') return this.fields.get('#nsAccess')?.radios.find((r) => r.checked) || null;
      if (!this.fields.has(s)) this.fields.set(s, s === '#nsAccess' ? new AccessGroup() : new Element());
      return this.fields.get(s);
    }
    close() { this.open = false; }
    showModal() { this.open = true; shown.push(this); }
    cloneNode() { return new Dialog(); }
    replaceWith(dialog) { elements.set('#modal', dialog); }
  }
  elements.set('#modal', new Dialog());
  t.after(() => elements.delete('#modal'));
  return shown;
}

test('space forms share the initial probe and a dismissed loading dialog stays closed', async (t) => {
  const shown = modalFixture(t);
  const engines = Promise.withResolvers();
  let probes = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/api/engines') { probes++; return engines.promise; }
    assert.equal(url, '/api/library/extensions');
    return Response.json({ skills: [], mcp: [] });
  });
  state.space = space();
  state.engines = [];
  state.enginesLoaded = false;
  const { refreshEngines } = await import('../public/js/engines.js');
  const { openNewSpaceModal, openSpaceSettings } = await import('../public/js/space-form.js');
  const startup = refreshEngines();
  const settings = openSpaceSettings();
  assert.match(element('#modal').innerHTML, /空间设置/);
  element('#modal').querySelector('[data-act=close]').onclick();
  const creation = openNewSpaceModal();
  assert.equal(shown.length, 2);
  for (const dialog of shown) assert.match(dialog.innerHTML, /正在检测 AI 连接/);
  assert.equal(probes, 1);
  engines.resolve(Response.json(detected));
  await Promise.all([startup, settings, creation]);
  assert.equal(shown.length, 3);
  const dialog = element('#modal');
  assert.equal(dialog.open, true);
  assert.match(dialog.innerHTML, /id="nsCreate"/);
  assert.match(dialog.querySelector('#nsMembers').innerHTML, /Probe CLI/);
  assert.doesNotMatch(dialog.querySelector('#nsMembers').innerHTML, /还不能用|未就绪/);
});

function assertAccessGroup(group, kind, selected) {
  const task = kind === 'task';
  assert.deepEqual(group.radios.map((r) => r.value), task ? ['edit', 'run', 'full'] : ['read', 'edit', 'run', 'full']);
  assert.deepEqual(group.radios.filter((r) => r.checked).map((r) => r.value), [selected]);
  const runChoice = group.innerHTML.match(/name="access" value="run"[\s\S]*?<\/label>/)[0];
  const chatCopy = '还能运行命令，每条命令先问你';
  const taskCopy = '支持无人值守命令的引擎可在子任务中直接运行命令。Pi 子任务可用文件工具和只读 MCP。';
  assert.ok(runChoice.includes(task ? taskCopy : chatCopy));
  assert.ok(!runChoice.includes(task ? chatCopy : taskCopy));
}

test('settings for an existing read-only task default to its persisted permission', async () => {
  const { accessChoices } = await import('../public/js/space-form.js');
  const group = new AccessGroup();
  group.innerHTML = accessChoices('read', 'task', { existing: true });
  assert.deepEqual(group.radios.filter(r => r.checked).map(r => r.value), ['read']);
});

test('the new-space form updates permissions on kind changes and when reopening with saved read access', async (t) => {
  modalFixture(t);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, value: { getItem: (key) => key === 'lastAccess' ? JSON.stringify('read') : null },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  });
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/api/engines') return Response.json(detected);
    assert.equal(url, '/api/library/extensions');
    return Response.json({ skills: [], mcp: [] });
  });
  const { openNewSpaceModal } = await import('../public/js/space-form.js');
  await openNewSpaceModal();
  const dialog = element('#modal');
  assert.match(dialog.innerHTML, /id="nsAccess"/);
  const group = dialog.querySelector('#nsAccess');
  const changeKind = (value) => {
    const event = new Event('change');
    Object.defineProperty(event, 'target', { value: { name: 'kind', value } });
    dialog.dispatchEvent(event);
  };
  assertAccessGroup(group, 'chat', 'read');
  changeKind('task');
  assertAccessGroup(group, 'task', 'edit');
  changeKind('chat');
  assertAccessGroup(group, 'chat', 'edit');
  for (const radio of group.radios) radio.checked = radio.value === 'run';
  changeKind('task');
  assertAccessGroup(group, 'task', 'run');
  changeKind('chat');
  assertAccessGroup(group, 'chat', 'run');

  await openNewSpaceModal({ kind: 'task' });
  assertAccessGroup(element('#modal').querySelector('#nsAccess'), 'task', 'edit');
});

test('space settings and CLI member badges describe run access for the current kind', async (t) => {
  await import('../public/js/space-tabs.js');
  const { list } = await import('../public/js/slots.js');
  const { renderMembersBar } = await import('../public/js/chat.js');
  const general = list('spaceTabs').find((tab) => tab.id === 'general');
  const previous = { engines: state.engines, space: state.space };
  t.after(() => Object.assign(state, previous));
  state.engines = detected;
  for (const kind of ['chat', 'task']) {
    state.space = { ...space(), kind, access: 'run' };
    const panel = new AccessGroup();
    general.render(panel, { space: state.space, onSave() {} });
    assertAccessGroup(panel, kind, 'run');
    renderMembersBar();
    assert.equal(element('#membersBar').innerHTML.includes('不能运行命令'), kind === 'chat');
  }
});

test('scheduling a task from chat displays and submits the task template permissions', async (t) => {
  await import('../public/js/schedules.js');
  const { list } = await import('../public/js/slots.js');
  const tab = list('spaceTabs').find((entry) => entry.id === 'schedules');
  class SchedulePanel extends Element {
    fields = new Map();
    querySelector(selector) {
      if (!this.fields.has(selector)) this.fields.set(selector, new SchedulePanel());
      return this.fields.get(selector);
    }
    replaceChildren(child) { this.firstChild = child; }
  }
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  t.after(() => { tab.dispose(); delete globalThis.MutationObserver; });
  t.mock.method(document, 'createElement', (tag) => {
    assert.equal(tag, 'form');
    const form = new SchedulePanel();
    form.elements = { at: { value: '2035-01-01T09:00' }, amount: new Element(), message: { value: '' }, goal: { value: 'Draft notes' } };
    return form;
  });
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (opts.method === 'POST') {
      assert.equal(url, '/api/schedules');
      writes.push(JSON.parse(opts.body));
      return Response.json({});
    }
    assert.equal(url, '/api/schedules?spaceId=' + spaceId);
    return Response.json([]);
  });
  for (const [sourceAccess, taskAccess, description] of [
    ['read', 'edit', '可以阅读和修改文件'], ['run', 'run', 'Pi 子任务可用文件工具和只读 MCP'],
  ]) {
    const panel = new SchedulePanel();
    panel.hidden = true; // Keep the live schedule feed closed while exercising the editor.
    tab.render(panel, { space: { ...space(), access: sourceAccess } });
    panel.querySelector('.schedule-add').onclick();
    const form = panel.querySelector('[data-editor]').firstChild;
    const taskButton = { dataset: { segment: 'action' }, value: 'task', hasAttribute: () => false };
    form.onclick({ target: { closest: () => taskButton } });
    assert.ok(form.innerHTML.includes(description));
    form.onsubmit({ preventDefault() {} });
    await settle();
    const [saved] = writes.splice(0);
    assert.equal(saved.spaceId, spaceId);
    assert.equal(saved.action.type, 'task');
    assert.equal(saved.action.template.access, taskAccess);
  }
});
