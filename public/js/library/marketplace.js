import { $, ICON, engineOf, esc, tr } from '../util.js';
import { actions, button, chip, githubDialog, input, installItem, lib, libraryPage, local, modeChip } from './shared.js';

const names = () => ({ roles:tr('角色卡'),teams:tr('团队'),skills:'Skill',mcp:'MCP' });
libraryPage('marketplace',tr('集市'),ICON.files,40,async el => {
  let catalog = await lib('marketplace'), filter = '', searching = false, results = [], note = '', query = '';
  const tabs = (act,rows,current) => rows.map(([id,label]) => `<button type="button" class="btn sm" data-lib="${act}" data-id="${esc(id)}" aria-pressed="${id === current}">${esc(label)}</button>`).join('');
  function render() {
    const groups = names(), rows = searching ? results.map(x => ['mcp',x]) : Object.keys(groups).filter(k => !filter || filter === k).flatMap(k => catalog[k].map(x => [k,x]));
    el.innerHTML = `<div class="lib-toolbar">${tabs('tab',[['catalog',tr('精选清单')],['search',tr('搜索更多')]],searching ? 'search' : 'catalog')}
      ${button('refresh',tr('刷新'))}${chip(catalog.source === 'remote' ? tr('在线清单') : tr('离线清单'))}</div>`
      + (searching ? `<form class="lib-toolbar">${input('q',query,`type="search" aria-label="${tr('搜索 MCP 注册表')}" placeholder="${tr('搜索 MCP 注册表')}"`)}<button class="btn" type="submit">${tr('搜索')}</button>${button('github',tr('从 GitHub 安装 skill'))}</form>`
        : '<div class="lib-toolbar">' + tabs('filter',[['',tr('全部')],...Object.entries(groups)],filter) + '</div>')
      + (note ? '<p role="status">' + esc(note) + '</p>' : '') + '<div class="lib-grid">'
      + rows.map(([k,x]) => `<article class="lib-card" data-group="${k}"><h3>${esc(local(x.name))}</h3><p>${esc(local(x.summary) || x.description)}</p>
        <div class="lib-tags">${chip(groups[k])}${k === 'mcp' ? modeChip(x.mode) : ''}${(x.supportedEngines || ['claude-code','codex','pi']).map(id => chip(engineOf(id)?.defaultName || id)).join('')}</div>
        <div class="lib-actions">${x.installed ? chip(tr('已安装'),'selected') : button('install',tr('安装'),x.id)}
        ${/^https?:\/\//i.test(x.sourceUrl) ? `<a class="lib-source" href="${esc(x.sourceUrl)}" target="_blank" rel="noopener noreferrer">${tr('来源')} ${ICON.external}</a>` : ''}</div></article>`).join('') + '</div>';
    if (searching) $('form',el).onsubmit = async e => {
      e.preventDefault(); query = e.target.elements.q.value;
      const q = query;
      try {
        const res = await lib('marketplace/mcp-search?q=' + encodeURIComponent(q));
        if (query !== q) return;
        const installed = new Set((await lib('extensions')).mcp.map(s => s.id));
        results = res.servers.map(s => ({ ...s, installed: installed.has(s.id) }));
        note = res.registryError ? tr('注册表暂不可用') : results.length ? '' : tr('没有匹配结果');
      } catch (err) { note = err.message; }
      render();
    };
  }
  actions(el,async (act,id,b) => {
    if (act === 'tab') { searching = id === 'search'; note = ''; }
    if (act === 'filter') filter = id;
    if (act === 'github') await githubDialog();
    if (act === 'refresh') catalog = await lib('marketplace?refresh=1');
    if (act === 'install') {
      const k = b.closest('[data-group]').dataset.group, item = (searching ? results : catalog[k]).find(x => x.id === id);
      if (await installItem(k,item)) { item.installed = true; catalog = await lib('marketplace'); }
    }
    render();
  });
  render();
});
