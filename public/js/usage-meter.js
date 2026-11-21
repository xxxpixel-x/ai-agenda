// 成员标签上的用量：上下文小圈、额度快用完时标签变色、鼠标提示。
// 数据来自 GET /api/spaces/:id/usage，画圈交给 chat.js 的 setMemberMeter。
// 成员标签重画（换空间、有人开始或说完）时刷新，不另开事件流。
import { setMemberMeter } from './chat.js';
import { formatCountCompact, normalizeContextResponse, statelessContextTip } from './context-memory-format.js';
import { $, $$, api, clock, getLanguage, state, tr } from './util.js';

const QUOTA_WARN = 80; // 额度用到这个百分比，标签变色
const bar = $('#membersBar');
let spaceId = null;
let usage = {};        // memberId -> { latest, total, today }
let context = normalizeContextResponse();
let speakingKey = null; // 上次读用量时正在发言的成员
let timer = null;
let seq = 0;
let readAt = 0;
const shown = new Set();

const fin = (n) => Number.isFinite(n);
const pct = (n) => `${Math.round(n)}%`;
const tokens = (u) => ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((n, k) => n + (fin(u?.[k]) ? u[k] : 0), 0);
function resetText(ts) {
  const d = new Date(ts);
  if (d.toDateString() === new Date().toDateString()) return clock(ts);
  return d.toLocaleString(getLanguage(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 一个成员的小圈和提示；什么都拿不到时返回 null。 */
export function meterFor(entry, now = Date.now(), contextMember = null, hasRecap = true) {
  const u = entry?.latest || {};
  const ratio = contextMember?.mode !== 'stateless' && fin(u.contextUsed) && fin(u.contextWindow) && u.contextWindow > 0 ? u.contextUsed / u.contextWindow : null;
  // 重置时间已经过了的额度不再可信，不显示
  const q = u.quota && fin(u.quota.usedPct) && !(fin(u.quota.resetsAt) && u.quota.resetsAt <= now) ? u.quota : null;
  const parts = [];
  if (ratio !== null) parts.push(tr('上下文 {0}', [pct(ratio * 100)]));
  if (q) parts.push(tr('额度 {0}', [pct(q.usedPct)]));
  let tip = parts.join(tr('、'));
  if (q && fin(q.resetsAt)) tip += tr('，{0} 重置', [resetText(q.resetsAt)]);
  // 没有额度说法的成员（只报 token 数）：这个空间、今天各用了多少
  if (!q && tokens(entry?.total) > 0) {
    const line = tr('这个空间 {0} token，今天 {1}', [formatCountCompact(tokens(entry.total)), formatCountCompact(tokens(entry.today))]);
    tip = tip ? `${tip}\n${line}` : line;
  }
  if (ratio === null) tip = [statelessContextTip(contextMember, hasRecap, tr), tip].filter(Boolean).join('\n');
  if (ratio === null && !tip) return null;
  return { ratio, tip, warn: !!q && q.usedPct >= QUOTA_WARN };
}

function paint() {
  const sp = state.space;
  if (!sp) return;
  const hasRecap = Boolean(context.recap.text.trim() || context.recap.uptoSeq > 0);
  for (const m of sp.members) {
    const meter = meterFor(usage[m.id], Date.now(), context.members[m.id], hasRecap);
    if (meter) { setMemberMeter(m.id, { ratio: meter.ratio, tip: meter.tip }); shown.add(m.id); }
    else if (shown.delete(m.id)) setMemberMeter(m.id, null);
    $(`.person[data-id="${CSS.escape(m.id)}"]`, bar)?.classList.toggle('quota-warn', !!meter?.warn);
  }
}

async function refresh() {
  const id = spaceId;
  const mine = ++seq;
  const [u, c] = await Promise.allSettled([api(`/api/spaces/${id}/usage`), api(`/api/spaces/${id}/context`)]);
  if (mine !== seq || state.space?.id !== id) return;
  if (u.status === 'fulfilled') usage = u.value?.members || {};
  if (c.status === 'fulfilled') context = normalizeContextResponse(c.value);
  readAt = Date.now();
  paint();
}

window.addEventListener('agenda:context-updated', ({ detail }) => {
  if (detail?.spaceId !== spaceId || state.space?.id !== spaceId) return;
  clearTimeout(timer);
  refresh();
});

// 成员标签重画：换了空间先清掉旧的；正在发言的成员变了（有人说完）就重新读用量
new MutationObserver(() => {
  const sp = state.space;
  if (!sp) return;
  if (sp.id !== spaceId) {
    for (const id of shown) setMemberMeter(id, null);
    shown.clear();
    usage = {};
    context = normalizeContextResponse();
    spaceId = sp.id;
    speakingKey = null;
  }
  paint();
  const key = $$('.person.speaking', bar).map((c) => c.dataset.id).sort().join(',');
  // 回到同一个空间（比如从设置页回来）时，隔一会儿也重新读一次
  if (key === speakingKey && Date.now() - readAt < 30_000) return;
  speakingKey = key;
  clearTimeout(timer);
  timer = setTimeout(refresh, 400);
}).observe(bar, { childList: true });
