import { refreshEngines } from '../engines.js';
import { register } from '../slots.js';
import { $, $$, ICON, api, engineOf, esc, markHtml, shownEngines, toast, tr } from '../util.js';

// [名字, OpenAI 兼容地址, 默认模型, Anthropic 兼容地址（给 Claude Code 用）]，地址和型号按各家官方文档（2026-11-20）
const PRESETS = [
  ['DeepSeek', 'https://api.deepseek.com', 'deepseek-flash', 'https://api.deepseek.com/anthropic'],
  [tr('通义千问'), 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'],
  ['Kimi', 'https://api.moonshot.cn/v1', 'kimi-k3.1-pro', 'https://api.moonshot.cn/anthropic'],
  [tr('智谱'), 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3', 'https://open.bigmodel.cn/api/anthropic'],
  ['OpenAI', 'https://api.openai.com/v1', ''],
  [tr('Ollama本地'), 'http://localhost:11434/v1', ''],
];

function button(action, label, style = '') {
  return `<button type="button" class="btn sm ${style}" data-act="${esc(action)}">${esc(label)}</button>`;
}

function field(name, label, value, placeholder, wide = false) {
  return `<label class="conn-field${wide ? ' wide' : ''}"><span>${esc(label)}</span>
    <input name="${esc(name)}" type="${name === 'apiKey' ? 'password' : 'text'}" value="${esc(value)}"
      placeholder="${esc(placeholder)}"${name === 'name' ? ' maxlength="30"' : ''}></label>`;
}

// 也给 Claude Code 用：勾上才露出 Anthropic 兼容地址
function claudeCodeFields(p) {
  return `<div class="conn-field wide"><label class="check-row"><input name="claudeCode" type="checkbox"${p.claudeCode ? ' checked' : ''}>${esc(tr('也给 Claude Code 用'))}</label></div>`
    + field('anthropicUrl', tr('Anthropic 兼容地址'), p.anthropicUrl || '', 'https://…/anthropic', true).replace('<label class="conn-field wide"', `<label class="conn-field wide"${p.claudeCode ? '' : ' hidden'}`);
}

const valueOf = (input) => (input.type === 'checkbox' ? input.checked : input.value);
const edited = (input) => (input.type === 'checkbox' ? input.checked !== input.defaultChecked : input.value !== input.defaultValue);

function keyField(connection, placeholder) {
  const hint = connection.hasKey ? tr('已保存（{0}），留空表示不变', [connection.keyHint]) : placeholder;
  return field('apiKey', tr('API 密钥'), '', hint, true);
}

const providerKey = (id) => `openai:${id}`;
const isDraft = (key) => key.startsWith('draft:');
const acpKey = (id) => `acp:${id}`;
const isAcpDraft = (key) => key.startsWith('acp-draft:');
const formatArgs = (args = []) => args.map((s) => s && !/[\s'"]/.test(s) ? s : '"' + s.replace(/"/g, '\\"').replace(/(\\*)$/, '"$1')).join(' ');

async function render(el) {
  let settings;
  try { settings = await api('/api/settings'); }
  catch (e) { toast(e.message, 'error'); return; }

  const expanded = new Set();
  const drafts = new Map();
  const acpDrafts = new Map();
  let draftNumber = 0;
  let busy = false;

  function item(key, mark, name, badge, detail) {
    const open = expanded.has(key);
    return `<div class="conn-item${open ? ' open' : ''}" data-conn="${esc(key)}">
      <button class="conn-row" type="button" aria-expanded="${open}">${mark}<span class="conn-name">${esc(name)}</span>
        ${badge}<span class="conn-chev">${ICON.chevron}</span></button>
      <div class="conn-detail"${open ? '' : ' hidden'}>${detail}</div>
    </div>`;
  }

  function connection(key, name, fields, action = '', hint = '') {
    const engine = engineOf(key);
    const status = engine?.status || {};
    const [style, label] = isDraft(key) ? ['off', tr('未保存')]
      : status.ready ? ['ok', tr('可用')] : status.available ? ['warn', tr('待设置')] : ['off', tr('未安装')];
    const badge = `<span class="conn-state ${style}">${esc(label)}</span>`;
    const note = [status.note, status.version].filter(Boolean).join(' · ');
    return item(key, markHtml(key, esc(engine?.color || '#7c3aed'), hint), name, badge, `
      ${note ? `<div class="conn-note">${esc(note)}</div>` : ''}
      ${status.command ? `<code class="cmd">${esc(status.command)}</code>` : ''}
      <div class="conn-fields">${fields}</div>
      <div class="conn-actions">${action}<span class="grow"></span>${button('save', tr('保存'), 'primary')}</div>`);
  }

  function provider(key, p) {
    const fields = field('name', tr('名字'), p.name, '')
      + field('model', tr('默认模型'), p.model, tr('例如 deepseek-chat'))
      + field('baseUrl', tr('接口地址'), p.baseUrl, 'https://…/v1', true)
      + keyField(p, tr('填写 API key（本地模型可留空）'))
      + claudeCodeFields(p);
    return connection(key, p.name || tr('新接口'), fields, button('delete', tr('删除接口'), 'danger'), `${p.name} ${p.baseUrl}`);
  }

  function acpItem(key, c) {
    const status = engineOf(key)?.status || settings.acpStatuses?.[key] || {};
    const style = isAcpDraft(key) ? 'off' : status.ready ? 'ok' : status.available ? 'warn' : 'off';
    const label = isAcpDraft(key) ? tr('未保存') : status.ready ? tr('可用') : tr('不可用');
    const badge = `<span class="conn-state ${style}">${esc(label)}</span>`;
    const color = esc(c.color || '#6366f1');
    const note = [status.note, status.version].filter(Boolean).join(' · ');
    return item(key, markHtml(key, color, c.name), c.name || tr('自定义 AI'), badge, `
      ${note ? `<div class="conn-note">${esc(note)}</div>` : ''}
      <div class="conn-fields">${field('name', tr('名字'), c.name, '')}
        <label class="conn-field"><span>${tr('图标颜色')}</span><input name="color" type="color" value="${color}"></label>
        ${field('command', tr('启动命令'), c.command, 'npx / node / agent-cli', true)}
        ${field('args', tr('启动参数'), formatArgs(c.args), '--acp', true)}</div>
      <div class="conn-actions">${button('delete', tr('删除'), 'danger')}<span class="grow"></span>
        ${button('test-acp', tr('测试握手'))}${button('save', tr('保存'), 'primary')}</div>`);
  }

  function draw(savedKey, savedField) {
    // 只恢复仍在编辑的字段；其余字段显示服务端刚返回的值。
    const edits = new Map();
    for (const row of $$('.conn-item', el)) {
      const values = new Map();
      for (const input of $$('input', row)) {
        if (row.dataset.conn === savedKey && (!savedField || input.name === savedField)) continue;
        if (edited(input)) values.set(input.name, valueOf(input));
      }
      edits.set(row.dataset.conn, values);
    }
    const cli = shownEngines().filter((e) => e.kind === 'cli').map((e) => connection(e.id, e.label,
      field('path', tr('程序位置'), settings.paths[e.id], e.status?.bin || tr('自动查找'), true)));
    const gem = settings.gemini;
    const gemFields = keyField(gem, tr('在 aistudio.google.com 创建'))
      + field('baseUrl', tr('接口地址'), gem.baseUrl, 'https://generativelanguage.googleapis.com', true);
    const gemini = connection('gemini', 'Gemini API', gemFields,
      gem.hasKey ? button('clear-key', tr('清除 key'), 'danger') : '');
    const presets = PRESETS.map(([name], i) =>
      `<button type="button" class="btn sm" data-act="preset" data-preset="${i}">${esc(name)}</button>`).join('');
    const add = item('add', ICON.plus, tr('添加接口'), '', `<div class="preset-row">${presets}${button('preset', tr('自定义'))}</div>`);
    el.innerHTML = `<section class="set-group">
      <h3 class="set-group-title"><span>${esc(tr('本机程序'))}</span>${button('recheck', tr('重新检测'))}</h3>
      <div class="set-list">${cli.join('')}</div></section>
      <section class="set-group"><h3 class="set-group-title"><span>API</span></h3>
      <div class="set-list">${gemini}${settings.providers.map((p) => provider(providerKey(p.id), p)).join('')}
        ${[...drafts].map(([key, p]) => provider(key, p)).join('')}${add}</div></section>
      <section class="set-group"><h3 class="set-group-title">${esc(tr('自定义 AI（ACP）'))}</h3><div class="set-list">
        ${settings.customAcp.map((c) => acpItem(acpKey(c.id), c)).join('')}
        ${[...acpDrafts].map(([key, c]) => acpItem(key, c)).join('')}
        <div class="conn-item"><button class="conn-row" type="button" data-act="add-acp">${ICON.plus}<span class="conn-name">${tr('自定义 AI')}</span></button></div>
      </div></section>`;
    for (const row of $$('.conn-item', el)) {
      const values = edits.get(row.dataset.conn);
      for (const input of $$('input', row)) {
        if (!values?.has(input.name)) continue;
        if (input.type === 'checkbox') input.checked = values.get(input.name);
        else input.value = values.get(input.name);
      }
      syncClaudeCode(row);
    }
  }

  function syncClaudeCode(row) {
    const box = $('input[name="claudeCode"]', row);
    const url = $('input[name="anthropicUrl"]', row);
    if (box && url) url.closest('label').hidden = !box.checked;
  }

  function addDraft(preset) {
    const [baseName, baseUrl, model, anthropicUrl = ''] = preset || [tr('自定义接口'), '', ''];
    const names = new Set($$('input[name="name"]', el).map((input) => input.value));
    let name = baseName;
    for (let i = 2; names.has(name); i++) name = `${baseName}${i}`;
    const key = `draft:${++draftNumber}`;
    drafts.set(key, { name, baseUrl, model, anthropicUrl });
    expanded.delete('add');
    focusDraft(key);
  }

  function focusDraft(key) {
    expanded.add(key);
    draw();
    const row = $(`[data-conn="${key}"]`, el);
    row.scrollIntoView({ block: 'nearest' });
    $$('input', row).find((input) => !input.value)?.focus({ preventScroll: true });
  }

  async function saveRow(key, action, values) {
    let body;
    let savedAcpKey;
    if (key === 'gemini') {
      body = { gemini: action === 'clear-key' ? { apiKey: '' } : values };
    } else if (isDraft(key) || key.startsWith('openai:')) {
      // providers 是整表替换。以最新的已保存列表为底，只叠加本行的操作。
      const latest = await api('/api/settings');
      const providers = latest.providers.map(({ id, name, model, baseUrl }) => ({ id, name, model, baseUrl }));
      if (isDraft(key)) {
        if (providers.length >= 20) throw new Error(tr('最多可添加 20 个接口'));
        providers.push(values);
      } else {
        const i = providers.findIndex((p) => providerKey(p.id) === key);
        if (i < 0) throw new Error(tr('接口已删除'));
        if (action === 'delete') providers.splice(i, 1);
        else Object.assign(providers[i], values);
      }
      body = { providers };
    } else if (isAcpDraft(key) || key.startsWith('acp:')) {
      const { customAcp } = await api('/api/settings');
      if (isAcpDraft(key)) {
        if (customAcp.length >= 20) throw new Error(tr('最多可添加 20 个自定义 AI'));
        customAcp.push(values);
      } else {
        const i = customAcp.findIndex((c) => acpKey(c.id) === key);
        if (i < 0) throw new Error(tr('找不到这个自定义 AI'));
        if (action === 'delete') customAcp.splice(i, 1);
        else Object.assign(customAcp[i], values);
      }
      body = { customAcp };
    } else {
      body = { paths: { [key]: values.path } };
    }
    settings = await api('/api/settings', { method: 'PUT', body });
    if (isDraft(key)) {
      drafts.delete(key);
      expanded.delete(key);
      expanded.add(providerKey(settings.providers.at(-1).id));
    } else if (isAcpDraft(key)) {
      acpDrafts.delete(key);
      expanded.delete(key);
      savedAcpKey = acpKey(settings.customAcp.at(-1).id);
      expanded.add(savedAcpKey);
    } else if (action === 'delete') expanded.delete(key);
    const status = settings.acpStatuses?.[savedAcpKey || key];
    toast(status?.note || tr('已保存'), status && !status.ready ? 'error' : undefined);
    // PUT 的响应也是最新配置，即便随后的重新读取失败，也不会重复创建接口。
    try {
      await refreshEngines(true);
      settings = { acpStatuses: settings.acpStatuses, ...await api('/api/settings') };
    } finally {
      draw(key, action === 'clear-key' ? 'apiKey' : undefined);
    }
  }

  draw();
  el.onchange = (event) => {
    if (event.target.name === 'claudeCode') syncClaudeCode(event.target.closest('.conn-item'));
  };
  el.onclick = async (event) => {
    const target = event.target.closest('button');
    if (!target) return;
    const row = target.closest('.conn-item');
    const key = row?.dataset.conn;
    if (target.classList.contains('conn-row') && key) {
      const open = row.classList.toggle('open');
      if (open) expanded.add(key); else expanded.delete(key);
      target.setAttribute('aria-expanded', String(open));
      $('.conn-detail', row).hidden = !open;
      return;
    }
    const action = target.dataset.act;
    if (busy || !action) return;
    if (action === 'add-acp') {
      const draft = `acp-draft:${++draftNumber}`;
      acpDrafts.set(draft, { name: '', command: '', args: [] });
      focusDraft(draft);
      return;
    }
    if (action === 'preset') { addDraft(PRESETS[target.dataset.preset]); return; }
    if (action === 'delete' && (isDraft(key) || isAcpDraft(key))) {
      drafts.delete(key);
      acpDrafts.delete(key);
      expanded.delete(key);
      draw(key);
      return;
    }

    busy = true;
    const controls = [...$$('button[data-act]', el), ...(row ? $$('input', row) : [])];
    controls.forEach((control) => { control.disabled = true; });
    try {
      if (action === 'recheck') {
        await refreshEngines(true);
        draw();
      } else {
        const values = Object.fromEntries($$('input', row).map((input) => [input.name, valueOf(input)]));
        if (values.apiKey !== undefined) {
          values.apiKey = values.apiKey.trim();
          if (!values.apiKey) delete values.apiKey;
        }
        if (action === 'test-acp') {
          const id = isAcpDraft(key) ? undefined : key.slice(4);
          const status = await api('/api/acp/test', { method: 'POST', body: { id, ...values } });
          toast(status.note, status.ready ? undefined : 'error');
        } else await saveRow(key, action, values);
      }
    } catch (e) { toast(e.message, 'error'); }
    finally {
      busy = false;
      controls.forEach((control) => { control.disabled = false; });
    }
  };
}

register('settings', { id: 'connections', label: tr('AI 连接'), icon: ICON.plug, order: 20, render });
