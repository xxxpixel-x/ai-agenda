import { $, ICON, esc, tr } from '../util.js';
import { openNewSpaceModal } from '../space-form.js';
import { actions, button, chip, choice, exportLink, field, formDialog, importMarkdown, input, lib, libraryPage, options, value } from './shared.js';

async function teamEditor(team = {}) {
  const roles = await lib('roles');
  const members = (team.members || []).map(m => m.reference ? { roleId: m.roleId } : m);
  let coord = team.coordinatorIndex || 0;
  return formDialog(team.name || tr('新建团队'), field(tr('名字'),input('name',team.name,'required'))
    + field(tr('简介'),input('summary',team.summary)) + '<div data-members></div>'
    + field(tr('添加角色卡'), '<select name="add">' + options([['',tr('选择角色卡')],...roles.map(r => [r.id,r.name])]) + '</select>'),
  f => lib('teams' + (team.id ? '/' + team.id : ''),team.id ? 'PATCH' : 'POST',{ name: value(f,'name'), summary: value(f,'summary'), members, coordinatorIndex: coord }), {
    init(f) {
      const render = () => {
        $('[data-members]',f).innerHTML = members.map((m,i) => `<div class="lib-row"><div>${esc(m.name || roles.find(r => r.id === m.roleId)?.name)}</div>
          <label><input type="radio" name="coord" value="${i}" ${i === coord ? 'checked' : ''}> ${tr('协调者')}</label>${button('remove',tr('移除'),i)}</div>`).join('');
        f.elements.add.disabled = members.length >= 8;
      };
      f.elements.add.onchange = e => { if (e.target.value) members.push({ roleId: e.target.value }); e.target.value = ''; render(); };
      f.onchange = e => { if (e.target.name === 'coord') coord = +e.target.value; };
      actions(f,(_,id) => { members.splice(+id,1); if (+id < coord) coord--; coord = Math.max(0,Math.min(coord,members.length - 1)); render(); });
      render();
    },
  });
}
libraryPage('teams',tr('团队'),ICON.task,20,async (el,refresh) => {
  const teams = await lib('teams');
  el.innerHTML = '<div class="lib-toolbar">' + button('new',tr('新建团队'),'','primary') + button('import',tr('导入 Markdown')) + '</div><div class="lib-list">'
    + teams.map(t => `<article class="lib-card"><h3>${esc(t.name)}</h3><div class="lib-tags">${t.members.map((m,i) => chip(m.name + (i === t.coordinatorIndex ? ' · ' + tr('协调者') : ''),i === t.coordinatorIndex ? 'selected' : '')).join('')}</div>
      <div class="lib-actions">${button('use',tr('用此团队新建空间'),t.id)}${button('edit',tr('编辑'),t.id)}${exportLink('teams',t.id)}${t.customized ? button('reset',tr('恢复默认'),t.id) : !t.builtin ? button('delete',tr('删除'),t.id) : ''}</div></article>`).join('') + '</div>';
  actions(el,async (act,id) => {
    if (act === 'use') return openNewSpaceModal({ teamId: id });
    if (act === 'import') await importMarkdown();
    if (act === 'new' || act === 'edit') await teamEditor(teams.find(t => t.id === id));
    if (act === 'reset' || act === 'delete') {
      if (!await choice(teams.find(t => t.id === id).name,'',[[act,act === 'reset' ? tr('恢复默认') : tr('确认删除')]])) return;
      await lib('teams/' + id + (act === 'reset' ? '/reset' : ''), act === 'reset' ? 'POST' : 'DELETE',{});
    }
    await refresh();
  });
});
