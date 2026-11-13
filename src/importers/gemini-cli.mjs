// Gemini CLI 的会话记录：~/.gemini/tmp/<项目>/chats/session-*.jsonl（三个系统都在用户主目录下）。
// 新版是 JSONL：第一行是会话信息，之后每行一条消息，{"$set": {...}} 行更新会话信息，同一个 id 再出现表示更新那条消息。
// 旧版是一个 session-*.json，里面 { ..., messages: [...] }。两种都读。
// 项目文件夹：新版 <项目>/.project_root 里写着；旧版的 <项目> 是路径的哈希，从 ~/.gemini/projects.json 反查不到就留空。
// 只在真机上见过“只有登录记录”的会话，含 AI 回复和工具调用的部分按 Gemini CLI 公开的源码格式写，没在真机上验证过。
import fs from 'node:fs';
import path from 'node:path';
import { EntryBuilder, readJsonl, relTo, brief, toTs, homeDir } from './common.mjs';

// 对应的成员是 Gemini CLI；没装（Agenda 里没有这个类型）时只导入文字
export const meta = { id: 'gemini-cli', label: 'Gemini CLI', engine: 'gemini-cli' };

const ROOT = () => homeDir('.gemini', 'tmp');
const FILE_RE = /^session-.+\.jsonl?$/;

function files() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT(), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    const dir = path.join(ROOT(), d.name, 'chats');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) if (FILE_RE.test(n)) out.push(path.join(dir, n));
  }
  return out;
}

const idOf = (file) => path.basename(file).replace(/\.jsonl?$/, '');

/** 读出会话信息和消息（同一个 id 的更新合并成最后的样子，保持第一次出现的顺序）。 */
function load(file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    const o = JSON.parse(raw);
    return { info: o, messages: Array.isArray(o.messages) ? o.messages : [] };
  }
  const info = {};
  const byId = new Map();
  for (const o of readJsonl(raw)) {
    if (o.$set) Object.assign(info, o.$set);
    else if (o.id && (o.type || byId.has(o.id))) byId.set(o.id, { ...byId.get(o.id), ...o });
    else if (o.sessionId && !o.type) Object.assign(info, o);
  }
  return { info, messages: [...byId.values()] };
}

function cwdOf(file, info) {
  const dir = path.dirname(path.dirname(file));
  try { return fs.readFileSync(path.join(dir, '.project_root'), 'utf8').trim(); } catch { /* 旧版没有 */ }
  try {
    const { projects = {} } = JSON.parse(fs.readFileSync(homeDir('.gemini', 'projects.json'), 'utf8'));
    const name = path.basename(dir);
    return Object.keys(projects).find((p) => projects[p] === name) || '';
  } catch { return info.projectRoot || ''; }
}

const textOf = (c) => (typeof c === 'string' ? c : (Array.isArray(c) ? c : [c]).map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n')).trim();
// Gemini CLI 自己附在第一条消息里的运行环境说明不算你打的字
const userText = (m) => (m.type === 'user' ? textOf(m.content).replace(/<session_context>[\s\S]*?<\/session_context>/g, '').trim() : '');

function actOf(t, cwd) {
  const a = t.args || {};
  const file = relTo(a.file_path || a.absolute_path || a.path, cwd);
  switch (t.name) {
    case 'read_file': return `读取 ${file}`;
    case 'read_many_files': return `读取 ${brief((a.paths || []).join('、'), 60)}`;
    case 'write_file': return `写入 ${file}`;
    case 'replace': case 'edit': return `修改 ${file}`;
    case 'run_shell_command': return `运行 ${brief(a.command, 70)}`;
    case 'google_web_search': return `搜索：${brief(a.query, 60)}`;
    case 'web_fetch': return `打开网页 ${brief(a.url || a.prompt, 60)}`;
    default: return ''; // 列目录、查找文件、记忆等不记
  }
}

export function list() {
  const out = [];
  for (const file of files()) {
    try {
      const { info, messages } = load(file);
      if (info.kind && info.kind !== 'main') continue; // 子代理的会话不单独列出
      const firstUser = messages.map(userText).find(Boolean);
      if (!firstUser) continue; // 只有登录之类的记录
      out.push({ id: idOf(file), title: info.summary || brief(firstUser, 40), cwd: cwdOf(file, info), updatedAt: fs.statSync(file).mtimeMs });
    } catch { /* 读不了的跳过 */ }
  }
  return out;
}

export function read(id) {
  const file = files().find((f) => idOf(f) === id);
  if (!file) throw new Error('找不到这段 Gemini CLI 对话');
  const { info, messages } = load(file);
  const cwd = cwdOf(file, info);
  const b = new EntryBuilder();
  for (const m of messages) {
    const ts = toTs(m.timestamp);
    if (m.type === 'user') b.user(m.id, userText(m), ts);
    else if (m.type === 'gemini') {
      b.aiText(m.id, textOf(m.content), ts);
      for (const t of m.toolCalls || []) b.act(m.id, actOf(t, cwd), ts);
    }
  }
  const entries = b.done();
  return { id, title: info.summary || brief(entries.find((e) => e.role === 'user')?.text, 40), cwd, entries };
}
