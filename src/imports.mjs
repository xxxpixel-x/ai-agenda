// 导入外部 AI 对话（Claude Code / Codex / DeepSeek Harness）到空间里。
//
// 导入的对话在聊天记录里是一条 kind:'import' 的消息，显示成一个折叠块。
// 它不算普通聊天消息（不占“最近 40 条”的名额），而是作为固定背景附在每个成员的每次发言里；
// 所以要控制篇幅：按长度自动选方式（全部原文 / 早期压成摘要 / 写 handoff 文件），也可以手动改。
//
// 来源是 Claude Code 时，对应的 Claude 成员接着原会话继续（复制一份再接，原会话不动），
// 它自己记得全部内容，不需要这块背景。
// 补导：之后原对话又有新内容，追加一条 parentId 指向原块的导入消息。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readSession, samePath } from './importers/index.mjs';
import { normalizeMembers } from './space.mjs';
import { systemPrompt } from './prompts.mjs';
import { runAgentTurn } from './turn-runner.mjs';

export const MODES = ['full', 'from', 'summary', 'handoff'];
const LIMIT = { short: 15000, long: 60000, recentSummary: 15000, recentHandoff: 10000 };
const MAX_ACTS = 12;          // 每条最多列几个操作
const PRIOR_CHAT = 40;        // 接续的 Claude 第一次发言时，补给它导入之前的多少条聊天

const entryChars = (e) => e.text.length + e.acts.slice(0, MAX_ACTS).join('；').length + 8;
const charsOf = (entries) => entries.reduce((n, e) => n + entryChars(e), 0);
const autoMode = (chars) => (chars <= LIMIT.short ? 'full' : chars <= LIMIT.long ? 'summary' : 'handoff');
const preview = (t, n = 40) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };

/** 保留最近约 budget 字原文时，从第几条开始（尽量从你说的话开始）。 */
function recentStart(entries, budget) {
  let n = 0;
  let i = entries.length - 1;
  for (; i > 0; i--) {
    n += entryChars(entries[i]);
    if (n > budget) { i++; break; }
  }
  i = Math.min(Math.max(i, 0), entries.length - 1);
  const user = entries.findIndex((e, k) => k >= i && e.role === 'user');
  return user >= 0 && user < entries.length - 1 ? user : i;
}

/** 选好方式后，哪些原文进聊天、哪些交给 AI 整理。 */
function plan(entries, mode, fromIndex) {
  if (mode === 'from') {
    const from = Math.min(Math.max(parseInt(fromIndex, 10) || 0, 0), entries.length - 1);
    return { keep: entries.slice(from), skipped: from, early: [] };
  }
  if (mode === 'summary' || mode === 'handoff') {
    const start = recentStart(entries, mode === 'summary' ? LIMIT.recentSummary : LIMIT.recentHandoff);
    return { keep: entries.slice(start), skipped: start, early: entries.slice(0, start) };
  }
  return { keep: entries, skipped: 0, early: [] };
}

// ---------- 给界面用 ----------

/** 选中一段对话后显示的信息：篇幅、自动选的方式、可以从哪条开始。 */
export function sessionDetail(source, id) {
  const s = readSession(source, id);
  const chars = charsOf(s.entries);
  return {
    source: s.source, sourceLabel: s.sourceLabel, engine: s.engine, id: s.id, title: s.title, cwd: s.cwd,
    count: s.entries.length, chars, auto: autoMode(chars),
    starts: s.entries.map((e, i) => (e.role === 'user' ? { i, text: preview(e.text) } : null)).filter(Boolean),
  };
}

/** 接续中的 Claude 成员复制出来的会话：导入列表里不显示。 */
export function forkedSessionIds(spaces) {
  const ids = new Set();
  for (const sp of spaces) {
    for (const st of Object.values(sp.data.memberState || {})) if (st?.importId && !st.fork && st.sessionId) ids.add(st.sessionId);
  }
  return ids;
}

// ---------- 给 AI 的文字 ----------

function entryText(e, aiName) {
  const who = e.role === 'user' ? '我' : aiName;
  const parts = [`【${who}】`];
  if (e.text) parts.push(e.text);
  if (e.acts.length) parts.push(`（操作：${e.acts.slice(0, MAX_ACTS).join('；')}${e.acts.length > MAX_ACTS ? `；等共 ${e.acts.length} 个` : ''}）`);
  return parts.join('\n');
}
const entriesText = (entries, aiName) => entries.map((e) => entryText(e, aiName)).join('\n\n');

function blockText(m) {
  const head = m.parentId ? `# 导入的对话（补导的新内容）：${m.title}` : `# 导入的对话：${m.title}（来自 ${m.sourceLabel}）`;
  const parts = [head];
  if (m.summary) parts.push(`## 较早部分的摘要\n${m.summary}`);
  else if (m.handoff) parts.push(`较早的部分整理成了交接文档「${m.handoff}」，在共享文件夹里，需要时去读。`);
  else if (m.skipped) parts.push(`（前面 ${m.skipped} 条没有导入）`);
  if (m.entries.length) parts.push(`${m.summary || m.handoff ? '## 最近的原文\n' : ''}${entriesText(m.entries, m.name)}`);
  return parts.join('\n\n');
}

/**
 * 发言时附带的导入背景。
 *  from       只要这条之后的导入（续接会话的成员，之前的它都看过）
 *  excludeId  接续中的 Claude 自己那段原对话（它记得，不用再给）
 */
export function importsBackground(messages, { from = 0, excludeId = null } = {}) {
  return messages.slice(from)
    .filter((m) => m.kind === 'import' && m.status !== 'writing' && m.id !== excludeId)
    .map(blockText).join('\n\n---\n\n');
}

function resumeNote(s, workspacePath) {
  const lines = [
    '## 接续说明',
    `你之前在 ${s.sourceLabel} 里和用户（「我」）聊过这段对话。现在用户把它带进了这个空间，接下来按上面的规则和大家一起交流；其他成员看到的是这段对话的文字记录。`,
  ];
  if (s.cwd && !samePath(s.cwd, workspacePath)) {
    lines.push(`原来的项目文件夹是 ${s.cwd}，现在的共享文件夹是 ${workspacePath}。原对话里提到的文件路径指的是原来的文件夹，现在读写文件以共享文件夹为准。`);
  }
  return lines.join('\n');
}

const DIGEST = {
  summary: '把这段对话写成摘要，给接下来加入讨论的其他 AI 看：讨论了什么、定下了什么、做了哪些改动（涉及哪些文件）、还有什么没解决。不超过 1500 字，用对话使用的语言，只输出摘要本身。',
  handoff: '为这段对话写一份 Markdown 交接文档，让接手的人不看原对话也能继续。分这几节：## 讨论到哪、## 已经定下的、## 还没解决的、## 下一步、## 涉及的文件。用对话使用的语言，只输出文档本身。',
};

// ---------- 导入 ----------

function uniqueName(members, base) {
  let name = base;
  for (let k = 2; members.some((m) => m.name === name); k++) name = `${base}${k}`;
  return name;
}

/**
 * 对应的成员。memberId：指定的同类成员；'' 表示新加一个；不给就用第一个同类成员。
 * 找不到（或 Claude 成员已在接续别的对话）就新加一个。
 */
function pickMember(space, engine, memberId) {
  const d = space.data;
  const busy = (m) => engine === 'claude-code' && !!d.memberState[m.id]?.importId;
  const usable = (m) => m.engine === engine && !busy(m);
  const chosen = memberId == null ? d.members.find(usable) : d.members.find((m) => m.id === memberId && usable(m));
  if (chosen) return chosen;
  const meta = space.registry.list().find((e) => e.id === engine);
  if (!meta) throw new Error('圆桌里没有对应的 AI 类型');
  if (d.members.length >= 8) throw new Error('成员已经满 8 个了，先在设置里移除一个');
  d.members = normalizeMembers([...d.members, { engine, name: uniqueName(d.members, meta.defaultName) }], space.registry.list());
  return d.members.at(-1);
}

function assertIdle(space) {
  if (space.running) throw new Error('请先停止当前讨论再导入');
  if (space.importing) throw new Error('正在整理另一段导入的对话，稍等');
}

/**
 * 导入一段对话。
 * opts: { source, sessionId, mode?, fromIndex?, memberId?, writerId? }
 */
export function importSession(space, opts = {}) {
  assertIdle(space);
  space.assertChatAllowed();
  const s = readSession(opts.source, opts.sessionId);
  if (!s.entries.length) throw new Error('这段对话里没有内容');
  const mode = MODES.includes(opts.mode) ? opts.mode : autoMode(charsOf(s.entries));
  const member = pickMember(space, s.engine, opts.memberId);
  const resume = s.engine === 'claude-code';
  const writer = resume ? member : space.data.members.find((m) => m.id === opts.writerId) || space.data.members.find((m) => m.id !== member.id) || member;

  const { keep, skipped, early } = plan(s.entries, mode, opts.fromIndex);
  const last = s.entries.at(-1);
  const msg = {
    id: randomUUID(), kind: 'import', ts: Date.now(),
    source: s.source, sourceLabel: s.sourceLabel, sessionId: s.id, title: s.title || '（无标题）', cwd: s.cwd,
    memberId: member.id, name: member.name, writerId: writer.id,
    mode, skipped, entries: keep, total: s.entries.length,
    lastKey: last.key, lastTs: last.ts,
    status: early.length || mode === 'handoff' ? 'writing' : 'ready',
  };

  const messages = space.data.messages;
  if (resume) {
    space.data.memberState[member.id] = {
      importId: msg.id, sessionId: s.id, fork: true,
      seen: Math.max(0, messages.length - PRIOR_CHAT),
      note: resumeNote(s, space.workspacePath),
    };
  }
  messages.push(msg);
  space.save();
  space.emitEvent({ type: 'snapshot', space: space.toJSON() }); // 成员可能变了
  if (msg.status === 'writing') digest(space, msg, mode === 'handoff' ? s.entries : early, writer);
  return msg;
}

/** 让 AI 写摘要 / handoff（后台进行，写好后更新折叠块）。 */
async function digest(space, msg, entries, writer) {
  space.importing = true;
  const state = space.data.memberState[writer.id];
  const resume = state?.importId === msg.id && !!state.sessionId;
  const ask = DIGEST[msg.mode === 'handoff' ? 'handoff' : 'summary'];
  let prompt;
  if (resume) {
    const firstKept = msg.entries[0];
    prompt = msg.mode === 'handoff'
      ? `${ask}\n\n范围：我们这段对话的全部内容。`
      : `${ask}\n\n范围：我们这段对话从开头到${firstKept ? `「${preview(firstKept.text, 30)}」这条之前` : '现在'}的部分（后面的部分大家能直接看到原文）。`;
  } else {
    prompt = `下面是用户和 ${msg.sourceLabel} 的一段对话（「我」是用户，「${msg.name}」是 ${msg.sourceLabel}）。\n\n${ask}\n\n# 对话\n${entriesText(entries, msg.name)}`;
  }
  const system = resume
    ? `${systemPrompt(space.toJSON(), writer, { api: space.registry.isApi(writer.engine) })}\n${state.note || ''}`
    : '你在帮用户整理导入的对话，照要求输出整理好的文字，不要加别的话。';
  const sink = { text: '', activities: [] };
  try {
    const r = await runAgentTurn(space.registry, writer, {
      system, prompt, cwd: space.workspacePath, access: 'read', sink,
      sessionId: resume ? state.sessionId : undefined,
      fork: resume && state.fork,
    });
    const text = String(r.text || '').trim();
    if (!text) throw new Error(`${writer.name} 没有写出内容`);
    if (resume && r.sessionId) Object.assign(state, { sessionId: r.sessionId, fork: false });
    if (msg.mode === 'handoff') {
      msg.handoff = handoffPath(space, msg.title);
      const changes = space.ws.write(msg.handoff, `${text}\n`, writer.name);
      if (changes.length) space.emitEvent({ type: 'files_changed', changes });
    } else {
      msg.summary = text;
    }
    msg.status = 'ready';
    delete msg.error;
  } catch (e) {
    msg.status = 'error';
    msg.error = `${writer.name} 没有写成${msg.mode === 'handoff' ? '交接文档' : '摘要'}：${e.message}`;
    space.emitEvent({ type: 'notice', level: 'error', text: msg.error });
  } finally {
    space.importing = false;
    space.save();
    space.emitEvent({ type: 'message_done', message: msg });
  }
}

function handoffPath(space, title) {
  const base = `交接-${String(title).replace(/[\\/:*?"<>|\s]+/g, ' ').trim().slice(0, 40) || '对话'}`;
  let name = `${base}.md`;
  for (let k = 2; fs.existsSync(path.join(space.workspacePath, name)); k++) name = `${base}（${k}）.md`;
  return name;
}

// ---------- 补导 ----------

const chainOf = (space, rootId) => space.data.messages.filter((m) => m.kind === 'import' && (m.id === rootId || m.parentId === rootId));

function rootOf(space, id) {
  const m = space.data.messages.find((x) => x.id === id && x.kind === 'import');
  if (!m) throw Object.assign(new Error('找不到这段导入的对话'), { status: 404 });
  return m.parentId ? rootOf(space, m.parentId) : m;
}

/** 原对话在上次导入之后的新内容。 */
function newEntries(space, root) {
  const last = chainOf(space, root.id).at(-1);
  const s = readSession(root.source, root.sessionId);
  let i = s.entries.findIndex((e) => e.key === last.lastKey);
  if (i < 0) i = s.entries.findLastIndex((e) => e.ts && e.ts <= last.lastTs);
  return { s, fresh: s.entries.slice(i + 1) };
}

export function checkImport(space, id) {
  const root = rootOf(space, id);
  try { return { newCount: newEntries(space, root).fresh.length }; } catch { return { newCount: 0 }; }
}

export function refreshImport(space, id) {
  assertIdle(space);
  const root = rootOf(space, id);
  const { s, fresh } = newEntries(space, root);
  if (!fresh.length) return { added: 0, grown: false };
  const last = s.entries.at(-1);
  const msg = {
    id: randomUUID(), kind: 'import', ts: Date.now(), parentId: root.id,
    source: root.source, sourceLabel: root.sourceLabel, sessionId: root.sessionId, title: root.title, cwd: root.cwd,
    memberId: root.memberId, name: root.name, mode: 'full', skipped: 0, entries: fresh, total: fresh.length,
    lastKey: last.key, lastTs: last.ts, status: 'ready',
  };
  space.data.messages.push(msg);
  space.save();
  space.emitEvent({ type: 'message', message: msg });
  const raw = charsOf(chainOf(space, root.id).flatMap((m) => m.entries));
  return { added: fresh.length, grown: raw > (root.mode === 'handoff' ? LIMIT.recentHandoff : LIMIT.short) };
}

/** 重新整理（变长了要压缩，或者摘要没写成要重试）：原块按新方式重做，补导的块并进来。 */
export function recompressImport(space, id, mode) {
  assertIdle(space);
  const root = rootOf(space, id);
  const chain = chainOf(space, root.id);
  const s = readSession(root.source, root.sessionId);
  let end = s.entries.findIndex((e) => e.key === chain.at(-1).lastKey);
  if (end < 0) end = s.entries.length - 1;
  const entries = s.entries.slice(0, end + 1);
  const m = MODES.includes(mode) && mode !== 'from' ? mode : autoMode(charsOf(entries));
  const { keep, skipped, early } = plan(entries, m, 0);
  space.data.messages = space.data.messages.filter((x) => x.parentId !== root.id);
  Object.assign(root, { mode: m, skipped, entries: keep, total: entries.length, lastKey: entries.at(-1).key, lastTs: entries.at(-1).ts });
  delete root.summary; delete root.handoff; delete root.error;
  root.status = early.length || m === 'handoff' ? 'writing' : 'ready';
  space.save();
  space.emitEvent({ type: 'snapshot', space: space.toJSON() });
  if (root.status === 'writing') {
    const writer = space.data.members.find((x) => x.id === root.writerId) || space.data.members.find((x) => x.id === root.memberId) || space.data.members[0];
    digest(space, root, m === 'handoff' ? entries : early, writer);
  }
  return root;
}
