import { $, ICON, esc, tr } from '../util.js';
import { actions, button, chip, choice, field, formDialog, githubDialog, input, lib, libraryPage, modeChip, options, report, value } from './shared.js';

function mcpEditor(server = {}) {
  const existing = !!server.id;
  const select = (name, rows, current) => `<select name="${name}">${options(rows,current)}</select>`;
  const vars = ['env','headers'].flatMap(group => Object.entries(server[group] || {}).map(([key,v]) => ({ group, key, v })));
  return formDialog(existing ? server.name : tr('添加 MCP'), (existing ? '' : field(tr('标识'),input('id','','required placeholder="my-server"')))
    + field(tr('名字'),input('name',server.name,'required'))
    + field(tr('权限'),select('mode',[['mutating',tr('会改东西')],['readonly',tr('只读')]],server.mode))
    + field(tr('传输方式'),select('transport',[['stdio','stdio'],['http','HTTP']],server.transport))
    + '<div data-stdio>' + field(tr('命令'),input('command',server.command)) + field(tr('参数（每行一个）'),
      `<textarea name="args" rows="3">${esc(server.args?.join('\n'))}</textarea>`) + '</div><div data-http>' + field('URL',input('url',server.url)) + '</div>'
    + vars.map(({group,key,v},i) => field(group + ' · ' + key, input('var' + i,typeof v === 'string' ? v : '',
      `type="${typeof v === 'string' ? 'text' : 'password'}" placeholder="${esc(v?.keyHint || '')}" autocomplete="off"`))
      + `<label><input type="checkbox" name="clear${i}"> ${esc(tr('清除 {0}',[key]))}</label>`).join('')
    + '<fieldset><legend>' + tr('添加密钥') + '</legend><div data-keys></div>' + button('key',tr('添加一行')) + '</fieldset>',
  f => {
    const env = {}, headers = {}, secretKeys = new Set(server.secretKeys || []);
    for (const [i,{group,key}] of vars.entries()) {
      const v = value(f,'var' + i);
      if (v || f.elements['clear' + i].checked) (group === 'env' ? env : headers)[key] = f.elements['clear' + i].checked ? '' : v;
    }
    for (const row of f.querySelectorAll('[data-key-row]')) {
      const key = $('input',row).value.trim(); if (!key) continue;
      ($('select',row).value === 'env' ? env : headers)[key] = $('[type=password]',row).value;
      secretKeys.add(key);
    }
    const body = { name: value(f,'name'), transport: value(f,'transport'), mode: value(f,'mode'), env, headers, secretKeys: [...secretKeys],
      ...(value(f,'transport') === 'http' ? { url: value(f,'url') } : { command: value(f,'command'), args: value(f,'args').split('\n').filter(Boolean) }) };
    return existing ? lib('mcp/' + server.id,'PATCH',body) : lib('mcp/install','POST',{ ...body,id: value(f,'id') });
  }, { init(f) {
    const toggle = () => { $('[data-stdio]',f).hidden = value(f,'transport') !== 'stdio'; $('[data-http]',f).hidden = !($('[data-stdio]',f).hidden); };
    f.elements.transport.onchange = toggle; toggle();
    $('[data-lib=key]',f).onclick = () => $('[data-keys]',f).insertAdjacentHTML('beforeend',`<div class="lib-toolbar" data-key-row><select aria-label="env / header"><option>env</option><option>header</option></select>
      <input placeholder="KEY" aria-label="Key"><input type="password" autocomplete="new-password" aria-label="${tr('密钥')}" placeholder="${tr('密钥')}"></div>`);
  } });
}
libraryPage('extensions',tr('skill 与 MCP'),ICON.plug,30,async (el,refresh) => {
  const data = await lib('extensions');
  el.innerHTML = '<div class="lib-toolbar">' + button('github',tr('从 GitHub 安装 skill')) + button('add',tr('添加 MCP')) + '</div>'
    + ['skills','mcp'].map(k => '<h2>' + (k === 'skills' ? 'Skills' : 'MCP') + '</h2><div class="lib-list">' + (data[k].map(s => `<article class="lib-row" data-group="${k}"><div><h3>${esc(s.name)}</h3><p>${esc(s.description)}</p><div class="lib-tags" title="${s.removable ? '' : tr('本机已有的资源只能停用')}">
      ${chip(s.removable ? tr('Agenda 安装') : tr('本机已有'))}${k === 'mcp' ? modeChip(s.mode) : ''}</div></div><label><input type="checkbox" data-switch="${esc(s.id)}" ${s.enabled ? 'checked' : ''}> ${tr('启用')}</label>
      ${s.removable ? (k === 'mcp' ? button('edit',tr('配置与密钥'),s.id) : '') + button('delete',tr('删除'),s.id) : ''}</article>`).join('') || '<p class="hint">' + tr('尚未安装') + '</p>') + '</div>').join('');
  el.onchange = async e => {
    const id = e.target.dataset.switch;
    if (!id) return;
    e.target.disabled = true;
    try { await lib(e.target.closest('[data-group]').dataset.group + '/' + id,'PATCH',{enabled:e.target.checked}); }
    catch (err) { e.target.checked = !e.target.checked; report(err); }
    finally { e.target.disabled = false; }
  };
  actions(el,async (act,id,b) => {
    if (act === 'github') await githubDialog();
    if (act === 'add' || act === 'edit') await mcpEditor(data.mcp.find(x => x.id === id));
    if (act === 'delete' && await choice(id,'',[[act,tr('确认删除')]])) await lib(b.closest('[data-group]').dataset.group + '/' + id,'DELETE',{});
    await refresh();
  });
});
