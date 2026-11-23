// 引擎：AI 列表与可用状态、欢迎页的连接提示、通用弹窗
import { $, ICON, api, esc, markHtml, shownEngines, state, toast, tr } from './util.js';

// ---------------- 引擎 / 设置 ----------------
const listeners = new Set();
export function onEnginesChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
let pending = null;
export function refreshEngines(refresh = false) {
  if (pending) return refresh ? pending.then(() => refreshEngines(true)) : pending;
  if (!state.enginesLoaded) renderWelcome();
  pending = api(`/api/engines${refresh ? '?refresh=1' : ''}`).then(
    (engines) => { state.engines = engines; },
    (e) => toast(e.message, 'error'),
  ).finally(() => {
    pending = null;
    state.enginesLoaded = true;
    renderEngineDots();
    renderWelcome();
    for (const fn of listeners) fn();
  });
  return pending;
}
function engineBadge(e) {
  const s = e.status || {};
  if (s.ready) return `<span class="badge ok">${tr('可用')}</span>`;
  if (s.available) return `<span class="badge warn">${tr('待设置')}</span>`;
  return `<span class="badge off">${tr('未安装')}</span>`;
}
function renderEngineDots() {
  $('#engineDots').innerHTML = shownEngines().map((e) => `<i class="${e.status?.ready ? 'ready' : e.status?.available ? 'warn' : ''}" title="${esc(e.label)}"></i>`).join('');
}
function renderWelcome() {
  if (!state.enginesLoaded) {
    $('#engineSummary').textContent = tr('正在检测 AI 连接…');
    return;
  }
  const none = !state.engines.some((e) => e.status?.ready);
  $('#engineSummary').innerHTML = !none ? '' : shownEngines().map((e) => `
    <div class="engine-card"><div class="n">${markHtml(e.id, e.color)}${esc(e.label)} ${engineBadge(e)}</div>
    <div class="s">${esc(e.status?.note || '')}</div></div>`).join('');
}

export function showModal(html) {
  const dlg = $('#modal');
  dlg.close();
  const fresh = dlg.cloneNode(false); // 去掉旧的事件监听
  dlg.replaceWith(fresh);
  fresh.innerHTML = html;
  fresh.showModal();
  fresh.addEventListener('cancel', () => fresh.close());
  return fresh;
}

/** 首次探测期间让用户看到并能关闭正在打开的表单。关闭或替换后不再打开它。 */
export async function refreshEnginesForDialog(title) {
  const loading = !state.enginesLoaded && showModal(`<div class="modal-inner">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" type="button" data-act="close" aria-label="${tr('关闭')}">${ICON.close}</button></div>
    <div class="modal-body hint" role="status">${tr('正在检测 AI 连接…')}</div></div>`);
  if (loading) $('[data-act=close]', loading).onclick = () => loading.close();
  await refreshEngines();
  if (loading && !loading.open) return false;
  if (loading) loading.close();
  return true;
}

