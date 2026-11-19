// 整页视图：左边分类、右边内容。全局设置和资源库用它，分类由各自的模块注册到 slots。
// 路由 #/settings/<id>、#/library/<id>；一个分类都没注册的页面不显示入口。
import { list, onSlotsChange } from './slots.js';
import { $, ICON, esc, tr } from './util.js';

const TITLES = { settings: '设置', library: '资源库' };
const TONES = ['sky', 'mint', 'pink', 'butter']; // 分类图标块的颜色，按顺序轮流
let current = null;       // { page, def }
let returnHash = '#/';    // 关掉整页时回到哪里

export const pageRoute = (hash) => {
  const m = String(hash).match(/^#\/(settings|library)(?:\/([\w-]+))?\/?$/);
  return m ? { page: m[1], id: m[2] || '' } : null;
};
export const hasPage = (page) => list(page, {}).length > 0;
export const currentPage = () => current?.page || null;

export function openPage(page, sectionId) {
  location.hash = `#/${page}${sectionId ? `/${sectionId}` : ''}`;
}
/** 离开整页时回到的地址（路由每次进空间或欢迎页时更新）。 */
export function setReturnHash(hash) { returnHash = hash || '#/'; }
export function closePage() { location.hash = returnHash; }

function dispose() {
  try { current?.def?.dispose?.(); } catch (e) { console.error(e); }
}

/** 显示整页；这个页面一个分类都没有时返回 false。 */
export function showPage(page, sectionId) {
  const sections = list(page, { page });
  if (!sections.length) return false;
  const def = sections.find((d) => d.id === sectionId) || sections[0];
  if (def.id !== sectionId) { history.replaceState(null, '', `#/${page}/${def.id}`); }
  dispose();
  current = { page, def };
  const view = $('#pageView');
  view.hidden = false;
  view.innerHTML = `<div class="page-shell">
    <nav class="page-nav" aria-label="${esc(tr(TITLES[page]))}">
      <h2 class="page-nav-title">${esc(tr(TITLES[page]))}</h2>
      ${sections.map((d, i) => `<a class="page-link ${d === def ? 'active' : ''}" href="#/${page}/${d.id}" ${d === def ? 'aria-current="page"' : ''}>
        <span class="page-link-icon" style="--tile:var(--${TONES[i % TONES.length]})">${d.icon || ''}</span><span>${esc(d.label)}</span></a>`).join('')}
    </nav>
    <div class="page-body">
      <header class="page-head"><h1>${esc(def.label)}</h1>
        <button class="icon-btn" type="button" data-page-close title="${esc(tr('关闭'))}" aria-label="${esc(tr('关闭'))}">${ICON.close}</button></header>
      <div class="page-content" id="pageContent"></div>
    </div>
  </div>`;
  document.title = `${def.label} · Agenda`;
  $('#mobileTitle').textContent = tr(TITLES[page]);
  try { def.render($('#pageContent'), { page, section: def.id }); } catch (e) { console.error(e); }
  return true;
}

export function hidePage() {
  dispose();
  current = null;
  const view = $('#pageView');
  view.hidden = true;
  view.innerHTML = '';
}

$('#pageView').addEventListener('click', (e) => { if (e.target.closest('[data-page-close]')) closePage(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && current && !document.querySelector('dialog[open]') && !e.defaultPrevented
    && !e.target.closest?.('input, textarea, select')) closePage();
});
// 分类有增减时，正在看的整页跟着刷新
onSlotsChange((slot) => { if (current?.page === slot) showPage(slot, current.def.id); });
