// Codex 的会话记录：$CODEX_HOME/sessions/年/月/日/rollout-<时间>-<会话ID>.jsonl（默认 ~/.codex）
// Codex 用代码调工具，调用本身看不出做了什么，所以从 item_completed 里整理好的条目读：
// UserMessage / AgentMessage / FileChange / CommandExecution / Extension(联网搜索) / McpToolCall。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EntryBuilder, readJsonl, readEdges, relTo, brief, toTs } from './common.mjs';

export const meta = { id: 'codex', label: 'Codex', engine: 'codex' };

const HOME = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const ID_RE = /^[0-9a-f-]{36}$/i;
const FILE_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function files() {
  const out = [];
  const walk = (dir, depth) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of items) {
      const p = path.join(dir, d.name);
      if (d.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (d.isFile() && FILE_RE.test(d.name)) out.push(p);
    }
  };
  walk(path.join(HOME(), 'sessions'), 0);
  return out;
}

const idOf = (file) => path.basename(file).match(FILE_RE)?.[1] || '';

/** 会话标题：session_index.jsonl 里同一个 id 可能出现多次，取最后一次。 */
function titles() {
  const map = new Map();
  try {
    for (const o of readJsonl(fs.readFileSync(path.join(HOME(), 'session_index.jsonl'), 'utf8'))) {
      if (o.id && o.thread_name) map.set(o.id, o.thread_name);
    }
  } catch { /* 没有索引 */ }
  return map;
}

function userText(item) {
  const t = (item.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  return /^<[a-z_]+>/i.test(t) ? '' : t; // 系统注入的环境信息、问答回执等
}

const commandText = (cmd) => {
  const c = Array.isArray(cmd) ? cmd.at(-1) : cmd;
  return brief(c, 70);
};

const FILE_ACT = { add: '新建', create: '新建', delete: '删除', update: '修改' };

function apply(b, o, cwd) {
  const item = o.payload?.item;
  if (o.type !== 'event_msg' || o.payload?.type !== 'item_completed' || !item) return;
  const key = o.ordinal ?? item.id;
  const ts = toTs(o.timestamp);
  switch (item.type) {
    case 'UserMessage': b.user(key, userText(item), ts); break;
    case 'AgentMessage': b.aiText(key, (item.content || []).map((c) => c.text || '').join(''), ts); break;
    case 'FileChange':
      for (const [p, ch] of Object.entries(item.changes || {})) b.act(key, `${FILE_ACT[ch?.type] || '修改'} ${relTo(p, cwd)}`, ts);
      break;
    case 'CommandExecution': b.act(key, `运行 ${commandText(item.command)}`, ts); break;
    case 'Extension':
      if (item.kind === 'web.search') b.act(key, `搜索：${brief(item.query || item.action?.queries?.[0], 60)}`, ts);
      break;
    case 'McpToolCall':
      if (item.arguments?.title) b.act(key, brief(item.arguments.title, 60), ts);
      break;
    default: break;
  }
}

export function list() {
  const names = titles();
  const out = [];
  for (const file of files()) {
    try {
      const id = idOf(file);
      const { head } = readEdges(file, 64 * 1024);
      const first = readJsonl(head);
      const metaLine = first.find((o) => o.type === 'session_meta');
      const firstUser = first.map((o) => (o.payload?.type === 'item_completed' && o.payload.item?.type === 'UserMessage' ? userText(o.payload.item) : '')).find(Boolean);
      out.push({
        id,
        title: names.get(id) || brief(firstUser, 40) || '（无标题）',
        cwd: metaLine?.payload?.cwd || '',
        updatedAt: fs.statSync(file).mtimeMs,
      });
    } catch { /* 读不了的跳过 */ }
  }
  return out;
}

export function read(id) {
  if (!ID_RE.test(id)) throw new Error('会话 id 不对');
  const file = files().find((f) => idOf(f) === id);
  if (!file) throw new Error('找不到这段 Codex 对话');
  const lines = readJsonl(fs.readFileSync(file, 'utf8'));
  const cwd = lines.find((o) => o.type === 'session_meta')?.payload?.cwd || '';
  const b = new EntryBuilder();
  for (const o of lines) apply(b, o, cwd);
  const entries = b.done();
  return { id, title: titles().get(id) || brief(entries.find((e) => e.role === 'user')?.text, 40), cwd, entries };
}
