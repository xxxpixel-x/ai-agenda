// 成员编辑器：新建空间 / 空间设置共用
import { closeStream, input, showWelcome } from './chat.js';
import { refreshEngines, showModal } from './engines.js';
import { bindImportOptions, importOptionsHtml, openSessionPicker, readImportOptions, safeName, samePath, wan } from './imports.js';
import { refreshSpaces, renderSpaceList } from './sidebar.js';
import { $, $$, ACCESS, ICON, api, engineOf, esc, shownEngines, state, toast, tr } from './util.js';

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
function memberEditor(container, members) {
  const render = () => {
    container.innerHTML = `<div class="member-rows">${members.map((m, i) => {
      const e = engineOf(m.engine) || {};
      const models = modelChoices(e);
      const st = e.status || {};
      return `<div class="member-row" data-i="${i}" style="--c:${e.color || '#999'}">
        <div class="member-top">
          <input data-k="name" value="${esc(m.name)}" maxlength="20" placeholder="${tr('名字')}">
          <select data-k="engine">${state.engines.filter((x) => shownEngines().includes(x) || x.id === m.engine).map((x) => `<option value="${esc(x.id)}" ${x.id === m.engine ? 'selected' : ''}>${esc(x.label)}${x.status?.ready ? '' : tr('（未就绪）')}</option>`).join('')}</select>
          <input data-k="model" value="${esc(m.model || '')}" list="models-${i}" placeholder="${esc(st.defaultModel ? tr('默认：{0}', [st.defaultModel]) : tr('默认模型'))}">
          <datalist id="models-${i}">${models.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</datalist>
          ${effortSelect(e, m)}
          <button class="icon-btn" type="button" data-act="del-member" title="${tr('移除')}" ${members.length <= 1 ? 'disabled' : ''}>${ICON.close}</button>
        </div>
        ${!st.ready ? `<div class="member-status warn">⚠ ${esc(st.note || tr('还不能用'))}</div>` : ''}
        <details ${m.persona ? 'open' : ''}><summary>${tr('设定')}</summary>
          <textarea data-k="persona" rows="2" placeholder="${tr('例如：你负责挑毛病；或者：你是这份论文的审稿人')}">${esc(m.persona || '')}</textarea></details>
      </div>`;
    }).join('')}</div>
    <button class="btn sm ghost" type="button" data-act="add-member" ${members.length >= 8 ? 'disabled' : ''}>${tr('＋ 添加成员')}</button>`;
  };
  container.addEventListener('input', (ev) => {
    const row = ev.target.closest('.member-row');
    const k = ev.target.dataset.k;
    if (!row || !k) return;
    const m = members[+row.dataset.i];
    m[k] = ev.target.value;
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
const accessChoices = (cur) => Object.entries(ACCESS).map(([k, v]) => `
  <label class="choice"><input type="radio" name="access" value="${k}" ${k === cur ? 'checked' : ''}>
    <span><b>${v.label}</b><div class="d">${v.desc}</div></span></label>`).join('');

export async function openNewSpaceModal() {
  await refreshEngines();
  const members = defaultMembers();
  let imp = null; // 从一段对话开始时选中的对话
  let autoFolder = ''; // 软件自动填的共享文件夹；你自己选过别的就不再跟着变
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
  const dlg = showModal(`<div class="modal-inner">
    <div class="modal-head"><h3>${tr('新建空间')}</h3><button class="btn sm ghost" type="button" data-act="from-chat">${tr('从对话开始')}</button><button class="icon-btn" type="button" data-act="close">${ICON.close}</button></div>
    <div class="modal-body">
      <div id="nsImport"></div>
      <div class="field"><label>${tr('名字')}</label><input id="nsTitle" maxlength="60" placeholder="${tr('例如：毕业论文第三章')}"></div>
      <div class="field"><div class="label">${tr('成员')}</div><div id="nsMembers"></div></div>
      <div class="field"><div class="label">${tr('共享文件夹')}</div>
        <div class="choices">
          <label class="choice"><input type="radio" name="ws" value="managed" checked><span><b>${tr('新建一个空文件夹')}</b><div class="d">${tr('适合写作和讨论')}</div></span></label>
          <label class="choice"><input type="radio" name="ws" value="folder"><span><b>${tr('用电脑上已有的文件夹')}</b><div class="d">${tr('AI 会直接读写里面的文件')}</div>
            <div class="folder-row"><input id="nsFolder" placeholder="${tr('点右边按钮选择')}" readonly><button class="btn sm" type="button" data-act="pick">${tr('选择…')}</button></div></span></label>
        </div></div>
      <div class="field"><div class="label">${tr('AI 的权限')}</div><div class="choices">${accessChoices('edit')}</div></div>
      <div class="field"><label>${tr('每次最多来回几次')}</label>
        <input id="nsTurns" type="number" min="1" max="30" value="6" style="width:100px"></div>
    </div>
    <div class="modal-foot"><button class="btn" type="button" data-act="close">${tr('取消')}</button><button class="btn primary" type="button" data-act="create">${tr('创建')}</button></div>
  </div>`);
  memberEditor($('#nsMembers', dlg), members);
  $('#nsTitle', dlg).focus();
  dlg.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'close') dlg.close();
    if (b.dataset.act === 'pick') {
      const p = await window.desktop.pickFolder();
      if (p) { $('#nsFolder', dlg).value = p; $('input[name=ws][value=folder]', dlg).checked = true; }
    }
    if (b.dataset.act === 'from-chat') {
      const s = await openSessionPicker();
      if (!s) return;
      try { imp = await api(`/api/import/session?source=${s.source}&id=${encodeURIComponent(s.id)}`); } catch (e) { toast(e.message, 'error'); return; }
      $('#nsTitle', dlg).value = imp.title;
      if (imp.cwd) { autoFolder = imp.cwd; $('#nsFolder', dlg).value = imp.cwd; $('input[name=ws][value=folder]', dlg).checked = true; }
      const e = engineOf(imp.engine);
      if (e && !members.some((m) => m.engine === imp.engine)) {
        members.unshift({ engine: imp.engine, name: uniqueName(members, e.defaultName), model: '', effort: '', persona: '' });
        const box = $('#nsMembers', dlg);
        const fresh = box.cloneNode(false); // 成员编辑器重新绑定
        box.replaceWith(fresh);
        memberEditor(fresh, members);
      }
      $('#nsImport', dlg).innerHTML = `<div class="field"><div class="imp-pick"><b>${esc(imp.title)}</b><span class="hint">${tr('{0} · {1} 条 · {2}', [esc(imp.sourceLabel), imp.count, wan(imp.chars)])}</span>
        <button class="icon-btn" type="button" data-act="drop-import" title="${tr('不导入')}">${ICON.close}</button></div>${importOptionsHtml(imp)}</div>`;
      bindImportOptions($('#nsImport', dlg), syncFolder);
    }
    if (b.dataset.act === 'drop-import') { imp = null; $('#nsImport', dlg).innerHTML = ''; }
    if (b.dataset.act === 'create') {
      const wsType = $('input[name=ws]:checked', dlg).value;
      const body = {
        title: $('#nsTitle', dlg).value,
        members,
        workspace: { type: wsType, path: $('#nsFolder', dlg).value },
        access: $('input[name=access]:checked', dlg).value,
        maxTurns: $('#nsTurns', dlg).value,
      };
      if (wsType === 'folder' && !body.workspace.path) { toast(tr('请先选择文件夹'), 'error'); return; }
      if (imp) {
        const { memberId, writerId, ...opts } = readImportOptions($('#nsImport', dlg), imp);
        const topic = opts.mode === 'topic';
        if (topic && !opts.topic) { toast(tr('请填写主题'), 'error'); $('#impTopic', dlg).focus(); return; }
        const has = members.some((m) => m.engine === imp.engine);
        if (engineOf(imp.engine) && !has && !topic) { toast(tr('导入这段对话需要一个 {0} 成员', [imp.sourceLabel]), 'error'); return; }
        const folder = wsType === 'folder' ? body.workspace.path : '';
        const moved = has && engineOf(imp.engine)?.continuesImports && imp.cwd && !samePath(folder, imp.cwd) && !(topic && folder && subOf(folder, imp.cwd));
        if (moved && !confirm(tr('共享文件夹和原对话的不同，原对话里的文件路径可能对不上。继续吗？'))) return;
        body.import = opts;
      }
      b.disabled = true;
      try {
        const sp = await api('/api/spaces', { method: 'POST', body });
        if (sp.importError) toast(tr('空间建好了，但对话没导入：{0}', [sp.importError]), 'error');
        dlg.close();
        await refreshSpaces();
        location.hash = `#/space/${sp.id}`;
      } catch (e) { toast(e.message, 'error'); b.disabled = false; }
    }
  });
  dlg.addEventListener('input', (ev) => { if (ev.target.id === 'nsFolder') $('input[name=ws][value=folder]', dlg).checked = true; });
}

export async function openSpaceSettings() {
  const sp = state.space;
  if (!sp) return;
  await refreshEngines();
  const members = sp.members.map((m) => ({ ...m }));
  const allowed = [...(sp.allowedPrograms || [])];
  const allowedHtml = () => allowed.map((p) => `<span class="allowed-chip"><code>${esc(p)}</code><button type="button" class="icon-btn" data-act="unallow" data-p="${esc(p)}" title="${tr('移除')}" aria-label="${tr('移除 {0}', [esc(p)])}">${ICON.close}</button></span>`).join('');
  const dlg = showModal(`<div class="modal-inner">
    <div class="modal-head"><h3>${tr('空间设置')}</h3><button class="icon-btn" type="button" data-act="close">${ICON.close}</button></div>
    <div class="modal-body">
      <div class="field"><label>${tr('名字')}</label><input id="ssTitle" maxlength="60" value="${esc(sp.title)}"></div>
      <div class="field"><div class="label">${tr('成员')}</div><div id="ssMembers"></div></div>
      <div class="field"><div class="label">${tr('AI 的权限')}</div><div class="choices">${accessChoices(sp.access)}</div></div>
      ${allowed.length ? `<div class="field"><div class="label">${tr('运行前不再问的程序')}</div><div class="allowed-list" id="ssAllowed">${allowedHtml()}</div></div>` : ''}
      <div class="field"><label>${tr('每次最多来回几次')}</label><input id="ssTurns" type="number" min="1" max="30" value="${sp.maxTurns}" style="width:100px"></div>
      <div class="field"><div class="label">${tr('共享文件夹')}</div><span class="cmd">${esc(sp.workspacePath)}</span></div>
    </div>
    <div class="modal-foot"><button class="btn danger" type="button" data-act="delete">${tr('删除这个空间')}</button><span class="grow"></span>
      <button class="btn" type="button" data-act="close">${tr('取消')}</button><button class="btn primary" type="button" data-act="save">${tr('保存')}</button></div>
  </div>`);
  memberEditor($('#ssMembers', dlg), members);
  dlg.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'close') dlg.close();
    if (b.dataset.act === 'unallow') {
      allowed.splice(allowed.indexOf(b.dataset.p), 1);
      $('#ssAllowed', dlg).innerHTML = allowedHtml() || `<span class="hint">${tr('（无）')}</span>`;
    }
    if (b.dataset.act === 'save') {
      b.disabled = true;
      try {
        await api(`/api/spaces/${sp.id}`, { method: 'PATCH', body: { title: $('#ssTitle', dlg).value, members, access: $('input[name=access]:checked', dlg).value, maxTurns: $('#ssTurns', dlg).value, allowedPrograms: allowed } });
        dlg.close();
        refreshSpaces();
      } catch (e) { toast(e.message, 'error'); b.disabled = false; }
    }
    if (b.dataset.act === 'delete') {
      openDeleteSpaceModal(sp);
    }
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

