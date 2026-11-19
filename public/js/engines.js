// 引擎：AI 列表与可用状态、欢迎页的连接提示、通用弹窗
import { $, api, esc, markHtml, shownEngines, state, toast, tr } from './util.js';

// ---------------- 引擎 / 设置 ----------------
export async function refreshEngines(refresh = false) {
  try { state.engines = await api(`/api/engines${refresh ? '?refresh=1' : ''}`); } catch (e) { toast(e.message, 'error'); }
  renderEngineDots();
  renderWelcome();
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

