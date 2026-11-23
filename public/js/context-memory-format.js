import { getLanguage, t } from '../i18n.js';

const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => Array.isArray(v) ? v : [];
const text = (v) => typeof v === 'string' ? v : '';
const count = (v) => Number.isFinite(v) && v >= 0 ? v : 0;
const ids = (v) => list(v).filter((id) => Number.isSafeInteger(id) && id > 0);
const segments = ['system', 'memory', 'recap', 'imports', 'recent', 'files'];

function normalizeBreakdown(raw) {
  const result = {};
  for (const key of [...segments, 'omitted']) {
    const part = raw?.[key];
    result[key] = { tokens: count(part?.tokens), chars: count(part?.chars) };
    if (key === 'memory') result[key].entryIds = [...new Set(ids(part?.entryIds))];
    if (key === 'recent' || key === 'omitted') result[key].count = count(part?.count);
  }
  return result;
}

export function normalizeContextResponse(raw) {
  const r = raw?.recap;
  const recap = {
    text: text(r?.text), uptoSeq: count(r?.uptoSeq), version: count(r?.version),
    editedByUser: r?.editedByUser === true, updatedAt: Number.isFinite(r?.updatedAt) ? r.updatedAt : null,
  };
  const members = Object.fromEntries(Object.entries(record(raw?.members) ? raw.members : {}).map(([id, m]) => [id, {
    mode: m?.mode === 'session' ? 'session' : 'stateless',
    lastTurnAt: count(m?.lastTurnAt), running: m?.running === true, canHandoff: m?.canHandoff === true,
    breakdown: normalizeBreakdown(m?.breakdown),
    handoffs: list(m?.handoffs).filter(record).map((h) => ({
      at: count(h.at), reason: text(h.reason), summary: text(h.summary),
    })),
  }]));
  return { recap, members };
}

export function computeBreakdownRows(breakdown, tr = t) {
  const data = normalizeBreakdown(breakdown);
  const labels = {
    system: tr('角色说明与设定'), memory: tr('记忆库'), recap: tr('前情提要'),
    imports: tr('简报与导入摘要'), files: tr('附带文件'),
    recent: data.recent.count ? tr('最近 {0} 条聊天', [data.recent.count]) : tr('最近聊天'),
  };
  const totalTokens = segments.reduce((sum, key) => sum + data[key].tokens, 0);
  const totalChars = segments.reduce((sum, key) => sum + data[key].chars, 0);
  const rows = segments.map((key) => ({
    key, tone: key, label: labels[key], ...data[key],
    pct: totalTokens ? data[key].tokens / totalTokens * 100 : totalChars ? data[key].chars / totalChars * 100 : 0,
  }));
  return { rows, totalTokens, totalChars, hasData: totalTokens > 0 || totalChars > 0, omitted: data.omitted };
}

const compactFormats = new Map();
export function formatCountCompact(n, lang = getLanguage()) {
  if (!compactFormats.has(lang)) compactFormats.set(lang, new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 }));
  return compactFormats.get(lang).format(count(n));
}

export function handoffButtonState(memberCtx, { speaking = false, spaceClosed = false } = {}, tr = t) {
  let reason = '';
  if (spaceClosed) reason = tr('这个任务已经结束，无法重开会话');
  else if (speaking || memberCtx?.running) reason = tr('正在发言，说完后才能重开会话');
  else if (!memberCtx || memberCtx.canHandoff === false) reason = tr('当前成员不保持长会话，每轮已自动重新组装上下文');
  return { disabled: !!reason, reason };
}

export function formatHandoffReason(reason, tr = t) {
  switch (reason) {
    case 'auto': return tr('自动交接');
    case 'manual': return tr('手动重开');
    case 'config_changed': return tr('设置变更');
    default: return tr('换了新会话');
  }
}

export function statelessContextTip(memberCtx, hasRecap = true, tr = t) {
  const recent = count(memberCtx?.breakdown?.recent?.count);
  const omitted = count(memberCtx?.breakdown?.omitted?.count);
  if (omitted) return hasRecap ? tr('最近 {0} 条在、更早的 {1} 条已压进前情提要', [recent, omitted])
    : tr('最近 {0} 条在、更早的 {1} 条已省略', [recent, omitted]);
  return recent ? tr('最近 {0} 条在上下文中', [recent]) : '';
}

export function formatActionSummary(actions, tr = t) {
  const items = [];
  for (const action of list(actions)) {
    const cmd = text(action).trim();
    if (cmd && cmd !== items.at(-1)) items.push(cmd);
  }
  return items.length ? { items, text: tr('运行了：{0}', [items.join(' · ')]) } : null;
}

export const MEMORY_FILTERS = ['all', 'decision', 'constraint', 'preference', 'rejected', 'open', 'result', 'superseded'];
// Store translation keys so callers can select a language at render time.
export const MEMORY_TYPE_LABELS = {
  decision: '决定', constraint: '约束', fact: '项目事实', preference: '偏好', question: '问题',
  proposal: '提议', disagreement: '分歧', rejected: '否决过', result: '任务结果',
};
export const MEMORY_FILTER_LABELS = { ...MEMORY_TYPE_LABELS, all: '全部', open: '提议与分歧', superseded: '已取代' };
const active = (e) => (e.status ?? 'active') === 'active';
export function matchesMemoryFilter(entry, filter) {
  if (!record(entry)) return false;
  if (filter === 'all') return true;
  if (filter === 'superseded') return ['superseded', 'resolved', 'retracted'].includes(entry.status);
  if (!active(entry)) return false;
  if (filter === 'open') return ['proposal', 'disagreement', 'question'].includes(entry.type);
  return MEMORY_FILTERS.includes(filter) && entry.type === filter;
}

export function filterMemoryEntries(entries, filter = 'all', query = '') {
  const q = text(query).trim().toLowerCase();
  const id = /^#?(\d+)$/.exec(q);
  return list(entries).filter((e) => {
    if (!matchesMemoryFilter(e, filter)) return false;
    if (!q) return true;
    if (id && Number(id[1]) === e.id) return true;
    if (id && q.startsWith('#')) return false;
    return [e.text, e.reason, e.scope, e.task, ...list(e.topics), ...list(e.files), ...list(e.source?.files)]
      .some((value) => text(value).toLowerCase().includes(q));
  }).sort((a, b) => Number(active(b)) - Number(active(a)) || b.id - a.id);
}

export function countMemoryFilters(entries) {
  return Object.fromEntries(MEMORY_FILTERS.map((filter) => [filter, list(entries).filter((e) => matchesMemoryFilter(e, filter)).length]));
}

export function formatMemoryOrigin(entry, tr = t) {
  if (entry?.type === 'rejected' && entry.origin === 'attempt') {
    const tag = entry.attempt?.model || entry.attempt?.engine;
    return { kind: 'attempt', label: tag ? tr('试过走不通·{0}', [tag]) : tr('试过走不通') };
  }
  if ((entry?.origin === 'user' || entry?.confirmedBy === 'user') && ['decision', 'constraint', 'preference'].includes(entry.type)) {
    return { kind: 'user', label: tr('你定的') };
  }
  if (entry?.type === 'rejected' && (entry.origin === 'user' || entry.confirmedBy === 'user')) {
    return { kind: 'user', label: tr('你定的') };
  }
  return entry?.type === 'decision' ? { kind: 'default', label: tr('默认通过的') } : null;
}

export function formatMemorySources(source, tr = t) {
  const chips = ids(source?.messages).map((seq) => ({ kind: 'message', seq, label: tr('消息 {0}', [seq]) }));
  for (const ref of list(source?.tasks)) {
    if (!text(ref).trim()) continue;
    const [taskId, attempt] = ref.split('/');
    chips.push({ kind: 'task', ref, taskId, label: attempt ? tr('任务 {0} 第 {1} 次执行', [taskId, attempt]) : tr('任务 {0}', [taskId]) });
  }
  for (const file of list(source?.files)) if (text(file).trim()) chips.push({ kind: 'file', file, label: file });
  return chips;
}

export const AUTO_HANDOFF_PRESETS = [0, 30, 40, 50, 60, 70, 80, 90];
export function normalizeAutoHandoffPct(value) {
  if (typeof value !== 'number' && !text(value).trim()) return 50;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 50;
  return n === 0 ? 0 : Math.max(1, Math.min(100, Math.round(n)));
}
