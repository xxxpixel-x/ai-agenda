import { register } from './slots.js';
import { $, $$, ICON, api, clock, emptyHtml, esc, getLanguage, state, toast, tr } from './util.js';

const schedulesUrl = '/api/schedules';
const clockIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2.5"/></svg>';
const weekdays = [[1, '一'], [2, '二'], [3, '三'], [4, '四'], [5, '五'], [6, '六'], [0, '日']];

function dateTime(at, shortToday = false) {
  const date = new Date(at);
  if (shortToday && date.toDateString() === new Date().toDateString()) return clock(at);
  return date.toLocaleString(getLanguage(), {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
}

function ruleText(rule) {
  if (rule.type === 'once') return dateTime(rule.at);
  if (rule.type === 'interval') return rule.minutes % 60 === 0
    ? tr('每隔 {0} 小时', [rule.minutes / 60]) : tr('每隔 {0} 分钟', [rule.minutes]);
  if (rule.days.length === 7) return tr('每天 {0}', [rule.time]);
  const days = weekdays.filter(([day]) => rule.days.includes(day)).map(([, label]) => tr(label));
  return tr('周{0} {1}', [days.join(tr('、')), rule.time]);
}

function actionText(action) {
  if (action.type === 'message') return tr('发消息：{0}', [action.text]);
  return tr('新建任务空间：{0}', [action.template.goal?.trim().split(/\r?\n/)[0] || '']);
}

function scheduleRow(schedule, { owner, disabled = false, expanded }) {
  const time = ruleText(schedule.rule);
  const next = schedule.enabled && schedule.nextAt != null && tr('下次 {0}', [dateTime(schedule.nextAt, true)]);
  const summary = [owner, actionText(schedule.action)].filter(Boolean).join(' · ');
  return `<div class="schedule-row" data-schedule="${esc(schedule.id)}">
    <button type="button" class="schedule-open"${disabled ? ' disabled' : ''}
      ${expanded === undefined ? '' : `aria-expanded="${esc(expanded)}"`}>
      <span class="schedule-time">${esc(time)}</span>
      <span class="schedule-meta"><span class="schedule-clip" title="${esc(summary)}">${esc(summary)}</span>
        ${next ? `<span class="schedule-next"> · ${esc(next)}</span>` : ''}</span>
    </button>
    <label class="switch"><input type="checkbox" role="switch" data-toggle="${esc(schedule.id)}"
      aria-label="${esc(tr('启用定时任务：{0}', [time]))}"${schedule.enabled ? ' checked' : ''}${disabled ? ' disabled' : ''}><i aria-hidden="true"></i></label>
  </div>`;
}

// 只接收当前视图的最新响应，切走标签后保留草稿。
function watchList(el, read, draw, watchSpaces = false) {
  let source = null;
  let version = 0;
  const pending = new Map();
  async function refresh() {
    if (!source) return;
    const request = ++version;
    try {
      const data = await read();
      if (request !== version) return;
      draw(data);
      for (const box of $$('[data-toggle]', el)) {
        if (!pending.has(box.dataset.toggle)) continue;
        box.checked = pending.get(box.dataset.toggle);
        box.disabled = true;
      }
    } catch (e) { if (request === version) toast(e.message, 'error'); }
  }
  function stop() {
    source?.close();
    source = null;
    version++;
  }
  function sync() {
    if (el.hidden) { stop(); return; }
    if (source) return;
    source = new EventSource('/api/events');
    source.onerror = () => { if (source) source.onopen = refresh; };
    source.onmessage = (event) => {
      const { type } = JSON.parse(event.data);
      if (type === 'schedules' || (watchSpaces && type === 'spaces')) refresh();
    };
    refresh();
  }
  el.onchange = async ({ target: box }) => {
    const id = box.dataset.toggle;
    if (!id) return;
    if (pending.has(id)) {
      box.checked = pending.get(id);
      box.disabled = true;
      return;
    }
    let enabled = box.checked;
    pending.set(id, enabled);
    box.disabled = true;
    try {
      await api(`${schedulesUrl}/${id}`, { method: 'PATCH', body: { enabled } });
    } catch (e) {
      enabled = !enabled;
      toast(e.message, 'error');
    } finally {
      pending.delete(id);
      // 推送可能已替换最初点击的开关。
      const current = $$('[data-toggle]', el).find((input) => input.dataset.toggle === id);
      if (current) {
        current.checked = enabled;
        current.disabled = $('.schedule-open', current.closest('.schedule-row')).disabled;
      }
      await refresh();
    }
  };
  const observer = new MutationObserver(sync);
  observer.observe(el, { attributes: true, attributeFilter: ['hidden'] });
  sync();
  return { refresh, dispose() { observer.disconnect(); stop(); el.onchange = null; } };
}

function spaceTemplate(space) {
  const run = space.run;
  return {
    title: space.title,
    members: space.members.map(({ engine, name, model, effort, persona, color, id }) =>
      ({ engine, name, model, effort, persona, color, id })),
    coordinatorId: run ? run.coordinatorId : space.members[0]?.id,
    workspace: { type: 'folder', path: space.workspacePath },
    access: space.access,
    planConfirm: run?.planConfirm || 'manual',
    reviewPlan: run ? run.discuss !== false : true,
    autoApprove: !!run?.autoApprove,
    maxParallel: run?.maxParallel || 3,
  };
}

function segment(name, label, choices) {
  return `<div class="seg" role="group" aria-label="${esc(tr(label))}">
    ${choices.map(([value, text]) => `<button type="button" class="seg-btn" data-segment="${esc(name)}"
      value="${esc(value)}">${esc(tr(text))}</button>`).join('')}</div>`;
}

function localInputTime(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function createEditor(space, schedule, close, saved) {
  const rule = schedule?.rule;
  const action = schedule?.action;
  const taskOnly = space.kind === 'task';
  const template = action?.template || spaceTemplate(space);
  const selected = {
    rule: rule?.type || 'once',
    action: taskOnly ? 'task' : action?.type || 'message',
    plan: template.planConfirm || 'manual',
  };
  const days = new Set(rule?.days || weekdays.map(([day]) => day));
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const once = localInputTime(rule?.type === 'once' ? new Date(rule.at) : tomorrow);
  const minutes = rule?.minutes || 60;
  const hours = minutes % 60 === 0;
  const members = (template.members || []).map((member) => member.name).join(tr('、'));
  const folder = template.workspace?.path?.split(/[\\/]/).filter(Boolean).pop();
  const hint = [members, folder].filter(Boolean).join(' · ');
  const form = document.createElement('form');
  form.className = 'schedule-editor';
  form.noValidate = true;
  form.innerHTML = `<div class="field"><span class="label">${esc(tr('时间'))}</span>
    ${segment('rule', '时间', [['once', '一次'], ['weekly', '每周'], ['interval', '每隔']])}
    <div class="schedule-inputs" data-pane="once"><input type="datetime-local" name="at" value="${esc(once)}" aria-label="${esc(tr('运行时间'))}"></div>
    <div class="schedule-inputs" data-pane="weekly">
      <div class="schedule-days">${weekdays.map(([day, label]) => `<button type="button" data-day="${esc(day)}"
        aria-label="${esc(tr('周{0}', [tr(label)]))}">${esc(tr(label))}</button>`).join('')}</div>
      <input type="time" name="time" value="${esc(rule?.time || '09:00')}" aria-label="${esc(tr('运行时间'))}"></div>
    <div class="schedule-inputs" data-pane="interval">
      <input type="number" name="amount" step="any" value="${esc(hours ? minutes / 60 : minutes)}" aria-label="${esc(tr('间隔'))}">
      <select name="unit" aria-label="${esc(tr('间隔单位'))}"><option value="1">${esc(tr('分钟'))}</option>
        <option value="60"${hours ? ' selected' : ''}>${esc(tr('小时'))}</option></select></div></div>
    <div class="field"><span class="label">${esc(taskOnly ? tr('新建任务空间') : tr('动作'))}</span>
      ${taskOnly ? '' : segment('action', '动作', [['message', '发一条消息'], ['task', '新建任务空间']])}
      <div data-pane="message"><label>${esc(tr('消息'))}<textarea name="message" rows="3" maxlength="8000" required>${esc(action?.text)}</textarea></label></div>
      <div data-pane="task"><label>${esc(tr('目标'))}<textarea name="goal" rows="3" required>${esc(template.goal ?? space.run?.objective)}</textarea></label>
        ${hint ? `<div class="hint schedule-clip" title="${esc(hint)}">${esc(hint)}</div>` : ''}
        <div class="schedule-plan"><span>${esc(tr('计划'))}</span>
          ${segment('plan', '计划', [['manual', '等我确认'], ['auto', '自动开始']])}</div></div></div>
    <div class="schedule-actions">${schedule ? `<button type="button" class="btn sm danger" data-remove>${esc(tr('删除'))}</button>` : ''}
      <span class="grow"></span><button type="button" class="btn sm" data-cancel>${esc(tr('取消'))}</button>
      <button type="submit" class="btn sm primary">${esc(tr('保存'))}</button></div>`;
  const fields = form.elements;
  function readRule() {
    if (selected.rule === 'weekly') {
      return days.size && fields.time.value ? { type: 'weekly', days: [...days], time: fields.time.value } : null;
    }
    if (selected.rule === 'interval') {
      const count = Number(fields.amount.value) * Number(fields.unit.value);
      if (!Number.isInteger(count) || count < 5 || count > 44640) return null;
      return { ...(rule?.type === 'interval' ? rule : {}), type: 'interval', minutes: count };
    }
    const at = rule?.type === 'once' && fields.at.value === once ? rule.at : new Date(fields.at.value).getTime();
    return Number.isFinite(at) ? { type: 'once', at } : null;
  }
  function sync() {
    for (const pane of $$('[data-pane]', form)) {
      pane.hidden = ![selected.rule, selected.action].includes(pane.dataset.pane);
    }
    for (const button of $$('[data-segment]', form)) {
      const on = selected[button.dataset.segment] === button.value;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    }
    for (const button of $$('[data-day]', form)) {
      button.setAttribute('aria-pressed', String(days.has(Number(button.dataset.day))));
    }
    validate();
  }
  function validate() {
    const validRule = readRule();
    fields.amount.setAttribute('aria-invalid', String(selected.rule === 'interval' && !validRule));
    const text = (selected.action === 'task' ? fields.goal : fields.message).value.trim();
    const validAction = text && (selected.action === 'task' || [...text].length <= 8000);
    $('button[type=submit]', form).disabled = !validRule || !validAction;
  }
  async function write(remove = false) {
    if (form.inert) return;
    form.inert = true;
    try {
      const path = schedule ? `${schedulesUrl}/${schedule.id}` : schedulesUrl;
      if (remove) await api(path, { method: 'DELETE' });
      else {
        const action = selected.action === 'message' ? { type: 'message', text: fields.message.value.trim() }
          : { type: 'task', template: { ...template, goal: fields.goal.value.trim(), planConfirm: selected.plan } };
        const body = { rule: readRule(), action };
        if (!schedule) body.spaceId = space.id;
        await api(path, { method: schedule ? 'PATCH' : 'POST', body });
      }
      saved();
    } catch (e) { toast(e.message, 'error'); }
    finally { form.inert = false; }
  }
  form.oninput = validate;
  form.onchange = validate;
  form.onclick = (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-cancel')) { close(); return; }
    if (button.hasAttribute('data-remove')) {
      if (confirm(tr('删除这个定时任务？'))) write(true);
      return;
    }
    if (button.dataset.segment) selected[button.dataset.segment] = button.value;
    if (button.hasAttribute('data-day')) {
      const day = Number(button.dataset.day);
      if (days.has(day)) days.delete(day); else days.add(day);
    }
    sync();
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    if (!$('button[type=submit]', form).disabled) write();
  };
  sync();
  return form;
}

let spaceView, settingsView;
function renderSpace(el, { space }) {
  spaceView?.dispose();
  el.innerHTML = `<div class="set-list schedule-card" hidden><div data-before></div><div data-editor></div><div data-after></div></div>
    <button type="button" class="btn sm schedule-add">${ICON.plus}${esc(tr('添加'))}</button>`;
  let schedules = [];
  let editingId = null;
  const card = $('.schedule-card', el);
  const editor = $('[data-editor]', el);
  const add = $('.schedule-add', el);
  function draw() {
    const index = schedules.findIndex((s) => s.id === editingId);
    const split = index < 0 ? schedules.length : index + 1;
    const row = (s) => scheduleRow(s, { expanded: s.id === editingId });
    $('[data-before]', card).innerHTML = schedules.slice(0, split).map(row).join('');
    $('[data-after]', card).innerHTML = schedules.slice(split).map(row).join('');
    card.hidden = !schedules.length && !editor.firstChild;
    // 正在新建时编辑器里已经有取消和保存，「添加」先藏起来
    add.hidden = !!editor.firstChild && editingId === null;
  }
  function close() {
    const previous = editingId;
    editingId = null;
    editor.replaceChildren();
    draw();
    const opener = $$('.schedule-open', card).find((b) => b.parentElement.dataset.schedule === previous);
    (opener || add).focus();
  }
  function open(schedule) {
    if (editor.firstChild?.inert) return;
    const id = schedule?.id || null;
    if (editor.firstChild && editingId === id) { close(); return; }
    editingId = id;
    editor.replaceChildren(createEditor(space, schedule, close, () => { close(); view.refresh(); }));
    draw();
    $('.seg-btn.on', editor).focus();
  }
  add.onclick = () => open();
  card.onclick = (event) => {
    const button = event.target.closest('.schedule-open');
    if (button) open(schedules.find((s) => s.id === button.parentElement.dataset.schedule));
  };
  const view = watchList(el, () => api(`${schedulesUrl}?spaceId=${encodeURIComponent(space.id)}`), (data) => {
    schedules = data;
    draw();
  });
  spaceView = view;
}

function runRow(run, schedule, spaces) {
  const results = {
    ok: tr('成功'), failed: tr('失败'), skipped: tr('上一次还没结束，跳过'),
    missed: tr('错过 {0} 次', [run.count]), disabled: run.reason === 'space_deleted' ? tr('所属空间已删除，已停用') : tr('已停用'),
  };
  const target = run.status === 'ok' && run.spaceId ? run.spaceId : schedule?.spaceId;
  const summary = schedule ? actionText(schedule.action) : tr('已删除的定时任务');
  return `<button type="button" class="schedule-run" data-space="${esc(target)}"${spaces.has(target) ? '' : ' disabled'}
    ${run.status === 'failed' ? `title="${esc(run.error)}"` : ''}>
    <i class="schedule-dot" data-status="${esc(run.status)}" aria-hidden="true"></i>
    <span class="schedule-time">${esc(dateTime(run.at, true))}</span><span class="schedule-clip">${esc(summary)}</span>
    <span class="schedule-result">${esc(results[run.status])}</span></button>`;
}

function renderSettings(el) {
  settingsView?.dispose();
  let byId = new Map();
  function draw([schedules, runs, spaces]) {
    state.spaces = spaces;
    const owners = new Map(spaces.map((s) => [s.id, s]));
    byId = new Map(schedules.map((s) => [s.id, s]));
    if (!schedules.length && !runs.length) { el.innerHTML = emptyHtml(tr('还没有定时任务')); return; }
    el.innerHTML = `${schedules.length ? `<section class="set-group"><div class="set-list schedule-card">
      ${schedules.map((s) => scheduleRow(s, { owner: owners.get(s.spaceId)?.title ?? tr('已删除的空间'), disabled: !owners.has(s.spaceId) })).join('')}
      </div></section>` : ''}
      ${runs.length ? `<section class="set-group"><h3 class="set-group-title">${esc(tr('运行记录'))}</h3>
        <div class="set-list schedule-card schedule-history">${runs.slice(0, 50).map((run) => runRow(run, byId.get(run.scheduleId), owners)).join('')}</div></section>` : ''}`;
  }
  el.onclick = (event) => {
    const button = event.target.closest('.schedule-open, .schedule-run');
    if (!button || button.disabled) return;
    const id = button.dataset.space || byId.get(button.parentElement.dataset.schedule)?.spaceId;
    if (state.spaces.some((s) => s.id === id)) location.hash = `#/space/${id}`;
  };
  settingsView = watchList(el, () => Promise.all([api(schedulesUrl), api(schedulesUrl + '/runs'), api('/api/spaces')]), draw, true);
}

register('spaceTabs', {
  id: 'schedules', label: tr('定时'), order: 40, render: renderSpace, dispose() { spaceView?.dispose(); },
});
register('settings', {
  id: 'schedules', label: tr('定时任务'), icon: clockIcon, order: 30, render: renderSettings, dispose() { settingsView?.dispose(); },
});
