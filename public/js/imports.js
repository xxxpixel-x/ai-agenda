// 导入外部 AI 对话
import { activitiesHtml, findMsg, input, memberOf, renderHeader, updateMessage } from './chat.js';
import { refreshEngines, showModal } from './engines.js';
import { openFile, renderFilesBody, renderFilesPanel } from './files.js';
import { $, $$, ICON, api, authorName, clock, diffHtml, engineOf, esc, getLanguage, md, relTime, state, store, toast, tr } from './util.js';

// ---------------- 导入外部 AI 对话 ----------------
const MODE_LABEL = { full: tr('全部原文'), from: tr('从某一条开始'), summary: tr('早期压成摘要'), handoff: tr('写交接文档'), topic: tr('按主题') };
export const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\s]+/g, ' ').trim().slice(0, 40);
export const samePath = (a, b) => !!a && !!b && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
const folderName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
export const wan = (n) => getLanguage() === 'en' ? tr('{0} 字', [n.toLocaleString('en')]) : (n < 10000 ? tr('{0} 字', [n]) : tr('{0} 万字', [(n / 10000).toFixed(1)]));
const importNew = {}; // 导入块 id -> 原对话里的新条数

/** 选一段对话。cwd：当前空间的共享文件夹，默认只列同文件夹的。 */
export function openSessionPicker({ cwd } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal picker';
    dlg.innerHTML = `<div class="modal-inner">
      <div class="modal-head"><h3>${tr('选择对话')}</h3><button class="icon-btn" type="button" data-act="close">${ICON.close}</button></div>
      <div class="picker-bar"><input id="pkQ" placeholder="${tr('搜索')}"><div class="seg" id="pkScope" hidden>
        <button type="button" data-scope="here">${tr('同文件夹')}</button><button type="button" data-scope="all">${tr('全部')}</button></div>
        <button class="btn sm" type="button" data-act="paste">${tr('粘贴或选文件')}</button></div>
      <div class="modal-body picker-list" id="pkList"><span class="typing"><i></i><i></i><i></i></span></div>
      <div class="modal-body pk-paste" id="pkPaste" hidden><textarea id="pkText" placeholder="${tr('把对话粘贴到这里，或把导出的文件拖进来')}"></textarea>
        <div class="pk-paste-foot"><button class="btn" type="button" data-act="file">${tr('选择文件…')}</button><button class="btn primary" type="button" data-act="paste-go">${tr('下一步')}</button></div>
        <input type="file" id="pkFile" hidden accept=".json,.jsonl,.md,.markdown,.txt,.zip"></div></div>`;
    document.body.appendChild(dlg);
    let result = null;
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    dlg.showModal();

    let all = [];
    let scope = 'all';
    const render = () => {
      const q = $('#pkQ', dlg).value.trim().toLowerCase();
      const list = all.filter((s) => (scope === 'all' || samePath(s.cwd, cwd)) && (!q || `${s.title} ${s.cwd}`.toLowerCase().includes(q))).slice(0, 200);
      $$('#pkScope button', dlg).forEach((b) => b.classList.toggle('active', b.dataset.scope === scope));
      $('#pkList', dlg).innerHTML = list.length ? list.map((s) => `<button type="button" class="pk-row" data-id="${esc(s.id)}" data-source="${esc(s.source)}" style="--c:${engineOf(s.engine)?.color || '#999'}">
          <b>${esc(s.title)}</b><span><i></i>${[esc(s.sourceLabel), esc(folderName(s.cwd)), relTime(s.updatedAt)].filter(Boolean).join(' · ')}</span></button>`).join('')
        : `<div class="empty-list">${tr('没有对话')}</div>`;
    };
    const showPaste = (on) => {
      $('#pkPaste', dlg).hidden = !on;
      $('#pkList', dlg).hidden = on;
      $('.picker-bar', dlg).hidden = on;
      if (on) $('#pkText', dlg).focus();
    };
    // 粘贴的文字或文件交给后台整理；一个导出文件里有多段对话时，回到列表里选一段
    const stage = async (body) => {
      const go = $('[data-act=paste-go]', dlg);
      go.disabled = true;
      try {
        const list = await api('/api/import/paste', { method: 'POST', body });
        if (list.length === 1) { result = list[0]; dlg.close(); return; }
        all = list;
        scope = 'all';
        $('#pkScope', dlg).hidden = true;
        $('[data-act=paste]', dlg).hidden = true;
        $('#pkQ', dlg).value = '';
        showPaste(false);
        render();
      } catch (e) { toast(e.message, 'error'); } finally { go.disabled = false; }
    };
    const stageFile = async (file) => {
      if (!file) return;
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      stage({ data: btoa(bin), name: file.name });
    };
    dlg.addEventListener('input', (ev) => { if (ev.target.id === 'pkQ') render(); });
    dlg.addEventListener('change', (ev) => { if (ev.target.id === 'pkFile') stageFile(ev.target.files[0]); });
    dlg.addEventListener('dragover', (ev) => ev.preventDefault());
    dlg.addEventListener('drop', (ev) => { ev.preventDefault(); showPaste(true); stageFile(ev.dataTransfer.files[0]); });
    dlg.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-act=close]')) { dlg.close(); return; }
      if (ev.target.closest('[data-act=paste]')) { showPaste(true); return; }
      if (ev.target.closest('[data-act=file]')) { $('#pkFile', dlg).click(); return; }
      if (ev.target.closest('[data-act=paste-go]')) {
        const text = $('#pkText', dlg).value;
        if (text.trim()) stage({ text }); else $('#pkText', dlg).focus();
        return;
      }
      const sc = ev.target.closest('[data-scope]');
      if (sc) { scope = sc.dataset.scope; render(); return; }
      const row = ev.target.closest('.pk-row');
      if (row) { result = all.find((s) => s.id === row.dataset.id && s.source === row.dataset.source); dlg.close(); }
    });
    api('/api/import/sessions').then((list) => {
      if ($('[data-act=paste]', dlg).hidden) return; // 已经换成了文件里的对话
      all = list;
      if (cwd && all.some((s) => samePath(s.cwd, cwd))) { scope = 'here'; $('#pkScope', dlg).hidden = false; }
      render();
      $('#pkQ', dlg).focus();
    }).catch((e) => { $('#pkList', dlg).innerHTML = `<div class="err">${esc(e.message)}</div>`; });
  });
}

/** 导入方式（以及已有空间里的对应成员、由谁整理）。members 不给表示新建空间。 */
export function importOptionsHtml(d, { members = null, cwd = '' } = {}) {
  const claude = !!engineOf(d.engine)?.continuesImports;
  const modes = Object.keys(MODE_LABEL).map((k) => `<label class="choice"><input type="radio" name="impMode" value="${k}" ${k === d.auto ? 'checked' : ''}>
    <span><b>${MODE_LABEL[k]}</b>${k === 'from' ? `<select id="impFrom">${d.starts.map((s) => `<option value="${s.i}">${esc(s.text)}</option>`).join('')}</select>` : ''}${k === 'topic' ? `<input id="impTopic" maxlength="40" placeholder="${tr('例如：剧本')}">` : ''}</span></label>`).join('');
  let extra = '';
  if (members) {
    const busy = (m) => claude && !!state.space?.memberState?.[m.id]?.importId;
    const same = members.filter((m) => m.engine === d.engine && !busy(m));
    const label = engineOf(d.engine)?.defaultName;
    // 来源在 Agenda 里没有对应的 AI 类型（粘贴的、Trae 等）时，只导入文字，不选成员
    if (label) extra += `<div class="field"><div class="label">${tr('对应成员')}</div><select id="impMember">${same.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}<option value="">${tr('新加一个 {0}', [esc(label)])}</option><option value="none">${tr('不加')}</option></select></div>`;
    const others = [...members.filter((m) => m.engine !== d.engine), ...members.filter((m) => m.engine === d.engine)];
    if (others.length) extra += `<div class="field" id="impWriterRow" data-claude="${claude ? 1 : ''}"><div class="label">${tr('由谁整理')}</div><select id="impWriter">${others.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></div>`;
  }
  const warn = members && claude && d.cwd && !samePath(d.cwd, cwd)
    ? `<div class="note warn">${tr('原对话在 {0}，和共享文件夹不同，原对话里的文件路径可能对不上。', [esc(d.cwd)])}</div>` : '';
  return `<div class="field"><div class="choices">${modes}</div></div>${extra}${warn}`;
}

export function bindImportOptions(root, onChange) {
  const sync = () => {
    const mode = $('input[name=impMode]:checked', root)?.value;
    const topic = mode === 'topic';
    const sel = $('#impMember', root);
    const none = sel && $('option[value=none]', sel);
    if (none) {
      none.hidden = none.disabled = !topic; // “不加”只在按主题时可选
      if (!topic && sel.value === 'none') sel.selectedIndex = 0;
    }
    const w = $('#impWriterRow', root);
    // Claude 接续时由它自己整理；不加它（按主题）时才要选
    if (w) w.hidden = w.dataset.claude ? !(topic && sel?.value === 'none') : !(mode === 'summary' || mode === 'handoff' || topic);
    onChange?.();
  };
  root.addEventListener('change', (e) => {
    if (e.target.id === 'impFrom') $('input[name=impMode][value=from]', root).checked = true;
    sync();
  });
  root.addEventListener('focusin', (e) => {
    if (e.target.id !== 'impTopic') return;
    $('input[name=impMode][value=topic]', root).checked = true;
    sync();
  });
  root.addEventListener('input', (e) => { if (e.target.id === 'impTopic') onChange?.(); });
  sync();
}

export function readImportOptions(root, d) {
  const mode = $('input[name=impMode]:checked', root).value;
  return {
    source: d.source,
    sessionId: d.id,
    mode,
    fromIndex: mode === 'from' ? $('#impFrom', root).value : undefined,
    topic: mode === 'topic' ? $('#impTopic', root).value.trim() : undefined,
    memberId: $('#impMember', root)?.value ?? '',
    writerId: $('#impWriter', root)?.value,
  };
}

export async function openImportModal() {
  const sp = state.space;
  if (!sp) return;
  await refreshEngines();
  const s = await openSessionPicker({ cwd: sp.workspacePath });
  if (!s) return;
  let d;
  try { d = await api(`/api/import/session?source=${s.source}&id=${encodeURIComponent(s.id)}`); } catch (e) { toast(e.message, 'error'); return; }
  const dlg = showModal(`<div class="modal-inner">
    <div class="modal-head"><h3>${esc(d.title)}</h3><button class="icon-btn" type="button" data-act="close">${ICON.close}</button></div>
    <div class="modal-body"><div class="hint imp-stat">${tr('{0} · {1} 条 · {2}', [esc(d.sourceLabel), d.count, wan(d.chars)])}</div>
      ${importOptionsHtml(d, { members: sp.members, cwd: sp.workspacePath })}</div>
    <div class="modal-foot"><button class="btn" type="button" data-act="close">${tr('取消')}</button><button class="btn primary" type="button" data-act="go">${tr('导入')}</button></div>
  </div>`);
  bindImportOptions(dlg);
  dlg.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'close') dlg.close();
    if (b.dataset.act === 'go') {
      const opts = readImportOptions(dlg, d);
      if (opts.mode === 'topic' && !opts.topic) { toast(tr('请填写主题'), 'error'); $('#impTopic', dlg).focus(); return; }
      b.disabled = true;
      try {
        await api(`/api/spaces/${sp.id}/imports`, { method: 'POST', body: opts });
        dlg.close();
      } catch (e) { toast(e.message, 'error'); b.disabled = false; }
    }
  });
}

const ACT_KIND = [[/^(读取|Read )/i, 'read'], [/^(修改|写入|新建|删除|Edit |Write |Create |Delete )/i, 'edit'], [/^(搜索|打开网页|Search |Open page )/i, 'search'], [/^(运行|Run )/i, 'command']];
const actKind = (label) => ACT_KIND.find(([re]) => re.test(label))?.[1] || 'tool';

export function importHtml(m, prefix = 'm') {
  const color = memberOf(m.memberId)?.color || engineOf(m.source)?.color || '#888';
  const fresh = !m.parentId && m.status === 'ready' && importNew[m.id];
  const topic = m.mode === 'topic';
  const pend = m.briefPending;
  const foot = [
    m.status === 'writing' ? `<span class="typing"><i></i><i></i><i></i>${tr('&nbsp;正在整理')}</span>` : '',
    pend ? `<span class="imp-pend">${briefChange(pend)}</span>
      <button type="button" class="btn sm" data-imp="diff" data-id="${m.id}">${tr('看对比')}</button>
      <button type="button" class="btn sm primary" data-imp="accept" data-id="${m.id}">${tr('采用')}</button>
      <button type="button" class="btn sm" data-imp="revert" data-id="${m.id}">${tr('撤销')}</button>` : '',
    topic && m.brief && m.briefText == null && m.status === 'ready' ? `<span class="hint">${tr('简报文件已删除')}</span>` : '',
    fresh && !pend ? `<button type="button" class="btn sm" data-imp="refresh" data-id="${m.id}">${tr('补导 {0} 条新内容', [importNew[m.id]])}</button>` : '',
    m.error ? `<span class="err">${esc(m.error)}</span><button type="button" class="btn sm" data-imp="retry" data-id="${m.id}" data-mode="${m.mode}">${tr('重试')}</button>` : '',
  ].join('');
  const head = topic
    ? `<span class="imp-src">${tr('主题')}</span><b>${esc(m.topic)}</b><span class="m">${tr('{0} · {1} 条 · {2}', [esc(m.sourceLabel), m.total, clock(m.ts)])}</span>`
    : `<span class="imp-src">${esc(m.parentId ? tr('补导') : m.sourceLabel)}</span><b>${esc(m.title)}</b><span class="m">${tr('{0} 条 · {1}', [m.parentId ? m.entries.length : m.total, clock(m.ts)])}</span>`;
  return `<div class="msg import" id="${prefix}-${m.id}" style="--c:${color}">
    <details class="imp" data-import="${m.id}">
      <summary>${head}</summary>
      <div class="imp-body"></div>
    </details>${foot ? `<div class="imp-foot">${foot}</div>` : ''}
  </div>`;
}

// 两个视图共用同一条导入记录，任务推送只更新任务区，不打断正在阅读的对话。
export function renderTaskImports() {
  const imports = state.space.messages.filter((m) => m.kind === 'import');
  $('#taskImportList').innerHTML = imports.map((m) => importHtml(m, 'task-m')).join('');
  $('#taskImports').hidden = !imports.length;
}

export function updateTaskImport(m) {
  const el = document.getElementById(`task-m-${m.id}`);
  if (el) replaceImport(el, m, 'task-m');
  else $('#taskImportList').insertAdjacentHTML('beforeend', importHtml(m, 'task-m'));
  $('#taskImports').hidden = false;
}

export function replaceImport(el, m, prefix = 'm') {
  const open = $('details.imp', el)?.open;
  const rawOpen = $('details.imp-raw', el)?.open;
  const scroll = $('.imp-body', el)?.scrollTop || 0;
  el.outerHTML = importHtml(m, prefix);
  if (!open) return;
  const next = document.getElementById(`${prefix}-${m.id}`);
  const details = $('details.imp', next);
  details.open = true;
  fillImportBody(details, m);
  const raw = $('details.imp-raw', next);
  if (rawOpen && raw) { raw.open = true; raw.lastElementChild.innerHTML = entriesHtml(m); }
  $('.imp-body', next).scrollTop = scroll;
}

function entriesHtml(m) {
  return m.entries.map((e) => {
    const acts = e.acts.map((label) => ({ kind: actKind(label), label }));
    return `<div class="imp-e ${e.role}"><div class="n">${e.role === 'user' ? tr('我') : esc(m.name)}</div>${activitiesHtml(acts, false)}${e.text ? `<div class="md">${md(e.text)}</div>` : ''}</div>`;
  }).join('');
}

function importBodyHtml(m) {
  if (m.mode === 'topic') {
    const parts = [];
    if (m.brief) parts.push(`<button type="button" class="change-chip" data-open-file="${esc(m.brief)}">${ICON.file}${esc(m.brief)}</button>`);
    if (m.briefText) parts.push(`<div class="imp-summary md">${md(m.briefText)}</div>`);
    parts.push(`<details class="imp-raw" data-raw="${m.id}"><summary>${tr('原对话「{0}」· {1} 条', [esc(m.title), m.total])}</summary><div></div></details>`);
    return parts.join('');
  }
  const parts = [];
  if (m.summary) parts.push(`<div class="imp-summary md">${md(m.summary)}</div>`);
  if (m.handoff) parts.push(`<button type="button" class="change-chip" data-open-file="${esc(m.handoff)}">${ICON.file}${esc(m.handoff)}</button>`);
  if (m.skipped && !m.summary && !m.handoff && m.status !== 'writing') parts.push(`<div class="note">${tr('前面 {0} 条没有导入', [m.skipped])}</div>`);
  return parts.join('') + entriesHtml(m);
}

/** 打开空间后，看看导入的原对话有没有新内容。 */
export function checkImports() {
  const sp = state.space;
  for (const m of sp.messages) {
    if (m.kind !== 'import' || m.parentId || m.status !== 'ready') continue;
    api(`/api/spaces/${sp.id}/imports/${m.id}/check`).then((r) => {
      if (state.space !== sp) return;
      const n = r.newCount || 0;
      if ((importNew[m.id] || 0) === n) return;
      importNew[m.id] = n;
      updateMessage(m);
    }).catch(() => {});
  }
}

const briefChange = (p) => tr('{0}{1}了简报', [p.by === '外部修改' ? tr('有人在软件外') : `${esc(authorName(p.by))} `, p.after == null ? tr('删除') : tr('改')]);

export async function briefAction(id, action) {
  try { await api(`/api/spaces/${state.space.id}/imports/${id}/brief`, { method: 'POST', body: { action } }); } catch (e) { toast(e.message, 'error'); }
}

function openBriefDiff(id) {
  state.files.view = { type: 'briefdiff', id };
  if (!state.files.open) { state.files.open = true; store('rt:filesOpen', true); renderHeader(); }
  renderFilesPanel();
}

/** 简报上待确认的修改：确认过的版本 → 文件现在的内容。 */
export function renderBriefDiff(body, v) {
  const m = findMsg(v.id);
  const p = m?.briefPending;
  if (!p) { state.files.view = null; renderFilesBody(); return; } // 采用或撤销后回到文件列表
  body.innerHTML = `<div class="diff-view">
    <div class="editor-head"><button class="icon-btn" type="button" data-act="back" title="${tr('返回')}">${ICON.back}</button>
      <span class="ep">${briefChange(p)} · ${esc(m.brief)}</span>
      <button class="btn sm primary" type="button" data-brief-act="accept">${tr('采用')}</button><button class="btn sm" type="button" data-brief-act="revert">${tr('撤销')}</button></div>
    <div class="diff">${diffHtml(m.briefText, p.after ?? '')}</div></div>`;
}

function openSharedFile(p) {
  state.files.open = true;
  store('rt:filesOpen', true);
  state.files.tab = 'files';
  renderFilesPanel();
  renderHeader();
  openFile(p);
}

// 展开时才渲染内容（长对话有几百条）
function fillImportBody(details, m) {
  const body = $('.imp-body', details);
  if (body.dataset.loaded) return;
  body.innerHTML = importBodyHtml(m);
  body.dataset.loaded = 'true';
}

$('#spaceView').addEventListener('toggle', (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.open) return;
  if (d.dataset.raw) { const m = findMsg(d.dataset.raw); if (m) d.lastElementChild.innerHTML = entriesHtml(m); return; }
  if (!d.dataset.import) return;
  const m = findMsg(d.dataset.import);
  if (m) fillImportBody(d, m);
}, true);

$('#spaceView').addEventListener('click', async (e) => {
  const f = e.target.closest('[data-open-file]');
  if (f) { openSharedFile(f.dataset.openFile); return; }
  const b = e.target.closest('[data-imp]');
  if (!b || !state.space) return;
  if (b.dataset.imp === 'diff') { openBriefDiff(b.dataset.id); return; }
  if (b.dataset.imp === 'accept' || b.dataset.imp === 'revert') { briefAction(b.dataset.id, b.dataset.imp); return; }
  const base = `/api/spaces/${state.space.id}/imports/${b.dataset.id}`;
  b.disabled = true;
  try {
    if (b.dataset.imp === 'refresh') {
      const r = await api(`${base}/refresh`, { method: 'POST', body: {} });
      delete importNew[b.dataset.id];
      const m = findMsg(b.dataset.id);
      if (m) updateMessage(m);
      if (r.grown && confirm(tr('导入的内容已经变长，要重新压缩吗？'))) await api(`${base}/recompress`, { method: 'POST', body: {} });
    } else if (b.dataset.imp === 'retry') {
      await api(`${base}/recompress`, { method: 'POST', body: { mode: b.dataset.mode } });
    }
  } catch (err) { toast(err.message, 'error'); b.disabled = false; }
});

