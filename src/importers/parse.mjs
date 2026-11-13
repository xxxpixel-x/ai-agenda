// 把粘贴的文字或选择的文件整理成对话：parseImport(buffer 或文字, 文件名) -> [{ title, sourceLabel, entries }]
// 认得这几种：
//   ChatGPT 导出（conversations.json，或整个导出的 .zip）
//   Claude.ai 导出（conversations.json / .zip）
//   Google Takeout 里的 Gemini 活动记录（MyActivity.json / .zip，按天分成一段段）—— 按公开说明写的，没拿真实导出验证过
//   通用 JSON / JSONL：消息数组 [{ role, content }]，或 { messages: [...] }
//   文字和 Markdown：按「You said:」「ChatGPT said:」「## User」「我：」「豆包：」这类说话人标记切开；认不出就整段作一条
import zlib from 'node:zlib';
import { brief, toTs } from './common.mjs';

// ---------- 文字 ----------

const USER_NAMES = ['you', 'user', 'me', 'human', 'i', 'prompt', 'question', '我', '用户', '你', '提问', '问题', '问'];
const AI_NAMES = ['assistant', 'ai', 'bot', 'model', 'answer', 'response', 'chatgpt', 'gpt', 'gemini', 'bard', 'claude', 'deepseek', 'kimi',
  'copilot', 'grok', 'perplexity', 'qwen', 'glm', 'chatglm', 'mistral', 'llama', 'doubao', 'yuanbao',
  '助手', '回答', '答', '豆包', '元宝', '腾讯元宝', '通义', '通义千问', '千问', '文心', '文心一言', '智谱', '智谱清言', '讯飞星火', '星火', '海螺', '秘塔'];
const DISPLAY = { chatgpt: 'ChatGPT', gpt: 'ChatGPT', gemini: 'Gemini', bard: 'Gemini', claude: 'Claude', deepseek: 'DeepSeek', kimi: 'Kimi',
  copilot: 'Copilot', grok: 'Grok', perplexity: 'Perplexity', qwen: '通义千问', glm: '智谱清言', chatglm: '智谱清言', doubao: '豆包', yuanbao: '元宝' };

// 一行里的说话人标记：「## User」「**ChatGPT:**」「You said:」「Gemini said」「我：」「User: 你好」
const MARK = /^\s{0,3}(?:#{1,6}\s*)?(?:\*\*|__)?\s*([^\s:：*_#][^:：*_\n]{0,23}?)\s*(?:\*\*|__)?\s*(?:[:：]\s*(?:\*\*|__)?|(?:\*\*|__)?\s*$)(.*)$/;

function roleOf(label) {
  const l = label.trim().toLowerCase().replace(/\s+/g, ' ');
  const said = l.match(/^(.+?) (?:said|says|wrote)$/);
  const name = said ? said[1] : l;
  if (USER_NAMES.includes(name)) return { role: 'user' };
  if (AI_NAMES.includes(name)) return { role: 'ai', name: DISPLAY[name] || label.trim().replace(/ (said|says|wrote)$/i, '') };
  if (said) return { role: 'ai', name: label.trim().replace(/ (said|says|wrote)$/i, '') };
  return null;
}

function parseText(text, fileTitle) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const marks = [];
  lines.forEach((line, i) => {
    if (line.length > 60 && !/[:：]/.test(line.slice(0, 30))) return;
    const m = line.match(MARK);
    const r = m && roleOf(m[1]);
    if (r) marks.push({ i, ...r, rest: m[2].trim() });
  });
  // 至少要有你和 AI 各一处标记，才算认出来了；否则整段作一条
  if (!marks.some((m) => m.role === 'user') || !marks.some((m) => m.role === 'ai')) {
    const t = text.trim();
    return t ? [{ title: fileTitle || brief(t, 40), sourceLabel: '', entries: [{ key: '0', role: 'ai', text: t, acts: [], ts: 0 }] }] : [];
  }
  const entries = [];
  marks.forEach((m, k) => {
    const body = [m.rest, ...lines.slice(m.i + 1, marks[k + 1]?.i ?? lines.length)].join('\n').trim();
    if (!body) return;
    const prev = entries.at(-1);
    if (prev?.role === m.role) prev.text += `\n\n${body}`;
    else entries.push({ key: String(entries.length), role: m.role, text: body, acts: [], ts: 0 });
  });
  const ais = [...new Set(marks.filter((m) => m.role === 'ai').map((m) => m.name))];
  const label = ais.length === 1 && !['Assistant', 'AI', 'Bot', 'Model', '助手', '回答', '答'].includes(ais[0]) ? ais[0] : '';
  return [{ title: fileTitle || brief(entries.find((e) => e.role === 'user')?.text, 40), sourceLabel: label, entries }];
}

// ---------- JSON ----------

const ROLE = { user: 'user', human: 'user', me: 'user', assistant: 'ai', ai: 'ai', model: 'ai', bot: 'ai', gemini: 'ai', chatbot: 'ai' };
const partsText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(partsText).filter(Boolean).join('\n') : c?.text || c?.content && partsText(c.content) || '');

function fromMessages(list, title, sourceLabel = '') {
  const entries = [];
  for (const m of list) {
    const role = ROLE[String(m?.role || m?.author?.role || m?.sender || m?.type || '').toLowerCase()];
    const text = partsText(m?.content ?? m?.text ?? m?.parts).trim();
    if (!role || !text) continue;
    const prev = entries.at(-1);
    if (prev?.role === role) prev.text += `\n\n${text}`;
    else entries.push({ key: String(entries.length), role, text, acts: [], ts: toTs(m.timestamp || m.created_at || m.create_time || 0) });
  }
  return entries.length ? { title: title || brief(entries.find((e) => e.role === 'user')?.text, 40), sourceLabel, entries } : null;
}

/** ChatGPT 导出：每段对话是一棵树，从 current_node 往回找当前这条线。 */
function fromChatGPT(c) {
  const chain = [];
  const seen = new Set();
  for (let id = c.current_node; id && c.mapping?.[id] && !seen.has(id); id = c.mapping[id].parent) {
    seen.add(id);
    if (c.mapping[id].message) chain.push(c.mapping[id].message);
  }
  const entries = [];
  let ai = null;
  for (const m of chain.reverse()) {
    const role = m.author?.role;
    const ct = m.content?.content_type;
    const text = (ct === 'text' || ct === 'multimodal_text') ? partsText((m.content.parts || []).filter((p) => typeof p === 'string')).trim() : '';
    const ts = toTs(m.create_time || 0);
    if (m.metadata?.is_visually_hidden_from_conversation) continue;
    if (role === 'user' && text) { ai = null; entries.push({ key: m.id, role: 'user', text, acts: [], ts }); continue; }
    if (role !== 'assistant') continue;
    if (!ai) { ai = { key: m.id, role: 'ai', text: '', acts: [], ts }; entries.push(ai); }
    ai.key = m.id;
    const to = String(m.recipient || 'all');
    if (to === 'all' && text) ai.text = ai.text ? `${ai.text}\n\n${text}` : text;
    else if (/^(web|browser)/.test(to)) ai.acts.push(`搜索：${brief(partsText(m.content?.text || m.content?.parts), 60)}`);
    else if (to === 'python') ai.acts.push('运行 Python 代码');
    else if (/dalle|image/.test(to)) ai.acts.push('生成图片');
  }
  const list = entries.filter((e) => e.text || e.acts.length);
  return list.length ? { title: c.title || brief(list[0].text, 40), sourceLabel: 'ChatGPT', entries: list } : null;
}

/** Claude.ai 导出。 */
function fromClaudeAi(c) {
  const entries = [];
  for (const m of c.chat_messages || []) {
    const role = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'ai' : null;
    if (!role) continue;
    const blocks = Array.isArray(m.content) && m.content.length ? m.content : [{ type: 'text', text: m.text }];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n').trim();
    const acts = blocks.filter((b) => b.type === 'tool_use').map((b) => (b.name === 'web_search' ? `搜索：${brief(b.input?.query, 60)}` : b.name === 'repl' ? '运行代码' : '')).filter(Boolean);
    if (!text && !acts.length) continue;
    entries.push({ key: m.uuid || String(entries.length), role, text, acts, ts: toTs(m.created_at || 0) });
  }
  return entries.length ? { title: c.name || brief(entries[0].text, 40), sourceLabel: 'Claude.ai', entries } : null;
}

const stripHtml = (h) => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/\n{3,}/g, '\n\n').trim();

/** Google Takeout 的 Gemini 活动记录：一条是一问一答，没有分对话，按天分。 */
function fromTakeout(items) {
  const days = new Map();
  for (const it of [...items].sort((a, b) => toTs(a.time) - toTs(b.time))) {
    const user = String(it.title || '').replace(/^Prompted\s+/i, '').trim();
    const ai = stripHtml((it.safeHtmlItem || []).map((x) => x.html).join('\n'));
    if (!user && !ai) continue;
    const ts = toTs(it.time);
    const day = new Date(ts).toLocaleDateString('sv-SE'); // YYYY-MM-DD
    if (!days.has(day)) days.set(day, []);
    const list = days.get(day);
    if (user) list.push({ key: `${ts}-u`, role: 'user', text: user, acts: [], ts });
    if (ai) list.push({ key: `${ts}-a`, role: 'ai', text: ai, acts: [], ts });
  }
  return [...days].reverse().map(([day, entries]) => ({ title: `Gemini ${day}`, sourceLabel: 'Gemini', entries }));
}

function parseJson(data, fileTitle) {
  const list = Array.isArray(data) ? data : null;
  if (list?.some((c) => c?.mapping && 'current_node' in c)) return list.map(fromChatGPT).filter(Boolean);
  if (list?.some((c) => Array.isArray(c?.chat_messages))) return list.map(fromClaudeAi).filter(Boolean);
  if (list?.some((it) => /gemini|bard/i.test(`${it?.header} ${(it?.products || []).join(' ')}`))) {
    return fromTakeout(list.filter((it) => /gemini|bard/i.test(`${it?.header} ${(it?.products || []).join(' ')}`)));
  }
  if (data?.mapping && 'current_node' in data) return [fromChatGPT(data)].filter(Boolean);
  if (Array.isArray(data?.chat_messages)) return [fromClaudeAi(data)].filter(Boolean);
  const msgs = list || data?.messages || data?.conversation || data?.history;
  if (Array.isArray(msgs)) return [fromMessages(msgs, data?.title || fileTitle)].filter(Boolean);
  return null;
}

// ---------- zip（导出文件大多是 zip，自己解，不加依赖） ----------

function unzip(buf) {
  const out = [];
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('zip 文件不完整');
  let p = buf.readUInt32LE(end + 16);
  const count = buf.readUInt16LE(end + 10);
  for (let k = 0; k < count && buf.readUInt32LE(p) === 0x02014b50; k++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.push({ name, read: () => (method === 0 ? buf.subarray(start, start + size) : zlib.inflateRawSync(buf.subarray(start, start + size))) });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

// zip 里优先找这些文件
const IN_ZIP = [/(^|\/)conversations\.json$/i, /gemini[^/]*\/[^/]*activity\.json$/i, /\.(json|jsonl|md|markdown|txt)$/i];

// ---------- 入口 ----------

export function parseImport(input, fileName = '') {
  const fileTitle = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  if (Buffer.isBuffer(input) && input.readUInt32LE(0) === 0x04034b50) {
    const files = unzip(input);
    for (const re of IN_ZIP) {
      const hit = files.find((f) => re.test(f.name) && !f.name.startsWith('__MACOSX'));
      if (hit) return parseImport(hit.read(), hit.name);
    }
    throw new Error('压缩包里没有找到对话文件');
  }
  const text = (Buffer.isBuffer(input) ? input.toString('utf8') : String(input || '')).replace(/^﻿/, '');
  const t = text.trim();
  if (/^[[{]/.test(t)) {
    try {
      const r = parseJson(JSON.parse(t), fileTitle);
      if (r) return r;
    } catch { /* 不是 JSON，当文字处理 */ }
  }
  if (/\.jsonl$/i.test(fileName) || /^\{.*\}\s*\n\s*\{/s.test(t)) {
    const rows = t.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const r = rows.length && fromMessages(rows, fileTitle);
    if (r) return [r];
  }
  return parseText(text, fileTitle);
}
