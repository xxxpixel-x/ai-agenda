// 成员编辑器：新建空间 / 空间设置共用
import { closeStream, showWelcome } from './chat.js';
import { refreshEngines, showModal } from './engines.js';
import { bindImportOptions, importOptionsHtml, openSessionPicker, readImportOptions, safeName, samePath, wan } from './imports.js';
import { refreshSpaces, renderSpaceList } from './sidebar.js';
import { list } from './slots.js';
import { $, $$, ACCESS, ICON, api, engineOf, esc, load, shownEngines, state, store, toast, tr } from './util.js';

// ---------------- 成员编辑器（新建空间 / 空间设置共用） ----------------
// 型号候选：写死的常用型号 + 检测时查到的（字符串，或 [型号, 显示名]）
export function modelChoices(e) {
  const seen = new Map();
  for (const x of [...(e.models || []), ...(e.status?.models || [])]) {
    const [v, l] = Array.isArray(x) ? x : [x, ''];
    if (v && !seen.has(v)) seen.set(v, l && l !== v ? l : '');
  }
  return [...seen];
}
// 思考档位：查到了这个型号支持哪些就只列那些，否则列这个 AI 的全部档位
export function effortChoices(e, model) {
  const known = e.status?.efforts?.[model || e.status?.defaultModel || ''];
  return known ? ['', ...known] : e.efforts || [];
}
export function effortSelect(e, m) {
  const list = effortChoices(e, m.model);
  if (list.length <= 1) return '<span data-k="effort"></span>';
  return `<select data-k="effort" title="${tr('思考深度')}">${list.map((v) => `<option value="${esc(v)}" ${v === (m.effort || '') ? 'selected' : ''}>${tr('思考：{0}', [esc(v || tr('默认'))])}</option>`).join('')}</select>`;
}
export function memberEditor(container, members, onChange) {
  const render = () => {
    container.innerHTML = `<div class="member-rows">${members.map((m, i) => {
      const e = engineOf(m.engine) || {};
      const models = modelChoices(e);
      const st = e.status || {};
      return `<div class="member-row" data-i="${i}" style="--c:${esc(e.color || '#999')}">
        <div class="member-top">
          <input data-k="name" value="${esc(m.name)}" maxlength="20" placeholder="${tr('名字')}">
          <select data-k="engine">${state.engines.filter((x) => shownEngines().includes(x) || x.id === m.engine).map((x) => `<option value="${esc(x.id)}" ${x.id === m.engine ? 'selected' : ''}>${esc(x.label)}${x.status?.ready ? '' : tr('（未就绪）')}</option>`).join('')}</select>
          <input data-k="model" value="${esc(m.model || '')}" list="models-${i}" placeholder="${esc(st.defaultModel ? tr('默认：{0}', [st.defaultModel]) : tr('默认模型'))}">
          <datalist id="models-${i}">${models.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</datalist>
          ${effortSelect(e, m)}
          <button class="icon-btn" type="button" data-act="del-member" title="${tr('移除')}" ${members.length <= 1 ? 'disabled' : ''}>${ICON.close}</button>
        </div>
        ${!st.ready ? `<div class="member-status warn">${esc(st.note || tr('还不能用'))}</div>` : ''}
        <details ${m.persona ? 'open' : ''}><summary>${tr('设定')}</summary>
          <textarea data-k="persona" rows="2" placeholder="${tr('例如：你负责挑毛病；或者：你是这份论文的审稿人')}">${esc(m.persona || '')}</textarea></details>
      </div>`;
    }).join('')}</div>
    <button class="btn sm ghost" type="button" data-act="add-member" ${members.length >= 8 ? 'disabled' : ''}>${ICON.plus}${tr('添加成员')}</button>`;
    onChange?.();
  };
  container.addEventListener('input', (ev) => {
    const row = ev.target.closest('.member-row');
    const k = ev.target.dataset.k;
    if (!row || !k) return;
    const m = members[+row.dataset.i];
    m[k] = ev.target.value;
    if (k === 'name') onChange?.();
    if (k === 'engine') {
      const e = engineOf(m.engine);
      m.model = '';
      m.effort = '';
      if (e && (!m.name || state.engines.some((x) => x.defaultName === m.name))) m.name = uniqueName(members, e.defaultName, m);
      render();
    } else if (k === 'model') {
      // 换型号：档位跟着换，原来的档位新型号不支持就回到默认（只换这一个下拉，输入框不丢焦点）
      const e = engineOf(m.engine) || {};
      if (!effortChoices(e, m.model).includes(m.effort || '')) m.effort = '';
      row.querySelector('[data-k="effort"]').outerHTML = effortSelect(e, m);
    }
  });
  container.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'del-member') { members.splice(+b.closest('.member-row').dataset.i, 1); render(); }
    if (b.dataset.act === 'add-member') {
      const used = new Set(members.map((m) => m.engine));
      const list = shownEngines();
      const e = list.find((x) => x.status?.ready && !used.has(x.id)) || list.find((x) => x.status?.ready) || list[0];
      members.push({ engine: e.id, name: uniqueName(members, e.defaultName), model: '', effort: '', persona: '' });
      render();
    }
  });
  render();
}
function uniqueName(members, base, self) {
  let name = base;
  for (let k = 2; members.some((m) => m !== self && m.name === name); k++) name = `${base}${k}`;
  return name;
}
function defaultMembers() {
  // 按注册顺序取能用的；同名的只带一个（Gemini CLI 能用就用它，否则用 Gemini API）
  const builtin = (e) => !e.id.startsWith('openai:');
  let list = state.engines.filter((e) => e.status?.ready);
  if (!list.length) list = shownEngines().filter((e) => builtin(e) && !e.hideWhenMissing);
  const seen = new Set();
  list = list.filter((e) => !builtin(e) || (!seen.has(e.defaultName) && seen.add(e.defaultName)));
  return list.slice(0, 4).map((e) => ({ engine: e.id, name: e.defaultName, model: '', effort: '', persona: '' }));
}
export const accessChoices = (cur) => Object.entries(ACCESS).map(([k, v]) => `
  <label class="choice"><input type="radio" name="access" value="${k}" ${k === cur ? 'checked' : ''}>
    <span><b>${v.label}</b><div class="d">${v.desc}</div></span></label>`).join('');

// 任务空间的执行选项：新建和任务空间设置共用
const PLAN_CONFIRM = {
  manual: { label: tr('等我确认'), desc: tr('协调者定好计划（包括中途改过的计划）后，等你点确认再开始') },
  auto: { label: tr('自动开始执行'), desc: tr('计划定好直接开始，照样显示在计划条里，随时可以停') },
};
export function taskOptionsHtml(o = {}) {
  const pc = o.planConfirm || 'manual';
  return `<div class="field"><div class="label">${tr('计划确认方式')}</div><div class="choices row">${Object.entries(PLAN_CONFIRM).map(([k, v]) => `
      <label class="choice"><input type="radio" name="planConfirm" value="${k}" ${k === pc ? 'checked' : ''}><span><b>${v.label}</b><div class="d">${v.desc}</div></span></label>`).join('')}</div></div>
    <div class="field opts-list">
      <label class="check-row"><input type="checkbox" data-opt="discuss" ${o.discuss !== false ? 'checked' : ''}> ${tr('其他成员先审阅计划')}</label>
      <label class="check-row"><input type="checkbox" data-opt="autoApprove" ${o.autoApprove ? 'checked' : ''}> ${tr('子任务做完自动通过')}</label>
      <label class="check-row">${tr('Git 项目最多同时做')} <input type="number" data-opt="maxParallel" min="1" max="6" value="${esc(o.maxParallel || 3)}"> ${tr('个子任务')}</label>
    </div>`;
}
export function readTaskOptions(root) {
  return {
    planConfirm: $('input[name=planConfirm]:checked', root)?.value || 'manual',
    discuss: $('[data-opt=discuss]', root).checked,
    autoApprove: $('[data-opt=autoApprove]', root).checked,
    maxParallel: $('[data-opt=maxParallel]', root).value,
  };
}
const copyMembers = (list) => list.map((m) => ({ engine: m.engine, name: m.name, model: m.model || '', effort: m.effort || '', persona: m.persona || '' }));

/**
 * 新建空间。opts：
 *  kind          'chat' | 'task'，lockKind 为 true 时不能切换
 *  objective     任务目标（直接带过去的消息 / 再开一个类似的任务时为空）
 *  distill       { ids, memberId }：打开后让这个成员把选中的讨论整理成目标
 *  from          从哪个聊天空间转来 { id, title, workspacePath }：默认用同一个文件夹
 *  source        { spaceId, messages }：记在任务空间上，结束时可以把总结发回去
 *  members / coordinatorName / task / access / folder：照搬的成员和设置
 */
export async function openNewSpaceModal(opts = {}) {
  await refreshEngines();
  const members = opts.members?.length ? copyMembers(opts.members) : defaultMembers();
  let kind = opts.kind === 'task' ? 'task' : 'chat';
  let imp = null; // 从一段对话开始时选中的对话
  let autoFolder = ''; // 软件自动填的共享文件夹；你自己选过别的就不再跟着变
  let coordIndex = Math.max(0, members.findIndex((m) => m.name === opts.coordinatorName));
  const subOf = (dir, parent) => samePath(dir.replace(/[\\/]+[^\\/]+[\\/]*$/, ''), parent);
  const syncFolder = () => {
    const f = $('#nsFolder', dlg);
    if (!imp?.cwd || (f.value && f.value !== autoFolder)) return;
    const box = $('#nsImport', dlg);
    const topic = $('input[name=impMode]:checked', box)?.value === 'topic' ? safeName($('#impTopic', box).value) : '';
    autoFolder = topic ? `${imp.cwd.replace(/[\\/]+$/, '')}\\${topic}` : imp.cwd;
    f.value = autoFolder;
    $('input[name=ws][value=folder]', dlg).checked = true;
  };
  const sharedChoice = opts.from ? `<label class="choice"><input type="radio" name="ws" value="shared" checked><span><b>${tr('和「{0}」用同一个文件夹', [esc(opts.from.title)])}</b><div class="d">${tr('Git 项目在独立副本里做，审查通过才合并；不是 Git 项目时，执行期间那个聊天空间的文件暂时只读')}</div></span></label>` : '';
  const dlg = showModal(`<div class="modal-inner">
    <div class="modal-head"><h3 id="nsHead">${tr('新建空间')}</h3><button class="btn sm ghost" type="button" data-act="from-chat" id="nsFromChat">${tr('从对话开始')}</button><button class="icon-btn" type="button" data-act="close">${ICON.close}</button></div>
    <div class="modal-body">
      <div class="kind-switch" role="radiogroup" aria-label="${tr('空间类型')}" ${opts.lockKind ? 'hidden' : ''}>
        <label class="kind-opt"><input type="radio" name="kind" value="chat" ${kind === 'chat' ? 'checked' : ''}><span class="ko-icon">${ICON.chat}</span><span><b>${tr('聊天空间')}</b><span class="d">${tr('自由讨论，输入框发给所有成员')}</span></span></label>
        <label class="kind-opt"><input type="radio" name="kind" value="task" ${kind === 'task' ? 'checked' : ''}><span class="ko-icon">${ICON.task}</span><span><b>${tr('任务空间')}</b><span class="d">${tr('完成一个目标，输入框只发给协调者')}</span></span></label>
      </div>
      <div id="nsImport"></div>
      <div class="field" data-for="task"><label for="nsGoal">${tr('目标')}</label>
        <textarea id="nsGoal" rows="6" placeholder="${tr('要完成什么？例如：给这个项目加上导出 PDF 的功能')}">${esc(opts.objective || '')}</textarea>
        <div class="hint" id="nsGoalHint">${opts.source ? esc(tr('从聊天空间「{0}」选了 {1} 条消息', [opts.from?.title || '', opts.source.messages])) : ''}</div></div>
      <div class="field"><label for="nsTitle">${tr('名字')}</label><input id="nsTitle" maxlength="60"></div>
      <div class="field"><div class="label">${tr('成员')}</div><div id="nsMembers"></div></div>
      <div class="field" data-for="task"><label for="nsCoord">${tr('协调者')}</label><select id="nsCoord" class="w-auto"></select>
        <div class="hint">${tr('拆分计划、分配子任务、处理你中途发来的消息、写总结')}</div></div>
      <div class="field"><div class="label">${tr('共享文件夹')}</div>
        <div class="choices">${sharedChoice}
          <label class="choice"><input type="radio" name="ws" value="managed" ${sharedChoice || opts.folder ? '' : 'checked'}><span><b>${tr('新建一个空文件夹')}</b><div class="d">${tr('适合写作和讨论')}</div></span></label>
          <label class="choice"><input type="radio" name="ws" value="folder" ${!sharedChoice && opts.folder ? 'checked' : ''}><span><b>${tr('用电脑上已有的文件夹')}</b><div class="d">${tr('AI 会直接读写里面的文件')}</div>
            <div class="folder-row"><input id="nsFolder" placeholder="${tr('点右边按钮选择')}" readonly value="${esc(opts.folder || '')}"><button class="btn sm" type="button" data-act="pick">${tr('选择…')}</button></div></span></label>
        </div></div>
      <div class="field"><div class="label">${tr('AI 的权限')}</div><div class="choices">${accessChoices(opts.access || (ACCESS[load('lastAccess')] ? load('lastAccess') : 'edit'))}</div></div>
      <details class="more-opts">
        <summary>${tr('更多选项')}</summary>
        <div data-for="task">${taskOptionsHtml(opts.task)}</div>
        <div class="field" data-for="chat"><label for="nsTurns">${tr('每次最多来回几次')}</label>
          <input id="nsTurns" type="number" min="1" max="30" value="6" class="w-num"></div>
      </details>
    </div>
    <div class="modal-foot"><button class="btn" type="button" data-act="close">${tr('取消')}</button><button class="btn primary" type="button" data-act="create" id="nsCreate">${tr('创建')}</button></div>
  </div>`);
  const moreOptions = $('.more-opts', dlg);
  const fieldError = (selector, message) => {
    const field = $(selector, dlg);
    if (moreOptions.contains(field)) moreOptions.open = true;
    field.focus();
    toast(message, 'error');
  };
  const renderCoord = () => {
    coordIndex = Math.min(coordIndex, members.length - 1);
    $('#nsCoord', dlg).innerHTML = members.map((m, i) => `<option value="${i}" ${i === coordIndex ? 'selected' : ''}>${esc(m.name || tr('成员 {0}', [i + 1]))}</option>`).join('');
  };
  const applyKind = () => {
    for (const el of $$('[data-for]', dlg)) el.hidden = el.dataset.for !== kind;
    $('#nsHead', dlg).textContent = opts.lockKind ? tr('转到新的任务空间') : tr('新建空间');
    $('#nsFromChat', dlg).hidden = kind !== 'chat';
    $('#nsCreate', dlg).textContent = kind === 'task' ? tr('创建并开始规划') : tr('创建');
    $('#nsTitle', dlg).placeholder = kind === 'task' ? tr('留空就用目标的第一句') : tr('例如：毕业论文第三章');
    if (kind === 'task' && imp) { imp = null; $('#nsImport', dlg).innerHTML = ''; }
  };
  memberEditor($('#nsMembers', dlg), members, renderCoord);
  renderCoord();
  applyKind();
  ($(kind === 'task' ? '#nsGoal' : '#nsTitle', dlg)).focus();
  if (opts.distill) {
    // 让一个成员整理：先占住目标框，整理好了填进去，你再改
    const goal = $('#nsGoal', dlg);
    const who = opts.members?.find((m) => m.id === opts.distill.memberId)?.name || '';
    goal.disabled = true;
    goal.placeholder = tr('{0} 正在把选中的讨论整理成方案…', [who]);
    api(`/api/spaces/${opts.from.id}/distill`, { method: 'POST', body: opts.distill }).then((r) => {
      goal.value = r.text;
      $('#nsGoalHint', dlg).textContent = tr('{0} 从「{1}」选中的 {2} 条消息整理的，看过、改过再创建', [r.by, opts.from.title, opts.source.messages]);
    }).catch((e) => {
      toast(tr('没整理成：{0}', [e.message]), 'error');
      goal.placeholder = tr('没整理成，可以自己写目标');
    }).finally(() => { goal.disabled = false; goal.focus(); });
  }
  dlg.addEventListener('change', (ev) => {
    if (ev.target.name === 'kind') { kind = ev.target.value; applyKind(); }
    if (ev.target.id === 'nsCoord') coordIndex = +ev.target.value;
  });
  dlg.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'close') dlg.close();
    if (b.dataset.act === 'pick') {
      const p = await window.desktop?.pickFolder?.();
      if (p) { $('#nsFolder', dlg).value = p; $('input[name=ws][value=folder]', dlg).checked = true; }
    }
    if (b.dataset.act === 'from-chat') {
      const s = await openSessionPicker();
      if (!s) return;
      try { imp = await api(`/api/import/session?source=${s.source}&id=${encodeURIComponent(s.id)}`); } catch (e) { toast(e.message, 'error'); return; }
      $('#nsTitle', dlg).value = imp.title;
      if (imp.cwd) {
        autoFolder = imp.cwd;
        $('#nsFolder', dlg).value = imp.cwd;
        $('input[name=ws][value=folder]', dlg).checked = true;
      }
      const e = engineOf(imp.engine);
      if (e && !members.some((m) => m.engine === imp.engine)) {
        members.unshift({ engine: imp.engine, name: uniqueName(members, e.defaultName), model: '', effort: '', persona: '' });
        const box = $('#nsMembers', dlg);
        const fresh = box.cloneNode(false); // 成员编辑器重新绑定
        box.replaceWith(fresh);
        memberEditor(fresh, members, renderCoord);
        renderCoord();
      }
      $('#nsImport', dlg).innerHTML = `<div class="field"><div class="imp-pick"><b>${esc(imp.title)}</b><span class="hint">${esc(tr('{0} · {1} 条 · {2}', [imp.sourceLabel, imp.count, wan(imp.chars)]))}</span>
        <button class="icon-btn" type="button" data-act="drop-import" title="${tr('不导入')}">${ICON.close}</button></div>${importOptionsHtml(imp)}</div>`;
      bindImportOptions($('#nsImport', dlg), syncFolder);
    }
    if (b.dataset.act === 'drop-import') { imp = null; $('#nsImport', dlg).innerHTML = ''; }
    if (b.dataset.act === 'create') {
      const wsType = $('input[name=ws]:checked', dlg).value;
      const workspace = wsType === 'shared' ? { type: 'folder', path: opts.from.workspacePath } : { type: wsType, path: $('#nsFolder', dlg).value };
      const body = {
        kind,
        title: $('#nsTitle', dlg).value,
        members,
        workspace,
        access: $('input[name=access]:checked', dlg).value,
      };
      if (wsType === 'folder' && !workspace.path) return fieldError('[data-act=pick]', tr('请先选择文件夹'));
      if (kind === 'task') {
        body.objective = $('#nsGoal', dlg).value;
        if (!body.objective.trim()) return fieldError('#nsGoal', tr('先写下目标'));
        body.coordinatorIndex = coordIndex;
        Object.assign(body, readTaskOptions(dlg));
        if (opts.source) body.source = opts.source;
      } else {
        body.maxTurns = $('#nsTurns', dlg).value;
      }
      if (imp && kind === 'chat') {
        const { memberId, writerId, ...io } = readImportOptions($('#nsImport', dlg), imp);
        const topic = io.mode === 'topic';
        if (topic && !io.topic) return fieldError('#impTopic', tr('请填写主题'));
        const has = members.some((m) => m.engine === imp.engine);
        if (engineOf(imp.engine) && !has && !topic) { toast(tr('导入这段对话需要一个 {0} 成员', [imp.sourceLabel]), 'error'); return; }
        const folder = wsType === 'folder' ? workspace.path : '';
        const moved = has && engineOf(imp.engine)?.continuesImports && imp.cwd && !samePath(folder, imp.cwd) && !(topic && folder && subOf(folder, imp.cwd));
        if (moved && !confirm(tr('共享文件夹和原对话的不同，原对话里的文件路径可能对不上。继续吗？'))) return;
        body.import = io;
      }
      b.disabled = true;
      try {
        const sp = await api('/api/spaces', { method: 'POST', body });
        store('lastAccess', body.access); // 下次新建默认用这一档
        if (sp.importError) toast(tr('空间建好了，但对话没导入：{0}', [sp.importError]), 'error');
        dlg.close();
        await refreshSpaces();
        location.hash = `#/space/${sp.id}`;
      } catch (e) { toast(e.message, 'error'); b.disabled = false; }
    }
  });
  dlg.addEventListener('input', (ev) => { if (ev.target.id === 'nsFolder') $('input[name=ws][value=folder]', dlg).checked = true; });
}

/** 结束了的任务空间：再开一个类似的任务。成员和设置照搬，目标重新写。 */
export function openSimilarTask(sp) {
  const r = sp.run || {};
  openNewSpaceModal({
    kind: 'task',
    lockKind: true,
    members: sp.members,
    coordinatorName: sp.members.find((m) => m.id === r.coordinatorId)?.name,
    task: { planConfirm: r.planConfirm, discuss: r.discuss, autoApprove: r.autoApprove, maxParallel: r.maxParallel },
    access: sp.access,
    folder: sp.workspace.type === 'folder' ? sp.workspacePath : '',
    from: sp.source ? { id: sp.source.spaceId, title: sp.source.title, workspacePath: sp.workspacePath } : null,
    source: sp.source ? { spaceId: sp.source.spaceId, messages: 0 } : null,
  });
}

export async function openSpaceSettings() {
  const sp = state.space;
  if (!sp) return;
  await refreshEngines();
  const collectors = [];
  const ctx = {
    space: sp,
    members: sp.members.map((m) => ({ ...m })),
    onSave(fn) { collectors.push(fn); },
  };
  const tabs = list('spaceTabs', ctx);
  if (!tabs.length) return;
  const remembered = load('rt:spaceTab');
  const active = tabs.find((tab) => tab.id === remembered) || tabs[0];
  const title = sp.kind === 'task' ? tr('任务空间设置') : tr('空间设置');
  const dlg = showModal(`<div class="modal-inner">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" type="button" data-act="close">${ICON.close}</button></div>
    ${tabs.length > 1 ? `<div class="modal-tabs" role="tablist" aria-label="${esc(title)}">
      ${tabs.map((tab, i) => `<button class="tab${tab === active ? ' active' : ''}" type="button" role="tab" data-stab="${esc(tab.id)}"
        aria-controls="ssPanel-${i}" aria-selected="${tab === active}" tabindex="${tab === active ? 0 : -1}">${esc(tab.label)}</button>`).join('')}
    </div>` : ''}
    <div class="modal-body">
      ${tabs.map((tab, i) => `<div class="tab-panel" data-stab-panel="${esc(tab.id)}" role="tabpanel" id="ssPanel-${i}"
        aria-label="${esc(tab.label)}" ${tab === active ? '' : 'hidden'}></div>`).join('')}
    </div>
    <div class="modal-foot"><button class="btn danger" type="button" data-act="delete">${tr('删除这个空间')}</button><span class="grow"></span>
      <button class="btn" type="button" data-act="close">${tr('取消')}</button><button class="btn primary" type="button" data-act="save">${tr('保存')}</button></div>
  </div>`);
  const panels = $$('[data-stab-panel]', dlg);
  const buttons = $$('[data-stab]', dlg);
  dlg.addEventListener('close', () => {
    for (const tab of tabs) {
      try { tab.dispose?.(); } catch (e) { console.error(e); }
    }
  }, { once: true });
  tabs.forEach((tab, i) => tab.render(panels[i], ctx));

  const select = (index) => {
    buttons.forEach((button, i) => {
      const selected = i === index;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      panels[i].hidden = !selected;
    });
    store('rt:spaceTab', tabs[index].id);
  };
  buttons.forEach((button, i) => {
    button.addEventListener('click', () => select(i));
    button.addEventListener('keydown', (ev) => {
      const last = buttons.length - 1;
      const next = { ArrowLeft: i ? i - 1 : last, ArrowRight: i === last ? 0 : i + 1, Home: 0, End: last }[ev.key];
      if (next === undefined) return;
      ev.preventDefault();
      select(next);
      buttons[next].focus();
    });
  });

  for (const button of $$('.modal-head [data-act=close], .modal-foot [data-act=close]', dlg)) {
    button.addEventListener('click', () => dlg.close());
  }
  $('.modal-foot [data-act=delete]', dlg).addEventListener('click', () => openDeleteSpaceModal(sp));
  const save = $('.modal-foot [data-act=save]', dlg);
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const body = {};
      for (const collect of collectors) collect(body);
      await api(`/api/spaces/${sp.id}`, { method: 'PATCH', body });
      dlg.close();
      refreshSpaces();
    } catch (e) { toast(e.message, 'error'); save.disabled = false; }
  });
}

export function openDeleteSpaceModal(sp) {
  const managed = sp.workspace.type === 'managed';
  const dlg = showModal(`<div class="modal-inner">
    <div class="modal-head"><h3>${tr('删除「{0}」？', [esc(sp.title)])}</h3></div>
    <div class="modal-body">
      <p>${tr('聊天记录、导入的对话和任务记录都会删除，无法恢复。正在进行的讨论和任务会先停止。')}</p>
      <p>${managed ? tr('软件建的共享文件夹及里面的文件也会一起删除。') : tr('你的共享文件夹及里面的文件会保留。')}</p>
      <span class="cmd">${esc(sp.workspacePath)}</span>
      <p class="err" data-delete-error role="alert" hidden></p>
    </div>
    <div class="modal-foot"><span class="grow"></span><button class="btn" type="button" data-act="close" autofocus>${tr('取消')}</button>
      <button class="btn danger" type="button" data-act="confirm-delete">${tr('确认删除')}</button></div>
  </div>`);
  let deleting = false;
  dlg.addEventListener('cancel', (e) => { if (deleting) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  dlg.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || deleting) return;
    if (b.dataset.act === 'close') { dlg.close(); return; }
    if (b.dataset.act !== 'confirm-delete') return;
    deleting = true;
    $$('button', dlg).forEach((button) => { button.disabled = true; });
    b.textContent = tr('正在删除…');
    $('[data-delete-error]', dlg).hidden = true;
    try {
      await api(`/api/spaces/${sp.id}`, { method: 'DELETE', body: {} });
      if (state.space?.id === sp.id) {
        closeStream();
        state.files.view = null;
        location.hash = '#/';
        showWelcome();
      }
      state.spaces = state.spaces.filter((s) => s.id !== sp.id);
      renderSpaceList();
      dlg.close();
      toast(tr('空间已删除'));
      await refreshSpaces();
    } catch (err) {
      const error = $('[data-delete-error]', dlg);
      error.textContent = err.message;
      error.hidden = false;
      deleting = false;
      $$('button', dlg).forEach((button) => { button.disabled = false; });
      b.textContent = tr('重试删除');
    }
  });
}

