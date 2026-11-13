// 导入外部 AI 对话（Claude Code / Codex / DeepSeek Harness）到空间里。
//
// 导入的对话在聊天记录里是一条 kind:'import' 的消息，显示成一个折叠块。
// 它不算普通聊天消息（不占“最近 40 条”的名额），而是作为固定背景附在每个成员的每次发言里；
// 所以要控制篇幅：按长度自动选方式（全部原文 / 早期压成摘要 / 写 handoff 文件），也可以手动改。
//
// 来源是 Claude Code 时，对应的 Claude 成员接着原会话继续（复制一份再接，原会话不动），
// 它自己记得全部内容，不需要这块背景。
// 补导：之后原对话又有新内容，追加一条 parentId 指向原块的导入消息。
//
// 按主题导入（mode:'topic'）：只整理和某个主题有关的内容，写成「主题简报」存进共享文件夹，
// 背景里给的是你确认过的版本（briefText）。成员或别的软件改了简报文件，要你在导入块上「采用」才生效；
// 你自己在文件面板里改的直接生效。补导时由整理的成员把新内容里相关的部分并进简报。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readSession, samePath } from './importers/index.mjs';
import { normalizeMembers } from './space.mjs';
import { systemPrompt } from './prompts.mjs';
import { runAgentTurn } from './turn-runner.mjs';

export const MODES = ['full', 'from', 'summary', 'handoff', 'topic'];
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
  if (m.mode === 'topic') return topicText(m);
  const head = m.parentId ? `# 导入的对话（补导的新内容）：${m.title}` : `# 导入的对话：${m.title}（来自 ${m.sourceLabel}）`;
  const parts = [head];
  if (m.summary) parts.push(`## 较早部分的摘要\n${m.summary}`);
  else if (m.handoff) parts.push(`较早的部分整理成了交接文档「${m.handoff}」，在共享文件夹里，需要时去读。`);
  else if (m.skipped) parts.push(`（前面 ${m.skipped} 条没有导入）`);
  if (m.entries.length) parts.push(`${m.summary || m.handoff ? '## 最近的原文\n' : ''}${entriesText(m.entries, m.name)}`);
  return parts.join('\n\n');
}

function topicText(m) {
  return [
    `# 主题简报：${m.topic}`,
    `从导入的对话「${m.title}」（来自 ${m.sourceLabel}）里整理出来，只含和这个主题有关的内容，共享文件夹里的「${m.brief}」是它的文件。这里是用户确认过的版本，以这里为准；要修改简报，先在聊天里问「我」，得到同意再改。${m.briefPending ? '\n（文件里有一处修改还没经过用户确认，不要按它来。）' : ''}`,
    m.briefText.trim(),
  ].join('\n\n');
}

/**
 * 发言时附带的导入背景。
 *  from       只要这条之后的导入（续接会话的成员，之前的它都看过）
 *  excludeId  接续中的 Claude 自己那段原对话（它记得，不用再给）
 *  briefs     续接会话的成员上次看到的各份主题简报版本：只给有变化的；不给表示全部都给
 */
export function importsBackground(messages, { from = 0, excludeId = null, briefs = null } = {}) {
  return messages
    .filter((m, i) => m.kind === 'import' && (m.mode === 'topic'
      ? m.briefText != null && (!briefs || briefs[m.id] !== m.briefVer)
      : i >= from && m.status !== 'writing' && m.id !== excludeId))
    .map(blockText).join('\n\n---\n\n');
}

/** 当前各份主题简报的版本，发言后记给续接会话的成员。 */
export const briefVersions = (messages) => Object.fromEntries(messages
  .filter((m) => m.kind === 'import' && m.mode === 'topic' && m.briefText != null).map((m) => [m.id, m.briefVer]));

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
  if (!meta) throw new Error('Agenda 里没有对应的 AI 类型');
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
  const topic = mode === 'topic' ? String(opts.topic || '').trim().slice(0, 40) : '';
  if (mode === 'topic' && !topic) throw new Error('请填写主题');
  // 不加对应成员：来源在 Agenda 里没有对应的 AI 类型（粘贴的、Trae 等）；
  // 或者按主题导入时选了“不加”，或者新建空间时把它从成员里去掉了
  const noMember = !space.registry.list().some((e) => e.id === s.engine)
    || (mode === 'topic' && (opts.memberId === 'none' || (opts.memberId == null && !space.data.members.some((m) => m.engine === s.engine))));
  const member = noMember ? null : pickMember(space, s.engine, opts.memberId);
  const resume = !!member && s.engine === 'claude-code';
  const members = space.data.members;
  const writer = resume ? member : members.find((m) => m.id === opts.writerId) || members.find((m) => m.id !== member?.id) || member || members[0];

  const { keep, skipped, early } = mode === 'topic' ? { keep: s.entries, skipped: 0, early: [] } : plan(s.entries, mode, opts.fromIndex);
  const last = s.entries.at(-1);
  const msg = {
    id: randomUUID(), kind: 'import', ts: Date.now(),
    source: s.source, sourceLabel: s.sourceLabel, sessionId: s.id, title: s.title || '（无标题）', cwd: s.cwd,
    memberId: member?.id ?? null, name: member?.name || s.sourceLabel, writerId: writer.id,
    mode, skipped, entries: keep, total: s.entries.length,
    lastKey: last.key, lastTs: last.ts,
    status: early.length || mode === 'handoff' || mode === 'topic' ? 'writing' : 'ready',
  };
  if (topic) Object.assign(msg, { topic, brief: null, briefText: null, briefVer: 0, briefCount: 0 });

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
  if (mode === 'topic') space.track(writeTopic(space, msg, writer));
  else if (msg.status === 'writing') space.track(digest(space, msg, mode === 'handoff' ? s.entries : early, writer));
  return msg;
}

/** 让 AI 写摘要 / handoff（后台进行，写好后更新折叠块）。 */
async function digest(space, msg, entries, writer) {
  space.importing = true;
  const controller = space.importController = new AbortController();
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
      system, prompt, cwd: space.workspacePath, access: 'read', sink, signal: controller.signal,
      sessionId: resume ? state.sessionId : undefined,
      fork: resume && state.fork,
    });
    if (space.deleting) return;
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
    space.importController = null;
    space.save();
    space.emitEvent({ type: 'message_done', message: msg });
  }
}

// ---------- 主题简报 ----------

const NO_CHANGE = '[无需修改]';
const QUOTES_HEAD = '## 相关原文';
const MAX_QUOTES = 8;
const topicAsk = (topic) => `只整理和「${topic}」这个主题有关的内容，写成一份 Markdown 简报，给接下来只负责这个主题的其他 AI 看。它们看不到原对话，也不需要知道和这个主题无关的事。
格式：
# ${topic}
## 背景
（在做什么、和这个主题有关的最少必要信息）
## 已经定下的
## 约束和接口
（这个主题的产出要满足的格式、规模，以及和其他部分怎么对接）
## 待讨论
（还没定、需要大家拿主意的）
某一节没有内容就写“暂无”。不超过 3000 字，用对话使用的语言。`;
const quoteAsk = (what = '原话') => `简报写完后另起一行，写「相关原文：」，后面列出最能说明这个主题的${what}编号，最多 ${MAX_QUOTES} 个，用逗号分隔；没有就写「相关原文：无」。除了简报和这一行，不要输出别的。`;

const safeName = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, ' ').trim().slice(0, 40);
const whoOf = (e, name) => (e.role === 'user' ? '我' : name);

/** 简报 = 正文 + 「相关原文」一节（软件从原对话里原样取出，不让 AI 转述）。 */
function splitBrief(text) {
  const i = text.search(new RegExp(`^${QUOTES_HEAD}\\s*$`, 'm'));
  return i < 0 ? { body: text.trim(), quotes: '' } : { body: text.slice(0, i).trim(), quotes: text.slice(i + QUOTES_HEAD.length).trim() };
}

function quoteOf(e, name) {
  const t = (e.text || e.acts.join('；')).trim();
  const lines = (t.length > 1500 ? `${t.slice(0, 1500)}…` : t).split('\n');
  return [`> **${whoOf(e, name)}**：${lines[0]}`, ...lines.slice(1).map((l) => `> ${l}`)].join('\n');
}

/** 拆出 AI 回复最后的「相关原文：3, 7」，按编号从原对话里取出原话。 */
function parseTopicReply(text, entries, name) {
  const m = text.match(/\n?[ \t]*相关原文[:：][ \t]*([^\n]*)\s*$/);
  const body = (m ? text.slice(0, m.index) : text).trim();
  const nums = m ? [...new Set([...m[1].matchAll(/\d+/g)].map((x) => Number(x[0])))].filter((n) => entries[n - 1]).slice(0, MAX_QUOTES) : [];
  return { body, quotes: nums.sort((a, b) => a - b).map((n) => quoteOf(entries[n - 1], name)).join('\n\n') };
}

function topicPath(space, topic) {
  const base = `主题-${safeName(topic) || '简报'}`;
  let name = `${base}.md`;
  for (let k = 2; fs.existsSync(path.join(space.workspacePath, name)); k++) name = `${base}（${k}）.md`;
  return name;
}

/** 写主题简报（后台进行）。还没有简报时整理全部原文；已有简报时只把 briefCount 之后的新内容并进去。 */
async function writeTopic(space, msg, writer) {
  space.importing = true;
  const controller = space.importController = new AbortController();
  const state = space.data.memberState[writer.id];
  const resume = state?.importId === msg.id && !!state.sessionId;
  const update = msg.briefText != null && msg.briefCount > 0;
  const from = update ? msg.briefCount : 0;
  const list = msg.entries.slice(from);
  const numbered = list.map((e, i) => `[${from + i + 1}] ${entryText(e, msg.name)}`).join('\n\n');
  const old = update ? splitBrief(msg.briefText) : null;
  let prompt;
  if (update) {
    prompt = `这是之前按「${msg.topic}」这个主题整理的简报：\n\n${old.body}\n\n原对话之后又有了下面这些新内容（每条前面有编号）。把新内容里和这个主题有关的部分并进简报，保持原来的结构，写出完整的新简报（同样不超过 3000 字）。如果新内容和这个主题无关，只回复 ${NO_CHANGE}。\n\n${quoteAsk('新内容里的原话')}\n\n# 新内容\n${numbered}`;
  } else if (resume) {
    const index = list.map((e, i) => `[${i + 1}] 【${whoOf(e, msg.name)}】${preview(e.text || e.acts.join('；'), 60)}`).join('\n');
    prompt = `${topicAsk(msg.topic)}\n\n范围：我们这段对话的全部内容。需要的话可以去读项目里的文件，把格式、接口写准。\n\n${quoteAsk()}\n\n下面是对话各条的编号：\n${index}`;
  } else {
    prompt = `下面是用户和 ${msg.sourceLabel} 的一段对话（「我」是用户，「${msg.name}」是 ${msg.sourceLabel}），每条前面有编号。\n\n${topicAsk(msg.topic)}\n\n${quoteAsk()}\n\n# 对话\n${numbered}`;
  }
  const system = resume
    ? `${systemPrompt(space.toJSON(), writer, { api: space.registry.isApi(writer.engine) })}\n${state.note || ''}`
    : '你在帮用户整理导入的对话，照要求输出整理好的文字，不要加别的话。';
  const sink = { text: '', activities: [] };
  try {
    const r = await runAgentTurn(space.registry, writer, {
      system, prompt, cwd: space.workspacePath, access: 'read', sink, signal: controller.signal,
      sessionId: resume ? state.sessionId : undefined,
      fork: resume && state.fork,
    });
    if (space.deleting) return;
    const text = String(r.text || '').trim();
    if (!text) throw new Error(`${writer.name} 没有写出内容`);
    if (resume && r.sessionId) Object.assign(state, { sessionId: r.sessionId, fork: false });
    if (update && text.includes(NO_CHANGE) && text.length < NO_CHANGE.length + 20) {
      space.emitEvent({ type: 'notice', level: 'info', text: `新内容和「${msg.topic}」无关，简报没有改` });
    } else {
      const { body, quotes } = parseTopicReply(text, msg.entries, msg.name);
      const allQuotes = [old?.quotes, quotes].filter(Boolean).join('\n\n');
      const brief = `${body}${allQuotes ? `\n\n${QUOTES_HEAD}\n\n${allQuotes}` : ''}\n`;
      msg.brief ||= topicPath(space, msg.topic);
      Object.assign(msg, { briefText: brief, briefVer: (msg.briefVer || 0) + 1 });
      delete msg.briefPending;
      const changes = space.ws.write(msg.brief, brief, writer.name);
      if (changes.length) space.emitEvent({ type: 'files_changed', changes });
    }
    msg.briefCount = msg.entries.length;
    msg.status = 'ready';
    delete msg.error;
  } catch (e) {
    msg.status = 'error';
    msg.error = `${writer.name} 没有写成主题简报：${e.message}`;
    space.emitEvent({ type: 'notice', level: 'error', text: msg.error });
  } finally {
    space.importing = false;
    space.importController = null;
    space.save();
    space.emitEvent({ type: 'message_done', message: msg });
  }
}

/** 新建空间并按主题导入时：共享文件夹默认是原项目里的主题子文件夹，还没有就建出来。 */
export function topicFolder(dir, imp) {
  if (!dir || !path.isAbsolute(dir) || fs.existsSync(dir)) return;
  const s = readSession(imp.source, imp.sessionId);
  if (s.cwd && samePath(path.dirname(path.resolve(dir)), s.cwd)) fs.mkdirSync(dir);
}

const readOrNull = (space, rel) => { try { return space.ws.read(rel); } catch { return null; } };

/**
 * 共享文件夹有改动时调用：你改的简报直接生效；成员或别的软件改的先挂起，等你采用。
 * 简报文件被删掉并采用后（briefText 为 null），这块就不再跟踪。
 */
export function syncBriefs(space, changes) {
  for (const m of space.data.messages) {
    if (m.kind !== 'import' || m.mode !== 'topic' || !m.brief || m.briefText == null) continue;
    const c = changes.findLast((x) => x.path === m.brief);
    if (!c) continue;
    const cur = readOrNull(space, m.brief);
    const wasPending = !!m.briefPending;
    if (c.by === '我') {
      if (cur !== m.briefText) Object.assign(m, { briefText: cur, briefVer: m.briefVer + 1 });
      delete m.briefPending;
    } else if (cur === m.briefText) {
      delete m.briefPending;
    } else {
      m.briefPending = { by: c.by, after: cur };
      const who = c.by === '外部修改' ? '有人在软件外' : `${c.by} `;
      if (!wasPending) space.emitEvent({ type: 'notice', level: 'info', text: `${who}改了简报「${m.brief}」，在导入块上采用后才生效` });
    }
    space.save();
    space.emitEvent({ type: 'message_done', message: m });
  }
}

/** 处理简报上待确认的修改：accept 采用（以文件为准），revert 撤销（文件恢复成确认过的版本）。 */
export function resolveBrief(space, id, action) {
  const m = rootOf(space, id);
  if (m.mode !== 'topic' || !m.briefPending) throw new Error('简报没有待确认的修改');
  if (action === 'accept') {
    Object.assign(m, { briefText: readOrNull(space, m.brief), briefVer: m.briefVer + 1 });
    delete m.briefPending;
    space.save();
    space.emitEvent({ type: 'message_done', message: m });
  } else if (action === 'revert') {
    if (space.running) throw new Error('讨论进行中，先停止再撤销');
    const changes = space.ws.write(m.brief, m.briefText, '我');
    space.emitEvent({ type: 'files_changed', changes }); // syncBriefs 会清掉挂起
  } else {
    throw new Error(`未知操作：${action}`);
  }
  return m;
}

function handoffPath(space, title) {
  const base = `交接-${String(title).replace(/[\\/:*?"<>|\s]+/g, ' ').trim().slice(0, 40) || '对话'}`;
  let name = `${base}.md`;
  for (let k = 2; fs.existsSync(path.join(space.workspacePath, name)); k++) name = `${base}（${k}）.md`;
  return name;
}

// ---------- 补导 ----------

const writerOf = (space, root) => space.data.members.find((x) => x.id === root.writerId) || space.data.members.find((x) => x.id === root.memberId) || space.data.members[0];

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
  if (root.mode === 'topic') {
    if (root.status !== 'ready') throw new Error('简报还在整理，稍等');
    if (root.briefPending) throw new Error('简报上有还没确认的修改，先采用或撤销');
    if (root.briefText == null) throw new Error('简报文件已经删除了，想继续的话重新导入一次');
  }
  const { s, fresh } = newEntries(space, root);
  if (!fresh.length) return { added: 0, grown: false };
  const last = s.entries.at(-1);
  if (root.mode === 'topic') {
    root.entries.push(...fresh);
    Object.assign(root, { total: root.entries.length, lastKey: last.key, lastTs: last.ts, status: 'writing' });
    space.save();
    space.emitEvent({ type: 'message_done', message: root });
    space.track(writeTopic(space, root, writerOf(space, root)));
    return { added: fresh.length, grown: false };
  }
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
  if (root.mode === 'topic') { // 简报没写成：重试
    if (root.status !== 'error') return root;
    root.status = 'writing';
    delete root.error;
    space.save();
    space.emitEvent({ type: 'message_done', message: root });
    space.track(writeTopic(space, root, writerOf(space, root)));
    return root;
  }
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
    space.track(digest(space, root, m === 'handoff' ? entries : early, writerOf(space, root)));
  }
  return root;
}
