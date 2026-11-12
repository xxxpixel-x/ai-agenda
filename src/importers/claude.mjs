// Claude Code 的会话记录：~/.claude/projects/<项目>/<会话ID>.jsonl
// 记录是一棵树（倒回重来、编辑消息会分叉），从最后一条沿 parentUuid 往回找，只取当前这条线；
// 压缩过的会话在 compact_boundary 处断开，用 logicalParentUuid 接上压缩前的部分。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EntryBuilder, readJsonl, readEdges, relTo, brief, toTs } from './common.mjs';

export const meta = { id: 'claude-code', label: 'Claude Code', engine: 'claude-code' };

const ROOT = () => path.join(os.homedir(), '.claude', 'projects');
const ID_RE = /^[0-9a-f-]{36}$/i;
const CONTINUED = 'This session is being continued from a previous conversation';

function files() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT(), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    const dir = path.join(ROOT(), d.name);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (n.endsWith('.jsonl') && ID_RE.test(n.slice(0, -6))) out.push(path.join(dir, n));
    }
  }
  return out;
}

const fileOf = (id) => {
  if (!ID_RE.test(id)) return null;
  return files().find((f) => path.basename(f, '.jsonl') === id) || null;
};

/** 用户真正打的字（去掉系统附加的提醒块）；工具结果、命令输出等返回空。 */
function userText(o) {
  if (o.type !== 'user' || o.isMeta || o.isCompactSummary || o.isSidechain) return '';
  if (o.origin?.kind && o.origin.kind !== 'human') return ''; // 后台任务通知等，不是你打的字
  const c = o.message?.content;
  let t = '';
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b.type === 'tool_result')) return '';
    t = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!t || t.startsWith(CONTINUED)) return '';
  if (/^<(command-name|command-message|local-command|bash-input|bash-stdout)/.test(t)) return '';
  return t;
}

function actOf(b, cwd) {
  const i = b.input || {};
  switch (b.name) {
    case 'Read': return `读取 ${relTo(i.file_path, cwd)}`;
    case 'Edit': case 'MultiEdit': return `修改 ${relTo(i.file_path, cwd)}`;
    case 'Write': return `写入 ${relTo(i.file_path, cwd)}`;
    case 'NotebookEdit': return `修改 ${relTo(i.notebook_path, cwd)}`;
    case 'Bash': case 'PowerShell': return `运行 ${brief(i.command, 70)}`;
    case 'WebSearch': return `搜索：${brief(i.query, 60)}`;
    case 'WebFetch': return `打开网页 ${brief(i.url, 60)}`;
    default: return ''; // 查找文件、任务清单、内部工具等不记
  }
}

/** 当前这条线上的记录（按时间顺序）。 */
function mainLine(lines) {
  const byId = new Map();
  let leaf = null;
  for (const o of lines) {
    if (!o.uuid) continue;
    byId.set(o.uuid, o);
    if ((o.type === 'user' || o.type === 'assistant') && !o.isSidechain) leaf = o;
  }
  const chain = [];
  const seen = new Set();
  for (let o = leaf; o && !seen.has(o.uuid);) {
    seen.add(o.uuid);
    chain.push(o);
    const next = o.parentUuid || o.logicalParentUuid;
    o = next ? byId.get(next) : null;
  }
  return chain.reverse();
}

function titleOf(lines) {
  let t = '';
  for (const o of lines) if (o.type === 'custom-title' && o.customTitle) t = o.customTitle;
  return t;
}

export function list() {
  const out = [];
  for (const file of files()) {
    try {
      const st = fs.statSync(file);
      const { head, tail } = readEdges(file, 128 * 1024);
      const first = readJsonl(head);
      const last = readJsonl(tail);
      const cwd = first.find((o) => o.cwd)?.cwd || '';
      const firstUser = first.map(userText).find(Boolean) || '';
      if (!firstUser && !titleOf(last)) continue; // 没有对话内容（例如只登录失败的一次调用）
      out.push({
        id: path.basename(file, '.jsonl'),
        title: titleOf(last) || titleOf(first) || brief(firstUser, 40),
        cwd,
        updatedAt: st.mtimeMs,
      });
    } catch { /* 读不了的跳过 */ }
  }
  return out;
}

export function read(id) {
  const file = fileOf(id);
  if (!file) throw new Error('找不到这段 Claude Code 对话');
  const lines = readJsonl(fs.readFileSync(file, 'utf8'));
  const cwd = lines.find((o) => o.cwd)?.cwd || '';
  const b = new EntryBuilder();
  for (const o of mainLine(lines)) {
    const ts = toTs(o.timestamp);
    if (o.type === 'user') {
      const t = userText(o);
      if (t) b.user(o.uuid, t, ts);
    } else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      for (const c of o.message.content) {
        if (c.type === 'text') b.aiText(o.uuid, c.text, ts);
        else if (c.type === 'tool_use') b.act(o.uuid, actOf(c, cwd), ts);
      }
    }
  }
  const entries = b.done();
  return { id, title: titleOf(lines) || brief(entries.find((e) => e.role === 'user')?.text, 40), cwd, entries };
}
