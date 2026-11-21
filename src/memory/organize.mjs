import { t as tr } from '../i18n.mjs';
import { escapeTags } from '../prompts.mjs';
import { runAgentTurn } from '../turn-runner.mjs';
import { check, normalizeOps } from './rules.mjs';
import { tokenize } from './tokens.mjs';

const kinds = ['user', 'ai', 'summary', 'task', 'import'];
const firstLine = (text) => (text || '').trim().split(/\r?\n/, 1)[0].slice(0, 120);
const paths = (changes) => [...new Set((changes || []).map((c) => typeof c === 'string' ? c : c.path).filter(Boolean))];

function messageView(m) {
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

function context(messages, tasks) {
  return {
    messages: new Map(messages.map((m) => [m.seq, { seq: m.seq, kind: m.kind, ts: m.ts, originalTs: m.lastTs,
      changes: !!m.changes?.length, activities: !!m.activities?.length }])),
    tasks: new Map(tasks.map((t) => [t.id, t])),
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

function taskSummary(tasks, from, to) {
  const parts = [];
  for (const t of tasks) {
    const attempts = t.attempts || [], feedbacks = t.feedbacks || [];
    const times = [t.approvedAt, ...attempts.flatMap((a) => [a.startedAt, a.endedAt]), ...feedbacks.map((f) => f.ts)];
    if (['approved', 'skipped', 'cancelled'].includes(t.status) && !times.some((ts) => ts >= from && ts <= to)) continue;
    parts.push(tr('{0} {1}（{2}）', [t.id, t.title, t.status]));
    attempts.forEach((a, i) => parts.push(tr('执行 {0}：{1} {2}', [i + 1, a.outcome || '', firstLine(a.report || a.error || a.text)])));
    for (const f of feedbacks) parts.push(tr('打回意见：{0}', [firstLine(f.text)]));
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
    [m.seq, name, m.kind, time(m.ts), imported, escapeTags(body.join('\n'))]);
}

export function organizeSystem(writer) {
  return tr('memory.organizer', [tr('你是这个空间记忆库的整理者'), writer.name]);
}

export function organizePrompt({ existing, tasks, messages }) {
  return tr('memory.organizePrompt', [escapeTags(existing), escapeTags(tasks), messages.map(messageBlock).join('\n\n')]);
}

function existingMemory(memory) {
  const ids = memory.active().filter((e) => ['question', 'proposal', 'disagreement', 'fact'].includes(e.type)).map((e) => e.id);
  const lines = memory.render({ layer: 3, ids }).split('\n').filter((line) => /^#\d+ \[/.test(line));
  return [memory.render({ layer: 1 }), memory.render({ layer: 2 }), ...lines].filter(Boolean).join('\n');
}

export async function organize(host, memory, { writer, since = memory.lastSeq, signal, limit = {} }) {
  const { batch, more } = batchOf(host.messages(since), limit);
  const tasks = host.tasks();
  const allMessages = host.messages(0);
  const ctx = context(allMessages, tasks);
  const record = { at: Date.now(), writerId: writer.id, fromSeq: since, toSeq: batch.at(-1)?.seq ?? since,
    added: [], rejected: [], notes: [] };
  if (more) record.more = true;
  function apply(op) {
    const r = check(op, memory.entries(), ctx);
    if (!r.ok) { record.rejected.push({ op, reason: r.reason }); return; }
    const [saved] = memory.append([r.entry]);
    record.added.push(saved.id);
    if (r.note) record.notes.push(r.note);
  }
  memory.archive(batch);
  // 任务验收独立于整理成员；即使这次调用失败，结果也已经落盘。
  const recorded = new Set(memory.entries().filter((e) => e.type === 'result')
    .flatMap((e) => (e.source.tasks || []).filter((ref) => ref.startsWith(e.task + '/'))));
  for (const task of tasks) {
    const op = resultOp(task);
    if (op && !recorded.has(op.source.tasks[0])) apply(op);
  }
  if (!batch.length) record.skipped = true;
  else {
    const from = allMessages.findLast((m) => m.seq <= since)?.ts ?? 0;
    const prompt = organizePrompt({ existing: existingMemory(memory), tasks: taskSummary(tasks, from, more ? batch.at(-1).ts : record.at), messages: batch });
    const sink = { text: '', activities: [] };
    try {
      const reply = await runAgentTurn(host.registry, writer, {
        system: organizeSystem(writer), prompt, cwd: host.workspacePath, access: 'read', signal, sink,
      });
      if (sink.usage) record.usage = sink.usage;
      const ops = normalizeOps(reply.text ?? sink.text);
      if (!ops) record.error = tr('整理结果不是有效的 JSON');
      else {
        for (const op of ops) {
          if (op?.type === 'result') record.rejected.push({ op, reason: tr('任务结果由程序按验收记录写入') });
          else apply(op);
        }
        memory.setLastSeq(record.toSeq);
      }
    } catch (e) {
      record.error = e.message;
      memory.log(record);
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
  return ops;
}
