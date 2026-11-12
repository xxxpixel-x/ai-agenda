// DeepSeek Harness 的会话记录：~/.dsh/sessions/<项目>/session-<ID>/session.v4.jsonl.zstd（zstd 压缩的 JSONL）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { EntryBuilder, readJsonl, relTo, brief } from './common.mjs';

export const meta = { id: 'dsh', label: 'DeepSeek Harness', engine: 'dsh' };

const ROOT = () => path.join(os.homedir(), '.dsh', 'sessions');
const ID_RE = /^(session-)?[0-9a-f-]{36}$/i;
const FILE = 'session.v4.jsonl.zstd';

function files() {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(ROOT(), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const p of projects) {
    let sessions = [];
    try { sessions = fs.readdirSync(path.join(ROOT(), p.name)); } catch { continue; }
    for (const s of sessions) {
      const f = path.join(ROOT(), p.name, s, FILE);
      if (ID_RE.test(s) && fs.existsSync(f)) out.push(f);
    }
  }
  return out;
}

const idOf = (file) => path.basename(path.dirname(file));

// 解压整份记录。列表时也要用到（标题、项目文件夹），按修改时间缓存。
// 记录是一段段压缩后接起来的（多个 zstd frame）。Node 24.18 只解出第一段，Agenda 用的 Electron 45（Node 24.22）能全部解出。
const cache = new Map(); // file -> { mtime, lines }
function load(file) {
  const mtime = fs.statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.lines;
  if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('当前 Node 版本不能解压 DeepSeek Harness 的记录（需要 Node 22.15 以上）');
  const lines = readJsonl(zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8'));
  cache.set(file, { mtime, lines });
  return lines;
}

const textOf = (content) => (content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
// 运行环境、技能目录等也记成 user/message，只有 source.kind 为 user 的才是你打的字
const userText = (o) => (o.type === 'user/message' && (o.data?.source?.kind ?? 'user') === 'user' ? textOf(o.data?.content) : '');

function titleOf(lines) {
  let t = '';
  for (const o of lines) if (o.type === 'session/title' && o.data?.title) t = o.data.title;
  return t;
}

function actOf(c, cwd) {
  let a = {};
  try { a = JSON.parse(c.arguments || '{}'); } catch { /* 参数不是 JSON */ }
  const file = relTo(a.file_path || a.path, cwd);
  switch (String(c.name || '').toLowerCase()) {
    case 'read': return `读取 ${file}`;
    case 'write': return `写入 ${file}`;
    case 'edit': case 'multiedit': case 'apply_patch': return `修改 ${file}`;
    case 'pwsh': case 'bash': case 'shell': case 'powershell': return `运行 ${brief(a.command || a.cmd, 70)}`;
    case 'web_search': return `搜索：${brief(a.query || a.queries?.[0], 60)}`;
    case 'web_fetch': return `打开网页 ${brief(a.url, 60)}`;
    default: return '';
  }
}

export function list() {
  const out = [];
  for (const file of files()) {
    try {
      const lines = load(file);
      const session = lines.find((o) => o.type === 'session');
      const firstUser = lines.map(userText).find(Boolean);
      if (!firstUser || session?.delegationDepth > 0) continue; // 子任务会话不单独列出
      out.push({
        id: idOf(file),
        title: titleOf(lines) || brief(firstUser, 40),
        cwd: session?.cwd || '',
        updatedAt: fs.statSync(file).mtimeMs,
      });
    } catch { /* 读不了的跳过 */ }
  }
  return out;
}

export function read(id) {
  if (!ID_RE.test(id)) throw new Error('会话 id 不对');
  const file = files().find((f) => idOf(f) === id);
  if (!file) throw new Error('找不到这段 DeepSeek Harness 对话');
  const lines = load(file);
  const cwd = lines.find((o) => o.type === 'session')?.cwd || '';
  const b = new EntryBuilder();
  for (const o of lines) {
    const ts = o.time || 0;
    if (o.type === 'user/message') b.user(o.seq, userText(o), ts);
    else if (o.type === 'assistant/message') {
      for (const c of o.data?.message?.content || []) {
        if (c.type === 'text') b.aiText(o.seq, c.text, ts);
        else if (c.type === 'tool-call') b.act(o.seq, actOf(c, cwd), ts);
      }
    }
  }
  const entries = b.done();
  return { id, title: titleOf(lines) || brief(entries.find((e) => e.role === 'user')?.text, 40), cwd, entries };
}
