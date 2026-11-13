// ZCode 桌面版和 CLI 共用 ~/.zcode/cli/db/db.sqlite；桌面标题另见 ~/.zcode/v2/tasks-index.sqlite。
// session 是目录，message / part 是正文，按 sequence 排序；rollout 是模型请求日志，不重复导入。
// Windows 已核对；macOS / Linux 的 ~/.zcode 路径由上游源码确认，但未在对应系统实测。
// Electron 缓存惯例位置（macOS / Linux 为推断）：%APPDATA%/ZCode、
// ~/Library/Application Support/ZCode、$XDG_CONFIG_HOME/ZCode（默认 ~/.config/ZCode），不作为会话来源。
import fs from 'node:fs';
import { EntryBuilder, homeDir, openSqlite, relTo, brief, toTs } from './common.mjs';

export const meta = { id: 'zcode', label: 'ZCode', engine: null };

const database = () => homeDir('.zcode', 'cli', 'db', 'db.sqlite');
const taskIndex = () => homeDir('.zcode', 'v2', 'tasks-index.sqlite');

function withDb(file, fn) {
  const db = openSqlite(file);
  try { return fn(db); } finally { db.close(); }
}

const columns = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));

function parse(data) {
  try { return JSON.parse(data) || {}; } catch { return {}; }
}

// 只读桌面列表的标量列，不解析 meta_json / searchable_text，更不读每段会话正文。
function desktopTasks() {
  const file = taskIndex();
  if (!fs.existsSync(file)) return new Map();
  return withDb(file, (db) => {
    const cols = columns(db, 'tasks');
    const legacyId = cols.has('acp_session_id') ? "COALESCE(NULLIF(acp_session_id, ''), task_id)" : 'task_id';
    const rows = db.prepare(`SELECT ${legacyId} AS id, title, title_overridden, deleted, updated_at
      FROM tasks ORDER BY updated_at`).all();
    return new Map(rows.map((r) => [r.id, r]));
  });
}

function sessionFilter(db) {
  const cols = columns(db, 'session');
  let where = "(parent_id IS NULL OR parent_id = '')";
  if (cols.has('task_type')) where += " AND task_type NOT IN ('workflow_child', 'subagent_child', 'nested_workflow_child')";
  if (cols.has('time_deleted')) where += ' AND time_deleted IS NULL';
  return where;
}

function summary(row, task) {
  return {
    id: row.id,
    title: (task?.title_overridden && task.title) || row.title || '（无标题）',
    cwd: row.directory || '',
    updatedAt: Math.max(toTs(row.time_updated), toTs(task?.updated_at)),
  };
}

// 旧库没有 sequence；新库以它为准，时间戳相同时也不能按随机 ID 打乱对话。
function orderBy(db, table) {
  return (columns(db, table).has('sequence') ? 'sequence IS NULL, sequence, ' : '') +
    (table === 'message' ? 'time_created, rowid' : 'time_created, id');
}

function visible(message) {
  const s = message.semantics || {};
  if (message.synthetic || message.visibility === 'model-only' || s.uiVisibility === 'hidden' || s.uiVisibility === 'debug') return false;
  if (message.role === 'user') {
    if (message.source || (message.anchor?.origin && message.anchor.origin !== 'realUser')) return false;
    if (s.origin && !['real_user', 'import', 'migration'].includes(s.origin)) return false;
    return !s.kind || s.kind === 'user_prompt' || s.kind === 'slash_command';
  }
  return message.role === 'assistant' && !message.summary && s.origin !== 'system' &&
    (!s.kind || s.kind === 'assistant_response');
}

function textOf(part) {
  if (part.type !== 'text' || part.synthetic || part.ignored || typeof part.text !== 'string') return '';
  // 老版本可能将环境说明和提醒嵌入正文；保留这些块之外的用户文字。
  return part.text.replace(/<(system-reminder|environment_context|env_info|skills_instructions)>[\s\S]*?<\/\1>/gi, '').trim();
}

function actOf(part, cwd) {
  const input = part.state?.input;
  const a = typeof input === 'string' ? parse(input) : (input || {});
  const file = relTo(a.file_path || a.path || a.notebook_path, cwd);
  const command = brief(a.command || a.cmd, 70);
  const query = brief(a.query || a.pattern, 60);
  switch (String(part.tool || '').toLowerCase()) {
    case 'read': return file ? `读取 ${file}` : '';
    case 'edit': case 'multiedit': case 'notebookedit': return file ? `修改 ${file}` : '';
    case 'write': return file ? `写入 ${file}` : '';
    case 'bash': case 'powershell': case 'pwsh': case 'shell': return command ? `运行 ${command}` : '';
    case 'websearch': case 'web_search': return query ? `搜索：${query}` : '';
    case 'webfetch': case 'web_fetch': return a.url ? `打开网页 ${brief(a.url, 60)}` : '';
    default: return '';
  }
}

export function list() {
  try {
    if (!fs.existsSync(database())) return [];
    const tasks = desktopTasks();
    return withDb(database(), (db) => db.prepare(`SELECT id, title, directory, time_updated
      FROM session WHERE ${sessionFilter(db)} ORDER BY time_updated DESC`).all()
      .filter((r) => !tasks.get(r.id)?.deleted)
      .map((r) => summary(r, tasks.get(r.id))));
  } catch { return []; } // 被占用、权限不足或格式不支持时，不影响其它来源。
}

export function read(id) {
  if (typeof id !== 'string' || !id) throw new Error('ZCode 会话 id 不对');
  try {
    const tasks = desktopTasks();
    return withDb(database(), (db) => {
      db.exec('BEGIN'); // 同一次读取使用一致的正文快照，close 时释放。
      const row = db.prepare(`SELECT id, title, directory, time_updated FROM session
        WHERE id = ? AND ${sessionFilter(db)}`).get(id);
      if (!row || tasks.get(id)?.deleted) throw new Error('找不到这段 ZCode 对话（可能已删除或是子任务）');
      const info = summary(row, tasks.get(id));
      const messages = db.prepare(`SELECT id, time_created, data FROM message
        WHERE session_id = ? ORDER BY ${orderBy(db, 'message')}`).all(id);
      const parts = db.prepare(`SELECT id, message_id, data FROM part
        WHERE session_id = ? ORDER BY ${orderBy(db, 'part')}`).all(id);
      const byMessage = new Map();
      for (const p of parts) {
        const group = byMessage.get(p.message_id) || [];
        group.push({ ...parse(p.data), id: p.id });
        byMessage.set(p.message_id, group);
      }
      const b = new EntryBuilder();
      for (const m of messages) {
        const message = parse(m.data);
        if (!visible(message)) continue;
        const ts = toTs(message.time?.created || m.time_created);
        const content = byMessage.get(m.id) || [];
        if (message.role === 'user') {
          b.user(m.id, content.map(textOf).filter(Boolean).join('\n'), ts);
        } else {
          const blocks = content.filter((p) => ['text', 'reasoning', 'tool'].includes(p.type));
          if (blocks.length && blocks.every((p) => Number.isInteger(p.blockIndex) && p.blockIndex >= 0)) {
            blocks.sort((a, b) => a.blockIndex - b.blockIndex);
          }
          for (const p of blocks) {
            if (p.type === 'text') b.aiText(p.id, textOf(p), ts);
            else if (p.type === 'tool') b.act(p.id, actOf(p, info.cwd), ts);
          }
        }
      }
      return { id, title: info.title, cwd: info.cwd, entries: b.done() };
    });
  } catch (error) {
    throw new Error(`无法读取 ZCode 对话：数据库可能被占用、无读取权限或格式不受支持，请关闭 ZCode 后重试。${error.message}`);
  }
}
