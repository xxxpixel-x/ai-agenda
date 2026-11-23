// 右侧栏的「文件」「改动」两个面板：共享文件夹、Markdown 预览、右键菜单；每次改动、对比、逐行批注
import { briefAction, renderBriefDiff } from './imports.js';
import { chatNoteBar, renderNoteDiff, sendChatNotes, trackNoteView } from './notes.js';
import { currentPanel, onRightbarChange, renderPanelBody, renderRightbar, rightbarOpen, setPanelBadge, showPanel } from './rightbar.js';
import { register } from './slots.js';
import { $, $$, ICON, VIEW_PANEL, api, authorName, emptyHtml, esc, getLanguage, md, sizeText, state, toast, tr } from './util.js';

// ---------------- 共享文件面板 ----------------
export async function loadFiles() {
  if (!state.space) return;
  try {
    const r = await api(`/api/spaces/${state.space.id}/files`);
    state.files.list = r.files;
    state.files.root = r.root;
    state.files.truncated = r.truncated;
  } catch (e) { toast(e.message, 'error'); }
  if (currentPanel() === 'files' && !state.files.view && document.activeElement?.id !== 'newFileName') renderFilesBody();
}
export async function loadHistory() {
  if (!state.space) return;
  try { state.files.history = await api(`/api/spaces/${state.space.id}/history`); } catch { state.files.history = []; }
  setPanelBadge('changes', state.files.history.length || null);
  if (currentPanel() === 'changes' && !state.files.view) renderFilesBody();
}

/** 文件暂时只读（同一个文件夹的任务空间在依次直接改）或任务已结束：不能编辑、撤销。 */
export const filesLocked = () => !!state.space?.readOnly || (state.space?.kind === 'task' && !!state.space.run?.closed);

/** 整个右侧栏重画（标签和当前面板）。 */
export const renderFilesPanel = () => { hideFileMenu(); renderRightbar(); };
/** 只重画当前面板。 */
export const renderFilesBody = () => { hideFileMenu(); renderPanelBody(); };
/** 打开一个详情（文件、改动、子任务……），切到它所属的面板。 */
export function showView(view) {
  state.files.view = view;
  if (!showPanel(VIEW_PANEL[view.type])) renderFilesBody();
}
/** 换空间：各面板的详情都清掉。 */
export function resetViews() { state.files.views = {}; }

// 面板渲染时记下当前是哪个面板（state.files.view 读的是它的详情），并告诉批注模块现在看的是什么
export function enterPanel(id) {
  hideFileMenu();
  state.files.panel = id;
  trackNoteView(rightbarOpen() && state.space, state.files.view);
}
onRightbarChange(() => { if (!rightbarOpen()) { hideFileMenu(); trackNoteView(null); } });

const folderName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
function renderFilesPane(body) {
  enterPanel('files');
  const v = state.files.view;
  if (v?.type === 'file') return renderEditor(body, v);
  const sp = state.space;
  const ro = sp.readOnly;
  const why = ro ? tr('任务空间「{0}」正在依次修改这个文件夹，做完之前文件只能看、不能改', [ro.title]) : '';
  const files = state.files.list;
  body.innerHTML = `<div class="panel-bar">
      <span class="pb-title" title="${esc(sp.workspacePath)}">${ICON.folder}<span>${esc(folderName(sp.workspacePath))}</span></span>
      ${ro ? `<span class="files-lock" tabindex="0" title="${esc(why)}" aria-label="${esc(why)}">${ICON.lock}</span>` : ''}
      <span class="grow"></span>
      <button class="icon-btn" type="button" data-act="new-file" title="${tr('新建文件')}" aria-label="${tr('新建文件')}" ${filesLocked() ? 'disabled' : ''}>${ICON.plus}</button>
      ${state.app.desktop ? `<button class="icon-btn" type="button" data-act="open-folder" title="${tr('在资源管理器中打开')}" aria-label="${tr('在资源管理器中打开')}">${ICON.external}</button>` : ''}
      <button class="icon-btn" type="button" data-act="refresh" title="${tr('刷新')}" aria-label="${tr('刷新')}">${ICON.refresh}</button></div>
    ${state.files.truncated ? `<div class="hint panel-note">${tr('文件太多，只显示一部分')}</div>` : ''}
    ${files.length ? `<div class="file-list">${treeHtml(fileTree(files))}</div>` : emptyHtml(tr('文件夹是空的'))}`;
  state.files.flash.clear();
}

function renderChangesPane(body) {
  enterPanel('changes');
  const v = state.files.view;
  if (v?.type === 'change') return renderChange(body, v);
  if (v?.type === 'briefdiff') return renderBriefDiff(body, v);
  {
    const list = state.files.history;
    body.innerHTML = list.length ? `<div class="history-list">${list.map((h) => {
      const mem = state.space.members.find((m) => m.name === h.by);
      const color = h.by === '我' ? 'var(--accent)' : mem?.color || 'var(--muted)';
      const tag = h.undoOf ? tr('撤销') : h.created ? tr('新建') : h.deleted ? tr('删除') : '';
      return `<div class="h-row" data-change="${h.id}" style="--c:${color}">
        <span class="who">${esc(authorName(h.by))}</span><span class="hp">${esc(h.path)}</span>
        <span>${tag ? `<span class="badge off">${tag}</span> ` : ''}<span class="plus">+${h.added}</span> <span class="minus">−${h.removed}</span></span>
        <span class="ht">${new Date(h.ts).toLocaleString(getLanguage(), { hour12: false })}</span></div>`;
    }).join('')}</div>` : emptyHtml(tr('还没有改动'));
  }
}


// 文件夹树：文件夹在前，名字按自然顺序（9 在 10 前），子文件夹默认收起
const byName = new Intl.Collator(getLanguage(), { numeric: true, sensitivity: 'base' }).compare;
function fileTree(list) {
  const root = { dirs: new Map(), files: [] };
  for (const f of list) {
    const parts = f.path.split('/');
    let node = root;
    for (const d of parts.slice(0, -1)) {
      if (!node.dirs.has(d)) node.dirs.set(d, { dirs: new Map(), files: [] });
      node = node.dirs.get(d);
    }
    node.files.push({ ...f, name: parts.at(-1) });
  }
  return root;
}
function treeHtml(node, prefix = '', depth = 0) {
  const dirs = [...node.dirs.keys()].sort(byName).map((name) => {
    const p = `${prefix}${name}/`;
    const open = state.files.expanded.has(p);
    return `<div class="dir-row${open ? ' open' : ''}" data-dir="${esc(p)}" tabindex="0" role="button" aria-expanded="${open}" style="--d:${depth}">${ICON.chevron}${ICON.folder}<span class="fp">${esc(name)}</span></div>${open ? treeHtml(node.dirs.get(name), p, depth + 1) : ''}`;
  });
  const files = node.files.sort((a, b) => byName(a.name, b.name)).map((f) => `<div class="file-row${state.files.flash.has(f.path) ? ' flash' : ''}" data-path="${esc(f.path)}" tabindex="0" role="button" style="--d:${depth}">${ICON.file}<span class="fp">${esc(f.name)}</span><span class="fs">${sizeText(f.size)}</span></div>`);
  return dirs.join('') + files.join('');
}
/** 展开到这个文件所在的文件夹。 */
function revealFile(p) {
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) state.files.expanded.add(`${parts.slice(0, i).join('/')}/`);
}

export async function openFile(p) {
  const spaceId = state.space.id;
  try {
    const r = await api(`/api/spaces/${spaceId}/file?path=${encodeURIComponent(p)}`);
    if (state.space?.id !== spaceId) return;
    showView({ type: 'file', path: p, content: r.content, draft: r.content, preview: /\.md$/i.test(p), stale: false });
  } catch (e) { toast(e.message, 'error'); }
}

function renderEditor(body, v) {
  body.innerHTML = `<div class="editor">
    <div class="editor-head"><button class="icon-btn" type="button" data-act="back" title="${tr('返回')}">${ICON.back}</button>
      <span class="ep" title="${esc(v.path)}"></span>
      <button class="btn sm" type="button" data-act="toggle-preview">${v.preview ? tr('编辑') : tr('预览')}</button>
      <button class="btn sm primary" type="button" data-act="save-file">${tr('保存')}</button></div>
    ${v.preview ? `<div class="preview md">${md(v.draft)}</div>` : `<textarea spellcheck="false" id="editorText" ${filesLocked() ? 'readonly' : ''}>${esc(v.draft)}</textarea>`}
  </div>`;
  updateEditorStatus(body, v);
  const ta = $('#editorText', body);
  ta?.addEventListener('input', () => {
    const was = v.draft !== v.content;
    v.draft = ta.value;
    if (was !== (v.draft !== v.content)) updateEditorStatus(body, v);
  });
  ta?.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); } });
}

function updateEditorStatus(body, v) {
  const dirty = v.draft !== v.content;
  $('.ep', body).textContent = v.path + (dirty ? ' ●' : '');
  $('[data-act=save-file]', body).disabled = !dirty || filesLocked();
  const warn = $('.editor-warn', body);
  if (!v.stale) { warn?.remove(); return; }
  if (!warn) $('.editor-head', body).insertAdjacentHTML('afterend', `<div class="editor-warn">${ICON.alert}${tr('这个文件刚被改过了。')}
    <button class="btn sm" type="button" data-act="reload-file">${tr('载入最新内容')}</button><span class="hint">${tr('（会丢掉你没保存的修改）')}</span></div>`);
  $('.editor-warn .hint', body).hidden = !dirty;
}

// 同一个文件的多次显式保存按提交顺序写入，切换文件不阻塞其他保存。
const pendingSaves = new Map();
async function saveFile() {
  const v = state.files.view;
  const spaceId = state.space?.id;
  if (!spaceId || v?.type !== 'file' || filesLocked()) return;
  const targetPath = v.path;
  const sent = v.draft;
  const key = `${spaceId}/${targetPath}`;
  const pending = pendingSaves.get(key);
  if (sent === (pending ? pending.sent : v.content)) return;
  const write = () => api(`/api/spaces/${spaceId}/file`, { method: 'PUT', body: { path: targetPath, content: sent } });
  const request = pending ? pending.request.then(write, write) : write();
  pendingSaves.set(key, { sent, request });
  try {
    await request;
    if (v.path === targetPath) { v.content = sent; v.stale = false; }
    const cur = state.files.views.files;
    if (state.space?.id !== spaceId || cur?.type !== 'file' || cur.path !== targetPath) return;
    cur.content = sent;
    cur.stale = false;
    if (currentPanel() !== 'files') return;
    updateEditorStatus($('#filesBody'), cur);
    toast(tr('已保存'));
  } catch (e) { toast(e.message, 'error'); }
  finally { if (pendingSaves.get(key)?.request === request) pendingSaves.delete(key); }
}

export async function openChange(id) {
  const spaceId = state.space.id;
  try {
    const c = await api(`/api/spaces/${spaceId}/history/${id}`);
    if (state.space?.id !== spaceId) return;
    showView({ type: 'change', ...c });
  } catch (e) { toast(e.message, 'error'); }
}

function renderChange(body, c) {
  const chat = state.space.kind === 'chat';
  const member = chat && c.by !== '我' && !c.undoOf && state.space.members.find((m) => m.name === c.by);
  const undone = state.files.history.some((h) => h.undoOf === c.id);
  const canUndo = !undone && c.current === c.after;
  body.innerHTML = `<div class="diff-view">
    <div class="editor-head"><button class="icon-btn" type="button" data-act="back" title="${tr('返回')}">${ICON.back}</button>
      <span class="ep">${esc(authorName(c.by))} ${c.created ? tr('新建了') : c.deleted ? tr('删除了') : tr('修改了')} ${esc(c.path)}</span>
      <button class="btn sm" type="button" data-act="open-file" data-path="${esc(c.path)}" ${c.deleted ? 'disabled' : ''}>${tr('打开文件')}</button>
      <button class="btn sm danger" type="button" data-act="undo" ${undone || filesLocked() ? 'disabled' : ''}>${undone ? tr('已撤销') : tr('撤销这次改动')}</button></div>
    <div class="hint" style="padding:6px 12px">${new Date(c.ts).toLocaleString(getLanguage(), { hour12: false })}${!canUndo && !undone ? tr(' · 这个文件之后又被改过') : ''}</div>
    <div class="diff"></div>${chat ? chatNoteBar(state.space.id) : ''}</div>`;
  renderNoteDiff($('.diff', body), c, member?.id, renderFilesBody);
}

async function undoChange(c) {
  try {
    await api(`/api/spaces/${state.space.id}/history/${c.id}/undo`, { method: 'POST', body: {} });
    toast(tr('已撤销对 {0} 的改动', [c.path]));
  } catch (e) {
    if (!e.conflict) { toast(e.message, 'error'); return; }
    if (!confirm(tr('{0}\n\n仍然要把 {1} 恢复成这次改动之前的样子吗？之后的修改会丢失（但会留在改动记录里，可以再撤销回来）。', [e.message, c.path]))) return;
    try { await api(`/api/spaces/${state.space.id}/history/${c.id}/undo`, { method: 'POST', body: { force: true } }); toast(tr('已撤销')); } catch (err) { toast(err.message, 'error'); return; }
  }
  await loadHistory();
  openChange(c.id);
}

export async function onFilesChanged(changes) {
  const spaceId = state.space?.id;
  if (!spaceId) return;
  for (const c of changes) if (!c.deleted) { revealFile(c.path); state.files.flash.add(c.path); }
  loadFiles();
  loadHistory();
  const v = state.files.views.files;
  if (v?.type !== 'file') return;
  const change = changes.findLast((c) => c.path === v.path);
  if (!change) return;
  // 自己的保存也会发 files_changed，可能比 PUT 先到或后到。只应用仍属于当前视图的磁盘变化。
  const before = v.content;
  v.lastChange = change;
  const current = () => state.space?.id === spaceId && state.files.views.files === v &&
    v.path === change.path && v.lastChange === change && v.content === before;
  try {
    const { content } = await api(`/api/spaces/${spaceId}/file?path=${encodeURIComponent(v.path)}`);
    const pending = pendingSaves.get(`${spaceId}/${change.path}`);
    if (!current() || content === before || content === pending?.sent) return;
    if (v.draft === before && !pending) {
      v.content = v.draft = content;
      v.stale = false;
      if (currentPanel() === 'files') renderFilesBody();
      return;
    }
  } catch (e) {
    if (!current()) return;
    if (v.draft === before) toast(e.message, 'error');
  }
  v.stale = true;
  if (currentPanel() === 'files') updateEditorStatus($('#filesBody'), v);
}

// 剪贴板接口被拒绝时（有的浏览器不给本机页面写权限），退回到选中文字再复制
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* 用下面的办法 */ }
  const back = document.activeElement;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  back?.focus({ preventScroll: true });
  if (!ok) throw new Error(tr('复制失败'));
}

const fileMenu = $('#fileMenu');
const treeRow = '.file-row[data-path], .dir-row[data-dir]';
let menuRow = null;
function hideFileMenu() {
  fileMenu.hidden = true;
  menuRow = null;
}
function openFileMenu(row, x, y) {
  menuRow = row;
  const { desktop, mock, platform } = state.app;
  const reveal = $('[data-file-action=reveal]', fileMenu);
  reveal.textContent = platform === 'win32' ? tr('在资源管理器中显示') : platform === 'darwin' ? tr('在访达中显示') : tr('在文件管理器中显示');
  reveal.hidden = !desktop || mock;
  $('[data-file-action=open]', fileMenu).hidden = reveal.hidden || !!row.dataset.dir;
  fileMenu.hidden = false;
  fileMenu.style.left = `${Math.max(8, Math.min(x, innerWidth - fileMenu.offsetWidth - 8))}px`;
  fileMenu.style.top = `${Math.max(8, Math.min(y, innerHeight - fileMenu.offsetHeight - 8))}px`;
  $('button:not([hidden])', fileMenu).focus({ preventScroll: true });
}
$('#filesBody').addEventListener('contextmenu', (e) => {
  const row = e.target.closest(treeRow);
  if (!row) return;
  e.preventDefault();
  openFileMenu(row, e.clientX, e.clientY);
});
$('#filesBody').addEventListener('keydown', (e) => {
  const row = e.target.closest(treeRow);
  if (!row) return;
  if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    openFileMenu(row, rect.left + 12, rect.bottom);
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    row.click();
  }
});
document.addEventListener('pointerdown', (e) => { if (!fileMenu.contains(e.target)) hideFileMenu(); });
document.addEventListener('keydown', (e) => {
  if (!menuRow) return;
  if (e.key === 'Escape' || e.key === 'Tab') {
    menuRow.focus({ preventScroll: true });
    hideFileMenu();
    if (e.key === 'Escape') e.preventDefault();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const buttons = $$('button:not([hidden])', fileMenu);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    buttons[(buttons.indexOf(document.activeElement) + step + buttons.length) % buttons.length].focus();
  }
});
window.addEventListener('resize', hideFileMenu);
window.addEventListener('blur', hideFileMenu);
document.addEventListener('scroll', hideFileMenu, true);
fileMenu.addEventListener('click', async (e) => {
  const action = e.target.closest('button')?.dataset.fileAction;
  if (!action || !menuRow) return;
  const windows = state.app.platform === 'win32';
  const sep = windows ? '\\' : '/';
  const path = menuRow.dataset.path ?? menuRow.dataset.dir.slice(0, -1);
  const relative = windows ? path.replaceAll('/', sep) : path;
  const root = windows ? state.files.root.replaceAll('/', sep) : state.files.root;
  const absolute = root + (root.endsWith(sep) ? '' : sep) + relative;
  menuRow.focus({ preventScroll: true });
  hideFileMenu();
  try {
    if (action === 'copy' || action === 'relative') {
      await copyText(action === 'copy' ? absolute : relative);
      toast(tr('已复制'));
    } else {
      await api(`/api/${action}-path`, { method: 'POST', body: { path: absolute } });
    }
  } catch (err) { toast(err.message, 'error'); }
});

$('#filesBody').addEventListener('click', async (e) => {
  const dir = e.target.closest('.dir-row');
  if (dir) {
    const p = dir.dataset.dir;
    if (!state.files.expanded.delete(p)) state.files.expanded.add(p);
    renderFilesBody();
    $(`[data-dir="${CSS.escape(p)}"]`, $('#filesBody'))?.focus({ preventScroll: true });
    return;
  }
  const row = e.target.closest('.file-row');
  if (row) { openFile(row.dataset.path); return; }
  const h = e.target.closest('.h-row');
  if (h) { openChange(h.dataset.change); return; }
  const ba = e.target.closest('[data-brief-act]');
  if (ba && state.files.view?.type === 'briefdiff') { briefAction(state.files.view.id, ba.dataset.briefAct); return; }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const v = state.files.view;
  switch (b.dataset.act) {
    case 'send-notes':
      b.disabled = true;
      await sendChatNotes(state.space, renderFilesBody);
      break;
    case 'back':
      if (v?.type === 'file' && v.draft !== v.content && !confirm(tr('有没保存的修改，确定离开吗？'))) return;
      state.files.view = null; renderFilesBody(); break;
    case 'toggle-preview': v.preview = !v.preview; renderFilesBody(); break;
    case 'save-file': saveFile(); break;
    case 'reload-file': openFile(v.path); break;
    case 'open-file': openFile(b.dataset.path); break;
    case 'refresh': loadFiles(); loadHistory(); break;
    case 'open-folder': api('/api/open-path', { method: 'POST', body: { path: state.space.workspacePath } }).catch((err) => toast(err.message, 'error')); break;
    case 'undo': undoChange(v); break;
    case 'new-file': {
      // 桌面版（Electron）不支持 prompt()，就地换成一个输入框
      let tools = $('.file-tools', $('#filesBody'));
      if (!tools) { $('.panel-bar', $('#filesBody')).insertAdjacentHTML('afterend', '<div class="file-tools"></div>'); tools = $('.file-tools', $('#filesBody')); }
      tools.innerHTML = `<input id="newFileName" value="${tr('新文档.md')}" spellcheck="false" placeholder="${tr('notes/计划.md')}">`;
      const inp = $('#newFileName', tools);
      let done = false;
      inp.focus();
      inp.setSelectionRange(0, inp.value.lastIndexOf('.'));
      inp.addEventListener('keydown', (ev) => {
        if (ev.isComposing || ev.keyCode === 229) return;
        if (ev.key === 'Escape') { done = true; renderFilesBody(); }
        if (ev.key === 'Enter') { ev.preventDefault(); done = true; createFile(inp.value); }
      });
      inp.addEventListener('blur', () => { if (!done) renderFilesBody(); });
      break;
    }
  }
});
export async function createFile(name) {
  const spaceId = state.space.id;
  const p = name.trim().replaceAll('\\', '/').split('/').filter(part => part && part !== '.').join('/');
  if (!p) { renderFilesBody(); return; }
  try {
    await api(`/api/spaces/${spaceId}/file`, { method: 'PUT', body: { path: p, content: '', createOnly: true } });
  } catch (err) {
    if (state.space?.id !== spaceId) return;
    if (err.status !== 409 || !err.conflict) { toast(err.message, 'error'); renderFilesBody(); return; }
  }
  if (state.space?.id === spaceId) { renderFilesBody(); await openFile(p); }
}

// 两个面板放在最后注册（注册会立刻触发一次右侧栏重画，上面的变量要先定义好）
register('panels', { id: 'files', label: tr('文件'), icon: ICON.files, order: 10, render: renderFilesPane });
register('panels', { id: 'changes', label: tr('改动'), icon: ICON.transfer, order: 20, render: renderChangesPane });
