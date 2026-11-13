// Agenda —— 界面逻辑
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initial = (name) => [...(name || '?')][0];

const ACCESS = {
  read: { label: '只读', desc: '只能阅读，不能修改' },
  edit: { label: '可改文件', desc: '可以阅读和修改文件' },
  run: { label: '可运行命令', desc: '还能运行命令，适合代码项目' },
  full: { label: '全部权限', desc: '不受限制，可以动电脑上任何地方' },
};
const svg = (d, z = 16) => `<svg viewBox="0 0 24 24" width="${z}" height="${z}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  files: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  settings: svg('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
  export: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  import: svg('<path d="M4 5h11a3 3 0 0 1 3 3v3M4 5v14h9M8 9h5M8 13h3"/><path d="M15 17h6M18 14l3 3-3 3"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 15),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>', 14),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', 14),
  chevron: svg('<path d="M9 6l6 6-6 6"/>', 12),
  system: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'),
  light: svg('<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>'),
  dark: svg('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
};
const ACT_ICON = {
  read: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', 13),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>', 13),
  search: svg('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>', 13),
  command: svg('<path d="M5 7l5 5-5 5M12 17h7"/>', 13),
  tool: svg('<circle cx="12" cy="12" r="2.5"/>', 13),
};

const state = {
  app: {},
  engines: [],        // [{ id, label, color, models, efforts, freeModel, status }]
  spaces: [],
  space: null,        // 当前空间（完整数据）
  es: null,
  files: { open: load('rt:filesOpen') ?? true, tab: 'files', list: [], root: '', view: null, history: [], expanded: new Set(), flash: new Set() },
};

// ---------------- 工具 ----------------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `请求失败（${res.status}）`), { conflict: data.conflict });
  return data;
}
function toast(text, level = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), level === 'error' ? 10000 : 3500);
}
function store(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }
function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}
const clock = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const sizeText = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const engineOf = (id) => state.engines.find((e) => e.id === id);

// 各 AI 的图标（public/icons）。单色的跟随文字颜色，用遮罩画；彩色的直接用图片。
const MONO_LOGO = new Set(['codex', 'openai', 'ollama', 'kimi']);
const LOGO_OF = { 'claude-code': 'claude', codex: 'codex', dsh: 'deepseek', gemini: 'gemini' };
const LOGO_HINT = [[/deepseek/i, 'deepseek'], [/qwen|dashscope|通义|千问/i, 'qwen'], [/kimi|moonshot/i, 'kimi'], [/zhipu|bigmodel|智谱|glm/i, 'zhipu'],
  [/ollama|:11434/i, 'ollama'], [/claude|anthropic/i, 'claude'], [/gemini/i, 'gemini'], [/openai|gpt/i, 'openai']];
function logoKey(engineId, hint = '') {
  if (LOGO_OF[engineId]) return LOGO_OF[engineId];
  const e = engineOf(engineId);
  const text = `${hint} ${e?.label || ''}`;
  return LOGO_HINT.find(([re]) => re.test(text))?.[1] || null;
}
const logoHtml = (k) => (MONO_LOGO.has(k) ? `<i class="logo mono" style="--logo:url(/icons/${k}.svg)"></i>` : `<img class="logo" src="/icons/${k}.svg" alt="">`);
/** 成员头像：有图标用图标，没有就用名字的第一个字。 */
function avatarHtml(engineId, name) {
  const k = logoKey(engineId);
  return k ? `<span class="avatar has-logo">${logoHtml(k)}</span>` : `<span class="avatar">${esc(initial(name))}</span>`;
}
/** 连接列表里的小标记：有图标用图标，没有就用颜色圆点。 */
function markHtml(engineId, color, hint) {
  const k = logoKey(engineId, hint);
  return k ? logoHtml(k) : `<span class="swatch" style="--c:${color}"></span>`;
}

// 简洁、安全的 Markdown 渲染（先转义再加格式）
function md(src) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/@([^\s@，。,.!?！？:：、；;）)]+)/g, '<span class="at">@$1</span>');
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  let html = '';
  let para = [];
  const flush = () => { if (para.length) html += `<p>${para.map(inline).join('<br>')}</p>`; para = []; };
  const UL = /^\s*[-*•]\s+/;
  const OL = /^\s*\d+(?:[.)]\s+|、\s*)/;
  const TR = /^\s*\|.*\|\s*$/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (/^\s*```/.test(line)) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush(); html += '<hr>'; i++;
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flush();
      const lv = Math.min(6, Math.max(3, m[1].length + 2));
      html += `<h${lv}>${inline(m[2])}</h${lv}>`; i++;
    } else if (TR.test(line) && TR.test(lines[i + 1] || '') && /^[\s|:-]+$/.test(lines[i + 1])) {
      flush();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && TR.test(lines[i])) rows.push(cells(lines[i++]));
      html += `<table><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</table>`;
    } else if (UL.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && UL.test(lines[i])) items.push(lines[i++].replace(UL, ''));
      html += `<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`;
    } else if (OL.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && OL.test(lines[i])) items.push(lines[i++].replace(OL, ''));
      html += `<ol>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`;
    } else if (/^>\s?/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      html += `<blockquote>${buf.map(inline).join('<br>')}</blockquote>`;
    } else if (!line.trim()) {
      flush(); i++;
    } else {
      para.push(line); i++;
    }
  }
  flush();
  return html;
}

// 行级 diff（LCS）。文件很大时退化为“整段替换”。
function diffLines(a, b) {
  const A = (a ?? '').split('\n');
  const B = (b ?? '').split('\n');
  if (a == null) return B.map((t, j) => ({ t, type: 'add', nb: j + 1 }));
  if (b == null) return A.map((t, i) => ({ t, type: 'del', na: i + 1 }));
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length - 1;
  let endB = B.length - 1;
  while (endA >= start && endB >= start && A[endA] === B[endB]) { endA--; endB--; }
  const midA = A.slice(start, endA + 1);
  const midB = B.slice(start, endB + 1);
  const out = [];
  for (let i = 0; i < start; i++) out.push({ t: A[i], type: 'same', na: i + 1, nb: i + 1 });
  if (midA.length * midB.length > 4_000_000) {
    midA.forEach((t, k) => out.push({ t, type: 'del', na: start + k + 1 }));
    midB.forEach((t, k) => out.push({ t, type: 'add', nb: start + k + 1 }));
  } else {
    const n = midA.length;
    const m = midB.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) { out.push({ t: midA[i], type: 'same', na: start + i + 1, nb: start + j + 1 }); i++; j++; } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { out.push({ t: midB[j], type: 'add', nb: start + j + 1 }); j++; } else { out.push({ t: midA[i], type: 'del', na: start + i + 1 }); i++; }
    }
  }
  for (let k = endA + 1; k < A.length; k++) out.push({ t: A[k], type: 'same', na: k + 1, nb: endB + 1 + (k - endA) });
  return out;
}
function diffHtml(before, after) {
  const lines = diffLines(before, after);
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => { if (l.type !== 'same') for (let k = Math.max(0, i - 3); k <= Math.min(lines.length - 1, i + 3); k++) keep[k] = true; });
  let html = '';
  let gap = 0;
  lines.forEach((l, i) => {
    if (!keep[i]) { gap++; return; }
    if (gap) { html += `<div class="dl gap">… 省略 ${gap} 行未改动 …</div>`; gap = 0; }
    const no = l.type === 'add' ? `+${l.nb}` : l.type === 'del' ? `-${l.na}` : l.nb;
    html += `<div class="dl ${l.type}"><span class="no">${no}</span><span>${esc(l.t) || ' '}</span></div>`;
  });
  if (gap) html += `<div class="dl gap">… 省略 ${gap} 行未改动 …</div>`;
  return html || '<div class="empty-files">没有差异</div>';
}

// ---------------- 引擎 / 设置 ----------------
async function refreshEngines(refresh = false) {
  try { state.engines = await api(`/api/engines${refresh ? '?refresh=1' : ''}`); } catch (e) { toast(e.message, 'error'); }
  renderEngineDots();
  renderWelcome();
}
function engineBadge(e) {
  const s = e.status || {};
  if (s.ready) return '<span class="badge ok">可用</span>';
  if (s.available) return '<span class="badge warn">待设置</span>';
  return '<span class="badge off">未安装</span>';
}
function renderEngineDots() {
  $('#engineDots').innerHTML = state.engines.map((e) => `<i class="${e.status?.ready ? 'ready' : e.status?.available ? 'warn' : ''}" title="${esc(e.label)}"></i>`).join('');
}
function renderWelcome() {
  const none = !state.engines.some((e) => e.status?.ready);
  $('#engineSummary').innerHTML = !none ? '' : state.engines.map((e) => `
    <div class="engine-card"><div class="n">${markHtml(e.id, e.color)}${esc(e.label)} ${engineBadge(e)}</div>
    <div class="s">${esc(e.status?.note || '')}</div></div>`).join('');
}

async function openEnginesModal() {
  let settings;
  try { [settings] = await Promise.all([api('/api/settings'), refreshEngines(true)]); } catch (e) { toast(e.message, 'error'); return; }
  const providers = settings.providers.map((p) => ({ ...p }));
  const cli = state.engines.filter((e) => ['claude-code', 'codex', 'dsh'].includes(e.id));
  const gem = engineOf('gemini');
  const PRESETS = [
    ['DeepSeek', 'https://api.deepseek.com', 'deepseek-chat'],
    ['通义千问', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'],
    ['Kimi', 'https://api.moonshot.cn/v1', ''],
    ['智谱', 'https://open.bigmodel.cn/api/paas/v4', ''],
    ['OpenAI', 'https://api.openai.com/v1', ''],
    ['Ollama本地', 'http://localhost:11434/v1', ''],
  ];

  const providerHtml = (p, i) => {
    const e = engineOf(`openai:${p.id}`);
    return `<div class="conn" data-i="${i}">
      <div class="conn-head">${markHtml(`openai:${p.id}`, '#7c3aed', `${p.name || ''} ${p.baseUrl || ''}`)}<b>${esc(p.name || '新接口')}</b>${e ? engineBadge(e) : ''}
        <button class="icon-btn" type="button" data-act="del-provider" title="删除">${ICON.close}</button></div>
      ${e?.status?.note ? `<div class="note">${esc(e.status.note)}</div>` : ''}
      <div class="grid">
        <label>名字<input data-k="name" value="${esc(p.name)}" maxlength="30"></label>
        <label>默认模型<input data-k="model" value="${esc(p.model || '')}" placeholder="例如 deepseek-chat"></label>
        <label class="wide">接口地址<input data-k="baseUrl" value="${esc(p.baseUrl || '')}" placeholder="https://…/v1"></label>
        <label class="wide">API key<input type="password" data-k="apiKey" placeholder="${p.hasKey ? `已保存（${esc(p.keyHint)}），留空表示不变` : '填写 API key（本地模型可留空）'}"></label>
      </div></div>`;
  };

  const html = `<div class="modal-inner">
    <div class="modal-head"><h3>连接与登录</h3><button class="icon-btn" type="button" data-act="close">${ICON.close}</button></div>
    <div class="modal-body">
      <div class="section-title">本机 AI 应用</div>
      ${cli.map((e) => `<div class="conn" data-engine="${e.id}">
        <div class="conn-head">${markHtml(e.id, e.color)}<b>${esc(e.label)}</b>${engineBadge(e)}</div>
        <div class="note">${esc(e.status?.note || '')}${e.status?.version ? `（${esc(e.status.version)}）` : ''}</div>
        ${e.status?.command ? `<span class="cmd">${esc(e.status.command)}</span>` : ''}
        <div class="grid"><label class="wide">程序位置<input data-path="${e.id}" value="${esc(settings.paths[e.id] || '')}" placeholder="${esc(e.status?.bin || '自动查找')}"></label></div>
      </div>`).join('')}
      <div class="section-title">Gemini</div>
      <div class="conn" data-engine="gemini">
        <div class="conn-head">${markHtml('gemini')}<b>Gemini API</b>${gem ? engineBadge(gem) : ''}</div>
        <div class="note">${esc(gem?.status?.note || '')}</div>
        <div class="grid">
          <label class="wide">API key<input type="password" id="gemKey" placeholder="${settings.gemini.hasKey ? `已保存（${esc(settings.gemini.keyHint)}），留空表示不变` : '在 aistudio.google.com 创建'}"></label>
          <label class="wide">接口地址<input id="gemBase" value="${esc(settings.gemini.baseUrl || '')}" placeholder="https://generativelanguage.googleapis.com"></label>
        </div>
        ${settings.gemini.hasKey ? '<button class="btn sm danger" type="button" data-act="clear-gem" style="margin-top:8px">清除 key</button>' : ''}
      </div>
      <div class="section-title">OpenAI 兼容接口</div>
      <div class="preset-row">${PRESETS.map(([n], i) => `<button class="btn sm" type="button" data-act="add-provider" data-preset="${i}">＋ ${esc(n)}</button>`).join('')}
        <button class="btn sm ghost" type="button" data-act="add-provider">＋ 自定义</button></div>
      <div id="providerList">${providers.map(providerHtml).join('')}</div>
    </div>
    <div class="modal-foot"><span class="grow"></span>
      <button class="btn" type="button" data-act="recheck">重新检测</button>
      <button class="btn primary" type="button" data-act="save">保存</button></div>
  </div>`;

  const dlg = showModal(html);
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
      let name = pr ? pr[0] : '自定义接口';
      for (let k = 2; providers.some((p) => p.name === name); k++) name = `${pr ? pr[0] : '自定义接口'}${k}`;
      providers.push({ name, baseUrl: pr ? pr[1] : '', model: pr ? pr[2] : '' });
      rerenderProviders();
    } else if (act === 'del-provider') {
      collect();
      providers.splice(+b.closest('.conn').dataset.i, 1);
      rerenderProviders();
    } else if (act === 'clear-gem') {
      clearGem = true; b.textContent = '保存后清除'; b.disabled = true;
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
        toast('已保存');
        dlg.close();
        await refreshEngines(true);
        openEnginesModal();
      } catch (e) { toast(e.message, 'error'); b.disabled = false; }
    }
  });
}

function showModal(html) {
  const dlg = $('#modal');
  const fresh = dlg.cloneNode(false); // 去掉旧的事件监听
  dlg.replaceWith(fresh);
  fresh.innerHTML = html;
  fresh.showModal();
  fresh.addEventListener('cancel', () => fresh.close());
  return fresh;
}

// ---------------- 成员编辑器（新建空间 / 空间设置共用） ----------------
// 型号候选：写死的常用型号 + 检测时查到的（字符串，或 [型号, 显示名]）
function modelChoices(e) {
  const seen = new Map();
  for (const x of [...(e.models || []), ...(e.status?.models || [])]) {
    const [v, l] = Array.isArray(x) ? x : [x, ''];
    if (v && !seen.has(v)) seen.set(v, l && l !== v ? l : '');
  }
  return [...seen];
}
// 思考档位：查到了这个型号支持哪些就只列那些，否则列这个 AI 的全部档位
function effortChoices(e, model) {
  const known = e.status?.efforts?.[model || e.status?.defaultModel || ''];
  return known ? ['', ...known] : e.efforts || [];
}
function effortSelect(e, m) {
  const list = effortChoices(e, m.model);
  if (list.length <= 1) return '<span data-k="effort"></span>';
  return `<select data-k="effort" title="思考深度">${list.map((v) => `<option value="${esc(v)}" ${v === (m.effort || '') ? 'selected' : ''}>思考：${esc(v || '默认')}</option>`).join('')}</select>`;
}
function memberEditor(container, members) {
  const render = () => {
    container.innerHTML = `<div class="member-rows">${members.map((m, i) => {
      const e = engineOf(m.engine) || {};
      const models = modelChoices(e);
      const st = e.status || {};
      return `<div class="member-row" data-i="${i}" style="--c:${e.color || '#999'}">
        <div class="member-top">
          <input data-k="name" value="${esc(m.name)}" maxlength="20" placeholder="名字">
          <select data-k="engine">${state.engines.map((x) => `<option value="${esc(x.id)}" ${x.id === m.engine ? 'selected' : ''}>${esc(x.label)}${x.status?.ready ? '' : '（未就绪）'}</option>`).join('')}</select>
          <input data-k="model" value="${esc(m.model || '')}" list="models-${i}" placeholder="${esc(st.defaultModel ? `默认：${st.defaultModel}` : '默认模型')}">
          <datalist id="models-${i}">${models.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</datalist>
          ${effortSelect(e, m)}
          <button class="icon-btn" type="button" data-act="del-member" title="移除" ${members.length <= 1 ? 'disabled' : ''}>${ICON.close}</button>
        </div>
        ${!st.ready ? `<div class="member-status warn">⚠ ${esc(st.note || '还不能用')}</div>` : ''}
        <details ${m.persona ? 'open' : ''}><summary>设定</summary>
          <textarea data-k="persona" rows="2" placeholder="例如：你负责挑毛病；或者：你是这份论文的审稿人">${esc(m.persona || '')}</textarea></details>
      </div>`;
    }).join('')}</div>
    <button class="btn sm ghost" type="button" data-act="add-member" ${members.length >= 8 ? 'disabled' : ''}>＋ 添加成员</button>`;
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
      const e = state.engines.find((x) => x.status?.ready && !used.has(x.id)) || state.engines.find((x) => x.status?.ready) || state.engines[0];
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
  const prefer = ['claude-code', 'codex', 'dsh', 'gemini'];
  let list = state.engines.filter((e) => e.status?.ready && (prefer.includes(e.id) || e.id.startsWith('openai:')));
  if (!list.length) list = state.engines.filter((e) => prefer.includes(e.id));
  return list.slice(0, 4).map((e) => ({ engine: e.id, name: e.defaultName, model: '', effort: '', persona: '' }));
}
const accessChoices = (cur) => Object.entries(ACCESS).map(([k, v]) => `
  <label class="choice"><input type="radio" name="access" value="${k}" ${k === cur ? 'checked' : ''}>
    <span><b>${v.label}</b><div class="d">${v.desc}</div></span></label>`).join('');

async function openNewSpaceModal() {
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
    <div class="modal-head"><h3>新建空间</h3><button class="btn sm ghost" type="button" data-act="from-chat">从对话开始</button><button class="icon-btn" type="button" data-act="close">${ICON.close}</button></div>
    <div class="modal-body">
      <div id="nsImport"></div>
      <div class="field"><label>名字</label><input id="nsTitle" maxlength="60" placeholder="例如：毕业论文第三章"></div>
      <div class="field"><div class="label">成员</div><div id="nsMembers"></div></div>
      <div class="field"><div class="label">共享文件夹</div>
        <div class="choices">
          <label class="choice"><input type="radio" name="ws" value="managed" checked><span><b>新建一个空文件夹</b><div class="d">适合写作和讨论</div></span></label>
          <label class="choice"><input type="radio" name="ws" value="folder"><span><b>用电脑上已有的文件夹</b><div class="d">AI 会直接读写里面的文件</div>
            <div class="folder-row"><input id="nsFolder" placeholder="点右边按钮选择" readonly><button class="btn sm" type="button" data-act="pick">选择…</button></div></span></label>
        </div></div>
      <div class="field"><div class="label">AI 的权限</div><div class="choices">${accessChoices('edit')}</div></div>
      <div class="field"><label>每次最多来回几次</label>
        <input id="nsTurns" type="number" min="1" max="30" value="6" style="width:100px"></div>
    </div>
    <div class="modal-foot"><button class="btn" type="button" data-act="close">取消</button><button class="btn primary" type="button" data-act="create">创建</button></div>
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
      if (!members.some((m) => m.engine === imp.engine)) {
        const e = engineOf(imp.engine);
        members.unshift({ engine: imp.engine, name: uniqueName(members, e?.defaultName || imp.sourceLabel), model: '', effort: '', persona: '' });
        const box = $('#nsMembers', dlg);
        const fresh = box.cloneNode(false); // 成员编辑器重新绑定
        box.replaceWith(fresh);
        memberEditor(fresh, members);
      }
      $('#nsImport', dlg).innerHTML = `<div class="field"><div class="imp-pick"><b>${esc(imp.title)}</b><span class="hint">${esc(imp.sourceLabel)} · ${imp.count} 条 · ${wan(imp.chars)}</span>
        <button class="icon-btn" type="button" data-act="drop-import" title="不导入">${ICON.close}</button></div>${importOptionsHtml(imp)}</div>`;
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
      if (wsType === 'folder' && !body.workspace.path) { toast('请先选择文件夹', 'error'); return; }
      if (imp) {
        const { memberId, writerId, ...opts } = readImportOptions($('#nsImport', dlg), imp);
        const topic = opts.mode === 'topic';
        if (topic && !opts.topic) { toast('请填写主题', 'error'); $('#impTopic', dlg).focus(); return; }
        const has = members.some((m) => m.engine === imp.engine);
        if (!has && !topic) { toast(`导入这段对话需要一个 ${imp.sourceLabel} 成员`, 'error'); return; }
        const folder = wsType === 'folder' ? body.workspace.path : '';
        const moved = has && imp.engine === 'claude-code' && imp.cwd && !samePath(folder, imp.cwd) && !(topic && folder && subOf(folder, imp.cwd));
        if (moved && !confirm('共享文件夹和原对话的不同，原对话里的文件路径可能对不上。继续吗？')) return;
        body.import = opts;
      }
      b.disabled = true;
      try {
        const sp = await api('/api/spaces', { method: 'POST', body });
        if (sp.importError) toast(`空间建好了，但对话没导入：${sp.importError}`, 'error');
        dlg.close();
        await refreshSpaces();
        location.hash = `#/space/${sp.id}`;
      } catch (e) { toast(e.message, 'error'); b.disabled = false; }
    }
  });
  dlg.addEventListener('input', (ev) => { if (ev.target.id === 'nsFolder') $('input[name=ws][value=folder]', dlg).checked = true; });
}

async function openSpaceSettings() {
  const sp = state.space;
  if (!sp) return;
  await refreshEngines();
  const members = sp.members.map((m) => ({ ...m }));
  const dlg = showModal(`<div class="modal-inner">
    <div class="modal-head"><h3>空间设置</h3><button class="icon-btn" type="button" data-act="close">${ICON.close}</button></div>
    <div class="modal-body">
      <div class="field"><label>名字</label><input id="ssTitle" maxlength="60" value="${esc(sp.title)}"></div>
      <div class="field"><div class="label">成员</div><div id="ssMembers"></div></div>
      <div class="field"><div class="label">AI 的权限</div><div class="choices">${accessChoices(sp.access)}</div></div>
      <div class="field"><label>每次最多来回几次</label><input id="ssTurns" type="number" min="1" max="30" value="${sp.maxTurns}" style="width:100px"></div>
      <div class="field"><div class="label">共享文件夹</div><span class="cmd">${esc(sp.workspacePath)}</span></div>
    </div>
    <div class="modal-foot"><button class="btn danger" type="button" data-act="delete">删除这个空间</button><span class="grow"></span>
      <button class="btn" type="button" data-act="close">取消</button><button class="btn primary" type="button" data-act="save">保存</button></div>
  </div>`);
  memberEditor($('#ssMembers', dlg), members);
  dlg.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'close') dlg.close();
    if (b.dataset.act === 'save') {
      b.disabled = true;
      try {
        await api(`/api/spaces/${sp.id}`, { method: 'PATCH', body: { title: $('#ssTitle', dlg).value, members, access: $('input[name=access]:checked', dlg).value, maxTurns: $('#ssTurns', dlg).value } });
        dlg.close();
        refreshSpaces();
      } catch (e) { toast(e.message, 'error'); b.disabled = false; }
    }
    if (b.dataset.act === 'delete') {
      const managed = sp.workspace.type === 'managed';
      const ok = confirm(`确定删除「${sp.title}」吗？\n\n聊天记录和改动记录都会删除，无法恢复。\n${managed ? '软件建的共享文件夹（及里面的文件）也会一起删除。' : `你的文件夹 ${sp.workspacePath} 不会被删除。`}`);
      if (!ok) return;
      try {
        await api(`/api/spaces/${sp.id}`, { method: 'DELETE', body: {} });
        dlg.close();
        toast('已删除');
        state.space = null;
        await refreshSpaces();
        location.hash = '#/';
      } catch (e) { toast(e.message, 'error'); }
    }
  });
}

// ---------------- 侧栏 ----------------
async function refreshSpaces() {
  try { state.spaces = await api('/api/spaces'); } catch { /* ignore */ }
  renderSpaceList();
}
let spacesTimer = null;
const refreshSpacesSoon = () => { clearTimeout(spacesTimer); spacesTimer = setTimeout(refreshSpaces, 800); };
// 去掉 Markdown 符号，只留文字（用于一行预览）
const plain = (s) => String(s)
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/(\*\*|__)(.+?)\1/g, '$2')
  .replace(/\*([^*\n]+)\*/g, '$1')
  .replace(/`/g, '')
  .replace(/^\s*(#{1,6}|>|[-*•]|\d+[.)、])\s*/gm, '')
  .replace(/\s+/g, ' ')
  .trim();
function renderSpaceList() {
  const list = $('#spaceList');
  if (!state.spaces.length) { list.innerHTML = '<div class="empty-list">还没有空间</div>'; return; }
  list.innerHTML = state.spaces.map((s) => `
    <a class="space-item ${s.id === state.space?.id ? 'active' : ''}" href="#/space/${s.id}">
      <div class="t">${s.running ? '<span class="live-dot" title="讨论中"></span>' : ''}<span>${esc(s.title)}</span>
        <span class="dots">${s.members.map((m) => `<i style="background:${m.color}"></i>`).join('')}</span></div>
      <div class="p">${s.preview ? `${esc(plain(s.preview))} · ` : ''}${relTime(s.updatedAt)}</div>
    </a>`).join('');
}
$('#newSpaceBtn').addEventListener('click', openNewSpaceModal);
$('#enginesBtn').addEventListener('click', openEnginesModal);

// ---------------- 主题：跟随系统 → 浅色 → 深色 ----------------
const THEMES = { system: '跟随系统', light: '浅色', dark: '深色' };
let theme = 'system';
function applyTheme(t) {
  theme = THEMES[t] ? t : 'system';
  // 桌面版连窗口一起换，页面配色自动跟着走；浏览器里用 data-theme 盖过系统设置
  if (window.desktop?.setTheme) window.desktop.setTheme(theme);
  else {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    store('rt:theme', theme);
  }
  const b = $('#themeBtn');
  b.innerHTML = ICON[theme];
  b.title = `主题：${THEMES[theme]}`;
  b.setAttribute('aria-label', b.title);
}
$('#themeBtn').addEventListener('click', () => {
  const order = Object.keys(THEMES);
  applyTheme(order[(order.indexOf(theme) + 1) % order.length]);
});
$('#welcomeView').addEventListener('click', (e) => {
  if (e.target.closest('[data-act=new]')) openNewSpaceModal();
  else if (e.target.closest('.engine-card')) openEnginesModal();
});
$('#menuBtn').addEventListener('click', () => $('#app').classList.add('nav-open'));
$('#scrim').addEventListener('click', () => $('#app').classList.remove('nav-open'));
$('#sidebar').addEventListener('click', (e) => { if (e.target.closest('a, button')) $('#app').classList.remove('nav-open'); });

// ---------------- 空间视图 ----------------
function closeStream() { if (state.es) { state.es.close(); state.es = null; } }

function showWelcome() {
  closeStream();
  state.space = null;
  $('#spaceView').hidden = true;
  $('#filesPanel').hidden = true;
  $('#welcomeView').hidden = false;
  $('#mobileTitle').textContent = 'Agenda';
  document.title = 'Agenda';
  renderSpaceList();
}

function openSpace(id) {
  closeStream();
  $('#welcomeView').hidden = true;
  $('#spaceView').hidden = false;
  if (state.space?.id !== id) {
    state.space = null;
    $('#messages').innerHTML = '';
    $('#spaceTitle').textContent = '加载中…';
    state.files.view = null;
    state.files.expanded = new Set();
  }
  const es = new EventSource(`/api/spaces/${id}/events`);
  state.es = es;
  es.onmessage = (e) => { try { handleEvent(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) { toast('这个空间不存在或已被删除', 'error'); location.hash = '#/'; }
  };
}

const findMsg = (id) => state.space?.messages.find((m) => m.id === id);
const memberOf = (id) => state.space?.members.find((m) => m.id === id);

function handleEvent(ev) {
  const sp = state.space;
  switch (ev.type) {
    case 'snapshot': {
      const first = !sp || sp.id !== ev.space.id;
      state.space = ev.space;
      if (first) state.view = ev.space.run ? 'task' : 'chat';
      renderSpace();
      if (first) { loadFiles(); loadHistory(); }
      break;
    }
    case 'message':
      if (!sp) return;
      sp.messages.push(ev.message);
      appendMessage(ev.message);
      refreshSpacesSoon();
      break;
    case 'delta': {
      const m = findMsg(ev.id);
      if (!m) return;
      m.text += ev.text;
      scheduleUpdate(m.id);
      break;
    }
    case 'activity': {
      const m = findMsg(ev.id);
      if (!m) return;
      (m.activities ||= []).push(ev.activity);
      scheduleUpdate(m.id);
      break;
    }
    case 'message_done': {
      if (!sp) return;
      const i = sp.messages.findIndex((x) => x.id === ev.message.id);
      if (i >= 0) sp.messages[i] = ev.message; else sp.messages.push(ev.message);
      pending.delete(ev.message.id);
      updateMessage(ev.message);
      if (state.files.view?.type === 'briefdiff' && state.files.view.id === ev.message.id) renderFilesBody();
      refreshSpacesSoon();
      break;
    }
    case 'state':
      if (!sp) return;
      sp.running = ev.running;
      sp.speaking = ev.speaking;
      sp.queue = ev.queue;
      renderHeader();
      renderMembersBar();
      refreshSpacesSoon();
      break;
    case 'files_changed':
      onFilesChanged(ev.changes);
      break;
    case 'run':
      onRunEvent(ev.run);
      break;
    case 'notice':
      toast(ev.text, ev.level);
      break;
  }
}

function renderSpace() {
  const sp = state.space;
  document.title = `${sp.title} · Agenda`;
  $('#mobileTitle').textContent = sp.title;
  $('#spaceTitle').textContent = sp.title;
  renderHeader();
  renderMembersBar();
  const box = $('#messages');
  box.innerHTML = '';
  const shown = sp.messages.filter((m) => !(m.kind === 'ai' && !m.streaming && !m.text && !m.error && !m.passed && !m.changes?.length));
  for (const m of shown) box.insertAdjacentHTML('beforeend', messageHtml(m));
  box.scrollTop = box.scrollHeight;
  renderSpaceList();
  renderFilesPanel();
  applyView();
  checkImports();
}

function renderHeader() {
  const sp = state.space;
  const next = (sp.queue || []).map((id) => memberOf(id)?.name).filter(Boolean);
  const q = $('#queueInfo');
  q.textContent = next.length ? `接下来：${next.slice(0, 5).join(' → ')}` : '';
  q.hidden = !next.length;
  const btns = sp.running
    ? [['stop', '停止'], ...(sp.speaking ? [['skip', '跳过当前']] : [])]
    : [['continue', '继续讨论']];
  const icons = [['files', state.files.open ? '收起文件' : '共享文件', state.files.open], ['import', '导入对话'], ['settings', '设置'], ['export', '导出']];
  $('#spaceActions').innerHTML = btns.map(([a, l]) => `<button type="button" class="btn sm ${a === 'stop' ? 'danger' : ''}" data-act="${a}">${l}</button>`).join('')
    + icons.map(([a, l, on]) => `<button type="button" class="icon-btn ${on ? 'on' : ''}" data-act="${a}" title="${l}" aria-label="${l}">${ICON[a]}</button>`).join('');
}

function renderMembersBar() {
  const sp = state.space;
  const speaking = sp.speaking && findMsg(sp.speaking);
  $('#membersBar').innerHTML = sp.members.map((m) => {
    const e = engineOf(m.engine);
    const ok = !e || e.status?.ready !== false;
    return `<span class="person ${speaking?.memberId === m.id ? 'speaking' : ''} ${ok ? '' : 'off'}" style="--c:${m.color}" data-id="${m.id}"
      title="${esc(m.engineLabel)}${m.model ? ` · ${esc(m.model)}` : ''}\n点一下让 ${esc(m.name)} 现在发言${ok ? '' : `\n⚠ ${esc(e.status?.note || '')}`}">
      ${avatarHtml(m.engine, m.name)}${esc(m.name)}</span>`;
  }).join('');
}

function activitiesHtml(acts, streaming) {
  if (!acts?.length) return '';
  const row = (a) => `<div class="act"><i>${ACT_ICON[a.kind] || ACT_ICON.tool}</i><span title="${esc(a.label)}">${esc(a.label)}</span></div>`;
  if (acts.length <= 5 || streaming) return `<div class="acts">${acts.slice(-5).map(row).join('')}${acts.length > 5 ? `<div class="act"><i></i><span>（共 ${acts.length} 步）</span></div>` : ''}</div>`;
  return `<details class="acts"><summary>${acts.length} 个操作</summary>${acts.map(row).join('')}</details>`;
}

function messageHtml(m) {
  if (m.kind === 'import') return importHtml(m);
  if (m.kind === 'user') {
    return `<div class="msg user" id="m-${m.id}"><span class="avatar me">我</span>
      <div class="msg-main"><div class="msg-head"><span class="n">我</span><span class="m">${clock(m.ts)}</span></div>
      <div class="bubble"><div class="md">${md(m.text)}</div></div></div></div>`;
  }
  const mem = memberOf(m.memberId);
  const color = mem?.color || engineOf(m.engine)?.color || '#888';
  if (m.passed && !m.streaming) {
    return `<div class="pass-line" id="m-${m.id}" style="--c:${color}"><b>${esc(m.name)}</b> 没有补充${m.changes?.length ? `，但修改了 ${m.changes.length} 个文件` : ''}</div>`;
  }
  const meta = [];
  if (m.durationMs) meta.push(`${(m.durationMs / 1000).toFixed(0)} 秒`);
  if (m.model) meta.push(m.model);
  const last = m.activities?.[m.activities.length - 1];
  let body;
  if (m.streaming && !m.text) body = `<span class="typing"><i></i><i></i><i></i>&nbsp;${esc(last ? last.label : '思考中')}</span>`;
  else body = m.text ? `<div class="md ${m.streaming ? 'cursor' : ''}">${md(m.text)}</div>` : '';
  const changes = m.changes?.length ? `<div class="changes">${m.changes.map((c) => `<button type="button" class="change-chip" data-change="${c.id}">${ICON.file}${esc(c.path)} ${c.created ? '<span class="plus">新建</span>' : c.deleted ? '<span class="minus">删除</span>' : `<span class="plus">+${c.added}</span><span class="minus">−${c.removed}</span>`}</button>`).join('')}</div>` : '';
  return `<div class="msg ai ${m.error ? 'error' : ''}" id="m-${m.id}" style="--c:${color}">
    ${avatarHtml(mem?.engine || m.engine, m.name)}
    <div class="msg-main">
      <div class="msg-head"><span class="n">${esc(m.name)}</span><span class="m" title="${esc(meta.join(' · '))}">${clock(m.ts)}</span></div>
      <div class="bubble">${activitiesHtml(m.activities, m.streaming)}${body}
        ${m.interrupted ? '<div class="note">（发言被中断）</div>' : ''}
        ${m.note ? `<div class="note">${esc(m.note)}</div>` : ''}
        ${m.error ? `<div class="err">⚠ ${esc(m.error)}</div>` : ''}${changes}</div>
    </div></div>`;
}

const nearBottom = () => { const b = $('#messages'); return b.scrollHeight - b.scrollTop - b.clientHeight < 140; };
const scrollToBottom = () => { const b = $('#messages'); b.scrollTop = b.scrollHeight; };

function appendMessage(m) {
  const stick = nearBottom() || m.kind === 'user';
  $('#messages').insertAdjacentHTML('beforeend', messageHtml(m));
  if (stick) scrollToBottom();
}
function updateMessage(m) {
  const el = document.getElementById(`m-${m.id}`);
  const stick = nearBottom();
  const hidden = m.kind === 'ai' && !m.streaming && !m.text && !m.error && !m.passed && !m.changes?.length && !m.interrupted;
  if (!el) { if (!hidden) appendMessage(m); return; }
  if (hidden) { el.remove(); return; }
  const open = m.kind === 'import' && el.querySelector('details.imp')?.open; // 导入块更新后保持展开
  el.outerHTML = messageHtml(m);
  if (open) document.querySelector(`#m-${m.id} details.imp`).open = true;
  if (stick) scrollToBottom();
}
const pending = new Set();
let rafId = 0;
function scheduleUpdate(id) {
  pending.add(id);
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    for (const x of pending) { const m = findMsg(x); if (m) updateMessage(m); }
    pending.clear();
  });
}

$('#spaceActions').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || !state.space) return;
  const act = b.dataset.act;
  if (act === 'files') { state.files.open = !state.files.open; store('rt:filesOpen', state.files.open); renderFilesPanel(); renderHeader(); return; }
  if (act === 'settings') { openSpaceSettings(); return; }
  if (act === 'import') { openImportModal(); return; }
  if (act === 'export') { location.href = `/api/spaces/${state.space.id}/export`; return; }
  b.disabled = true;
  try { await api(`/api/spaces/${state.space.id}/control`, { method: 'POST', body: { action: act } }); } catch (err) { toast(err.message, 'error'); b.disabled = false; }
});
$('#membersBar').addEventListener('click', async (e) => {
  const p = e.target.closest('.person');
  if (!p || !state.space) return;
  try { await api(`/api/spaces/${state.space.id}/control`, { method: 'POST', body: { action: 'ask', memberId: p.dataset.id } }); } catch (err) { toast(err.message, 'error'); }
});
$('#messages').addEventListener('click', (e) => {
  const c = e.target.closest('[data-change]');
  if (c) openChange(c.dataset.change);
});

// ---------------- 输入框 ----------------
const input = $('#input');
const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(180, input.scrollHeight + 2)}px`; };
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
});
$('#sendBtn').addEventListener('click', send);
async function send() {
  const text = input.value.trim();
  if (!text || !state.space) return;
  $('#sendBtn').disabled = true;
  try {
    await api(`/api/spaces/${state.space.id}/messages`, { method: 'POST', body: { text } });
    input.value = '';
    autosize();
  } catch (e) { toast(e.message, 'error'); } finally { $('#sendBtn').disabled = false; input.focus(); }
}

// ---------------- 共享文件面板 ----------------
async function loadFiles() {
  if (!state.space) return;
  try {
    const r = await api(`/api/spaces/${state.space.id}/files`);
    state.files.list = r.files;
    state.files.root = r.root;
    state.files.truncated = r.truncated;
  } catch (e) { toast(e.message, 'error'); }
  if (state.files.tab === 'files' && !state.files.view && document.activeElement?.id !== 'newFileName') renderFilesBody();
}
async function loadHistory() {
  if (!state.space) return;
  try { state.files.history = await api(`/api/spaces/${state.space.id}/history`); } catch { state.files.history = []; }
  $('#historyCount').textContent = state.files.history.length || '';
  if (state.files.tab === 'history' && !state.files.view) renderFilesBody();
}

function renderFilesPanel() {
  const panel = $('#filesPanel');
  panel.hidden = !state.space || !state.files.open;
  if (panel.hidden) return;
  $('#filesTitle').title = state.space.workspacePath;
  $('#openFolderBtn').hidden = !state.app.desktop;
  $$('.tab', panel).forEach((t) => t.classList.toggle('active', t.dataset.tab === state.files.tab));
  renderFilesBody();
}

function renderFilesBody() {
  const body = $('#filesBody');
  const v = state.files.view;
  if (v?.type === 'task') return renderTaskDetail(body, v);
  if (v?.type === 'taskdiff') return renderTaskDiff(body, v);
  if (v?.type === 'file') return renderEditor(body, v);
  if (v?.type === 'change') return renderChange(body, v);
  if (v?.type === 'briefdiff') return renderBriefDiff(body, v);
  if (state.files.tab === 'history') {
    const list = state.files.history;
    body.innerHTML = list.length ? `<div class="history-list">${list.map((h) => {
      const mem = state.space.members.find((m) => m.name === h.by);
      const color = h.by === '我' ? 'var(--accent)' : mem?.color || 'var(--muted)';
      const tag = h.undoOf ? '撤销' : h.created ? '新建' : h.deleted ? '删除' : '';
      return `<div class="h-row" data-change="${h.id}" style="--c:${color}">
        <span class="who">${esc(h.by)}</span><span class="hp">${esc(h.path)}</span>
        <span>${tag ? `<span class="badge off">${tag}</span> ` : ''}<span class="plus">+${h.added}</span> <span class="minus">−${h.removed}</span></span>
        <span class="ht">${new Date(h.ts).toLocaleString('zh-CN', { hour12: false })}</span></div>`;
    }).join('')}</div>` : '<div class="empty-files">还没有改动</div>';
    return;
  }
  const files = state.files.list;
  body.innerHTML = `<div class="file-tools"><button class="btn sm" type="button" data-act="new-file">＋ 新建文件</button>
      ${state.files.truncated ? '<span class="hint">文件太多，只显示一部分</span>' : ''}</div>
    ${files.length ? `<div class="file-list">${treeHtml(fileTree(files))}</div>` : '<div class="empty-files">文件夹是空的</div>'}`;
  state.files.flash.clear();
}

// 文件夹树：文件夹在前，名字按自然顺序（9 在 10 前），子文件夹默认收起
const byName = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' }).compare;
function fileTree(list) {
  const root = { dirs: new Map(), files: [] };
  for (const f of list) {
    const parts = f.path.split('/');
    let node = root;
    for (const d of parts.slice(0, -1)) {
      if (!node.dirs.has(d)) node.dirs.set(d, { dirs: new Map(), files: [] });
      node = node.dirs.get(d);
    }
    node.files.push({ ...f, name: parts.at(-1) });
  }
  return root;
}
function treeHtml(node, prefix = '', depth = 0) {
  const dirs = [...node.dirs.keys()].sort(byName).map((name) => {
    const p = `${prefix}${name}/`;
    const open = state.files.expanded.has(p);
    return `<div class="dir-row${open ? ' open' : ''}" data-dir="${esc(p)}" style="--d:${depth}">${ICON.chevron}${ICON.folder}<span class="fp">${esc(name)}</span></div>${open ? treeHtml(node.dirs.get(name), p, depth + 1) : ''}`;
  });
  const files = node.files.sort((a, b) => byName(a.name, b.name)).map((f) => `<div class="file-row${state.files.flash.has(f.path) ? ' flash' : ''}" data-path="${esc(f.path)}" style="--d:${depth}">${ICON.file}<span class="fp">${esc(f.name)}</span><span class="fs">${sizeText(f.size)}</span></div>`);
  return dirs.join('') + files.join('');
}
/** 展开到这个文件所在的文件夹。 */
function revealFile(p) {
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) state.files.expanded.add(`${parts.slice(0, i).join('/')}/`);
}

async function openFile(p) {
  try {
    const r = await api(`/api/spaces/${state.space.id}/file?path=${encodeURIComponent(p)}`);
    state.files.view = { type: 'file', path: p, content: r.content, draft: r.content, preview: /\.md$/i.test(p), stale: false };
    if (!state.files.open) { state.files.open = true; renderHeader(); }
    renderFilesPanel();
  } catch (e) { toast(e.message, 'error'); }
}

function renderEditor(body, v) {
  const dirty = v.draft !== v.content;
  body.innerHTML = `<div class="editor">
    <div class="editor-head"><button class="icon-btn" type="button" data-act="back" title="返回">${ICON.back}</button>
      <span class="ep" title="${esc(v.path)}">${esc(v.path)}${dirty ? ' ●' : ''}</span>
      <button class="btn sm" type="button" data-act="toggle-preview">${v.preview ? '编辑' : '预览'}</button>
      <button class="btn sm primary" type="button" data-act="save-file" ${dirty ? '' : 'disabled'}>保存</button></div>
    ${v.stale ? `<div class="editor-warn">⚠ 这个文件刚被改过了。<button class="btn sm" type="button" data-act="reload-file">载入最新内容</button>${dirty ? '<span class="hint">（会丢掉你没保存的修改）</span>' : ''}</div>` : ''}
    ${v.preview ? `<div class="preview md">${md(v.draft)}</div>` : `<textarea spellcheck="false" id="editorText">${esc(v.draft)}</textarea>`}
  </div>`;
  const ta = $('#editorText', body);
  ta?.addEventListener('input', () => {
    const was = v.draft !== v.content;
    v.draft = ta.value;
    if (was !== (v.draft !== v.content)) {
      $('.ep', body).textContent = v.path + (v.draft !== v.content ? ' ●' : '');
      $('[data-act=save-file]', body).disabled = v.draft === v.content;
    }
  });
  ta?.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); } });
}

async function saveFile() {
  const v = state.files.view;
  if (!v || v.type !== 'file' || v.draft === v.content) return;
  try {
    await api(`/api/spaces/${state.space.id}/file`, { method: 'PUT', body: { path: v.path, content: v.draft } });
    v.content = v.draft;
    v.stale = false;
    toast('已保存');
    renderFilesBody();
  } catch (e) { toast(e.message, 'error'); }
}

async function openChange(id) {
  try {
    const c = await api(`/api/spaces/${state.space.id}/history/${id}`);
    state.files.view = { type: 'change', ...c };
    if (!state.files.open) { state.files.open = true; renderHeader(); }
    renderFilesPanel();
  } catch (e) { toast(e.message, 'error'); }
}

function renderChange(body, c) {
  const undone = state.files.history.some((h) => h.undoOf === c.id);
  const canUndo = !undone && c.current === c.after;
  body.innerHTML = `<div class="diff-view">
    <div class="editor-head"><button class="icon-btn" type="button" data-act="back" title="返回">${ICON.back}</button>
      <span class="ep">${esc(c.by)} ${c.created ? '新建了' : c.deleted ? '删除了' : '修改了'} ${esc(c.path)}</span>
      <button class="btn sm" type="button" data-act="open-file" data-path="${esc(c.path)}" ${c.deleted ? 'disabled' : ''}>打开文件</button>
      <button class="btn sm danger" type="button" data-act="undo" ${undone ? 'disabled' : ''}>${undone ? '已撤销' : '撤销这次改动'}</button></div>
    <div class="hint" style="padding:6px 12px">${new Date(c.ts).toLocaleString('zh-CN', { hour12: false })}${!canUndo && !undone ? ' · 这个文件之后又被改过' : ''}</div>
    <div class="diff">${diffHtml(c.before, c.after)}</div></div>`;
}

async function undoChange(c) {
  try {
    await api(`/api/spaces/${state.space.id}/history/${c.id}/undo`, { method: 'POST', body: {} });
    toast(`已撤销对 ${c.path} 的改动`);
  } catch (e) {
    if (!e.conflict) { toast(e.message, 'error'); return; }
    if (!confirm(`${e.message}\n\n仍然要把 ${c.path} 恢复成这次改动之前的样子吗？之后的修改会丢失（但会留在改动记录里，可以再撤销回来）。`)) return;
    try { await api(`/api/spaces/${state.space.id}/history/${c.id}/undo`, { method: 'POST', body: { force: true } }); toast('已撤销'); } catch (err) { toast(err.message, 'error'); return; }
  }
  await loadHistory();
  openChange(c.id);
}

function onFilesChanged(changes) {
  for (const c of changes) if (!c.deleted) { revealFile(c.path); state.files.flash.add(c.path); }
  loadFiles();
  loadHistory();
  const v = state.files.view;
  if (v?.type === 'file' && changes.some((c) => c.path === v.path)) {
    if (v.draft === v.content) openFile(v.path); // 没有未保存的修改：直接刷新
    else { v.stale = true; renderFilesBody(); }
  }
}

$('#filesPanel').addEventListener('click', async (e) => {
  const tab = e.target.closest('.tab');
  if (tab) { state.files.tab = tab.dataset.tab; state.files.view = null; renderFilesPanel(); return; }
  const dir = e.target.closest('.dir-row');
  if (dir) {
    const p = dir.dataset.dir;
    if (!state.files.expanded.delete(p)) state.files.expanded.add(p);
    renderFilesBody();
    return;
  }
  const row = e.target.closest('.file-row');
  if (row) { openFile(row.dataset.path); return; }
  const h = e.target.closest('.h-row');
  if (h) { openChange(h.dataset.change); return; }
  const ba = e.target.closest('[data-brief-act]');
  if (ba && state.files.view?.type === 'briefdiff') { briefAction(state.files.view.id, ba.dataset.briefAct); return; }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const v = state.files.view;
  switch (b.dataset.act) {
    case 'back':
      if (v?.type === 'file' && v.draft !== v.content && !confirm('有没保存的修改，确定离开吗？')) return;
      state.files.view = null; renderFilesBody(); break;
    case 'toggle-preview': v.preview = !v.preview; renderFilesBody(); break;
    case 'save-file': saveFile(); break;
    case 'reload-file': openFile(v.path); break;
    case 'open-file': state.files.tab = 'files'; openFile(b.dataset.path); break;
    case 'undo': undoChange(v); break;
    case 'new-file': {
      // 桌面版（Electron）不支持 prompt()，就地换成一个输入框
      const tools = b.closest('.file-tools');
      tools.innerHTML = '<input id="newFileName" value="新文档.md" spellcheck="false" placeholder="notes/计划.md">';
      const inp = $('#newFileName', tools);
      let done = false;
      inp.focus();
      inp.setSelectionRange(0, 3);
      inp.addEventListener('keydown', (ev) => {
        if (ev.isComposing || ev.keyCode === 229) return;
        if (ev.key === 'Escape') { done = true; renderFilesBody(); }
        if (ev.key === 'Enter') { ev.preventDefault(); done = true; createFile(inp.value); }
      });
      inp.addEventListener('blur', () => { if (!done) renderFilesBody(); });
      break;
    }
  }
});
async function createFile(name) {
  const p = name.trim();
  if (!p) { renderFilesBody(); return; }
  if (state.files.list.some((f) => f.path === p)) { openFile(p); return; }
  try { await api(`/api/spaces/${state.space.id}/file`, { method: 'PUT', body: { path: p, content: '' } }); openFile(p); } catch (err) { toast(err.message, 'error'); renderFilesBody(); }
}
$('#closeFilesBtn').addEventListener('click', () => { state.files.open = false; store('rt:filesOpen', false); renderFilesPanel(); if (state.space) renderHeader(); });
$('#refreshFilesBtn').addEventListener('click', () => { loadFiles(); loadHistory(); });
$('#openFolderBtn').addEventListener('click', () => api('/api/open-path', { method: 'POST', body: { path: state.space.workspacePath } }).catch((e) => toast(e.message, 'error')));

// ================= 任务协作 =================
const RUN_STATUS = { planning: '规划中', plan_review: '等你确认计划', executing: '执行中', summarizing: '协调者在写总结', done: '已完成', failed: '没有完成规划', cancelled: '已取消' };
const T_STATUS = { pending: '等前置任务', ready: '排队中', running: '进行中', review: '待你审查', approved: '已通过', failed: '失败', blocked: '等你回答', skipped: '已跳过', cancelled: '已取消' };
const CHAT_PLACEHOLDER = '说点什么，@名字 点名';
state.view = 'chat';
let planDraft = null;
const taskChecks = new Map();

const runBlocksChat = (r) => !!r && (r.status === 'planning' || r.status === 'summarizing' || (r.status === 'executing' && r.mode === 'direct'));
const needsUser = (r) => r.status === 'plan_review' || r.paused || r.tasks.some((t) => ['review', 'blocked', 'failed'].includes(t.status)) || (r.status === 'done' && r.mode === 'git' && !r.merged && r.tasks.some((t) => t.status === 'approved'));
const memberName = (id) => memberOf(id)?.name || '（已移除）';
const memberColor = (id) => memberOf(id)?.color || '#888';
const mins = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)} 秒` : `${(ms / 60000).toFixed(1)} 分钟`);

function applyView() {
  const task = state.view === 'task';
  $('#messages').hidden = task;
  $('#taskView').hidden = !task;
  $('#composer').hidden = task;
  $$('#viewSeg button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  if (task) renderTaskView(true);
  updateTaskDot();
  updateComposerLock();
}
function updateTaskDot() {
  const r = state.space?.run;
  const dot = $('#taskDot');
  dot.hidden = !r;
  if (r) dot.className = `seg-dot ${needsUser(r) ? 'wait' : ''}`;
}
function updateComposerLock() {
  const lock = runBlocksChat(state.space?.run);
  $('#composer').classList.toggle('locked', lock);
  input.disabled = lock;
  $('#sendBtn').disabled = lock;
  input.placeholder = lock ? '任务进行中，聊天暂停' : CHAT_PLACEHOLDER;
}
$('#viewSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) { state.view = b.dataset.view; applyView(); }
});

let taskRaf = 0;
function scheduleTaskRender() {
  if (taskRaf) return;
  taskRaf = requestAnimationFrame(() => { taskRaf = 0; if (state.view === 'task') renderTaskView(); updateTaskDot(); updateComposerLock(); });
}
let detailTimer = null;
function onRunEvent(run) {
  const sp = state.space;
  if (!sp) return;
  const prev = sp.run;
  if (run?.closed) run = null;
  if (run && sp.run === null && prev === null && run.status !== 'planning') return; // 迟到的旧推送
  sp.run = run;
  if (run?.status === 'planning') planDraft = null;
  if (run && prev?.status !== run.status && ['plan_review', 'done'].includes(run.status) && state.view !== 'task') toast(run.status === 'plan_review' ? '计划拟好了，请到“任务协作”里确认' : '任务完成了');
  scheduleTaskRender();
  const v = state.files.view;
  if (v?.type === 'task' && !detailTimer) detailTimer = setTimeout(() => { detailTimer = null; refreshTaskDetail(); }, 700);
}

// 重新渲染时保留输入框里没提交的内容与焦点
function keepInputs(root, render) {
  const vals = new Map($$('[data-keep]', root).map((el) => [el.dataset.keep, el.value]));
  const focused = document.activeElement?.dataset?.keep;
  const sel = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  render();
  for (const el of $$('[data-keep]', root)) if (vals.has(el.dataset.keep)) el.value = vals.get(el.dataset.keep);
  if (focused) { const el = $(`[data-keep="${focused}"]`, root); if (el) { el.focus(); try { el.setSelectionRange(...sel); } catch { /* select */ } } }
}

function renderTaskView(force = false) {
  const sp = state.space;
  const box = $('#taskView');
  if (!sp) return;
  const r = sp.run;
  const key = r ? `${r.id}:${r.status}` : 'none';
  // 编辑计划时不要被推送打断
  if (!force && r?.status === 'plan_review' && box.dataset.key === key && planDraft?.runId === r.id) return;
  if (!force && !r && box.dataset.key === key) return;
  box.dataset.key = key;
  keepInputs(box, () => {
    if (!r) box.innerHTML = `<div class="tv-inner">${startFormHtml()}${pastRunsHtml()}</div>`;
    else if (r.status === 'planning' || r.status === 'plan_review' || (r.status === 'failed' && !r.tasks.length)) box.innerHTML = `<div class="tv-inner">${runBarHtml(r)}${planningHtml(r)}</div>`;
    else box.innerHTML = `<div class="tv-inner">${runBarHtml(r)}${boardHtml(r)}${r.summary ? summaryHtml(r) : ''}</div>`;
  });
  if (!r) loadTaskCheck();
}

function startFormHtml() {
  const sp = state.space;
  return `<div class="card">
    <textarea id="tkObjective" data-keep="tk-objective" rows="4" placeholder="要完成什么？例如：给这个项目加上导出 PDF 的功能"></textarea>
    <div class="opts">
      <span class="mode-tag" id="tkMode"></span>
      <label>协调者 <select id="tkCoord">${sp.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></label>
      ${sp.members.length > 1 ? '<label><input type="checkbox" id="tkDiscuss" checked> 先让其他成员审阅计划</label>' : ''}
      <label id="tkParWrap" hidden>最多同时 <input type="number" id="tkPar" min="1" max="6" value="3"> 个</label>
      <label><input type="checkbox" id="tkAuto"> 做完自动通过</label>
    </div>
    <div class="mode-note warn" id="tkDirty" hidden></div>
    <div style="display:flex;justify-content:flex-end"><button class="btn primary" type="button" data-tact="start">开始规划</button></div>
  </div>`;
}

async function loadTaskCheck() {
  const sp = state.space;
  let c = taskChecks.get(sp.id);
  if (!c || Date.now() - c.at > 15000) {
    try { c = { at: Date.now(), v: await api(`/api/spaces/${sp.id}/taskcheck`) }; } catch (e) { c = { at: Date.now(), v: { mode: 'direct', note: e.message } }; }
    taskChecks.set(sp.id, c);
  }
  const el = $('#tkMode');
  if (!el) return;
  const v = c.v;
  const git = v.mode === 'git';
  el.textContent = git ? `并行 · ${v.branch}` : '依次修改';
  el.title = git ? '每个子任务在独立副本里进行，通过审查后合并' : (v.note || '子任务按顺序直接修改共享文件夹');
  $('#tkParWrap').hidden = !git;
  const dirty = $('#tkDirty');
  dirty.hidden = !(git && v.dirty);
  if (git && v.dirty) dirty.textContent = `⚠ 有 ${v.dirtyFiles} 个文件改了还没提交，AI 的副本里看不到，建议先提交`;
}

function pastRunsHtml() {
  const list = state.space.pastRuns || [];
  if (!list.length) return '';
  return `<div class="card past"><h3>以前的任务</h3>${list.map((p) => `<div class="past-row">
    <span class="po">${esc(p.objective.split('\n')[0].slice(0, 80))}</span>
    <span class="st ${p.status === 'done' ? 'approved' : 'cancelled'}">${RUN_STATUS[p.status] || p.status}</span>
    <span class="hint">${p.approved}/${p.tasks} 通过 · ${new Date(p.createdAt).toLocaleDateString('zh-CN')}</span>
    ${p.merged ? `<span class="hint">已合并到 ${esc(p.merged.branch)}</span>` : p.branch ? `<span class="hint">结果保存在分支 <code>${esc(p.branch)}</code></span>` : ''}
  </div>`).join('')}</div>`;
}

function runBarHtml(r) {
  const total = r.tasks.length;
  const ok = r.tasks.filter((t) => t.status === 'approved').length;
  const settled = r.tasks.filter((t) => ['approved', 'skipped', 'cancelled'].includes(t.status)).length;
  const btns = [];
  if (r.paused && r.status === 'executing') btns.push('<button class="btn sm primary" type="button" data-tact="resume">继续执行</button>');
  if (r.status === 'done' && r.mode === 'git' && !r.merged && ok) btns.push(`<button class="btn sm primary" type="button" data-tact="merge">合并到 ${esc(r.git?.baseBranch || '你的分支')}</button>`);
  if (['done', 'cancelled', 'failed'].includes(r.status)) btns.push('<button class="btn sm" type="button" data-tact="close">结束并收起</button>');
  else btns.push('<button class="btn sm danger" type="button" data-tact="cancel">取消任务</button>');
  return `<div class="card"><div class="run-bar">
      <div class="obj"><b>${esc(r.objective.split('\n')[0].slice(0, 100))}</b>
        <span>${RUN_STATUS[r.status] || r.status}${r.paused ? '（已暂停）' : ''}</span></div>
      ${btns.join('')}</div>
    ${total && r.status !== 'plan_review' && r.status !== 'planning' ? `<div class="progress"><i style="width:${Math.round((settled / total) * 100)}%"></i></div>` : ''}
    ${r.error ? `<div class="err">⚠ ${esc(r.error)}</div>` : ''}
    ${r.merged ? `<div class="note">已合并到 ${esc(r.merged.branch)}</div>` : ''}
  </div>`;
}

const planMsgHtml = (m) => messageHtml({ ...m, kind: 'ai', id: `p-${m.id}` });

function planningHtml(r) {
  const msgs = r.planning.messages.map(planMsgHtml).join('');
  if (r.status === 'planning') {
    return `<div class="plan-msgs">${msgs}</div><div class="hint">${esc(memberName(r.coordinatorId))} 正在规划…</div>`;
  }
  if (!r.tasks.length) return `<div class="plan-msgs">${msgs}</div>`;
  if (!planDraft || planDraft.runId !== r.id) planDraft = { runId: r.id, tasks: r.tasks.map((t) => ({ id: t.id, title: t.title, assigneeId: t.assigneeId, deps: [...t.deps], spec: t.spec })) };
  return `<details class="plan-msgs" ${msgs ? '' : 'hidden'}><summary>规划过程（${r.planning.messages.length} 条发言）</summary>${msgs}</details>
    <div class="card plan-edit"><h3>计划</h3>
      <div class="tasks" id="planTasks">${planEditorRows()}</div>
      <button class="btn sm ghost" type="button" data-tact="pe-add" style="margin-top:8px">＋ 添加子任务</button>
    </div>
    <div class="card">
      <textarea data-keep="replan" id="replanText" rows="2" placeholder="不满意？写下意见"></textarea>
      <div class="opts" style="justify-content:flex-end"><button class="btn sm" type="button" data-tact="replan">重新规划</button>
        <button class="btn primary" type="button" data-tact="approve-plan">批准并执行</button></div></div>`;
}

function planEditorRows() {
  const sp = state.space;
  return planDraft.tasks.map((t, i) => `<div class="tcard" style="--c:${memberColor(t.assigneeId)}" data-pi="${i}">
    <div class="pe-row"><span class="tid">${esc(t.id)}</span>
      <input data-pe="title" value="${esc(t.title)}" placeholder="标题">
      <select data-pe="assigneeId">${sp.members.map((m) => `<option value="${m.id}" ${m.id === t.assigneeId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
      <button class="icon-btn" type="button" data-tact="pe-del" title="删除">${ICON.close}</button></div>
    <textarea data-pe="spec" rows="3" placeholder="说明：目标、要改什么、限制、怎样算完成">${esc(t.spec)}</textarea>
    ${planDraft.tasks.length > 1 ? `<div class="deps">依赖：${planDraft.tasks.filter((o) => o.id !== t.id).map((o) => `<label><input type="checkbox" data-dep="${esc(o.id)}" ${t.deps.includes(o.id) ? 'checked' : ''}>${esc(o.id)}</label>`).join('')}</div>` : ''}
  </div>`).join('');
}

const boardHtml = (r) => `<div class="tasks">${r.tasks.map((t) => taskCardHtml(r, t)).join('')}</div>`;

function taskCardHtml(r, t) {
  const a = t.attempts.at(-1);
  let sub = t.deps.length ? `依赖 ${t.deps.join('、')}` : '';
  const add = (s) => { if (s) sub += `${sub ? ' · ' : ''}${s}`; };
  if (t.status === 'running') add(a?.activities?.at(-1)?.label || (a?.text ? a.text.trim().split('\n').at(-1).slice(0, 80) : '思考中…'));
  else if (t.status === 'review' || t.status === 'approved') add(`${(a?.report || '').split('\n')[0].slice(0, 90)}${t.changes?.length ? `（改了 ${t.changes.length} 个文件）` : ''}`);
  else if (t.status === 'failed') add(a?.error || '失败');
  if (t.attempts.length > 1) add(`第 ${t.attempts.length} 次`);
  if (a?.endedAt && a.startedAt) add(mins(a.endedAt - a.startedAt));
  const k = `${r.id}-${t.id}`;
  const acts = [];
  const live = r.status === 'executing';
  if (t.status === 'running') acts.push(`<button class="btn sm" type="button" data-tact="stop-task" data-task="${t.id}">停止</button>`);
  if (t.status === 'review') acts.push(`<button class="btn sm" type="button" data-tact="open" data-task="${t.id}">查看改动并审查</button><button class="btn sm primary" type="button" data-tact="approve-task" data-task="${t.id}">通过</button>`);
  if (t.status === 'failed' && live) acts.push(`<button class="btn sm primary" type="button" data-tact="retry-task" data-task="${t.id}">重试</button>`);
  if (['failed', 'pending', 'ready', 'blocked'].includes(t.status) && live) {
    acts.push(`<button class="btn sm" type="button" data-tact="skip-task" data-task="${t.id}">跳过</button>`);
    acts.push(`<select data-reassign="${t.id}" title="改派给" style="width:auto">${state.space.members.map((m) => `<option value="${m.id}" ${m.id === t.assigneeId ? 'selected' : ''}>负责：${esc(m.name)}</option>`).join('')}</select>`);
  }
  return `<div class="tcard ${state.files.view?.type === 'task' && state.files.view.taskId === t.id ? 'sel' : ''}" data-task="${t.id}" style="--c:${memberColor(t.assigneeId)}">
    <div class="tc-top"><span class="tid">${esc(t.id)}</span><span class="tt">${esc(t.title)}</span><span class="tc-who">@${esc(memberName(t.assigneeId))}</span><span class="st ${t.status}">${T_STATUS[t.status] || t.status}</span></div>
    ${sub ? `<div class="tc-sub">${esc(sub)}</div>` : ''}
    ${t.status === 'blocked' ? `<div class="question"><b>${esc(memberName(t.assigneeId))} 问你：</b>${esc(t.question || '')}</div>
      <div class="tc-actions"><input data-keep="ans-${k}" placeholder="写下回答，它会接着做"><button class="btn sm primary" type="button" data-tact="answer" data-task="${t.id}">回答</button></div>` : ''}
    ${acts.length ? `<div class="tc-actions">${acts.join('')}</div>` : ''}
  </div>`;
}

function summaryHtml(r) {
  const s = r.summary;
  return `<div class="card"><h3>协调者的总结</h3>${s.streaming && !s.text ? '<span class="typing"><i></i><i></i><i></i>&nbsp;正在写</span>' : `<div class="md">${md(s.text || '')}</div>`}${s.error ? `<div class="err">⚠ ${esc(s.error)}</div>` : ''}</div>`;
}

// ---- 子任务详情（右侧面板） ----
async function openTask(taskId) {
  state.files.view = { type: 'task', taskId, detail: null };
  if (!state.files.open) { state.files.open = true; renderHeader(); }
  renderFilesPanel();
  await refreshTaskDetail();
  scheduleTaskRender();
}
async function refreshTaskDetail() {
  const v = state.files.view;
  if (v?.type !== 'task' || !state.space?.run) return;
  try { v.detail = await api(`/api/spaces/${state.space.id}/task/${v.taskId}`); } catch (e) { v.detail = { error: e.message }; }
  if (state.files.view === v) keepInputs($('#filesBody'), () => renderFilesBody());
}
function renderTaskDetail(body, v) {
  const t = v.detail;
  const r = state.space.run;
  if (!t) { body.innerHTML = '<div class="empty-files">加载中…</div>'; return; }
  if (t.error && !t.id) { body.innerHTML = `<div class="empty-files">${esc(t.error)}</div>`; return; }
  const k = `${r?.id}-${t.id}`;
  const changes = (t.changes || []).map((c) => `<div class="chg-row" data-tdiff="${esc(c.path)}">${c.status === 'A' || c.created ? '<span class="fst a">A</span>' : c.status === 'D' || c.deleted ? '<span class="fst d">D</span>' : '<span class="fst">M</span>'}<span class="fp">${esc(c.path)}</span><span class="plus">+${c.added}</span><span class="minus">−${c.removed}</span></div>`).join('');
  const live = r?.status === 'executing';
  const attempts = t.attempts.map((a, i) => ({ a, i })).reverse().map(({ a, i }) => `<div class="attempt">
      <div class="attempt-head"><b>第 ${i + 1} 次</b><span>${new Date(a.startedAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>${a.endedAt ? `<span>${mins(a.endedAt - a.startedAt)}</span>` : '<span class="typing"><i></i><i></i><i></i></span>'}
        ${a.outcome ? `<span class="st ${a.outcome === 'done' ? 'approved' : a.outcome === 'question' ? 'blocked' : 'failed'}">${a.outcome === 'done' ? '报告完成' : a.outcome === 'question' ? '提了问题' : '失败'}</span>` : ''}</div>
      ${a.conflict ? `<div class="note">这次是在解决合并冲突：${esc(a.conflict.join('、'))}</div>` : ''}
      ${activitiesHtml(a.activities, !a.endedAt)}
      ${a.report || a.text ? `<div class="md">${md(a.report || a.text)}</div>` : ''}
      ${a.note ? `<div class="note">${esc(a.note)}</div>` : ''}
      ${a.error ? `<div class="err">⚠ ${esc(a.error)}</div>` : ''}
      ${a.log?.length ? `<details><summary class="hint">原始输出</summary><div class="log">${esc(a.log.join('\n'))}</div></details>` : ''}
    </div>`).join('');
  body.innerHTML = `<div class="editor-head"><button class="icon-btn" type="button" data-act="back" title="返回">${ICON.back}</button>
      <span class="ep">${esc(t.id)} ${esc(t.title)}</span><span class="st ${t.status}">${T_STATUS[t.status]}</span></div>
    <div class="td">
      <div><h4>负责</h4><span style="color:${memberColor(t.assigneeId)};font-weight:600">@${esc(memberName(t.assigneeId))}</span>${t.deps.length ? `　<span class="hint">依赖 ${esc(t.deps.join('、'))}</span>` : ''}</div>
      <div><h4>说明</h4><div class="spec">${esc(t.spec)}</div></div>
      ${t.status === 'review' ? `<div class="review-box"><b>审查</b>
        <textarea data-keep="fb-${k}" id="fbText" rows="3" placeholder="退回时写下要怎么改"></textarea>
        <div class="row"><button class="btn sm primary" type="button" data-tact="approve-task" data-task="${t.id}">通过</button>
          <button class="btn sm" type="button" data-tact="reject-task" data-task="${t.id}">带意见退回重做</button>
          ${r.mode === 'direct' && t.changes?.length ? `<button class="btn sm danger" type="button" data-tact="undo-task" data-task="${t.id}">撤销它的全部改动</button>` : ''}</div></div>` : ''}
      ${t.status === 'blocked' ? `<div class="review-box"><b>${esc(memberName(t.assigneeId))} 问你：</b><div>${esc(t.question || '')}</div>
        <textarea data-keep="ans2-${k}" id="ansText" rows="2" placeholder="写下回答"></textarea><div class="row"><button class="btn sm primary" type="button" data-tact="answer-detail" data-task="${t.id}">回答</button></div></div>` : ''}
      ${t.status === 'failed' && live ? `<div class="row"><button class="btn sm primary" type="button" data-tact="retry-task" data-task="${t.id}">重试</button> <button class="btn sm" type="button" data-tact="skip-task" data-task="${t.id}">跳过</button>${r.mode === 'direct' && t.changes?.length ? ` <button class="btn sm danger" type="button" data-tact="undo-task" data-task="${t.id}">撤销它的改动</button>` : ''}</div>` : ''}
      ${t.feedbacks?.length ? `<div><h4>你的意见</h4>${t.feedbacks.map((f) => `<div class="note">• ${esc(f.text)}</div>`).join('')}</div>` : ''}
      <div><h4>改动（${t.changes?.length || 0} 个文件）${t.undone ? ' · 已撤销' : ''}</h4>${changes || '<div class="hint">还没有改动</div>'}</div>
      <div><h4>过程</h4>${attempts || '<div class="hint">还没开始</div>'}</div>
    </div>`;
}
async function openTaskDiff(taskId, file) {
  try {
    const d = await api(`/api/spaces/${state.space.id}/taskdiff/${taskId}?path=${encodeURIComponent(file)}`);
    state.files.view = { type: 'taskdiff', taskId, ...d };
    renderFilesBody();
  } catch (e) { toast(e.message, 'error'); }
}
function renderTaskDiff(body, v) {
  body.innerHTML = `<div class="diff-view"><div class="editor-head"><button class="icon-btn" type="button" data-tact="back-task" data-task="${esc(v.taskId)}" title="返回">${ICON.back}</button>
    <span class="ep">${esc(v.taskId)} · ${esc(v.path)}</span></div><div class="diff">${diffHtml(v.before, v.after)}</div></div>`;
}

// ---- 操作 ----
const runAction = (action, body = {}) => api(`/api/spaces/${state.space.id}/run/${action}`, { method: 'POST', body });

async function onTaskAction(b, root) {
  const act = b.dataset.tact;
  const taskId = b.dataset.task;
  const sp = state.space;
  try {
    switch (act) {
      case 'start': {
        const objective = $('#tkObjective').value.trim();
        if (!objective) { toast('先写下目标', 'error'); return; }
        b.disabled = true;
        await api(`/api/spaces/${sp.id}/runs`, { method: 'POST', body: { objective, coordinatorId: $('#tkCoord').value, discuss: $('#tkDiscuss')?.checked ?? false, maxParallel: $('#tkPar').value, autoApprove: $('#tkAuto').checked } });
        break;
      }
      case 'pe-add': {
        let n = planDraft.tasks.length + 1;
        while (planDraft.tasks.some((t) => t.id === `T${n}`)) n++;
        planDraft.tasks.push({ id: `T${n}`, title: '', assigneeId: sp.members[0].id, deps: [], spec: '' });
        $('#planTasks').innerHTML = planEditorRows();
        return;
      }
      case 'pe-del': {
        const i = +b.closest('[data-pi]').dataset.pi;
        const [gone] = planDraft.tasks.splice(i, 1);
        for (const t of planDraft.tasks) t.deps = t.deps.filter((d) => d !== gone.id);
        $('#planTasks').innerHTML = planEditorRows();
        return;
      }
      case 'approve-plan':
        if (!planDraft.tasks.length || planDraft.tasks.some((t) => !t.title.trim() || !t.spec.trim())) { toast('每个子任务都要有标题和说明', 'error'); return; }
        b.disabled = true;
        await runAction('approve-plan', { tasks: planDraft.tasks });
        break;
      case 'replan':
        await runAction('replan', { feedback: $('#replanText').value });
        break;
      case 'cancel':
        if (!confirm(`取消这次任务吗？正在做的子任务会被中止。${sp.run.mode === 'git' ? '\n各 AI 的独立副本和临时分支会被删除，你的项目不受影响。' : '\n已经改了的文件不会自动还原（可以在改动记录里撤销）。'}`)) return;
        await runAction('cancel');
        break;
      case 'close':
        await runAction('close');
        if (state.files.view?.type?.startsWith('task')) { state.files.view = null; renderFilesPanel(); }
        break;
      case 'merge': {
        b.disabled = true;
        const m = await runAction('merge');
        toast(`已合并到 ${m.branch}`);
        loadFiles(); loadHistory();
        break;
      }
      case 'open': case 'back-task': openTask(taskId); return;
      case 'answer': {
        const inp = $(`[data-keep="ans-${sp.run.id}-${taskId}"]`, root);
        if (!inp?.value.trim()) { toast('先写下回答', 'error'); return; }
        await runAction('answer', { taskId, answer: inp.value });
        inp.value = '';
        break;
      }
      case 'answer-detail': {
        const inp = $('#ansText');
        if (!inp?.value.trim()) { toast('先写下回答', 'error'); return; }
        await runAction('answer', { taskId, answer: inp.value });
        inp.value = '';
        break;
      }
      case 'reject-task': {
        const inp = $('#fbText');
        if (!inp?.value.trim()) { toast('退回时请写下要怎么改', 'error'); inp?.focus(); return; }
        await runAction('reject-task', { taskId, feedback: inp.value });
        inp.value = '';
        break;
      }
      case 'approve-task': {
        b.disabled = true;
        const res = await runAction('approve-task', { taskId });
        if (res.conflict) toast(`${taskId} 和已通过的改动冲突了（${(res.files || []).join('、')}），已让负责人去解决冲突`, 'error');
        break;
      }
      case 'undo-task':
        if (!confirm('撤销这个子任务对文件做的全部改动吗？')) return;
        await runAction('undo-task', { taskId });
        loadFiles(); loadHistory();
        break;
      default:
        await runAction(act, { taskId });
    }
  } catch (e) {
    toast(e.message, 'error');
    b.disabled = false;
  }
  refreshTaskDetail();
}

$('#taskView').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tact]');
  if (b) { onTaskAction(b, $('#taskView')); return; }
  if (e.target.closest('input, select, textarea, a, summary, details, .plan-edit')) return;
  const card = e.target.closest('.tcard[data-task]');
  if (card) openTask(card.dataset.task);
});
$('#taskView').addEventListener('input', (e) => {
  const row = e.target.closest('[data-pi]');
  if (!row || !planDraft) return;
  const t = planDraft.tasks[+row.dataset.pi];
  if (e.target.dataset.pe) {
    t[e.target.dataset.pe] = e.target.value;
    if (e.target.dataset.pe === 'assigneeId') row.style.setProperty('--c', memberColor(t.assigneeId));
  }
  if (e.target.dataset.dep) t.deps = $$('[data-dep]', row).filter((x) => x.checked).map((x) => x.dataset.dep);
});
$('#taskView').addEventListener('change', async (e) => {
  const s = e.target.closest('[data-reassign]');
  if (!s) return;
  try { await runAction('reassign', { taskId: s.dataset.reassign, memberId: s.value }); } catch (err) { toast(err.message, 'error'); }
});
$('#filesBody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tact]');
  if (b) { e.stopPropagation(); onTaskAction(b, $('#filesBody')); return; }
  const d = e.target.closest('[data-tdiff]');
  if (d && state.files.view?.type === 'task') { e.stopPropagation(); openTaskDiff(state.files.view.taskId, d.dataset.tdiff); }
}, true);

// ---------------- 导入外部 AI 对话 ----------------
const MODE_LABEL = { full: '全部原文', from: '从某一条开始', summary: '早期压成摘要', handoff: '写交接文档', topic: '按主题' };
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\s]+/g, ' ').trim().slice(0, 40);
const samePath = (a, b) => !!a && !!b && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
const folderName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
const wan = (n) => (n < 10000 ? `${n} 字` : `${(n / 10000).toFixed(1)} 万字`);
const importNew = {}; // 导入块 id -> 原对话里的新条数

/** 选一段对话。cwd：当前空间的共享文件夹，默认只列同文件夹的。 */
function openSessionPicker({ cwd } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal picker';
    dlg.innerHTML = `<div class="modal-inner">
      <div class="modal-head"><h3>选择对话</h3><button class="icon-btn" type="button" data-act="close">${ICON.close}</button></div>
      <div class="picker-bar"><input id="pkQ" placeholder="搜索"><div class="seg" id="pkScope" hidden>
        <button type="button" data-scope="here">同文件夹</button><button type="button" data-scope="all">全部</button></div></div>
      <div class="modal-body picker-list" id="pkList"><span class="typing"><i></i><i></i><i></i></span></div></div>`;
    document.body.appendChild(dlg);
    let result = null;
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    dlg.showModal();

    let all = [];
    let scope = 'all';
    const render = () => {
      const q = $('#pkQ', dlg).value.trim().toLowerCase();
      const list = all.filter((s) => (scope === 'all' || samePath(s.cwd, cwd)) && (!q || `${s.title} ${s.cwd}`.toLowerCase().includes(q))).slice(0, 200);
      $$('#pkScope button', dlg).forEach((b) => b.classList.toggle('active', b.dataset.scope === scope));
      $('#pkList', dlg).innerHTML = list.length ? list.map((s) => `<button type="button" class="pk-row" data-id="${esc(s.id)}" data-source="${esc(s.source)}" style="--c:${engineOf(s.engine)?.color || '#999'}">
          <b>${esc(s.title)}</b><span><i></i>${esc(s.sourceLabel)} · ${esc(folderName(s.cwd))} · ${relTime(s.updatedAt)}</span></button>`).join('')
        : '<div class="empty-list">没有对话</div>';
    };
    dlg.addEventListener('input', render);
    dlg.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-act=close]')) { dlg.close(); return; }
      const sc = ev.target.closest('[data-scope]');
      if (sc) { scope = sc.dataset.scope; render(); return; }
      const row = ev.target.closest('.pk-row');
      if (row) { result = all.find((s) => s.id === row.dataset.id && s.source === row.dataset.source); dlg.close(); }
    });
    api('/api/import/sessions').then((list) => {
      all = list;
      if (cwd && all.some((s) => samePath(s.cwd, cwd))) { scope = 'here'; $('#pkScope', dlg).hidden = false; }
      render();
      $('#pkQ', dlg).focus();
    }).catch((e) => { $('#pkList', dlg).innerHTML = `<div class="err">${esc(e.message)}</div>`; });
  });
}

/** 导入方式（以及已有空间里的对应成员、由谁整理）。members 不给表示新建空间。 */
function importOptionsHtml(d, { members = null, cwd = '' } = {}) {
  const claude = d.engine === 'claude-code';
  const modes = Object.keys(MODE_LABEL).map((k) => `<label class="choice"><input type="radio" name="impMode" value="${k}" ${k === d.auto ? 'checked' : ''}>
    <span><b>${MODE_LABEL[k]}</b>${k === 'from' ? `<select id="impFrom">${d.starts.map((s) => `<option value="${s.i}">${esc(s.text)}</option>`).join('')}</select>` : ''}${k === 'topic' ? '<input id="impTopic" maxlength="40" placeholder="例如：剧本">' : ''}</span></label>`).join('');
  let extra = '';
  if (members) {
    const busy = (m) => claude && !!state.space?.memberState?.[m.id]?.importId;
    const same = members.filter((m) => m.engine === d.engine && !busy(m));
    const label = engineOf(d.engine)?.defaultName || d.sourceLabel;
    extra += `<div class="field"><div class="label">对应成员</div><select id="impMember">${same.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}<option value="">新加一个 ${esc(label)}</option><option value="none">不加</option></select></div>`;
    const others = [...members.filter((m) => m.engine !== d.engine), ...members.filter((m) => m.engine === d.engine)];
    if (others.length) extra += `<div class="field" id="impWriterRow" data-claude="${claude ? 1 : ''}"><div class="label">由谁整理</div><select id="impWriter">${others.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></div>`;
  }
  const warn = members && claude && d.cwd && !samePath(d.cwd, cwd)
    ? `<div class="note warn">原对话在 ${esc(d.cwd)}，和共享文件夹不同，原对话里的文件路径可能对不上。</div>` : '';
  return `<div class="field"><div class="choices">${modes}</div></div>${extra}${warn}`;
}

function bindImportOptions(root, onChange) {
  const sync = () => {
    const mode = $('input[name=impMode]:checked', root)?.value;
    const topic = mode === 'topic';
    const sel = $('#impMember', root);
    const none = sel && $('option[value=none]', sel);
    if (none) {
      none.hidden = none.disabled = !topic; // “不加”只在按主题时可选
      if (!topic && sel.value === 'none') sel.selectedIndex = 0;
    }
    const w = $('#impWriterRow', root);
    // Claude 接续时由它自己整理；不加它（按主题）时才要选
    if (w) w.hidden = w.dataset.claude ? !(topic && sel?.value === 'none') : !(mode === 'summary' || mode === 'handoff' || topic);
    onChange?.();
  };
  root.addEventListener('change', (e) => {
    if (e.target.id === 'impFrom') $('input[name=impMode][value=from]', root).checked = true;
    sync();
  });
  root.addEventListener('focusin', (e) => {
    if (e.target.id !== 'impTopic') return;
    $('input[name=impMode][value=topic]', root).checked = true;
    sync();
  });
  root.addEventListener('input', (e) => { if (e.target.id === 'impTopic') onChange?.(); });
  sync();
}

function readImportOptions(root, d) {
  const mode = $('input[name=impMode]:checked', root).value;
  return {
    source: d.source,
    sessionId: d.id,
    mode,
    fromIndex: mode === 'from' ? $('#impFrom', root).value : undefined,
    topic: mode === 'topic' ? $('#impTopic', root).value.trim() : undefined,
    memberId: $('#impMember', root)?.value ?? '',
    writerId: $('#impWriter', root)?.value,
  };
}

async function openImportModal() {
  const sp = state.space;
  if (!sp) return;
  await refreshEngines();
  const s = await openSessionPicker({ cwd: sp.workspacePath });
  if (!s) return;
  let d;
  try { d = await api(`/api/import/session?source=${s.source}&id=${encodeURIComponent(s.id)}`); } catch (e) { toast(e.message, 'error'); return; }
  const dlg = showModal(`<div class="modal-inner">
    <div class="modal-head"><h3>${esc(d.title)}</h3><button class="icon-btn" type="button" data-act="close">${ICON.close}</button></div>
    <div class="modal-body"><div class="hint imp-stat">${esc(d.sourceLabel)} · ${d.count} 条 · ${wan(d.chars)}</div>
      ${importOptionsHtml(d, { members: sp.members, cwd: sp.workspacePath })}</div>
    <div class="modal-foot"><button class="btn" type="button" data-act="close">取消</button><button class="btn primary" type="button" data-act="go">导入</button></div>
  </div>`);
  bindImportOptions(dlg);
  dlg.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'close') dlg.close();
    if (b.dataset.act === 'go') {
      const opts = readImportOptions(dlg, d);
      if (opts.mode === 'topic' && !opts.topic) { toast('请填写主题', 'error'); $('#impTopic', dlg).focus(); return; }
      b.disabled = true;
      try {
        await api(`/api/spaces/${sp.id}/imports`, { method: 'POST', body: opts });
        dlg.close();
      } catch (e) { toast(e.message, 'error'); b.disabled = false; }
    }
  });
}

const ACT_KIND = [[/^读取/, 'read'], [/^(修改|写入|新建|删除)/, 'edit'], [/^(搜索|打开网页)/, 'search'], [/^运行/, 'command']];
const actKind = (label) => ACT_KIND.find(([re]) => re.test(label))?.[1] || 'tool';

function importHtml(m) {
  const color = memberOf(m.memberId)?.color || engineOf(m.source)?.color || '#888';
  const fresh = !m.parentId && m.status === 'ready' && importNew[m.id];
  const topic = m.mode === 'topic';
  const pend = m.briefPending;
  const foot = [
    m.status === 'writing' ? '<span class="typing"><i></i><i></i><i></i>&nbsp;正在整理</span>' : '',
    pend ? `<span class="imp-pend">${briefChange(pend)}</span>
      <button type="button" class="btn sm" data-imp="diff" data-id="${m.id}">看对比</button>
      <button type="button" class="btn sm primary" data-imp="accept" data-id="${m.id}">采用</button>
      <button type="button" class="btn sm" data-imp="revert" data-id="${m.id}">撤销</button>` : '',
    topic && m.brief && m.briefText == null && m.status === 'ready' ? '<span class="hint">简报文件已删除</span>' : '',
    fresh && !pend ? `<button type="button" class="btn sm" data-imp="refresh" data-id="${m.id}">补导 ${importNew[m.id]} 条新内容</button>` : '',
    m.error ? `<span class="err">${esc(m.error)}</span><button type="button" class="btn sm" data-imp="retry" data-id="${m.id}" data-mode="${m.mode}">重试</button>` : '',
  ].join('');
  const head = topic
    ? `<span class="imp-src">主题</span><b>${esc(m.topic)}</b><span class="m">${esc(m.sourceLabel)} · ${m.total} 条 · ${clock(m.ts)}</span>`
    : `<span class="imp-src">${esc(m.parentId ? '补导' : m.sourceLabel)}</span><b>${esc(m.title)}</b><span class="m">${m.parentId ? m.entries.length : m.total} 条 · ${clock(m.ts)}</span>`;
  return `<div class="msg import" id="m-${m.id}" style="--c:${color}">
    <details class="imp" data-import="${m.id}">
      <summary>${head}</summary>
      <div class="imp-body"></div>
    </details>${foot ? `<div class="imp-foot">${foot}</div>` : ''}
  </div>`;
}

function entriesHtml(m) {
  return m.entries.map((e) => {
    const acts = e.acts.map((label) => ({ kind: actKind(label), label }));
    return `<div class="imp-e ${e.role}"><div class="n">${e.role === 'user' ? '我' : esc(m.name)}</div>${activitiesHtml(acts, false)}${e.text ? `<div class="md">${md(e.text)}</div>` : ''}</div>`;
  }).join('');
}

function importBodyHtml(m) {
  if (m.mode === 'topic') {
    const parts = [];
    if (m.brief) parts.push(`<button type="button" class="change-chip" data-open-file="${esc(m.brief)}">${ICON.file}${esc(m.brief)}</button>`);
    if (m.briefText) parts.push(`<div class="imp-summary md">${md(m.briefText)}</div>`);
    parts.push(`<details class="imp-raw" data-raw="${m.id}"><summary>原对话「${esc(m.title)}」· ${m.total} 条</summary><div></div></details>`);
    return parts.join('');
  }
  const parts = [];
  if (m.summary) parts.push(`<div class="imp-summary md">${md(m.summary)}</div>`);
  if (m.handoff) parts.push(`<button type="button" class="change-chip" data-open-file="${esc(m.handoff)}">${ICON.file}${esc(m.handoff)}</button>`);
  if (m.skipped && !m.summary && !m.handoff && m.status !== 'writing') parts.push(`<div class="note">前面 ${m.skipped} 条没有导入</div>`);
  return parts.join('') + entriesHtml(m);
}

/** 打开空间后，看看导入的原对话有没有新内容。 */
function checkImports() {
  const sp = state.space;
  for (const m of sp.messages) {
    if (m.kind !== 'import' || m.parentId || m.status !== 'ready') continue;
    api(`/api/spaces/${sp.id}/imports/${m.id}/check`).then((r) => {
      if (state.space !== sp) return;
      const n = r.newCount || 0;
      if ((importNew[m.id] || 0) === n) return;
      importNew[m.id] = n;
      updateMessage(m);
    }).catch(() => {});
  }
}

const briefChange = (p) => `${p.by === '外部修改' ? '有人在软件外' : `${esc(p.by)} `}${p.after == null ? '删除' : '改'}了简报`;

async function briefAction(id, action) {
  try { await api(`/api/spaces/${state.space.id}/imports/${id}/brief`, { method: 'POST', body: { action } }); } catch (e) { toast(e.message, 'error'); }
}

function openBriefDiff(id) {
  state.files.view = { type: 'briefdiff', id };
  if (!state.files.open) { state.files.open = true; store('rt:filesOpen', true); renderHeader(); }
  renderFilesPanel();
}

/** 简报上待确认的修改：确认过的版本 → 文件现在的内容。 */
function renderBriefDiff(body, v) {
  const m = findMsg(v.id);
  const p = m?.briefPending;
  if (!p) { state.files.view = null; renderFilesBody(); return; } // 采用或撤销后回到文件列表
  body.innerHTML = `<div class="diff-view">
    <div class="editor-head"><button class="icon-btn" type="button" data-act="back" title="返回">${ICON.back}</button>
      <span class="ep">${briefChange(p)} · ${esc(m.brief)}</span>
      <button class="btn sm primary" type="button" data-brief-act="accept">采用</button><button class="btn sm" type="button" data-brief-act="revert">撤销</button></div>
    <div class="diff">${diffHtml(m.briefText, p.after ?? '')}</div></div>`;
}

function openSharedFile(p) {
  state.files.open = true;
  store('rt:filesOpen', true);
  state.files.tab = 'files';
  renderFilesPanel();
  renderHeader();
  openFile(p);
}

// 展开时才渲染内容（长对话有几百条）
$('#messages').addEventListener('toggle', (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.open) return;
  if (d.dataset.raw) { const m = findMsg(d.dataset.raw); if (m) d.lastElementChild.innerHTML = entriesHtml(m); return; }
  if (!d.dataset.import) return;
  const m = findMsg(d.dataset.import);
  if (m) $('.imp-body', d).innerHTML = importBodyHtml(m);
}, true);

$('#messages').addEventListener('click', async (e) => {
  const f = e.target.closest('[data-open-file]');
  if (f) { openSharedFile(f.dataset.openFile); return; }
  const b = e.target.closest('[data-imp]');
  if (!b || !state.space) return;
  if (b.dataset.imp === 'diff') { openBriefDiff(b.dataset.id); return; }
  if (b.dataset.imp === 'accept' || b.dataset.imp === 'revert') { briefAction(b.dataset.id, b.dataset.imp); return; }
  const base = `/api/spaces/${state.space.id}/imports/${b.dataset.id}`;
  b.disabled = true;
  try {
    if (b.dataset.imp === 'refresh') {
      const r = await api(`${base}/refresh`, { method: 'POST', body: {} });
      delete importNew[b.dataset.id];
      const m = findMsg(b.dataset.id);
      if (m) updateMessage(m);
      if (r.grown && confirm('导入的内容已经变长，要重新压缩吗？')) await api(`${base}/recompress`, { method: 'POST', body: {} });
    } else if (b.dataset.imp === 'retry') {
      await api(`${base}/recompress`, { method: 'POST', body: { mode: b.dataset.mode } });
    }
  } catch (err) { toast(err.message, 'error'); b.disabled = false; }
});

// ---------------- 路由与启动 ----------------
function route() {
  const m = location.hash.match(/^#\/space\/([a-f0-9-]{36})/i);
  if (m) openSpace(m[1]);
  else if (state.spaces.length && !location.hash) location.hash = `#/space/${state.spaces[0].id}`;
  else showWelcome();
}
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => {
  const v = state.files.view;
  if (v?.type === 'file' && v.draft !== v.content) { e.preventDefault(); e.returnValue = ''; }
});
setInterval(renderSpaceList, 60_000);

(async () => {
  try { state.app = await api('/api/app'); } catch { state.app = {}; }
  $('#mockTag').hidden = !state.app.mock;
  applyTheme(window.desktop?.getTheme ? await window.desktop.getTheme() : load('rt:theme'));
  await Promise.all([refreshEngines(), refreshSpaces()]);
  route();
})();
