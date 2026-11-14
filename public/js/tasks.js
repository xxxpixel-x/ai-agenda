// 任务协作
import { activitiesHtml, input, memberOf, messageHtml, pending, renderHeader } from './chat.js';
import { loadFiles, loadHistory, renderFilesBody, renderFilesPanel } from './files.js';
import { $, $$, ICON, api, diffHtml, esc, getLanguage, md, state, toast, tr } from './util.js';

// ================= 任务协作 =================
const RUN_STATUS = { planning: tr('规划中'), plan_review: tr('等你确认计划'), executing: tr('执行中'), summarizing: tr('协调者在写总结'), done: tr('已完成'), failed: tr('没有完成规划'), cancelled: tr('已取消') };
const T_STATUS = { pending: tr('等前置任务'), ready: tr('排队中'), running: tr('进行中'), review: tr('待你审查'), approved: tr('已通过'), failed: tr('失败'), blocked: tr('等你回答'), skipped: tr('已跳过'), cancelled: tr('已取消') };
const CHAT_PLACEHOLDER = tr('说点什么，@名字 点名');
state.view = 'chat';
let planDraft = null;
const taskChecks = new Map();

const runBlocksChat = (r) => !!r && (r.status === 'planning' || r.status === 'summarizing' || (r.status === 'executing' && r.mode === 'direct'));
const needsUser = (r) => r.status === 'plan_review' || r.paused || r.tasks.some((t) => ['review', 'blocked', 'failed'].includes(t.status)) || (r.status === 'done' && r.mode === 'git' && !r.merged && r.tasks.some((t) => t.status === 'approved'));
const memberName = (id) => memberOf(id)?.name || tr('（已移除）');
const memberColor = (id) => memberOf(id)?.color || '#888';
const mins = (ms) => (ms < 60000 ? tr('{0} 秒', [Math.round(ms / 1000)]) : tr('{0} 分钟', [(ms / 60000).toFixed(1)]));

export function applyView() {
  const task = state.view === 'task';
  $('#messages').hidden = task;
  $('#taskView').hidden = !task;
  $('#composer').hidden = task;
  $$('#viewSeg button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  if (task) renderTaskView(true);
  updateTaskDot();
  renderTaskBar();
  updateComposerLock();
}
function updateTaskDot() {
  const r = state.space?.run;
  const dot = $('#taskDot');
  dot.hidden = !r;
  if (r) dot.className = `seg-dot ${needsUser(r) ? 'wait' : ''}`;
}
// 聊天输入框上方：任务协作在等你的事（只说第一件，其余算个数），点一下去处理
function renderTaskBar() {
  const r = state.space?.run;
  const bar = $('#taskBar');
  const items = [];
  if (r && needsUser(r)) {
    if (r.status === 'plan_review') items.push([tr('等你确认计划')]);
    for (const t of r.tasks) {
      if (t.status === 'blocked') items.push([tr('{0} 在问你「{1}」的事', [memberName(t.assigneeId), t.title]), t.id]);
      else if (t.status === 'review') items.push([tr('等你审查「{0}」', [t.title]), t.id]);
      else if (t.status === 'failed') items.push([tr('「{0}」失败了，等你处理', [t.title]), t.id]);
    }
    if (!items.length) items.push([r.paused ? tr('任务已暂停，等你继续') : tr('任务做完了，等你合并')]);
  }
  bar.hidden = !items.length;
  if (!items.length) return;
  const [text, taskId] = items[0];
  bar.innerHTML = `<span class="tb-dot"></span><span class="tb-text">${tr('任务协作：{0}{1}', [esc(text), items.length > 1 ? `<span class="hint">${tr('（还有 {0} 件）', [items.length - 1])}</span>` : ''])}</span>
    <button class="btn sm" type="button" data-task="${esc(taskId || '')}">${tr('去处理')}</button>`;
}
$('#taskBar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.view = 'task';
  applyView();
  const card = b.dataset.task && $(`#taskView .tcard[data-task="${CSS.escape(b.dataset.task)}"]`);
  if (card) { card.scrollIntoView({ block: 'center' }); card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1600); }
});
function updateComposerLock() {
  const lock = runBlocksChat(state.space?.run);
  $('#composer').classList.toggle('locked', lock);
  input.disabled = lock;
  $('#sendBtn').disabled = lock;
  input.placeholder = lock ? tr('任务进行中，聊天暂停') : CHAT_PLACEHOLDER;
}
$('#viewSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) { state.view = b.dataset.view; applyView(); }
});

let taskRaf = 0;
function scheduleTaskRender() {
  if (taskRaf) return;
  taskRaf = requestAnimationFrame(() => { taskRaf = 0; if (state.view === 'task') renderTaskView(); updateTaskDot(); renderTaskBar(); updateComposerLock(); });
}
let detailTimer = null;
export function onRunEvent(run) {
  const sp = state.space;
  if (!sp) return;
  const prev = sp.run;
  if (run?.closed) run = null;
  if (run && sp.run === null && prev === null && run.status !== 'planning') return; // 迟到的旧推送
  sp.run = run;
  if (run?.status === 'planning') planDraft = null;
  if (run && prev?.status !== run.status && ['plan_review', 'done'].includes(run.status) && state.view !== 'task') toast(run.status === 'plan_review' ? tr('计划拟好了，请到“任务协作”里确认') : tr('任务完成了'));
  scheduleTaskRender();
  const v = state.files.view;
  if (v?.type === 'task' && !detailTimer) detailTimer = setTimeout(() => { detailTimer = null; refreshTaskDetail(); }, 700);
}

// 重新渲染时保留输入框里没提交的内容与焦点
function keepInputs(root, render) {
  const vals = new Map($$('[data-keep]', root).map((el) => [el.dataset.keep, el.value]));
  const focused = document.activeElement?.dataset?.keep;
  const sel = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  render();
  for (const el of $$('[data-keep]', root)) if (vals.has(el.dataset.keep)) el.value = vals.get(el.dataset.keep);
  if (focused) { const el = $(`[data-keep="${focused}"]`, root); if (el) { el.focus(); try { el.setSelectionRange(...sel); } catch { /* select */ } } }
}

function renderTaskView(force = false) {
  const sp = state.space;
  const box = $('#taskContent');
  if (!sp) return;
  const r = sp.run;
  const key = r ? `${r.id}:${r.status}` : 'none';
  // 编辑计划时不要被推送打断
  if (!force && r?.status === 'plan_review' && box.dataset.key === key && planDraft?.runId === r.id) return;
  if (!force && !r && box.dataset.key === key) return;
  box.dataset.key = key;
  keepInputs(box, () => {
    if (!r) box.innerHTML = `${startFormHtml()}${pastRunsHtml()}`;
    else if (r.status === 'planning' || r.status === 'plan_review' || (r.status === 'failed' && !r.tasks.length)) box.innerHTML = `${runBarHtml(r)}${planningHtml(r)}`;
    else box.innerHTML = `${runBarHtml(r)}${boardHtml(r)}${r.summary ? summaryHtml(r) : ''}`;
  });
  if (!r) loadTaskCheck();
}

function startFormHtml() {
  const sp = state.space;
  return `<div class="card">
    <textarea id="tkObjective" data-keep="tk-objective" rows="4" placeholder="${tr('要完成什么？例如：给这个项目加上导出 PDF 的功能')}"></textarea>
    <div class="opts">
      <span class="mode-tag" id="tkMode"></span>
      <label>${tr('协调者')} <select id="tkCoord">${sp.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></label>
      ${sp.members.length > 1 ? `<label><input type="checkbox" id="tkDiscuss" checked> ${tr('先让其他成员审阅计划')}</label>` : ''}
      <label id="tkParWrap" hidden>${tr('最多同时')} <input type="number" id="tkPar" min="1" max="6" value="3"> ${tr('个')}</label>
      <label><input type="checkbox" id="tkAuto"> ${tr('做完自动通过')}</label>
    </div>
    <div class="mode-note warn" id="tkDirty" hidden></div>
    <div style="display:flex;justify-content:flex-end"><button class="btn primary" type="button" data-tact="start">${tr('开始规划')}</button></div>
  </div>`;
}

async function loadTaskCheck() {
  const sp = state.space;
  let c = taskChecks.get(sp.id);
  if (!c || Date.now() - c.at > 15000) {
    try { c = { at: Date.now(), v: await api(`/api/spaces/${sp.id}/taskcheck`) }; } catch (e) { c = { at: Date.now(), v: { mode: 'direct', note: e.message } }; }
    taskChecks.set(sp.id, c);
  }
  const el = $('#tkMode');
  if (!el) return;
  const v = c.v;
  const git = v.mode === 'git';
  el.textContent = git ? tr('并行 · {0}', [v.branch]) : tr('依次修改');
  el.title = git ? tr('每个子任务在独立副本里进行，通过审查后合并') : (v.note || tr('子任务按顺序直接修改共享文件夹'));
  $('#tkParWrap').hidden = !git;
  const dirty = $('#tkDirty');
  dirty.hidden = !(git && v.dirty);
  if (git && v.dirty) dirty.textContent = tr('⚠ 有 {0} 个文件改了还没提交，AI 的副本里看不到，建议先提交', [v.dirtyFiles]);
}

function pastRunsHtml() {
  const list = state.space.pastRuns || [];
  if (!list.length) return '';
  return `<div class="card past"><h3>${tr('以前的任务')}</h3>${list.map((p) => `<div class="past-row">
    <span class="po">${esc(p.objective.split('\n')[0].slice(0, 80))}</span>
    <span class="st ${p.status === 'done' ? 'approved' : 'cancelled'}">${RUN_STATUS[p.status] || p.status}</span>
    <span class="hint">${tr('{0}/{1} 通过 · {2}', [p.approved, p.tasks, new Date(p.createdAt).toLocaleDateString(getLanguage())])}</span>
    ${p.merged ? `<span class="hint">${tr('已合并到 {0}', [esc(p.merged.branch)])}</span>` : p.branch ? `<span class="hint">${tr('结果保存在分支')} <code>${esc(p.branch)}</code></span>` : ''}
  </div>`).join('')}</div>`;
}

function runBarHtml(r) {
  const total = r.tasks.length;
  const ok = r.tasks.filter((t) => t.status === 'approved').length;
  const settled = r.tasks.filter((t) => ['approved', 'skipped', 'cancelled'].includes(t.status)).length;
  const btns = [];
  if (r.paused && r.status === 'executing') btns.push(`<button class="btn sm primary" type="button" data-tact="resume">${tr('继续执行')}</button>`);
  if (r.status === 'done' && r.mode === 'git' && !r.merged && ok) btns.push(`<button class="btn sm primary" type="button" data-tact="merge">${tr('合并到 {0}', [esc(r.git?.baseBranch || tr('你的分支'))])}</button>`);
  if (['done', 'cancelled', 'failed'].includes(r.status)) btns.push(`<button class="btn sm" type="button" data-tact="close">${tr('结束并收起')}</button>`);
  else btns.push(`<button class="btn sm danger" type="button" data-tact="cancel">${tr('取消任务')}</button>`);
  return `<div class="card"><div class="run-bar">
      <div class="obj"><b>${esc(r.objective.split('\n')[0].slice(0, 100))}</b>
        <span>${RUN_STATUS[r.status] || r.status}${r.paused ? tr('（已暂停）') : ''}</span></div>
      ${btns.join('')}</div>
    ${total && r.status !== 'plan_review' && r.status !== 'planning' ? `<div class="progress"><i style="width:${Math.round((settled / total) * 100)}%"></i></div>` : ''}
    ${r.error ? `<div class="err">⚠ ${esc(r.error)}</div>` : ''}
    ${r.merged ? `<div class="note">${tr('已合并到 {0}', [esc(r.merged.branch)])}</div>` : ''}
  </div>`;
}

const planMsgHtml = (m) => messageHtml({ ...m, kind: 'ai', id: `p-${m.id}` });

function planningHtml(r) {
  const msgs = r.planning.messages.map(planMsgHtml).join('');
  if (r.status === 'planning') {
    return `<div class="plan-msgs">${msgs}</div><div class="hint">${tr('{0} 正在规划…', [esc(memberName(r.coordinatorId))])}</div>`;
  }
  if (!r.tasks.length) return `<div class="plan-msgs">${msgs}</div>`;
  if (!planDraft || planDraft.runId !== r.id) planDraft = { runId: r.id, tasks: r.tasks.map((t) => ({ id: t.id, title: t.title, assigneeId: t.assigneeId, deps: [...t.deps], spec: t.spec })) };
  return `<details class="plan-msgs" ${msgs ? '' : 'hidden'}><summary>${tr('规划过程（{0} 条发言）', [r.planning.messages.length])}</summary>${msgs}</details>
    <div class="card plan-edit"><h3>${tr('计划')}</h3>
      <div class="tasks" id="planTasks">${planEditorRows()}</div>
      <button class="btn sm ghost" type="button" data-tact="pe-add" style="margin-top:8px">${tr('＋ 添加子任务')}</button>
    </div>
    <div class="card">
      <textarea data-keep="replan" id="replanText" rows="2" placeholder="${tr('不满意？写下意见')}"></textarea>
      <div class="opts" style="justify-content:flex-end"><button class="btn sm" type="button" data-tact="replan">${tr('重新规划')}</button>
        <button class="btn primary" type="button" data-tact="approve-plan">${tr('批准并执行')}</button></div></div>`;
}

function planEditorRows() {
  const sp = state.space;
  return planDraft.tasks.map((t, i) => `<div class="tcard" style="--c:${memberColor(t.assigneeId)}" data-pi="${i}">
    <div class="pe-row"><span class="tid">${esc(t.id)}</span>
      <input data-pe="title" value="${esc(t.title)}" placeholder="${tr('标题')}">
      <select data-pe="assigneeId">${sp.members.map((m) => `<option value="${m.id}" ${m.id === t.assigneeId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
      <button class="icon-btn" type="button" data-tact="pe-del" title="${tr('删除')}">${ICON.close}</button></div>
    <textarea data-pe="spec" rows="3" placeholder="${tr('说明：目标、要改什么、限制、怎样算完成')}">${esc(t.spec)}</textarea>
    ${planDraft.tasks.length > 1 ? `<div class="deps">${tr('依赖：{0}', [planDraft.tasks.filter((o) => o.id !== t.id).map((o) => `<label><input type="checkbox" data-dep="${esc(o.id)}" ${t.deps.includes(o.id) ? 'checked' : ''}>${esc(o.id)}</label>`).join('')])}</div>` : ''}
  </div>`).join('');
}

const boardHtml = (r) => `<div class="tasks">${r.tasks.map((t) => taskCardHtml(r, t)).join('')}</div>`;

function taskCardHtml(r, t) {
  const a = t.attempts.at(-1);
  let sub = t.deps.length ? tr('依赖 {0}', [t.deps.join('、')]) : '';
  const add = (s) => { if (s) sub += `${sub ? ' · ' : ''}${s}`; };
  if (t.status === 'running') add(a?.activities?.at(-1)?.label || (a?.text ? a.text.trim().split('\n').at(-1).slice(0, 80) : tr('思考中…')));
  else if (t.status === 'review' || t.status === 'approved') add(`${(a?.report || '').split('\n')[0].slice(0, 90)}${t.changes?.length ? tr('（改了 {0} 个文件）', [t.changes.length]) : ''}`);
  else if (t.status === 'failed') add(a?.error || tr('失败'));
  if (t.attempts.length > 1) add(tr('第 {0} 次', [t.attempts.length]));
  if (a?.endedAt && a.startedAt) add(mins(a.endedAt - a.startedAt));
  const k = `${r.id}-${t.id}`;
  const acts = [];
  const live = r.status === 'executing';
  if (t.status === 'running') acts.push(`<button class="btn sm" type="button" data-tact="stop-task" data-task="${t.id}">${tr('停止')}</button>`);
  if (t.status === 'review') acts.push(`<button class="btn sm" type="button" data-tact="open" data-task="${t.id}">${tr('查看改动并审查')}</button><button class="btn sm primary" type="button" data-tact="approve-task" data-task="${t.id}">${tr('通过')}</button>`);
  if (t.status === 'failed' && live) acts.push(`<button class="btn sm primary" type="button" data-tact="retry-task" data-task="${t.id}">${tr('重试')}</button>`);
  if (['failed', 'pending', 'ready', 'blocked'].includes(t.status) && live) {
    acts.push(`<button class="btn sm" type="button" data-tact="skip-task" data-task="${t.id}">${tr('跳过')}</button>`);
    acts.push(`<select data-reassign="${t.id}" title="${tr('改派给')}" style="width:auto">${state.space.members.map((m) => `<option value="${m.id}" ${m.id === t.assigneeId ? 'selected' : ''}>${tr('负责：{0}', [esc(m.name)])}</option>`).join('')}</select>`);
  }
  return `<div class="tcard ${state.files.view?.type === 'task' && state.files.view.taskId === t.id ? 'sel' : ''}" data-task="${t.id}" style="--c:${memberColor(t.assigneeId)}">
    <div class="tc-top"><span class="tid">${esc(t.id)}</span><span class="tt">${esc(t.title)}</span><span class="tc-who">@${esc(memberName(t.assigneeId))}</span><span class="st ${t.status}">${T_STATUS[t.status] || t.status}</span></div>
    ${sub ? `<div class="tc-sub">${esc(sub)}</div>` : ''}
    ${t.status === 'blocked' ? `<div class="question"><b>${tr('{0} 问你：', [esc(memberName(t.assigneeId))])}</b>${esc(t.question || '')}</div>
      <div class="tc-actions"><input data-keep="ans-${k}" placeholder="${tr('写下回答，它会接着做')}"><button class="btn sm primary" type="button" data-tact="answer" data-task="${t.id}">${tr('回答')}</button></div>` : ''}
    ${acts.length ? `<div class="tc-actions">${acts.join('')}</div>` : ''}
  </div>`;
}

function summaryHtml(r) {
  const s = r.summary;
  return `<div class="card"><h3>${tr('协调者的总结')}</h3>${s.streaming && !s.text ? `<span class="typing"><i></i><i></i><i></i>${tr('&nbsp;正在写')}</span>` : `<div class="md">${md(s.text || '')}</div>`}${s.error ? `<div class="err">⚠ ${esc(s.error)}</div>` : ''}</div>`;
}

// ---- 子任务详情（右侧面板） ----
async function openTask(taskId) {
  state.files.view = { type: 'task', taskId, detail: null };
  if (!state.files.open) { state.files.open = true; renderHeader(); }
  renderFilesPanel();
  await refreshTaskDetail();
  scheduleTaskRender();
}
async function refreshTaskDetail() {
  const v = state.files.view;
  if (v?.type !== 'task' || !state.space?.run) return;
  try { v.detail = await api(`/api/spaces/${state.space.id}/task/${v.taskId}`); } catch (e) { v.detail = { error: e.message }; }
  if (state.files.view === v) keepInputs($('#filesBody'), () => renderFilesBody());
}
export function renderTaskDetail(body, v) {
  const t = v.detail;
  const r = state.space.run;
  if (!t) { body.innerHTML = `<div class="empty-files">${tr('加载中…')}</div>`; return; }
  if (t.error && !t.id) { body.innerHTML = `<div class="empty-files">${esc(t.error)}</div>`; return; }
  const k = `${r?.id}-${t.id}`;
  const changes = (t.changes || []).map((c) => `<div class="chg-row" data-tdiff="${esc(c.path)}">${c.status === 'A' || c.created ? '<span class="fst a">A</span>' : c.status === 'D' || c.deleted ? '<span class="fst d">D</span>' : '<span class="fst">M</span>'}<span class="fp">${esc(c.path)}</span><span class="plus">+${c.added}</span><span class="minus">−${c.removed}</span></div>`).join('');
  const live = r?.status === 'executing';
  const attempts = t.attempts.map((a, i) => ({ a, i })).reverse().map(({ a, i }) => `<div class="attempt">
      <div class="attempt-head"><b>${tr('第 {0} 次', [i + 1])}</b><span>${new Date(a.startedAt).toLocaleTimeString(getLanguage(), { hour12: false })}</span>${a.endedAt ? `<span>${mins(a.endedAt - a.startedAt)}</span>` : '<span class="typing"><i></i><i></i><i></i></span>'}
        ${a.outcome ? `<span class="st ${a.outcome === 'done' ? 'approved' : a.outcome === 'question' ? 'blocked' : 'failed'}">${a.outcome === 'done' ? tr('报告完成') : a.outcome === 'question' ? tr('提了问题') : tr('失败')}</span>` : ''}</div>
      ${a.conflict ? `<div class="note">${tr('这次是在解决合并冲突：{0}', [esc(a.conflict.join('、'))])}</div>` : ''}
      ${activitiesHtml(a.activities, !a.endedAt)}
      ${a.report || a.text ? `<div class="md">${md(a.report || a.text)}</div>` : ''}
      ${a.note ? `<div class="note">${esc(a.note)}</div>` : ''}
      ${a.error ? `<div class="err">⚠ ${esc(a.error)}</div>` : ''}
      ${a.log?.length ? `<details><summary class="hint">${tr('原始输出')}</summary><div class="log">${esc(a.log.join('\n'))}</div></details>` : ''}
    </div>`).join('');
  body.innerHTML = `<div class="editor-head"><button class="icon-btn" type="button" data-act="back" title="${tr('返回')}">${ICON.back}</button>
      <span class="ep">${esc(t.id)} ${esc(t.title)}</span><span class="st ${t.status}">${T_STATUS[t.status]}</span></div>
    <div class="td">
      <div><h4>${tr('负责')}</h4><span style="color:${memberColor(t.assigneeId)};font-weight:600">@${esc(memberName(t.assigneeId))}</span>${t.deps.length ? `　<span class="hint">${tr('依赖 {0}', [esc(t.deps.join('、'))])}</span>` : ''}</div>
      <div><h4>${tr('说明')}</h4><div class="spec">${esc(t.spec)}</div></div>
      ${t.status === 'review' ? `<div class="review-box"><b>${tr('审查')}</b>
        <textarea data-keep="fb-${k}" id="fbText" rows="3" placeholder="${tr('退回时写下要怎么改')}"></textarea>
        <div class="row"><button class="btn sm primary" type="button" data-tact="approve-task" data-task="${t.id}">${tr('通过')}</button>
          <button class="btn sm" type="button" data-tact="reject-task" data-task="${t.id}">${tr('带意见退回重做')}</button>
          ${r.mode === 'direct' && t.changes?.length ? `<button class="btn sm danger" type="button" data-tact="undo-task" data-task="${t.id}">${tr('撤销它的全部改动')}</button>` : ''}</div></div>` : ''}
      ${t.status === 'blocked' ? `<div class="review-box"><b>${tr('{0} 问你：', [esc(memberName(t.assigneeId))])}</b><div>${esc(t.question || '')}</div>
        <textarea data-keep="ans2-${k}" id="ansText" rows="2" placeholder="${tr('写下回答')}"></textarea><div class="row"><button class="btn sm primary" type="button" data-tact="answer-detail" data-task="${t.id}">${tr('回答')}</button></div></div>` : ''}
      ${t.status === 'failed' && live ? `<div class="row"><button class="btn sm primary" type="button" data-tact="retry-task" data-task="${t.id}">${tr('重试')}</button> <button class="btn sm" type="button" data-tact="skip-task" data-task="${t.id}">${tr('跳过')}</button>${r.mode === 'direct' && t.changes?.length ? ` <button class="btn sm danger" type="button" data-tact="undo-task" data-task="${t.id}">${tr('撤销它的改动')}</button>` : ''}</div>` : ''}
      ${t.feedbacks?.length ? `<div><h4>${tr('你的意见')}</h4>${t.feedbacks.map((f) => `<div class="note">• ${esc(f.text)}</div>`).join('')}</div>` : ''}
      <div><h4>${tr('改动（{0} 个文件）{1}', [t.changes?.length || 0, t.undone ? tr(' · 已撤销') : ''])}</h4>${changes || `<div class="hint">${tr('还没有改动')}</div>`}</div>
      <div><h4>${tr('过程')}</h4>${attempts || `<div class="hint">${tr('还没开始')}</div>`}</div>
    </div>`;
}
async function openTaskDiff(taskId, file) {
  try {
    const d = await api(`/api/spaces/${state.space.id}/taskdiff/${taskId}?path=${encodeURIComponent(file)}`);
    state.files.view = { type: 'taskdiff', taskId, ...d };
    renderFilesBody();
  } catch (e) { toast(e.message, 'error'); }
}
export function renderTaskDiff(body, v) {
  body.innerHTML = `<div class="diff-view"><div class="editor-head"><button class="icon-btn" type="button" data-tact="back-task" data-task="${esc(v.taskId)}" title="${tr('返回')}">${ICON.back}</button>
    <span class="ep">${esc(v.taskId)} · ${esc(v.path)}</span></div><div class="diff">${diffHtml(v.before, v.after)}</div></div>`;
}

// ---- 操作 ----
const runAction = (action, body = {}) => api(`/api/spaces/${state.space.id}/run/${action}`, { method: 'POST', body });

async function onTaskAction(b, root) {
  const act = b.dataset.tact;
  const taskId = b.dataset.task;
  const sp = state.space;
  try {
    switch (act) {
      case 'start': {
        const objective = $('#tkObjective').value.trim();
        if (!objective) { toast(tr('先写下目标'), 'error'); return; }
        b.disabled = true;
        await api(`/api/spaces/${sp.id}/runs`, { method: 'POST', body: { objective, coordinatorId: $('#tkCoord').value, discuss: $('#tkDiscuss')?.checked ?? false, maxParallel: $('#tkPar').value, autoApprove: $('#tkAuto').checked } });
        break;
      }
      case 'pe-add': {
        let n = planDraft.tasks.length + 1;
        while (planDraft.tasks.some((t) => t.id === `T${n}`)) n++;
        planDraft.tasks.push({ id: `T${n}`, title: '', assigneeId: sp.members[0].id, deps: [], spec: '' });
        $('#planTasks').innerHTML = planEditorRows();
        return;
      }
      case 'pe-del': {
        const i = +b.closest('[data-pi]').dataset.pi;
        const [gone] = planDraft.tasks.splice(i, 1);
        for (const t of planDraft.tasks) t.deps = t.deps.filter((d) => d !== gone.id);
        $('#planTasks').innerHTML = planEditorRows();
        return;
      }
      case 'approve-plan':
        if (!planDraft.tasks.length || planDraft.tasks.some((t) => !t.title.trim() || !t.spec.trim())) { toast(tr('每个子任务都要有标题和说明'), 'error'); return; }
        b.disabled = true;
        await runAction('approve-plan', { tasks: planDraft.tasks });
        break;
      case 'replan':
        await runAction('replan', { feedback: $('#replanText').value });
        break;
      case 'cancel':
        if (!confirm(tr('取消这次任务吗？正在做的子任务会被中止。{0}', [sp.run.mode === 'git' ? tr('\n各 AI 的独立副本和临时分支会被删除，你的项目不受影响。') : tr('\n已经改了的文件不会自动还原（可以在改动记录里撤销）。')]))) return;
        await runAction('cancel');
        break;
      case 'close':
        await runAction('close');
        if (state.files.view?.type?.startsWith('task')) { state.files.view = null; renderFilesPanel(); }
        break;
      case 'merge': {
        b.disabled = true;
        const m = await runAction('merge');
        toast(tr('已合并到 {0}', [m.branch]));
        loadFiles(); loadHistory();
        break;
      }
      case 'open': case 'back-task': openTask(taskId); return;
      case 'answer': {
        const inp = $(`[data-keep="ans-${sp.run.id}-${taskId}"]`, root);
        if (!inp?.value.trim()) { toast(tr('先写下回答'), 'error'); return; }
        await runAction('answer', { taskId, answer: inp.value });
        inp.value = '';
        break;
      }
      case 'answer-detail': {
        const inp = $('#ansText');
        if (!inp?.value.trim()) { toast(tr('先写下回答'), 'error'); return; }
        await runAction('answer', { taskId, answer: inp.value });
        inp.value = '';
        break;
      }
      case 'reject-task': {
        const inp = $('#fbText');
        if (!inp?.value.trim()) { toast(tr('退回时请写下要怎么改'), 'error'); inp?.focus(); return; }
        await runAction('reject-task', { taskId, feedback: inp.value });
        inp.value = '';
        break;
      }
      case 'approve-task': {
        b.disabled = true;
        const res = await runAction('approve-task', { taskId });
        if (res.conflict) toast(tr('{0} 和已通过的改动冲突了（{1}），已让负责人去解决冲突', [taskId, (res.files || []).join('、')]), 'error');
        break;
      }
      case 'undo-task':
        if (!confirm(tr('撤销这个子任务对文件做的全部改动吗？'))) return;
        await runAction('undo-task', { taskId });
        loadFiles(); loadHistory();
        break;
      default:
        await runAction(act, { taskId });
    }
  } catch (e) {
    toast(e.message, 'error');
    b.disabled = false;
  }
  refreshTaskDetail();
}

$('#taskView').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tact]');
  if (b) { onTaskAction(b, $('#taskView')); return; }
  if (e.target.closest('input, select, textarea, a, summary, details, .plan-edit')) return;
  const card = e.target.closest('.tcard[data-task]');
  if (card) openTask(card.dataset.task);
});
$('#taskView').addEventListener('input', (e) => {
  const row = e.target.closest('[data-pi]');
  if (!row || !planDraft) return;
  const t = planDraft.tasks[+row.dataset.pi];
  if (e.target.dataset.pe) {
    t[e.target.dataset.pe] = e.target.value;
    if (e.target.dataset.pe === 'assigneeId') row.style.setProperty('--c', memberColor(t.assigneeId));
  }
  if (e.target.dataset.dep) t.deps = $$('[data-dep]', row).filter((x) => x.checked).map((x) => x.dataset.dep);
});
$('#taskView').addEventListener('change', async (e) => {
  const s = e.target.closest('[data-reassign]');
  if (!s) return;
  try { await runAction('reassign', { taskId: s.dataset.reassign, memberId: s.value }); } catch (err) { toast(err.message, 'error'); }
});
$('#filesBody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tact]');
  if (b) { e.stopPropagation(); onTaskAction(b, $('#filesBody')); return; }
  const d = e.target.closest('[data-tdiff]');
  if (d && state.files.view?.type === 'task') { e.stopPropagation(); openTaskDiff(state.files.view.taskId, d.dataset.tdiff); }
}, true);

