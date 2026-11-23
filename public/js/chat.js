// 空间视图：消息、成员标签、命令审批、输入框。聊天空间和任务空间共用，任务空间另有顶部的计划条（tasks.js）
import { attachmentDraft, renderAttachments, messageAttachments } from './attachments.js';
import { formatActionSummary } from './context-memory-format.js';
import { onEnginesChange } from './engines.js';
import { resetRecap, syncRecapSlot } from './recap.js';
import { loadFiles, loadHistory, onFilesChanged, openChange, renderFilesBody, renderFilesPanel, resetViews } from './files.js';
import { checkImports, importHtml, openImportModal, replaceImport } from './imports.js';
import { trackNoteView } from './notes.js';
import { mountParticles } from './particles.js';
import { onRightbarChange, rightbarAlert, rightbarOpen, setRightbarSpace, toggleRightbar } from './rightbar.js';
import { refreshSpacesSoon, renderSpaceList } from './sidebar.js';
import { effortChoices, effortSelect, modelChoices, openSpaceSettings } from './space-form.js';
import { coordinatorText, decisionHtml, onRunEvent, renderTaskSpace, summaryCardHtml, taskStatusText } from './tasks.js';
import { pickBoxHtml, renderSelectBar, startPicking } from './transfer.js';
import { $, $$, ACT_ICON, ICON, api, avatarHtml, clock, engineOf, errHtml, esc, localizeActivity, md, state, store, toast, tr } from './util.js';

// ---------------- 空间视图 ----------------
export function closeStream() { if (state.es) { state.es.close(); state.es = null; } }

// 欢迎页的粒子：只在欢迎页显示时画
let welcomeFx = null;
const stopWelcomeFx = () => { welcomeFx?.stop(); welcomeFx = null; };

/** 离开空间（去整页设置等）：断开事件流，空间、欢迎页和文件面板都收起。 */
export function leaveSpace() {
  closeStream();
  resetRecap();
  trackNoteView(null);
  stopWelcomeFx();
  state.space = null;
  setRightbarSpace(null);
  $('#spaceView').hidden = true;
  $('#welcomeView').hidden = true;
}

export function showWelcome() {
  leaveSpace();
  $('#welcomeView').hidden = false;
  welcomeFx = mountParticles($('#welcomeArt'), { mode: 'ambient' });
  $('#mobileTitle').textContent = 'Agenda';
  document.title = 'Agenda';
  renderSpaceList();
}

export function openSpace(id) {
  closeStream();
  stopWelcomeFx();
  $('#welcomeView').hidden = true;
  $('#spaceView').hidden = false;
  if (state.space?.id !== id) {
    resetRecap();
    state.space = null;
    $('#messages').innerHTML = '';
    $('#spaceTitle').textContent = tr('加载中…');
    resetViews();
    setRightbarSpace(null);
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
      if (first) state.picking = null;
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
    case 'no_images': {
      const m = findMsg(ev.id);
      if (m) { m.noImages = true; scheduleUpdate(m.id); }
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
    case 'lock':
      // 同一个文件夹的任务空间开始 / 停止“依次直接改”：文件面板标题旁的锁
      if (!sp) return;
      sp.readOnly = ev.readOnly;
      renderFilesPanel();
      refreshSpacesSoon();
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
      if (state.files.view?.type === 'change') renderFilesBody();
      refreshMemberViews();
      break;
    case 'acp_warning': {
      const engine = engineOf(ev.engineId);
      if (engine) engine.unverifiedPermissions = true;
      refreshMemberViews();
      break;
    }
    case 'notice':
      toast(ev.text, ev.level);
      break;
  }
  if (['snapshot', 'message_done', 'state', 'members', 'run'].includes(ev.type)) {
    window.dispatchEvent(new CustomEvent('agenda:space-event', { detail: { type: ev.type, space: state.space, event: ev } }));
  }
}

const hiddenMessage = (m) => m.kind === 'ai' && !m.streaming && !m.text && !m.error && !m.passed &&
  !m.changes?.length && !m.actions?.length && !m.interrupted && !m.decision;

function renderSpace() {
  const sp = state.space;
  hideMemberPop();
  document.title = `${sp.title} · Agenda`;
  $('#mobileTitle').textContent = sp.title;
  $('#spaceTitle').textContent = sp.title;
  $('#spaceKind').innerHTML = ICON[sp.kind === 'task' ? 'task' : 'chat'];
  $('#spaceKind').title = sp.kind === 'task' ? tr('任务空间') : tr('聊天空间');
  renderHeader();
  renderMembersBar();
  const box = $('#messages');
  box.innerHTML = (sp.kind === 'task' ? '<div id="taskIntro"></div>' : '') + '<div id="recapSlot" hidden></div>';
  syncRecapSlot(sp);
  box.classList.toggle('selecting', !!state.picking);
  const shown = sp.messages.filter((m) => !hiddenMessage(m));
  for (const m of shown) box.insertAdjacentHTML('beforeend', messageHtml(m));
  renderTaskSpace();
  renderComposer();
  box.scrollTop = box.scrollHeight;
  syncThinking();
  renderSpaceList();
  setRightbarSpace(sp);
  checkImports();
}

const CHAT_PLACEHOLDER = tr('说点什么，@名字 点名');
const SOLO_PLACEHOLDER = tr('说点什么');
/** 只有一个成员的聊天空间：单人聊天（不轮流，不需要「继续讨论」和 @）。 */
const isSolo = (sp) => sp?.kind !== 'task' && sp?.members.length === 1;
const TASK_PLACEHOLDER = tr('和协调者说：补充要求、改做法、问进展');
/** 输入框：聊天空间发给大家；任务空间发给协调者；结束了的任务空间换成一条说明。 */
export function renderComposer() {
  const sp = state.space;
  if (!sp) return;
  const ended = sp.kind === 'task' && !!sp.run?.closed;
  const picking = !!state.picking;
  $('.composer-box').hidden = ended || picking;
  $('#endedBar').hidden = !ended;
  $('#selectBar').hidden = !picking;
  if (picking) renderSelectBar();
  if (ended) {
    $('#endedBar').innerHTML = `<span>${tr('这个任务已经结束，只能查看')}</span>
      <button class="btn sm" type="button" data-act="again">${ICON.plus}${tr('再开一个类似的任务')}</button>`;
  }
  renderAttachments();
  renderOnlyTag();
  input.placeholder = sp.kind === 'task' ? TASK_PLACEHOLDER : isSolo(sp) ? SOLO_PLACEHOLDER : CHAT_PLACEHOLDER;
}

// ---- 只问某个人：成员菜单里选「只问 TA」，输入框上方出现可以取消的小标记，发出这一条后自动取消 ----
let onlyAsk = null; // { spaceId, memberId }
const onlyTag = document.createElement('div');
onlyTag.className = 'only-tag';
onlyTag.hidden = true;
$('.composer-box').prepend(onlyTag);
function onlyMember() {
  const sp = state.space;
  if (!onlyAsk || !sp || onlyAsk.spaceId !== sp.id || sp.kind === 'task' || isSolo(sp)) return null;
  return memberOf(onlyAsk.memberId) || null;
}
function setOnly(memberId) {
  onlyAsk = memberId && state.space ? { spaceId: state.space.id, memberId } : null;
  renderOnlyTag();
}
function renderOnlyTag() {
  const m = onlyMember();
  onlyTag.hidden = !m;
  onlyTag.innerHTML = m ? `<span class="only-chip">${avatarHtml(m.engine, m.name, m.model)}<span>${tr('只问 {0}', [esc(m.name)])}</span>
    <button type="button" data-only-clear title="${tr('取消')}" aria-label="${tr('取消')}">×</button></span>` : '';
}
onlyTag.addEventListener('click', (e) => { if (e.target.closest('[data-only-clear]')) { setOnly(null); input.focus(); } });

export function renderHeader() {
  const sp = state.space;
  const task = sp.kind === 'task';
  const next = (sp.queue || []).map((id) => memberOf(id)?.name).filter(Boolean);
  const q = $('#queueInfo');
  q.textContent = task ? taskStatusText() : next.length && !isSolo(sp) ? tr('接下来：{0}', [next.slice(0, 5).join(' → ')]) : '';
  q.hidden = !q.textContent;
  q.classList.toggle('link', task);
  const btns = task ? [] : sp.running
    ? [['stop', tr('停止')], ...(sp.speaking ? [['skip', tr('跳过当前')]] : [])]
    : isSolo(sp) ? [] : [['continue', tr('继续讨论')]];
  const ended = task && !!sp.run?.closed;
  const side = rightbarOpen();
  const icons = [...(ended ? [] : [['import', tr('导入对话')]]), ['settings', task ? tr('任务空间设置') : tr('空间设置')], ['export', tr('导出')], ['panel', side ? tr('收起侧栏') : tr('展开侧栏'), side, !side && rightbarAlert()]];
  $('#spaceActions').innerHTML = btns.map(([a, l]) => `<button type="button" class="btn sm ${a === 'stop' ? 'danger' : ''}" data-act="${a}">${l}</button>`).join('')
    + icons.map(([a, l, on, dot]) => `<button type="button" class="icon-btn ${on ? 'on' : ''} ${dot ? 'has-dot' : ''}" data-act="${a}" title="${l}" aria-label="${l}" ${a === 'panel' ? `aria-expanded="${!!on}"` : ''}>${ICON[a]}</button>`).join('');

}

// 聊天的「可运行命令」档下，没法在运行前先问你的命令行 AI 只能改文件
const cannotRun = (m) => { const e = engineOf(m.engine); return state.space?.kind !== 'task' && state.space?.access === 'run' && e?.kind === 'cli' && !e.approvals; };
const unverifiedPerms = (m) => { const e = engineOf(m.engine); return !!(e?.status?.unverifiedPermissions || e?.unverifiedPermissions); };

const noExtensions = (m) => {
  const e = engineOf(m.engine);
  return !!e && (m.skills?.length || m.mcp?.length) && !e.skills;
};
function refreshMemberViews() {
  if (!state.space) return;
  renderMembersBar();
  if (!$('#memberPop').hidden) renderMemberPop();
}
onEnginesChange(refreshMemberViews);
export function renderMembersBar() {
  const sp = state.space;
  const speaking = sp.speaking && findMsg(sp.speaking);
  const coord = sp.kind === 'task' ? sp.run?.coordinatorId : null;
  // 任务空间里正在干活的成员（协调者在判断、子任务进行中）
  const busy = new Set(sp.kind === 'task' && sp.run ? [...sp.run.tasks.filter((t) => t.status === 'running').map((t) => t.assigneeId), ...(sp.run.thinking || ['planning', 'summarizing'].includes(sp.run.status) ? [coord] : [])] : []);
  $('#membersBar').innerHTML = sp.members.map((m) => {
    const e = engineOf(m.engine);
    const ok = !e || (m.source ? e.status?.available !== false : e.status?.ready !== false);
    const warning = unverifiedPerms(m) ? tr('这个 AI 的权限无法保证') : '';
    const title = `${(m.source && m.engineLabel) || e?.label || m.engineLabel || m.engine}${m.model ? ` · ${m.model}` : ''}${ok ? '' : `\n${e.status?.note || ''}`}${noExtensions(m) ? '\n' + tr('不支持 skill/MCP') : ''}${warning ? `\n${warning}` : ''}`;
    return `<button type="button" class="person ${speaking?.memberId === m.id || busy.has(m.id) ? 'speaking' : ''} ${ok ? '' : 'off'}" style="--c:${m.color}" data-id="${m.id}" data-title="${esc(title)}" title="${esc(title)}">
      <span class="pa">${avatarHtml(m.engine, m.name, m.model)}</span>${esc(m.name)}${m.id === coord ? `<small>${tr('协调者')}</small>` : ''}${cannotRun(m) ? `<small>${tr('不能运行命令')}</small>` : ''}${noExtensions(m) ? `<small>${tr('不支持 skill/MCP')}</small>` : ''}${warning ? `<small class="warn-tag">${esc(warning)}</small>` : ''}</button>`;
  }).join('');
  for (const id of meters.keys()) paintMeter(id);
  renderOnlyTag();
}

// ---- 成员标签上的上下文小圈：由用量那部分调用 setMemberMeter 来填 ----
const meters = new Map(); // memberId -> { ratio, tip }
function paintMeter(memberId) {
  const chip = $(`#membersBar .person[data-id="${CSS.escape(memberId)}"]`);
  if (!chip) return;
  const v = meters.get(memberId);
  const ring = $('.pa', chip);
  const ratio = Number.isFinite(v?.ratio) ? Math.min(1, Math.max(0, v.ratio)) : null;
  ring.classList.toggle('metered', ratio !== null);
  ring.classList.toggle('high', ratio !== null && ratio >= 0.7 && ratio < 0.9);
  ring.classList.toggle('full', ratio !== null && ratio >= 0.9);
  if (ratio === null) ring.style.removeProperty('--meter'); else ring.style.setProperty('--meter', ratio);
  chip.title = [chip.dataset.title, v?.tip].filter(Boolean).join('\n');
}
/**
 * 成员标签上的小圈。ratio 是 0–1 的上下文用量（拿不到就不传或传 null，小圈不显示），
 * tip 是鼠标停上去时显示的一行字（例如「上下文 42%、额度 18%」）。传 null 清掉。
 */
export function setMemberMeter(memberId, meter) {
  if (!memberId) return;
  if (meter) meters.set(memberId, { ratio: meter.ratio ?? null, tip: meter.tip || '' }); else meters.delete(memberId);
  paintMeter(memberId);
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
    <div class="mp-head">${avatarHtml(m.engine, m.name, m.model)}<b>${esc(m.name)}</b><span>${esc((m.source && m.engineLabel) || e.label || m.engineLabel)}</span></div>
    ${(m.source ? st.available : st.ready) === false ? `<div class="member-status warn">${esc(st.note || tr('还不能用'))}</div>` : ''}
    ${unverifiedPerms(m) ? `<div class="member-status warn">${tr('这个 AI 的权限无法保证')}</div>` : ''}
    ${cannotRun(m) ? `<div class="hint">${tr('它没法在运行命令前先问你，所以这一档只能读写文件。')}</div>` : ''}
    ${noExtensions(m) ? `<div class="hint">${tr('这个 AI 暂不支持 skill 和 MCP，卡上配置的工具不会生效。')}</div>` : ''}
    ${['skills','mcp'].filter(k => m[k]?.length).map(k => `<div class="hint" data-tool-names="${k}">${k === 'skills' ? 'Skills' : 'MCP'} · ${esc(m[k].join(', '))}</div>`).join('')}
    ${!state.enginesLoaded ? `<div class="hint" role="status">${tr('正在检测 AI 连接…')}</div>` : `<select data-k="model" title="${tr('型号')}"><option value="">${esc(st.defaultModel ? tr('默认（{0}）', [st.defaultModel]) : tr('默认型号'))}</option>
      ${models.map(([v, l]) => `<option value="${esc(v)}" ${v === m.model ? 'selected' : ''}>${esc(l || v)}</option>`).join('')}</select>
    ${effortSelect(e, m)}`}
    ${state.space.kind === 'task' || isSolo(state.space) ? '' : `<button class="btn sm block" type="button" data-act="only">${tr('只问 {0}', [esc(m.name)])}</button>
      <button class="btn sm block" type="button" data-act="ask">${tr('让 {0} 现在发言', [esc(m.name)])}</button>`}`;
  const tools = $('#memberPop').querySelectorAll('[data-tool-names]');
  if (tools.length) api('/api/library/extensions').then(list => {
    for (const el of tools) {
      const k = el.dataset.toolNames;
      const names = m[k].map(id => list[k].find(tool => tool.id === id)?.name || id);
      el.textContent = (k === 'mcp' ? 'MCP' : 'Skills') + ' · ' + names.join(', ');
    }
  }).catch(() => {}); // The IDs remain readable if the local scan fails.
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
  if (e.target.closest('[data-act="only"]')) { setOnly(popMember); hideMemberPop(); input.focus(); return; }
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
    <div class="ap-q">${a.kind === 'edit' ? tr('想修改文件') : tr('想运行')}</div>
    <pre class="ap-cmd">${esc(a.command)}</pre>
    <input class="ap-note" data-apr maxlength="500" placeholder="${tr('附一句话（可不填）')}" value="${esc(noteDrafts.get(a.id) || '')}">
    <div class="ap-actions"><button class="btn sm primary" type="button" data-apd="allow">${tr('允许')}</button>
      ${a.kind !== 'edit' && a.programs?.length && a.canAlways !== false ? `<button class="btn sm" type="button" data-apd="always">${tr('一直允许 {0}', [esc(a.programs.join(tr('、')))])}</button>` : ''}
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

// 聊天空间里能转到任务空间的消息：鼠标停上去出现「转到任务空间」
const transferable = (m) => state.space?.kind !== 'task' && ['user', 'ai', 'task'].includes(m.kind) && !m.passed && !m.streaming && !!m.text?.trim();
const transferBtn = (m) => (transferable(m) ? `<button type="button" class="msg-act" data-transfer="${m.id}" title="${tr('转到任务空间')}" aria-label="${tr('转到任务空间')}">${ICON.transfer}</button>` : '');

/** 我的消息时间上的提示：消息编号（有 seq 时）、只问了谁。 */
function userMeta(m) {
  const only = m.only && memberOf(m.only);
  return [m.seq ? tr('消息 {0}', [m.seq]) : '', only ? tr('只问 {0}', [only.name]) : ''].filter(Boolean).join(' · ');
}

export function messageHtml(m) {
  if (m.kind === 'import') return importHtml(m);
  if (m.kind === 'summary') return summaryCardHtml(m);
  const pick = transferable(m) ? pickBoxHtml(m) : '';
  if (m.kind === 'task') return taskBackHtml(m, pick);
  if (m.kind === 'user') {
    const wait = m.queued ? `<div class="msg-note">${tr('等协调者看')}</div>` : m.unanswered ? `<div class="msg-note">${tr('软件关闭时协调者还没回这条，可以再发一次')}</div>` : '';
    return `<div class="msg user ${pick ? 'pickable' : ''}" id="m-${m.id}" data-seq="${esc(m.seq)}">${pick}
      <div class="msg-main"><div class="msg-head"><span class="n">${tr('我')}</span><span class="m" title="${esc(userMeta(m))}">${clock(m.ts)}</span>${transferBtn(m)}</div>
      <div class="msg-body">${m.text ? `<div class="md">${md(m.text)}</div>` : ''}${messageAttachments(m.attachments)}</div>${wait}</div></div>`;
  }
  const mem = memberOf(m.memberId);
  const color = mem?.color || engineOf(m.engine)?.color || '#888';
  const imageNote = m.noImages ? `<div class="image-note">${tr('{0} 看不到图片', [esc(m.name)])}</div>` : '';
  const summary = m.kind === 'ai' && formatActionSummary(m.actions, tr);
  const actions = summary ? `<div class="msg-actions-summary" title="${esc(summary.text)}"><span class="mas-label">${esc(tr('运行了：'))}</span>
    <span class="mas-cmds">${summary.items.slice(0, 5).map((cmd) => `<code>${esc(cmd)}</code>`).join('<span class="mas-sep">·</span>')}${summary.items.length > 5 ? ' …' : ''}</span></div>` : '';
  if (m.passed && !m.streaming) {
    return `<div class="pass-line" id="m-${m.id}" data-seq="${esc(m.seq)}" style="--c:${color}">${imageNote}<b>${esc(m.name)}</b> ${tr('没有补充{0}', [m.changes?.length ? tr('，但修改了 {0} 个文件', [m.changes.length]) : ''])}${actions}</div>`;
  }
  const meta = m.seq ? [tr('消息 {0}', [m.seq])] : [];
  if (m.durationMs) meta.push(tr('{0} 秒', [(m.durationMs / 1000).toFixed(0)]));
  if (m.model) meta.push(m.model);
  const last = m.activities?.[m.activities.length - 1];
  // 协调者的判断：回复后面那段 JSON 只给软件看，不显示
  const text = m.replyTo ? coordinatorText(m.text, m.streaming) : m.text;
  let body;
  // 还没吐字：粒子占位（开始输出就换成正文）
  if (m.streaming && !text) body = `<div class="think"><span class="think-art"></span><span class="think-label">${esc(last ? localizeActivity(last.label) : tr('思考中'))}</span></div>`;
  else body = text ? `<div class="md ${m.streaming ? 'cursor' : ''}">${md(text)}</div>` : '';
  const changes = m.changes?.length ? `<div class="changes">${m.changes.map((c) => `<button type="button" class="change-chip" data-change="${c.id}">${ICON.file}${esc(c.path)} ${c.created ? `<span class="plus">${tr('新建')}</span>` : c.deleted ? `<span class="minus">${tr('删除')}</span>` : `<span class="plus">+${c.added}</span><span class="minus">−${c.removed}</span>`}</button>`).join('')}</div>` : '';
  return `<div class="msg ai ${m.error ? 'error' : ''} ${pick ? 'pickable' : ''}" id="m-${m.id}" data-seq="${esc(m.seq)}" style="--c:${color}">${pick}
    ${avatarHtml(mem?.engine || m.engine, m.name, m.model || mem?.model)}
    <div class="msg-main">${imageNote}
      <div class="msg-head"><span class="n">${esc(m.name)}</span>${m.replyTo ? `<span class="role">${tr('协调者')}</span>` : ''}<span class="m" title="${esc(meta.join(' · '))}">${clock(m.ts)}</span>${transferBtn(m)}</div>
      <div class="msg-body">${activitiesHtml(m.activities, m.streaming)}${approvalsHtml(m)}${body}
        ${m.interrupted ? `<div class="note">${tr('（发言被中断）')}</div>` : ''}
        ${m.note ? `<div class="note">${esc(m.note)}</div>` : ''}
        ${m.error ? errHtml(m.error) : ''}${changes}${actions}</div>
      ${m.decision ? decisionHtml(m) : ''}
    </div></div>`;
}

/** 聊天空间里：任务空间结束时发回来的总结。 */
function taskBackHtml(m, pick) {
  return `<div class="msg task-back ${pick ? 'pickable' : ''}" id="m-${m.id}" data-seq="${esc(m.seq)}">${pick}
    <div class="tb-card">
      <div class="tb-head"><span class="tb-icon">${ICON.task}</span><span class="tb-title">${tr('任务「{0}」结束了', [esc(m.title)])}</span>
        <span class="m" title="${m.seq ? tr('消息 {0}', [m.seq]) : ''}">${tr('{0}/{1} 个子任务通过', [m.approved, m.total])}${m.merged ? tr(' · 已合并到 {0}', [esc(m.merged)]) : ''} · ${clock(m.ts)}</span>${transferBtn(m)}</div>
      <div class="md">${md(m.text)}</div>
      <a class="tb-link" href="#/space/${esc(m.taskSpaceId)}">${tr('打开任务空间')}</a>
    </div></div>`;
}

const nearBottom = () => { const b = $('#messages'); return b.scrollHeight - b.scrollTop - b.clientHeight < 140; };
const scrollToBottom = () => { const b = $('#messages'); b.scrollTop = b.scrollHeight; };

function appendMessage(m) {
  const stick = nearBottom() || m.kind === 'user';
  $('#messages').insertAdjacentHTML('beforeend', messageHtml(m));
  syncThinking();
  if (stick) scrollToBottom();
}

// 思考中的粒子：新出现的占位挂上粒子，消息重绘时把正在动的那个搬过去，不重新开始
const thinking = new Map(); // 元素 -> 粒子
function syncThinking() {
  for (const [el, fx] of thinking) if (!el.isConnected) { fx.stop(); thinking.delete(el); }
  for (const el of $$('#messages .think-art')) if (!thinking.has(el)) thinking.set(el, mountParticles(el, { mode: 'thinking' }));
}
export function updateMessage(m) {
  const el = document.getElementById(`m-${m.id}`);
  const stick = nearBottom();
  const hidden = hiddenMessage(m);
  if (!el) { if (!hidden) appendMessage(m); return; }
  if (hidden) { el.remove(); return; }
  // 正在卡片上写附言时消息重绘了：把光标放回原处
  const typing = el.contains(document.activeElement) && document.activeElement.matches('[data-apr]')
    ? { id: document.activeElement.closest('[data-ap]').dataset.ap, at: document.activeElement.selectionStart } : null;
  const art = $('.think-art', el);
  if (m.kind === 'import') replaceImport(el, m);
  else el.outerHTML = messageHtml(m);
  const slot = art && $(`#m-${CSS.escape(m.id)} .think-art`);
  if (slot) slot.replaceWith(art);
  syncThinking();
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
  if (act === 'panel') { toggleRightbar(); return; }
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
  const t = e.target.closest('[data-transfer]');
  if (t) { startPicking(t.dataset.transfer); return; }
  const c = e.target.closest('[data-change]');
  if (c) openChange(c.dataset.change);
  const d = e.target.closest('[data-apd]');
  if (d) decide(d.closest('[data-ap]'), d.dataset.apd);
});

// 右侧栏展开 / 收起、面板上的提醒变了：顶栏的开关按钮跟着变
onRightbarChange(() => { if (state.space) renderHeader(); });

// ---------------- 输入框 ----------------
export const input = $('#input');
const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(180, input.scrollHeight + 2)}px`; };
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && onlyMember()) { setOnly(null); return; }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
});
$('#sendBtn').addEventListener('click', send);
$('#endedBar').addEventListener('click', (e) => {
  if (e.target.closest('[data-act=again]')) import('./space-form.js').then((f) => f.openSimilarTask(state.space));
});
async function send() {
  const text = input.value.trim();
  const id = state.space?.id;
  if (!id) return;
  const draft = attachmentDraft(id);
  if (draft.sending || draft.items.some((a) => a.busy) || (!text && !draft.items.length)) return;
  draft.sending = true;
  const attachments = draft.items.map((a) => a.id);
  const ask = onlyAsk;
  const only = onlyMember()?.id;
  renderAttachments();
  try {
    await api(`/api/spaces/${id}/messages`, { method: 'POST', body: { text, attachments, ...(only ? { only } : {}) } });
    draft.items = draft.items.filter((a) => !attachments.includes(a.id));
    if (onlyAsk === ask) setOnly(null); // 只管这一条
    if (state.space?.id === id && input.value.trim() === text) { input.value = ''; autosize(); }
  } catch (e) { toast(e.message, 'error'); } finally {
    draft.sending = false;
    renderAttachments();
    if (state.space?.id === id) input.focus();
  }
}

