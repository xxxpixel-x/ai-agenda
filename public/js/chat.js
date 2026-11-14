// 空间视图：聊天消息、成员标签、命令审批、输入框
import { loadFiles, loadHistory, onFilesChanged, openChange, renderFilesBody, renderFilesPanel } from './files.js';
import { checkImports, importHtml, openImportModal, renderTaskImports, replaceImport, updateTaskImport } from './imports.js';
import { refreshSpacesSoon, renderSpaceList } from './sidebar.js';
import { effortChoices, effortSelect, modelChoices, openSpaceSettings } from './space-form.js';
import { applyView, onRunEvent } from './tasks.js';
import { $, $$, ACT_ICON, ICON, api, avatarHtml, clock, engineOf, esc, localizeActivity, md, state, store, toast, tr } from './util.js';

// ---------------- 空间视图 ----------------
export function closeStream() { if (state.es) { state.es.close(); state.es = null; } }

export function showWelcome() {
  closeStream();
  state.space = null;
  $('#spaceView').hidden = true;
  $('#filesPanel').hidden = true;
  $('#welcomeView').hidden = false;
  $('#mobileTitle').textContent = 'Agenda';
  document.title = 'Agenda';
  renderSpaceList();
}

export function openSpace(id) {
  closeStream();
  $('#welcomeView').hidden = true;
  $('#spaceView').hidden = false;
  if (state.space?.id !== id) {
    state.space = null;
    $('#messages').innerHTML = '';
    $('#spaceTitle').textContent = tr('加载中…');
    state.files.view = null;
    state.files.expanded = new Set();
  }
  const es = new EventSource(`/api/spaces/${id}/events`);
  state.es = es;
  es.onmessage = (e) => { try { handleEvent(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) { toast(tr('这个空间不存在或已被删除'), 'error'); location.hash = '#/'; }
  };
}

export const findMsg = (id) => state.space?.messages.find((m) => m.id === id);
export const memberOf = (id) => state.space?.members.find((m) => m.id === id);

function handleEvent(ev) {
  const sp = state.space;
  switch (ev.type) {
    case 'snapshot': {
      const first = !sp || sp.id !== ev.space.id;
      state.space = ev.space;
      if (first) state.view = ev.space.run ? 'task' : 'chat';
      renderSpace();
      if (first) { loadFiles(); loadHistory(); }
      break;
    }
    case 'message':
      if (!sp) return;
      sp.messages.push(ev.message);
      appendMessage(ev.message);
      refreshSpacesSoon();
      break;
    case 'delta': {
      const m = findMsg(ev.id);
      if (!m) return;
      m.text += ev.text;
      scheduleUpdate(m.id);
      break;
    }
    case 'activity': {
      const m = findMsg(ev.id);
      if (!m) return;
      (m.activities ||= []).push(ev.activity);
      scheduleUpdate(m.id);
      break;
    }
    case 'message_done': {
      if (!sp) return;
      const i = sp.messages.findIndex((x) => x.id === ev.message.id);
      if (i >= 0) sp.messages[i] = ev.message; else sp.messages.push(ev.message);
      pending.delete(ev.message.id);
      updateMessage(ev.message);
      if (state.files.view?.type === 'briefdiff' && state.files.view.id === ev.message.id) renderFilesBody();
      refreshSpacesSoon();
      break;
    }
    case 'state':
      if (!sp) return;
      sp.running = ev.running;
      sp.speaking = ev.speaking;
      sp.queue = ev.queue;
      renderHeader();
      renderMembersBar();
      refreshSpacesSoon();
      break;
    case 'files_changed':
      onFilesChanged(ev.changes);
      break;
    case 'run':
      onRunEvent(ev.run);
      break;
    case 'approval': {
      const m = findMsg(ev.id);
      if (!m) return;
      const list = (m.approvals ||= []);
      const i = list.findIndex((a) => a.id === ev.approval.id);
      if (i >= 0) list[i] = ev.approval; else list.push(ev.approval);
      if (ev.allowedPrograms) sp.allowedPrograms = ev.allowedPrograms;
      if (ev.approval.status !== 'pending') noteDrafts.delete(ev.approval.id);
      scheduleUpdate(m.id);
      break;
    }
    case 'members':
      if (!sp) return;
      sp.members = ev.members;
      renderMembersBar();
      if (!$('#memberPop').hidden) renderMemberPop();
      break;
    case 'notice':
      toast(ev.text, ev.level);
      break;
  }
}

function renderSpace() {
  const sp = state.space;
  hideMemberPop();
  document.title = `${sp.title} · Agenda`;
  $('#mobileTitle').textContent = sp.title;
  $('#spaceTitle').textContent = sp.title;
  renderHeader();
  renderMembersBar();
  const box = $('#messages');
  box.innerHTML = '';
  const shown = sp.messages.filter((m) => !(m.kind === 'ai' && !m.streaming && !m.text && !m.error && !m.passed && !m.changes?.length));
  for (const m of shown) box.insertAdjacentHTML('beforeend', messageHtml(m));
  box.scrollTop = box.scrollHeight;
  renderTaskImports();
  renderSpaceList();
  renderFilesPanel();
  applyView();
  checkImports();
}

export function renderHeader() {
  const sp = state.space;
  const next = (sp.queue || []).map((id) => memberOf(id)?.name).filter(Boolean);
  const q = $('#queueInfo');
  q.textContent = next.length ? tr('接下来：{0}', [next.slice(0, 5).join(' → ')]) : '';
  q.hidden = !next.length;
  const btns = sp.running
    ? [['stop', tr('停止')], ...(sp.speaking ? [['skip', tr('跳过当前')]] : [])]
    : [['continue', tr('继续讨论')]];
  const icons = [['files', state.files.open ? tr('收起文件') : tr('共享文件'), state.files.open], ['import', tr('导入对话')], ['settings', tr('空间设置')], ['export', tr('导出')]];
  $('#spaceActions').innerHTML = btns.map(([a, l]) => `<button type="button" class="btn sm ${a === 'stop' ? 'danger' : ''}" data-act="${a}">${l}</button>`).join('')
    + icons.map(([a, l, on]) => `<button type="button" class="icon-btn ${on ? 'on' : ''}" data-act="${a}" title="${l}" aria-label="${l}">${ICON[a]}</button>`).join('');
}

// 「可运行命令」档下，没法在运行前先问你的命令行 AI 只能改文件
const cannotRun = (m) => { const e = engineOf(m.engine); return state.space?.access === 'run' && e?.kind === 'cli' && !e.approvals; };

function renderMembersBar() {
  const sp = state.space;
  const speaking = sp.speaking && findMsg(sp.speaking);
  $('#membersBar').innerHTML = sp.members.map((m) => {
    const e = engineOf(m.engine);
    const ok = !e || e.status?.ready !== false;
    return `<button type="button" class="person ${speaking?.memberId === m.id ? 'speaking' : ''} ${ok ? '' : 'off'}" style="--c:${m.color}" data-id="${m.id}"
      title="${esc(e.label || m.engineLabel)}${m.model ? ` · ${esc(m.model)}` : ''}${ok ? '' : `\n⚠ ${esc(e.status?.note || '')}`}">
      ${avatarHtml(m.engine, m.name)}${esc(m.name)}${cannotRun(m) ? `<small>${tr('不能运行命令')}</small>` : ''}</button>`;
  }).join('');
}

// ---- 点成员标签：换型号 / 思考档位，或者让 TA 现在发言 ----
let popMember = null;
function hideMemberPop() { $('#memberPop').hidden = true; popMember = null; }
function openMemberPop(chip) {
  const pop = $('#memberPop');
  popMember = chip.dataset.id;
  renderMemberPop();
  pop.hidden = false;
  const r = chip.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.top = `${r.bottom + 6}px`;
  $('select', pop)?.focus();
}
function renderMemberPop() {
  const m = memberOf(popMember);
  if (!m) { hideMemberPop(); return; }
  const e = engineOf(m.engine) || {};
  const st = e.status || {};
  const models = modelChoices(e);
  if (m.model && !models.some(([v]) => v === m.model)) models.unshift([m.model, '']);
  $('#memberPop').innerHTML = `
    <div class="mp-head">${avatarHtml(m.engine, m.name)}<b>${esc(m.name)}</b><span>${esc(e.label || m.engineLabel)}</span></div>
    ${st.ready === false ? `<div class="member-status warn">⚠ ${esc(st.note || tr('还不能用'))}</div>` : ''}
    ${cannotRun(m) ? `<div class="hint">${tr('它没法在运行命令前先问你，所以这一档只能读写文件。')}</div>` : ''}
    <select data-k="model" title="${tr('型号')}"><option value="">${esc(st.defaultModel ? tr('默认（{0}）', [st.defaultModel]) : tr('默认型号'))}</option>
      ${models.map(([v, l]) => `<option value="${esc(v)}" ${v === m.model ? 'selected' : ''}>${esc(l || v)}</option>`).join('')}</select>
    ${effortSelect(e, m)}
    <button class="btn sm block" type="button" data-act="ask">${tr('让 {0} 现在发言', [esc(m.name)])}</button>`;
}
$('#memberPop').addEventListener('change', async (e) => {
  const k = e.target.dataset.k;
  const m = memberOf(popMember);
  if (!k || !m) return;
  const body = { [k]: e.target.value };
  if (k === 'model' && !effortChoices(engineOf(m.engine) || {}, body.model).includes(m.effort || '')) body.effort = '';
  try { await api(`/api/spaces/${state.space.id}/members/${m.id}`, { method: 'PATCH', body }); } catch (err) { toast(err.message, 'error'); renderMemberPop(); }
});
$('#memberPop').addEventListener('click', async (e) => {
  if (!e.target.closest('[data-act="ask"]')) return;
  const id = popMember;
  hideMemberPop();
  try { await api(`/api/spaces/${state.space.id}/control`, { method: 'POST', body: { action: 'ask', memberId: id } }); } catch (err) { toast(err.message, 'error'); }
});
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#memberPop, .person')) hideMemberPop(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#memberPop').hidden) hideMemberPop(); });
window.addEventListener('resize', hideMemberPop);

// ---- 命令审批卡片 ----
const noteDrafts = new Map(); // 卡片上正在写的附言：id -> 文字（消息重绘时不丢）
const AP_DONE = { allowed: tr('已允许'), always: tr('已允许，以后不再问'), denied: tr('已拒绝'), cancelled: tr('已取消') };
function approvalHtml(a) {
  if (a.status !== 'pending') {
    const one = a.command.replace(/\s+/g, ' ');
    const note = a.note || a.reason;
    return `<div class="ap-done ${a.status}"><span>${AP_DONE[a.status] || a.status}</span><code title="${esc(a.command)}">${esc(one)}</code>${note ? `<span class="why" title="${esc(note)}">${esc(note)}</span>` : ''}</div>`;
  }
  return `<div class="approval" data-ap="${a.id}">
    <div class="ap-q">${tr('想运行')}</div>
    <pre class="ap-cmd">${esc(a.command)}</pre>
    <input class="ap-note" data-apr maxlength="500" placeholder="${tr('附一句话（可不填）')}" value="${esc(noteDrafts.get(a.id) || '')}">
    <div class="ap-actions"><button class="btn sm primary" type="button" data-apd="allow">${tr('允许')}</button>
      ${a.programs?.length ? `<button class="btn sm" type="button" data-apd="always">${tr('一直允许 {0}', [esc(a.programs.join('、'))])}</button>` : ''}
      <button class="btn sm" type="button" data-apd="deny">${tr('拒绝')}</button></div>
  </div>`;
}
const approvalsHtml = (m) => (m.approvals?.length ? `<div class="approvals">${m.approvals.map(approvalHtml).join('')}</div>` : '');
async function decide(card, decision) {
  const id = card.dataset.ap;
  $$('button, input', card).forEach((b) => { b.disabled = true; });
  try {
    await api(`/api/spaces/${state.space.id}/approvals/${id}`, { method: 'POST', body: { decision, note: noteDrafts.get(id) || '' } });
  } catch (err) { toast(err.message, 'error'); $$('button, input', card).forEach((b) => { b.disabled = false; }); }
}
$('#messages').addEventListener('input', (e) => {
  const card = e.target.closest('[data-ap]');
  if (card && e.target.matches('[data-apr]')) noteDrafts.set(card.dataset.ap, e.target.value);
});

export function activitiesHtml(acts, streaming) {
  if (!acts?.length) return '';
  const row = (a) => `<div class="act"><i>${ACT_ICON[a.kind] || ACT_ICON.tool}</i><span title="${esc(localizeActivity(a.label))}">${esc(localizeActivity(a.label))}</span></div>`;
  if (acts.length <= 5 || streaming) return `<div class="acts">${acts.slice(-5).map(row).join('')}${acts.length > 5 ? `<div class="act"><i></i><span>${tr('（共 {0} 步）', [acts.length])}</span></div>` : ''}</div>`;
  return `<details class="acts"><summary>${tr('{0} 个操作', [acts.length])}</summary>${acts.map(row).join('')}</details>`;
}

export function messageHtml(m) {
  if (m.kind === 'import') return importHtml(m);
  if (m.kind === 'user') {
    return `<div class="msg user" id="m-${m.id}"><span class="avatar me">${tr('我')}</span>
      <div class="msg-main"><div class="msg-head"><span class="n">${tr('我')}</span><span class="m">${clock(m.ts)}</span></div>
      <div class="bubble"><div class="md">${md(m.text)}</div></div></div></div>`;
  }
  const mem = memberOf(m.memberId);
  const color = mem?.color || engineOf(m.engine)?.color || '#888';
  if (m.passed && !m.streaming) {
    return `<div class="pass-line" id="m-${m.id}" style="--c:${color}"><b>${esc(m.name)}</b> ${tr('没有补充{0}', [m.changes?.length ? tr('，但修改了 {0} 个文件', [m.changes.length]) : ''])}</div>`;
  }
  const meta = [];
  if (m.durationMs) meta.push(tr('{0} 秒', [(m.durationMs / 1000).toFixed(0)]));
  if (m.model) meta.push(m.model);
  const last = m.activities?.[m.activities.length - 1];
  let body;
  if (m.streaming && !m.text) body = `<span class="typing"><i></i><i></i><i></i>&nbsp;${esc(last ? last.label : tr('思考中'))}</span>`;
  else body = m.text ? `<div class="md ${m.streaming ? 'cursor' : ''}">${md(m.text)}</div>` : '';
  const changes = m.changes?.length ? `<div class="changes">${m.changes.map((c) => `<button type="button" class="change-chip" data-change="${c.id}">${ICON.file}${esc(c.path)} ${c.created ? `<span class="plus">${tr('新建')}</span>` : c.deleted ? `<span class="minus">${tr('删除')}</span>` : `<span class="plus">+${c.added}</span><span class="minus">−${c.removed}</span>`}</button>`).join('')}</div>` : '';
  return `<div class="msg ai ${m.error ? 'error' : ''}" id="m-${m.id}" style="--c:${color}">
    ${avatarHtml(mem?.engine || m.engine, m.name)}
    <div class="msg-main">
      <div class="msg-head"><span class="n">${esc(m.name)}</span><span class="m" title="${esc(meta.join(' · '))}">${clock(m.ts)}</span></div>
      <div class="bubble">${activitiesHtml(m.activities, m.streaming)}${approvalsHtml(m)}${body}
        ${m.interrupted ? `<div class="note">${tr('（发言被中断）')}</div>` : ''}
        ${m.note ? `<div class="note">${esc(m.note)}</div>` : ''}
        ${m.error ? `<div class="err">⚠ ${esc(m.error)}</div>` : ''}${changes}</div>
    </div></div>`;
}

const nearBottom = () => { const b = $('#messages'); return b.scrollHeight - b.scrollTop - b.clientHeight < 140; };
const scrollToBottom = () => { const b = $('#messages'); b.scrollTop = b.scrollHeight; };

function appendMessage(m) {
  const stick = nearBottom() || m.kind === 'user';
  $('#messages').insertAdjacentHTML('beforeend', messageHtml(m));
  if (m.kind === 'import') updateTaskImport(m);
  if (stick) scrollToBottom();
}
export function updateMessage(m) {
  if (m.kind === 'import') updateTaskImport(m);
  const el = document.getElementById(`m-${m.id}`);
  const stick = nearBottom();
  const hidden = m.kind === 'ai' && !m.streaming && !m.text && !m.error && !m.passed && !m.changes?.length && !m.interrupted;
  if (!el) { if (!hidden) appendMessage(m); return; }
  if (hidden) { el.remove(); return; }
  // 正在卡片上写附言时消息重绘了：把光标放回原处
  const typing = el.contains(document.activeElement) && document.activeElement.matches('[data-apr]')
    ? { id: document.activeElement.closest('[data-ap]').dataset.ap, at: document.activeElement.selectionStart } : null;
  if (m.kind === 'import') replaceImport(el, m);
  else el.outerHTML = messageHtml(m);
  if (typing) {
    const box = $(`[data-ap="${typing.id}"] [data-apr]`);
    if (box) { box.focus(); box.setSelectionRange(typing.at, typing.at); }
  }
  if (stick) scrollToBottom();
}
export const pending = new Set();
let rafId = 0;
function scheduleUpdate(id) {
  pending.add(id);
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    for (const x of pending) { const m = findMsg(x); if (m) updateMessage(m); }
    pending.clear();
  });
}

$('#spaceActions').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || !state.space) return;
  const act = b.dataset.act;
  if (act === 'files') { state.files.open = !state.files.open; store('rt:filesOpen', state.files.open); renderFilesPanel(); renderHeader(); return; }
  if (act === 'settings') { openSpaceSettings(); return; }
  if (act === 'import') { openImportModal(); return; }
  if (act === 'export') { location.href = `/api/spaces/${state.space.id}/export`; return; }
  b.disabled = true;
  try { await api(`/api/spaces/${state.space.id}/control`, { method: 'POST', body: { action: act } }); } catch (err) { toast(err.message, 'error'); b.disabled = false; }
});
$('#membersBar').addEventListener('click', (e) => {
  const p = e.target.closest('.person');
  if (!p || !state.space) return;
  if (popMember === p.dataset.id) hideMemberPop(); else openMemberPop(p);
});
$('#membersBar').addEventListener('scroll', hideMemberPop);
$('#messages').addEventListener('click', (e) => {
  const c = e.target.closest('[data-change]');
  if (c) openChange(c.dataset.change);
  const d = e.target.closest('[data-apd]');
  if (d) decide(d.closest('[data-ap]'), d.dataset.apd);
});

// ---------------- 输入框 ----------------
export const input = $('#input');
const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(180, input.scrollHeight + 2)}px`; };
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
});
$('#sendBtn').addEventListener('click', send);
async function send() {
  const text = input.value.trim();
  if (!text || !state.space) return;
  $('#sendBtn').disabled = true;
  try {
    await api(`/api/spaces/${state.space.id}/messages`, { method: 'POST', body: { text } });
    input.value = '';
    autosize();
  } catch (e) { toast(e.message, 'error'); } finally { $('#sendBtn').disabled = false; input.focus(); }
}

