// 侧栏与主题
import { openEnginesModal } from './engines.js';
import { openDeleteSpaceModal, openNewSpaceModal } from './space-form.js';
import { $, ICON, api, esc, load, relTime, state, store, toast, tr } from './util.js';

// ---------------- 侧栏 ----------------
export async function refreshSpaces() {
  try { state.spaces = await api('/api/spaces'); } catch { /* ignore */ }
  renderSpaceList();
}
let spacesTimer = null;
export const refreshSpacesSoon = () => { clearTimeout(spacesTimer); spacesTimer = setTimeout(refreshSpaces, 800); };
// 去掉 Markdown 符号，只留文字（用于一行预览）
const plain = (s) => String(s)
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/(\*\*|__)(.+?)\1/g, '$2')
  .replace(/\*([^*\n]+)\*/g, '$1')
  .replace(/`/g, '')
  .replace(/(^|[：:\s])#{1,6}\s+/g, '$1')
  .replace(/^\s*(#{1,6}|>|[-*•]|\d+[.)、])\s*/gm, '')
  .replace(/\s+/g, ' ')
  .trim();
export function renderSpaceList() {
  const list = $('#spaceList');
  if (!state.spaces.length) { list.innerHTML = `<div class="empty-list">${tr('还没有空间')}</div>`; return; }
  // 右上角：需要你的事优先（等你确认 > 任务等你），否则显示最后一条消息的时间
  const side = (s) => (s.waiting ? `<b class="tag">${tr('等你确认')}</b>`
    : s.needsYou ? `<b class="tag">${tr('等你处理')}</b>`
      : `<span class="when">${relTime(s.lastAt || s.updatedAt)}</span>`);
  // 图标区分两类空间；正在干活的空间图标旁有一个小点，结束了的任务空间变淡
  const kindTitle = (s) => (s.kind === 'task' ? (s.finished ? tr('任务空间（已结束）') : tr('任务空间')) : s.readOnly ? tr('聊天空间（文件暂时只读）') : tr('聊天空间'));
  list.innerHTML = state.spaces.map((s) => `
    <a class="space-item ${s.id === state.space?.id ? 'active' : ''} ${s.finished ? 'finished' : ''}" href="#/space/${s.id}" data-space-id="${s.id}">
      <span class="si-icon ${s.running ? 'live' : ''}" title="${kindTitle(s)}">${ICON[s.kind === 'task' ? 'task' : 'chat']}</span>
      <span class="si-body">
        <span class="t"><span class="title">${esc(s.title)}</span>${side(s)}</span>
        <span class="p">${s.finished ? tr('已结束 · ') : ''}${s.preview ? esc(plain(s.preview)) : tr('还没有消息')}</span>
      </span>
    </a>`).join('');
}
function hideSpaceMenu() { $('#spaceMenu').hidden = true; }
function openSpaceMenu(item, x, y) {
  const menu = $('#spaceMenu');
  menu.dataset.spaceId = item.dataset.spaceId;
  menu.hidden = false;
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
  $('button', menu).focus();
}
$('#spaceList').addEventListener('contextmenu', (e) => {
  const item = e.target.closest('[data-space-id]');
  if (!item) return;
  e.preventDefault();
  openSpaceMenu(item, e.clientX, e.clientY);
});
$('#spaceList').addEventListener('keydown', (e) => {
  const item = e.target.closest('[data-space-id]');
  if (!item || !(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return;
  e.preventDefault();
  const rect = item.getBoundingClientRect();
  openSpaceMenu(item, rect.left + 12, rect.bottom);
});
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#spaceMenu')) hideSpaceMenu(); });
document.addEventListener('keydown', (e) => {
  const menu = $('#spaceMenu');
  if (menu.hidden || !['Escape', 'Tab'].includes(e.key)) return;
  hideSpaceMenu();
  $(`#spaceList [data-space-id="${menu.dataset.spaceId}"]`)?.focus();
  if (e.key === 'Escape') e.preventDefault();
});
window.addEventListener('resize', hideSpaceMenu);
window.addEventListener('blur', hideSpaceMenu);
document.addEventListener('scroll', hideSpaceMenu, true);
$('#spaceMenu').addEventListener('click', async (e) => {
  if (!e.target.closest('button')) return;
  const id = $('#spaceMenu').dataset.spaceId;
  hideSpaceMenu();
  try {
    const sp = state.space?.id === id ? state.space : await api(`/api/spaces/${id}`);
    openDeleteSpaceModal(sp);
  } catch (err) { toast(err.message, 'error'); }
});
$('#newSpaceBtn').addEventListener('click', () => openNewSpaceModal());
$('#enginesBtn').addEventListener('click', openEnginesModal);

// ---------------- 主题：跟随系统 → 浅色 → 深色 ----------------
const THEMES = { system: tr('跟随系统'), light: tr('浅色'), dark: tr('深色') };
export let theme = 'system';
export function applyTheme(t) {
  theme = THEMES[t] ? t : 'system';
  // 桌面版连窗口一起换，页面配色自动跟着走；浏览器里用 data-theme 盖过系统设置
  if (window.desktop?.setTheme) window.desktop.setTheme(theme);
  else {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    store('rt:theme', theme);
  }
  const b = $('#themeBtn');
  b.innerHTML = ICON[theme];
  b.title = tr('主题：{0}', [THEMES[theme]]);
  b.setAttribute('aria-label', b.title);
}
$('#themeBtn').addEventListener('click', () => {
  const order = Object.keys(THEMES);
  applyTheme(order[(order.indexOf(theme) + 1) % order.length]);
});
for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = ICON[el.dataset.icon] || '';
$('#welcomeView').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act=new]');
  if (b) openNewSpaceModal({ kind: b.dataset.kind });
  else if (e.target.closest('.engine-card')) openEnginesModal();
});
// 折叠侧栏：按钮或 Ctrl/⌘+B，记住上次的状态
const sideKey = `${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'}+B`;
for (const [id, label] of [['#sideCollapseBtn', '收起侧栏'], ['#sideExpandBtn', '展开侧栏']]) {
  $(id).title = `${tr(label)} (${sideKey})`;
  $(id).setAttribute('aria-label', tr(label));
}
function setSideCollapsed(on, focus = false) {
  $('#app').classList.toggle('side-collapsed', on);
  store('sideCollapsed', on);
  if (focus) $(on ? '#sideExpandBtn' : '#sideCollapseBtn').focus();
}
setSideCollapsed(!!load('sideCollapsed'));
$('#sideCollapseBtn').addEventListener('click', () => setSideCollapsed(true, true));
$('#sideExpandBtn').addEventListener('click', () => setSideCollapsed(false, true));
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'b' || innerWidth <= 760 || $('#modal').open) return;
  e.preventDefault();
  setSideCollapsed(!$('#app').classList.contains('side-collapsed'));
});
$('#menuBtn').addEventListener('click', () => $('#app').classList.add('nav-open'));
$('#scrim').addEventListener('click', () => $('#app').classList.remove('nav-open'));
$('#sidebar').addEventListener('click', (e) => { if (e.target.closest('a, button')) $('#app').classList.remove('nav-open'); });

