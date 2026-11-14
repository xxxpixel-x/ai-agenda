// Agenda —— 界面入口：路由与启动。各部分在 public/js/ 下。
import { openSpace, showWelcome } from './js/chat.js';
import { refreshEngines } from './js/engines.js';
import { applyTheme, refreshSpaces, refreshSpacesSoon, renderSpaceList, theme } from './js/sidebar.js';
import { $, api, load, state } from './js/util.js';
import './js/space-form.js';
import './js/files.js';
import './js/tasks.js';
import './js/imports.js';

// ---------------- 路由与启动 ----------------
function route() {
  const m = location.hash.match(/^#\/space\/([a-f0-9-]{36})/i);
  if (m) openSpace(m[1]);
  else if (state.spaces.length && !location.hash) location.hash = `#/space/${state.spaces[0].id}`;
  else showWelcome();
}
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => {
  const v = state.files.view;
  if (v?.type === 'file' && v.draft !== v.content) { e.preventDefault(); e.returnValue = ''; }
});
setInterval(renderSpaceList, 60_000);
// 所有空间的状态变化（发言中、等你确认、任务等你）：侧栏跟着刷新
new EventSource('/api/events').onmessage = refreshSpacesSoon;

(async () => {
  $('#mockTag').hidden = !state.app.mock;
  applyTheme(window.desktop?.getTheme ? await window.desktop.getTheme() : load('rt:theme'));
  await Promise.all([refreshEngines(), refreshSpaces()]);
  route();
})();

