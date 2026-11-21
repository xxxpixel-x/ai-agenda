// 工具：DOM、转义、请求、提示、弹窗、图标、全局状态
import { t as tr, getLanguage, initLanguage, translatePage, localizeActivity } from '../i18n.js';

export { tr, getLanguage, localizeActivity };

export const appInfo = await initLanguage();
translatePage();

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const authorName = (name) => ['我', '外部修改'].includes(name) ? tr(name) : name;
const initial = (name) => [...(name || '?')][0];

export const ACCESS = {
  read: { label: tr('只读'), desc: tr('只能阅读，不能修改') },
  edit: { label: tr('可改文件'), desc: tr('可以阅读和修改文件') },
  run: { label: tr('可运行命令'), desc: tr('还能运行命令，每条命令先问你') },
  full: { label: tr('全部权限'), desc: tr('不受限制，可以动电脑上任何地方') },
};
const svg = (d, z = 16) => `<svg viewBox="0 0 24 24" width="${z}" height="${z}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICON = {
  context: svg('<path d="m3 7 9-4 9 4-9 4zM3 12l9 4 9-4M3 17l9 4 9-4"/>'),
  memory: svg('<path d="M6 4h12a1 1 0 0 1 1 1v16l-7-4-7 4V5a1 1 0 0 1 1-1zM9 8h6M9 11h4"/>'),
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
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  // 空间的两类：聊天（对话气泡）、任务（勾选清单）
  chat: svg('<path d="M20 12a7 7 0 0 1-10.4 6.1L4 20l1.9-5.1A7 7 0 1 1 20 12z"/>'),
  task: svg('<path d="M10 6h10M10 12h10M10 18h10"/><path d="M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11"/><circle cx="5" cy="18" r="1.2"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 14),
  alert: svg('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.2v.1"/>', 14),
  transfer: svg('<path d="M4 7h11M11 3l4 4-4 4"/><path d="M20 17H9M13 13l-4 4 4 4"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 14),
  stop: svg('<rect x="7" y="7" width="10" height="10" rx="1.5"/>', 14),
  collapse: svg('<path d="M6 15l6-6 6 6"/>', 14),
  expand: svg('<path d="M6 9l6 6 6-6"/>', 14),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  library: svg('<path d="M5 4h4v16H5zM11 4h4v16h-4z"/><path d="M17.2 4.6l3.6 1 -3.9 14.8-3.6-1z"/>'),
  panel: svg('<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M14.5 5v14"/>'),
  external: svg('<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>'),
  refresh: svg('<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/>'),
  plug: svg('<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>'),
};
/** Agenda 的小脸（public/brand）：'thinking' 是它自己在忙（协调者规划、整理导入），'empty' 是空状态。AI 成员思考时用粒子，不用它。 */
export const mascot = (kind, size = 20) => `<img class="mascot" src="/brand/agenda-${kind}.svg" width="${size}" height="${size}" alt="">`;
/** 空状态：小脸加一句话。 */
export const emptyHtml = (text, cls = 'empty-files') => `<div class="${cls} empty">${mascot('empty', 40)}<span>${esc(text)}</span></div>`;
/** 出错 / 需要注意的提示：小三角图标加文字（不用 ⚠ 字符）。 */
export const errHtml = (text) => `<div class="err">${ICON.alert}<span>${esc(text)}</span></div>`;
export const ACT_ICON = {
  read: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', 13),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>', 13),
  search: svg('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>', 13),
  command: svg('<path d="M5 7l5 5-5 5M12 17h7"/>', 13),
  tool: svg('<circle cx="12" cy="12" r="2.5"/>', 13),
};

export const state = {
  app: appInfo,
  engines: [],        // [{ id, label, color, models, efforts, freeModel, status }]
  spaces: [],
  space: null,        // 当前空间（完整数据）
  es: null,
  // 右侧栏里文件 / 改动 / 计划三个面板各有一个「正在看的详情」（打开的文件、某次改动、子任务……），
  // 切面板不丢；state.files.view 读写的是当前面板（panel）的那一个，写入时按类型放回所属面板
  files: { panel: 'files', views: {}, list: [], root: '', history: [], expanded: new Set(), flash: new Set() },
};
export const VIEW_PANEL = { file: 'files', change: 'changes', briefdiff: 'changes', task: 'plan', taskdiff: 'plan' };
Object.defineProperty(state.files, 'view', {
  get() { return this.views[this.panel] ?? null; },
  set(v) { this.views[(v && VIEW_PANEL[v.type]) || this.panel] = v || null; },
});

// ---------------- 工具 ----------------
export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error || tr('请求失败（{0}）', [res.status])), { status: res.status, conflict: data?.conflict, data });
  return data;
}
export function toast(text, level = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), level === 'error' ? 10000 : 3500);
}
export function store(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch { return false; } }
export function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
export function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return tr('刚刚');
  if (s < 3600) return tr('{0} 分钟前', [Math.floor(s / 60)]);
  if (s < 86400) return tr('{0} 小时前', [Math.floor(s / 3600)]);
  return new Date(ts).toLocaleDateString(getLanguage());
}
export const clock = (ts) => new Date(ts).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit', hour12: false });
export const sizeText = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const engineOf = (id) => state.engines.find((e) => e.id === id);
// 没装就不出现的 AI（Gemini CLI）。已经在用它的成员照常显示。
export const shownEngines = () => state.engines.filter((e) => !e.hideWhenMissing || e.status?.available);

// 各 AI 的图标（public/icons）。单色的跟随文字颜色，用遮罩画；彩色的直接用图片。
const MONO_LOGO = new Set(['codex', 'openai', 'ollama', 'kimi']);
const LOGO_HINT = [[/deepseek/i, 'deepseek'], [/qwen|dashscope|通义|千问/i, 'qwen'], [/kimi|moonshot/i, 'kimi'], [/zhipu|bigmodel|智谱|glm/i, 'zhipu'],
  [/ollama|:11434/i, 'ollama'], [/claude|anthropic/i, 'claude'], [/gemini/i, 'gemini'], [/openai|gpt/i, 'openai']];
function logoKey(engineId, hint = '', model = '') {
  const e = engineOf(engineId);
  if (e?.logo) return e.logo;
  const match = (text) => LOGO_HINT.find(([re]) => re.test(text))?.[1];
  // 中转站一个接口里有各家模型，先看模型名，再看接口名
  return (model && match(model)) || match(`${hint} ${e?.label || ''}`) || null;
}
const logoHtml = (k) => (MONO_LOGO.has(k) ? `<i class="logo mono" style="--logo:url(/icons/${k}.svg)"></i>` : `<img class="logo" src="/icons/${k}.svg" alt="">`);
/** 成员头像：有图标用图标（没选模型就按接口默认模型认），没有就用名字的第一个字。 */
export function avatarHtml(engineId, name, model) {
  const k = logoKey(engineId, '', model || engineOf(engineId)?.status?.defaultModel);
  return k ? `<span class="avatar has-logo">${logoHtml(k)}</span>` : `<span class="avatar">${esc(initial(name))}</span>`;
}
/** 连接列表里的小标记：有图标用图标，没有就用颜色圆点。 */
export function markHtml(engineId, color, hint) {
  const k = logoKey(engineId, hint);
  return k ? logoHtml(k) : `<span class="swatch" style="--c:${color}"></span>`;
}

// 简洁、安全的 Markdown 渲染（先转义再加格式）
export function md(src) {
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
    if ((m = line.match(/^\s*(`{3,})/))) {
      flush();
      const buf = [];
      const close = new RegExp('^\\s*`{' + m[1].length + ',}\\s*$');
      i++;
      while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++]);
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
export function diffHtml(before, after, options) {
  const lines = diffLines(before, after);
  const annotations = options?.annotations?.(lines);
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => { if (l.type !== 'same') for (let k = Math.max(0, i - 3); k <= Math.min(lines.length - 1, i + 3); k++) keep[k] = true; });
  let html = '';
  let gap = 0;
  lines.forEach((l, i) => {
    if (!keep[i]) { gap++; return; }
    if (gap) { html += `<div class="dl gap">${tr('… 省略 {0} 行未改动 …', [gap])}</div>`; gap = 0; }
    const no = l.type === 'add' ? `+${l.nb}` : l.type === 'del' ? `-${l.na}` : l.nb;
    const data = options ? ` data-index="${i}" data-type="${l.type}" data-old="${l.na ?? ''}" data-new="${l.nb ?? ''}"` : '';
    const marked = annotations?.marked.has(i) ? ' noted' : '';
    html += `<div class="dl ${l.type}${marked}"${data}><span class="no">${no}</span><span>${esc(l.t) || ' '}</span></div>`;
    for (const note of annotations?.ending.get(i) || []) html += options.renderNote(note);
  });
  if (gap) html += `<div class="dl gap">${tr('… 省略 {0} 行未改动 …', [gap])}</div>`;
  return html || `<div class="empty-files">${tr('没有差异')}</div>`;
}

