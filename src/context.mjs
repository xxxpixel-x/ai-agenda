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

const emptyMemory = () => ({ prefix: '', l1: '', l2: '', extras: '', entryIds: [], layerOneIds: [], activeLayerOneIds: [], mandatoryIds: [], truncatedMandatory: false });

/** 原文和条目详情给无法直读 memoryDir 的成员；优先本轮用户/对话明确点名，不把自动渲染出的引用再次当查询。 */
function originals(memory, messages, references, hits, included) {
  const explicitIds = new Set(), seqs = new Set();
  const refText = String(references || '');
  // 分开解析「消息 N」与条目「#N」，先提取明确点名的消息编号再提取条目编号（避免「消息 #N」被当成条目 #N）。
  const withoutMsgRefs = refText.replace(/(?:消息|message)\s*#?(\d+)/gi, (_, n) => { seqs.add(+n); return ' '; });
  for (const match of withoutMsgRefs.matchAll(/#(\d+)\b/g)) explicitIds.add(+match[1]);
  for (const entry of hits) for (const seq of entry.source?.messages || []) seqs.add(seq);
  let remaining = 4000;
  const parts = [], entryIds = [];
  for (const id of [...explicitIds].slice(0, 5)) {
    const entry = memory.get(id);
    if (!entry) continue; // 控制行或不存在的编号安全跳过
    const detail = memory.render({ layer: 3, ids: [id] });
    if (detail && detail.length <= remaining) {
      parts.push(detail);
      entryIds.push(id);
      remaining -= detail.length;
    }
    for (const seq of entry.source?.messages || []) seqs.add(seq);
  }
  for (const seq of [...seqs].slice(0, 5)) {
    if (remaining < 30) break;
    const text = memory.readMessage(seq) || messages.find((m) => m.seq === seq)?.text;
    if (!text) continue;
    const raw = tr('消息 {0}', [seq]) + '\n' + text;
    const block = raw.length > remaining ? raw.slice(0, Math.max(0, remaining - 1)) + '…' : raw;
    parts.push(block);
    remaining -= block.length;
  }
  return { text: join(parts), entryIds };
}

export function memoryForTurn({ memory, memoryDir, task, query = '', references = query, messages = [], sinceId, api, canReadMemoryDir }, { extras = true, budget, mandatoryOnly = false } = {}) {
  if (!memory) return emptyMemory();
  const canReadDir = canReadMemoryDir === true;
  const one = memory.renderWithIds({ layer: 1, task, sinceId, query, budget, mandatoryOnly });
  const directory = extras && sinceId == null && !mandatoryOnly ? memory.render({ layer: 2 }) : '';
  // 先排除已在第 1 层的条目再取前 6 条。
  const hits = extras && !task && !mandatoryOnly
    ? memory.search(query, { limit: 20 }).map((r) => r.entry).filter((e) => !one.entryIds.includes(e.id)).slice(0, 6)
    : [];
  const hitIds = hits.map((e) => e.id);
  const detail = hitIds.length ? memory.render({ layer: 3, ids: hitIds }) : '';
  const included = [...one.entryIds, ...hitIds];
  const source = extras && !canReadDir && !mandatoryOnly ? originals(memory, messages, references, hits, included) : { text: '', entryIds: [] };
  const hint = canReadDir && memoryDir && (one.text || directory || detail || (extras && sinceId == null && memory.entries().length))
    ? tr('只读记忆库：{0}（memory.md 和 messages/<seq>.md）', [memoryDir]) : '';
  const l1Body = join([one.text, hint]);
  const l1 = l1Body ? escapeTags(tr('# 空间记忆库') + '\n' + l1Body) : '';
  const l2 = directory ? escapeTags(tr('## 记忆库目录') + '\n' + directory) : '';
  const prefixBody = join([one.text, directory, hint]);
  const prefix = prefixBody ? escapeTags(tr('# 空间记忆库') + '\n' + prefixBody) : '';
  const extraText = join([detail, source.text]);
  return {
    prefix,
    l1,
    l2,
    extras: escapeTags(!canReadDir && extraText ? tr('# 相关原文') + '\n' + extraText : extraText),
    layerOneIds: one.entryIds,
    activeLayerOneIds: one.activeIds ?? one.entryIds,
    mandatoryIds: one.mandatoryIds ?? [],
    truncatedMandatory: !!one.truncatedMandatory,
    entryIds: uniqueIds([...included, ...source.entryIds]),
  };
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

/** 缩减顺序：旧导入降摘要 → 历史按档往后裁 → 去 L2/extras → 缩 API 文件 → 缩非必守记忆 → 摘录导入/提要/交接/超长单条；必守约束与撤回不可静默清空。 */
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

  // 1. 较早导入降为摘要
  for (let i = 0; i < imports.length && size() > tokenBudget; i++) {
    if (imports[i].summaryText.length < blocks[i].length) blocks[i] = imports[i].summaryText;
  }
  // 2. 聊天历史按 10 条一档二分往后裁
  if (cut < lines.length - 1 && (size() > tokenBudget || history().length > historyChars)) {
    let lo = 1, hi = Math.ceil((lines.length - 1 - start) / HISTORY_STEP);
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      cut = Math.min(start + mid * HISTORY_STEP, lines.length - 1);
      if (size() <= tokenBudget && history().length <= historyChars) hi = mid;
      else lo = mid + 1;
    }
    cut = Math.min(start + lo * HISTORY_STEP, lines.length - 1);
  }
  // 3. 去掉 memory.l2 / extras
  if (size() > tokenBudget) {
    mem = memory({ extras: false });
  }
  // 4. 缩 API 附带文件（移到必守约束之前）
  if (fileText && size() > tokenBudget) {
    fileText = '';
    let chars = Math.max(0, tokenBudget - size()) * 4;
    do {
      fileText = escapeTags(filesForPrompt(files, { maxTotal: chars }));
      if (size() <= tokenBudget) break;
      fileText = '';
      chars = Math.floor(chars / 2);
    } while (chars > 0);
    if (!fileText) {
      const sensitive = files.filter((f) => f.sensitive === true);
      if (sensitive.length) fileText = escapeTags(filesForPrompt(sensitive));
    }
  }
  // 5. 缩减非必守记忆（必守硬约束与增量撤回禁止静默置空）
  if (size() > tokenBudget && (mem.l1 || mem.prefix)) {
    const chars = (mem.l1 || mem.prefix).length;
    const mandatoryMem = memory({ extras: false, mandatoryOnly: true });
    const hasMandatory = (mandatoryMem.mandatoryIds?.length || 0) > 0;
    mem = emptyMemory();
    const available = Math.max(0, tokenBudget - size());
    mem = memory({ extras: false, budget: Math.min(chars, available * 4) });
    if (size() > tokenBudget) mem = memory({ extras: false, budget: available });
    if (size() > tokenBudget) mem = hasMandatory ? mandatoryMem : emptyMemory();
  }
  // 6. 极小窗口下头尾摘录导入 / 提要 / 交接 / 超长单条消息
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
  // 只按有效/必送 ID 计算未送达游标，防止裁剪掉已失效旧行导致 lastMemoryId 倒退。
  const trackIds = initial.activeLayerOneIds || initial.layerOneIds;
  const firstUnsent = trackIds?.find((id) => !mem.entryIds.includes(id));
  if (firstUnsent != null) lastMemoryId = firstUnsent - 1;
  const omitted = lines.slice(0, cut);
  let omittedSeq = 0;
  for (const line of omitted) omittedSeq = Math.max(omittedSeq, line.seq || 0);
  const memCombined = join([mem.l1 || mem.prefix, mem.l1 ? mem.l2 : '', mem.extras]);
  return { system, prompt: compose(s), breakdown: {
    system: measure(system), memory: { ...measure(memCombined), entryIds: mem.entryIds },
    recap: measure(join([s.recap, s.handoff])), imports: measure(s.imports), recent: { count: lines.length - cut, ...measure(s.recent) },
    omitted: { count: cut, ...measure(omitted.map((l) => l.text).join('\n\n')) }, files: measure(fileText),
  }, meta: { omittedSeq, compacted: cut > 0, usedMemoryIds: mem.entryIds, lastMemoryId } };
}

export const handoffSystem = () => tr('你正在为自己的下一个会话写交接说明。');
export const handoffPrompt = (recent) => tr('只简短记录新会话从代码、记忆库和最近几轮看不到的内容：试过但走不通的做法及原因、未完成的工作、下一步要回查的消息或任务执行编号。不要重复记忆库。没有就回复 [无]。\n{0}', [escapeTags(recent)]);
