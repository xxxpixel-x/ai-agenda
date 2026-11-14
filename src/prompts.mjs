// 系统提示词与每次发言的输入。
import { t as tr } from './i18n.mjs';
import { randomBytes } from 'node:crypto';
import { fileBlockRules, filesForPrompt } from './engines/file-blocks.mjs';

const MAX_HISTORY = 40; // 每次最多带上最近多少条聊天记录

export const ACCESS = {
  read: { get label() { return tr('只读'); }, get desc() { return tr('你只能阅读共享文件夹里的文件，不能修改，也不能运行命令。'); } },
  edit: { get label() { return tr('可改文件'); }, get desc() { return tr('你可以阅读和修改共享文件夹里的文件；不要运行命令（Codex 的命令被限制在沙箱内）。'); } },
  run: { get label() { return tr('可运行命令'); }, get desc() { return tr('你可以阅读、修改共享文件夹里的文件，也可以在共享文件夹里运行命令（例如跑脚本、跑测试）。不要动共享文件夹以外的东西。'); } },
  full: { get label() { return tr('全部权限'); }, get desc() { return tr('你可以读写电脑上任何地方的文件、运行任何命令，不限于共享文件夹。'); } },
};

export const canRun = (access) => access === 'run' || access === 'full';

export const PASS = '[跳过]';
export const DONE = '[结束]';

// ---------- 发言人标记 ----------
// 给 AI 的输入是一整段文字，谁说的只能靠标注。每次输入换一个随机标记：
// AI 在回复里猜不到下一次的标记，所以冒充不了别人，尤其冒充不了「我」。

export const newKey = () => randomBytes(4).toString('hex');

export function said(key, who, text, user = false) {
  const speaker = user ? tr('我') : /^(me|我)$/i.test(who) ? `@${who}` : who;
  const name = String(speaker).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return tr('<消息 来自="{0}" 标记="{1}">\n{2}\n</消息>', [name, key, text]);
}

export const keyRule = (key) => tr('chat.keyRule', [key]);

/**
 * @param opts.access     这位成员实际拿到的权限（不能先问的 AI 在「可运行命令」档只能改文件），默认用空间的
 * @param opts.approvals  运行命令前会先问「我」
 */
export function systemPrompt(space, member, { api = false, access: granted = space.access, approvals = false } = {}) {
  const others = space.members.filter((m) => m.id !== member.id)
    .map((m) => `- @${m.name}（${m.engineLabel || m.engine}）`).join('\n') || tr('- （没有其他 AI）');
  const full = granted === 'full';
  // API 型 AI 只能通过文件块写共享文件夹，“全部权限”对它没有更多意义
  const base = ACCESS[api && full ? 'edit' : granted] || ACCESS.edit;
  const access = approvals ? { ...base, desc: tr('{0}每条命令运行前都会先请「我」确认；被拒绝时会告诉你理由，按理由调整做法，不要换一种写法绕过。', [base.desc]) } : base;
  return tr('chat.system', [
    member.name, others,
    api ? tr('大家共用一个文件夹，最新内容会附在下面。') : tr('大家共用你当前的工作目录：{0}', [space.workspacePath]),
    access.desc, tr(PASS), tr(DONE),
    full ? tr('用户开了“全部权限”，表示已经事先同意：直接去做，包括删除文件、改共享文件夹以外的地方，不用再问「我」；做完在聊天里说一句做了什么。')
      : tr('在用户的目标和当前权限之内可以照做；要删除文件、大范围改动用户没提过的内容、运行有风险的命令时，先在聊天里问「我」，等「我」同意再做（这次回复最后加上 {0}）。', [tr(DONE)]),
    member.persona ? tr('\n## 你的额外设定\n{0}\n', [member.persona]) : '',
    api ? `\n${fileBlockRules()}\n` : '',
  ]);
}

function line(m, key) {
  const who = m.kind === 'user' ? tr('我') : m.name;
  const parts = [];
  if (m.interrupted) parts.push(tr('（发言被打断）'));
  if (m.text?.trim()) parts.push(m.text.trim());
  if (m.changes?.length) parts.push(tr('（修改了：{0}）', [m.changes.map((c) => c.path).join('、')]));
  return said(key, who, parts.join('\n'), m.kind === 'user');
}

const visible = (m) => (m.kind === 'user' || m.kind === 'ai') && !m.passed && (m.text?.trim() || m.changes?.length);

/**
 * 本次发言的输入。
 *  since：只给出这条之后的新消息（续接会话时用，之前的它都记得）
 *  background：导入的外部对话（固定附带，不占聊天记录的条数）
 *  key：发言人标记，不给就新生成一个
 */
export function turnPrompt(space, member, { reason, api = false, files = null, since = null, background = '', key = newKey() } = {}) {
  const msgs = space.messages.filter(visible);
  let list = since != null ? space.messages.slice(since).filter(visible) : msgs.slice(-MAX_HISTORY);
  const omitted = since == null ? msgs.length - list.length : 0;
  const parts = [];
  if (since == null) parts.push(tr('# 空间：{0}', [space.title]));
  parts.push(keyRule(key));
  if (background) parts.push(background);
  if (api && files) parts.push(filesForPrompt(files));
  if (list.length) {
    parts.push(`# ${since != null ? tr('你上次发言之后的新消息') : tr('聊天记录')}${omitted ? tr('（更早的 {0} 条已省略）', [omitted]) : ''}\n${list.map((m) => line(m, key)).join('\n\n')}`);
  } else if (since != null) {
    parts.push(tr('# 你上次发言之后没有新消息'));
  }
  if (reason === 'mention') parts.push(tr('有人 @ 了你。现在请你（「{0}」）回应。', [member.name]));
  else parts.push(tr('现在轮到你（「{0}」）发言。没有要补充的就只回复 {1}。', [member.name, tr(PASS)]));
  return parts.join('\n\n');
}

/** 解析回复里的 [跳过] / [结束] 标记。 */
export function parseMarkers(text) {
  // 有的 AI 会照着聊天记录的格式，把自己的回复也包一层 <消息>
  let t = String(text || '').trim().replace(/^<(?:消息|message)(?=[\s>])[^>\n]*>\s*/i, '').replace(/\s*<\/(?:消息|message)>$/i, '').trim();
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
