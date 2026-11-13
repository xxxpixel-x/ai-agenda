// WorkBuddy（腾讯）的会话记录：~/.workbuddy/projects/<项目>/<会话ID>.jsonl，三个系统都在用户主目录下。
// 同一套格式的 CodeBuddy Code 命令行（~/.codebuddy/projects）也一起读（按格式推断，没在真机上验证过）。
// 记录是一棵树（编辑消息会分叉），从最后一条沿 parentId 往回找，只取当前这条线。
// 你打的字包在 <user_query> 里，前面附带的 <system-reminder> 等是系统加的；子代理的记录在 <会话ID>/subagents/ 下，不单独列出。
import fs from 'node:fs';
import path from 'node:path';
import { EntryBuilder, readJsonl, readEdges, relTo, brief, homeDir } from './common.mjs';

export const meta = { id: 'workbuddy', label: 'WorkBuddy', engine: null };

const ROOTS = () => [['WorkBuddy', homeDir('.workbuddy', 'projects')], ['CodeBuddy', homeDir('.codebuddy', 'projects')]];
const ID_RE = /^[0-9a-f-]{36}$/i;
const SKIP = new Set(['session-meta', 'file-history-snapshot']);

function files() {
  const out = [];
  for (const [label, root] of ROOTS()) {
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const d of dirs) {
      let names = [];
      try { names = fs.readdirSync(path.join(root, d.name)); } catch { continue; }
      for (const n of names) if (n.endsWith('.jsonl') && ID_RE.test(n.slice(0, -6))) out.push({ label, file: path.join(root, d.name, n) });
    }
  }
  return out;
}

const idOf = (file) => path.basename(file, '.jsonl');
const textOf = (c) => (typeof c === 'string' ? c : (Array.isArray(c) ? c : []).map((p) => p?.text || '').join('\n'));

/** 你打的字：有 <user_query> 就取里面的；否则去掉系统附加的块。子代理消息、后台通知返回空。 */
function userText(o) {
  if (o.type !== 'message' || o.role !== 'user') return '';
  const t = textOf(o.content);
  const q = [...t.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g)].map((m) => m[1].trim()).filter(Boolean);
  if (q.length) return q.join('\n\n');
  return t.replace(/<([\w-]+)>[\s\S]*?<\/\1>/g, '').trim();
}

function actOf(o, cwd) {
  let a = {};
  try { a = typeof o.arguments === 'string' ? JSON.parse(o.arguments) : o.arguments || {}; } catch { /* 参数不是 JSON */ }
  switch (o.name) {
    case 'Read': return `读取 ${relTo(a.file_path, cwd)}`;
    case 'Edit': case 'MultiEdit': return `修改 ${relTo(a.file_path, cwd)}`;
    case 'Write': return `写入 ${relTo(a.file_path, cwd)}`;
    case 'Bash': case 'PowerShell': return `运行 ${brief(a.command, 70)}`;
    case 'WebSearch': return `搜索：${brief(a.query, 60)}`;
    case 'WebFetch': return `打开网页 ${brief(a.url, 60)}`;
    default: return ''; // 查找文件、任务清单、界面组件等不记
  }
}

function titleOf(lines) {
  let t = '';
  for (const o of lines) if (o.type === 'ai-title' && o.aiTitle) t = o.aiTitle;
  return t;
}

/** 当前这条线上的记录（按时间顺序）。同一个 id 出现多次时以最后一次为准。 */
function mainLine(lines) {
  const byId = new Map();
  let leaf = null;
  for (const o of lines) {
    if (!o.id || SKIP.has(o.type)) continue;
    byId.set(o.id, o);
    if (o.type === 'message') leaf = o;
  }
  const chain = [];
  const seen = new Set();
  for (let o = leaf; o && !seen.has(o.id); o = o.parentId ? byId.get(o.parentId) : null) {
    seen.add(o.id);
    chain.push(o);
  }
  return chain.reverse();
}

export function list() {
  const out = [];
  for (const { label, file } of files()) {
    try {
      const { head, tail } = readEdges(file, 128 * 1024);
      const first = readJsonl(head);
      const firstUser = first.map(userText).find(Boolean);
      if (!firstUser) continue;
      out.push({
        id: idOf(file),
        title: titleOf(readJsonl(tail)) || titleOf(first) || brief(firstUser, 40),
        cwd: first.find((o) => o.cwd)?.cwd || '',
        updatedAt: fs.statSync(file).mtimeMs,
        ...(label !== meta.label && { sourceLabel: label }),
      });
    } catch { /* 读不了的跳过 */ }
  }
  return out;
}

export function read(id) {
  const hit = ID_RE.test(id) && files().find((f) => idOf(f.file) === id);
  if (!hit) throw new Error('找不到这段对话');
  const lines = readJsonl(fs.readFileSync(hit.file, 'utf8'));
  const cwd = lines.find((o) => o.cwd)?.cwd || '';
  const b = new EntryBuilder();
  for (const o of mainLine(lines)) {
    const ts = o.timestamp || 0;
    if (o.type === 'message' && o.role === 'user') b.user(o.id, userText(o), ts);
    else if (o.type === 'message' && o.role === 'assistant') b.aiText(o.id, textOf(o.content), ts);
    else if (o.type === 'function_call') b.act(o.id, actOf(o, cwd), ts);
  }
  const entries = b.done();
  return {
    id, cwd, entries,
    title: titleOf(lines) || brief(entries.find((e) => e.role === 'user')?.text, 40),
    ...(hit.label !== meta.label && { sourceLabel: hit.label }),
  };
}
