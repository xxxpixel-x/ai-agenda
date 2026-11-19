// 右侧栏：顶部切换面板，一次看一个，能收起。面板由各自的模块注册到 slots 的 panels，
// 当前空间用不上的面板（when 不通过）不显示。收起状态和上次看的面板记在本机（按空间类型分开记）。
// 只依赖 slots 和 util，不知道面板里是什么。
import { list, onSlotsChange } from './slots.js';
import { $, ICON, esc, load, store, tr } from './util.js';

const KEY = 'rt:rightbar';
const saved = load(KEY) || {};
let open = saved.open ?? load('rt:filesOpen') ?? true;   // rt:filesOpen：旧版文件面板的开关
const lastPanel = { chat: 'files', task: 'plan', ...(saved.panels || {}) };
let space = null;
let active = null;          // 正在显示的面板定义
const badges = new Map();   // 面板 id -> 数字 / 'dot'
const listeners = new Set();

const persist = () => store(KEY, { open, panels: lastPanel });
const kindOf = (sp) => (sp?.kind === 'task' ? 'task' : 'chat');
const panels = () => (space ? list('panels', { space }) : []);
const emit = () => { for (const fn of listeners) fn(); };

/** 右侧栏现在是不是展开着（有空间、有面板、没收起）。 */
export const rightbarOpen = () => open && !!space && panels().length > 0;
export const currentPanel = () => (rightbarOpen() ? active?.id || null : null);
/** 收起时也要提醒的事：有面板挂着 'dot'。 */
export const rightbarAlert = () => panels().some((d) => badges.get(d.id) === 'dot');
export const onRightbarChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/** 换空间（null 表示离开空间：收起并清空）。 */
export function setRightbarSpace(sp) {
  if (sp?.id !== space?.id) badges.clear();
  space = sp || null;
  renderRightbar();
}

/** 切到某个面板（收起的话先展开）。这个空间没有这个面板时返回 false。 */
export function showPanel(id) {
  if (!panels().some((d) => d.id === id)) return false;
  lastPanel[kindOf(space)] = id;
  open = true;
  persist();
  renderRightbar();
  return true;
}

export function toggleRightbar(force) {
  open = force ?? !open;
  persist();
  renderRightbar();
}

/** 面板标签上的小标记：数字（例如改动条数）或 'dot'（等你处理）；null 去掉。 */
export function setPanelBadge(id, value) {
  const before = badges.get(id) ?? null;
  if (value === null || value === undefined || value === '' || value === 0) badges.delete(id); else badges.set(id, value);
  if ((badges.get(id) ?? null) !== before) { renderTabs(); emit(); }
}

function dispose() {
  try { active?.dispose?.(); } catch (e) { console.error(e); }
}

function renderTabs() {
  const defs = panels();
  $('#rbTabs').innerHTML = defs.map((d) => {
    const b = badges.get(d.id);
    const mark = b === 'dot' ? '<i class="rb-dot" aria-hidden="true"></i>' : b ? `<span class="rb-count">${esc(b)}</span>` : '';
    const on = d === active;
    return `<button class="rb-tab ${on ? 'active' : ''}" type="button" role="tab" aria-selected="${on}" data-panel="${esc(d.id)}">${esc(d.label)}${mark}</button>`;
  }).join('');
}

/** 整个右侧栏重画：标签和当前面板。 */
export function renderRightbar() {
  const aside = $('#rightbar');
  const defs = panels();
  const show = open && !!space && defs.length > 0;
  aside.hidden = !show;
  if (!show) {
    dispose();
    active = null;
    $('#filesBody').innerHTML = '';
    emit();
    return;
  }
  const want = defs.find((d) => d.id === lastPanel[kindOf(space)]) || defs[0];
  if (want !== active) { dispose(); active = want; }
  renderTabs();
  renderPanelBody();
  emit();
}

/** 只重画当前面板的内容。 */
export function renderPanelBody() {
  if (!active || !rightbarOpen()) return;
  try { active.render($('#filesBody'), { space }); } catch (e) { console.error(e); }
}

$('#rbTabs').addEventListener('click', (e) => {
  const t = e.target.closest('[data-panel]');
  if (t) showPanel(t.dataset.panel);
});
$('#rbTabs').addEventListener('keydown', (e) => {
  const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
  if (!step) return;
  const tabs = [...$('#rbTabs').children];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const next = tabs[(i + step + tabs.length) % tabs.length];
  showPanel(next.dataset.panel);
  $(`[data-panel="${CSS.escape(next.dataset.panel)}"]`, $('#rbTabs'))?.focus();
});
$('#rbClose').addEventListener('click', () => toggleRightbar(false));
$('#rbClose').title = tr('收起侧栏');
$('#rbClose').setAttribute('aria-label', tr('收起侧栏'));
$('#rbClose').innerHTML = ICON.close;
onSlotsChange((slot) => { if (slot === 'panels') renderRightbar(); });
