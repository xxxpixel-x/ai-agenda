// 任务协作模式的提示词（参考 orca 的 worker dispatch preamble：任务自包含、只做自己的事、
// 三句话报告、明确成功/失败、需要人决定时停下来问）。
import { t as tr } from './i18n.mjs';
import { fileBlockRules, filesForPrompt } from './engines/file-blocks.mjs';
import { canRun, newKey, said, keyRule, escapeTags, attachmentText } from './prompts.mjs';

const RESULT_RE = /(?:结果|Result)\s*[:：]\s*(完成|失败|需要确认|Done|Failed|Needs input)\s*[:：,，]?\s*(.*)$/i;

function roster(space) {
  return space.members.map((m) => `- @${m.name}（${m.engineLabel}${m.persona ? tr('；设定：{0}', [m.persona.replace(/\s+/g, ' ').slice(0, 80)]) : ''}）`).join('\n');
}

const modeLine = (run) => (run.mode === 'git'
  ? tr('这是一个 git 项目：每个子任务在独立的副本（git worktree）里进行，互不影响，可以同时进行；用户审查通过后才合并。会改同一批文件的子任务要么合成一个，要么设依赖。')
  : tr('这不是 git 项目：子任务会按依赖顺序一个接一个执行，直接修改共享文件夹。'));

const accessLine = (space) => (canRun(space.access)
  ? tr('成员可以在工作目录里运行命令（例如跑测试），spec 里可以要求用命令验证。')
  : tr('成员只能读写文件、不能运行命令，所以 spec 里不要要求“运行/测试来验证”，改成“检查代码/内容是否正确”。'));

export function plannerSystem(space, run, me) {
  return tr('tasks.planner', [me.name, roster(space), modeLine(run), accessLine(space), tr('tasks.planFormat')]);
}

/** 总目标是用户写的，带上发言人标记（见 prompts.mjs）。 */
const objective = (run, key) => tr('# 总目标\n{0}', [said(key, '', run.objective, true)]);

export function plannerPrompt(run, { feedback = [], previous = null, key = newKey() } = {}) {
  const parts = [keyRule(key), objective(run, key)];
  if (previous) parts.push(tr('# 你之前给出的计划\n```json\n{0}\n```', [JSON.stringify({ tasks: previous }, null, 1)]));
  if (feedback.length) parts.push(tr('# 意见\n{0}', [feedback.map((f) => said(key, f.name, f.text)).join('\n\n')]));
  parts.push(previous ? tr('根据意见修改计划，重新给出完整计划。') : tr('请给出计划。'));
  return parts.join('\n\n');
}

export function reviewerSystem(space, run, me, coordinator) {
  return tr('tasks.reviewer', [me.name, coordinator.name, roster(space), modeLine(run)]);
}

export function reviewerPrompt(run, tasks, { key = newKey() } = {}) {
  return tr('{0}\n\n{1}\n\n# 计划\n{2}\n\n请提意见，没有意见只回复 [同意]。', [keyRule(key), objective(run, key), planText(tasks, null)]);
}

function planText(tasks, members, mine) {
  return tasks.map((t) => {
    const who = members ? (members.find((m) => m.id === t.assigneeId)?.name || '?') : (t.assignee || '?');
    const st = t.status && t.status !== 'pending' && t.status !== 'ready' ? `［${STATUS_TEXT[t.status] || t.status}］` : '';
    return tr('- {0} {1}（负责：{2}）{3}{4}{5}{6}', [
      t.id, t.title, who,
      t.deps?.length ? tr(' 依赖 {0}', [t.deps.join('、')]) : '',
      st, t.id === mine ? tr('  ← 你') : '',
      members ? '' : `\n  ${String(t.spec || '').replace(/\n/g, '\n  ')}`,
    ]);
  }).join('\n');
}

export const STATUS_TEXT = {
  get pending() { return tr('等待前置任务'); },
  get ready() { return tr('排队中'); },
  get running() { return tr('进行中'); },
  get review() { return tr('待审查'); },
  get approved() { return tr('已通过'); },
  get failed() { return tr('失败'); },
  get blocked() { return tr('等你回答'); },
  get skipped() { return tr('已跳过'); },
  get cancelled() { return tr('已取消'); },
};

export function workerSystem(space, run, task, me, { api = false, cwd } = {}) {
  const directory = run.mode === 'git'
    ? tr('{0}这是专门给你这个子任务建的独立副本（git worktree），别人看不到你的改动；用户审查通过后才会合并。\n- 不要执行 git commit / push / checkout / 切换分支，软件会替你提交。', [api ? '' : `${cwd}\n`])
    : tr('{0}这是大家共用的文件夹，你的改动会直接生效（用户可以撤销）。', [api ? '' : `${cwd}\n`]);
  return tr('tasks.worker', [
    me.name, task.id, directory,
    canRun(space.access) ? tr('- 你可以在工作目录里运行命令（例如跑测试）来验证结果。') : tr('- 不要运行命令，只读写文件。'),
    me.persona ? tr('\n## 你的额外设定\n{0}\n', [me.persona]) : '',
    api ? `\n${fileBlockRules()}\n` : '',
  ]);
}

export function workerPrompt(space, run, task, { files = null, conflict = null, key = newKey() } = {}) {
  const parts = [keyRule(key), objective(run, key), tr('# 整体计划\n{0}', [planText(run.tasks, space.members, task.id)])];
  if (files) parts.push(filesForPrompt(files));
  parts.push(tr('# 你的子任务 {0}：{1}\n{2}', [task.id, task.title, task.spec]));
  const deps = run.tasks.filter((t) => task.deps.includes(t.id));
  if (deps.length) {
    parts.push(tr('# 前置任务的结果\n{0}{1}', [deps.map((d) => {
      const who = space.members.find((m) => m.id === d.assigneeId)?.name || '?';
      const rep = d.attempts.at(-1)?.report || tr('（没有报告）');
      return `## ${d.id} ${d.title}（${who}）\n${rep}${d.changes?.length ? tr('\n改动的文件：{0}', [d.changes.map((c) => c.path).join('、')]) : ''}`;
    }).join('\n\n'), run.mode === 'git' ? tr('\n（这些结果已经合并进你的副本。）') : '']));
  }
  const prev = task.attempts.filter((a) => a.report || a.error);
  if (prev.length) parts.push(tr('# 你上一次的结果\n{0}\n（你上次的改动还在工作目录里，在此基础上继续。）', [prev.at(-1).report || prev.at(-1).error]));
  if (task.notes?.length) parts.push(tr('# 用户中途补充的要求（协调者转给你的，请一并照做）\n{0}', [task.notes.map((n) => said(key, '', n.text, true)).join('\n')]));
  if (task.feedbacks?.length) parts.push(tr('# 用户的意见（请按意见修改）\n{0}', [task.feedbacks.map((f) => said(key, '', f.text, true)).join('\n')]));
  if (task.question && task.answer) parts.push(tr('# 你之前的问题\n{0}\n# 用户的回答\n{1}', [task.question, said(key, '', task.answer, true)]));
  if (conflict) parts.push(tr('# 合并冲突\n你的改动和已经通过的其他子任务冲突了。下面这些文件里有 <<<<<<< ======= >>>>>>> 冲突标记，请解决冲突（保留双方都需要的内容），删除所有冲突标记：\n{0}', [conflict.map((f) => `- ${f}`).join('\n')]));
  parts.push(tr('现在开始做。做完按规则报告。'));
  return parts.join('\n\n');
}

/** 解析报告最后的“结果：…”。 */
export function parseReport(text) {
  const lines = String(text || '').trim().split('\n');
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
    const m = lines[i].replace(/[*`]/g, '').trim().match(RESULT_RE);
    if (m) {
      const report = [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n').trim();
      const outcome = /^(完成|Done)$/i.test(m[1]) ? 'done' : /^(失败|Failed)$/i.test(m[1]) ? 'failed' : 'question';
      return { outcome, detail: m[2].trim(), report };
    }
  }
  return { outcome: 'done', detail: '', report: String(text || '').trim(), noResultLine: true };
}

export function summarySystem(space, me) {
  return tr('tasks.summary', [me.name]);
}

export function summaryPrompt(space, run, { key = newKey() } = {}) {
  const tasks = run.tasks.map((t) => {
    const who = space.members.find((m) => m.id === t.assigneeId)?.name || '?';
    const a = t.attempts.at(-1);
    return tr('## {0} {1}（{2}，{3}，做了 {4} 次）\n{5}{6}{7}', [
      t.id, t.title, who, STATUS_TEXT[t.status], t.attempts.length,
      a?.report || a?.error || tr('（没有报告）'),
      t.changes?.length ? tr('\n改动：{0}', [t.changes.map((c) => c.path).join('、')]) : '',
      t.feedbacks?.length ? tr('\n用户意见：\n{0}', [t.feedbacks.map((f) => said(key, '', f.text, true)).join('\n')]) : '',
    ]);
  }).join('\n\n');
  return tr('{0}\n\n{1}\n\n# 子任务\n{2}\n\n请写总结。', [keyRule(key), objective(run, key), tasks]);
}

export function commitSystem(space, me) {
  return tr('tasks.commit', [me.name]);
}

export function commitPrompt(run, { commits, files, summary, key = newKey() }) {
  return tr('tasks.commitPrompt', [
    keyRule(key), objective(run, key), escapeTags(summary),
    escapeTags(files.map((f) => f.path).join('\n')), escapeTags(commits.join('\n\n---\n\n')),
  ]);
}

/** 从协调者回复里取出计划 JSON。 */
export function extractPlan(text) {
  const s = String(text || '');
  const blocks = [...s.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const candidates = blocks.length ? blocks.reverse() : [];
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) candidates.push(s.slice(a, b + 1));
  for (const c of candidates) {
    try {
      const j = JSON.parse(c);
      const tasks = Array.isArray(j) ? j : j.tasks;
      if (Array.isArray(tasks) && tasks.length) return tasks;
    } catch { /* 下一个 */ }
  }
  return null;
}

/** 规范化计划：id 唯一、负责人映射到成员、依赖有效且无环。 */
export function normalizePlan(rawTasks, members, fallbackId, { max = 12 } = {}) {
  const byName = new Map(members.map((m) => [m.name, m.id]));
  const ids = new Set();
  const tasks = rawTasks.slice(0, max).map((t, i) => {
    let id = String(t.id || `T${i + 1}`).replace(/[^A-Za-z0-9-]/g, '').slice(0, 12) || `T${i + 1}`;
    while (ids.has(id)) id = `${id}x`;
    ids.add(id);
    const who = String(t.assignee || t.assigneeName || '').replace(/^@/, '').trim();
    const assigneeId = t.assigneeId && members.some((m) => m.id === t.assigneeId) ? t.assigneeId
      : byName.get(who) || members.find((m) => who && (m.engineLabel === who || who.includes(m.name)))?.id || fallbackId;
    return {
      id,
      title: String(t.title || tr('子任务 {0}', [i + 1])).trim().slice(0, 80),
      spec: String(t.spec || t.description || t.title || '').trim().slice(0, 6000),
      assigneeId,
      deps: Array.isArray(t.deps) ? t.deps.map(String) : [],
    };
  });
  const known = new Set(tasks.map((t) => t.id));
  for (const t of tasks) t.deps = [...new Set(t.deps.filter((d) => known.has(d) && d !== t.id))];
  // 去环：按顺序检查，形成环的依赖直接去掉
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const reaches = (from, target, seen = new Set()) => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (byId.get(from)?.deps || []).some((d) => reaches(d, target, seen));
  };
  for (const t of tasks) t.deps = t.deps.filter((d) => !reaches(d, t.id));
  return tasks;
}

// ---------- 任务空间：你中途发来的消息先交给协调者 ----------
// 协调者看当前计划、各子任务状态和进展，判断是补充说明、要改计划、只是问问，还是和总目标无关。

/** 各子任务现在做到哪了（给协调者判断用）。 */
function progressText(space, run) {
  return run.tasks.map((t) => {
    const who = space.members.find((m) => m.id === t.assigneeId)?.name || '?';
    const a = t.attempts.at(-1);
    const lines = [tr('## {0} {1}（负责：{2}，{3}{4}）', [t.id, t.title, who, STATUS_TEXT[t.status] || t.status, t.deps?.length ? tr('，依赖 {0}', [t.deps.join('、')]) : ''])];
    lines.push(t.spec);
    if (t.notes?.length) lines.push(tr('已有的补充说明：\n{0}', [t.notes.map((n) => `- ${n.text}`).join('\n')]));
    if (t.status === 'running' && a) {
      const acts = (a.activities || []).slice(-8).map((x) => `- ${x.label}`).join('\n');
      lines.push(tr('正在做，已经做了：\n{0}', [acts || tr('（还没有动作）')]));
    } else if (a?.report || a?.error) {
      lines.push(tr('最近一次的结果：{0}', [(a.report || a.error).slice(0, 1200)]));
    }
    if (t.changes?.length) lines.push(tr('改动的文件：{0}', [t.changes.map((c) => c.path).join('、')]));
    return lines.join('\n');
  }).join('\n\n');
}

export function triageSystem(space, run, me) {
  return tr('tasks.triage', [me.name, roster(space), modeLine(run), accessLine(space)]);
}

/** history：这个任务空间里你和协调者最近的几轮对话（不含这一条）。 */
export function triagePrompt(space, run, text, { history = [], key = newKey() } = {}) {
  const parts = [keyRule(key), objective(run, key)];
  parts.push(tr('# 现在的阶段\n{0}', [run.status === 'done' ? tr('所有子任务都结束了，你已经写过总结；用户还没有结束这个任务。') : run.status === 'plan_review' ? tr('计划还在等用户确认，还没开始执行。') : tr('正在执行。')]));
  parts.push(tr('# 计划和进展\n{0}', [progressText(space, run) || tr('（还没有子任务）')]));
  if (history.length) parts.push(tr('# 之前的对话\n{0}', [history.map((m) => said(key, m.name, attachmentText(m, space.workspacePath), m.kind === 'user')).join('\n\n')]));
  parts.push(tr('# 用户刚发来的消息\n{0}', [said(key, '', text, true)]));
  parts.push(tr('请判断并按格式回复。'));
  return parts.join('\n\n');
}

/** 取出协调者的判断：```json 块里的 { type, notes, stop, tasks }，其余文字是给用户的回复。 */
export function parseTriage(text) {
  const s = String(text || '');
  const blocks = [...s.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)];
  let j = null;
  for (const m of [...blocks].reverse()) {
    try { j = JSON.parse(m[1]); break; } catch { /* 下一个 */ }
  }
  const reply = s.replace(/```(?:json)?\s*\n[\s\S]*?\n```/g, '').trim();
  if (!j || typeof j !== 'object') return { type: 'answer', reply: reply || s.trim(), notes: [], stop: [], tasks: null };
  const type = ['note', 'change', 'unrelated', 'answer'].includes(j.type) ? j.type : 'answer';
  const notes = (Array.isArray(j.notes) ? j.notes : []).map((n) => ({ task: String(n.task || n.id || ''), text: String(n.text || '').trim().slice(0, 2000) })).filter((n) => n.task && n.text);
  const stop = (Array.isArray(j.stop) ? j.stop : []).map((x) => (typeof x === 'string' ? { task: x, keep: true } : { task: String(x.task || x.id || ''), keep: x.keep !== false })).filter((x) => x.task);
  const tasks = type === 'change' && Array.isArray(j.tasks) && j.tasks.length ? j.tasks : null;
  return { type: type === 'change' && !tasks ? 'answer' : type, reply: reply || String(j.reply || '').trim(), notes, stop, tasks, why: String(j.why || '').trim().slice(0, 600) };
}

// ---------- 聊天空间 → 任务空间：让一个成员把选中的讨论提炼成方案 ----------
export function distillSystem(me) {
  return tr('tasks.distill', [me.name]);
}

export function distillPrompt(messages, { key = newKey() } = {}) {
  const lines = messages.map((m) => said(key, m.kind === 'user' ? '' : m.name, m.text, m.kind === 'user'));
  return tr('{0}\n\n# 选出的讨论\n{1}\n\n请提炼成任务目标。', [keyRule(key), lines.join('\n\n')]);
}
