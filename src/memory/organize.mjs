import { t as tr } from '../i18n.mjs';
import { escapeTags, visible, attachmentText } from '../prompts.mjs';
import { estimateTokens, contextWindowFor } from '../context.mjs';
import { runAgentTurn } from '../turn-runner.mjs';
import { resolveTurnAccess } from '../access.mjs';
import { check, normalizeOrganizerResult, normPath } from './rules.mjs';
import { tokenize } from './tokens.mjs';

const escapeRecord = (s) => escapeTags(s).replace(/<(\s*\/?\s*)(交接说明|handoff)(?=[\s>/]|$)/gi, '＜$1$2');
const kinds = ['user', 'ai', 'summary', 'task', 'import'];
const firstLine = (text) => (text || '').trim().split(/\r?\n/, 1)[0].slice(0, 120);
const clipBlock = (text, max = 450) => {
  const s = String(text || '').trim().replace(/\r\n/g, '\n');
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
};
const paths = (changes) => [...new Set((changes || []).map((c) => normPath(typeof c === 'string' ? c : c?.path)).filter(Boolean))];

export function messageView(m) {
  const view = { seq: m.seq, kind: m.kind, name: m.kind === 'user' ? tr('我') : m.name || m.kind,
    ts: m.ts, text: m.text || '', changes: paths(m.changes), activities: !!m.activities?.length };
  if (m.kind === 'import') {
    const lines = [];
    let length = 0;
    for (const e of m.entries || []) {
      const speaker = e.role === 'user' ? tr('我') : e.name || m.name || e.role;
      const name = e.ts ? tr('{0}，{1}', [speaker, time(e.ts)]) : speaker;
      const line = tr('【{0}】{1}', [name, e.text || '']);
      lines.push(line);
      length += line.length + 1;
      if (length >= 4000) break;
    }
    view.text = lines.join('\n').slice(0, 4000);
    view.originalTs = m.lastTs;
  }
  return view;
}

export function isArchivableMessage(m) {
  if (!m || !kinds.includes(m.kind) || m.passed || m.streaming) return false;
  const view = messageView(m);
  return !!(view.text.trim() || view.changes.length);
}

function batchOf(messages, limit) {
  const batch = [];
  let size = 0;
  for (const m of messages) {
    if (!kinds.includes(m.kind) || m.passed || m.streaming) continue;
    const view = messageView(m);
    if (!view.text.trim() && !view.changes.length) continue;
    const chars = view.text.length + view.changes.join(' ').length;
    if (batch.length && (batch.length >= (limit.messages ?? 40) || size + chars > (limit.chars ?? 30000))) return { batch, more: true };
    size += chars;
    batch.push(view);
  }
  return { batch, more: false };
}

function freezeTasks(tasks) {
  return (tasks || []).map((t) => ({
    id: t.id, title: t.title, status: t.status, approvedAt: t.approvedAt,
    changes: (t.changes || []).map((c) => typeof c === 'string' ? c : { ...c }),
    attempts: (t.attempts || []).map((a) => ({ ...a })),
    feedbacks: (t.feedbacks || []).map((f) => ({ ...f })),
  }));
}

function context(messages, tasks, { batchSeqs = null, handoffs = [] } = {}) {
  const knownFiles = new Set();
  for (const m of messages) {
    if (batchSeqs && !batchSeqs.has(m.seq)) continue;
    for (const p of paths(m.changes)) knownFiles.add(p);
    for (const a of m.activities || []) {
      const match = String(a?.label || '').match(/[\w.\-\u4e00-\u9fff/\\]+\.[A-Za-z0-9]{1,10}/g);
      if (match) for (const f of match) knownFiles.add(normPath(f));
    }
  }
  for (const t of tasks) for (const p of paths(t.changes)) knownFiles.add(p);
  return {
    messages: new Map(messages.map((m) => [m.seq, {
      seq: m.seq, kind: m.kind, ts: m.ts, originalTs: m.lastTs,
      changes: !!m.changes?.length, activities: !!m.activities?.length,
      inBatch: batchSeqs ? batchSeqs.has(m.seq) : true,
    }])),
    tasks: new Map(tasks.map((t) => [t.id, t])),
    handoffSeqs: new Set(handoffs.map((h) => h.anchorSeq).filter(Boolean)),
    handoffs: new Map(handoffs.filter((h) => h.anchorSeq).map((h) => [h.anchorSeq, h])),
    knownFiles,
  };
}

function resultOp(task) {
  if (task.status !== 'approved') return null;
  const attempts = task.attempts || [];
  const i = attempts.findLastIndex((a) => !a.error && !['failed', 'question', 'cancelled', 'stopped'].includes(a.outcome));
  if (i < 0) return null;
  const files = paths(task.changes).slice(0, 10);
  const report = firstLine(attempts[i].report || attempts[i].text);
  const text = tr('{0} {1}：{2}', [task.id, task.title, report]) + (files.length ? tr('，改了 {0}', [files.join(tr('、'))]) : '');
  return { type: 'result', task: task.id, text, source: { tasks: [task.id + '/' + (i + 1)], files }, topics: [], files };
}

function taskSummary(tasks, from, to, maxChars = 8000) {
  const parts = [];
  let total = 0;
  for (const t of tasks) {
    const attempts = t.attempts || [], feedbacks = t.feedbacks || [];
    const times = [t.approvedAt, ...attempts.flatMap((a) => [a.startedAt, a.endedAt]), ...feedbacks.map((f) => f.ts)];
    if (['approved', 'skipped', 'cancelled'].includes(t.status) && !times.some((ts) => ts >= from && ts <= to)) continue;
    const block = [tr('{0} {1}（{2}）', [t.id, t.title, t.status])];
    attempts.forEach((a, i) => {
      const who = [a.engine, a.model].filter(Boolean).join('/');
      const body = clipBlock(a.report || a.error || a.text, 450);
      block.push(who
        ? tr('执行 {0}（{1}）：{2} {3}', [i + 1, who, a.outcome || '', body])
        : tr('执行 {0}：{1} {2}', [i + 1, a.outcome || '', body]));
    });
    for (const f of feedbacks) block.push(tr('打回意见：{0}', [clipBlock(f.text, 450)]));
    const text = block.join('\n');
    if (parts.length && total + text.length > maxChars) break;
    parts.push(text);
    total += text.length + 1;
  }
  return parts.join('\n');
}

function time(ts) {
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function messageBlock(m) {
  const name = m.name.replace(/[&<>"\r\n]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || ' '));
  const imported = m.kind === 'import' ? tr(' 原对话时间="{0}"', [time(m.originalTs)]) : '';
  const body = [m.text];
  if (m.changes.length) body.push(tr('改动文件：{0}', [m.changes.join(tr('、'))]));
  if (m.activities) body.push(tr('有工具操作记录'));
  return tr('<消息 {0} 来自="{1}" 类型="{2}" 时间="{3}"{4}>\n{5}\n</消息>',
    [m.seq, name, m.kind, time(m.ts), imported, escapeRecord(body.join('\n'))]);
}

export function organizeSystem(writer, includeRecap = false) {
  const base = tr('memory.organizer', [tr('你是这个空间记忆库的整理者'), writer.name]);
  return includeRecap ? base + '\n' + tr('在同一 JSON 对象中另加 recap 字段，总结本次移出的消息。') : base;
}

export function organizePrompt({ existing, tasks, messages, recap, recapMessages = [], handoffs = [] }) {
  const parts = [tr('memory.organizePrompt', [escapeRecord(existing), escapeRecord(tasks), messages.map(messageBlock).join('\n\n')])];
  if (handoffs.length) {
    parts.push(tr('## 交接说明'), tr('将交接中试过但走不通的做法记为 rejected，引用该说明的消息编号并写明原因。'));
    for (const h of handoffs) {
      const name = String(h.memberName).replace(/[&<>"]/g, ' ');
      parts.push(tr('<交接说明 来自="{0}" 截至消息="{1}">\n{2}\n</交接说明>', [name, h.anchorSeq, escapeTags(h.summary).replace(/[<>]/g, (c) => c === '<' ? '＜' : '＞')]));
    }
  }
  if (recapMessages.length) {
    parts.push(tr('已有前情提要：{0}', [escapeRecord(recap.text)]), tr('## 移出聊天记录的消息'),
      ...recapMessages.map((m) => tr('消息 {0}', [m.seq]) + ' · ' + escapeRecord(attachmentText(m)).slice(0, 1500)),
      tr('返回 {"ops":[...],"recap":"..."}。recap 只概括本批移出的消息，引用消息编号，勿复述已有提要。'));
  }
  return parts.join('\n\n');
}

export function mockRecap(prompt) {
  const section = prompt.split(tr('## 移出聊天记录的消息') + '\n\n')[1];
  if (!section) return undefined;
  return [...section.matchAll(/^((?:消息|Message) \d+ · .*)/gim)].map((m) => m[1].slice(0, 100)).join('\n');
}

export function existingMemory(memory, { maxTokens = 12000, query = '' } = {}) {
  const sections = [];
  let used = 0;
  const addSection = (text) => {
    if (!text) return false;
    const cost = estimateTokens(text);
    if (used + cost > maxTokens) return false;
    sections.push(text);
    used += cost;
    return true;
  };
  let l1 = memory.render({ layer: 1 });
  if (l1 && estimateTokens(l1) > maxTokens) {
    l1 = memory.render({ layer: 1, budget: Math.max(200, maxTokens * 2), query });
  }
  if (l1) { sections.push(l1); used += estimateTokens(l1); }

  const active = memory.active();
  const openIds = active.filter((e) => ['disagreement', 'question', 'proposal'].includes(e.type)).map((e) => e.id);
  const factCandidates = active.filter((e) => e.type === 'fact');
  let orderedFactIds;
  if (query && factCandidates.length) {
    const scored = new Map(memory.search(query, { limit: factCandidates.length }).map((r) => [r.entry.id, r.score]));
    orderedFactIds = [...factCandidates].sort((a, b) => (scored.get(b.id) || 0) - (scored.get(a.id) || 0) || b.id - a.id).map((e) => e.id);
  } else {
    orderedFactIds = [...factCandidates].sort((a, b) => b.id - a.id).map((e) => e.id);
  }
  const dir = memory.render({ layer: 2 });
  const dirTokens = dir ? estimateTokens(dir) : 0;
  const reserveDir = dir && used + dirTokens <= maxTokens ? dirTokens : 0;
  const lines = [];
  for (const id of [...openIds, ...orderedFactIds]) {
    const line = memory.render({ layer: 3, ids: [id] }).split('\n').find((l) => /^#\d+ \[/.test(l));
    if (!line) continue;
    const cost = estimateTokens(line) + 1;
    if (used + reserveDir + cost > maxTokens) break;
    lines.push(line);
    used += cost;
  }
  if (dir && used + dirTokens <= maxTokens) sections.push(dir);
  sections.push(...lines);
  return sections.filter(Boolean).join('\n');
}

export function recordApprovedResults(memory, tasks, ctx = context([], freezeTasks(tasks)), record = { added: [], rejected: [], notes: [] }) {
  const recorded = new Set(memory.entries().filter((e) => e.type === 'result')
    .flatMap((e) => (e.source.tasks || []).filter((ref) => ref.startsWith(e.task + '/'))));
  const accepted = [];
  const working = memory.entries().slice();
  let nextId = memory.latestId;
  for (const task of tasks) {
    const op = resultOp(task);
    if (!op || recorded.has(op.source.tasks[0])) continue;
    const r = check(op, working, ctx);
    if (!r.ok) { record.rejected.push({ op, reason: r.reason }); continue; }
    const saved = { ...r.entry, id: ++nextId, status: 'active' };
    for (const id of saved.supersedes || []) {
      const old = working.find((e) => e.id === id);
      if (old) { old.status = 'superseded'; old.by = saved.id; }
    }
    working.push(saved);
    accepted.push(r.entry);
    if (r.note) record.notes.push(r.note);
  }
  if (accepted.length) {
    const saved = memory.append(accepted);
    for (const s of saved) record.added.push(s.id);
  }
  return record;
}

export async function organize(host, memory, { writer, since = memory.lastSeq, signal, limit = {}, recap, handoffs = [] }) {
  const started = Date.now();
  const { batch, more } = batchOf(host.messages(since), limit);
  const frozenTasks = freezeTasks(host.tasks());
  const allMessages = host.messages(0);
  const batchSeqs = new Set(batch.map((m) => m.seq));
  const ctx = context(allMessages, frozenTasks, { batchSeqs, handoffs });
  const rolled = recap && recap.targetSeq > recap.uptoSeq
    ? allMessages.filter((m) => visible(m) && !m.streaming && m.seq > recap.uptoSeq && m.seq <= recap.targetSeq) : [];
  const recapMessages = rolled.slice(0, limit.messages || 40);
  const record = { at: started, writerId: writer.id, fromSeq: since, toSeq: batch.at(-1)?.seq ?? since,
    added: [], rejected: [], notes: [] };
  if (more) record.more = true;
  memory.archive(batch);
  // 任务验收独立于整理成员；即使这次调用失败，结果也已经落盘。
  recordApprovedResults(memory, frozenTasks, ctx, record);
  if (!batch.length && !recapMessages.length && !handoffs.length) {
    record.skipped = true;
    record.durationMs = Date.now() - started;
  } else {
    const from = allMessages.findLast((m) => m.seq <= since)?.ts ?? 0;
    const contextOpts = host.contextOptions?.(writer) || {};
    const windowTokens = contextWindowFor(writer, contextOpts);
    const maxExistingTokens = Math.min(12000, Math.max(1000, Math.floor(windowTokens * 0.25)));
    const batchQuery = [...batch.map((m) => [m.text, ...m.changes].join(' ')), ...handoffs.map((h) => h.summary)].join('\n').slice(0, 4000);
    const prompt = organizePrompt({
      existing: existingMemory(memory, { maxTokens: maxExistingTokens, query: batchQuery }),
      tasks: taskSummary(frozenTasks, from, more ? batch.at(-1).ts : record.at),
      messages: batch, recap, recapMessages, handoffs,
    });
    const sink = { text: '', activities: [] };
    try {
      const { access } = resolveTurnAccess({ spaceKind: host.kind, spaceAccess: host.access, role: 'organizer' });
      const cleanWriter = { ...writer, skills: [], mcp: [] };
      const reply = await runAgentTurn(host.registry, cleanWriter, {
        system: organizeSystem(writer, recapMessages.length > 0), prompt, cwd: host.workspacePath, access,
        noTools: true, readOnlyDirs: [], signal, sink,
      });
      if (signal?.aborted) throw Object.assign(new Error(tr('整理已取消')), { aborted: true });
      record.durationMs = Date.now() - started;
      record.toolCalls = sink.activities.length;
      if (sink.usage) record.usage = sink.usage;
      const result = normalizeOrganizerResult(reply.text ?? sink.text);
      if (!result) record.error = tr('整理结果不是有效的 JSON');
      else {
        // 批内使用同一内存快照顺序校验并一次性同步追加，整批只重写一次 memory.md。
        const working = memory.entries().slice();
        let nextId = memory.latestId;
        const accepted = [];
        for (const op of result.ops) {
          if (op?.type === 'result') {
            record.rejected.push({ op, reason: tr('任务结果由程序按验收记录写入') });
            continue;
          }
          const r = check(op, working, ctx);
          if (!r.ok) { record.rejected.push({ op, reason: r.reason }); continue; }
          const projected = { ...r.entry, id: ++nextId, status: r.entry.supersededBy ? 'superseded' : 'active', ...(r.entry.supersededBy ? { by: r.entry.supersededBy } : {}) };
          for (const id of projected.supersedes || []) {
            const old = working.find((e) => e.id === id);
            if (old) { old.status = 'superseded'; old.by = projected.id; }
          }
          for (const id of projected.resolves || []) {
            const old = working.find((e) => e.id === id);
            if (old) { old.status = 'resolved'; old.by = projected.id; }
          }
          working.push(projected);
          accepted.push(r.entry);
          if (r.note) record.notes.push(r.note);
        }
        if (signal?.aborted) throw Object.assign(new Error(tr('整理已取消')), { aborted: true });
        if (accepted.length) {
          const saved = memory.append(accepted);
          for (const s of saved) record.added.push(s.id);
        }
        if (recapMessages.length && result.recap) {
          record.recapText = result.recap;
          record.recapUptoSeq = recapMessages.at(-1).seq;
          if (rolled.length > recapMessages.length) record.more = true;
        }
        memory.setLastSeq(record.toSeq);
      }
    } catch (e) {
      record.durationMs = Date.now() - started;
      record.toolCalls = sink.activities.length;
      record.error = e.message;
      memory.log(record);
      e.organizeRecord = record;
      throw e;
    }
  }
  memory.log(record);
  return record;
}

// 演示整理也读取与真实成员相同的消息框，只根据用户原话改决定。
export function mockOps(prompt) {
  const ops = [];
  const tag = /^<(?:消息|message) (\d+) (?:来自|from)="[^"]*" (?:类型|type)="(\w+)" [^>]*>\n([\s\S]*?)\n<\/(?:消息|message)>/gm;
  const existing = prompt.split(/^<(?:消息|message) \d+ /m, 1)[0];
  const replaced = new Set([...existing.matchAll(/^#\d+ (?:取代|replaces) #(\d+)/gm)].map((m) => Number(m[1])));
  const previous = [...existing.matchAll(/^#(\d+) \[(?:决定|Decision)·/gm)].map((m) => Number(m[1])).filter((id) => !replaced.has(id)).at(-1);
  for (const [, seq, kind, body] of prompt.matchAll(tag)) {
    const text = body.trim().split(/[。\n]/, 1)[0].slice(0, 60);
    const reason = body.match(/因为([^。\n]+)/)?.[1]?.trim() || tr('你定的');
    const topic = tokenize(text)[0];
    const op = { text, source: { messages: [Number(seq)] }, topics: topic ? [topic] : [] };
    if (kind === 'ai' && /建议|提议/.test(body)) op.type = 'proposal';
    else if (kind !== 'user') continue;
    else if (/改成/.test(body) && previous) {
      Object.assign(op, { op: 'supersede', target: previous, type: 'decision', origin: 'user', reason, answers: reason });
      const catalog = [...existing.matchAll(/^- (.+?)[：:]\s*(#\d+.*)$/gm)];
      const old = catalog.find(([, , ids]) => ids.match(/\d+/g)?.includes(String(previous)));
      if (old) op.topics = [old[1]];
    } else if (/不要|不用|否决/.test(body)) Object.assign(op, { type: 'rejected', reason });
    else if (/偏好|以后都/.test(body)) op.type = 'preference';
    else if (/定了|决定|就用/.test(body)) Object.assign(op, { type: 'decision', origin: 'user', reason });
    else continue;
    ops.push(op);
  }
  const notes = /^<(?:交接说明 来自|handoff from)="[^"]*" (?:截至消息|upto)="(\d+)">\n([\s\S]*?)\n<\/(?:交接说明|handoff)>/gm;
  for (const [, seq, body] of prompt.matchAll(notes)) {
    const failed = body.split(/[\n。]/).find((s) => /走不通|失败|不行|failed|didn.t work|unworkable/i.test(s));
    if (failed && Number(seq)) ops.push({ type: 'rejected', text: failed, reason: failed, source: { messages: [Number(seq)] } });
  }
  return ops;
}

export function clarificationDecision(q, answers) {
  const question = q.text.trim().replace(/[?？:：\s]+$/, '');
  if (Object.hasOwn(answers, q.id)) return tr('{0}：{1}', [question, answers[q.id]]);
  return q.default ? tr('{0}：按默认处理（{1}）', [question, q.default]) : tr('{0}：按默认处理', [question]);
}

export function recordPlanDecisions(memory, run) {
  const seen = new Set(memory.entries().filter((e) => e.type === 'decision' && e.source.tasks?.includes('plan')).map((e) => e.origin + '\n' + e.text));
  const batch = [];
  function add(origin, text, reason, at, confirmed = false) {
    text = text.trim().slice(0, 300);
    const key = origin + '\n' + text;
    if (!text || seen.has(key)) return;
    seen.add(key);
    batch.push({ type: 'decision', origin, ...(confirmed ? { confirmedBy: 'user' } : {}), text, reason, at, source: { tasks: ['plan'] } });
  }
  const c = run.clarify;
  if (c?.resolvedAt != null) for (const q of c.questions) {
    const user = Object.hasOwn(c.answers, q.id);
    add(user ? 'user' : 'default', clarificationDecision(q, c.answers), user ? tr('规划前澄清中你的回答') : tr('规划前澄清按默认通过'), c.resolvedAt, user);
  }
  for (const assumption of run.assumptions || []) add('default', assumption, tr('规划时的默认假设'), Date.now(), false);
  if (batch.length) memory.append(batch);
}

export { normalizeOrganizerResult };
