import { $, ICON, esc, engineOf, md, state, tr } from '../util.js';
import { modelChoices, effortChoices } from '../space-form.js';
import { actions, button, checks, checked, chip, choice, exportLink, field, formDialog, importMarkdown, input, lib, libraryPage, options, value } from './shared.js';

function defaults(role) {
  const pref = role.myDefault || {};
  const html = field(tr('AI'), '<select name="engine">' + options([['',tr('使用角色卡建议')], ...state.engines.map(e => [e.id,e.label])], pref.engine || '') + '</select>')
    + '<div data-settings></div>';
  return formDialog(tr('我的默认') + ' · ' + role.name, html, form => lib('roles/' + role.id + '/default', 'PUT',
    Object.fromEntries(['engine','source','model','effort'].map(k => [k,value(form,k)]))), {
    init(form) {
      const render = () => {
        const e = engineOf(value(form,'engine'));
        const current = e?.id === pref.engine ? pref : {};
        $('[data-settings]', form).innerHTML = !e ? '' : (e.sources ? field(tr('模型来源'), '<select name="source">' + options([
          ...(!e.sourceRequired ? [['',e.accountLabel || tr('默认')]] : []), ...(e.sourceChoices || []).map(s => [s.id,s.name])], current.source) + '</select>') : '')
          + field(tr('型号'), input('model',current.model,'list="lib-models"') + '<datalist id="lib-models">' + options(modelChoices(e)) + '</datalist>')
          + field(tr('思考深度'), '<select name="effort"></select>');
        const efforts = () => { if (e) form.elements.effort.innerHTML = options(effortChoices(e,value(form,'model')).map(x => [x,x || tr('默认')]), current.effort); };
        efforts(); if (e) form.elements.model.oninput = efforts;
      };
      form.elements.engine.onchange = render; render();
    },
  });
}

export async function roleEditor(role = {}, member) {
  const [catalog, installed] = await Promise.all([lib('marketplace'),lib('extensions')]);
  const tools = (k, refs) => [...new Map([...(refs || []), ...catalog[k], ...installed[k]].map(x => [x.id,x])).values()];
  const fields = field(tr('名字'),input('name',role.name || member?.name,'required maxlength="100"'))
    + field(tr('简介'),input('summary',role.summary,'maxlength="1000"'))
    + field(tr('建议的 AI'), '<select name="engine">' + options(state.engines.map(e => [e.id,e.label]),role.suggestedEngine || member?.engine) + '</select>')
    + field(tr('角色说明'), `<textarea name="instructions" maxlength="16000" rows="8">${esc(role.instructions ?? member?.persona ?? '')}</textarea>`)
    + `<details><summary>${tr('预览')}</summary><div class="lib-preview"></div></details>`
    + ['skills','mcp'].map(k => {
      const refs = role[k === 'skills' ? 'recommendedSkills' : 'recommendedMcp'] || [];
      return '<fieldset><legend>' + (k === 'skills' ? tr('推荐的 skill') : tr('推荐的 MCP')) + '</legend>' + checks(k,tools(k,refs),member?.[k] || refs.map(x => x.id)) + '</fieldset>';
    }).join('');
  return formDialog(role.name || tr('新建角色卡'),fields, f => {
    const body = { name: value(f,'name'), summary: value(f,'summary'), suggestedEngine: value(f,'engine'), instructions: value(f,'instructions') };
    for (const [k,key] of [['skills','recommendedSkills'],['mcp','recommendedMcp']]) {
      const available = tools(k,role[key]);
      body[key] = checked(f,k).map(id => {
        const item = available.find(x => x.id === id);
        return { id, name: item.name, source: item.source || item.sourceUrl || '', ...(k === 'mcp' && { mode: item.mode }) };
      });
    }
    if (role.id) for (const key of Object.keys(body)) if (JSON.stringify(body[key]) === JSON.stringify(role[key])) delete body[key];
    if (role.id && !Object.keys(body).length) return role;
    return lib('roles' + (role.id ? '/' + role.id : ''),role.id ? 'PATCH' : 'POST',body);
  }, { init(f) {
    const update = () => { $('.lib-preview',f).innerHTML = md(value(f,'instructions')); };
    f.elements.instructions.oninput = update; update();
  } });
}

libraryPage('roles',tr('角色卡'),ICON.library,10,async (el,refresh) => {
  const roles = await lib('roles');
  el.innerHTML = '<div class="lib-toolbar">' + button('new',tr('新建角色卡'),'','primary') + button('import',tr('导入 Markdown')) + '</div><div class="lib-grid">'
    + roles.map(r => `<article class="lib-card"><h3>${esc(r.name)}</h3><p>${esc(r.summary)}</p><div class="lib-tags">
      ${chip(r.customized ? tr('已自定义') : r.builtin ? tr('内置') : tr('自建'))}${chip(engineOf(r.suggestedEngine)?.defaultName || r.suggestedEngine)}
      ${chip(`${r.recommendedSkills.length} skill · ${r.recommendedMcp.length} MCP`)}${r.myDefault ? chip(tr('我的默认'),'selected') : ''}</div>
      <div class="lib-actions">${button('edit',tr('编辑'),r.id)}${button('default',tr('我的默认'),r.id)}${exportLink('roles',r.id)}
      ${r.customized ? button('reset',tr('恢复默认'),r.id) : !r.builtin ? button('delete',tr('删除'),r.id) : ''}</div></article>`).join('') + '</div>';
  actions(el,async (act,id) => {
    const role = roles.find(r => r.id === id);
    if (act === 'new' || act === 'edit') await roleEditor(role);
    if (act === 'default') await defaults(role);
    if (act === 'import') await importMarkdown();
    if (['reset','delete'].includes(act)) {
      if (!await choice(role.name,'',[[act,act === 'reset' ? tr('恢复默认') : tr('确认删除')]])) return;
      await lib('roles/' + id + (act === 'reset' ? '/reset' : ''),act === 'reset' ? 'POST' : 'DELETE',{});
    }
    await refresh();
  });
});
