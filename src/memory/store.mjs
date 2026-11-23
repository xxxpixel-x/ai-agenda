import fs from 'node:fs';
import path from 'node:path';
import { t as tr } from '../i18n.mjs';
import { tokenize } from './tokens.mjs';
import { TYPES, normPath } from './rules.mjs';

const firstLayer = (e) => !!TYPES[e.type]?.firstLayer;
const validId = (id) => Number.isSafeInteger(id) && id > 0;
const ascending = (a, b) => a.id - b.id;
const join = (items) => items.join(tr('、'));
const idsText = (ids) => join(ids.map((id) => '#' + id));
const taskIds = (e) => new Set([e.task, ...(e.source?.tasks || []).map((ref) => ref.split('/')[0])].filter(Boolean));
const entryFiles = (e) => [...new Set([...(e.files || []), ...(e.source?.files || [])].map(normPath).filter(Boolean))];
const isText = (s) => typeof s === 'string';
const optionalList = (items, valid) => items == null || (Array.isArray(items) && items.every(valid));
const number = (v) => Number.isFinite(v) && v >= 0 ? v : 0;

export const isRetractRecord = (r) => !!(r && typeof r === 'object' && !Array.isArray(r) && validId(r.id)
  && r.type == null && Array.isArray(r.retracts) && r.retracts.length > 0 && r.retracts.every(validId)
  && (r.seqAt == null || (Number.isSafeInteger(r.seqAt) && r.seqAt >= 0)));

function validEntry(e) {
  return validId(e.id) && Object.hasOwn(TYPES, e.type) && isText(e.text) && e.source && typeof e.source === 'object'
    && optionalList(e.source.messages, validId) && optionalList(e.source.tasks, isText) && optionalList(e.source.files, isText)
    && optionalList(e.topics, isText) && optionalList(e.files, isText)
    && [e.related, e.supersedes, e.resolves, e.conflicts].every((ids) => optionalList(ids, validId))
    && (e.importedAt == null || (Number.isFinite(e.importedAt) && Number.isFinite(new Date(e.importedAt).getTime())));
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function readRawRecords(file) {
  const candidates = [];
  let maxId = 0;
  for (const line of (read(file) || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(tr('记录格式不对'));
      if (validId(row.id)) maxId = Math.max(maxId, row.id);
      if (!validEntry(row) && !isRetractRecord(row)) throw new Error(tr('记录格式不对'));
      candidates.push(row);
    } catch (e) { console.warn(tr('跳过无法读取的记录 {0}：{1}', [path.basename(file), e.message])); }
  }
  candidates.sort(ascending);
  const records = [];
  const seenIds = new Set();
  const businessIds = new Set();
  for (const row of candidates) {
    if (seenIds.has(row.id)) continue;
    if (isRetractRecord(row)) {
      if (row.retracts.some((targetId) => targetId >= row.id || !businessIds.has(targetId))) {
        console.warn(tr('跳过无法读取的记录 {0}：{1}', [path.basename(file), tr('记录格式不对')]));
        continue;
      }
      seenIds.add(row.id);
      records.push(row);
    } else {
      seenIds.add(row.id);
      businessIds.add(row.id);
      records.push(row);
    }
  }
  return { records, maxId };
}

function readLogLines(file) {
  const rows = [];
  for (const line of (read(file) || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(tr('记录格式不对'));
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

// 两遍派生状态：第一遍收集撤回控制行；第二遍 supersedes 扫全部业务行（不自动复活旧 L1），resolves 仅扫未撤回行（重开被解决的问题/分歧）。
function withStatus(rawRecords) {
  const retracted = new Map();
  for (const r of rawRecords) {
    if (!isRetractRecord(r)) continue;
    for (const id of r.retracts) {
      if (!retracted.has(id)) retracted.set(id, { id: r.id, seqAt: number(r.seqAt), addedAt: number(r.addedAt) });
    }
  }
  const replaced = new Map(), resolved = new Map();
  for (const r of rawRecords) {
    if (isRetractRecord(r)) continue;
    for (const id of r.supersedes || []) replaced.set(id, r.id);
    if (!retracted.has(r.id)) {
      for (const id of r.resolves || []) resolved.set(id, r.id);
    }
  }
  const business = [];
  for (const r of rawRecords) {
    if (isRetractRecord(r)) continue;
    const ret = retracted.get(r.id);
    if (ret) {
      business.push({ ...r, status: 'retracted', by: ret.id, retractedSeqAt: ret.seqAt, retractedAt: ret.addedAt });
      continue;
    }
    const by = r.supersededBy || replaced.get(r.id);
    if (by) { business.push({ ...r, status: 'superseded', by }); continue; }
    if (resolved.has(r.id)) { business.push({ ...r, status: 'resolved', by: resolved.get(r.id) }); continue; }
    business.push({ ...r, status: 'active' });
  }
  return business;
}

function entryLine(e) {
  let label = tr(TYPES[e.type].label);
  if (e.type === 'decision') label += '·' + tr(e.origin === 'user' || e.confirmedBy === 'user' ? '你定的' : '默认通过的');
  else if (e.type === 'rejected' && e.origin === 'attempt') {
    const tag = e.attempt?.model || e.attempt?.engine;
    label = tag ? tr('试过走不通·{0}', [tag]) : tr('试过走不通');
  }
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
  if (e.status === 'retracted') return tr('已被 #{0} 撤回', [e.by]);
  if (e.status === 'superseded') return tr('已被 #{0} 取代', [e.by]);
  if (e.status === 'resolved') return tr('已解决：#{0}', [e.by]);
  return tr('有效');
}

function correctionsOf(r, include = () => true, byId = null) {
  if (isRetractRecord(r)) {
    return r.retracts.filter(include).map((id) => {
      const target = byId?.get(id);
      const reopened = (target?.resolves || []).filter((qid) => byId?.get(qid)?.status === 'active');
      const base = tr('#{0} 撤回 #{1}', [r.id, id]);
      return reopened.length ? base + tr('（{0} 重新待处理）', [idsText(reopened)]) : base;
    });
  }
  return [
    ...(r.supersedes || []).filter(include).map((id) => tr('#{0} 取代 #{1}：{2}', [r.id, id, r.text])),
    ...(r.resolves || []).filter(include).map((id) => tr('#{0} 解决 #{1}：{2}', [r.id, id, r.text])),
  ];
}

function ranked(rows, query) {
  const words = new Set(tokenize(query));
  if (!words.size) return [];
  const df = new Map();
  const hits = rows.map((entry) => {
    const content = [entry.text, entry.reason, ...(entry.topics || []), ...entryFiles(entry), entry.scope];
    const matches = [...new Set(tokenize(content.join(' ')))].filter((w) => words.has(w));
    for (const w of matches) df.set(w, (df.get(w) || 0) + 1);
    return { entry, matches };
  });
  return hits.filter((r) => r.matches.length).map(({ entry, matches }) => ({
    entry, score: matches.reduce((n, w) => n + Math.log1p(rows.length / df.get(w)), 0),
  })).sort((a, b) => b.score - a.score || b.entry.id - a.entry.id);
}

const isGlobalMandatory = (e) => e.confirmedBy === 'user' || e.type === 'constraint' || e.type === 'preference'
  || (e.type === 'rejected' && e.origin === 'user') || (e.type === 'decision' && e.origin === 'user');

function globalRows(rawRecords, business, cutoff) {
  const rows = [];
  const byId = new Map(business.map((e) => [e.id, e]));
  const base = withStatus(rawRecords.filter((r) => r.id <= cutoff));
  for (const e of base) {
    if (firstLayer(e) && e.status === 'active') {
      const current = byId.get(e.id);
      rows.push({ e, text: entryLine(e), active: current?.status === 'active', mandatory: current?.status === 'active' && isGlobalMandatory(e) });
    }
  }
  const first = new Set(business.filter(firstLayer).map((e) => e.id));
  for (const r of rawRecords) {
    if (r.id <= cutoff) continue;
    if (isRetractRecord(r)) {
      const lines = correctionsOf(r, (id) => first.has(id), byId);
      if (lines.length) rows.push({ e: r, text: lines.join('\n'), isCorrection: true, active: true, mandatory: true });
      continue;
    }
    if (r.supersededBy) continue;
    const lines = correctionsOf(r, (id) => first.has(id), byId);
    if (firstLayer(r)) lines.unshift(entryLine(r));
    if (lines.length) {
      const current = byId.get(r.id);
      rows.push({ e: r, text: lines.join('\n'), active: current?.status === 'active' || lines.length > (firstLayer(r) ? 1 : 0),
        mandatory: current?.status === 'active' && isGlobalMandatory(r) });
    }
  }
  return rows;
}

function globalActiveRows(business) {
  return business.filter((e) => e.status === 'active' && firstLayer(e)).sort(ascending).map((e) => ({
    e, text: entryLine(e), section: isGlobalMandatory(e) ? 0 : 1, mandatory: isGlobalMandatory(e), active: true,
  }));
}

function workerRows(active, task) {
  const rows = [], used = new Set();
  function section(index, title, entries, mandatory = false) {
    for (const e of entries.sort(ascending)) {
      if (used.has(e.id)) continue;
      used.add(e.id);
      rows.push({ e, section: index, title, text: entryLine(e), mandatory, active: true });
    }
  }
  section(0, tr('全员都要遵守'), active.filter((e) => !e.scope && (
    ['constraint', 'preference'].includes(e.type)
    || (e.type === 'rejected' && e.origin === 'user')
    || (e.type === 'decision' && (e.source.tasks?.includes('plan') || e.confirmedBy === 'user'))
  )), true);
  // 第 2 段先判明确 scope，再匹配无 scope 但归属该任务的条目，避免串入明确属于其他子任务的条目。
  section(1, tr('你的子任务 {0}', [task.id]), active.filter((e) => e.scope === task.id || (!e.scope && taskIds(e).has(task.id))));
  const latest = new Map();
  for (const e of active) if (e.type === 'result' && task.deps?.includes(e.task)) latest.set(e.task, e);
  section(2, tr('前置任务的结果'), [...latest.values()]);
  const taskFiles = new Set((task.files || []).map(normPath).filter(Boolean));
  const candidates = active.filter((e) => !used.has(e.id) && (!e.scope || e.scope === task.id) && TYPES[e.type]?.workerRelated);
  const scores = new Map(ranked(active, task.text).map(({ entry, score }) => [entry.id, score]));
  const fileMatch = (e) => entryFiles(e).some((f) => taskFiles.has(f)) ? 1 : 0;
  candidates.sort((a, b) => fileMatch(b) - fileMatch(a) || (scores.get(b.id) || 0) - (scores.get(a.id) || 0) || b.id - a.id);
  section(3, tr('相关'), candidates.filter((e) => fileMatch(e) || scores.has(e.id)).slice(0, 8));
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

function fit(rows, budget, query, { sectioned = false } = {}) {
  const full = rowText(rows);
  if (!Number.isFinite(budget) || full.length <= budget) return rows;
  const businessRows = rows.filter((r) => !isRetractRecord(r.e)).map((r) => r.e);
  const scores = new Map(ranked(businessRows, query).map(({ entry, score }) => [entry.id, score]));
  const kept = new Set(), headings = new Set();
  let left = budget;
  const tryKeep = (r) => {
    let cost = r.text.length + (kept.size ? 1 : 0);
    if (r.title && !headings.has(r.title)) cost += r.title.length + 5;
    if (cost <= left) { kept.add(r); if (r.title) headings.add(r.title); left -= cost; return true; }
    return false;
  };
  if (sectioned) {
    const groups = new Map();
    for (const r of rows) {
      const sec = r.section ?? 0;
      if (!groups.has(sec)) groups.set(sec, []);
      groups.get(sec).push(r);
    }
    for (const sec of [...groups.keys()].sort((a, b) => a - b)) {
      const order = [...groups.get(sec)].sort((a, b) => (scores.get(b.e.id) || 0) - (scores.get(a.e.id) || 0) || b.e.id - a.e.id);
      for (const r of order) tryKeep(r);
    }
  } else {
    const order = [...rows].sort((a, b) => (scores.get(b.e.id) || 0) - (scores.get(a.e.id) || 0) || b.e.id - a.e.id);
    for (const r of order) tryKeep(r);
  }
  return rows.filter((r) => kept.has(r));
}

function directory(active, { includeFiles = false } = {}) {
  function index(title, keys) {
    const groups = new Map();
    for (const e of active) for (const key of keys(e)) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e.id);
    }
    if (!groups.size) return '';
    return ['### ' + title, ...[...groups].map(([k, ids]) => tr('- {0}：{1}', [k, idsText(ids)]))].join('\n');
  }
  const parts = [index(tr('主题'), (e) => e.topics || []), index(tr('任务'), taskIds)];
  if (includeFiles) parts.push(index(tr('文件'), entryFiles));
  return parts.filter(Boolean).join('\n');
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
  const readAll = () => {
    const { records, maxId } = readRawRecords(file('entries.jsonl'));
    return { records, maxId, business: withStatus(records) };
  };
  const entries = () => readAll().business;
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
  function renderWithIds({ layer = 1, task, budget, query, ids = [], sinceId, mandatoryOnly = false } = {}, snapshot) {
    const snap = snapshot || readAll();
    const rows = snap.business;
    const rawRecords = snap.records;
    const activeRows = rows.filter((e) => e.status === 'active');
    if (layer === 1) {
      const isWorker = !!(task && !task.coordinator);
      let selected;
      let sectioned = false;
      if (sinceId != null) {
        const byId = new Map(rows.map((e) => [e.id, e]));
        const base = isWorker ? workerRows(activeRows, task) : globalRows(rawRecords, rows, state().compactedAt);
        const byEntryId = new Map(base.map((r) => [r.e.id, r]));
        selected = rawRecords.filter((r) => r.id > sinceId).map((r) => {
          const corrs = correctionsOf(r, () => true, byId);
          const fromBase = byEntryId.get(r.id)?.text.split('\n') || [];
          const lines = new Set([...fromBase, ...corrs]);
          const text = [...lines].filter(Boolean).join('\n');
          const hasCorr = corrs.length > 0 || isRetractRecord(r);
          return { e: r, text, section: hasCorr ? 0 : 1, mandatory: hasCorr, active: true };
        }).filter((r) => r.text);
        sectioned = true;
      } else if (isWorker) {
        selected = workerRows(activeRows, task);
        sectioned = true;
      } else {
        selected = globalRows(rawRecords, rows, state().compactedAt);
        if (mandatoryOnly || (Number.isFinite(budget) && rowText(selected).length > budget)) {
          // 一旦触发裁剪，全局视图切回当前有效 L1 投影，绝不发出失效约束却丢掉更正/撤回行。
          selected = globalActiveRows(rows);
          sectioned = true;
        }
      }
      if (mandatoryOnly) selected = selected.filter((r) => r.mandatory);
      const mandatoryCount = selected.filter((r) => r.mandatory).length;
      const kept = fit(selected, budget, query, { sectioned });
      const keptMandatory = kept.filter((r) => r.mandatory).length;
      const activeIds = selected.filter((r) => r.active !== false).map((r) => r.e.id).sort((a, b) => a - b);
      const mandatoryIds = selected.filter((r) => r.mandatory).map((r) => r.e.id).sort((a, b) => a - b);
      return {
        text: rowText(kept),
        entryIds: kept.map((r) => r.e.id).sort((a, b) => a - b),
        activeIds,
        mandatoryIds,
        truncatedMandatory: keptMandatory < mandatoryCount,
      };
    }
    const selected = layer === 2 ? activeRows.filter((e) => e.topics?.length || taskIds(e).size) : rows.filter((e) => ids.includes(e.id));
    return { text: render({ layer, ids }, snap), entryIds: selected.map((e) => e.id) };
  }
  function render({ layer, task, budget, query, ids = [], includeFiles = false } = {}, snapshot) {
    const snap = snapshot || readAll();
    const rows = snap.business;
    const current = rows.filter((e) => e.status === 'active');
    const one = () => renderWithIds({ layer: 1, task, budget, query }, snap).text;
    const two = () => directory(current, { includeFiles });
    const three = () => details(rows, ids, (seq) => validId(seq) && fs.existsSync(msgFile(seq)));
    if (layer === 1) return one();
    if (layer === 2) return two();
    if (layer === 3) return three();
    return [[tr('每轮都带'), one()], [tr('目录'), two()], [tr('条目详情'), three()]]
      .filter(([, body]) => body).map(([title, body]) => '## ' + title + '\n' + body).join('\n\n');
  }
  function rewrite(snap) {
    const rows = snap.business;
    const lines = rows.map((e) => entryLine(e) + (e.status === 'active' ? '' : tr('〔{0}〕', [statusText(e)])));
    const section = (title, body) => ['## ' + tr(title), body].filter(Boolean).join('\n');
    write('memory.md', [tr('这是空间记忆库，可按编号查条目和原话。'), section('每轮都带', render({ layer: 1 }, snap)),
      section('目录', render({ layer: 2, includeFiles: true }, snap)), section('全部条目', lines.join('\n'))].join('\n\n') + '\n');
  }
  return {
    dir, entries, active, render, renderWithIds,
    get latestId() { return readAll().maxId; },
    get: (id) => entries().find((e) => e.id === id),
    append(batch) {
      if (!batch?.length) return [];
      const { records, maxId } = readRawRecords(file('entries.jsonl'));
      let id = maxId;
      const added = batch.map(({ status, by, retractedSeqAt, retractedAt, ...entry }) => ({ ...entry, id: ++id, addedAt: Date.now() }));
      ensure();
      appendLines(file('entries.jsonl'), added);
      const nextRecords = [...records, ...added];
      const business = withStatus(nextRecords);
      rewrite({ records: nextRecords, maxId: id, business });
      const addedIds = new Set(added.map((a) => a.id));
      return business.filter((e) => addedIds.has(e.id));
    },
    retract(targetId, { seqAt = 0 } = {}) {
      const { records, maxId } = readRawRecords(file('entries.jsonl'));
      const business = withStatus(records);
      const target = business.find((e) => e.id === targetId);
      if (!target) throw Object.assign(new Error(tr('条目 #{0} 不存在', [targetId])), { status: 404 });
      if (target.status === 'retracted') {
        const control = records.find((r) => isRetractRecord(r) && r.retracts.includes(targetId));
        return { already: true, control, entry: target };
      }
      const control = {
        id: maxId + 1,
        retracts: [targetId],
        confirmedBy: 'user',
        seqAt: Number.isSafeInteger(seqAt) && seqAt >= 0 ? seqAt : 0,
        addedAt: Date.now(),
      };
      ensure();
      appendLines(file('entries.jsonl'), [control]);
      const nextRecords = [...records, control];
      const nextBusiness = withStatus(nextRecords);
      rewrite({ records: nextRecords, maxId: control.id, business: nextBusiness });
      return { already: false, control, entry: nextBusiness.find((e) => e.id === targetId) };
    },
    corrections(sinceId = 0) {
      const { records, business } = readAll();
      const byId = new Map(business.map((e) => [e.id, e]));
      return records.filter((r) => r.id > sinceId).flatMap((r) => correctionsOf(r, () => true, byId));
    },
    search: (text, { limit = 8, all = false } = {}) => ranked(all ? entries() : active(), text).slice(0, Math.max(0, limit)),
    get lastSeq() { return state().lastSeq; },
    setLastSeq(n) {
      const s = state();
      if (validId(n) && n > s.lastSeq) write('state.json', JSON.stringify({ ...s, lastSeq: n }));
    },
    get compactedAt() { return state().compactedAt; },
    compactableCount() {
      const { records, business } = readAll();
      const cutoff = state().compactedAt;
      const byId = new Map(business.map((e) => [e.id, e]));
      const base = withStatus(records.filter((r) => r.id <= cutoff));
      let count = 0;
      for (const e of base) if (firstLayer(e) && e.status === 'active' && byId.get(e.id)?.status !== 'active') count++;
      for (const r of records) {
        if (r.id <= cutoff) continue;
        if (isRetractRecord(r)) {
          if (r.retracts.some((id) => firstLayer(byId.get(id) || {}))) count++;
        } else if (firstLayer(r) && byId.get(r.id)?.status !== 'active') {
          count++;
        }
      }
      return count;
    },
    compact() {
      const snap = readAll(), compactedAt = snap.maxId;
      write('state.json', JSON.stringify({ ...state(), compactedAt }));
      rewrite(snap);
      return { compactedAt };
    },
    archive(messages, { overwrite = false } = {}) {
      if (messages.length) ensure();
      for (const m of messages) {
        if (!validId(m.seq)) continue;
        const tsValid = Number.isFinite(m.ts) && Number.isFinite(new Date(m.ts).getTime());
        const head = tr('# 消息 {0} · {1} · {2}', [m.seq, m.name || m.kind || '', tsValid ? new Date(m.ts).toISOString() : '']);
        const files = [...new Set((m.changes || []).map((c) => normPath(typeof c === 'string' ? c : c?.path)).filter(Boolean))];
        const tail = files.length ? `\n\n${tr('改动文件：{0}', [join(files)])}` : '';
        const content = `${head}\n\n${m.text || ''}${tail}\n`;
        if (overwrite) {
          fs.writeFileSync(msgFile(m.seq), content);
        } else {
          try { fs.writeFileSync(msgFile(m.seq), content, { flag: 'wx' }); }
          catch (e) { if (e.code !== 'EEXIST') throw e; }
        }
      }
    },
    readMessage: (seq) => validId(seq) ? read(msgFile(seq)) : null,
    log: (record) => { ensure(); appendLines(file('organize.jsonl'), [record]); },
    logs: (limit = 20) => limit > 0 ? readLogLines(file('organize.jsonl')).slice(-limit) : [],
  };
}
