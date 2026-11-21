// 任务空间：右侧栏的「计划」面板（子任务、依赖、状态、子任务详情）+ 对话里的目标卡片、计划卡片、协调者的判断卡片、总结卡片
import { activitiesHtml, memberOf, messageHtml, renderComposer, renderHeader, renderMembersBar, updateMessage } from './chat.js';
import { enterPanel, loadFiles, loadHistory, renderFilesBody, showView } from './files.js';
import { showModal } from './engines.js';
import { checkNoteLength, removeNotes, renderNoteDiff, taskNoteList, taskNotes } from './notes.js';
import { formatNotes } from './notes-format.js';
import { currentPanel, setPanelBadge, showPanel } from './rightbar.js';
import { register } from './slots.js';
import { $, $$, ICON, api, clock, errHtml, esc, getLanguage, mascot, md, state, toast, tr } from './util.js';

const RUN_STATUS = { planning: tr('规划中'), clarifying: tr('等你回答问题'), plan_review: tr('等你确认计划'), executing: tr('执行中'), summarizing: tr('协调者在写总结'), done: tr('做完了'), failed: tr('没有完成规划'), cancelled: tr('已取消') };
const T_STATUS = { pending: tr('等前置任务'), ready: tr('排队中'), running: tr('进行中'), review: tr('待你审查'), approved: tr('已通过'), failed: tr('失败'), blocked: tr('等你回答'), skipped: tr('已跳过'), cancelled: tr('已取消') };
const WHAT = { title: tr('标题'), spec: tr('说明'), assignee: tr('负责人'), deps: tr('依赖') };
let planDraft = null;

const memberName = (id) => memberOf(id)?.name || tr('（已移除）');
const memberColor = (id) => memberOf(id)?.color || 'var(--muted)';
const mins = (ms) => (ms < 60000 ? tr('{0} 秒', [Math.round(ms / 1000)]) : tr('{0} 分钟', [(ms / 60000).toFixed(1)]));
const firstLine = (s, n = 100) => String(s || '').split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').slice(0, n) || '';
const runAction = (action, body = {}) => api(`/api/spaces/${state.space.id}/run/${action}`, { method: 'POST', body });

/** 协调者的回复去掉最后给软件看的 JSON（写到一半时也先藏起来）。 */
export function coordinatorText(text, streaming) {
  let t = String(text || '');
  const i = t.search(/```(?:json)?\s*\n?\s*\{/);
  if (i >= 0) t = t.slice(0, i);
  else if (streaming) t = t.replace(/`{1,3}[a-z]*\s*$/i, '');
  return t.trim();
}

// ================= 右侧栏的「计划」面板 =================
export function renderTaskSpace() {
  const sp = state.space;
  if (!sp || sp.kind !== 'task') return;
  refreshPlan();
  renderIntro(true);
}

const runState = (r) => (r.closed ? tr('已结束') : r.hold ? tr('改过的计划等你确认') : r.paused && r.status === 'executing' ? tr('已暂停') : RUN_STATUS[r.status] || r.status);
const runNeedsYou = (r) => !!r && !r.closed && (r.status === 'clarifying' || r.status === 'plan_review' || !!r.hold || r.tasks.some((t) => !t.removed && ['review', 'blocked', 'failed'].includes(t.status)));
/** 顶栏标题下面的一行：任务进行到哪了（点它打开计划面板）。 */
export function taskStatusText() {
  const r = state.space?.kind === 'task' ? state.space.run : null;
  if (!r) return '';
  const live = r.tasks.filter((t) => !t.removed);
  const ok = live.filter((t) => t.status === 'approved').length;
  return live.length && !['planning', 'plan_review'].includes(r.status) ? `${runState(r)} · ${tr('{0}/{1} 通过', [ok, live.length])}` : runState(r);
}
/** 计划有变化：标签上的提醒点跟着变；正在看计划列表就重画。 */
function refreshPlan() {
  setPanelBadge('plan', runNeedsYou(state.space?.run) ? 'dot' : null);
  if (currentPanel() === 'plan' && !state.files.view) renderFilesBody();
}

function renderPlanPane(body) {
  enterPanel('plan');
  const v = state.files.view;
  if (v?.type === 'task') return renderTaskDetail(body, v);
  if (v?.type === 'taskdiff') return renderTaskDiff(body, v);
  body.innerHTML = planListHtml();
}
register('panels', { id: 'plan', label: tr('计划'), icon: ICON.task, order: 30, when: (ctx) => ctx.space?.kind === 'task', render: renderPlanPane });

function planListHtml() {
  const r = state.space.run;
  if (!r) return `<div class="plan-head"><span class="ts-state">${tr('准备中…')}</span></div>`;
  const live = r.tasks.filter((t) => !t.removed);
  const ok = live.filter((t) => t.status === 'approved').length;
  const settled = live.filter((t) => ['approved', 'skipped', 'cancelled'].includes(t.status)).length;
  const btns = [];
  if (!r.closed) {
    if (r.hold) btns.push(`<button class="btn sm primary" type="button" data-tact="confirm-plan">${tr('确认新计划')}</button>`);
    if (r.paused && r.status === 'executing') btns.push(`<button class="btn sm primary" type="button" data-tact="resume">${tr('继续执行')}</button>`);
    if (r.status === 'done' && r.mode === 'git' && !r.merged && ok) btns.push(`<button class="btn sm primary" type="button" data-tact="merge">${tr('合并到 {0}', [esc(r.git?.baseBranch || tr('你的分支'))])}</button>`);
    btns.push(`<button class="btn sm" type="button" data-tact="finish">${tr('结束任务')}</button>`);
  }
  const rows = live.length && !['planning', 'plan_review'].includes(r.status) ? `<div class="ts-tasks">${live.map((t) => stripRowHtml(r, t)).join('')}${r.tasks.some((t) => t.removed) ? `<div class="ts-removed hint">${tr('已从计划中去掉：{0}', [r.tasks.filter((t) => t.removed).map((t) => esc(t.id)).join('、')])}</div>` : ''}</div>` : '';
  const assume = assumptionsHtml(r);
  return `<div class="plan-head ${runNeedsYou(r) ? 'needs' : ''}">
      <div class="ph-top"><span class="ts-state">${runState(r)}</span>${live.length ? `<span class="ts-count">${tr('{0}/{1} 通过', [ok, live.length])}</span>` : ''}</div>
      ${live.length ? `<span class="ts-bar"><i style="width:${Math.round((settled / live.length) * 100)}%"></i></span>` : ''}
      <div class="ph-meta"><span class="ts-mode" title="${r.mode === 'git' ? tr('每个子任务在独立副本里进行，通过审查后合并') : tr('子任务按顺序直接修改共享文件夹')}">${r.mode === 'git' ? tr('并行 · {0}', [esc(r.git?.baseBranch || 'git')]) : tr('依次修改')}</span>${r.thinking ? `<span>${tr(' · 协调者在看你的消息')}</span>` : ''}</div>
      ${btns.length ? `<div class="ph-actions">${btns.join('')}</div>` : ''}
    </div>${assume ? `<div class="ph-assume">${assume}</div>` : ''}${rows}`;
}

function stripRowHtml(r, t) {
  const a = t.attempts.at(-1);
  let sub = '';
  if (t.status === 'running') sub = a?.activities?.at(-1)?.label || tr('思考中…');
  else if (t.status === 'blocked') sub = t.question || '';
  else if (t.status === 'failed') sub = a?.error || '';
  else if (t.deps.length && t.status === 'pending') sub = tr('依赖 {0}', [t.deps.join('、')]);
  const act = r.closed ? '' : t.status === 'review' ? `<button class="btn sm" type="button" data-tact="open" data-task="${t.id}">${tr('审查')}</button>`
    : t.status === 'blocked' ? `<button class="btn sm" type="button" data-tact="open" data-task="${t.id}">${tr('回答')}</button>`
      : t.status === 'failed' && r.status === 'executing' ? `<button class="btn sm" type="button" data-tact="retry-task" data-task="${t.id}">${tr('重试')}</button>` : '';
  const sel = state.files.view?.type === 'task' && state.files.view.taskId === t.id;
  return `<div class="ts-row ${sel ? 'sel' : ''}" data-task="${t.id}" style="--c:${memberColor(t.assigneeId)}" role="button" tabindex="0">
    <span class="dot ${t.status}"></span><span class="tid">${esc(t.id)}</span><span class="tt">${esc(t.title)}</span>
    <span class="st ${t.status}">${T_STATUS[t.status] || t.status}</span>
    <span class="ts-line2"><span class="tc-who">${esc(memberName(t.assigneeId))}</span>${sub ? `<span class="ts-sub">${esc(sub)}</span>` : ''}${act ? `<span class="ts-act">${act}</span>` : ''}</span></div>`;
}

// ================= 对话最上面：目标、规划过程、计划 =================
// 重新渲染时保留输入框里没提交的内容与焦点
function keepInputs(root, render) {
  const vals = new Map($$('[data-keep]', root).map((el) => [el.dataset.keep, el.value]));
  const focused = document.activeElement?.dataset?.keep;
  const sel = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  render();
  for (const el of $$('[data-keep]', root)) if (vals.has(el.dataset.keep)) el.value = vals.get(el.dataset.keep);
  if (focused) { const el = $(`[data-keep="${focused}"]`, root); if (el) { el.focus(); try { el.setSelectionRange(...sel); } catch { /* select */ } } }
}

function renderIntro(force = false) {
  const box = $('#taskIntro');
  const sp = state.space;
  if (!box || !sp) return;
  const r = sp.run;
  const key = r ? `${r.id}:${r.status}:${r.planVersion || 0}` : 'none';
  // 正在改计划时不要被推送打断
  if (!force && r?.status === 'plan_review' && box.dataset.key === key && planDraft?.key === key) return;
  box.dataset.key = key;
  keepInputs(box, () => { box.innerHTML = goalHtml(sp) + (r ? planningHtml(r) : ''); });
  tickCountdown();
}

function goalHtml(sp) {
  const r = sp.run;
  const objective = r?.objective || '';
  const src = sp.source;
  const long = objective.split('\n').length > 6 || objective.length > 400;
  return `<section class="goal-card">
    <div class="gc-head"><span class="gc-label">${tr('目标')}</span>
      ${src ? `<span class="hint">${tr('从聊天空间 {0} 转来{1}', [`<a href="#/space/${esc(src.spaceId)}">「${esc(src.title)}」</a>`, src.messages ? tr('（{0} 条消息）', [src.messages]) : ''])}</span>` : ''}
      <span class="m">${r ? new Date(r.createdAt).toLocaleString(getLanguage(), { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</span></div>
    ${long ? `<details class="gc-body"><summary><span class="md">${md(firstLine(objective, 200))}</span><span class="hint">${tr('展开全文')}</span></summary><div class="md">${md(objective)}</div></details>` : `<div class="md gc-body">${md(objective)}</div>`}
  </section>`;
}

const planMsgHtml = (m) => messageHtml({ ...m, kind: 'ai', id: `p-${m.id}` });
// 协调者提问的那条：去掉给软件看的 JSON（问题本身画成卡片，问完是问答记录）
const askMsgHtml = (m) => planMsgHtml({ ...m, text: coordinatorText(m.text, m.streaming) });

function planningHtml(r) {
  if (r.status === 'clarifying' && !r.closed) return `${r.planning.messages[0] ? askMsgHtml(r.planning.messages[0]) : ''}${clarifyCardHtml(r)}`;
  const msgs = r.planning.messages.map((m, i) => (i === 0 && r.clarify ? askMsgHtml(m) + answersHtml(r) : planMsgHtml(m))).join('');
  if (r.status === 'planning' && !r.tasks.length) {
    return `<div class="plan-msgs">${msgs}</div>${msgs ? '' : `<div class="hint plan-wait busy-line">${mascot('thinking')}<span>${tr('{0} 正在规划…', [esc(memberName(r.coordinatorId))])}</span></div>`}`;
  }
  const process = msgs ? `<details class="plan-msgs"><summary>${tr('规划过程（{0} 条发言）', [r.planning.messages.length])}</summary>${msgs}</details>` : '';
  if (!r.tasks.length) {
    return `${process}<section class="plan-card">${r.error ? errHtml(r.error) : ''}<div class="hint">${tr('在下面说说想怎么做，协调者会重新规划')}</div></section>`;
  }
  if (r.status === 'plan_review' && !r.closed) return process + planEditorHtml(r);
  const live = r.tasks.filter((t) => !t.removed);
  return `${process}<section class="plan-card done">
    <div class="pc-line"><span class="pc-check">${ICON.check}</span><span>${tr('计划已确认 · {0} 个子任务', [live.length])}${r.planConfirm === 'auto' ? `<span class="hint">${tr(' · 计划定好自动开始')}</span>` : ''}</span></div>
    ${assumptionsHtml(r)}
  </section>`;
}

// ================= 规划前澄清：协调者的问题、计划开头的假设 =================
function clarifyCardHtml(r) {
  const c = r.clarify;
  return `<section class="plan-card clarify">
    ${c.questions.map((q) => `<label class="cq"><span class="cq-q">${esc(q.text)}</span>
      <input data-keep="cq-${r.id}-${esc(q.id)}" data-cq="${esc(q.id)}" placeholder="${esc(q.default)}" autocomplete="off"></label>`).join('')}
    <div class="pc-foot">${c.deadline ? `<span class="hint cq-timer" data-deadline="${c.deadline}">${countdownText(c.deadline)}</span>` : ''}<span class="grow"></span>
      <button class="btn" type="button" data-tact="clarify-defaults">${tr('按默认开始')}</button>
      <button class="btn primary" type="button" data-tact="clarify-answer">${tr('开始')}</button></div>
  </section>`;
}

/** 问过以后（规划过程里）：每个问题最后怎么定的。 */
function answersHtml(r) {
  const c = r.clarify;
  if (!c?.resolvedAt) return '';
  return `<ul class="cq-done">${c.questions.map((q) => {
    const a = c.answers?.[q.id];
    return `<li><span class="cq-q">${esc(q.text)}</span>${a ? `<span>${esc(a)}</span>` : `<span class="def">${esc(q.default || tr('默认'))}</span>`}</li>`;
  }).join('')}</ul>`;
}

/** 计划开头的假设；按默认处理的几条（排在最前面）换个记号。 */
function assumptionsHtml(r) {
  const list = r.assumptions || [];
  if (!list.length) return '';
  const defaulted = r.clarify?.resolvedAt ? (r.clarify.defaulted?.length || 0) : 0;
  return `<ul class="assume" aria-label="${tr('假设')}">${list.map((a, i) => `<li class="${i < defaulted ? 'def' : ''}">${esc(a)}</li>`).join('')}</ul>`;
}

function countdownText(deadline) {
  const s = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  return tr('{0} 后按默认开始', [`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`]);
}
// 自动开始的倒计时：只改这一行字，不重画卡片
let countdownTimer = 0;
function tickCountdown() {
  const el = $('#taskIntro .cq-timer');
  if (!el) { clearInterval(countdownTimer); countdownTimer = 0; return; }
  el.textContent = countdownText(+el.dataset.deadline);
  if (!countdownTimer) countdownTimer = setInterval(tickCountdown, 1000);
}

function planEditorHtml(r) {
  const key = `${r.id}:${r.status}:${r.planVersion || 0}`;
  if (!planDraft || planDraft.key !== key) planDraft = { key, tasks: r.tasks.map((t) => ({ id: t.id, title: t.title, assigneeId: t.assigneeId, deps: [...t.deps], spec: t.spec })) };
  return `<section class="plan-card plan-edit">
    <div class="pc-head"><b>${tr('计划')}</b><span class="hint">${tr('可以直接改，也可以在下面和协调者说')}</span></div>
    ${r.error ? errHtml(r.error) : ''}${assumptionsHtml(r)}
    <div class="tasks" id="planTasks">${planEditorRows()}</div>
    <div class="pc-foot"><button class="btn sm ghost" type="button" data-tact="pe-add">${ICON.plus}${tr('添加子任务')}</button><span class="grow"></span>
      <button class="btn primary" type="button" data-tact="approve-plan">${tr('批准并执行')}</button></div>
  </section>`;
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

// ================= 协调者的判断卡片 / 总结卡片 =================
const taskRef = (x) => `<button type="button" class="tref" data-tact="open" data-task="${esc(x.task)}"><span class="tid">${esc(x.task)}</span>${esc(x.title)}</button>`;

export function decisionHtml(m) {
  const d = m.decision;
  const r = state.space?.run;
  if (!d || d.type === 'answer') return '';
  if (d.type === 'unrelated') {
    return `<div class="decision"><div class="dc-head">${tr('和这次任务的目标无关')}</div>
      ${d.why ? `<div class="dc-why">${esc(d.why)}</div>` : ''}
      ${r?.closed ? '' : `<div class="dc-foot"><button class="btn sm" type="button" data-tact="new-task" data-msg="${esc(m.replyTo || '')}">${tr('新开一个任务空间')}</button></div>`}</div>`;
  }
  if (d.type === 'note') {
    if (!d.notes?.length) return '';
    return `<div class="decision"><div class="dc-head">${tr('没有冲突，记为补充说明')}</div>
      ${d.why ? `<div class="dc-why">${esc(d.why)}</div>` : ''}
      <ul class="dc-list">${d.notes.map((n) => `<li>${taskRef(n)}<span class="dc-text">${esc(n.text)}</span>${n.running ? `<span class="hint">${tr('正在做，下一次做时带上')}</span>` : ''}</li>`).join('')}</ul></div>`;
  }
  const sec = (title, items, row) => (items?.length ? `<div class="dc-sec"><div class="dc-label">${title}</div><ul class="dc-list">${items.map(row).join('')}</ul></div>` : '');
  const latestHold = d.hold && r?.hold && [...state.space.messages].reverse().find((x) => x.decision?.type === 'change')?.id === m.id;
  return `<div class="decision change"><div class="dc-head">${tr('有冲突，改了计划')}</div>
    ${d.why ? `<div class="dc-why">${esc(d.why)}</div>` : ''}
    ${sec(tr('停下'), d.stopped, (x) => `<li>${taskRef(x)}<span class="hint">${x.keep ? tr('做了一半的改动留着') : tr('做了一半的改动已丢掉')}</span></li>`)}
    ${sec(tr('新增'), d.added, (x) => `<li>${taskRef(x)}<span class="hint">${esc(memberName(x.assigneeId))}</span></li>`)}
    ${sec(tr('修改'), d.changed, (x) => `<li>${taskRef(x)}<span class="hint">${x.what.map((w) => WHAT[w] || w).join('、') || tr('恢复')}</span></li>`)}
    ${sec(tr('去掉'), d.removed, (x) => `<li><span class="tref off"><span class="tid">${esc(x.task)}</span>${esc(x.title)}</span></li>`)}
    ${latestHold ? `<div class="dc-foot"><span class="hint">${tr('新计划等你确认后才继续派新的子任务')}</span><button class="btn sm primary" type="button" data-tact="confirm-plan">${tr('确认新计划')}</button></div>`
      : d.hold ? `<div class="dc-foot hint">${tr('已确认')}</div>` : ''}
  </div>`;
}

export function summaryCardHtml(m) {
  const r = state.space?.run;
  const latest = [...(state.space?.messages || [])].reverse().find((x) => x.kind === 'summary')?.id === m.id;
  const btns = [];
  if (latest && r && !r.closed && r.status === 'done') {
    if (r.mode === 'git' && !r.merged && m.approved) btns.push(`<button class="btn sm primary" type="button" data-tact="merge">${tr('合并到 {0}', [esc(r.git?.baseBranch || tr('你的分支'))])}</button>`);
    btns.push(`<button class="btn sm" type="button" data-tact="finish">${tr('结束任务')}</button>`);
  }
  return `<div class="msg summary-card" id="m-${m.id}" data-seq="${esc(m.seq)}">
    <div class="sc-head"><span class="sc-label">${tr('总结')}</span><span class="hint">${tr('{0} · {1}/{2} 个子任务通过', [esc(m.name), m.approved, m.total])}</span><span class="m">${clock(m.ts)}</span></div>
    ${m.text ? `<div class="md">${md(m.text)}</div>` : ''}${m.error ? errHtml(m.error) : ''}
    ${latest && r?.merged ? `<div class="note">${tr('已合并到 {0}', [esc(r.merged.branch)])}</div>` : ''}
    ${latest && r && !r.closed && r.status === 'done' ? `<div class="hint sc-more">${tr('还可以接着提要求，协调者会追加子任务；都做完了就结束任务。')}</div>` : ''}
    ${btns.length ? `<div class="sc-foot">${btns.join('')}</div>` : ''}
  </div>`;
}

// ================= 推送 =================
let taskRaf = 0;
let detailTimer = null;
function scheduleTaskRender() {
  if (taskRaf) return;
  taskRaf = requestAnimationFrame(() => {
    taskRaf = 0;
    if (state.space?.kind !== 'task') return;
    refreshPlan();
    renderIntro();
    renderMembersBar();
    renderHeader();
    renderComposer();
    // 判断卡片上的「确认新计划」、总结卡片上的按钮跟着状态变
    for (const m of state.space.messages) if (m.decision?.hold || m.kind === 'summary') updateMessage(m);
  });
}
export function onRunEvent(run) {
  const sp = state.space;
  if (!sp || sp.kind !== 'task') return;
  const prev = sp.run;
  sp.run = run;
  if (run && prev?.status !== run.status && run.status === 'plan_review' && run.planConfirm !== 'auto') toast(tr('计划拟好了，请确认'));
  if (run && prev && prev.status !== run.status && run.status === 'clarifying') toast(tr('协调者有几个问题想先问你'));
  scheduleTaskRender();
  const v = state.files.views.plan;
  if (v?.type === 'taskdiff' && currentPanel() === 'plan' && reviewAssignee(prev, v.taskId) !== reviewAssignee(run, v.taskId)) renderFilesBody();
  if (v?.type === 'task' && !detailTimer) detailTimer = setTimeout(() => { detailTimer = null; refreshTaskDetail(); }, 700);
}

// ================= 子任务详情（计划面板里） =================
async function openTask(taskId) {
  showView({ type: 'task', taskId, detail: null });
  await refreshTaskDetail();
  scheduleTaskRender();
}
async function refreshTaskDetail() {
  const v = state.files.views.plan;
  if (v?.type !== 'task' || !state.space?.run) return;
  try { v.detail = await api(`/api/spaces/${state.space.id}/task/${v.taskId}`); } catch (e) { v.detail = { error: e.message }; }
  if (state.files.views.plan === v && currentPanel() === 'plan') keepInputs($('#filesBody'), () => renderFilesBody());
}
export function renderTaskDetail(body, v) {
  const t = v.detail;
  const r = state.space.run;
  if (!t) { body.innerHTML = `<div class="empty-files">${tr('加载中…')}</div>`; return; }
  if (t.error && !t.id) { body.innerHTML = `<div class="empty-files">${esc(t.error)}</div>`; return; }
  const k = `${r?.id}-${t.id}`;
  const open = r && !r.closed;
  const changes = (t.changes || []).map((c) => `<div class="chg-row" data-tdiff="${esc(c.path)}">${c.status === 'A' || c.created ? '<span class="fst a">A</span>' : c.status === 'D' || c.deleted ? '<span class="fst d">D</span>' : '<span class="fst">M</span>'}<span class="fp">${esc(c.path)}</span><span class="plus">+${c.added}</span><span class="minus">−${c.removed}</span></div>`).join('');
  const live = open && r.status === 'executing';
  const outcome = { done: tr('报告完成'), question: tr('提了问题'), stopped: tr('被协调者停下'), cancelled: tr('被中止'), failed: tr('失败') };
  const attempts = t.attempts.map((a, i) => ({ a, i })).reverse().map(({ a, i }) => `<div class="attempt">
      <div class="attempt-head"><b>${tr('第 {0} 次', [i + 1])}</b><span>${new Date(a.startedAt).toLocaleTimeString(getLanguage(), { hour12: false })}</span>${a.endedAt ? `<span>${mins(a.endedAt - a.startedAt)}</span>` : '<span class="typing"><i></i><i></i><i></i></span>'}
        ${a.outcome ? `<span class="st ${a.outcome === 'done' ? 'approved' : a.outcome === 'question' ? 'blocked' : a.outcome === 'stopped' ? 'pending' : 'failed'}">${outcome[a.outcome] || a.outcome}</span>` : ''}</div>
      ${a.conflict ? `<div class="note">${tr('这次是在解决合并冲突：{0}', [esc(a.conflict.join('、'))])}</div>` : ''}
      ${activitiesHtml(a.activities, !a.endedAt)}
      ${a.report || a.text ? `<div class="md">${md(a.report || a.text)}</div>` : ''}
      ${a.note ? `<div class="note">${esc(a.note)}</div>` : ''}
      ${a.error ? errHtml(a.error) : ''}
      ${a.log?.length ? `<details><summary class="hint">${tr('原始输出')}</summary><div class="log">${esc(a.log.join('\n'))}</div></details>` : ''}
    </div>`).join('');
  body.innerHTML = `<div class="editor-head"><button class="icon-btn" type="button" data-act="back" title="${tr('返回')}">${ICON.back}</button>
      <span class="ep">${esc(t.id)} ${esc(t.title)}</span><span class="st ${t.status}">${T_STATUS[t.status]}</span></div>
    <div class="td">
      <div><h4>${tr('负责')}</h4><span style="color:${memberColor(t.assigneeId)};font-weight:500">${esc(memberName(t.assigneeId))}</span>${t.deps.length ? `<span class="hint">${tr(' · 依赖 {0}', [esc(t.deps.join('、'))])}</span>` : ''}
        ${live && ['failed', 'pending', 'ready', 'blocked'].includes(t.status) ? `<select data-reassign="${t.id}" class="td-reassign" title="${tr('改派给')}">${state.space.members.map((m) => `<option value="${m.id}" ${m.id === t.assigneeId ? 'selected' : ''}>${tr('负责：{0}', [esc(m.name)])}</option>`).join('')}</select>` : ''}</div>
      <div><h4>${tr('说明')}</h4><div class="spec">${esc(t.spec)}</div></div>
      ${t.notes?.length ? `<div><h4>${tr('中途补充的要求')}</h4>${t.notes.map((n) => `<div class="note">${esc(n.text)}</div>`).join('')}</div>` : ''}
      ${open && t.status === 'review' ? `<div class="review-box"><b>${tr('审查')}</b>
        ${taskNoteList(taskNotes(state.space.id, t.id))}
        <textarea data-keep="fb-${k}" id="fbText" rows="3" placeholder="${tr('退回时写下要怎么改')}"></textarea>
        <div class="row"><button class="btn sm primary" type="button" data-tact="approve-task" data-task="${t.id}">${tr('通过')}</button>
          <button class="btn sm" type="button" data-tact="reject-task" data-task="${t.id}">${tr('带意见退回重做')}</button>
          ${r.mode === 'direct' && t.changes?.length ? `<button class="btn sm danger" type="button" data-tact="undo-task" data-task="${t.id}">${tr('撤销它的全部改动')}</button>` : ''}</div></div>` : ''}
      ${open && t.status === 'blocked' ? `<div class="review-box"><b>${tr('{0} 问你：', [esc(memberName(t.assigneeId))])}</b><div>${esc(t.question || '')}</div>
        <textarea data-keep="ans2-${k}" id="ansText" rows="2" placeholder="${tr('写下回答，它会接着做')}"></textarea><div class="row"><button class="btn sm primary" type="button" data-tact="answer-detail" data-task="${t.id}">${tr('回答')}</button></div></div>` : ''}
      ${live && t.status === 'failed' ? `<div class="row"><button class="btn sm primary" type="button" data-tact="retry-task" data-task="${t.id}">${tr('重试')}</button> <button class="btn sm" type="button" data-tact="skip-task" data-task="${t.id}">${tr('跳过')}</button>${r.mode === 'direct' && t.changes?.length ? ` <button class="btn sm danger" type="button" data-tact="undo-task" data-task="${t.id}">${tr('撤销它的改动')}</button>` : ''}</div>` : ''}
      ${live && t.status === 'running' ? `<div class="row"><button class="btn sm" type="button" data-tact="stop-task" data-task="${t.id}">${ICON.stop}${tr('停止')}</button></div>` : ''}
      ${live && ['pending', 'ready', 'blocked'].includes(t.status) ? `<div class="row"><button class="btn sm" type="button" data-tact="skip-task" data-task="${t.id}">${tr('跳过')}</button></div>` : ''}
      ${t.feedbacks?.length ? `<div><h4>${tr('你的意见')}</h4>${t.feedbacks.map((f) => `<div class="note">${esc(f.text)}</div>`).join('')}</div>` : ''}
      <div><h4>${tr('改动（{0} 个文件）{1}', [t.changes?.length || 0, t.undone ? tr(' · 已撤销') : ''])}</h4>${changes || `<div class="hint">${tr('还没有改动')}</div>`}</div>
      <div><h4>${tr('过程')}</h4>${attempts || `<div class="hint">${tr('还没开始')}</div>`}</div>
    </div>`;
}
async function openTaskDiff(taskId, file) {
  const detail = state.files.view;
  try {
    const d = await api(`/api/spaces/${state.space.id}/taskdiff/${taskId}?path=${encodeURIComponent(file)}`);
    if (state.files.view !== detail) return;
    state.files.view = { type: 'taskdiff', taskId, ...d };
    renderFilesBody();
  } catch (e) { toast(e.message, 'error'); }
}
function reviewAssignee(run, taskId) {
  if (!run || run.closed) return null;
  return run.tasks.find((t) => t.id === taskId && t.status === 'review')?.assigneeId;
}
export function renderTaskDiff(body, v) {
  body.innerHTML = `<div class="diff-view"><div class="editor-head"><button class="icon-btn" type="button" data-tact="back-task" data-task="${esc(v.taskId)}" title="${tr('返回')}">${ICON.back}</button>
    <span class="ep">${esc(v.taskId)} · ${esc(v.path)}</span></div><div class="diff"></div></div>`;
  renderNoteDiff($('.diff', body), v, reviewAssignee(state.space.run, v.taskId), renderFilesBody);
}

async function openMergeModal() {
  const branch = state.space.run.git?.baseBranch || tr('你的分支');
  const dlg = showModal(`<div class="modal-inner narrow">
    <div class="modal-head"><h3>${tr('合并到 {0}', [esc(branch)])}</h3></div>
    <div class="modal-body"><textarea rows="6" aria-label="${tr('提交说明')}" placeholder="${tr('起草中…')}" disabled></textarea></div>
    <div class="modal-foot"><button class="btn" type="button" data-act="close">${tr('取消')}</button><button class="btn primary" type="button" data-act="merge" disabled>${tr('合并')}</button></div>
  </div>`);
  const input = $('textarea', dlg);
  const merge = $('[data-act="merge"]', dlg);
  $('[data-act="close"]', dlg).onclick = () => dlg.close();
  try {
    const draft = await runAction('draft-commit');
    if (!dlg.open) return;
    input.value = draft.message;
    input.placeholder = '';
    input.disabled = merge.disabled = false;
    input.focus();
  } catch (err) {
    if (dlg.open) { dlg.close(); toast(err.message, 'error'); }
    return;
  }
  merge.onclick = async () => {
    input.disabled = merge.disabled = true;
    try {
      const m = await runAction('merge', { message: input.value });
      dlg.close();
      toast(tr('已合并到 {0}', [m.branch]));
      loadFiles(); loadHistory();
      refreshTaskDetail();
    } catch (err) {
      toast(err.message, 'error');
      input.disabled = merge.disabled = false;
    }
  };
}

// ================= 结束任务 =================
function openFinishModal() {
  const sp = state.space;
  const r = sp.run;
  const active = ['planning', 'executing', 'summarizing'].includes(r.status) || r.thinking;
  const summary = sp.messages.some((m) => m.kind === 'summary' && m.text);
  const unmerged = r.mode === 'git' && !r.merged && r.tasks.some((t) => t.status === 'approved');
  const dlg = showModal(`<div class="modal-inner narrow">
    <div class="modal-head"><h3>${tr('结束这个任务？')}</h3></div>
    <div class="modal-body">
      <p>${tr('结束后任务空间只读，留作记录；之后要接着做，可以再开一个类似的任务。')}</p>
      ${active ? `<p>${tr('正在做的子任务会先停下。')}</p>` : ''}
      ${unmerged ? `<p>${tr('通过的改动还没合并进你的项目，会保留在分支 {0} 上。', [`<code>${esc(r.git.intBranch)}</code>`])}</p>` : ''}
      ${sp.source ? `<label class="check-row"><input type="checkbox" id="fnPost" ${summary ? 'checked' : 'disabled'}> ${tr('把总结发回聊天空间「{0}」', [esc(sp.source.title)])}${summary ? '' : `<span class="hint">${tr('（还没有总结）')}</span>`}</label>` : ''}
    </div>
    <div class="modal-foot"><button class="btn" type="button" data-act="close">${tr('取消')}</button><button class="btn primary" type="button" data-act="finish">${tr('结束任务')}</button></div>
  </div>`);
  dlg.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'close') { dlg.close(); return; }
    b.disabled = true;
    try {
      const res = await runAction('finish', { postBack: !!$('#fnPost', dlg)?.checked });
      dlg.close();
      toast(res.posted ? tr('任务已结束，总结发回了「{0}」', [sp.source.title]) : tr('任务已结束'));
      if (state.files.views.plan) { state.files.views.plan = null; if (currentPanel() === 'plan') renderFilesBody(); }
    } catch (err) { toast(err.message, 'error'); b.disabled = false; }
  });
}

// ================= 操作 =================
async function onTaskAction(b, root) {
  const act = b.dataset.tact;
  const taskId = b.dataset.task;
  const sp = state.space;
  try {
    switch (act) {
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
      case 'finish': openFinishModal(); return;
      case 'clarify-answer': {
        const answers = Object.fromEntries($$('[data-cq]', root).map((el) => [el.dataset.cq, el.value.trim()]).filter(([, v]) => v));
        b.disabled = true;
        await runAction('clarify-answer', { answers });
        break;
      }
      case 'new-task': {
        const msg = sp.messages.find((m) => m.id === b.dataset.msg);
        const { openNewSpaceModal } = await import('./space-form.js');
        openNewSpaceModal({ kind: 'task', objective: msg?.text || '', members: sp.members, folder: sp.workspace.type === 'folder' ? sp.workspacePath : '' });
        return;
      }
      case 'merge': await openMergeModal(); return;
      case 'open': case 'back-task': openTask(taskId); return;
      case 'answer-detail': {
        const inp = $('#ansText');
        if (!inp?.value.trim()) { toast(tr('先写下回答'), 'error'); return; }
        await runAction('answer', { taskId, answer: inp.value });
        inp.value = '';
        break;
      }
      case 'reject-task': {
        const inp = $('#fbText');
        const notes = taskNotes(sp.id, taskId);
        const feedback = [inp.value.trim(), formatNotes(notes, tr)].filter(Boolean).join('\n\n');
        if (!feedback) { toast(tr('退回时请写下要怎么改'), 'error'); inp.focus(); return; }
        checkNoteLength(feedback);
        b.disabled = true;
        await runAction('reject-task', { taskId, feedback });
        removeNotes(sp.id, notes);
        inp.value = '';
        break;
      }
      case 'approve-task': {
        b.disabled = true;
        const res = await runAction('approve-task', { taskId });
        removeNotes(sp.id, taskNotes(sp.id, taskId));
        if (res.conflict) toast(tr('{0} 和已通过的改动冲突了（{1}），已让负责人去解决冲突', [taskId, (res.files || []).join('、')]), 'error');
        break;
      }
      case 'undo-task':
        if (!confirm(tr('撤销这个子任务对文件做的全部改动吗？'))) return;
        await runAction('undo-task', { taskId });
        loadFiles(); loadHistory();
        break;
      default:
        b.disabled = true;
        await runAction(act, { taskId });
    }
  } catch (e) {
    toast(e.message, 'error');
  }
  b.disabled = false;
  refreshTaskDetail();
}

$('#messages').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tact]');
  if (b) { e.stopPropagation(); onTaskAction(b, $('#messages')); }
});
// 问题卡片里按回车就开始
$('#messages').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing || !e.target.matches('[data-cq]')) return;
  e.preventDefault();
  $('[data-tact="clarify-answer"]', e.target.closest('.clarify'))?.click();
});
// 计划面板：点一行打开子任务详情
$('#filesBody').addEventListener('click', (e) => {
  if (e.target.closest('[data-tact], input, select, textarea, a, summary, details')) return;
  const row = e.target.closest('.ts-row[data-task]');
  if (row) openTask(row.dataset.task);
});
$('#filesBody').addEventListener('keydown', (e) => {
  const row = e.target.closest('.ts-row[data-task]');
  if (row && (e.key === 'Enter' || e.key === ' ') && e.target === row) { e.preventDefault(); openTask(row.dataset.task); }
});
// 顶栏标题下的任务进度：点它打开计划面板
$('#queueInfo').addEventListener('click', () => { if (state.space?.kind === 'task') showPanel('plan'); });
$('#messages').addEventListener('input', (e) => {
  const row = e.target.closest('[data-pi]');
  if (!row || !planDraft) return;
  const t = planDraft.tasks[+row.dataset.pi];
  if (e.target.dataset.pe) {
    t[e.target.dataset.pe] = e.target.value;
    if (e.target.dataset.pe === 'assigneeId') row.style.setProperty('--c', memberColor(t.assigneeId));
  }
  if (e.target.dataset.dep) t.deps = $$('[data-dep]', row).filter((x) => x.checked).map((x) => x.dataset.dep);
});
$('#filesBody').addEventListener('change', async (e) => {
  const s = e.target.closest('[data-reassign]');
  if (!s) return;
  try { await runAction('reassign', { taskId: s.dataset.reassign, memberId: s.value }); } catch (err) { toast(err.message, 'error'); }
});
$('#filesBody').addEventListener('click', (e) => {
  const del = e.target.closest('.review-note [data-note-delete]');
  if (del) {
    try {
      removeNotes(state.space.id, [{ id: del.dataset.noteDelete }]);
      keepInputs($('#filesBody'), renderFilesBody);
    } catch (err) { toast(err.message, 'error'); }
    return;
  }
  const b = e.target.closest('[data-tact]');
  if (b) { e.stopPropagation(); onTaskAction(b, $('#filesBody')); return; }
  const d = e.target.closest('[data-tdiff]');
  if (d && currentPanel() === 'plan' && state.files.view?.type === 'task') { e.stopPropagation(); openTaskDiff(state.files.view.taskId, d.dataset.tdiff); }
}, true);
