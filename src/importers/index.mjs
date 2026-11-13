// 外部 AI 会话记录的来源注册表。要支持新的来源：在这个文件夹里加一个模块，再加到 SOURCES（见 docs/importers.md）。
import os from 'node:os';
import path from 'node:path';
import * as claude from './claude.mjs';
import * as codex from './codex.mjs';
import * as dsh from './dsh.mjs';
import * as geminiCli from './gemini-cli.mjs';
import * as workbuddy from './workbuddy.mjs';
import * as zcode from './zcode.mjs';
import * as pasted from './pasted.mjs';

const SOURCES = [claude, codex, dsh, geminiCli, workbuddy, zcode, pasted];

export const sourceOf = (id) => SOURCES.find((s) => s.meta.id === id) || null;
export const sourceMetas = () => SOURCES.map((s) => s.meta);

/** 启动时调用一次：粘贴的对话存在数据目录里。 */
export const configureImporters = ({ dataDir }) => pasted.configure(dataDir);
export const stagePasted = pasted.stage;

// Windows、macOS 的路径不分大小写，Linux 分
const norm = (p) => (p ? (process.platform === 'linux' ? path.resolve(p) : path.resolve(p).toLowerCase()) : '');
const inside = (p, dir) => { const a = norm(p); const b = norm(dir); return !!a && !!b && (a === b || a.startsWith(b + path.sep)); };

/**
 * 各家的会话列表，最近更新的在前。
 *  exclude.ids    Agenda 自己复制出来的会话（接续中的 Claude 成员）
 *  exclude.dir    Agenda 的数据目录（里面的会话都是 Agenda 自己跑出来的）
 * 系统临时文件夹里的会话（各种工具试跑留下的）也不列出。
 */
export function listSessions({ exclude = {} } = {}) {
  const out = [];
  const tmp = os.tmpdir();
  for (const s of SOURCES) {
    let items = [];
    try { items = s.list(); } catch { /* 这一家读不了不影响其他 */ }
    for (const it of items) {
      if (exclude.ids?.has(it.id)) continue;
      if (inside(it.cwd, tmp) || (exclude.dir && inside(it.cwd, exclude.dir))) continue;
      out.push({ source: s.meta.id, sourceLabel: s.meta.label, engine: s.meta.engine, ...it });
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function readSession(source, id) {
  const s = sourceOf(source);
  if (!s) throw new Error('不支持的来源');
  try {
    return { source, sourceLabel: s.meta.label, engine: s.meta.engine, ...s.read(String(id || '')) };
  } catch (e) {
    throw new Error(`${s.meta.label} 的这段对话读不出来：${e.message}`);
  }
}

export const samePath = (a, b) => !!a && !!b && norm(a) === norm(b);
