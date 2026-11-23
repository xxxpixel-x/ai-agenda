// 系统提示词与每次发言的输入。
import { t as tr } from './i18n.mjs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { assembleContext, memoryForTurn, escapeTags, budgetFor, contextWindowFor } from './context.mjs';
export { escapeTags };
import { fileBlockRules } from './engines/file-blocks.mjs';

// 聊天记录按字数取：超出预算时按档往后裁，同一档里开头几轮不变，模型那边的前缀缓存才用得上
const HISTORY_CHARS = 60000;

// 较早的 AI 长回复只留头尾（最近几条保持原样）
const LONG_REPLY = 8000;
const CLIP_HEAD = 4000;
const CLIP_TAIL = 1000;
const RECENT_FULL = 6;

export const ACCESS = {
  read: { get label() { return tr('只读'); }, get desc() { return tr('你只能阅读共享文件夹里的文件，不能修改，也不能运行命令。'); } },
  edit: { get label() { return tr('可改文件'); }, get desc() { return tr('你可以阅读和修改共享文件夹里的文件；不要运行命令（Codex 的命令被限制在沙箱内）。'); } },
  run: { get label() { return tr('可运行命令'); }, get desc() { return tr('你可以阅读、修改共享文件夹里的文件，也可以在共享文件夹里运行命令（例如跑脚本、跑测试）。不要动共享文件夹以外的东西。'); } },
  full: { get label() { return tr('全部权限'); }, get desc() { return tr('你可以读写电脑上任何地方的文件、运行任何命令，不限于共享文件夹。'); } },
};

export const canRun = (access) => access === 'run' || access === 'full';

export const PASS = '[跳过]';
export const DONE = '[结束]';

// ---------- 发言人标注 ----------
// 给 AI 的输入是一整段文字，谁说的只能靠 <消息> 框标注。
// 放进输入的内容（消息、导入的对话、附带的文件）里出现的 <消息> 标签一律转义，伪造的消息框进不了输入，
// 所以聊天的消息框格式是固定的，每轮输入的前面部分保持不变，能命中缓存。
// 任务协作的提示词是一次性的，另外再加一个每次都换的随机标记（key）。

export const newKey = () => randomBytes(4).toString('hex');

export function said(key, who, text, user = false, seq = null) {
  const speaker = user ? tr('我') : /^(me|我)$/i.test(who) ? `@${who}` : who;
  const name = String(speaker).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const body = escapeTags(text);
  if (key) return tr('<消息 来自="{0}" 标记="{1}">\n{2}\n</消息>', [name, key, body]);
  if (Number.isSafeInteger(seq) && seq > 0) return tr('<消息 {0} 来自="{1}">\n{2}\n</消息>', [seq, name, body]);
  return tr('<消息 来自="{0}">\n{1}\n</消息>', [name, body]);
}

export const keyRule = (key) => tr('chat.keyRule', [key]);

/**
 * @param opts.access     这位成员实际拿到的权限（不能先问的 AI 在「可运行命令」档只能改文件），默认用空间的
 * @param opts.approvals  运行命令前会先问「我」
 * @param opts.solo       单人聊天：不讲其他成员、轮流和 [跳过] / [结束]
 */
export function systemPrompt(space, member, { api = false, access: granted = space.access, approvals = false, solo = false } = {}) {
  const full = granted === 'full';
  // API 型 AI 只能通过文件块写共享文件夹，“全部权限”对它没有更多意义
  const base = ACCESS[api && full ? 'edit' : granted] || ACCESS.edit;
  const access = approvals ? { ...base, desc: tr('{0}每条命令运行前都会先请「我」确认；被拒绝时会告诉你理由，按理由调整做法，不要换一种写法绕过。', [base.desc]) } : base;
  const extra = [
    member.persona ? tr('\n## 你的额外设定\n{0}\n', [member.persona]) : '',
    api ? `\n${fileBlockRules()}\n` : '',
  ];
  if (solo) {
    return tr('chat.systemSolo', [
      member.name,
      api ? tr('共享文件夹的最新内容会附在下面。') : tr('你当前的工作目录：{0}', [space.workspacePath]),
      access.desc,
      full ? tr('用户开了“全部权限”，表示已经事先同意：直接去做，包括删除文件、改共享文件夹以外的地方，不用再问「我」；做完说一句做了什么。')
        : tr('要删除文件、大范围改动用户没提过的内容、运行有风险的命令时，先问「我」，等「我」同意再做。'),
      ...extra,
    ]);
  }
  const others = space.members.filter((m) => m.id !== member.id)
    .map((m) => `- @${m.name}（${m.engineLabel || m.engine}）`).join('\n') || tr('- （没有其他 AI）');
  return tr('chat.system', [
    member.name, others,
    api ? tr('大家共用一个文件夹，最新内容会附在下面。') : tr('大家共用你当前的工作目录：{0}', [space.workspacePath]),
    access.desc, tr(PASS), tr(DONE),
    full ? tr('用户开了“全部权限”，表示已经事先同意：直接去做，包括删除文件、改共享文件夹以外的地方，不用再问「我」；做完在聊天里说一句做了什么。')
      : tr('在用户的目标和当前权限之内可以照做；要删除文件、大范围改动用户没提过的内容、运行有风险的命令时，先在聊天里问「我」，等「我」同意再做（这次回复最后加上 {0}）。', [tr(DONE)]),
    ...extra,
  ]);
}

function clip(text, seq, canReadMemoryDir) {
  if (text.length <= LONG_REPLY) return text;
  const omitted = text.length - CLIP_HEAD - CLIP_TAIL;
  const note = Number.isSafeInteger(seq) && seq > 0
    ? (canReadMemoryDir
      ? tr('……（中间省略 {0} 字，完整见 messages/{1}.md）……', [omitted, seq])
      : tr('……（中间省略 {0} 字，用户或下一位发言者提到「消息 {1}」时自动附原文）……', [omitted, seq]))
    : tr('……（中间省略 {0} 字）……', [omitted]);
  return `${text.slice(0, CLIP_HEAD)}\n${note}\n${text.slice(-CLIP_TAIL)}`;
}

export function attachmentText(m, root) {
  const lines = [m.text || ''];
  for (const a of m.attachments || []) {
    lines.push(a.kind === 'image' ? tr('[图片：{0}]', [a.name]) : tr('[附件：{0}]', [root ? path.resolve(root, a.path) : a.path]));
  }
  return lines.filter(Boolean).join('\n');
}

function line(m, full, names, canReadMemoryDir) {
  const who = m.kind === 'user' ? tr('我') : m.name;
  const parts = [];
  if (m.only && names?.has(m.only)) parts.push(tr('（只问 {0}）', [names.get(m.only)]));
  if (m.kind === 'task') parts.push(tr('（任务空间「{0}」结束了，这是协调者的总结）', [m.title]));
  if (m.interrupted) parts.push(tr('（发言被打断）'));
  const text = attachmentText(m).trim();
  if (text) parts.push(m.kind === 'ai' && !full ? clip(text, m.seq, canReadMemoryDir) : text);
  if (m.changes?.length) parts.push(tr('（修改了：{0}）', [m.changes.map((c) => c.path).join('、')]));
  if (m.actions?.length) parts.push(tr('（运行了：{0}）', [m.actions.join(tr('、'))]));
  return said(null, who, parts.join('\n'), m.kind === 'user', m.seq);
}

export const visible = (m) => (m.kind === 'user' || m.kind === 'ai' || m.kind === 'task') && !m.passed && !m.streaming && (m.text?.trim() || m.attachments?.length || m.changes?.length || m.actions?.length);

/** 最近 rounds 轮的起点：倒数第 rounds 条「我」的消息在 messages 里的位置。 */
export function recentStart(messages, rounds) {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].kind === 'user' && ++n >= rounds) return i;
  return 0;
}

/**
 * 本次发言的输入。固定的内容在前、每轮会变的在后，好让模型复用前缀缓存。
 *  since：只给出这条之后的新消息（续接会话时用，之前的它都记得）
 *  recent：新开的长会话只带从这条开始的最近几轮原文，更早的算作省略
 *  background：导入的外部对话（固定附带，不占聊天记录的预算）
 *  reason：'turn' 轮到你 / 'mention' 被 @ / 'only' 只问你 / 'solo' 单人聊天（不提 [跳过]）
 */
export function turnPrompt(space, member, opts) {
  return buildTurnContext(space, member, opts).prompt;
}

export function buildTurnContext(space, member, opts = {}) {
  const { reason, api = false, canReadMemoryDir = member?.engine === 'pi', files, since, recent, background, system = '', importBlocks, memory, memoryDir,
    recap = '', recapUptoSeq = 0, handoffNote = '', lastMemoryId, tokenBudget = member.engine ? budgetFor(contextWindowFor(member)) : 80000 } = opts;
  const pool = space.messages.slice(since ?? 0).filter(visible);
  const start = since == null && recent ? space.messages.slice(0, recent).filter(visible).length : 0;
  const names = new Map((space.members || []).map((m) => [m.id, m.name]));
  const lines = pool.map((m, i) => ({ seq: m.seq, text: line(m, recent != null && i >= start || i >= pool.length - RECENT_FULL, names, canReadMemoryDir) }));
  const query = pool.findLast((m) => m.kind === 'user')?.text || pool.at(-1)?.text || '';
  const references = [query, ...(since != null ? pool : pool.slice(-3)).map((m) => m.text), recap, handoffNote].join('\n');
  const parts = [];
  if (space.readOnly) parts.push(tr('# 文件暂时只读\n任务空间「{0}」正在依次修改共享文件夹，在它做完之前，这个空间只能阅读文件，不能修改。聊天照常进行。', [escapeTags(space.readOnly.title)]));
  if (reason === 'only') parts.push(tr('「我」这条只问你（「{0}」），其他成员这次不接话。现在请你回应。', [member.name]));
  else if (reason === 'solo') parts.push(tr('现在请你（「{0}」）回复。', [member.name]));
  else if (reason === 'mention') parts.push(tr('有人 @ 了你。现在请你（「{0}」）回应。', [member.name]));
  else parts.push(tr('现在轮到你（「{0}」）发言。没有要补充的就只回复 {1}。', [member.name, tr(PASS)]));
  const ending = parts.join('\n\n');
  const recapTitle = recapUptoSeq > 0 ? tr('# 前情提要（截至消息 {0}）', [recapUptoSeq]) : tr('# 前情提要');
  return assembleContext({ system, tokenBudget, files: api ? files : null, lines, start, historyChars: member.engine || opts.tokenBudget != null ? Infinity : HISTORY_CHARS,
    imports: importBlocks || (background ? [{ fullText: background, summaryText: background }] : []),
    handoff: handoffNote ? tr('# 上个会话的交接说明') + '\n' + handoffNote : '',
    recap: recap ? recapTitle + '\n' + recap : '', lastMemoryId: memory?.latestId ?? memory?.entries().at(-1)?.id ?? 0,
    memory: (limits) => memoryForTurn({ memory, memoryDir, query, references, messages: space.messages, sinceId: since != null ? lastMemoryId ?? 0 : undefined, api, canReadMemoryDir }, limits),
    compose: (s) => {
      const history = s.recent ? `# ${since != null ? tr('你上次发言之后的新消息') : tr('聊天记录')}${s.omitted ? tr('（更早的 {0} 条已省略）', [s.omitted]) : ''}\n${s.recent}`
        : since != null ? tr('# 你上次发言之后没有新消息') : '';
      const tailMemory = [s.memory.l2, s.memory.extras].filter(Boolean).join('\n\n');
      return [since == null && tr('# 空间：{0}', [escapeTags(space.title)]), tr('chat.rule'), s.imports, s.memory.l1,
        s.recap, s.handoff, history, tailMemory, s.files, ending].filter(Boolean).join('\n\n');
    },
  });
}

/** 解析回复里的 [跳过] / [结束] 标记。markers 为 false（单人聊天）时不认标记：顺手去掉，只剩标记时原样保留。 */
export function parseMarkers(text, { markers = true } = {}) {
  // 有的 AI 会照着聊天记录的格式，把自己的回复也包一层 <消息>
  let t = String(text || '').trim().replace(/^<(?:消息|message)(?=[\s>])[^>\n]*>\s*/i, '').replace(/\s*<\/(?:消息|message)>$/i, '').trim();
  if (!markers) return { text: t.replace(/\s*\[(?:结束|Done|跳过|Skip)\]/gi, '').trim() || t, passed: false, done: false };
  const skip = /\[(?:跳过|Skip)\]/i;
  const passed = /^\[(?:跳过|Skip)\]$/i.test(t.replace(/[。.!！\s]/g, '')) || (t.length < 20 && skip.test(t));
  if (passed) return { text: '', passed: true, done: false };
  const done = /\[(?:结束|Done)\]$/i.test(t);
  t = t.replace(/\[(?:结束|Done|跳过|Skip)\]/gi, '').trim();
  return { text: t, passed: false, done };
}

/** 回复里 @ 到的其他成员（按出现顺序）。 */
export function mentionsIn(text, members, selfId) {
  const hits = [];
  const sorted = [...members].sort((a, b) => b.name.length - a.name.length);
  for (const m of sorted) {
    if (m.id === selfId) continue;
    const idx = text.indexOf(`@${m.name}`);
    if (idx >= 0) hits.push({ id: m.id, idx });
  }
  return hits.sort((a, b) => a.idx - b.idx).map((h) => h.id);
}
