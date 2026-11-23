import { t as tr } from '../i18n.mjs';
import { tokenize } from './tokens.mjs';

export const TYPES = {
  decision: { label: '决定', firstLayer: true, decisionGroup: true, open: false, needsReason: true, workerRelated: true },
  constraint: { label: '约束', firstLayer: true, decisionGroup: true, open: false, needsReason: true, workerRelated: false },
  preference: { label: '偏好', firstLayer: true, decisionGroup: true, open: false, needsReason: false, workerRelated: false },
  rejected: { label: '否决过', firstLayer: true, decisionGroup: true, open: false, needsReason: true, workerRelated: true },
  fact: { label: '项目事实', firstLayer: false, decisionGroup: false, open: false, needsReason: false, workerRelated: true },
  result: { label: '任务结果', firstLayer: false, decisionGroup: false, open: false, needsReason: false, workerRelated: true },
  question: { label: '问题', firstLayer: false, decisionGroup: false, open: true, needsReason: false, workerRelated: true },
  proposal: { label: '提议', firstLayer: false, decisionGroup: false, open: true, needsReason: false, workerRelated: true },
  disagreement: { label: '分歧', firstLayer: false, decisionGroup: false, open: true, needsReason: false, workerRelated: true },
};

const types = Object.keys(TYPES);
const operations = ['add', 'supersede', 'resolve', 'reject', 'disagree'];
const unique = (items) => [...new Set(items)];
const list = (value) => Array.isArray(value) ? value : [];
const clean = (s) => typeof s === 'string' ? s.trim().replace(/[\r\n]+/g, ' ') : '';
const strings = (v) => unique(list(v).map(clean).filter(Boolean));
export const normPath = (p) => clean(p).replace(/\\/g, '/').replace(/^\.\//, '');
const paths = (v) => unique(list(v).map(normPath).filter(Boolean));
const fail = (key, ...vars) => ({ ok: false, reason: tr(key, vars) });
const live = (e) => !e.status || e.status === 'active';
const number = (v) => Number.isFinite(v) && v >= 0 ? v : 0;
const compactText = (s) => clean(s).replace(/\s/g, '');
const isOpen = (type) => !!TYPES[type]?.open;
const isDecisionGroup = (type) => !!TYPES[type]?.decisionGroup;
const isUserProtected = (e) => e.confirmedBy === 'user' || e.origin === 'user' || ['constraint', 'preference'].includes(e.type);

function pickAttemptMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const out = {};
  if (clean(meta.memberId)) out.memberId = clean(meta.memberId);
  if (clean(meta.engine)) out.engine = clean(meta.engine);
  if (clean(meta.model)) out.model = clean(meta.model);
  return Object.keys(out).length ? out : null;
}

// 出处和时间一起核实。导入的日期与原话的日期分开记。
function evidence(entry, op, ctx) {
  const proof = { user: false, acted: false, observed: false, handoff: false, verifiedFile: false,
    handoffMeta: null, taskAttempt: null, freshUserSeqs: [], taskAttemptTimes: [] };
  if (!ctx) {
    entry.at = number(op.at);
    proof.user = entry.origin === 'user' || ['constraint', 'preference'].includes(entry.type);
    proof.verifiedFile = entry.source.files.length > 0;
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
      const t = number(attempt.endedAt ?? task.approvedAt);
      taskTime = Math.max(taskTime, t);
      proof.taskAttemptTimes.push({ ref, time: t });
      if (!proof.taskAttempt) proof.taskAttempt = pickAttemptMeta(attempt);
    } else {
      proof.acted ||= task.status === 'approved';
      const t = number(task.approvedAt);
      taskTime = Math.max(taskTime, t);
      proof.taskAttemptTimes.push({ ref, time: t });
      const last = task.attempts?.at(-1);
      if (!proof.taskAttempt && last) proof.taskAttempt = pickAttemptMeta(last);
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
    const inBatch = m.inBatch !== false;
    const isHandoff = !!ctx.handoffSeqs?.has(seq);
    proof.handoff ||= isHandoff;
    if (isHandoff && !proof.handoffMeta) proof.handoffMeta = pickAttemptMeta(ctx.handoffs?.get(seq));
    // 交接锚点不计入用户证据；普通聊天用户证据仅认本批展示范围内的消息。
    if (inBatch && !isHandoff && (m.kind === 'user' || m.kind === 'import')) {
      proof.user = true;
      if (m.kind === 'user') proof.freshUserSeqs.push(seq);
    }
    proof.acted ||= m.kind === 'ai' && m.changes === true;
    proof.observed ||= m.activities === true || m.changes === true;
  }
  if (!entry.source.messages.length || taskTime > entry.at) entry.at = Math.max(entry.at, taskTime);
  proof.verifiedFile = ctx.knownFiles
    ? entry.source.files.some((f) => ctx.knownFiles.has(normPath(f)))
    : entry.source.files.length > 0;
  return proof;
}

function sameSubject(a, b) {
  // 子任务编号本身就标识同一项交付，重做后的报告可以完全不同。
  if (a.type === 'result' || b.type === 'result') return a.type === b.type && a.task === b.task;
  if (!(isDecisionGroup(a.type) && isDecisionGroup(b.type)) && a.type !== b.type) return false;
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
  if (TYPES[type].needsReason && !reason) return fail('没有写原因');
  const source = { messages: unique(list(op.source?.messages)), tasks: strings(op.source?.tasks), files: paths(op.source?.files) };
  const task = clean(op.task);
  if (!source.messages.length && !source.tasks.length && !source.files.length) return fail('没有出处');
  if (source.messages.some((seq) => !Number.isSafeInteger(seq) || seq < 1)) return fail('消息编号不合法');
  if (type === 'result') {
    if (!task) return fail('任务结果没有子任务编号');
    if (!source.tasks.some((ref) => ref.split('/')[0] === task)) source.tasks.push(task);
  }
  const entry = { type, text, source, related: unique(list(op.related)).filter((id) => byId.has(id)).slice(0, 10),
    files: paths(op.files).slice(0, 10), topics: strings(op.topics).slice(0, 10), scope: clean(op.scope), at: 0 };
  if (reason) entry.reason = reason;
  if (task) entry.task = task;
  if (op.ask === true || op.op === 'disagree') entry.ask = true;
  if (clean(op.answers)) entry.answers = clean(op.answers);
  if (type === 'decision') entry.origin = op.origin === 'user' ? 'user' : 'default';
  if (['constraint', 'preference'].includes(type)) entry.origin = 'user';
  if (type === 'rejected' && (op.origin === 'user' || op.origin === 'attempt')) entry.origin = op.origin;
  const attempt = pickAttemptMeta(op.attempt);
  if (type === 'rejected' && entry.origin === 'attempt' && attempt) entry.attempt = attempt;
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
  if (type === 'fact' && !(proof.user || proof.observed || source.tasks.length || proof.verifiedFile)) {
    return fail('AI 没验证过的说法不算项目事实');
  }
  if (type === 'rejected') {
    if (proof.handoff) {
      entry.origin = 'attempt';
      if (proof.handoffMeta) entry.attempt = proof.handoffMeta;
    } else if (proof.user && op.origin !== 'attempt') {
      entry.origin = 'user';
      delete entry.attempt;
    } else if (source.tasks.length) {
      entry.origin = 'attempt';
      if (proof.taskAttempt) entry.attempt = proof.taskAttempt;
    } else {
      return fail('否决过需要你的原话或任务出处');
    }
  }
}

function linkTargets(op, entry, type, byId, proof, notes) {
  const replaces = [...list(op.supersedes)];
  const resolves = [...list(op.resolves)];
  if (op.op === 'supersede' && (op.target != null || !replaces.length)) replaces.push(op.target);
  if ((op.op === 'resolve' && (op.target != null || !resolves.length)) || (op.op === 'reject' && op.target != null)) resolves.push(op.target);
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
    if (target.status === 'retracted') return fail('#{0} 已经撤回了', id);
    if (target.status === 'resolved') return fail('#{0} 已经解决了', id);
    // 先沿取代链找到当前有效链头，再比较时间与校验权威，防链中补导被拒及绕过链头保护。
    const current = live(target) ? target : latestTarget(target, byId);
    if (!current || !live(current)) return fail('#{0} 已经被取代了', id);
    if (isOpen(current.type)) { resolves.push(current.id); continue; }
    if (!sameSubject({ ...entry, type }, current)) return fail('看不出和 #{0} 是同一件事', current.id);
    if (entry.scope !== clean(current.scope)) return fail('适用范围不同');
    if (current.reason && !entry.answers && type !== 'result') return fail('没有回应 #{0} 的原因', current.id);
    const older = entry.at < current.at;
    if (older) {
      if (!historical || current.at > historical.at || (current.at === historical.at && current.id > historical.id)) historical = current;
    } else if (current.confirmedBy === 'user' || (isUserProtected(current) && !proof.user)) {
      conflicts.push(current.id);
    } else if (entry.type !== 'proposal') {
      supersedes.push(current.id);
    }
  }
  if (historical && conflicts.length) return fail('同一条操作同时涉及历史记录和冲突目标，请拆分开');
  for (const id of unique(resolves)) {
    const target = byId.get(id);
    if (!target || !live(target) || !isOpen(target.type)) return fail('#{0} 不是有效的问题、提议或分歧', id);
    if (entry.scope !== clean(target.scope)) return fail('适用范围不同');
    if (entry.at > 0 && target.at > 0 && entry.at < target.at) return fail('原话早于 #{0}，不能用旧消息解决新条目', id);
  }
  if (historical) {
    entry.supersededBy = historical.id;
    notes.push(tr('原话更早，作为已被 #{0} 取代的历史写入', [historical.id]));
  } else if (conflicts.length) {
    const uniqueConflicts = unique(conflicts);
    entry.proposed = { type: entry.type, text: entry.text, ...(entry.reason ? { reason: entry.reason } : {}) };
    entry.conflicts = uniqueConflicts;
    entry.type = 'disagreement';
    entry.ask = true;
    entry.related = unique([...uniqueConflicts, ...entry.related]).slice(0, 10);
    entry.text = tr('和 #{0} 不一致：{1}', [uniqueConflicts[0], entry.text]).slice(0, 300);
    delete entry.origin;
    delete entry.attempt;
    for (const id of uniqueConflicts) notes.push(tr('你定的 #{0} 只有你能改，记成分歧', [id]));
  } else {
    if (supersedes.length) entry.supersedes = unique(supersedes);
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
  const sameKey = (e) => e.type === entry.type && clean(e.scope) === entry.scope
    && clean(e.task) === clean(entry.task) && compactText(e.text) === compactText(entry.text);
  const duplicate = entries.find((e) => live(e) && !entry.supersedes?.includes(e.id) && sameKey(e));
  if (duplicate) return fail('和 #{0} 重复', duplicate.id);
  const retracted = entries.findLast((e) => e.status === 'retracted' && sameKey(e));
  if (retracted) {
    const seqAt = number(retracted.retractedSeqAt);
    const hasFreshUser = proof.freshUserSeqs.some((seq) => seq > seqAt);
    const oldTaskRefs = new Set(retracted.source?.tasks || []);
    const hasFreshAttempt = proof.taskAttemptTimes.some(({ ref, time }) => !oldTaskRefs.has(ref) && time > number(retracted.retractedAt));
    if (!hasFreshUser && !hasFreshAttempt) return fail('#{0} 已被你撤回，需要新的明确确认才会重新记录', retracted.id);
  }
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
