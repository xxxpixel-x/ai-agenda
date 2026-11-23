import { MEMORY_FILTERS, MEMORY_FILTER_LABELS, MEMORY_TYPE_LABELS, countMemoryFilters,
  filterMemoryEntries, formatMemoryOrigin, formatMemorySources } from './context-memory-format.js';
import { enterPanel } from './files.js';
import { mountParticles } from './particles.js';
import { currentPanel, setPanelBadge, showPanel, toggleRightbar } from './rightbar.js';
import { register } from './slots.js';
import { $, ICON, api, esc, mascot, state, toast, tr } from './util.js';

const pill = (label, cls = '') => `<span class="mem-pill ${cls}">${esc(label)}</span>`;
const jump = (label, id) => `<button type="button" class="mem-pill" data-memory-jump="${esc(id)}">${esc(label)}</button>`;
const tags = (items) => Array.isArray(items) ? items.filter(Boolean) : [];
const metaRow = (label, contents) => contents ? `<div class="mem-meta"><span>${esc(label)}</span><div>${contents}</div></div>` : '';

function actionBarHtml(e, editing) {
  if ((e.status ?? 'active') !== 'active' || state.space?.run?.closed) return '';
  const btns = [];
  if (e.type === 'disagreement' || e.type === 'proposal') {
    btns.push(`<button type="button" class="btn sm primary" data-mem-action="accept" data-id="${esc(e.id)}">${tr('采纳')}</button>`);
    btns.push(`<button type="button" class="btn sm" data-mem-action="reject" data-id="${esc(e.id)}">${tr('驳回')}</button>`);
  } else if (e.type === 'question') {
    btns.push(`<button type="button" class="btn sm primary" data-mem-action="answer" data-id="${esc(e.id)}">${tr('回答')}</button>`);
  }
  if (e.type !== 'result') btns.push(`<button type="button" class="btn sm" data-mem-action="edit" data-id="${esc(e.id)}">${tr('修改')}</button>`);
  btns.push(`<button type="button" class="btn sm" data-mem-action="retract" data-id="${esc(e.id)}">${tr('作废')}</button>`);
  let form = '';
  if (editing?.id === e.id) {
    if (editing.mode === 'retract') {
      const warn = e.supersedes?.length ? `<p class="mem-warn">${tr('撤回不会自动恢复旧条目，如需恢复请另行确认。')}</p>` : '';
      form = `<div class="mem-form">${warn}<div class="mem-form-bar">
        <button type="button" class="btn sm primary" data-mem-submit="retract" data-id="${esc(e.id)}">${tr('确认作废')}</button>
        <button type="button" class="btn sm" data-mem-cancel>${tr('取消')}</button></div></div>`;
    } else if (editing.mode === 'answer') {
      form = `<div class="mem-form">
        <textarea class="mem-input" data-mem-field="text" rows="2" placeholder="${tr('写下这条问题的结论或答案…')}"></textarea>
        <input class="mem-input" data-mem-field="reason" type="text" placeholder="${tr('原因（可选）')}">
        <div class="mem-form-bar">
          <select class="mem-select" data-mem-field="type"><option value="decision">${tr('记为决定')}</option><option value="fact">${tr('记为项目事实')}</option></select>
          <button type="button" class="btn sm primary" data-mem-submit="answer" data-id="${esc(e.id)}">${tr('提交回答')}</button>
          <button type="button" class="btn sm" data-mem-cancel>${tr('取消')}</button>
        </div></div>`;
    } else if (editing.mode === 'edit') {
      form = `<div class="mem-form">
        <textarea class="mem-input" data-mem-field="text" rows="2">${esc(e.text)}</textarea>
        <input class="mem-input" data-mem-field="reason" type="text" value="${esc(e.reason || '')}" placeholder="${tr('原因（可选）')}">
        <div class="mem-form-bar">
          <button type="button" class="btn sm primary" data-mem-submit="edit" data-id="${esc(e.id)}">${tr('保存修改')}</button>
          <button type="button" class="btn sm" data-mem-cancel>${tr('取消')}</button>
        </div></div>`;
    }
  }
  return `<div class="mem-actions">${btns.join('')}</div>${form}`;
}

// The compact preview and the library use the same entry details.
export function memoryEntryHtml(e, preview = false, editing = null) {
  const origin = formatMemoryOrigin(e, tr);
  const inactive = ['superseded', 'resolved', 'retracted'].includes(e.status);
  const type = Object.hasOwn(MEMORY_TYPE_LABELS, e.type) ? e.type : 'fact';
  const by = Number(String(e.by ?? '').replace(/^#/, ''));
  let status = preview ? pill(tr('有效')) : '';
  if (inactive) {
    if (e.status === 'retracted') status = pill(by > 0 ? tr('已被 #{0} 撤回', [by]) : tr('已撤回'));
    else {
      const label = e.status === 'resolved' ? tr('已解决') : tr('已取代');
      status = by > 0 ? jump(e.status === 'resolved' ? tr('已解决：#{0}', [by]) : tr('已被 #{0} 取代', [by]), by) : pill(label);
    }
  }
  const sources = formatMemorySources(e.source, tr).map((s) => {
    if (s.kind === 'message') return `<button type="button" class="mem-pill" data-message-seq="${esc(s.seq)}">${esc(s.label)}</button>`;
    return pill(s.kind === 'file' ? tr('文件 {0}', [s.file]) : s.label);
  });
  const imported = new Date(e.importedAt);
  if (e.importedAt != null && Number.isFinite(imported.getTime())) sources.push(pill(tr('导入于 {0}', [imported.toISOString().slice(0, 10)])));
  return `<article class="mem-entry type-${type}${inactive ? ' inactive' : ''}" data-entry-id="${esc(e.id)}" tabindex="-1">
    <header><b class="mem-id">#${esc(e.id)}</b>${pill(tr(MEMORY_TYPE_LABELS[type]), 'mem-type')}
      ${origin ? pill(origin.label, 'origin-' + origin.kind) : ''}${e.ask && !inactive ? pill(tr('待你确认'), 'ask') : ''}${status}</header>
    <p class="mem-text">${esc(e.text)}</p>
    ${e.reason ? `<p class="mem-reason"><b>${tr('原因')}</b> ${esc(e.reason)}</p>` : ''}
    ${metaRow(tr('出处'), sources.join(''))}
    ${metaRow(tr('相关'), tags(e.related).map((id) => jump('#' + id, id)).join(''))}
    ${metaRow(tr('主题'), tags(e.topics).map((topic) => pill(topic)).join(''))}
    ${metaRow(tr('文件'), tags(e.files).map((file) => pill(file)).join(''))}
    ${preview ? '' : actionBarHtml(e, editing)}
  </article>`;
}

function reveal(el, cls) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
  for (const animation of el.getAnimations()) animation.cancel();
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 1400);
}

export function revealMemorySource(seq) {
  const msg = $(`#messages [data-seq="${CSS.escape(String(seq))}"]`);
  if (!msg) { toast(tr('这条消息不在当前视图中')); return; }
  if (matchMedia('(max-width: 760px)').matches) toggleRightbar(false);
  msg.tabIndex = -1;
  reveal(msg, 'msg-flash');
}

let view = null;
let pendingFocusId = null;
let timer;
let heroFx, emptyFx;

function syncMemoryBadge(data) {
  const askCount = typeof data?.askCount === 'number'
    ? data.askCount
    : (data?.entries || []).filter((e) => (e.status ?? 'active') === 'active' && e.ask === true).length;
  setPanelBadge('memory', askCount > 0 ? 'dot' : null);
}

function applyFocus() {
  if (pendingFocusId == null || !view?.data) return;
  const id = pendingFocusId;
  pendingFocusId = null;
  if (!view.data.entries.some((e) => e.id === id)) { toast(tr('找不到这条记忆')); return; }
  const selector = `[data-entry-id="${id}"]`;
  if (!$(selector, view.root)) {
    view.filter = 'all';
    view.search.value = '';
    renderResults();
  }
  const card = $(selector, view.root);
  if (card) reveal(card, 'flash');
}

export function focusMemoryEntry(entryId) {
  const id = Number(entryId);
  if (!Number.isSafeInteger(id) || id < 1 || !state.space) return;
  if (currentPanel() !== 'memory' && !showPanel('memory')) return;
  pendingFocusId = id;
  applyFocus();
}

function renderResults() {
  const { root, data, filter, search, editing } = view;
  const counts = countMemoryFilters(data?.entries);
  for (const btn of root.querySelectorAll('[data-memory-filter]')) {
    btn.setAttribute('aria-pressed', String(filter === btn.dataset.memoryFilter));
    $('.count', btn).textContent = counts[btn.dataset.memoryFilter];
  }
  emptyFx?.stop();
  emptyFx = null;
  const list = $('.mem-list', root);
  if (!data) { list.textContent = view.failed ? tr('暂时无法读取记忆库') : tr('加载中…'); return; }
  if (!counts.all) {
    list.innerHTML = `<div class="mem-empty"><div class="mem-empty-art">${mascot('empty', 40)}</div>
      <b>${tr('还没有整理出记忆条目')}</b><p>${tr('讨论或完成任务后，达成的决定、约束和结论会整理到这里')}</p></div>`;
    emptyFx = mountParticles($('.mem-empty-art', list), { mode: 'ambient' });
    return;
  }
  const entries = filterMemoryEntries(data.entries, filter, search.value);
  list.innerHTML = entries.length ? entries.map((e) => memoryEntryHtml(e, false, editing)).join('')
    : `<div class="mem-empty">${tr('没有符合条件的条目')}<button type="button" class="btn sm" data-memory-reset>${tr('显示全部')}</button></div>`;
}

function updateStats(pane) {
  const data = pane.data;
  const writer = state.space?.members?.find((m) => m.id === data?.writerId);
  const writerLabel = writer ? writer.name : (data?.writerSource === 'global' ? tr('全局整理模型') : '');
  $('.mem-stats', pane.root).innerHTML = `<b>${esc(tr('{0} 条有效共识', [data.entries.filter((e) => (e.status ?? 'active') === 'active').length]))}</b>
    ${writerLabel ? pill(tr('由 {0} 整理', [writerLabel])) : ''}${data?.organizing ? pill(tr('整理中…'), 'organizing') : ''}
    ${data?.organizerError ? `<p class="mem-warn">${esc(data.organizerError)}</p>` : ''}`;
  const orgBtn = $('[data-memory-organize]', pane.root);
  if (orgBtn) orgBtn.disabled = !!data?.organizing || !!state.space?.run?.closed;
}

async function refresh() {
  clearTimeout(timer);
  timer = null;
  const pane = view;
  if (!pane) return;
  const request = ++pane.request;
  try {
    const data = await api(`/api/spaces/${pane.id}/memory`);
    if (view !== pane || request !== pane.request) return;
    pane.data = { ...data, entries: Array.isArray(data?.entries) ? data.entries.filter((e) => e && typeof e === 'object') : [] };
    syncMemoryBadge(pane.data);
    updateStats(pane);
    if (data?.organizing && !timer) timer = setTimeout(refresh, 2000);
  } catch {
    if (view !== pane || request !== pane.request) return;
    pane.failed = true;
  }
  renderResults();
  applyFocus();
}

async function triggerOrganize() {
  const pane = view;
  if (!pane) return;
  try {
    const res = await api(`/api/spaces/${pane.id}/memory/organize`, { method: 'POST', body: {} });
    if (view !== pane) return;
    if (res?.memory) {
      pane.data = { ...res.memory, entries: Array.isArray(res.memory.entries) ? res.memory.entries : [] };
      syncMemoryBadge(pane.data);
      updateStats(pane);
      renderResults();
    }
    toast(tr('已开始整理记忆库'));
    if (res?.organizing && !timer) timer = setTimeout(refresh, 2000);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function submitAction(id, action, payload = {}) {
  const pane = view;
  if (!pane) return;
  try {
    const res = await api(`/api/spaces/${pane.id}/memory/entries/${encodeURIComponent(id)}/action`, {
      method: 'POST',
      body: { action, ...payload },
    });
    if (view !== pane) return;
    pane.editing = null;
    if (res?.memory) {
      pane.data = { ...res.memory, entries: Array.isArray(res.memory.entries) ? res.memory.entries : [] };
      syncMemoryBadge(pane.data);
      updateStats(pane);
      renderResults();
    } else {
      await refresh();
    }
    toast(tr('已更新记忆库'));
  } catch (e) {
    toast(e.message, 'error');
    if (e.status === 409) { pane.editing = null; refresh(); }
  }
}

function renderMemoryPane(body, { space }) {
  enterPanel('memory');
  if (view?.id === space.id) return;
  disposeMemoryPane();
  body.innerHTML = `<section class="mem-pane"><header class="mem-hero">
    <div class="mem-hero-art" aria-hidden="true"></div><div class="mem-hero-title"><h2>${tr('空间记忆库')}</h2>
    <div class="mem-hero-actions">
      <button type="button" class="btn sm" data-memory-organize>${tr('立即整理')}</button>
      <button type="button" class="icon-btn" data-memory-refresh title="${tr('刷新')}" aria-label="${tr('刷新')}">${ICON.refresh}</button>
    </div></div>
    <div class="mem-stats"></div></header>
    <div class="mem-filters">${MEMORY_FILTERS.map((f) => `<button type="button" data-memory-filter="${f}">${esc(tr(MEMORY_FILTER_LABELS[f]))} <span class="count"></span></button>`).join('')}</div>
    <input class="mem-search" type="search" placeholder="${tr('搜索编号、内容或主题…')}" aria-label="${tr('搜索编号、内容或主题…')}">
    <div class="mem-list"></div></section>`;
  const root = body.firstElementChild;
  const search = $('.mem-search', root);
  view = { id: space.id, root, search, filter: 'all', data: null, editing: null, request: 0 };
  heroFx = mountParticles($('.mem-hero-art', root), { mode: 'ambient' });
  search.oninput = renderResults;
  root.onclick = ({ target }) => {
    const btn = target.closest('button');
    if (!btn || btn.disabled) return;
    const d = btn.dataset;
    if (d.memoryJump) focusMemoryEntry(d.memoryJump);
    else if (d.messageSeq) revealMemorySource(d.messageSeq);
    else if (btn.hasAttribute('data-memory-refresh')) refresh();
    else if (btn.hasAttribute('data-memory-organize')) triggerOrganize();
    else if (btn.hasAttribute('data-mem-cancel')) { view.editing = null; renderResults(); }
    else if (d.memAction) {
      const id = Number(d.id);
      if (d.memAction === 'accept' || d.memAction === 'reject') submitAction(id, d.memAction);
      else { view.editing = { id, mode: d.memAction }; renderResults(); }
    } else if (d.memSubmit) {
      const id = Number(d.id);
      const card = btn.closest('.mem-entry');
      const payload = {};
      if (card) {
        const textEl = $('[data-mem-field="text"]', card);
        const reasonEl = $('[data-mem-field="reason"]', card);
        const typeEl = $('[data-mem-field="type"]', card);
        if (textEl) payload.text = textEl.value;
        if (reasonEl) payload.reason = reasonEl.value;
        if (typeEl) payload.type = typeEl.value;
      }
      submitAction(id, d.memSubmit, payload);
    } else if (d.memoryFilter || btn.hasAttribute('data-memory-reset')) {
      view.filter = d.memoryFilter || 'all';
      if (!d.memoryFilter) { search.value = ''; search.focus(); }
      renderResults();
    }
  };
  renderResults();
  refresh();
}

function disposeMemoryPane() {
  clearTimeout(timer);
  heroFx?.stop();
  emptyFx?.stop();
  heroFx = emptyFx = view = pendingFocusId = null;
}

window.addEventListener('agenda:space-event', ({ detail }) => {
  if (!detail?.space?.id) return;
  if (detail.type === 'memory_changed') {
    if (view && currentPanel() === 'memory' && detail.space.id === view.id) {
      clearTimeout(timer);
      timer = setTimeout(refresh, 100);
    } else if (state.space?.id === detail.space.id) {
      api(`/api/spaces/${detail.space.id}/memory`).then(syncMemoryBadge).catch(() => {});
    }
    return;
  }
  if (!view || currentPanel() !== 'memory' || detail.space.id !== view.id || !['message_done', 'snapshot', 'run'].includes(detail.type)) return;
  clearTimeout(timer);
  timer = setTimeout(refresh, 200);
});

register('panels', { id: 'memory', label: tr('记忆库'), icon: ICON.memory, order: 50, render: renderMemoryPane, dispose: disposeMemoryPane });
