// 同一份上下文既用于实际调用，也用于成员面板的预览。
import { t as tr } from './i18n.mjs';
import { filesForPrompt } from './engines/file-blocks.mjs';

export const HISTORY_STEP = 10;
const uniqueIds = (ids) => [...new Set(ids)].sort((a, b) => a - b);
const join = (parts) => parts.filter(Boolean).join('\n\n');
export const escapeTags = (text) => String(text ?? '').replace(/<(\s*\/?\s*)(消息|message)(?=[\s>/]|$)/gi, '＜$1$2');

export function estimateTokens(text) {
  let han = 0, other = 0;
  for (const ch of String(text || '')) {
    if (/\p{Script=Han}/u.test(ch)) han++;
    else other++;
  }
  return han + Math.ceil(other / 4);
}

export function limitKeyFor(member, provider) {
  const model = member.model || provider?.model || 'default';
  return provider?.id ? `provider:${provider.id}:${model}` : `${member.engine}:${model}`;
}

const PRESETS = [[/claude|opus|sonnet|haiku|fable/i, 200000], [/gemini/i, 1000000],
  [/gpt-4\.1/i, 1000000], [/gpt-4o|gpt-4-turbo/i, 128000], [/gpt-5|codex/i, 272000],
  [/(?:^|[/:-])o[134]/i, 200000], [/deepseek|dsh|qwen|kimi|moonshot|glm/i, 128000]];

export function contextWindowFor(member, { provider, learnedLimits } = {}) {
  const learned = learnedLimits?.[limitKeyFor(member, provider)];
  if (Number.isSafeInteger(learned) && learned > 0) return learned;
  if (Number.isSafeInteger(provider?.contextWindow) && provider.contextWindow > 0) return provider.contextWindow;
  for (const name of [member.model || provider?.model, ...(provider || member.source ? [] : [member.engine])]) {
    const preset = name && PRESETS.find(([re]) => re.test(name));
    if (preset) return preset[1];
  }
  return 64000;
}

export const isContextLengthError = (err) => err?.contextOverflow === true || /context[_\s-]?length|maximum context|context window|prompt is too long|too many tokens|token limit|input is too long|exceeds.*(limit|maximum|window)|上下文超长|超出上下文/i.test(err?.message || '');
export const budgetFor = (window) => Math.min(Math.floor(window * 0.55), 80000);
const measure = (s) => ({ chars: s.length, tokens: estimateTokens(s) });

export async function withOverflowRetry(host, member, sink, build, send, signal, retry = { used: false }) {
  const options = host.contextOptions?.(member) || {};
  let budget = budgetFor(contextWindowFor(member, options));
  for (;;) {
    const ctx = build(budget);
    const sent = estimateTokens(ctx.system) + estimateTokens(ctx.prompt);
    if (sent > budget) throw new Error(tr('当前预算装不下必需的指令，请缩短输入或调大模型上下文窗口。'));
    host.recordContext?.(member.id, ctx.breakdown);
    try {
      const result = await send(ctx);
      return { result, meta: ctx.meta };
    } catch (e) {
      if (retry.used || signal?.aborted || !isContextLengthError(e)) throw e;
      retry.used = true;
      const window = Math.min(contextWindowFor(member, options), Math.max(4000, Math.floor((sent || budget) * 0.6)));
      host.rememberContextLimit?.(limitKeyFor(member, options.provider), window);
      budget = budgetFor(window);
      sink.text = '';
    }
  }
}

const emptyMemory = () => ({ prefix: '', extras: '', entryIds: [] });

/** 原文和条目详情只给没有读文件工具的成员；目录里的编号不等于已经读了条目。 */
function originals(memory, messages, references, hits, included) {
  const ids = new Set(), seqs = new Set();
  for (const match of references.matchAll(/(?:消息|message)\s*#?(\d+)/gi)) seqs.add(+match[1]);
  for (const match of references.matchAll(/#(\d+)\b/g)) if (!included.includes(+match[1])) ids.add(+match[1]);
  for (const entry of hits) for (const seq of entry.source.messages || []) seqs.add(seq);
  let remaining = 4000;
  const parts = [], entryIds = [];
  for (const id of [...ids].slice(0, 5)) {
    const detail = memory.render({ layer: 3, ids: [id] });
    if (!detail || detail.length > remaining) continue;
    parts.push(detail);
    entryIds.push(id);
    remaining -= detail.length;
    for (const seq of memory.get(id)?.source.messages || []) seqs.add(seq);
  }
  for (const seq of [...seqs].slice(0, 5)) {
    if (remaining < 30) break;
    const text = memory.readMessage(seq) || messages.find((m) => m.seq === seq)?.text;
    if (!text) continue;
    const block = (tr('消息 {0}', [seq]) + '\n' + text).slice(0, remaining);
    parts.push(block);
    remaining -= block.length;
  }
  return { text: join(parts), entryIds };
}

export function memoryForTurn({ memory, memoryDir, task, query = '', references = query, messages = [], sinceId, api }, { extras = true, budget } = {}) {
  if (!memory) return emptyMemory();
  const one = memory.renderWithIds({ layer: 1, task, sinceId, query, budget });
  const directory = extras && sinceId == null ? memory.render({ layer: 2 }) : '';
  const hits = extras && !task ? memory.search(query, { limit: 6 }).map((r) => r.entry).filter((e) => !one.entryIds.includes(e.id)) : [];
  const hitIds = hits.map((e) => e.id);
  const detail = hitIds.length ? memory.render({ layer: 3, ids: hitIds }) : '';
  const included = [...one.entryIds, ...hitIds];
  const source = extras && api ? originals(memory, messages, references + '\n' + detail, hits, included) : { text: '', entryIds: [] };
  const hint = !api && memoryDir && (one.text || directory || detail || (extras && sinceId == null && memory.entries().length))
    ? tr('只读记忆库：{0}（memory.md 和 messages/<seq>.md）', [memoryDir]) : '';
  const prefix = join([one.text, directory, hint]);
  const extraText = join([detail, source.text]);
  return { prefix: prefix ? escapeTags(tr('# 空间记忆库') + '\n' + prefix) : '',
    extras: escapeTags(api && extraText ? tr('# 相关原文') + '\n' + extraText : extraText), layerOneIds: one.entryIds, entryIds: uniqueIds([...included, ...source.entryIds]) };
}

// 只摘录可回查的资料；系统规则和任务指令必须原样送达。
function excerpt(text, tokens) {
  if (!text || tokens <= 0) return '';
  if (estimateTokens(text) <= tokens) return text;
  const chars = [...text];
  let lo = 0, hi = chars.length;
  const sample = (n) => {
    const head = Math.ceil(n * 0.6), tail = n - head;
    return chars.slice(0, head).join('') + '…' + (tail ? chars.slice(-tail).join('') : '');
  };
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(sample(mid)) <= tokens) lo = mid;
    else hi = mid - 1;
  }
  return sample(lo);
}

/** 先压较早的导入，再按档缩历史、按相关度缩记忆，最后缩文件。compose 负责各类提示词的布局。 */
export function assembleContext({ system, tokenBudget, imports = [], lines = [], start = 0, historyChars = Infinity,
  recap = '', handoff = '', files, memory = emptyMemory, compose, lastMemoryId }) {
  let cut = start;
  const historyText = lines.map((l) => l.text);
  const blocks = imports.map((b) => b.fullText);
  const initial = memory();
  let mem = initial, fileText = files ? escapeTags(filesForPrompt(files)) : '';
  let recapText = escapeTags(recap), handoffText = escapeTags(handoff);
  const history = () => historyText.slice(cut).join('\n\n');
  const sections = () => ({ memory: mem, imports: escapeTags(blocks.join('\n\n---\n\n')), recent: history(),
    omitted: cut, recap: cut ? recapText : '', handoff: handoffText, files: fileText });
  const systemTokens = estimateTokens(system);
  const size = () => systemTokens + estimateTokens(compose(sections()));
  for (let i = 0; i < imports.length && size() > tokenBudget; i++) {
    if (imports[i].summaryText.length < blocks[i].length) blocks[i] = imports[i].summaryText;
  }
  if (cut < lines.length - 1 && (size() > tokenBudget || history().length > historyChars)) {
    // 二分找第一个装得下的十条档位，避免长聊天逐档重复估算。
    let lo = 1, hi = Math.ceil((lines.length - 1 - start) / HISTORY_STEP);
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      cut = Math.min(start + mid * HISTORY_STEP, lines.length - 1);
      if (size() <= tokenBudget && history().length <= historyChars) hi = mid;
      else lo = mid + 1;
    }
    cut = Math.min(start + lo * HISTORY_STEP, lines.length - 1);
  }
  if (size() > tokenBudget) {
    mem = memory({ extras: false });
    if (size() > tokenBudget && mem.prefix) {
      const chars = mem.prefix.length;
      mem = emptyMemory();
      const available = Math.max(0, tokenBudget - size());
      mem = memory({ extras: false, budget: Math.min(chars, available * 4) });
      if (size() > tokenBudget) mem = memory({ extras: false, budget: available });
      if (size() > tokenBudget) mem = emptyMemory();
    }
  }
  if (fileText && size() > tokenBudget) {
    fileText = '';
    let chars = Math.max(0, tokenBudget - size()) * 4;
    do {
      fileText = escapeTags(filesForPrompt(files, { maxTotal: chars }));
      if (size() <= tokenBudget) break;
      fileText = '';
      chars = Math.floor(chars / 2);
    } while (chars > 0);
  }
  // 极小窗口也可能装不下一份摘要、用户编辑的提要或单条长消息。
  for (let i = 0; i < blocks.length && size() > tokenBudget; i++) {
    const original = blocks[i];
    blocks[i] = '';
    blocks[i] = excerpt(original, tokenBudget - size());
  }
  if (size() > tokenBudget && cut && recapText) {
    const original = recapText;
    recapText = '';
    recapText = excerpt(original, tokenBudget - size() - 1);
  }
  if (size() > tokenBudget && handoffText) {
    const original = handoffText;
    handoffText = '';
    handoffText = excerpt(original, tokenBudget - size() - 1);
  }
  if (size() > tokenBudget && lines.length - cut === 1) {
    const line = historyText[cut].match(/^(<(?:消息|message) [^\n]+>\n)([\s\S]*)(\n<\/(?:消息|message)>)$/);
    if (line) {
      historyText[cut] = line[1] + line[3];
      historyText[cut] = line[1] + excerpt(line[2], tokenBudget - size()) + line[3];
    }
  }
  const s = sections();
  const firstUnsent = initial.layerOneIds?.find((id) => !mem.entryIds.includes(id));
  if (firstUnsent != null) lastMemoryId = firstUnsent - 1;
  const omitted = lines.slice(0, cut);
  let omittedSeq = 0;
  for (const line of omitted) omittedSeq = Math.max(omittedSeq, line.seq || 0);
  return { system, prompt: compose(s), breakdown: {
    system: measure(system), memory: { ...measure(join([mem.prefix, mem.extras])), entryIds: mem.entryIds },
    recap: measure(join([s.recap, s.handoff])), imports: measure(s.imports), recent: { count: lines.length - cut, ...measure(s.recent) },
    omitted: { count: cut, ...measure(omitted.map((l) => l.text).join('\n\n')) }, files: measure(fileText),
  }, meta: { omittedSeq, compacted: cut > 0, usedMemoryIds: mem.entryIds, lastMemoryId } };
}

export const handoffSystem = () => tr('你正在为自己的下一个会话写交接说明。');
export const handoffPrompt = (recent) => tr('只简短记录新会话从代码、记忆库和最近几轮看不到的内容：试过但走不通的做法及原因、未完成的工作、下一步要回查的消息或任务执行编号。不要重复记忆库。没有就回复 [无]。\n{0}', [escapeTags(recent)]);

