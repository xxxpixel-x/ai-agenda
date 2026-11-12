// 共享文件夹：所有成员（AI 和你）读写同一个文件夹。
// 每次 AI 发言前后各扫描一次，比对出它改了哪些文件，记入改动记录；任何一条改动都能撤销。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out', '.next',
  '.nuxt', 'target', '.idea', '.vs', '.vscode', '.cache', '.gradle', 'bin', 'obj', '.dsh', '.codex', '.claude']);
const MAX_FILES = 3000;
const MAX_FILE_BYTES = 1024 * 1024;   // 超过 1MB 的文件不跟踪
const MAX_HISTORY = 500;

const toPosix = (p) => p.split(path.sep).join('/');

function readText(abs) {
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) return null; // 二进制
  return buf.toString('utf8');
}

/** 统计一次改动增删了多少行（足够用于列表展示，不追求精确 diff）。 */
function lineStats(before, after) {
  const a = (before ?? '').split('\n');
  const b = (after ?? '').split('\n');
  const count = new Map();
  for (const l of a) count.set(l, (count.get(l) || 0) + 1);
  let common = 0;
  for (const l of b) {
    const c = count.get(l);
    if (c) { common++; count.set(l, c - 1); }
  }
  return { added: before == null ? b.length : b.length - common, removed: after == null ? a.length : a.length - common };
}

export class Workspace {
  /**
   * @param root        共享文件夹的绝对路径
   * @param historyFile 改动记录的保存位置
   */
  constructor(root, historyFile) {
    this.root = path.resolve(root);
    this.historyFile = historyFile;
    fs.mkdirSync(this.root, { recursive: true });
    this.cache = new Map(); // rel -> { size, mtimeMs, content }
    this.truncated = false;
    try { this.history = JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch { this.history = []; }
    this.refresh();
  }

  /** 把相对路径解析成文件夹内的绝对路径；越界则报错。 */
  resolve(rel) {
    const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean || clean.split('/').some((s) => s === '..')) throw new Error('文件路径不合法');
    const abs = path.resolve(this.root, clean);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new Error('只能访问共享文件夹里的文件');
    return abs;
  }

  scan() {
    const found = new Map();
    let truncated = false;
    const walk = (dir) => {
      if (found.size >= MAX_FILES) { truncated = true; return; }
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (found.size >= MAX_FILES) { truncated = true; return; }
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(abs);
        } else if (e.isFile()) {
          let st;
          try { st = fs.statSync(abs); } catch { continue; }
          if (st.size <= MAX_FILE_BYTES) found.set(toPosix(path.relative(this.root, abs)), { size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    };
    walk(this.root);
    this.truncated = truncated;
    return found;
  }

  /**
   * 重新扫描并更新缓存，返回与缓存相比的变化 [{ path, before, after }]。
   * 文本以外的文件（二进制）不记录内容。
   */
  refresh() {
    const now = this.scan();
    const changes = [];
    for (const [rel, st] of now) {
      const old = this.cache.get(rel);
      if (old && old.size === st.size && old.mtimeMs === st.mtimeMs) continue;
      let content = null;
      try { content = readText(path.join(this.root, rel)); } catch { continue; }
      if (old && old.content === content) { this.cache.set(rel, { ...st, content }); continue; }
      this.cache.set(rel, { ...st, content });
      if (content !== null || old?.content != null) changes.push({ path: rel, before: old ? old.content : null, after: content });
    }
    for (const [rel, old] of this.cache) {
      if (!now.has(rel)) {
        this.cache.delete(rel);
        if (old.content !== null) changes.push({ path: rel, before: old.content, after: null });
      }
    }
    return changes;
  }

  /** 把一批变化记入改动记录（by = 谁改的）。返回记录摘要。 */
  record(changes, by, extra = {}) {
    const out = [];
    for (const c of changes) {
      if (c.before === c.after) continue;
      const entry = { id: randomUUID().slice(0, 12), ts: Date.now(), by, path: c.path, before: c.before, after: c.after, ...lineStats(c.before, c.after), ...extra };
      this.history.push(entry);
      out.push(this.summary(entry));
    }
    if (out.length) {
      if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY);
      this.saveHistory();
    }
    return out;
  }

  summary(e) {
    return { id: e.id, ts: e.ts, by: e.by, path: e.path, added: e.added, removed: e.removed, created: e.before == null, deleted: e.after == null, undoOf: e.undoOf, msgId: e.msgId };
  }

  saveHistory() {
    try {
      fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
      fs.writeFileSync(`${this.historyFile}.tmp`, JSON.stringify(this.history), 'utf8');
      fs.renameSync(`${this.historyFile}.tmp`, this.historyFile);
    } catch (e) {
      console.error('保存改动记录失败：', e.message);
    }
  }

  /** AI 发言前：吸收在此之前别人（例如你在外部编辑器里）做的改动，记为“外部”。 */
  begin() {
    const outside = this.refresh();
    return outside.length ? this.record(outside, '外部修改') : [];
  }

  /** AI 发言后：找出它改了什么并记下来。 */
  commit(by, msgId) {
    return this.record(this.refresh(), by, { msgId });
  }

  list() {
    return [...this.scan()].map(([p, st]) => ({ path: p, size: st.size, mtimeMs: st.mtimeMs }))
      .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
  }

  read(rel) {
    const abs = this.resolve(rel);
    const st = fs.statSync(abs);
    if (st.size > MAX_FILE_BYTES * 5) throw new Error('文件太大，无法在软件里打开');
    const text = readText(abs);
    if (text === null) throw new Error('这是二进制文件，无法在软件里打开');
    return text;
  }

  /** 由软件写入文件（你在编辑器里保存，或 API 型 AI 的文件块）。返回改动摘要。 */
  write(rel, content, by, extra = {}) {
    const abs = this.resolve(rel);
    this.begin();
    const key = toPosix(path.relative(this.root, abs));
    const before = this.cache.get(key)?.content ?? (fs.existsSync(abs) ? readText(abs) : null);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    this.refresh();
    return this.record([{ path: key, before, after: content }], by, extra);
  }

  /** 批量写入（不经过 begin，用于 AI 发言过程中，最后统一 commit）。 */
  writeRaw(rel, content) {
    const abs = this.resolve(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  historyList() {
    return this.history.map((e) => this.summary(e)).reverse();
  }

  change(id) {
    const e = this.history.find((h) => h.id === id);
    if (!e) throw new Error('找不到这条改动记录');
    let current = null;
    try { current = this.read(e.path); } catch { current = null; }
    return { ...this.summary(e), before: e.before, after: e.after, current };
  }

  /** 撤销一条改动：文件当前内容必须仍等于那次改动后的内容，否则拒绝（避免覆盖之后的修改）。 */
  undo(id, { force = false } = {}) {
    const e = this.history.find((h) => h.id === id);
    if (!e) throw new Error('找不到这条改动记录');
    this.begin();
    const abs = this.resolve(e.path);
    const current = fs.existsSync(abs) ? readText(abs) : null;
    if (!force && current !== e.after) {
      const err = new Error('这个文件在这次改动之后又被改过了，直接撤销会丢掉后面的修改。');
      err.conflict = true;
      throw err;
    }
    if (e.before == null) fs.rmSync(abs, { force: true });
    else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, e.before, 'utf8'); }
    this.refresh();
    return this.record([{ path: e.path, before: current, after: e.before }], '我', { undoOf: e.id });
  }

  /** 给 API 型 AI 用：当前所有文本文件的内容。 */
  snapshot() {
    this.begin();
    return [...this.cache].filter(([, v]) => v.content != null)
      .map(([p, v]) => ({ path: p, content: v.content }))
      .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
  }
}
