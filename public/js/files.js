// 共享文件面板
import { input, renderHeader } from './chat.js';
import { briefAction, renderBriefDiff } from './imports.js';
import { chatNoteBar, renderNoteDiff, sendChatNotes, trackNoteView } from './notes.js';
import { renderTaskDetail, renderTaskDiff } from './tasks.js';
import { $, $$, ICON, api, authorName, esc, getLanguage, md, sizeText, state, store, toast, tr } from './util.js';

// ---------------- 共享文件面板 ----------------
export async function loadFiles() {
  if (!state.space) return;
  try {
    const r = await api(`/api/spaces/${state.space.id}/files`);
    state.files.list = r.files;
    state.files.root = r.root;
    state.files.truncated = r.truncated;
  } catch (e) { toast(e.message, 'error'); }
  if (state.files.tab === 'files' && !state.files.view && document.activeElement?.id !== 'newFileName') renderFilesBody();
}
export async function loadHistory() {
  if (!state.space) return;
  try { state.files.history = await api(`/api/spaces/${state.space.id}/history`); } catch { state.files.history = []; }
  $('#historyCount').textContent = state.files.history.length || '';
  if (state.files.tab === 'history' && !state.files.view) renderFilesBody();
}

/** 文件暂时只读（同一个文件夹的任务空间在依次直接改）或任务已结束：不能编辑、撤销。 */
export const filesLocked = () => !!state.space?.readOnly || (state.space?.kind === 'task' && !!state.space.run?.closed);

export function renderFilesPanel() {
  hideFileMenu();
  const panel = $('#filesPanel');
  panel.hidden = !state.space || !state.files.open;
  if (panel.hidden) { trackNoteView(null); return; }
  $('#filesTitle').title = state.space.workspacePath;
  // 只在标题旁放一个小锁，鼠标停上去显示原因
  const lock = $('#filesLock');
  const ro = state.space.readOnly;
  lock.hidden = !ro;
  const why = ro ? tr('任务空间「{0}」正在依次修改这个文件夹，做完之前文件只能看、不能改', [ro.title]) : '';
  lock.title = why;
  lock.setAttribute('aria-label', why);
  $('#openFolderBtn').hidden = !state.app.desktop;
  $$('.tab', panel).forEach((t) => t.classList.toggle('active', t.dataset.tab === state.files.tab));
  renderFilesBody();
}

export function renderFilesBody() {
  hideFileMenu();
  const body = $('#filesBody');
  const v = state.files.view;
  trackNoteView(state.files.open && state.space, v);
  if (v?.type === 'task') return renderTaskDetail(body, v);
  if (v?.type === 'taskdiff') return renderTaskDiff(body, v);
  if (v?.type === 'file') return renderEditor(body, v);
  if (v?.type === 'change') return renderChange(body, v);
  if (v?.type === 'briefdiff') return renderBriefDiff(body, v);
  if (state.files.tab === 'history') {
    const list = state.files.history;
    body.innerHTML = list.length ? `<div class="history-list">${list.map((h) => {
      const mem = state.space.members.find((m) => m.name === h.by);
      const color = h.by === '我' ? 'var(--accent)' : mem?.color || 'var(--muted)';
      const tag = h.undoOf ? tr('撤销') : h.created ? tr('新建') : h.deleted ? tr('删除') : '';
      return `<div class="h-row" data-change="${h.id}" style="--c:${color}">
        <span class="who">${esc(authorName(h.by))}</span><span class="hp">${esc(h.path)}</span>
        <span>${tag ? `<span class="badge off">${tag}</span> ` : ''}<span class="plus">+${h.added}</span> <span class="minus">−${h.removed}</span></span>
        <span class="ht">${new Date(h.ts).toLocaleString(getLanguage(), { hour12: false })}</span></div>`;
    }).join('')}</div>` : `<div class="empty-files">${tr('还没有改动')}</div>`;
    return;
  }
  const files = state.files.list;
  body.innerHTML = `<div class="file-tools"><button class="btn sm" type="button" data-act="new-file" ${filesLocked() ? 'disabled' : ''}>${ICON.plus}${tr('新建文件')}</button>
      ${state.files.truncated ? `<span class="hint">${tr('文件太多，只显示一部分')}</span>` : ''}</div>
    ${files.length ? `<div class="file-list">${treeHtml(fileTree(files))}</div>` : `<div class="empty-files">${tr('文件夹是空的')}</div>`}`;
  state.files.flash.clear();
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
    state.files.view = { type: 'file', path: p, content: r.content, draft: r.content, preview: /\.md$/i.test(p), stale: false };
    if (!state.files.open) { state.files.open = true; renderHeader(); }
    renderFilesPanel();
  } catch (e) { toast(e.message, 'error'); }
}

function renderEditor(body, v) {
  const dirty = v.draft !== v.content;
  body.innerHTML = `<div class="editor">
    <div class="editor-head"><button class="icon-btn" type="button" data-act="back" title="${tr('返回')}">${ICON.back}</button>
      <span class="ep" title="${esc(v.path)}">${esc(v.path)}${dirty ? ' ●' : ''}</span>
      <button class="btn sm" type="button" data-act="toggle-preview">${v.preview ? tr('编辑') : tr('预览')}</button>
      <button class="btn sm primary" type="button" data-act="save-file" ${dirty && !filesLocked() ? '' : 'disabled'}>${tr('保存')}</button></div>
    ${v.stale ? `<div class="editor-warn">${ICON.alert}${tr('这个文件刚被改过了。')}<button class="btn sm" type="button" data-act="reload-file">${tr('载入最新内容')}</button>${dirty ? `<span class="hint">${tr('（会丢掉你没保存的修改）')}</span>` : ''}</div>` : ''}
    ${v.preview ? `<div class="preview md">${md(v.draft)}</div>` : `<textarea spellcheck="false" id="editorText" ${filesLocked() ? 'readonly' : ''}>${esc(v.draft)}</textarea>`}
  </div>`;
  const ta = $('#editorText', body);
  ta?.addEventListener('input', () => {
    const was = v.draft !== v.content;
    v.draft = ta.value;
    if (was !== (v.draft !== v.content)) {
      $('.ep', body).textContent = v.path + (v.draft !== v.content ? ' ●' : '');
      $('[data-act=save-file]', body).disabled = v.draft === v.content;
    }
  });
  ta?.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); } });
}

async function saveFile() {
  const v = state.files.view;
  if (!v || v.type !== 'file' || v.draft === v.content) return;
  try {
    await api(`/api/spaces/${state.space.id}/file`, { method: 'PUT', body: { path: v.path, content: v.draft } });
    v.content = v.draft;
    v.stale = false;
    toast(tr('已保存'));
    renderFilesBody();
  } catch (e) { toast(e.message, 'error'); }
}

export async function openChange(id) {
  const spaceId = state.space.id;
  try {
    const c = await api(`/api/spaces/${spaceId}/history/${id}`);
    if (state.space?.id !== spaceId) return;
    state.files.view = { type: 'change', ...c };
    if (!state.files.open) { state.files.open = true; renderHeader(); }
    renderFilesPanel();
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

export function onFilesChanged(changes) {
  for (const c of changes) if (!c.deleted) { revealFile(c.path); state.files.flash.add(c.path); }
  loadFiles();
  loadHistory();
  const v = state.files.view;
  if (v?.type === 'file' && changes.some((c) => c.path === v.path)) {
    if (v.draft === v.content) openFile(v.path); // 没有未保存的修改：直接刷新
    else { v.stale = true; renderFilesBody(); }
  }
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

$('#filesPanel').addEventListener('click', async (e) => {
  const tab = e.target.closest('.tab');
  if (tab) { state.files.tab = tab.dataset.tab; state.files.view = null; renderFilesPanel(); return; }
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
    case 'open-file': state.files.tab = 'files'; openFile(b.dataset.path); break;
    case 'undo': undoChange(v); break;
    case 'new-file': {
      // 桌面版（Electron）不支持 prompt()，就地换成一个输入框
      const tools = b.closest('.file-tools');
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
async function createFile(name) {
  const p = name.trim();
  if (!p) { renderFilesBody(); return; }
  if (state.files.list.some((f) => f.path === p)) { openFile(p); return; }
  try { await api(`/api/spaces/${state.space.id}/file`, { method: 'PUT', body: { path: p, content: '' } }); openFile(p); } catch (err) { toast(err.message, 'error'); renderFilesBody(); }
}
$('#closeFilesBtn').addEventListener('click', () => { state.files.open = false; store('rt:filesOpen', false); renderFilesPanel(); if (state.space) renderHeader(); });
$('#refreshFilesBtn').addEventListener('click', () => { loadFiles(); loadHistory(); });
$('#openFolderBtn').addEventListener('click', () => api('/api/open-path', { method: 'POST', body: { path: state.space.workspacePath } }).catch((e) => toast(e.message, 'error')));

