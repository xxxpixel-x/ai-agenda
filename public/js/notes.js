// 批注只存在当前空间的本地草稿里，点发送或退回后才交给后端。
import { $, $$, api, diffHtml, esc, load, state, store, toast, tr } from './util.js';
import { formatNotes, lineLabel, lineNumber, locateNotes, notesByMember, quoteLine } from './notes-format.js';

export const spaceNotes = (id) => load(`rt:notes:${id}`) || [];
export const taskNotes = (id, ref) => spaceNotes(id).filter((n) => n.kind === 'task' && n.ref === ref);
const sending = new Set();

function saveNotes(id, notes) {
  if (!store(`rt:notes:${id}`, notes)) throw new Error(tr('无法保存批注'));
}
export function removeNotes(id, notes) {
  if (!notes.length) return;
  const ids = new Set(notes.map((n) => n.id));
  saveNotes(id, spaceNotes(id).filter((n) => !ids.has(n.id)));
}
export function checkNoteLength(text) {
  if (text.length > 20000) throw new Error(tr('内容超过 {0} 个字符', [20000]));
}

let visibleDiff = null;
export function trackNoteView(space, view) {
  const kind = view?.type === 'taskdiff' ? 'task' : view?.type === 'change' ? 'change' : null;
  const next = space && kind ? { space: space.id, kind, ref: view.taskId ?? view.id, path: view.path } : null;
  const prev = visibleDiff;
  if (prev && (!next || prev.space !== next.space || prev.kind !== next.kind || prev.ref !== next.ref || prev.path !== next.path)) {
    const notes = spaceNotes(prev.space);
    if (notes.some((n) => n.kind === prev.kind && n.ref === prev.ref && n.path === prev.path)) toast(tr('有 {0} 条批注还没发', [notes.length]));
  }
  visibleDiff = next;
}

const deleteButton = (id) => `<button class="note-delete" type="button" data-note-delete="${esc(id)}" aria-label="${tr('删除')}" title="${tr('删除')}">×</button>`;
const noteCard = (n) => `<div class="diff-note"><span>${esc(n.text)}</span>${deleteButton(n.id)}</div>`;

export function taskNoteList(notes) {
  if (!notes.length) return '';
  return `<div class="review-notes"><div>${tr('{0} 条批注', [notes.length])}</div>${notes.map((n) =>
    `<div class="review-note"><span>${esc(n.path)} · ${esc(lineLabel(n.from, tr))} · ${esc(n.text.split('\n')[0])}</span>${deleteButton(n.id)}</div>`
  ).join('')}</div>`;
}

export function chatNoteBar(spaceId) {
  const count = spaceNotes(spaceId).filter((n) => n.kind === 'change').length;
  return count ? `<div class="note-bar"><span>${tr('{0} 条批注', [count])}</span><button class="btn sm primary" type="button" data-act="send-notes" ${sending.has(spaceId) ? 'disabled' : ''}>${tr('发送')}</button></div>` : '';
}

export async function sendChatNotes(space, refresh) {
  if (sending.has(space.id)) return;
  sending.add(space.id);
  try {
    const groups = notesByMember(spaceNotes(space.id).filter((n) => n.kind === 'change'));
    for (const [to, notes] of groups) {
      const member = space.members.find((m) => m.id === to);
      if (!member) throw new Error(tr('批注的接收成员已被移除'));
      const text = formatNotes(notes, tr, member.name);
      checkNoteLength(text);
      await api(`/api/spaces/${space.id}/messages`, { method: 'POST', body: { text } });
      removeNotes(space.id, notes);
    }
  } catch (err) { toast(err.message, 'error'); }
  finally {
    sending.delete(space.id);
    if (state.space?.id === space.id && state.files.view?.type === 'change') refresh();
  }
}

export function renderNoteDiff(root, view, to, refresh) {
  if (!to) {
    delete view.noteDraft;
    root.innerHTML = diffHtml(view.before, view.after);
    return;
  }
  const spaceId = state.space.id;
  const kind = view.type === 'change' ? 'change' : 'task';
  const ref = view.taskId ?? view.id;
  const path = view.path;
  const notes = spaceNotes(spaceId).filter((n) => n.kind === kind && n.ref === ref && n.path === path);
  let lines;
  root.innerHTML = diffHtml(view.before, view.after, {
    annotations(rows) { lines = rows; return locateNotes(rows, notes); },
    renderNote: noteCard,
  });
  const rows = new Map($$('[data-index]', root).map((row) => [+row.dataset.index, row]));

  function showSelection(focus) {
    $('.note-editor', root)?.remove();
    for (const row of $$('.note-selected', root)) row.classList.remove('note-selected');
    const draft = view.noteDraft;
    if (!draft) return;
    const start = Math.min(draft.anchor, draft.end);
    const end = Math.max(draft.anchor, draft.end);
    const last = rows.get(end);
    for (let i = start; i <= end; i++) rows.get(i).classList.add('note-selected');
    last.insertAdjacentHTML('afterend', `<div class="note-editor"><textarea rows="2" aria-label="${tr('批注')}"></textarea><div>
      <button class="btn sm primary" type="button" data-note-add>${tr('添加')}</button>
      <button class="btn sm" type="button" data-note-cancel>${tr('取消')}</button></div></div>`);
    const input = $('.note-editor textarea', root);
    const add = $('[data-note-add]', root);
    input.value = draft.text;
    add.disabled = !draft.text.trim();
    input.oninput = () => { draft.text = input.value; add.disabled = !draft.text.trim(); };
    const cancel = () => { delete view.noteDraft; showSelection(false); };
    $('[data-note-cancel]', root).onclick = cancel;
    add.onclick = () => {
      const text = input.value.trim();
      if (!text) return;
      const from = { start: lineNumber(lines[start]), end: lineNumber(lines[end]) };
      const quote = lines.slice(start, end + 1).map(quoteLine).join('\n');
      const note = { id: crypto.randomUUID(), kind, ref, path, to, from, quote, text, ts: Date.now() };
      try { saveNotes(spaceId, [...spaceNotes(spaceId), note]); } catch (err) { toast(err.message, 'error'); return; }
      delete view.noteDraft;
      redraw();
    };
    input.closest('.note-editor').onkeydown = (e) => {
      if (e.isComposing) return;
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add.click(); }
    };
    if (focus) input.focus();
  }
  function redraw() {
    const scroll = root.scrollTop;
    refresh();
    $('.diff', $('#filesBody')).scrollTop = scroll;
  }
  root.onmousedown = (e) => {
    if (e.shiftKey && e.target.closest('[data-index]')) e.preventDefault();
  };
  root.onclick = (e) => {
    const del = e.target.closest('[data-note-delete]');
    if (del) {
      try { removeNotes(spaceId, [{ id: del.dataset.noteDelete }]); redraw(); } catch (err) { toast(err.message, 'error'); }
      return;
    }
    const row = e.target.closest('[data-index]');
    if (!row) return;
    const end = +row.dataset.index;
    const draft = view.noteDraft;
    if (e.shiftKey && draft) {
      // 折叠行没有 data-index，遇到断档就保留原选择。
      const low = Math.min(end, draft.anchor);
      const high = Math.max(end, draft.anchor);
      for (let i = low; i <= high; i++) if (!rows.has(i)) return;
      draft.end = end;
    } else view.noteDraft = { anchor: end, end, text: draft?.text || '' };
    showSelection(true);
  };
  showSelection(false);
}
