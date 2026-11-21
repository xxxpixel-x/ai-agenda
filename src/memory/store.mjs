import fs from 'node:fs';
import path from 'node:path';
import { t as tr } from '../i18n.mjs';
import { tokenize } from './tokens.mjs';

const labels = { decision: '决定', constraint: '约束', fact: '项目事实', preference: '偏好', question: '问题',
  proposal: '提议', disagreement: '分歧', rejected: '否决过', result: '任务结果' };
const firstLayer = (e) => ['decision', 'constraint', 'preference', 'rejected'].includes(e.type);
const validId = (id) => Number.isSafeInteger(id) && id > 0;
const ascending = (a, b) => a.id - b.id;
const join = (items) => items.join(tr('、'));
const idsText = (ids) => join(ids.map((id) => '#' + id));
const taskIds = (e) => new Set([e.task, ...(e.source.tasks || []).map((ref) => ref.split('/')[0])].filter(Boolean));
const isText = (s) => typeof s === 'string';
const optionalList = (items, valid) => items == null || (Array.isArray(items) && items.every(valid));

function validEntry(e) {
  return validId(e.id) && Object.hasOwn(labels, e.type) && isText(e.text) && e.source && typeof e.source === 'object'
    && optionalList(e.source.messages, validId) && optionalList(e.source.tasks, isText) && optionalList(e.source.files, isText)
    && optionalList(e.topics, isText) && optionalList(e.files, isText)
    && [e.related, e.supersedes, e.resolves].every((ids) => optionalList(ids, validId))
    && (e.importedAt == null || (Number.isFinite(e.importedAt) && Number.isFinite(new Date(e.importedAt).getTime())));
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function readLines(file, valid) {
  const rows = [];
  for (const line of (read(file) || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row) || !valid(row)) throw new Error(tr('记录格式不对'));
      rows.push(row);
    } catch (e) { console.warn(tr('跳过无法读取的记录 {0}：{1}', [path.basename(file), e.message])); }
  }
  return rows;
}

// 上一次写入可能中断在半行；保留原字节，把新记录写在新的一行。
function appendLines(file, rows) {
  if (!rows.length) return;
  const fd = fs.openSync(file, 'a+');
  try {
    const size = fs.fstatSync(fd).size;
    const last = Buffer.alloc(1);
    if (size) fs.readSync(fd, last, 0, 1, size - 1);
    const prefix = size && last[0] !== 10 ? '\n' : '';
    fs.writeFileSync(fd, prefix + rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  } finally { fs.closeSync(fd); }
}

function withStatus(rows) {
  const replaced = new Map(), resolved = new Map();
  for (const e of rows) {
    for (const id of e.supersedes || []) replaced.set(id, e.id);
    for (const id of e.resolves || []) resolved.set(id, e.id);
  }
  return rows.map((e) => {
    const by = e.supersededBy || replaced.get(e.id);
    if (by) return { ...e, status: 'superseded', by };
    if (resolved.has(e.id)) return { ...e, status: 'resolved', by: resolved.get(e.id) };
    return { ...e, status: 'active' };
  });
}

function entryLine(e) {
  let label = tr(labels[e.type]);
  if (e.type === 'decision') label += '·' + tr(e.origin === 'user' ? '你定的' : '默认通过的');
  if (e.ask) label += '·' + tr('问你');
  const sources = [];
  if (e.source.messages?.length) sources.push(tr('消息 {0}', [join(e.source.messages)]));
  for (const ref of e.source.tasks || []) {
    const [id, n] = ref.split('/');
    sources.push(n ? tr('任务 {0} 第 {1} 次执行', [id, n]) : tr('任务 {0}', [id]));
  }
  if (e.source.files?.length) sources.push(tr('文件 {0}', [join(e.source.files)]));
  let source = tr('出处：{0}', [join(sources)]);
  if (e.importedAt != null) source += tr('；导入于 {0}', [new Date(e.importedAt).toISOString().slice(0, 10)]);
  if (e.related?.length) source += tr('；相关：{0}', [idsText(e.related)]);
  return tr('#{0} [{1}] {2}（{3}）', [e.id, label, e.text + (e.reason ? tr('——{0}', [e.reason]) : ''), source]);
}

function statusText(e) {
  if (e.status === 'superseded') return tr('已被 #{0} 取代', [e.by]);
  if (e.status === 'resolved') return tr('已解决：#{0}', [e.by]);
  return tr('有效');
}

function correctionsOf(e, include = () => true) {
  return [
    ...(e.supersedes || []).filter(include).map((id) => tr('#{0} 取代 #{1}：{2}', [e.id, id, e.text])),
    ...(e.resolves || []).filter(include).map((id) => tr('#{0} 解决 #{1}：{2}', [e.id, id, e.text])),
  ];
}

function ranked(rows, query) {
  const words = new Set(tokenize(query));
  if (!words.size) return [];
  const df = new Map();
  const hits = rows.map((entry) => {
    const content = [entry.text, entry.reason, ...(entry.topics || []), ...(entry.files || []), entry.scope];
    const matches = [...new Set(tokenize(content.join(' ')))].filter((w) => words.has(w));
    for (const w of matches) df.set(w, (df.get(w) || 0) + 1);
    return { entry, matches };
  });
  return hits.filter((r) => r.matches.length).map(({ entry, matches }) => ({
    entry, score: matches.reduce((n, w) => n + Math.log1p(rows.length / df.get(w)), 0),
  })).sort((a, b) => b.score - a.score || b.entry.id - a.entry.id);
}

function globalRows(entries, cutoff) {
  const rows = [];
  const base = withStatus(entries.filter((e) => e.id <= cutoff));
  for (const e of base) if (firstLayer(e) && e.status === 'active') rows.push({ e, text: entryLine(e) });
  const first = new Set(entries.filter(firstLayer).map((e) => e.id));
  for (const e of entries) {
    if (e.id <= cutoff || e.supersededBy) continue;
    const lines = correctionsOf(e, (id) => first.has(id));
    if (firstLayer(e)) lines.unshift(entryLine(e));
    if (lines.length) rows.push({ e, text: lines.join('\n') });
  }
  return rows;
}

function workerRows(active, task) {
  const rows = [], used = new Set();
  function section(title, entries) {
    for (const e of entries.sort(ascending)) {
      if (used.has(e.id)) continue;
      used.add(e.id);
      rows.push({ e, title, text: entryLine(e) });
    }
  }
  section(tr('全员都要遵守'), active.filter((e) => !e.scope && (['constraint', 'preference', 'rejected'].includes(e.type) || (e.type === 'decision' && e.source.tasks?.includes('plan')))));
  section(tr('你的子任务 {0}', [task.id]), active.filter((e) => e.scope === task.id || taskIds(e).has(task.id)));
  const latest = new Map();
  for (const e of active) if (e.type === 'result' && task.deps?.includes(e.task)) latest.set(e.task, e);
  section(tr('前置任务的结果'), [...latest.values()]);
  const candidates = active.filter((e) => !used.has(e.id) && ['decision', 'fact', 'question', 'proposal', 'disagreement'].includes(e.type));
  const scores = new Map(ranked(active, task.text).map(({ entry, score }) => [entry.id, score]));
  const fileMatch = (e) => e.files?.some((f) => task.files?.includes(f)) ? 1 : 0;
  candidates.sort((a, b) => fileMatch(b) - fileMatch(a) || (scores.get(b.id) || 0) - (scores.get(a.id) || 0) || b.id - a.id);
  section(tr('相关'), candidates.filter((e) => fileMatch(e) || scores.has(e.id)).slice(0, 8));
  return rows;
}

function rowText(rows) {
  const lines = [];
  let lastTitle;
  for (const { title, text } of rows) {
    if (title && title !== lastTitle) lines.push('### ' + title);
    lastTitle = title;
    lines.push(text);
  }
  return lines.join('\n');
}

function fit(rows, budget, query) {
  const full = rowText(rows);
  if (!Number.isFinite(budget) || full.length <= budget) return rows;
  const scores = new Map(ranked(rows.map((r) => r.e), query).map(({ entry, score }) => [entry.id, score]));
  const order = [...rows].sort((a, b) => (scores.get(b.e.id) || 0) - (scores.get(a.e.id) || 0) || b.e.id - a.e.id);
  const kept = new Set(), headings = new Set();
  let left = budget;
  for (const r of order) {
    let cost = r.text.length + (kept.size ? 1 : 0);
    if (r.title && !headings.has(r.title)) cost += r.title.length + 5;
    if (cost <= left) { kept.add(r); headings.add(r.title); left -= cost; }
  }
  return rows.filter((r) => kept.has(r));
}

function directory(active) {
  function index(title, keys) {
    const groups = new Map();
    for (const e of active) for (const key of keys(e)) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e.id);
    }
    if (!groups.size) return '';
    return ['### ' + title, ...[...groups].map(([k, ids]) => tr('- {0}：{1}', [k, idsText(ids)]))].join('\n');
  }
  return [index(tr('主题'), (e) => e.topics || []), index(tr('任务'), taskIds)].filter(Boolean).join('\n');
}

function details(entries, ids, archived) {
  if (!ids.length) return '';
  const selected = new Set(ids);
  const before = new Map(), after = new Map();
  function edge(from, to) {
    if (!before.has(to)) before.set(to, []);
    if (!after.has(from)) after.set(from, []);
    before.get(to).push(from);
    after.get(from).push(to);
  }
  for (const e of entries) {
    for (const old of e.supersedes || []) edge(old, e.id);
    if (e.supersededBy) edge(e.id, e.supersededBy);
  }
  function chain(id, links) {
    const seen = new Set([id]);
    for (const n of seen) for (const next of links.get(n) || []) seen.add(next);
    seen.delete(id);
    return [...seen];
  }
  return entries.filter((e) => selected.has(e.id)).map((e) => {
    const lines = [entryLine(e), tr('状态：{0}', [statusText(e)])];
    const older = chain(e.id, before), newer = chain(e.id, after);
    if (older.length) lines.push(tr('取代了：{0}', [idsText(older)]));
    if (newer.length) lines.push(tr('后来被取代：{0}', [idsText(newer)]));
    if (e.answers) lines.push(tr('回应：{0}', [e.answers]));
    for (const seq of e.source.messages || []) if (archived(seq)) lines.push(`messages/${seq}.md`);
    return lines.join('\n');
  }).join('\n\n');
}

export function openMemory(dir) {
  const file = (name) => path.join(dir, name);
  const ensure = () => fs.mkdirSync(file('messages'), { recursive: true }); // 写的时候才建目录，只读不留下空目录
  const msgFile = (seq) => file(`messages/${seq}.md`);
  const entries = () => withStatus(readLines(file('entries.jsonl'), validEntry).sort(ascending));
  const active = () => entries().filter((e) => e.status === 'active');
  function state() {
    const initial = { lastSeq: 0, compactedAt: 0 };
    const raw = read(file('state.json'));
    if (raw == null) return initial;
    try {
      const s = JSON.parse(raw);
      if (![s.lastSeq, s.compactedAt].every((n) => n === 0 || validId(n))) throw new Error(tr('记录格式不对'));
      return s;
    } catch (e) { console.warn(tr('跳过无法读取的记录 {0}：{1}', ['state.json', e.message])); return initial; }
  }
  function write(name, data) {
    ensure();
    fs.writeFileSync(file(name + '.tmp'), data);
    fs.renameSync(file(name + '.tmp'), file(name));
  }
  function renderWithIds({ layer = 1, task, budget, query, ids = [], sinceId } = {}, rows = entries()) {
    const active = rows.filter((e) => e.status === 'active');
    if (layer === 1) {
      let selected = task && !task.coordinator ? workerRows(active, task) : globalRows(rows, state().compactedAt);
      if (sinceId != null) {
        const byId = new Map(selected.map((r) => [r.e.id, r]));
        selected = rows.filter((e) => e.id > sinceId).map((e) => {
          const lines = new Set([...(byId.get(e.id)?.text.split('\n') || []), ...correctionsOf(e)]);
          return { e, text: [...lines].join('\n') };
        }).filter((r) => r.text);
      }
      const kept = fit(selected, budget, query);
      return { text: rowText(kept), entryIds: kept.map((r) => r.e.id).sort((a, b) => a - b) };
    }
    const selected = layer === 2 ? active.filter((e) => e.topics?.length || taskIds(e).size) : rows.filter((e) => ids.includes(e.id));
    return { text: render({ layer, ids }, rows), entryIds: selected.map((e) => e.id) };
  }
  function render({ layer, task, budget, query, ids = [] } = {}, rows = entries()) {
    const current = rows.filter((e) => e.status === 'active');
    const one = () => renderWithIds({ layer: 1, task, budget, query }, rows).text;
    const two = () => directory(current);
    const three = () => details(rows, ids, (seq) => validId(seq) && fs.existsSync(msgFile(seq)));
    if (layer === 1) return one();
    if (layer === 2) return two();
    if (layer === 3) return three();
    return [[tr('每轮都带'), one()], [tr('目录'), two()], [tr('条目详情'), three()]]
      .filter(([, body]) => body).map(([title, body]) => '## ' + title + '\n' + body).join('\n\n');
  }
  function rewrite(rows) {
    const lines = rows.map((e) => entryLine(e) + (e.status === 'active' ? '' : tr('〔{0}〕', [statusText(e)])));
    const section = (title, body) => ['## ' + tr(title), body].filter(Boolean).join('\n');
    write('memory.md', [tr('这是空间记忆库，可按编号查条目和原话。'), section('每轮都带', render({ layer: 1 }, rows)),
      section('目录', render({ layer: 2 }, rows)), section('全部条目', lines.join('\n'))].join('\n\n') + '\n');
  }
  return {
    dir, entries, active, render, renderWithIds,
    get: (id) => entries().find((e) => e.id === id),
    append(batch) {
      const rows = entries();
      let id = rows.at(-1)?.id || 0;
      const added = batch.map(({ status, by, ...entry }) => ({ ...entry, id: ++id, addedAt: Date.now() }));
      ensure();
      appendLines(file('entries.jsonl'), added);
      const updated = withStatus([...rows, ...added]);
      rewrite(updated);
      return updated.slice(rows.length);
    },
    corrections: (sinceId = 0) => entries().filter((e) => e.id > sinceId).flatMap((e) => correctionsOf(e)),
    search: (text, { limit = 8, all = false } = {}) => ranked(all ? entries() : active(), text).slice(0, Math.max(0, limit)),
    get lastSeq() { return state().lastSeq; },
    setLastSeq(n) {
      const s = state();
      if (validId(n) && n > s.lastSeq) write('state.json', JSON.stringify({ ...s, lastSeq: n }));
    },
    get compactedAt() { return state().compactedAt; },
    compact() {
      const rows = entries(), compactedAt = rows.at(-1)?.id || 0;
      write('state.json', JSON.stringify({ ...state(), compactedAt }));
      rewrite(rows);
      return { compactedAt };
    },
    archive(messages) {
      if (messages.length) ensure();
      for (const m of messages) {
        if (!validId(m.seq)) continue;
        const head = tr('# 消息 {0} · {1} · {2}', [m.seq, m.name || m.kind || '', Number.isFinite(m.ts) ? new Date(m.ts).toISOString() : '']);
        const tail = m.changes?.length ? `\n\n${tr('改动文件：{0}', [join(m.changes)])}` : '';
        try { fs.writeFileSync(msgFile(m.seq), `${head}\n\n${m.text || ''}${tail}\n`, { flag: 'wx' }); }
        catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
    },
    readMessage: (seq) => validId(seq) ? read(msgFile(seq)) : null,
    log: (record) => { ensure(); appendLines(file('organize.jsonl'), [record]); },
    logs: (limit = 20) => limit > 0 ? readLines(file('organize.jsonl'), () => true).slice(-limit) : [],
  };
}
