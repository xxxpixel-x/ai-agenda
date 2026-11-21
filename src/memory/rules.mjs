import { t as tr } from '../i18n.mjs';
import { tokenize } from './tokens.mjs';

const decisions = ['decision', 'constraint', 'preference', 'rejected'];
const openTypes = ['question', 'proposal', 'disagreement'];
const types = [...decisions, ...openTypes, 'fact', 'result'];
const operations = ['add', 'supersede', 'resolve', 'reject', 'disagree'];
const unique = (items) => [...new Set(items)];
const list = (value) => Array.isArray(value) ? value : [];
const clean = (s) => typeof s === 'string' ? s.trim().replace(/[\r\n]+/g, ' ') : '';
const strings = (v) => unique(list(v).map(clean).filter(Boolean));
const fail = (key, ...vars) => ({ ok: false, reason: tr(key, vars) });
const live = (e) => !e.status || e.status === 'active';
const number = (v) => Number.isFinite(v) && v >= 0 ? v : 0;

// 出处和时间一起核实。导入的日期与原话的日期分开记。
function evidence(entry, op, ctx) {
  const proof = { user: false, acted: false, observed: false };
  if (!ctx) {
    entry.at = number(op.at);
    proof.user = entry.origin === 'user' || ['constraint', 'preference'].includes(entry.type);
    return proof;
  }
  let taskTime = 0;
  for (const ref of entry.source.tasks) {
    const [id, attemptNo, ...rest] = ref.split('/');
    const task = ctx.tasks?.get(id);
    if (!task) return fail('出处里的任务 {0} 不存在', id);
    if (attemptNo !== undefined) {
      const attempt = task.attempts?.find((a, i) => String(a.n ?? i + 1) === attemptNo);
      if (!attempt || rest.length) return fail('出处里的执行 {0} 不存在', ref);
      proof.acted ||= !attempt.error && !['failed', 'question', 'cancelled', 'stopped'].includes(attempt.outcome)
        && !!(attempt.endedAt || attempt.outcome);
      taskTime = Math.max(taskTime, number(attempt.endedAt ?? task.approvedAt));
    } else {
      proof.acted ||= task.status === 'approved';
      taskTime = Math.max(taskTime, number(task.approvedAt));
    }
  }
  for (const seq of entry.source.messages) {
    const m = ctx.messages?.get(seq);
    if (!m) return fail('出处里的消息 {0} 不存在', seq);
    let at = number(m.ts);
    if (m.kind === 'import') {
      entry.importedAt = Math.max(entry.importedAt ?? 0, at);
      at = Number.isFinite(op.at) && op.at >= 0 && op.at <= at ? op.at : number(m.originalTs);
    }
    entry.at = Math.max(entry.at, at);
    proof.handoff ||= !!ctx.handoffSeqs?.has(seq);
    proof.user ||= m.kind === 'user' || m.kind === 'import';
    proof.acted ||= m.kind === 'ai' && m.changes === true;
    proof.observed ||= m.activities === true || m.changes === true;
  }
  if (!entry.source.messages.length) entry.at = taskTime;
  return proof;
}

function sameSubject(a, b) {
  // 子任务编号本身就标识同一项交付，重做后的报告可以完全不同。
  if (a.type === 'result' || b.type === 'result') return a.type === b.type && a.task === b.task;
  if (!(decisions.includes(a.type) && decisions.includes(b.type)) && a.type !== b.type) return false;
  if (a.topics.some((t) => b.topics?.includes(t))) return true;
  const words = (e) => tokenize([e.text, ...(e.topics || [])].join(' '));
  const old = new Set(words(b));
  return words(a).some((w) => old.has(w));
}

function latestTarget(target, byId) {
  const seen = new Set();
  while (target?.status === 'superseded' && !seen.has(target.id)) {
    seen.add(target.id);
    target = byId.get(target.by ?? target.supersededBy);
  }
  return target && live(target) ? target : null;
}

function parseEntry(op, byId) {
  if (!op || typeof op !== 'object' || !operations.includes(op.op ?? 'add')) return fail('未知的整理操作');
  const type = ({ reject: 'rejected', disagree: 'disagreement' })[op.op] ?? op.type;
  if (!types.includes(type)) return fail('未知的条目类型');
  const text = clean(op.text).slice(0, 300);
  const reason = clean(op.reason).slice(0, 200);
  if (!text) return fail('条目内容为空');
  if (['decision', 'constraint', 'rejected'].includes(type) && !reason) return fail('没有写原因');
  const source = { messages: unique(list(op.source?.messages)), tasks: strings(op.source?.tasks), files: strings(op.source?.files) };
  const task = clean(op.task);
  if (!source.messages.length && !source.tasks.length && !source.files.length) return fail('没有出处');
  if (source.messages.some((seq) => !Number.isSafeInteger(seq) || seq < 1)) return fail('消息编号不合法');
  if (type === 'result') {
    if (!task) return fail('任务结果没有子任务编号');
    if (!source.tasks.some((ref) => ref.split('/')[0] === task)) source.tasks.push(task);
  }
  const entry = { type, text, source, related: unique(list(op.related)).filter((id) => byId.has(id)).slice(0, 10),
    files: strings(op.files).slice(0, 10), topics: strings(op.topics).slice(0, 10), scope: clean(op.scope), at: 0 };
  if (reason) entry.reason = reason;
  if (task) entry.task = task;
  if (op.ask === true || op.op === 'disagree') entry.ask = true;
  if (clean(op.answers)) entry.answers = clean(op.answers);
  if (type === 'decision') entry.origin = op.origin === 'user' ? 'user' : 'default';
  if (['constraint', 'preference'].includes(type)) entry.origin = 'user';
  return { ok: true, entry };
}

function classify(entry, proof, op, notes) {
  const { type, source } = entry;
  if (type === 'decision') entry.origin = proof.user && op.origin !== 'default' ? 'user' : 'default';
  if ((type === 'decision' && entry.origin === 'default' && !proof.acted)
    || (['constraint', 'preference'].includes(type) && !proof.user)) {
    entry.type = 'proposal';
    delete entry.origin;
    notes.push(tr('AI 的建议没有依据成为决定或约束，记成提议'));
  }
  if (type === 'fact' && !(proof.user || proof.observed || source.tasks.length || source.files.length)) return fail('AI 没验证过的说法不算项目事实');
  if (type === 'rejected' && !(proof.user || proof.handoff || source.tasks.length)) return fail('否决过需要你的原话或任务出处');
}

function linkTargets(op, entry, type, byId, proof, notes) {
  const replaces = [...list(op.supersedes)];
  const resolves = [...list(op.resolves)];
  if (op.op === 'supersede') replaces.push(op.target);
  if (op.op === 'resolve' || (op.op === 'reject' && op.target != null)) resolves.push(op.target);
  if (type === 'result') {
    const results = [...byId.values()].filter((e) => e.type === 'result' && e.task === entry.task);
    const attempts = entry.source.tasks.filter((ref) => ref.startsWith(entry.task + '/'));
    const repeated = results.find((e) => attempts.some((ref) => e.source.tasks?.includes(ref)));
    if (repeated) return fail('这次执行已经记为 #{0}', repeated.id);
    const prior = results.findLast(live);
    if (prior) replaces.push(prior.id);
  }

  let historical;
  const supersedes = [], conflicts = [];
  for (const id of unique(replaces)) {
    const target = byId.get(id);
    if (!target) return fail('条目 #{0} 不存在', id);
    const older = entry.at < target.at;
    const current = older ? latestTarget(target, byId) : target;
    if (!current || !live(current)) return fail(target.status === 'resolved' ? '#{0} 已经解决了' : '#{0} 已经被取代了', id);
    if (openTypes.includes(target.type)) { resolves.push(id); continue; }
    if (!sameSubject({ ...entry, type }, target)) return fail('看不出和 #{0} 是同一件事', id);
    if (entry.scope !== clean(target.scope)) return fail('适用范围不同');
    if (target.reason && !entry.answers && type !== 'result') return fail('没有回应 #{0} 的原因', id);
    if (older) {
      if (!historical || current.at > historical.at || (current.at === historical.at && current.id > historical.id)) historical = current;
    } else if ((target.origin === 'user' || ['constraint', 'preference'].includes(target.type)) && !proof.user) conflicts.push(target.id);
    else if (entry.type !== 'proposal') supersedes.push(id);
  }
  for (const id of unique(resolves)) {
    const target = byId.get(id);
    if (!target || !live(target) || !openTypes.includes(target.type)) return fail('#{0} 不是有效的问题、提议或分歧', id);
  }
  if (historical) {
    entry.supersededBy = historical.id;
    notes.push(tr('原话更早，作为已被 #{0} 取代的历史写入', [historical.id]));
  } else if (conflicts.length) {
    entry.type = 'disagreement';
    entry.ask = true;
    entry.related = unique([...conflicts, ...entry.related]).slice(0, 10);
    entry.text = tr('和 #{0} 不一致：{1}', [conflicts[0], entry.text]).slice(0, 300);
    delete entry.origin;
    for (const id of conflicts) notes.push(tr('你定的 #{0} 只有你能改，记成分歧', [id]));
  } else {
    if (supersedes.length) entry.supersedes = supersedes;
    if (resolves.length) {
      if (entry.type === 'proposal' && type !== 'proposal') notes.push(tr('转成提议后不能解决其他条目'));
      else entry.resolves = unique(resolves);
    }
  }
}

export function check(op, entries = [], ctx) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const parsed = parseEntry(op, byId);
  if (!parsed.ok) return parsed;
  const { entry } = parsed;
  const type = entry.type;
  const proof = evidence(entry, op, ctx);
  if (proof.ok === false) return proof;
  const notes = [];
  if (ctx) {
    const invalid = classify(entry, proof, op, notes);
    if (invalid) return invalid;
  }
  const invalid = linkTargets(op, entry, type, byId, proof, notes);
  if (invalid) return invalid;
  const compactText = (s) => s.replace(/\s/g, '');
  const duplicate = entries.find((e) => live(e) && e.type === entry.type && compactText(e.text) === compactText(entry.text));
  if (duplicate) return fail('和 #{0} 重复', duplicate.id);
  return { ok: true, entry, ...(notes.length ? { note: notes.join(tr('；')) } : {}) };
}

export function normalizeOrganizerResult(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const fenced = !/^[\s]*[\[{]/.test(raw) && raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
    const data = JSON.parse(fenced ? fenced[1] : raw);
    const ops = Array.isArray(data) ? data : data?.ops;
    return Array.isArray(ops) ? { ops, ...(typeof data.recap === 'string' ? { recap: data.recap.trim() } : {}) } : null;
  } catch { return null; }
}

export const normalizeOps = (raw) => normalizeOrganizerResult(raw)?.ops ?? null;
