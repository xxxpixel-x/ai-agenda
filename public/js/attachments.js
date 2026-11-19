// 草稿按空间保存，消息或任务状态重绘时不丢；异步上传也只更新原来的草稿。
import { $, ICON, api, esc, state, toast, tr } from './util.js';
import { openFile } from './files.js';

const drafts = new Map();
const box = $('.composer-box');
const cards = $('#attachmentCards');
const preview = $('#imagePreview');
const url = (spaceId, id) => '/api/spaces/' + encodeURIComponent(spaceId) + '/attachments' + (id ? '/' + encodeURIComponent(id) : '');

export function attachmentDraft(id) {
  if (!drafts.has(id)) drafts.set(id, { items: [], sending: false });
  return drafts.get(id);
}

export function renderAttachments() {
  if (!state.space) return;
  const draft = attachmentDraft(state.space.id);
  cards.innerHTML = draft.items.map((a, index) => {
    const icon = a.kind === 'image' ? `<img alt="" src="${url(state.space.id, a.id)}">` : ICON.file;
    return `<span class="attachment-card">${icon}<span title="${esc(a.name)}">${esc(a.name)}</span>
      <button type="button" data-remove="${index}" aria-label="${tr('删除 {0}', [esc(a.name)])}" ${a.busy || draft.sending ? 'disabled' : ''}>×</button></span>`;
  }).join('');
  cards.hidden = !draft.items.length;
  $('#sendBtn').disabled = draft.sending || draft.items.some((a) => a.busy);
}

function screenshotName(file) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  const time = pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  const ext = file.type === 'image/jpeg' ? 'jpg' : file.type.slice(6);
  return tr('截图-{0}.{1}', [date + '-' + time, ext]);
}

function base64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(tr('无法读取附件')));
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    reader.readAsDataURL(file);
  });
}

async function upload(file, pasted) {
  const spaceId = state.space?.id;
  if (!spaceId || box.hidden) return;
  const draft = attachmentDraft(spaceId);
  const screenshot = pasted && /^image\/(png|jpeg|gif|webp)$/.test(file.type) && (!file.name || /^image(?:\.\w+)?$/i.test(file.name));
  const item = { name: screenshot ? screenshotName(file) : file.name, busy: true };
  draft.items.push(item);
  renderAttachments();
  try {
    if (file.size > 50 * 1024 * 1024) throw new Error(tr('单个文件不能超过 50 MB'));
    const body = { name: item.name, type: file.type, data: await base64(file) };
    const a = await api(url(spaceId), { method: 'POST', body });
    if (a.kind === 'image' && draft.items.filter((other) => other.kind === 'image').length >= 10) {
      await api(url(spaceId, a.id), { method: 'DELETE' });
      throw new Error(tr('每条消息最多 10 张图片'));
    }
    Object.assign(item, a, { busy: false });
  } catch (e) {
    draft.items.splice(draft.items.indexOf(item), 1);
    toast(e.message, 'error');
  }
  renderAttachments();
}

cards.addEventListener('click', async (e) => {
  const button = e.target.closest('[data-remove]');
  if (!button) return;
  const spaceId = state.space.id;
  const draft = attachmentDraft(spaceId);
  const item = draft.items[button.dataset.remove];
  item.busy = true;
  renderAttachments();
  try {
    await api(url(spaceId, item.id), { method: 'DELETE' });
    draft.items.splice(draft.items.indexOf(item), 1);
  } catch (err) { item.busy = false; toast(err.message, 'error'); }
  renderAttachments();
});

box.addEventListener('dragover', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  box.classList.add('drag-over');
});
box.addEventListener('dragleave', (e) => {
  if (!box.contains(e.relatedTarget)) box.classList.remove('drag-over');
});
box.addEventListener('drop', (e) => {
  box.classList.remove('drag-over');
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  for (const file of e.dataTransfer.files) upload(file, false);
});
$('#input').addEventListener('paste', (e) => {
  if (!e.clipboardData?.files.length) return;
  e.preventDefault();
  for (const file of e.clipboardData.files) upload(file, true);
});

export function messageAttachments(items) {
  if (!items?.length) return '';
  const buttons = items.map((a) => a.kind === 'image'
    ? `<button type="button" class="image-thumb" data-preview><img src="${url(state.space.id, a.id)}" alt="${esc(a.name)}"></button>`
    : `<button type="button" class="change-chip" data-attachment-path="${esc(a.path)}">${ICON.file}${esc(a.path)}</button>`);
  return `<div class="message-attachments">${buttons.join('')}</div>`;
}

$('#messages').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-attachment-path]');
  if (chip) { state.files.tab = 'files'; openFile(chip.dataset.attachmentPath); }
  const img = e.target.closest('[data-preview]')?.querySelector('img');
  if (img) { preview.replaceChildren(img.cloneNode()); preview.showModal(); }
});
preview.addEventListener('click', () => preview.close());
preview.addEventListener('close', () => preview.replaceChildren());
