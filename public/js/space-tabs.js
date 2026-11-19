import { register } from './slots.js';
import { accessChoices, memberEditor, readTaskOptions, taskOptionsHtml } from './space-form.js';
import { $, ICON, esc, tr } from './util.js';

const ended = (space) => space.kind === 'task' && !!space.run?.closed;

register('spaceTabs', {
  id: 'general', label: tr('常规'), order: 10,
  render(el, { space, onSave }) {
    const allowed = [...(space.allowedPrograms || [])];
    const chips = () => allowed.map((program) => `<span class="allowed-chip"><code>${esc(program)}</code>
      <button type="button" class="icon-btn" data-act="unallow" data-p="${esc(program)}"
        title="${tr('移除')}" aria-label="${esc(tr('移除 {0}', [program]))}">${ICON.close}</button></span>`).join('');
    const readOnlyTask = ended(space);
    el.innerHTML = `<div class="field"><label for="ssTitle">${tr('名字')}</label><input id="ssTitle" maxlength="60" value="${esc(space.title)}"></div>
      <div class="field"><div class="label">${tr('共享文件夹')}</div><span class="cmd">${esc(space.workspacePath)}</span></div>
      ${readOnlyTask ? `<p class="hint">${tr('这个任务已经结束，只能改名字。')}</p>` : `
      <div class="field"><div class="label">${tr('AI 的权限')}</div><div class="choices">${accessChoices(space.access)}</div></div>
      ${allowed.length ? `<div class="field"><div class="label">${tr('运行前不再问的程序')}</div><div class="allowed-list" id="ssAllowed">${chips()}</div></div>` : ''}
      ${space.kind === 'task' ? '' : `<div class="field"><label for="ssTurns">${tr('每次最多来回几次')}</label>
        <input id="ssTurns" type="number" min="1" max="30" value="${esc(space.maxTurns)}" class="w-num"></div>`}`}`;
    const list = $('#ssAllowed', el);
    list?.addEventListener('click', (ev) => {
      const button = ev.target.closest('[data-act=unallow]');
      if (!button) return;
      allowed.splice(allowed.indexOf(button.dataset.p), 1);
      list.innerHTML = chips() || `<span class="hint">${tr('（无）')}</span>`;
    });
    onSave((body) => {
      body.title = $('#ssTitle', el).value;
      if (readOnlyTask) return;
      body.access = $('input[name=access]:checked', el).value;
      body.allowedPrograms = allowed;
      if (space.kind !== 'task') body.maxTurns = $('#ssTurns', el).value;
    });
  },
});

register('spaceTabs', {
  id: 'members', label: tr('成员'), order: 20,
  when: ({ space }) => !ended(space),
  render(el, { space, members, onSave }) {
    const run = space.kind === 'task' && space.run;
    const busy = run && ['planning', 'plan_review', 'executing', 'summarizing'].includes(run.status);
    el.innerHTML = `<div class="field"><div class="label">${tr('成员')}</div>
      ${busy ? `<div class="hint">${tr('任务进行中，不能修改成员；换型号可以点顶部的成员标签')}</div>` : '<div id="ssMembers"></div>'}</div>
      ${run ? `<div class="field"><label for="ssCoord">${tr('协调者')}</label><select id="ssCoord" class="w-auto">
        ${space.members.map((m) => `<option value="${esc(m.id)}" ${m.id === run.coordinatorId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>` : ''}`;
    if (!busy) memberEditor($('#ssMembers', el), members);
    onSave((body) => {
      if (!busy) body.members = members;
      if (run) {
        body.task ??= {};
        body.task.coordinatorId = $('#ssCoord', el).value;
      }
    });
  },
});

register('spaceTabs', {
  id: 'task', label: tr('任务选项'), order: 30,
  when: ({ space }) => space.kind === 'task' && !!space.run && !space.run.closed,
  render(el, { space, onSave }) {
    el.innerHTML = taskOptionsHtml(space.run);
    onSave((body) => {
      body.task = { ...body.task, ...readTaskOptions(el) };
    });
  },
});
