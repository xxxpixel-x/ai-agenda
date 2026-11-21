import { $, $$, ICON, api, esc, getLanguage, toast, tr } from '../util.js';
import { register } from '../slots.js';

export const lib = (route, method = 'GET', body) => api('/api/library/' + route, { method, body });
export const local = value => typeof value === 'string' ? value : value?.[getLanguage()] || '';
export const chip = (text, tone = '') => `<span class="lib-chip ${tone}">${esc(text)}</span>`;
export const modeChip = mode => chip(mode === 'readonly' ? tr('只读') : tr('会改东西'), mode === 'mutating' ? 'warn' : '');
export const button = (act, label, id = '', cls = '') => `<button type="button" class="btn sm ${cls}" data-lib="${esc(act)}" data-id="${esc(id)}">${esc(label)}</button>`;
export const field = (label, control) => `<label class="field"><span class="label">${esc(label)}</span>${control}</label>`;
export const input = (key, value = '', attrs = '') => `<input name="${key}" value="${esc(value)}" ${attrs}>`;
export const options = (rows, selected) => rows.map(([id,label]) => `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(label)}</option>`).join('');
export const checks = (key, items, selected = []) => `<div class="lib-chips">${items.map(x => `<label class="lib-check"><input type="checkbox" name="${key}" value="${esc(x.id)}" ${selected.includes(x.id) ? 'checked' : ''}>${esc(local(x.name))}</label>`).join('')}</div>`;
export const checked = (form, name) => $$(`[name="${name}"]:checked`, form).map(el => el.value);
export const value = (form, name) => form.elements.namedItem(name)?.value || '';
export const report = e => toast(e.message, 'error');

export function openSubModal(html) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal sub-modal';
  dialog.innerHTML = html;
  const title = dialog.querySelector('h3');
  if (title) { title.id = 'sub-' + crypto.randomUUID(); dialog.setAttribute('aria-labelledby', title.id); }
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
  return dialog;
}

export function formDialog(title, html, submit, { confirm = tr('保存'), init, extra = '' } = {}) {
  const dlg = openSubModal(`<form class="modal-inner"><header class="modal-head"><h3>${esc(title)}</h3></header>
    <div class="modal-body">${html}<p class="err" role="alert" hidden></p></div>
    <footer class="modal-foot">${extra}<span class="grow"></span><button class="btn" type="button" data-cancel>${tr('取消')}</button>
    <button class="btn primary" type="submit">${esc(confirm)}</button></footer></form>`);
  const form = $('form', dlg), save = $('[type=submit]', dlg);
  let result = null;
  init?.(form);
  $('[data-cancel]', dlg).onclick = () => dlg.close();
  form.onsubmit = async e => {
    e.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    try { result = (await submit(form)) ?? true; dlg.close(); }
    catch (err) { const hint = $('[role=alert]', dlg); hint.textContent = err.message; hint.hidden = false; }
    finally { save.disabled = false; }
  };
  return new Promise(resolve => dlg.addEventListener('close', () => resolve(result), { once: true }));
}

export function choice(title, html, items) {
  const dlg = openSubModal(`<div class="modal-inner"><header class="modal-head"><h3>${esc(title)}</h3></header>
    <div class="modal-body">${html}<div class="lib-choices">${items.map(([id,label]) => button('choose',label,id)).join('')}</div></div>
    <footer class="modal-foot">${button('cancel', tr('取消'))}</footer></div>`);
  dlg.onclick = e => { const b = e.target.closest('[data-lib]'); if (b) dlg.close(b.dataset.id); };
  return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue || null), { once: true }));
}

export function libraryPage(id, label, icon, order, render) {
  register('library', { id, label, icon, order, render(el) {
    const refresh = () => Promise.resolve(render(el, refresh)).catch(e => { el.textContent = e.message; });
    refresh();
  } });
}
export function actions(el, fn) {
  el.onclick = async e => {
    const b = e.target.closest('[data-lib]');
    if (!b || b.disabled) return;
    b.disabled = true;
    try { await fn(b.dataset.lib, b.dataset.id, b); } catch (err) { report(err); }
    finally { b.disabled = false; }
  };
}
export const exportLink = (group,id) => `<a class="btn sm" href="/api/library/${group}/${encodeURIComponent(id)}/export" download>${ICON.export}${tr('导出 Markdown')}</a>`;
export async function importMarkdown() {
  return formDialog(tr('导入 Markdown'), field(tr('选择文件'), '<input type="file" accept=".md,text/markdown">')
    + field(tr('Markdown 文本'), '<textarea name="markdown" rows="8"></textarea>'), async form => {
    const file = $('[type=file]',form).files[0];
    const markdown = file ? await file.text() : value(form,'markdown');
    const p = await lib('import/preview','POST',{ markdown });
    const names = [p.team?.name, ...p.roles.map(r => r.name)].filter(Boolean);
    return formDialog(tr('确认导入'), '<ul>' + names.map(n => '<li>' + esc(local(n)) + '</li>').join('') + '</ul>'
      + p.warnings.map(w => '<p>' + esc(w) + '</p>').join('')
      + (p.conflicts.length ? field(tr('覆盖同名的自建资源'), '<input type="checkbox" name="overwrite">') : ''),
    f => lib('import/commit','POST',{ markdown, overwrite: !!f.elements.overwrite?.checked }), { confirm: tr('导入') });
  }, { confirm: tr('预览') });
}
export function githubDialog() {
  return formDialog(tr('从 GitHub 安装 skill'), field(tr('仓库路径'), input('repo','','required placeholder="owner/repo/path"')),
    form => lib('skills/install','POST',{ repo: value(form,'repo').trim() }), { confirm: tr('安装') });
}

export async function installItem(group, item) {
  if (group === 'roles' || group === 'teams') return lib('marketplace/install-' + (group === 'roles' ? 'role' : 'team'),'POST',{ id: item.id });
  if (group === 'skills') return lib('skills/install','POST',{ id: item.id, ...(item.installType === 'github' && { repo: item.repo, subdir: item.subdir }) });
  const keys = item.envKeys || [];
  const install = (form) => {
    const env = {}, headers = { ...item.headers };
    keys.forEach((k,i) => { const v = form && value(form,'v' + i); if (v) (k.header ? headers : env)[k.key] = v; });
    return lib('mcp/install','POST',{ id: item.id, name: local(item.name), description: local(item.summary) || item.description,
      mode: item.mode, transport: item.transport, command: item.command, args: item.args, url: item.url, source: item.sourceUrl,
      env, headers, envKeys: keys, secretKeys: keys.filter(k => k.secret).map(k => k.key) });
  };
  return keys.length ? formDialog(local(item.name), keys.map((k,i) => field(local(k.label) || k.key,
    input('v' + i,'', (k.secret ? 'type="password" autocomplete="new-password" ' : '') + (k.required ? 'required' : '')))).join(''), install, { confirm: tr('安装') }) : install();
}
