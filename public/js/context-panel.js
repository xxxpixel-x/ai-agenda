import { computeBreakdownRows, formatCountCompact, formatHandoffReason, handoffButtonState, normalizeContextResponse } from './context-memory-format.js';
import { enterPanel } from './files.js';
import { focusMemoryEntry, memoryEntryHtml, revealMemorySource } from './memory-view.js';
import { currentPanel } from './rightbar.js';
import { register } from './slots.js';
import { $, ICON, api, avatarHtml, clock, esc, state, toast, tr } from './util.js';

const spaces = new Map();
let pane = null;
let timer;

function speakingMember(sp) {
  return sp.messages?.find((m) => m.id === sp.speaking)?.memberId;
}

function breakdownHtml(breakdown) {
  const { rows, totalTokens, totalChars, hasData, omitted } = computeBreakdownRows(breakdown, tr);
  const figures = (tokens, chars) => tr('约 {0} tokens · {1} 字', [formatCountCompact(tokens), formatCountCompact(chars)]);
  const pct = (row) => Math.round(row.pct) + '%';
  return `<section class="ctx-card"><header><h3>${tr('本轮送入')}</h3>${hasData ? `<small>${esc(figures(totalTokens, totalChars))}</small>` : ''}</header>
    ${hasData ? `<div class="ctx-bar">${rows.filter((r) => r.pct > 0).map((r) => `<span class="seg-${r.tone}" style="width:${r.pct}%"
      title="${esc([r.label, figures(r.tokens, r.chars), pct(r)].join(' · '))}"></span>`).join('')}</div>
    <ul class="ctx-rows">${rows.map((r) => `<li><i class="seg-${r.tone}"></i><span>${esc(r.label)}</span>
      <small>${esc(figures(r.tokens, r.chars))}</small><b>${pct(r)}</b></li>`).join('')}</ul>`
      : `<p class="hint">${tr('这位成员还没有发言记录，发言后会显示本轮上下文构成')}</p>`}
    ${omitted.count || omitted.chars ? `<p class="ctx-omitted">${esc(tr('已省略 {0} 条较早聊天（{1} 字 / ~{2} tokens）',
      [omitted.count, formatCountCompact(omitted.chars), formatCountCompact(omitted.tokens)]))}</p>` : ''}</section>`;
}

function injectedHtml(cache, ids) {
  const expanded = ids.includes(cache.expanded) ? cache.expanded : null;
  const entry = cache.entries.get(expanded);
  return `<section class="ctx-card"><header><h3>${tr('本轮送入的记忆条目')}</h3><small>${ids.length}</small></header>
    <div class="ctx-ids">${ids.map((id) => `<button type="button" class="mem-pill" data-preview="${id}" aria-expanded="${id === expanded}">#${id}</button>`).join('')}</div>
    ${expanded ? `<div class="ctx-preview">${entry ? memoryEntryHtml(entry, true) : `<p class="hint">${tr('找不到这条记忆')}</p>`}
      <button type="button" class="btn sm" data-memory-jump="${expanded}">${tr('在记忆库中查看')}${ICON.external}</button></div>` : ''}</section>`;
}

function handoffHtml(cache, member, ctx, speaking) {
  const { disabled, reason } = handoffButtonState(ctx, { speaking, spaceClosed: !!state.space.run?.closed }, tr);
  const pending = cache.pending.has(member.id);
  const history = [...(ctx?.handoffs || [])].sort((a, b) => b.at - a.at);
  return `<section class="ctx-card"><button type="button" class="btn sm" data-handoff="${esc(member.id)}"
    ${disabled || pending ? 'disabled' : ''} title="${esc(reason)}">${pending ? tr('正在重开…') : tr('重开这个 AI 的会话')}</button>
    ${reason ? `<p class="hint">${esc(reason)}</p>` : ''}
    ${history.length ? `<ol class="ctx-history">${history.map((h) => `<li><div>${h.at ? `<time>${esc(clock(h.at))}</time>` : ''}
      ${tr('换了新会话')} <span class="mem-pill">${esc(formatHandoffReason(h.reason, tr))}</span></div>
      ${h.summary ? `<p>${esc(h.summary)}</p>` : ''}</li>`).join('')}</ol>` : `<p class="hint">${tr('还没有交接记录')}</p>`}</section>`;
}

function paint() {
  const sp = state.space;
  if (!pane || sp?.id !== pane.id) return;
  const { root, cache } = pane;
  const members = sp.members || [];
  const speaking = speakingMember(sp);
  const member = members.find((m) => m.id === cache.selected) || members.find((m) => m.id === speaking) || members[0];
  cache.selected = member?.id;
  const ctx = cache.context?.members[member?.id];
  const currentFocus = root.contains(document.activeElement) ? document.activeElement.closest('button')?.dataset : null;
  const scroll = $('.ctx-members', root)?.scrollLeft || 0;
  root.innerHTML = `<div class="panel-bar"><span class="pb-title">${ICON.context}${tr('上下文')}</span><span class="grow"></span>
    <button type="button" class="icon-btn" data-ctx-refresh title="${tr('刷新')}" aria-label="${tr('刷新')}">${ICON.refresh}</button></div>
    <div class="ctx-content"><div class="ctx-members">${members.map((m) => {
      const busy = speaking === m.id || cache.context?.members[m.id]?.running;
      return `<button type="button" data-ctx-member="${esc(m.id)}" aria-pressed="${m.id === member?.id}">
        ${avatarHtml(m.engine, m.name, m.model)}${esc(m.name)}${busy ? `<i class="ctx-busy" aria-label="${tr('正在发言')}"></i>` : ''}</button>`;
    }).join('')}</div>
    ${ctx ? `<div class="ctx-meta"><span class="mem-pill">${ctx.mode === 'session' ? tr('长会话') : tr('按轮组装')}</span>
      ${ctx.lastTurnAt ? esc(tr('上次更新 {0}', [clock(ctx.lastTurnAt)])) : ''}</div>` : ''}
    ${cache.context ? breakdownHtml(ctx?.breakdown) : `<p class="hint">${cache.failed ? tr('暂时无法读取上下文') : tr('加载中…')}</p>`}
    ${ctx?.breakdown.memory.entryIds.length ? injectedHtml(cache, ctx.breakdown.memory.entryIds) : ''}
    ${member && cache.context ? handoffHtml(cache, member, ctx, member.id === speaking) : ''}</div>`;
  $('.ctx-members', root).scrollLeft = scroll;
  if (currentFocus) {
    const [key, value] = Object.entries(currentFocus)[0] || [];
    if (key) [...root.querySelectorAll('button')].find((b) => b.dataset[key] === value)?.focus({ preventScroll: true });
  }
}

export async function refreshContextPanel() {
  if (!pane || currentPanel() !== 'context') return;
  clearTimeout(timer);
  const active = pane;
  const request = ++active.request;
  const { id, cache } = active;
  const [context, memory] = await Promise.allSettled([api(`/api/spaces/${id}/context`), api(`/api/spaces/${id}/memory`)]);
  if (pane !== active || request !== active.request) return;
  cache.failed = context.status === 'rejected';
  cache.context = cache.failed ? null : normalizeContextResponse(context.value);
  if (memory.status === 'fulfilled') {
    const entries = memory.value?.entries;
    cache.entries = new Map((Array.isArray(entries) ? entries : []).filter((e) => e?.id).map((e) => [e.id, e]));
  }
  paint();
}

export function invalidateContextCache(spaceId) {
  const cache = spaces.get(spaceId);
  if (cache) cache.context = null;
  if (pane?.id === spaceId) return refreshContextPanel();
}

async function handoff(memberId) {
  const { id, cache } = pane;
  const member = state.space.members.find((m) => m.id === memberId);
  const ctx = cache.context?.members[memberId];
  if (!member || cache.pending.has(memberId) || handoffButtonState(ctx, {
    speaking: memberId === speakingMember(state.space), spaceClosed: !!state.space.run?.closed,
  }, tr).disabled) return;
  cache.pending.add(memberId);
  paint();
  try {
    await api(`/api/spaces/${id}/members/${encodeURIComponent(memberId)}/handoff`, { method: 'POST' });
    if (state.space?.id === id) toast(tr('已重开 {0} 的会话', [member.name]));
    window.dispatchEvent(new CustomEvent('agenda:context-updated', { detail: { spaceId: id } }));
  } catch (e) {
    if (state.space?.id === id) toast(e.message, 'error');
    if (e.status === 409 && pane?.id === id) refreshContextPanel();
  } finally {
    cache.pending.delete(memberId);
    if (pane?.id === id) paint();
  }
}

function renderContextPane(body, { space }) {
  enterPanel('context');
  if (pane?.id === space.id) { paint(); return; }
  disposeContextPane();
  if (!spaces.has(space.id)) spaces.set(space.id, { context: null, entries: new Map(), pending: new Set() });
  const cache = spaces.get(space.id);
  body.innerHTML = '<section class="ctx-pane"></section>';
  const root = body.firstElementChild;
  pane = { root, cache, id: space.id, request: 0 };
  root.onclick = ({ target }) => {
    const b = target.closest('button');
    if (!b || b.disabled) return;
    if (b.hasAttribute('data-ctx-refresh')) refreshContextPanel();
    else if (b.dataset.ctxMember) { cache.selected = b.dataset.ctxMember; paint(); }
    else if (b.dataset.preview) {
      const id = Number(b.dataset.preview);
      cache.expanded = id === cache.expanded ? null : id;
      paint();
    } else if (b.dataset.memoryJump) focusMemoryEntry(b.dataset.memoryJump);
    else if (b.dataset.messageSeq) revealMemorySource(b.dataset.messageSeq);
    else if (b.dataset.handoff) handoff(b.dataset.handoff);
  };
  paint();
  refreshContextPanel();
}

function disposeContextPane() {
  clearTimeout(timer);
  pane = null;
}

window.addEventListener('agenda:context-updated', ({ detail }) => invalidateContextCache(detail.spaceId));
window.addEventListener('agenda:space-event', ({ detail }) => {
  if (!pane || currentPanel() !== 'context' || pane.id !== detail?.space?.id) return;
  if (!['snapshot', 'message_done', 'state', 'members', 'run'].includes(detail.type)) return;
  paint();
  clearTimeout(timer);
  timer = setTimeout(refreshContextPanel, 200);
});

register('panels', { id: 'context', label: tr('上下文'), icon: ICON.context, order: 40, render: renderContextPane, dispose: disposeContextPane });
