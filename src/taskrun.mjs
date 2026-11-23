// 任务协作（参考 orca 的 Run → Task DAG → Dispatch 模型）：
//   澄清：首次规划可先问你几个问题；自动开始的等十分钟按默认继续，手动确认的一直等
//   规划：协调者拆子任务 →（可选）其他成员审阅 → 协调者定稿 → 你确认/修改计划
//   执行：依赖都通过的子任务派给负责人；git 项目里每个子任务在独立副本里并行，否则依次直接改
//   审查：子任务做完 → 你看改动对比 → 通过（合并进集成分支）/ 带意见退回重做；需要你决定的问题会停下来问你
//   收尾：协调者写总结 → git 项目可一键合并到你的分支 → 你点「结束任务」后只读
//   中途：你在任务空间发的消息都先交给协调者，它判断是补充说明、改计划、只是问问，还是和目标无关
//
// 依赖的是一个很窄的“宿主”接口（见 space.mjs 的 runHost），不直接碰 Space：
//   host.members / access / workspacePath / workspaceType / dir
//   host.registry / ws / memory / deleting / messages / track(promise) / emit(ev) / save()
//   host.addMessage(msg) / messageDone(msg)：往任务空间的对话里加一条、一条写完了
//   澄清结束后用 host.track 接着规划；等回答期间，输入框发来的消息先排队
import { t as tr } from './i18n.mjs';
import { resolveTurnAccess } from './access.mjs';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as G from './git.mjs';
import { Workspace } from './workspace.mjs';
import { withOverflowRetry, assembleContext, memoryForTurn } from './context.mjs';
import { importBlocks } from './imports.mjs';
import { clarificationDecision } from './memory/organize.mjs';
import { runAgentTurn } from './turn-runner.mjs';
import { AbortedError } from './engines/proc.mjs';
import { newKey, parseMarkers, attachmentText } from './prompts.mjs';
import {
  plannerSystem, plannerPrompt, reviewerSystem, reviewerPrompt, workerSystem, workerPrompt,
  summarySystem, summaryPrompt, commitSystem, commitPrompt, parsePlan, parseClarify, normalizePlan, parseReport,
  triageSystem, triagePrompt, parseTriage,
} from './task-prompts.mjs';

const ACTIVE = new Set(['planning', 'clarifying', 'plan_review', 'executing', 'summarizing']);
export const CLARIFY_WAIT = 10 * 60 * 1000;
export const clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
};
export const PLAN_CONFIRM = ['manual', 'auto'];
const SATISFIED = new Set(['approved', 'skipped']);
const SETTLED = new Set(['approved', 'skipped', 'cancelled']);
const MAX_LOG = 600;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const realPath = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
export function extractTaskPaths(text) {
  const out = new Set();
  const cleaned = String(text || '').replace(/[a-z]+:\/\/\S+/gi, ' ');
  for (const m of cleaned.matchAll(/(?:^|[\s`'"（(【\[,，;；:：])(\.?\/?(?:[\w.\-\u4e00-\u9fff]+[/\\])+[\w.\-\u4e00-\u9fff]+\.[A-Za-z0-9]{1,10}|[\w.\-\u4e00-\u9fff]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|css|html|py|go|rs|java|yml|yaml|toml|sh|cmd|ps1))(?=$|[\s`'"）)】\],，;；:：。])/g)) {
    const p = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
    if (p && !p.startsWith('../')) out.add(p);
  }
  return [...out];
}

/** 开始前检查：是不是 git 项目、有没有未提交的改动。 */
export async function preflight(host) {
  if (host.workspaceType === 'managed') return { mode: 'direct' };
  const info = await G.repoInfo(host.workspacePath).catch(() => null);
  // 只是碰巧位于用户主目录这种“大仓库”里的子文件夹：不要拿整个主目录建副本
  if (info && path.resolve(info.root).toLowerCase() === path.resolve(os.homedir()).toLowerCase() && path.resolve(host.workspacePath).toLowerCase() !== path.resolve(info.root).toLowerCase()) {
    return { mode: 'direct', note: tr('这个文件夹位于你用户目录的 git 仓库里，但它本身不是项目根目录，所以按“依次直接改”的方式进行。') };
  }
  if (!info) return { mode: 'direct', gitAvailable: await G.gitAvailable() };
  if (info.noCommits) return { mode: 'direct', note: tr('这是 git 仓库，但还没有任何提交，所以按“依次直接改”的方式进行。') };
  return { mode: 'git', repo: info.root, branch: info.branch, dirty: info.dirty, dirtyFiles: info.dirtyFiles };
}

/** 任务的临时副本目录。 */
export const runDir = (host, runId) => path.join(host.dir, 'runs', runId);

/** 删除一次任务的副本和临时分支（不需要 TaskRun 实例，删除空间时也用它）。 */
export async function cleanupRunFiles(data, dir, { keepIntegration = true } = {}) {
  if (data.mode !== 'git') return;
  const g = data.git;
  for (const t of data.tasks) {
    if (t.git?.path) { await G.removeWorktree(g.repo, t.git.path, t.git.branch); t.git.removed = true; }
  }
  if (!keepIntegration && g.intPath) { await G.removeWorktree(g.repo, g.intPath, g.intBranch); g.removed = true; }
  fs.rmSync(dir, { recursive: true, force: true });
}

export class TaskRun extends EventEmitter {
  constructor(host, data) {
    super();
    this.host = host;
    this.data = data;
    this.controllers = new Map(); // taskId / 'plan' -> AbortController
    this.timer = null;
    this.clarifyTimer = null;
    // 往集成分支的合并必须一个接一个：同一个副本里同时跑两个 git merge 会撞上 index.lock
    this.integrationQueue = Promise.resolve();
    this.merging = new Set(); // 正在排队/合并的子任务，防止重复点“通过”
    // 软件重启后恢复：进行中的步骤都算中断
    for (const t of data.tasks) {
      if (t.status === 'running') {
        t.status = 'ready';
        const a = t.attempts.at(-1);
        if (a && !a.endedAt) { a.endedAt = Date.now(); a.error = tr('软件关闭，这一次中断了'); }
      }
    }
    for (const m of data.planning.messages) if (m.streaming) { m.streaming = false; m.interrupted = true; }
    if (data.status === 'planning') {
      data.status = data.tasks.length ? 'plan_review' : 'failed';
      if (!data.tasks.length) data.error = tr('软件关闭，规划中断了。请重新开始。');
    }
    if (data.status === 'summarizing') data.status = 'executing';
    if (data.status === 'executing') data.paused = true;
    data.planConfirm = PLAN_CONFIRM.includes(data.planConfirm) ? data.planConfirm : 'manual';
    this.inbox = [];          // 你发来、协调者还没处理的消息
    this.thinking = false;    // 协调者正在判断
    this.dispatching = new Map(); // taskId -> 正在进行的这一次（停掉后要等它收尾）
    // 软件关闭时协调者还没回的消息：不自动重发，标记一下
    for (const m of host.messages || []) {
      if (m.queued) { m.queued = false; m.unanswered = true; }
      if (m.streaming) { m.streaming = false; m.interrupted = true; }
    }
    if (data.status === 'clarifying') this.scheduleClarify();
  }

  static create(host, opts, pre) {
    const coordinator = host.members.find((m) => m.id === opts.coordinatorId) || host.members[0];
    const id = randomUUID().slice(0, 8);
    const data = {
      id,
      objective: str(opts.objective, 8000),
      coordinatorId: coordinator.id,
      clarifyFirst: opts.clarify !== false,
      discuss: opts.discuss !== false && host.members.length > 1,
      maxParallel: Math.min(6, Math.max(1, parseInt(opts.maxParallel, 10) || 3)),
      autoApprove: !!opts.autoApprove,
      planConfirm: PLAN_CONFIRM.includes(opts.planConfirm) ? opts.planConfirm : 'manual',
      mode: pre.mode,
      git: pre.mode === 'git' ? {
        repo: pre.repo,
        // git 给的仓库路径是真实路径；共享文件夹可能经过链接（macOS 的 /var → /private/var、
        // Windows 的短文件名或目录联接），两边都换成真实路径再算相对位置
        sub: path.relative(realPath(pre.repo), realPath(host.workspacePath)),
        baseBranch: pre.branch,
        intBranch: `agenda-${id}`,
      } : null,
      status: 'planning',
      planning: { messages: [] },
      tasks: [],
      summary: null,
      merged: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (!data.objective) throw new Error(tr('请写下这次要完成的目标'));
    return new TaskRun(host, data);
  }

  get id() { return this.data.id; }
  get active() { return ACTIVE.has(this.data.status); }
  get dir() { return runDir(this.host, this.id); }
  member(id) { return this.host.members.find((m) => m.id === id); }
  get coordinator() { return this.member(this.data.coordinatorId) || this.host.members[0]; }
  /** “依次直接改”正在改共享文件夹：同一个文件夹的聊天空间这时只能读。 */
  get locksFolder() {
    return !this.data.closed && this.data.mode === 'direct' && this.data.status === 'executing';
  }

  // ---------- 对外视图 ----------
  publicView() {
    const d = this.data;
    return {
      ...d,
      thinking: this.thinking,
      inbox: this.inbox.length,
      tasks: d.tasks.map((t) => ({
        ...t,
        attempts: t.attempts.map(({ log, ...a }) => ({ ...a, logLines: log?.length || 0 })),
      })),
    };
  }

  taskDetail(taskId) {
    const t = this.task(taskId);
    return { ...t, attempts: t.attempts };
  }

  task(id) {
    const t = this.data.tasks.find((x) => x.id === id);
    if (!t) throw new Error(tr('没有这个子任务'));
    return t;
  }

  changed() {
    if (this.host.deleting) return;
    this.data.updatedAt = Date.now();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.host.save();
      this.host.emit({ type: 'run', run: this.publicView() });
    }, 200);
  }

  // ---------- 调用 AI（统一处理流式、日志、文件块） ----------
  buildContext(member, { system, prompt, task, files, tokenBudget }) {
    const h = this.host, api = h.registry.isApi(member.engine);
    const taskText = task ? task.title + '\n' + task.spec : '';
    const taskFiles = task ? [...new Set([...(task.files || []), ...extractTaskPaths(taskText), ...(task.changes || []).map((c) => c.path)])] : [];
    const focus = task ? { id: task.id, deps: task.deps, files: taskFiles, text: taskText } : { coordinator: true };
    const base = typeof prompt === 'function' ? prompt('') : prompt;
    return assembleContext({ system, tokenBudget, imports: importBlocks(h.messages || []), files,
      lines: [{ text: base }], memory: (limits) => memoryForTurn({ memory: h.memory, memoryDir: h.memoryDir, api,
        canReadMemoryDir: h.registry.supportsReadOnlyDirs?.(member.engine) ?? (member.engine === 'pi'),
        task: focus, query: focus.text || this.data.objective, references: base, messages: h.messages }, limits),
      compose: (s) => [s.imports, s.memory.prefix, s.memory.extras, typeof prompt === 'function' ? prompt(s.files) : base].filter(Boolean).join('\n\n'),
    });
  }

  previewContext(member, tokenBudget) {
    const d = this.data, h = this.host;
    const task = d.tasks.find((t) => t.assigneeId === member.id && !SETTLED.has(t.status));
    const api = h.registry.isApi(member.engine), cwd = task?.git?.path || h.workspacePath;
    if (task) return this.buildContext(member, { system: workerSystem(h, d, task, member, { api, cwd }), task,
      files: api ? h.ws.snapshot() : null, prompt: (fileText) => workerPrompt(h, d, task, { key: 'preview0', fileText }), tokenBudget });
    return this.buildContext(member, { system: plannerSystem(h, d, member), prompt: plannerPrompt(d, { clarify: d.clarify }), tokenBudget });
  }

  async call(member, { system, prompt, cwd, role = 'coordinator', key, sink, wsForApi, onDelta, images, onNoImages, task, files }) {
    if (this.host.deleting) throw new AbortedError();
    const controller = new AbortController();
    this.controllers.set(key, controller);
    try {
      controller.memberId = member.id;
      const { access } = resolveTurnAccess({
        spaceKind: 'task', spaceAccess: this.host.access, role, isApi: this.host.registry.isApi(member.engine),
      });
      const build = (tokenBudget) => this.buildContext(member, { system, prompt, task, files, tokenBudget });
      const { result } = await withOverflowRetry(this.host, member, sink, build, (ctx) => runAgentTurn(this.host.registry, member, {
        system: ctx.system, prompt: ctx.prompt, readOnlyDirs: this.host.memoryDir ? [this.host.memoryDir] : [],
        cwd,
        access,
        signal: controller.signal,
        sink,
        ws: wsForApi, images, onNoImages,
        maxActivities: 80,
        maxLog: MAX_LOG,
        onDelta: (t) => { onDelta?.(t); this.changed(); },
        onActivity: () => this.changed(),
      }), controller.signal);
      return result.text;
    } finally {
      this.controllers.delete(key);
    }
  }

  // ---------- 规划 ----------
  async plan({ feedback = [], images = [] } = {}) {
    const d = this.data;
    d.status = 'planning';
    d.error = null;
    this.changed();
    const coord = this.coordinator;
    const cwd = this.host.workspacePath;
    const say = async (member, system, prompt, images) => {
      const msg = { id: randomUUID().slice(0, 10), memberId: member.id, name: member.name, text: '', streaming: true, ts: Date.now(), activities: [] };
      d.planning.messages.push(msg);
      this.changed();
      try {
        msg.text = (await this.call(member, { system, prompt, images, cwd, key: 'plan', sink: msg })).trim();
        return msg.text;
      } catch (e) {
        if (e.aborted) msg.interrupted = true; else msg.error = e.message;
        throw e;
      } finally {
        msg.streaming = false;
        this.changed();
      }
    };

    try {
      const previous = d.tasks.length ? d.tasks.map((t) => ({ id: t.id, title: t.title, assignee: this.member(t.assigneeId)?.name, deps: t.deps, spec: t.spec })) : null;
      const canAsk = d.clarifyFirst && !d.clarify && !d.tasks.length && !feedback.length;
      const text = await say(coord, plannerSystem(this.host, d, coord, { clarify: canAsk }), plannerPrompt(d, { feedback, previous, clarify: d.clarify }), images);
      if (this.host.deleting || d.closed) return;
      const plan = parsePlan(text);
      if (!plan) {
        const clarification = canAsk && parseClarify(text);
        if (!clarification) throw new Error(tr('{0} 没有给出可识别的计划（需要 JSON 格式）。可以换一个协调者，或点“重新规划”。', [coord.name]));
        const askedAt = clock.now();
        d.clarify = { questions: clarification.questions, answers: {}, askedAt };
        if (d.planConfirm === 'auto') d.clarify.deadline = askedAt + CLARIFY_WAIT;
        d.status = 'clarifying';
        this.changed();
        this.scheduleClarify();
        return;
      }
      let tasks = normalizePlan(plan.tasks, this.host.members, coord.id);
      let assumptions = plan.assumptions;

      // 第一次规划且开启了“先商量”：其他成员各提一次意见，协调者再定稿
      if (d.discuss && !previous && !feedback.length) {
        const opinions = [];
        for (const m of this.host.members.filter((x) => x.id !== coord.id)) {
          const draft = tasks.map((t) => ({ ...t, assignee: this.member(t.assigneeId)?.name }));
          const text = await say(m, reviewerSystem(this.host, d, m, coord), reviewerPrompt(d, draft, { clarify: d.clarify }));
          const mk = parseMarkers(text.replace(/\[(?:同意|Agree)\]/gi, '[Skip]'));
          if (!mk.passed && mk.text) opinions.push({ name: m.name, text: mk.text });
        }
        if (opinions.length) {
          const prev = tasks.map((t) => ({ id: t.id, title: t.title, assignee: this.member(t.assigneeId)?.name, deps: t.deps, spec: t.spec }));
          const final = parsePlan(await say(coord, plannerSystem(this.host, d, coord), plannerPrompt(d, { feedback: opinions, previous: prev, clarify: d.clarify })));
          if (final) {
            tasks = normalizePlan(final.tasks, this.host.members, coord.id);
            if (final.assumptions.length) assumptions = final.assumptions;
          }
        }
      }
      d.tasks = tasks.map((t) => this.blankTask(t));
      const defaults = (d.clarify?.resolvedAt != null ? d.clarify.questions : [])
        .filter((q) => !Object.hasOwn(d.clarify.answers, q.id))
        .map((q) => clarificationDecision(q, d.clarify.answers));
      // 默认条目始终排在前面；重新规划时只沿用后面的协调者假设。
      if (!assumptions.length && d.assumptions) assumptions = d.assumptions.slice(defaults.length);
      d.assumptions = [...defaults, ...assumptions];
      this.host.recordPlanDecisions?.(d);
      d.status = 'plan_review';
    } catch (e) {
      d.status = d.tasks.length ? 'plan_review' : 'failed';
      d.error = e.aborted ? tr('规划被取消了') : e.message;
    }
    this.changed();
    // 选了「自动开始执行」：计划定好直接开始，计划照样显示，随时可以停
    if (d.status === 'plan_review' && d.planConfirm === 'auto' && !this.host.deleting) {
      try { await this.approvePlan(); } catch (e) { d.error = e.message; this.changed(); }
    }
    this.drainInbox();
  }

  blankTask(t) {
    return { ...t, status: 'pending', attempts: [], feedbacks: [], notes: [], question: null, answer: null, changes: [], git: null };
  }

  clearClarifyTimer() {
    if (this.clarifyTimer != null) clock.clearTimeout(this.clarifyTimer);
    this.clarifyTimer = null;
  }

  scheduleClarify() {
    this.clearClarifyTimer();
    const d = this.data;
    if (d.status !== 'clarifying' || d.clarify.deadline == null) return;
    const timer = clock.setTimeout(() => {
      if (this.clarifyTimer === timer && d.status === 'clarifying' && !this.host.deleting) this.resolveClarify({}, true);
    }, Math.max(0, d.clarify.deadline - clock.now()));
    this.clarifyTimer = timer;
  }

  answerClarify(answers) {
    this.resolveClarify(answers);
  }

  useDefaults() {
    this.resolveClarify({});
  }

  resolveClarify(answers, timedOut = false) {
    if (this.data.status !== 'clarifying') throw new Error(tr('现在没有在等你回答问题'));
    this.clearClarifyTimer();
    const c = this.data.clarify;
    const entries = Array.isArray(answers) ? answers.map((a) => [a?.id, a?.text]) : Object.entries(answers || {});
    const ids = new Set(c.questions.map((q) => q.id));
    c.answers = Object.fromEntries(entries.filter(([id, text]) => ids.has(id) && typeof text === 'string' && text.trim())
      .map(([id, text]) => [id, str(text, 2000)]));
    c.resolvedAt = clock.now();
    c.defaulted = c.questions.filter((q) => !Object.hasOwn(c.answers, q.id)).map((q) => q.id);
    if (timedOut) c.timedOut = true;
    this.host.recordPlanDecisions?.(this.data);
    this.changed();
    this.host.track(this.plan());
  }

  replan(feedbackText) {
    if (this.data.status !== 'plan_review' && this.data.status !== 'failed') throw new Error(tr('现在不能重新规划'));
    const fb = str(feedbackText, 4000);
    this.host.track(this.plan({ feedback: fb ? [{ name: tr('我'), text: fb }] : [{ name: tr('我'), text: tr('请重新考虑分工和拆分方式。') }] }));
  }

  /** 你确认（可能改过的）计划后开始执行。 */
  async approvePlan(edited) {
    const d = this.data;
    if (d.status !== 'plan_review') throw new Error(tr('现在不是确认计划的时候'));
    if (Array.isArray(edited)) {
      if (!edited.length) throw new Error(tr('计划里至少要有一个子任务'));
      d.tasks = normalizePlan(edited, this.host.members, this.coordinator.id).map((t) => this.blankTask(t));
    }
    await this.ensureIntegration();
    d.status = 'executing';
    d.paused = false;
    this.changed();
    this.tick();
  }

  /** git 项目：建好集成分支的副本（合并进你的项目之后又追加子任务时，重新从你的分支开一个）。 */
  async ensureIntegration() {
    const d = this.data;
    if (d.mode !== 'git') return;
    fs.mkdirSync(this.dir, { recursive: true });
    const g = d.git;
    g.intPath = path.join(this.dir, 'integration');
    if (fs.existsSync(g.intPath) && !g.removed) return;
    g.baseCommit = await G.headOf(g.repo);
    await G.addWorktree(g.repo, g.intPath, g.intBranch, g.baseCommit);
    g.removed = false;
    d.merged = null;
  }

  // ---------- 调度 ----------
  tick() {
    const d = this.data;
    if (this.host.deleting || d.status !== 'executing' || d.paused || d.hold) return;
    for (const t of d.tasks) {
      if (t.status === 'pending' && t.deps.every((id) => SATISFIED.has(d.tasks.find((x) => x.id === id)?.status))) t.status = 'ready';
    }
    const running = d.tasks.filter((t) => t.status === 'running');
    const capacity = d.mode === 'git' ? d.maxParallel : 1;
    const busy = new Set(running.map((t) => t.assigneeId));
    for (const t of d.tasks) {
      if (running.length >= capacity) break;
      if (t.status !== 'ready' || busy.has(t.assigneeId)) continue;
      busy.add(t.assigneeId);
      running.push(t);
      this.host.track(this.dispatch(t));
    }
    if (d.tasks.every((t) => SETTLED.has(t.status)) && !this.thinking && !this.inbox.length) this.host.track(this.summarize());
    this.changed();
  }

  resume() {
    if (this.data.status !== 'executing') throw new Error(tr('现在不需要继续'));
    this.data.paused = false;
    this.tick();
  }

  dispatch(task, opts) {
    const p = this.runTask(task, opts);
    this.dispatching.set(task.id, p);
    const done = () => { if (this.dispatching.get(task.id) === p) this.dispatching.delete(task.id); };
    p.then(done, done);
    return p;
  }

  async runTask(task, { conflict = null } = {}) {
    const d = this.data;
    const member = this.member(task.assigneeId);
    task.status = 'running';
    const attempt = { id: randomUUID().slice(0, 10), memberId: member?.id || task.assigneeId, engine: member?.engine || '',
      model: member?.model || '', startedAt: Date.now(), text: '', activities: [], log: [], conflict: conflict || undefined, notes: task.notes?.length || 0 };
    task.attempts.push(attempt);
    this.changed();
    if (!member) {
      attempt.error = tr('负责这个子任务的成员已经不在空间里了，请改派或跳过。');
      attempt.endedAt = Date.now();
      task.status = 'failed';
      return this.tick();
    }

    let cwd;
    let ws = null;
    try {
      const api = this.host.registry.isApi(member.engine);
      if (d.mode === 'git') {
        const g = d.git;
        if (!task.git) {
          const base = await G.headOf(g.intPath); // 含已通过的前置任务
          const wt = path.join(this.dir, task.id);
          const branch = `${g.intBranch}-${task.id.toLowerCase()}`;
          await G.addWorktree(g.repo, wt, branch, base);
          task.git = { path: wt, branch, base, head: base };
        }
        attempt.startHead = task.git.head;
        cwd = path.join(task.git.path, g.sub);
        if (api) ws = new Workspace(cwd, path.join(this.dir, `${task.id}-scratch-history.json`));
      } else {
        cwd = this.host.workspacePath;
        const outside = this.host.ws.begin();
        if (outside.length) this.host.emit({ type: 'files_changed', changes: outside });
        if (api) ws = this.host.ws;
      }

      const key = newKey();
      const text = await this.call(member, {
        system: workerSystem(this.host, d, task, member, { api, cwd }),
        task, files: ws?.snapshot(), prompt: (fileText) => workerPrompt(this.host, d, task, { key, fileText, conflict }),
        cwd,
        role: 'task-worker',
        key: task.id,
        sink: attempt,
        wsForApi: ws,
      });
      const rep = parseReport(text);
      attempt.text = text.trim();
      attempt.report = rep.report;
      attempt.outcome = rep.outcome;
      if (rep.outcome === 'question') { task.question = rep.detail || rep.report.split('\n').at(-1); task.answer = null; }
      if (rep.outcome === 'failed') attempt.error = rep.detail || tr('它报告没有完成');
    } catch (e) {
      attempt.error = e.aborted ? tr('被你中止了') : e.message;
      attempt.outcome = e.aborted ? 'cancelled' : 'failed';
    }

    // 记录改动
    try {
      if (d.mode === 'git' && task.git) {
        const head = await G.commitAll(task.git.path, `${task.id} ${task.title}（${member.name}）`, member.name);
        if (head) task.git.head = head;
        // 只看这个子任务自己的改动：从它和集成分支的分叉点算起（解决冲突时合进来的别人的改动不算）
        task.git.reviewBase = await G.mergeBase(task.git.path, d.git.intBranch, task.git.head);
        task.changes = await G.changedFiles(task.git.path, task.git.reviewBase, task.git.head);
      } else if (d.mode === 'direct') {
        const ch = this.host.ws.commit(member.name, attempt.id);
        attempt.changeIds = ch.map((c) => c.id);
        if (ch.length) {
          this.host.emit({ type: 'files_changed', changes: ch });
          const known = new Map((task.changes || []).map((c) => [c.path, c]));
          for (const c of ch) known.set(c.path, { ...c, ids: [...(known.get(c.path)?.ids || []), c.id] });
          task.changes = [...known.values()];
        }
      }
    } catch (e) {
      attempt.error = tr('{0}记录改动失败：{1}', [attempt.error ? `${attempt.error}；` : '', e.message]);
    }

    attempt.endedAt = Date.now();
    // 协调者按你的新要求停下了它：状态由协调者那边接着处理
    if (task.stopping) { attempt.error = null; attempt.outcome = 'stopped'; return this.changed(); }
    if (task.status !== 'running') return this.changed(); // 期间被取消/跳过
    if (attempt.outcome === 'question') task.status = 'blocked';
    else if (attempt.error) task.status = 'failed';
    else task.status = 'review';
    this.changed();
    if (task.status === 'review' && d.autoApprove) {
      // 自动通过失败（比如 git 出错）：留在“待审查”，把原因记在这次尝试上，你可以手动再点通过
      return this.approveTask(task.id).catch((e) => { attempt.error = e.message; this.changed(); });
    }
    this.tick();
  }

  // ---------- 审查 ----------
  async approveTask(taskId) {
    const d = this.data;
    const t = this.task(taskId);
    if (t.status !== 'review') throw new Error(tr('这个子任务现在不能通过'));
    if (this.merging.has(t.id)) throw new Error(tr('这个子任务正在合并，请稍等'));
    d.paused = false; // 你对子任务的任何操作都视为继续
    if (d.mode === 'git' && t.git && t.changes?.length) {
      this.merging.add(t.id);
      let r;
      try {
        r = await this.withIntegrationLock(() => this.mergeIntoIntegration(t));
      } finally {
        this.merging.delete(t.id);
      }
      if (r.conflict) {
        this.host.track(this.dispatch(t, { conflict: r.files }));
        return { conflict: true, files: r.files };
      }
      if (r.skipped) return { ok: false }; // 排队期间被跳过/取消了
    }
    t.status = 'approved';
    t.approvedAt = Date.now();
    this.host.save();
    try { this.host.recordApprovedTask?.(t); } catch (e) { console.warn(tr('写入任务结果到记忆库失败：'), e.message); }
    this.changed();
    this.tick();
    return { ok: true };
  }

  /** 排队执行一次对集成分支的操作；前一个失败不影响后一个。 */
  withIntegrationLock(fn) {
    const next = this.integrationQueue.then(fn, fn);
    this.integrationQueue = next.catch(() => {});
    return next;
  }

  /**
   * 把子任务分支合进集成分支（调用方须持有 withIntegrationLock）。
   * 真正的内容冲突 → { conflict, files }，交给负责人解决；
   * git 自身出错（锁文件、权限等）→ 抛错，子任务停在“待审查”，可以再点通过重试。
   */
  async mergeIntoIntegration(t) {
    if (t.status !== 'review') return { skipped: true };
    const g = this.data.git;
    const r = await G.merge(g.intPath, t.git.branch, tr('合并 {0} {1}', [t.id, t.title]));
    if (r.ok) return { ok: true };
    if (!r.conflicts.length) throw new Error(tr('合并进集成分支失败（不是内容冲突）：{0}', [r.error || tr('未知错误')]));
    // 冲突：把集成分支合进它自己的副本（留下冲突标记），让负责人解决
    const back = await G.merge(t.git.path, g.intBranch, tr('同步集成分支到 {0}', [t.id]), { abortOnConflict: false });
    if (!back.ok && !back.conflicts.length) throw new Error(tr('把集成分支同步到 {0} 的副本失败：{1}', [t.id, back.error || tr('未知错误')]));
    const files = back.ok ? [] : back.conflicts;
    t.feedbacks.push({ ts: Date.now(), text: tr('合并时和其他已通过的子任务冲突（{0}），请解决冲突。', [(files.length ? files : r.conflicts).join('、')]) });
    return { conflict: true, files: files.length ? files : r.conflicts };
  }

  rejectTask(taskId, feedback) {
    const t = this.task(taskId);
    if (!['review', 'failed'].includes(t.status)) throw new Error(tr('这个子任务现在不能退回'));
    const text = str(feedback, 20000);
    if (!text) throw new Error(tr('请写下要怎么改'));
    this.data.paused = false;
    t.feedbacks.push({ ts: Date.now(), text });
    this.host.track(this.dispatch(t));
  }

  retryTask(taskId) {
    const t = this.task(taskId);
    if (!['failed', 'ready', 'review'].includes(t.status)) throw new Error(tr('这个子任务现在不能重试'));
    if (this.data.status !== 'executing') throw new Error(tr('任务不在执行中'));
    this.data.paused = false;
    this.host.track(this.dispatch(t));
  }

  answer(taskId, text) {
    const t = this.task(taskId);
    if (t.status !== 'blocked') throw new Error(tr('这个子任务没有在等你回答'));
    t.answer = str(text, 4000);
    if (!t.answer) throw new Error(tr('请写下回答'));
    this.data.paused = false;
    this.host.track(this.dispatch(t));
  }

  reassign(taskId, memberId) {
    const t = this.task(taskId);
    if (t.status === 'running') throw new Error(tr('先停止这个子任务再改派'));
    if (!this.member(memberId)) throw new Error(tr('没有这个成员'));
    t.assigneeId = memberId;
    this.changed();
  }

  stopTask(taskId) {
    const t = this.task(taskId);
    this.controllers.get(taskId)?.abort();
    return t;
  }

  skipTask(taskId) {
    const t = this.task(taskId);
    this.controllers.get(taskId)?.abort();
    t.status = 'skipped';
    this.data.paused = false;
    this.changed();
    this.tick();
  }

  /** 依次直接改模式：撤销这个子任务做过的全部改动。 */
  undoTask(taskId) {
    const t = this.task(taskId);
    if (this.data.mode !== 'direct') throw new Error(tr('git 模式下没通过的改动本来就不会进入你的项目'));
    if (t.status === 'running') throw new Error(tr('先停止这个子任务'));
    const ids = (t.changes || []).flatMap((c) => c.ids || [c.id]).reverse();
    for (const id of ids) {
      try { this.host.ws.undo(id); } catch (e) { if (!/找不到/.test(e.message)) throw e; }
    }
    this.host.emit({ type: 'files_changed', changes: [] });
    t.changes = [];
    t.undone = true;
    this.changed();
  }

  // ---------- 收尾 ----------
  async summarize() {
    const d = this.data;
    if (d.status !== 'executing') return;
    d.status = 'summarizing';
    this.changed();
    const coord = this.coordinator;
    const sink = { text: '', activities: [], streaming: true };
    d.summary = sink;
    try {
      sink.text = (await this.call(coord, { system: summarySystem(this.host, coord), prompt: summaryPrompt(this.host, d), cwd: this.host.workspacePath, key: 'summary', sink })).trim();
    } catch (e) {
      sink.error = e.aborted ? tr('总结被取消了') : e.message;
    }
    sink.streaming = false;
    d.status = 'done';
    d.finishedAt = Date.now();
    // 总结也放进任务空间的对话里（每写一次总结一张卡片）
    const done = d.tasks.filter((t) => t.status === 'approved').length;
    this.host.addMessage({
      id: randomUUID(), kind: 'summary', memberId: coord.id, name: coord.name, engine: coord.engine, ts: Date.now(),
      text: sink.text, error: sink.error, approved: done, total: d.tasks.length,
    });
    this.changed();
    this.host.save();
    this.drainInbox();
  }

  gitForMerge() {
    const d = this.data;
    if (d.mode !== 'git' || d.status !== 'done') throw new Error(tr('现在不能合并'));
    if (!d.tasks.some((t) => t.status === 'approved')) throw new Error(tr('没有通过审查的子任务，不需要合并'));
    return d.git;
  }

  defaultCommitMessage() {
    return tr('Agenda 任务：{0}', [this.data.objective.split('\n')[0].slice(0, 60)]);
  }

  async draftCommitMessage() {
    const g = this.gitForMerge();
    const d = this.data;
    try {
      const base = await G.mergeBase(g.repo, 'HEAD', g.intBranch);
      const [commits, files] = await Promise.all([G.recentCommits(g.repo), G.changedFiles(g.repo, base, g.intBranch)]);
      const summary = this.host.messages.findLast((m) => m.kind === 'summary' && m.text?.trim())?.text || d.summary?.text;
      const coord = this.coordinator;
      const reply = await this.call(coord, {
        system: commitSystem(this.host, coord), prompt: commitPrompt(d, { commits, files, summary }),
        cwd: this.host.workspacePath, key: Symbol('commit'), sink: { text: '', activities: [], streaming: true },
      });
      const message = str(reply.trim().replace(/^```[^\n]*\n(?:([\s\S]*?)\n)?```$/, '$1'), 4000);
      if (message) return { message, drafted: true };
    } catch { /* 起草失败或中止时，仍可用默认说明合并。 */ }
    return { message: this.defaultCommitMessage(), drafted: false };
  }

  /** git 模式：把集成分支合并到你当前的分支。 */
  async mergeIntoProject(message) {
    const d = this.data;
    const g = this.gitForMerge();
    const info = await G.repoInfo(g.repo);
    if (info.dirtyTracked) throw new Error(tr('你的项目（{0} 分支）有 {1} 个文件改了还没提交。请先提交或暂存，再合并。', [info.branch, info.dirtyTracked]));
    const r = await G.merge(g.repo, g.intBranch, str(message, 5000) || this.defaultCommitMessage());
    if (!r.ok && r.conflicts.length) throw new Error(tr('合并冲突（{0}）。已放弃这次合并，你的项目没有变化。可以手动合并分支 {1}。', [r.conflicts.join('、'), g.intBranch]));
    if (!r.ok) throw new Error(tr('合并失败：{0}。你的项目没有变化，可以稍后再试，或手动合并分支 {1}。', [r.error || tr('未知错误'), g.intBranch]));
    d.merged = { at: Date.now(), branch: info.branch, head: r.head };
    await this.cleanup({ keepIntegration: false });
    this.changed();
    this.host.emit({ type: 'files_changed', changes: [] });
    return d.merged;
  }

  /** 删除副本和临时分支。 */
  cleanup(opts) {
    return cleanupRunFiles(this.data, this.dir, opts);
  }

  stopForRemoval() {
    this.clearClarifyTimer();
    this.inbox = [];
    this.data.paused = true;
    for (const c of this.controllers.values()) c.abort();
    clearTimeout(this.timer);
  }

  /** 停下所有正在做的（结束任务、删除空间时用）。 */
  async stopAll() {
    for (const c of this.controllers.values()) c.abort();
    while (this.dispatching.size) await Promise.allSettled([...this.dispatching.values()]);
  }

  /**
   * 结束任务：之后这个任务空间只读，留作记录。正在做的会先停下。
   * git 项目没合并的结果留在集成分支上；依次直接改已经改了的文件不还原（可以在改动记录里撤销）。
   */
  async finish() {
    const d = this.data;
    if (d.closed) throw new Error(tr('这个任务已经结束了'));
    this.clearClarifyTimer();
    this.inbox = [];
    for (const m of this.host.messages) if (m.queued) { m.queued = false; m.unanswered = true; }
    await this.stopAll();
    for (const t of d.tasks) if (!SETTLED.has(t.status)) t.status = 'cancelled';
    if (ACTIVE.has(d.status)) d.status = ['planning', 'clarifying', 'plan_review'].includes(d.status) ? 'cancelled' : (d.summary?.text ? 'done' : 'cancelled');
    d.hold = null;
    d.paused = false;
    d.closed = true;
    d.finishedAt = Date.now();
    if (d.mode === 'git') await this.cleanup({ keepIntegration: !d.merged && d.tasks.some((t) => t.status === 'approved') }).catch((e) => { d.error = tr('清理副本失败：{0}', [e.message]); });
    this.changed();
  }

  /** 任务空间设置里改的选项。 */
  updateSettings(patch = {}) {
    const d = this.data;
    if (PLAN_CONFIRM.includes(patch.planConfirm) && patch.planConfirm !== d.planConfirm) {
      d.planConfirm = patch.planConfirm;
      if (d.status === 'clarifying') {
        if (d.planConfirm === 'auto') d.clarify.deadline = d.clarify.askedAt + CLARIFY_WAIT;
        else delete d.clarify.deadline;
        this.scheduleClarify();
      }
    }
    if ('autoApprove' in patch) d.autoApprove = !!patch.autoApprove;
    if ('discuss' in patch) d.discuss = !!patch.discuss;
    if ('maxParallel' in patch) d.maxParallel = Math.min(6, Math.max(1, parseInt(patch.maxParallel, 10) || d.maxParallel));
    if ('coordinatorId' in patch && this.member(patch.coordinatorId)) d.coordinatorId = patch.coordinatorId;
    this.changed();
    // 改成自动开始：等你确认的计划直接放行
    if (d.planConfirm === 'auto') {
      if (d.status === 'plan_review' && d.tasks.length) this.host.track(this.approvePlan().catch(() => {}));
      if (d.hold) this.confirmPlan();
    }
  }

  // ---------- 你在任务空间发的消息：都先交给协调者 ----------
  userMessage(text, attachments = []) {
    const d = this.data;
    text = str(text, 20000);
    if (!text && !attachments.length) throw new Error(tr('消息不能为空'));
    if (d.closed) throw new Error(tr('这个任务已经结束，只能查看'));
    const msg = { id: randomUUID(), kind: 'user', name: tr('我'), text, ts: Date.now(), queued: true };
    if (attachments.length) msg.attachments = attachments;
    this.host.addMessage(msg);
    this.inbox.push(msg);
    this.host.save();
    this.drainInbox();
    return msg;
  }

  /** 协调者一条一条处理；澄清、规划、写总结时先等着，做完会回来取。 */
  drainInbox() {
    const d = this.data;
    if (this.thinking || !this.inbox.length || this.host.deleting || d.closed) return;
    if (['planning', 'clarifying', 'summarizing'].includes(d.status)) return;
    const msg = this.inbox.shift();
    this.thinking = true;
    this.changed();
    this.host.track(this.handleMessage(msg).catch((e) => console.error(e)).finally(() => {
      this.thinking = false;
      msg.queued = false;
      this.host.messageDone(msg);
      this.changed();
      if (this.inbox.length) this.drainInbox();
      else this.tick();
    }));
  }

  async handleMessage(msg) {
    const d = this.data;
    const userText = attachmentText(msg, this.host.workspacePath);
    const images = this.host.images(msg.attachments);
    // 还没有计划（规划失败）：把你的话当作意见，重新规划
    if (!d.tasks.length) {
      msg.queued = false;
      await this.plan({ feedback: [{ name: tr('我'), text: userText }], images });
      return;
    }
    const coord = this.coordinator;
    const reply = { id: randomUUID(), kind: 'ai', memberId: coord.id, name: coord.name, engine: coord.engine, text: '', ts: Date.now(), streaming: true, activities: [], replyTo: msg.id };
    if (coord.model) reply.model = coord.model;
    this.host.addMessage(reply);
    const history = this.host.messages
      .filter((m) => m.id !== msg.id && !m.queued && (m.text || m.attachments?.length) && (m.kind === 'user' || (m.kind === 'ai' && m.replyTo)))
      .slice(-6);
    msg.queued = false;
    let text;
    try {
      text = await this.call(coord, {
        system: triageSystem(this.host, d, coord),
        prompt: triagePrompt(this.host, d, userText, { history }),
        images,
        onNoImages: () => this.host.emit({ type: 'no_images', id: reply.id }),
        cwd: this.host.workspacePath,
        key: 'coord',
        sink: reply,
        onDelta: (t) => this.host.emit({ type: 'delta', id: reply.id, text: t }),
      });
    } catch (e) {
      reply.streaming = false;
      if (e.aborted) reply.interrupted = true; else reply.error = e.message;
      this.host.messageDone(reply);
      return;
    }
    const r = parseTriage(text);
    reply.text = r.reply;
    try {
      reply.decision = await this.applyDecision(r);
    } catch (e) {
      reply.decision = { type: 'answer' };
      reply.error = tr('没能按这个判断修改计划：{0}', [e.message]);
    }
    reply.streaming = false;
    this.host.messageDone(reply);
  }

  /** 按协调者的判断改：补充说明分给子任务；有冲突就停掉受影响的子任务、改计划。返回给卡片显示的摘要。 */
  async applyDecision(r) {
    const d = this.data;
    const byId = new Map(d.tasks.map((t) => [t.id, t]));
    if (r.type === 'note') {
      const notes = r.notes.filter((n) => byId.has(n.task) && !SETTLED.has(byId.get(n.task).status));
      for (const n of notes) byId.get(n.task).notes.push({ ts: Date.now(), text: n.text });
      this.changed();
      return { type: 'note', why: r.why, notes: notes.map((n) => ({ task: n.task, title: byId.get(n.task).title, text: n.text, running: byId.get(n.task).status === 'running' })) };
    }
    if (r.type !== 'change') return { type: r.type, why: r.why };
    if (d.closed) throw new Error(tr('这个任务已经结束了'));

    // 已通过 / 已跳过的子任务不能改：协调者没写进新计划的也照样留着
    const raw = [...r.tasks];
    for (const t of d.tasks) if (SATISFIED.has(t.status) && !raw.some((x) => String(x.id) === t.id)) raw.unshift({ id: t.id, title: t.title, assigneeId: t.assigneeId, deps: t.deps, spec: t.spec });
    const plan = normalizePlan(raw, this.host.members, this.coordinator.id, { max: 30 });
    const planned = new Map(plan.map((p) => [p.id, p]));

    // 要停下的：协调者点名的，加上正在做、但被删掉或改了说明 / 负责人的（这种默认留着改动）
    const stop = new Map(r.stop.map((x) => [x.task, x.keep]));
    for (const t of d.tasks) {
      if (t.status !== 'running') continue;
      const p = planned.get(t.id);
      if ((!p || p.spec !== t.spec || p.assigneeId !== t.assigneeId) && !stop.has(t.id)) stop.set(t.id, true);
    }
    const stopped = [];
    for (const [id, keep] of stop) {
      const t = byId.get(id);
      if (t?.status === 'running') stopped.push(await this.stopForChange(t, keep));
    }

    const added = [];
    const changed = [];
    const removed = [];
    const next = [];
    for (const p of plan) {
      const o = byId.get(p.id);
      if (!o) { next.push(this.blankTask(p)); added.push({ task: p.id, title: p.title, assigneeId: p.assigneeId }); continue; }
      next.push(o);
      if (SATISFIED.has(o.status)) continue;
      const what = [];
      if (o.title !== p.title) what.push('title');
      if (o.spec !== p.spec) what.push('spec');
      if (o.assigneeId !== p.assigneeId) what.push('assignee');
      if (o.deps.join() !== p.deps.join()) what.push('deps');
      const revived = o.status === 'cancelled';
      if (!what.length && !revived) continue;
      Object.assign(o, { title: p.title, spec: p.spec, assigneeId: p.assigneeId, deps: p.deps, removed: false });
      // 说明或负责人变了：做过的结果不再算数，按新说明重做（之前的改动还在，在此基础上接着改）
      if (revived || ((what.includes('spec') || what.includes('assignee')) && ['review', 'failed', 'blocked'].includes(o.status))) {
        o.status = 'pending';
        o.question = null;
      }
      changed.push({ task: o.id, title: o.title, what, assigneeId: o.assigneeId });
    }
    for (const o of d.tasks) {
      if (planned.has(o.id)) continue;
      if (o.status !== 'cancelled') removed.push({ task: o.id, title: o.title });
      o.status = 'cancelled';
      o.removed = true;
      next.push(o);
    }
    d.tasks = next;
    d.planVersion = (d.planVersion || 0) + 1;
    d.error = null;

    let hold = false;
    if (d.status === 'plan_review') {
      // 还没开始执行：照常在计划卡片上等你确认（选了自动开始就直接放行）
      if (d.planConfirm === 'auto') await this.approvePlan();
    } else if (d.tasks.some((t) => !SETTLED.has(t.status))) {
      if (d.status === 'done' || d.status === 'failed') {
        await this.ensureIntegration();
        d.status = 'executing';
        d.finishedAt = null;
      }
      d.paused = false;
      if (d.planConfirm === 'manual') { d.hold = { at: Date.now() }; hold = true; }
    }
    this.changed();
    return { type: 'change', why: r.why, stopped, added, changed, removed, hold };
  }

  /** 协调者要改计划，先停下这个子任务；keep=false 时丢掉它这一次做了一半的改动。 */
  async stopForChange(t, keep) {
    t.stopping = true;
    this.controllers.get(t.id)?.abort();
    await this.dispatching.get(t.id)?.catch(() => {});
    t.stopping = false;
    const a = t.attempts.at(-1);
    if (!keep && a) await this.discardAttempt(t, a).catch((e) => { a.note = tr('丢掉改动时出错：{0}', [e.message]); });
    if (a && !a.note) a.note = keep ? tr('协调者按你的新要求停下了这一次，改动留着') : tr('协调者按你的新要求停下了这一次，改动已丢掉');
    t.status = 'pending';
    this.changed();
    return { task: t.id, title: t.title, keep };
  }

  async discardAttempt(t, a) {
    if (this.data.mode === 'git') {
      if (!t.git || !a.startHead) return;
      await G.resetHard(t.git.path, a.startHead);
      t.git.head = a.startHead;
      t.git.reviewBase = await G.mergeBase(t.git.path, this.data.git.intBranch, t.git.head);
      t.changes = await G.changedFiles(t.git.path, t.git.reviewBase, t.git.head);
      return;
    }
    const ids = [...(a.changeIds || [])].reverse();
    for (const id of ids) {
      try { this.host.ws.undo(id, { force: true }); } catch (e) { if (!/找不到|not found/i.test(e.message)) throw e; }
    }
    const gone = new Set(a.changeIds || []);
    t.changes = (t.changes || []).map((c) => ({ ...c, ids: (c.ids || [c.id]).filter((id) => !gone.has(id)) })).filter((c) => c.ids.length);
    if (ids.length) this.host.emit({ type: 'files_changed', changes: [] });
  }

  /** 改过的计划等你确认（选了「等我确认」时）。 */
  confirmPlan() {
    const d = this.data;
    if (!d.hold) throw new Error(tr('没有等你确认的计划'));
    d.hold = null;
    d.paused = false;
    this.changed();
    this.tick();
  }


  /** 子任务某个文件改动前后的内容。 */
  async fileDiff(taskId, file) {
    const t = this.task(taskId);
    const c = (t.changes || []).find((x) => x.path === file);
    if (!c) throw new Error(tr('这个子任务没有改这个文件'));
    if (this.data.mode === 'git') {
      const cwd = t.git.removed ? this.data.git.repo : t.git.path;
      const base = t.git.reviewBase || t.git.base;
      return { path: file, before: c.status === 'A' ? null : await G.showFile(cwd, base, file), after: c.status === 'D' ? null : await G.showFile(cwd, t.git.head, file) };
    }
    // 直接改：第一次改动之前 → 最后一次改动之后
    const ids = c.ids || [c.id];
    const first = this.host.ws.change(ids[0]);
    const last = this.host.ws.change(ids.at(-1));
    return { path: file, before: first.before, after: last.after };
  }
}
