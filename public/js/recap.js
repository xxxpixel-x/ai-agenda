import { normalizeContextResponse } from './context-memory-format.js';
import { $, ICON, api, clock, esc, md, state, toast, tr } from './util.js';

let view = null;
let timer;

export function resetRecap() {
  clearTimeout(timer);
  view = null;
}

const isCurrent = (v) => v === view && state.space?.id === v.id;
function draw(v, focus) {
  if (!isCurrent(v)) return;
  const { slot, recap, draft } = v;
  slot.hidden = draft === null && !recap.text.trim();
  if (slot.hidden) { slot.replaceChildren(); return; }
  const meta = [];
  if (recap.uptoSeq) meta.push(tr('涵盖至消息 #{0}', [recap.uptoSeq]));
  meta.push(tr('{0} 字', [recap.text.length]));
  if (recap.updatedAt) meta.push(clock(recap.updatedAt));
  slot.innerHTML = `<section class="recap-card"><button type="button" class="recap-head" data-recap="toggle"
    aria-expanded="${v.expanded}" ${v.busy ? 'disabled' : ''}>${ICON.chevron}<b>${tr('前情提要')}</b>
    ${recap.editedByUser ? '<small class="recap-edited">' + tr('已手动编辑') + '</small>' : ''}
    <span>${esc(meta.join(' · '))}</span></button>
    ${v.expanded ? `<div class="recap-body">${draft === null ? `<div class="md">${md(recap.text)}</div>
      <button type="button" class="btn sm" data-recap="edit">${tr('编辑')}</button>` :
      `<textarea aria-label="${tr('前情提要')}" ${v.busy ? 'readonly' : ''}></textarea>
      ${v.conflict ? `<div class="recap-conflict" role="alert">${tr('前情提要已在后台更新，当前保存未生效。')}
        <button type="button" class="btn sm" data-recap="latest" ${v.busy ? 'disabled' : ''}>${tr('载入最新内容')}</button></div>` : ''}
      <div class="recap-actions"><button type="button" class="btn sm primary" data-recap="save" ${v.busy ? 'disabled' : ''}>${tr('保存')}</button>
        <button type="button" class="btn sm" data-recap="cancel" ${v.busy ? 'disabled' : ''}>${tr('取消')}</button></div>`}</div>` : ''}</section>`;
  const box = $('textarea', slot);
  if (box) {
    box.value = draft;
    box.oninput = () => { v.draft = box.value; };
  }
  if (focus) $(focus, slot)?.focus({ preventScroll: true });
}

async function refresh(v) {
  const seq = ++v.request;
  try {
    const response = await api(`/api/spaces/${v.id}/context`);
    if (!isCurrent(v) || seq !== v.request) return;
    v.recap = normalizeContextResponse(response).recap;
    // Keep the editor node, selection and the version its draft was based on.
    if (v.draft === null) draw(v);
  } catch {
    // Older servers have no recap. Keep the last successful read.
  }
}

async function save(v) {
  v.busy = true;
  draw(v);
  try {
    const response = await api(`/api/spaces/${v.id}/recap`, { method: 'PUT', body: { text: v.draft, version: v.baseVersion } });
    if (isCurrent(v)) {
      ++v.request;
      v.recap = normalizeContextResponse(response).recap;
      v.draft = v.conflict = null;
      toast(tr('前情提要已保存'));
    }
    window.dispatchEvent(new CustomEvent('agenda:context-updated', { detail: { spaceId: v.id } }));
  } catch (err) {
    if (!isCurrent(v)) return;
    if (err.status === 409) v.conflict = { recap: err.data?.recap };
    else toast(err.message, 'error');
  } finally {
    v.busy = false;
    draw(v, v.draft === null ? '[data-recap="edit"]' : 'textarea');
  }
}

async function loadLatest(v) {
  v.busy = true;
  draw(v);
  try {
    const raw = v.conflict.recap ? { recap: v.conflict.recap } : await api(`/api/spaces/${v.id}/context`);
    if (!isCurrent(v)) return;
    ++v.request;
    const latest = normalizeContextResponse(raw).recap;
    if (latest.version >= v.recap.version) v.recap = latest;
    v.draft = v.recap.text;
    v.baseVersion = v.recap.version;
    v.conflict = null;
  } catch (err) {
    if (isCurrent(v)) toast(err.message, 'error');
  } finally {
    v.busy = false;
    draw(v, 'textarea');
  }
}

export function syncRecapSlot(space) {
  const slot = $('#recapSlot');
  if (!slot || !space?.id) return;
  if (view?.id !== space.id) {
    resetRecap();
    view = { id: space.id, recap: normalizeContextResponse().recap, draft: null, expanded: false, request: 0 };
  }
  const v = view;
  v.slot = slot;
  slot.onclick = ({ target }) => {
    const action = target.closest('[data-recap]')?.dataset.recap;
    if (!action || v.busy || !isCurrent(v)) return;
    if (action === 'save') { save(v); return; }
    if (action === 'latest') { loadLatest(v); return; }
    if (action === 'toggle') v.expanded = !v.expanded;
    if (action === 'edit') { v.draft = v.recap.text; v.baseVersion = v.recap.version; }
    if (action === 'cancel') v.draft = v.conflict = null;
    draw(v, v.expanded && v.draft !== null ? 'textarea' : action === 'cancel' ? '[data-recap="edit"]' : '[data-recap="toggle"]');
  };
  draw(v);
  refresh(v);
}

window.addEventListener('agenda:space-event', ({ detail }) => {
  if (!view || detail?.space?.id !== view.id || !['message_done', 'run', 'state'].includes(detail.type)) return;
  const v = view;
  clearTimeout(timer);
  timer = setTimeout(() => refresh(v), 200);
});
window.addEventListener('agenda:context-updated', ({ detail }) => {
  if (view?.id === detail?.spaceId) refresh(view);
});
