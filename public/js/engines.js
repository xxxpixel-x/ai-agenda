// 引擎与设置：AI 列表、连接与登录、语言
import { input } from './chat.js';
import { $, $$, ICON, api, engineOf, esc, markHtml, shownEngines, state, toast, tr } from './util.js';

// ---------------- 引擎 / 设置 ----------------
export async function refreshEngines(refresh = false) {
  try { state.engines = await api(`/api/engines${refresh ? '?refresh=1' : ''}`); } catch (e) { toast(e.message, 'error'); }
  renderEngineDots();
  renderWelcome();
}
function engineBadge(e) {
  const s = e.status || {};
  if (s.ready) return `<span class="badge ok">${tr('可用')}</span>`;
  if (s.available) return `<span class="badge warn">${tr('待设置')}</span>`;
  return `<span class="badge off">${tr('未安装')}</span>`;
}
function renderEngineDots() {
  $('#engineDots').innerHTML = shownEngines().map((e) => `<i class="${e.status?.ready ? 'ready' : e.status?.available ? 'warn' : ''}" title="${esc(e.label)}"></i>`).join('');
}
function renderWelcome() {
  const none = !state.engines.some((e) => e.status?.ready);
  $('#engineSummary').innerHTML = !none ? '' : shownEngines().map((e) => `
    <div class="engine-card"><div class="n">${markHtml(e.id, e.color)}${esc(e.label)} ${engineBadge(e)}</div>
    <div class="s">${esc(e.status?.note || '')}</div></div>`).join('');
}

export async function openEnginesModal() {
  let settings;
  try { [settings] = await Promise.all([api('/api/settings'), refreshEngines(true)]); } catch (e) { toast(e.message, 'error'); return; }
  const providers = settings.providers.map((p) => ({ ...p }));
  const cli = state.engines.filter((e) => e.kind === 'cli' && !e.hideWhenMissing);
  const gem = engineOf('gemini');
  const gemCli = shownEngines().find((e) => e.id === 'gemini-cli');
  const PRESETS = [
    ['DeepSeek', 'https://api.deepseek.com', 'deepseek-chat'],
    [tr('通义千问'), 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'],
    ['Kimi', 'https://api.moonshot.cn/v1', ''],
    [tr('智谱'), 'https://open.bigmodel.cn/api/paas/v4', ''],
    ['OpenAI', 'https://api.openai.com/v1', ''],
    [tr('Ollama本地'), 'http://localhost:11434/v1', ''],
  ];

  const providerHtml = (p, i) => {
    const e = engineOf(`openai:${p.id}`);
    return `<div class="conn" data-i="${i}">
      <div class="conn-head">${markHtml(`openai:${p.id}`, '#7c3aed', `${p.name || ''} ${p.baseUrl || ''}`)}<b>${esc(p.name || tr('新接口'))}</b>${e ? engineBadge(e) : ''}
        <button class="icon-btn" type="button" data-act="del-provider" title="${tr('删除')}">${ICON.close}</button></div>
      ${e?.status?.note ? `<div class="note">${esc(e.status.note)}</div>` : ''}
      <div class="grid">
        <label>${tr('名字')}<input data-k="name" value="${esc(p.name)}" maxlength="30"></label>
        <label>${tr('默认模型')}<input data-k="model" value="${esc(p.model || '')}" placeholder="${tr('例如 deepseek-chat')}"></label>
        <label class="wide">${tr('接口地址')}<input data-k="baseUrl" value="${esc(p.baseUrl || '')}" placeholder="https://…/v1"></label>
        <label class="wide">API key<input type="password" data-k="apiKey" placeholder="${p.hasKey ? tr('已保存（{0}），留空表示不变', [esc(p.keyHint)]) : tr('填写 API key（本地模型可留空）')}"></label>
      </div></div>`;
  };

  const cliHtml = (e) => `<div class="conn" data-engine="${e.id}">
        <div class="conn-head">${markHtml(e.id, e.color)}<b>${esc(e.label)}</b>${engineBadge(e)}</div>
        <div class="note">${esc(e.status?.note || '')}${e.status?.version ? `（${esc(e.status.version)}）` : ''}</div>
        ${e.status?.command ? `<span class="cmd">${esc(e.status.command)}</span>` : ''}
        <div class="grid"><label class="wide">${tr('程序位置')}<input data-path="${e.id}" value="${esc(settings.paths[e.id] || '')}" placeholder="${esc(e.status?.bin || tr('自动查找'))}"></label></div>
      </div>`;

  const html = `<div class="modal-inner">
    <div class="modal-head"><h3>${tr('设置')}</h3><button class="icon-btn" type="button" data-act="close">${ICON.close}</button></div>
    <div class="modal-body">
      <div class="field"><label for="appLanguage">${tr('语言')}</label>
        <select id="appLanguage">${[['system', '跟随系统 / Follow system'], ['zh', '中文'], ['en', 'English']].map(([value, label]) => `<option value="${value}" ${value === settings.language ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
      <div class="section-title">${tr('本机 AI 应用')}</div>
      ${cli.map(cliHtml).join('')}
      <div class="section-title">Gemini</div>
      ${gemCli ? cliHtml(gemCli) : ''}
      <div class="conn" data-engine="gemini">
        <div class="conn-head">${markHtml('gemini')}<b>Gemini API</b>${gem ? engineBadge(gem) : ''}</div>
        <div class="note">${esc(gem?.status?.note || '')}</div>
        <div class="grid">
          <label class="wide">API key<input type="password" id="gemKey" placeholder="${settings.gemini.hasKey ? tr('已保存（{0}），留空表示不变', [esc(settings.gemini.keyHint)]) : tr('在 aistudio.google.com 创建')}"></label>
          <label class="wide">${tr('接口地址')}<input id="gemBase" value="${esc(settings.gemini.baseUrl || '')}" placeholder="https://generativelanguage.googleapis.com"></label>
        </div>
        ${settings.gemini.hasKey ? `<button class="btn sm danger" type="button" data-act="clear-gem" style="margin-top:8px">${tr('清除 key')}</button>` : ''}
      </div>
      <div class="section-title">${tr('OpenAI 兼容接口')}</div>
      <div class="preset-row">${PRESETS.map(([n], i) => `<button class="btn sm" type="button" data-act="add-provider" data-preset="${i}">＋ ${esc(n)}</button>`).join('')}
        <button class="btn sm ghost" type="button" data-act="add-provider">${tr('＋ 自定义')}</button></div>
      <div id="providerList">${providers.map(providerHtml).join('')}</div>
    </div>
    <div class="modal-foot"><span class="grow"></span>
      <button class="btn" type="button" data-act="recheck">${tr('重新检测')}</button>
      <button class="btn primary" type="button" data-act="save">${tr('保存')}</button></div>
  </div>`;

  const dlg = showModal(html);
  $('#appLanguage', dlg).addEventListener('change', async (ev) => {
    const select = ev.target;
    select.disabled = true;
    try {
      await api('/api/settings', { method: 'PUT', body: { language: select.value } });
      location.reload();
    } catch (e) {
      select.value = settings.language || 'system';
      select.disabled = false;
      toast(e.message, 'error');
    }
  });
  let clearGem = false;
  const collect = () => {
    $$('#providerList .conn', dlg).forEach((el) => {
      const p = providers[+el.dataset.i];
      $$('input[data-k]', el).forEach((inp) => {
        if (inp.dataset.k === 'apiKey') { if (inp.value.trim()) p.apiKey = inp.value.trim(); } else p[inp.dataset.k] = inp.value;
      });
    });
  };
  const rerenderProviders = () => { $('#providerList', dlg).innerHTML = providers.map(providerHtml).join(''); };

  dlg.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'close') dlg.close();
    else if (act === 'add-provider') {
      collect();
      const pr = PRESETS[+b.dataset.preset];
      let name = pr ? pr[0] : tr('自定义接口');
      for (let k = 2; providers.some((p) => p.name === name); k++) name = `${pr ? pr[0] : tr('自定义接口')}${k}`;
      providers.push({ name, baseUrl: pr ? pr[1] : '', model: pr ? pr[2] : '' });
      rerenderProviders();
    } else if (act === 'del-provider') {
      collect();
      providers.splice(+b.closest('.conn').dataset.i, 1);
      rerenderProviders();
    } else if (act === 'clear-gem') {
      clearGem = true; b.textContent = tr('保存后清除'); b.disabled = true;
    } else if (act === 'recheck') {
      dlg.close(); openEnginesModal();
    } else if (act === 'save') {
      collect();
      const paths = {};
      $$('input[data-path]', dlg).forEach((inp) => { paths[inp.dataset.path] = inp.value; });
      const gemini = { baseUrl: $('#gemBase', dlg).value };
      const key = $('#gemKey', dlg).value.trim();
      if (key) gemini.apiKey = key; else if (clearGem) gemini.apiKey = '';
      b.disabled = true;
      try {
        await api('/api/settings', { method: 'PUT', body: { paths, gemini, providers } });
        toast(tr('已保存'));
        dlg.close();
        await refreshEngines(true);
        openEnginesModal();
      } catch (e) { toast(e.message, 'error'); b.disabled = false; }
    }
  });
}

export function showModal(html) {
  const dlg = $('#modal');
  dlg.close();
  const fresh = dlg.cloneNode(false); // 去掉旧的事件监听
  dlg.replaceWith(fresh);
  fresh.innerHTML = html;
  fresh.showModal();
  fresh.addEventListener('cancel', () => fresh.close());
  return fresh;
}

