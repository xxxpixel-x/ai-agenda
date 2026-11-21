import { $, $$, esc, tr } from '../util.js';
import { checks, choice, field, formDialog, input, installItem, lib, options, value } from './shared.js';

export function mountControls(root, members, tools) {
  for (const row of $$('[data-mounts]',root)) {
    const member = members[+row.closest('.member-row').dataset.i];
    row.innerHTML = ['skills','mcp'].map(k => {
      const selected = member[k] || [];
      const items = (tools[k] || []).filter(x => x.enabled || selected.includes(x.id));
      items.push(...selected.filter(id => !items.some(x => x.id === id)).map(id => ({id,name:id})));
      return items.length ? '<div class="lib-mounts"><b>' + (k === 'skills' ? 'Skills' : 'MCP') + '</b>' + checks(k,items,selected) + '</div>' : '';
    }).join('');
  }
}

async function prepare(rows) {
  let tools = await lib('extensions');
  const catalog = await lib('marketplace');
  const refs = k => new Set(rows.flatMap(row => row[k] || []));
  const missing = ['skills','mcp'].flatMap(k => [...refs(k)].filter(id => !tools[k].some(x => x.id === id))
    .map(id => ({ k,id,item:catalog[k].find(x => x.id === id) })));
  if (missing.length) {
    const available = missing.filter(x => x.item);
    const action = await choice(tr('这张卡推荐的 {0} 个工具还没装',[missing.length]),
      '<ul>' + missing.map(x => '<li>' + esc(x.item?.name || x.id) + '</li>').join('') + '</ul>',
      [...(available.length ? [['install',tr('一键安装')]] : []), ['skip',tr('跳过')]]);
    if (!action) return null;
    if (action === 'install') {
      for (const {k,item} of available) if (!await installItem(k,item)) return null;
      tools = await lib('extensions');
    }
  }
  return Object.fromEntries(['skills','mcp'].map(k => [k,tools[k].filter(x => x.enabled).map(x => x.id)]));
}
export async function chooseMembers(team, existingNames = [], initialId) {
  const group = team ? 'teams' : 'roles', list = await lib(group);
  const id = initialId || await choice(team ? tr('选择团队') : tr('从角色卡添加'),'',list.map(x => [x.id,x.name]));
  if (!id) return null;
  const selected = list.find(x => x.id === id);
  const rows = team ? selected.members : [{ reference:true,roleId:id,skills:selected.recommendedSkills.map(x => x.id),mcp:selected.recommendedMcp.map(x => x.id) }];
  const installed = await prepare(rows);
  if (!installed) return null;
  const members = [];
  for (const row of rows) {
    const names = [...existingNames,...members.map(m => m.name)];
    let m;
    if (row.reference) m = await lib('roles/' + row.roleId + '/resolve','POST',{existingNames:names,installedSkillIds:installed.skills,installedMcpIds:installed.mcp});
    else {
      m = structuredClone(row);
      for (const k of ['skills','mcp']) m[k] = (m[k] || []).filter(id => installed[k].includes(id));
      const base = m.name.replace(/[@\s]/g,'').slice(0,20);
      m.name = base;
      for (let n = 2; names.includes(m.name); n++) m.name = base.slice(0,20 - String(n).length) + n;
    }
    members.push({ ...m, id:crypto.randomUUID() });
  }
  return { members, coordinatorIndex: selected.coordinatorIndex || 0 };
}
export function saveTeam(members, coordinatorIndex = 0) {
  return formDialog(tr('存为团队'), field(tr('名字'),input('name','','required maxlength="100"'))
    + field(tr('协调者'), '<select name="coord">' + options(members.map((m,i) => [i,m.name]),Math.max(0,coordinatorIndex)) + '</select>'),
  f => lib('teams','POST',{name:value(f,'name'),members,coordinatorIndex:+value(f,'coord')}));
}

export async function permissions(body, originalMembers = []) {
  const members = body.members || originalMembers;
  const result = await lib('check-permissions','POST',{access:body.access,members});
  if (!result.hasConflict) return true;
  const explain = '<ul>' + result.conflicts.map(c => '<li>' + esc(c.memberName + ' · ' + c.mcpName) + '</li>').join('') + '</ul>';
  const picked = await choice(tr('这些 MCP 需要「可运行命令」'),explain,[
    ['run',tr('提高权限到「可运行命令」（对全体成员生效）')], ['remove',tr('暂不挂这些 MCP')],
  ]);
  if (!picked) return false;
  if (picked === 'run') body.access = 'run';
  else body.members = members.map((m,i) => {
    const drop = result.conflicts.filter(c => c.memberIndex === i).map(c => c.mcpId);
    return drop.length ? { ...m,mcp:m.mcp.filter(id => !drop.includes(id)) } : m;
  });
  return true;
}

