// 任务协作模式的提示词（参考 orca 的 worker dispatch preamble：任务自包含、只做自己的事、
// 三句话报告、明确成功/失败、需要人决定时停下来问）。
import { FILE_BLOCK_RULES, filesForPrompt } from './engines/file-blocks.mjs';

const RESULT_RE = /结果\s*[:：]\s*(完成|失败|需要确认)\s*[:：,，]?\s*(.*)$/;

function roster(space) {
  return space.members.map((m) => `- @${m.name}（${m.engineLabel}${m.persona ? `；设定：${m.persona.replace(/\s+/g, ' ').slice(0, 80)}` : ''}）`).join('\n');
}

const modeLine = (run) => (run.mode === 'git'
  ? '这是一个 git 项目：每个子任务在独立的副本（git worktree）里进行，互不影响，可以同时进行；用户审查通过后才合并。会改同一批文件的子任务要么合成一个，要么设依赖。'
  : '这不是 git 项目：子任务会按依赖顺序一个接一个执行，直接修改共享文件夹。');

const accessLine = (space) => (space.access === 'run'
  ? '成员可以在工作目录里运行命令（例如跑测试），spec 里可以要求用命令验证。'
  : '成员只能读写文件、不能运行命令，所以 spec 里不要要求“运行/测试来验证”，改成“检查代码/内容是否正确”。');

const PLAN_FORMAT =`计划用下面的 JSON 格式给出（放在 \`\`\`json 代码块里，JSON 前可以用一两句话说明思路）：
\`\`\`json
{"tasks": [
  {"id": "T1", "title": "简短标题", "assignee": "成员名", "deps": [], "spec": "自包含的说明"},
  {"id": "T2", "title": "……", "assignee": "成员名", "deps": ["T1"], "spec": "……"}
]}
\`\`\`
要求：
- spec 必须自包含：做这件事的人看不到规划过程，只能看到总目标、整体计划、自己的 spec 和前置任务的结果。写清目标、要改什么、限制、可以动哪些文件、怎样算完成。
- 一般 2～6 个子任务；能同时做的不要设依赖（deps）；deps 只写真正需要先完成的任务 id。
- 按成员的特点分工，assignee 必须是成员名之一。`;

export function plannerSystem(space, run, me) {
  return `你是「${me.name}」，这次任务协作的协调者。你负责把用户的总目标拆成子任务，分给成员去做。

## 成员
${roster(space)}

## 工作方式
${modeLine(run)}
${accessLine(space)}
现在是规划阶段：你可以阅读文件来了解情况，但不要修改任何文件。

${PLAN_FORMAT}`;
}

export function plannerPrompt(run, { feedback = [], previous = null } = {}) {
  const parts = [`# 总目标\n${run.objective}`];
  if (previous) parts.push(`# 你之前给出的计划\n\`\`\`json\n${JSON.stringify({ tasks: previous }, null, 1)}\n\`\`\``);
  if (feedback.length) parts.push(`# 意见\n${feedback.map((f) => `【${f.name}】\n${f.text}`).join('\n\n')}`);
  parts.push(previous ? '根据意见修改计划，重新给出完整计划。' : '请给出计划。');
  return parts.join('\n\n');
}

export function reviewerSystem(space, run, me, coordinator) {
  return `你是「${me.name}」。协调者「${coordinator.name}」为一次任务协作拟了计划，请你审阅计划。

## 成员
${roster(space)}

## 工作方式
${modeLine(run)}
现在是规划阶段，不要修改任何文件。

从你的角度提意见：分工是否合理、依赖是否正确、有没有遗漏或多余的子任务、spec 是否说清楚了。一两段话即可。完全同意就只回复 [同意]。`;
}

export function reviewerPrompt(run, tasks) {
  return `# 总目标\n${run.objective}\n\n# 计划\n${planText(tasks, null)}\n\n请提意见，没有意见只回复 [同意]。`;
}

function planText(tasks, members, mine) {
  return tasks.map((t) => {
    const who = members ? (members.find((m) => m.id === t.assigneeId)?.name || '?') : (t.assignee || '?');
    const st = t.status && t.status !== 'pending' && t.status !== 'ready' ? `［${STATUS_TEXT[t.status] || t.status}］` : '';
    return `- ${t.id} ${t.title}（负责：${who}）${t.deps?.length ? ` 依赖 ${t.deps.join('、')}` : ''}${st}${t.id === mine ? '  ← 你' : ''}${members ? '' : `\n  ${String(t.spec || '').replace(/\n/g, '\n  ')}`}`;
  }).join('\n');
}

export const STATUS_TEXT = {
  pending: '等待前置任务', ready: '排队中', running: '进行中', review: '待审查', approved: '已通过',
  failed: '失败', blocked: '等你回答', skipped: '已跳过', cancelled: '已取消',
};

export function workerSystem(space, run, task, me, { api = false, cwd } = {}) {
  return `你是「${me.name}」，正在一次多 AI 任务协作里做被分派给你的子任务 ${task.id}。只做这一个子任务，不要做计划里别人的事。

## 工作目录
${run.mode === 'git'
    ? `${api ? '' : `${cwd}\n`}这是专门给你这个子任务建的独立副本（git worktree），别人看不到你的改动；用户审查通过后才会合并。
- 不要执行 git commit / push / checkout / 切换分支，软件会替你提交。`
    : `${api ? '' : `${cwd}\n`}这是大家共用的文件夹，你的改动会直接生效（用户可以撤销）。`}
${space.access === 'run' ? '- 你可以在工作目录里运行命令（例如跑测试）来验证结果。' : '- 不要运行命令，只读写文件。'}

## 规则
- 遇到必须由用户决定才能继续的问题，不要猜：停下来，在报告最后写“结果：需要确认：你的问题”。
- 做完后用三句话报告：做了什么、发现了什么、还剩什么。
- 报告最后一行必须是下面三种之一：
  结果：完成
  结果：失败：原因
  结果：需要确认：问题
- 没做成就如实写失败，不要粉饰。
- 使用用户的语言。
${me.persona ? `\n## 你的额外设定\n${me.persona}\n` : ''}${api ? `\n${FILE_BLOCK_RULES}\n` : ''}`;
}

export function workerPrompt(space, run, task, { files = null, conflict = null } = {}) {
  const parts = [`# 总目标\n${run.objective}`, `# 整体计划\n${planText(run.tasks, space.members, task.id)}`];
  if (files) parts.push(filesForPrompt(files));
  parts.push(`# 你的子任务 ${task.id}：${task.title}\n${task.spec}`);
  const deps = run.tasks.filter((t) => task.deps.includes(t.id));
  if (deps.length) {
    parts.push(`# 前置任务的结果\n${deps.map((d) => {
      const who = space.members.find((m) => m.id === d.assigneeId)?.name || '?';
      const rep = d.attempts.at(-1)?.report || '（没有报告）';
      return `## ${d.id} ${d.title}（${who}）\n${rep}${d.changes?.length ? `\n改动的文件：${d.changes.map((c) => c.path).join('、')}` : ''}`;
    }).join('\n\n')}${run.mode === 'git' ? '\n（这些结果已经合并进你的副本。）' : ''}`);
  }
  const prev = task.attempts.filter((a) => a.report || a.error);
  if (prev.length) parts.push(`# 你上一次的结果\n${prev.at(-1).report || prev.at(-1).error}\n（你上次的改动还在工作目录里，在此基础上继续。）`);
  if (task.feedbacks?.length) parts.push(`# 用户的意见（请按意见修改）\n${task.feedbacks.map((f) => `- ${f.text}`).join('\n')}`);
  if (task.question && task.answer) parts.push(`# 你之前的问题\n${task.question}\n# 用户的回答\n${task.answer}`);
  if (conflict) parts.push(`# 合并冲突\n你的改动和已经通过的其他子任务冲突了。下面这些文件里有 <<<<<<< ======= >>>>>>> 冲突标记，请解决冲突（保留双方都需要的内容），删除所有冲突标记：\n${conflict.map((f) => `- ${f}`).join('\n')}`);
  parts.push('现在开始做。做完按规则报告。');
  return parts.join('\n\n');
}

/** 解析报告最后的“结果：…”。 */
export function parseReport(text) {
  const lines = String(text || '').trim().split('\n');
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
    const m = lines[i].replace(/[*`]/g, '').trim().match(RESULT_RE);
    if (m) {
      const report = [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n').trim();
      const outcome = m[1] === '完成' ? 'done' : m[1] === '失败' ? 'failed' : 'question';
      return { outcome, detail: m[2].trim(), report };
    }
  }
  return { outcome: 'done', detail: '', report: String(text || '').trim(), noResultLine: true };
}

export function summarySystem(space, me) {
  return `你是「${me.name}」，一次多 AI 任务协作的协调者。所有子任务都结束了，请给用户写一份简洁的总结。不要修改任何文件。

按这个结构写（Markdown）：
### 完成了什么
### 每个子任务的结果
（每个一行：谁做的、结果、关键改动）
### 需要你注意的地方
（风险、没做完的、需要用户检查或决定的）

使用用户的语言。`;
}

export function summaryPrompt(space, run) {
  return `# 总目标\n${run.objective}\n\n# 子任务\n${run.tasks.map((t) => {
    const who = space.members.find((m) => m.id === t.assigneeId)?.name || '?';
    const a = t.attempts.at(-1);
    return `## ${t.id} ${t.title}（${who}，${STATUS_TEXT[t.status]}，做了 ${t.attempts.length} 次）\n${a?.report || a?.error || '（没有报告）'}${t.changes?.length ? `\n改动：${t.changes.map((c) => c.path).join('、')}` : ''}${t.feedbacks?.length ? `\n用户意见：${t.feedbacks.map((f) => f.text).join('；')}` : ''}`;
  }).join('\n\n')}\n\n请写总结。`;
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
export function normalizePlan(rawTasks, members, fallbackId) {
  const byName = new Map(members.map((m) => [m.name, m.id]));
  const ids = new Set();
  const tasks = rawTasks.slice(0, 12).map((t, i) => {
    let id = String(t.id || `T${i + 1}`).replace(/[^A-Za-z0-9-]/g, '').slice(0, 12) || `T${i + 1}`;
    while (ids.has(id)) id = `${id}x`;
    ids.add(id);
    const who = String(t.assignee || t.assigneeName || '').replace(/^@/, '').trim();
    const assigneeId = t.assigneeId && members.some((m) => m.id === t.assigneeId) ? t.assigneeId
      : byName.get(who) || members.find((m) => who && (m.engineLabel === who || who.includes(m.name)))?.id || fallbackId;
    return {
      id,
      title: String(t.title || `子任务 ${i + 1}`).trim().slice(0, 80),
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
