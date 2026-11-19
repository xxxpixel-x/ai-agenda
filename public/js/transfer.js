// 聊天空间 → 任务空间：在消息上点「转到任务空间」进入挑选，可以多选（按住 Shift 连选），
// 然后直接带过去，或者让一个成员把选中的讨论整理成任务目标（你看过、改过再确认）。
import { renderComposer } from './chat.js';
import { openNewSpaceModal } from './space-form.js';
import { $, $$, ICON, esc, state, tr } from './util.js';

const pickable = () => $$('#messages [data-pick]').map((el) => el.dataset.pick);

export function pickBoxHtml(m) {
  const on = !!state.picking?.ids.has(m.id);
  return `<button type="button" class="pick-box ${on ? 'on' : ''}" data-pick="${m.id}" aria-pressed="${on}" aria-label="${tr('选这条')}">${ICON.check}</button>`;
}

function sync() {
  const ids = state.picking?.ids || new Set();
  $('#messages').classList.toggle('selecting', !!state.picking);
  for (const el of $$('#messages [data-pick]')) {
    const on = ids.has(el.dataset.pick);
    el.classList.toggle('on', on);
    el.setAttribute('aria-pressed', on);
    el.closest('.msg')?.classList.toggle('picked', on);
  }
  renderComposer();
}

export function startPicking(id) {
  state.picking = { ids: new Set([id]), anchor: id };
  sync();
}

export function stopPicking() {
  state.picking = null;
  sync();
}

function toggle(id, range) {
  const p = state.picking;
  if (!p) return;
  if (range && p.anchor) {
    const order = pickable();
    const [a, b] = [order.indexOf(p.anchor), order.indexOf(id)].sort((x, y) => x - y);
    if (a >= 0 && b >= 0) for (const x of order.slice(a, b + 1)) p.ids.add(x);
  } else if (p.ids.has(id)) p.ids.delete(id);
  else p.ids.add(id);
  p.anchor = id;
  sync();
}

export function renderSelectBar() {
  const sp = state.space;
  const n = state.picking?.ids.size || 0;
  $('#selectBar').innerHTML = `
    <span class="sb-count">${tr('已选 {0} 条', [n])}</span><span class="hint">${tr('按住 Shift 点击可以连选')}</span>
    <span class="grow"></span>
    <button class="btn sm" type="button" data-sb="cancel">${tr('取消')}</button>
    <span class="sb-ai">
      <select data-sb-member title="${tr('谁来整理')}">${sp.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>
      <button class="btn sm" type="button" data-sb="ai" ${n ? '' : 'disabled'}>${tr('让 TA 整理成方案')}</button>
    </span>
    <button class="btn sm primary" type="button" data-sb="raw" ${n ? '' : 'disabled'}>${tr('直接带过去')}</button>`;
}

/** 选中的消息按原来的顺序。 */
const selected = () => {
  const ids = state.picking?.ids || new Set();
  return state.space.messages.filter((m) => ids.has(m.id));
};

function rawText(list) {
  return list.map((m) => {
    const who = m.kind === 'user' ? tr('我') : m.kind === 'task' ? tr('{0}（任务「{1}」的总结）', [m.name, m.title]) : m.name;
    return `${who}：\n${m.text.trim()}`;
  }).join('\n\n');
}

$('#selectBar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sb]');
  if (!b) return;
  const sp = state.space;
  if (b.dataset.sb === 'cancel') { stopPicking(); return; }
  const list = selected();
  if (!list.length) return;
  const base = {
    kind: 'task',
    lockKind: true,
    from: { id: sp.id, title: sp.title, workspacePath: sp.workspacePath },
    source: { spaceId: sp.id, messages: list.length },
    members: sp.members,
  };
  if (b.dataset.sb === 'raw') openNewSpaceModal({ ...base, objective: rawText(list) });
  else openNewSpaceModal({ ...base, distill: { ids: list.map((m) => m.id), memberId: $('[data-sb-member]').value } });
  stopPicking();
});

// 挑选时点消息任意位置都算选它（链接、按钮、改动标签除外）
$('#messages').addEventListener('click', (e) => {
  if (!state.picking) return;
  const box = e.target.closest('[data-pick]');
  const msg = e.target.closest('.msg.pickable');
  const other = e.target.closest('a, button, summary, input, textarea, select');
  if (!box && (!msg || (other && !other.matches('[data-transfer]')))) return;
  const id = box?.dataset.pick || $('[data-pick]', msg)?.dataset.pick;
  if (!id) return;
  e.preventDefault();
  e.stopPropagation();
  toggle(id, e.shiftKey);
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.picking && !$('#modal').open) stopPicking(); });
