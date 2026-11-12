// 读取外部 AI 会话记录的公共部分。
// 每个来源模块导出：
//   meta = { id, label, engine }          engine：圆桌里对应的 AI 类型
//   list() -> [{ id, title, cwd, updatedAt }]
//   read(id) -> { id, title, cwd, entries: [{ key, role: 'user'|'ai', text, acts: [string], ts }] }
// 只读取，不改动任何记录文件。
import fs from 'node:fs';
import path from 'node:path';

export const brief = (s, max = 80) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

export const baseName = (p) => (p ? String(p).split(/[\\/]/).filter(Boolean).pop() : '');

/** 文件里的操作路径，尽量显示成相对项目文件夹的形式。 */
export function relTo(p, cwd) {
  if (!p) return '';
  const s = String(p);
  if (cwd) {
    const r = path.relative(cwd, s);
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r.split(path.sep).join('/');
  }
  return s;
}

export function readJsonl(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 写到一半的行 */ }
  }
  return out;
}

/** 读文件开头 / 结尾的一段（列表时不必读完几 MB 的记录）。 */
export function readEdges(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const total = fs.fstatSync(fd).size;
    const read = (pos, len) => {
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, pos);
      return buf.subarray(0, n).toString('utf8');
    };
    if (total <= size * 2) { const all = read(0, total); return { head: all, tail: all }; }
    return { head: read(0, size), tail: read(total - size, size) };
  } finally {
    fs.closeSync(fd);
  }
}

/** 按“一问一答”整理：连续的 AI 内容合并成一条。 */
export class EntryBuilder {
  constructor() { this.entries = []; this.ai = null; }
  user(key, text, ts) {
    const t = String(text || '').trim();
    if (!t) return;
    this.ai = null;
    this.entries.push({ key: String(key), role: 'user', text: t, acts: [], ts: ts || 0 });
  }
  aiEntry(key, ts) {
    if (!this.ai) {
      this.ai = { key: String(key), role: 'ai', text: '', acts: [], ts: ts || 0 };
      this.entries.push(this.ai);
    }
    this.ai.key = String(key); // 补导时从最后一块之后接着读
    return this.ai;
  }
  aiText(key, text, ts) {
    const t = String(text || '').trim();
    if (!t) return;
    const e = this.aiEntry(key, ts);
    e.text = e.text ? `${e.text}\n\n${t}` : t;
  }
  act(key, label, ts) {
    if (!label) return;
    const e = this.aiEntry(key, ts);
    if (e.acts.at(-1) !== label) e.acts.push(label);
  }
  done() {
    return this.entries.filter((e) => e.role === 'user' || e.text || e.acts.length);
  }
}

export const toTs = (v) => {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : 0;
};
