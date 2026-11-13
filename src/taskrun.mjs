// 任务协作（参考 orca 的 Run → Task DAG → Dispatch 模型）：
//   规划：协调者拆子任务 →（可选）其他成员审阅 → 协调者定稿 → 你确认/修改计划
//   执行：依赖都通过的子任务派给负责人；git 项目里每个子任务在独立副本里并行，否则依次直接改
//   审查：子任务做完 → 你看改动对比 → 通过（合并进集成分支）/ 带意见退回重做；需要你决定的问题会停下来问你
//   收尾：协调者写总结 → git 项目可一键合并到你的分支
//
// 依赖的是一个很窄的“宿主”接口（见 space.mjs 的 runHost），不直接碰 Space：
//   host.members / access / workspacePath / workspaceType / dir
//   host.registry / ws / chatRunning / importBackground / deleting / track(promise) / emit(ev) / save()
// 任务结束时发出 'done' 事件，由宿主决定要不要发到聊天里。
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as G from './git.mjs';
import { Workspace } from './workspace.mjs';
import { runAgentTurn } from './turn-runner.mjs';
import { AbortedError } from './engines/proc.mjs';
import { parseMarkers } from './prompts.mjs';
import {
  plannerSystem, plannerPrompt, reviewerSystem, reviewerPrompt, workerSystem, workerPrompt,
  summarySystem, summaryPrompt, extractPlan, normalizePlan, parseReport,
} from './task-prompts.mjs';

const ACTIVE = new Set(['planning', 'plan_review', 'executing', 'summarizing']);
const SATISFIED = new Set(['approved', 'skipped']);
const SETTLED = new Set(['approved', 'skipped', 'cancelled']);
const MAX_LOG = 600;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** 开始前检查：是不是 git 项目、有没有未提交的改动。 */
export async function preflight(host) {
  if (host.workspaceType === 'managed') return { mode: 'direct' };
  const info = await G.repoInfo(host.workspacePath).catch(() => null);
  // 只是碰巧位于用户主目录这种“大仓库”里的子文件夹：不要拿整个主目录建副本
  if (info && path.resolve(info.root).toLowerCase() === path.resolve(os.homedir()).toLowerCase() && path.resolve(host.workspacePath).toLowerCase() !== path.resolve(info.root).toLowerCase()) {
    return { mode: 'direct', note: '这个文件夹位于你用户目录的 git 仓库里，但它本身不是项目根目录，所以按“依次直接改”的方式进行。' };
  }
  if (!info) return { mode: 'direct', gitAvailable: await G.gitAvailable() };
  if (info.noCommits) return { mode: 'direct', note: '这是 git 仓库，但还没有任何提交，所以按“依次直接改”的方式进行。' };
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
    // 往集成分支的合并必须一个接一个：同一个副本里同时跑两个 git merge 会撞上 index.lock
    this.integrationQueue = Promise.resolve();
    this.merging = new Set(); // 正在排队/合并的子任务，防止重复点“通过”
    // 软件重启后恢复：进行中的步骤都算中断
    for (const t of data.tasks) {
      if (t.status === 'running') {
        t.status = 'ready';
        const a = t.attempts.at(-1);
        if (a && !a.endedAt) { a.endedAt = Date.now(); a.error = '软件关闭，这一次中断了'; }
      }
    }
    for (const m of data.planning.messages) if (m.streaming) { m.streaming = false; m.interrupted = true; }
    if (data.status === 'planning') {
      data.status = data.tasks.length ? 'plan_review' : 'failed';
      if (!data.tasks.length) data.error = '软件关闭，规划中断了。请重新开始。';
    }
    if (data.status === 'summarizing') data.status = 'executing';
    if (data.status === 'executing') data.paused = true;
  }

  static create(host, opts, pre) {
    const coordinator = host.members.find((m) => m.id === opts.coordinatorId) || host.members[0];
    const id = randomUUID().slice(0, 8);
    const data = {
      id,
      objective: str(opts.objective, 8000),
      coordinatorId: coordinator.id,
      discuss: opts.discuss !== false && host.members.length > 1,
      maxParallel: Math.min(6, Math.max(1, parseInt(opts.maxParallel, 10) || 3)),
      autoApprove: !!opts.autoApprove,
      mode: pre.mode,
      git: pre.mode === 'git' ? {
        repo: pre.repo,
        sub: path.relative(pre.repo, host.workspacePath),
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
    if (!data.objective) throw new Error('请写下这次要完成的目标');
    return new TaskRun(host, data);
  }

  get id() { return this.data.id; }
  get active() { return ACTIVE.has(this.data.status); }
  get dir() { return runDir(this.host, this.id); }
  member(id) { return this.host.members.find((m) => m.id === id); }
  get coordinator() { return this.member(this.data.coordinatorId) || this.host.members[0]; }
  /** 聊天是否要暂停：规划/总结时协调者在忙；“依次直接改”执行时文件夹正在被改。 */
  get blocksChat() {
    const s = this.data.status;
    return s === 'planning' || s === 'summarizing' || (s === 'executing' && this.data.mode === 'direct');
  }

  // ---------- 对外视图 ----------
  publicView() {
    const d = this.data;
    return {
      ...d,
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
    if (!t) throw new Error('没有这个子任务');
    return t;
  }

  changed() {
    if (this.host.deleting) return;
    this.data.updatedAt = Date.now();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.host.save();
      // 已收起的任务不再推送（否则会把界面上的“新任务”页面又顶回去）
      if (!this.data.closed) this.host.emit({ type: 'run', run: this.publicView() });
    }, 200);
  }

  // ---------- 调用 AI（统一处理流式、日志、文件块） ----------
  async call(member, { system, prompt, cwd, access, key, sink, wsForApi }) {
    if (this.host.deleting) throw new AbortedError();
    const controller = new AbortController();
    this.controllers.set(key, controller);
    try {
      // 任务会开启独立会话：每次调用都附带当前导入背景，包括补导和已采用的简报版本。
      const background = this.host.importBackground;
      const r = await runAgentTurn(this.host.registry, member, {
        system,
        prompt: background ? `${background}\n\n${prompt}` : prompt,
        cwd,
        access,
        signal: controller.signal,
        sink,
        ws: wsForApi,
        maxActivities: 80,
        maxLog: MAX_LOG,
        onDelta: () => this.changed(),
        onActivity: () => this.changed(),
      });
      return r.text;
    } finally {
      this.controllers.delete(key);
    }
  }

  // ---------- 规划 ----------
  async plan({ feedback = [] } = {}) {
    const d = this.data;
    d.status = 'planning';
    d.error = null;
    this.changed();
    const coord = this.coordinator;
    const cwd = this.host.workspacePath;
    const say = async (member, system, prompt) => {
      const msg = { id: randomUUID().slice(0, 10), memberId: member.id, name: member.name, text: '', streaming: true, ts: Date.now(), activities: [] };
      d.planning.messages.push(msg);
      this.changed();
      try {
        msg.text = (await this.call(member, { system, prompt, cwd, access: 'read', key: 'plan', sink: msg })).trim();
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
      let raw = extractPlan(await say(coord, plannerSystem(this.host, d, coord), plannerPrompt(d, { feedback, previous })));
      if (!raw) throw new Error(`${coord.name} 没有给出可识别的计划（需要 JSON 格式）。可以换一个协调者，或点“重新规划”。`);
      let tasks = normalizePlan(raw, this.host.members, coord.id);

      // 第一次规划且开启了“先商量”：其他成员各提一次意见，协调者再定稿
      if (d.discuss && !previous && !feedback.length) {
        const opinions = [];
        for (const m of this.host.members.filter((x) => x.id !== coord.id)) {
          const draft = tasks.map((t) => ({ ...t, assignee: this.member(t.assigneeId)?.name }));
          const text = await say(m, reviewerSystem(this.host, d, m, coord), reviewerPrompt(d, draft));
          const mk = parseMarkers(text.replace('[同意]', '[跳过]'));
          if (!mk.passed && mk.text) opinions.push({ name: m.name, text: mk.text });
        }
        if (opinions.length) {
          const prev = tasks.map((t) => ({ id: t.id, title: t.title, assignee: this.member(t.assigneeId)?.name, deps: t.deps, spec: t.spec }));
          raw = extractPlan(await say(coord, plannerSystem(this.host, d, coord), plannerPrompt(d, { feedback: opinions, previous: prev })));
          if (raw) tasks = normalizePlan(raw, this.host.members, coord.id);
        }
      }
      d.tasks = tasks.map((t) => this.blankTask(t));
      d.status = 'plan_review';
    } catch (e) {
      d.status = d.tasks.length ? 'plan_review' : 'failed';
      d.error = e.aborted ? '规划被取消了' : e.message;
    }
    this.changed();
  }

  blankTask(t) {
    return { ...t, status: 'pending', attempts: [], feedbacks: [], question: null, answer: null, changes: [], git: null };
  }

  replan(feedbackText) {
    if (this.data.status !== 'plan_review' && this.data.status !== 'failed') throw new Error('现在不能重新规划');
    const fb = str(feedbackText, 4000);
    this.host.track(this.plan({ feedback: fb ? [{ name: '我', text: fb }] : [{ name: '我', text: '请重新考虑分工和拆分方式。' }] }));
  }

  /** 你确认（可能改过的）计划后开始执行。 */
  async approvePlan(edited) {
    const d = this.data;
    if (d.status !== 'plan_review') throw new Error('现在不是确认计划的时候');
    if (d.mode === 'direct' && this.host.chatRunning) throw new Error('聊天里的讨论还在进行，先停止它（否则会和子任务同时改文件）');
    if (Array.isArray(edited)) {
      if (!edited.length) throw new Error('计划里至少要有一个子任务');
      d.tasks = normalizePlan(edited, this.host.members, this.coordinator.id).map((t) => this.blankTask(t));
    }
    if (d.mode === 'git') {
      fs.mkdirSync(this.dir, { recursive: true });
      const g = d.git;
      g.baseCommit = await G.headOf(g.repo);
      g.intPath = path.join(this.dir, 'integration');
      if (!fs.existsSync(g.intPath)) await G.addWorktree(g.repo, g.intPath, g.intBranch, g.baseCommit);
    }
    d.status = 'executing';
    d.paused = false;
    this.changed();
    this.tick();
  }

  // ---------- 调度 ----------
  tick() {
    const d = this.data;
    if (this.host.deleting || d.status !== 'executing' || d.paused) return;
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
    if (d.tasks.every((t) => SETTLED.has(t.status))) this.host.track(this.summarize());
    this.changed();
  }

  resume() {
    if (this.data.status !== 'executing') throw new Error('现在不需要继续');
    this.data.paused = false;
    this.tick();
  }

  async dispatch(task, { conflict = null } = {}) {
    const d = this.data;
    const member = this.member(task.assigneeId);
    task.status = 'running';
    const attempt = { id: randomUUID().slice(0, 10), startedAt: Date.now(), text: '', activities: [], log: [], conflict: conflict || undefined };
    task.attempts.push(attempt);
    this.changed();
    if (!member) {
      attempt.error = '负责这个子任务的成员已经不在空间里了，请改派或跳过。';
      attempt.endedAt = Date.now();
      task.status = 'failed';
      return this.tick();
    }

    let cwd;
    let ws = null;
    try {
      if (d.mode === 'git') {
        const g = d.git;
        if (!task.git) {
          const base = await G.headOf(g.intPath); // 含已通过的前置任务
          const wt = path.join(this.dir, task.id);
          const branch = `${g.intBranch}-${task.id.toLowerCase()}`;
          await G.addWorktree(g.repo, wt, branch, base);
          task.git = { path: wt, branch, base, head: base };
        }
        cwd = path.join(task.git.path, g.sub);
        if (this.host.registry.isApi(member.engine)) ws = new Workspace(cwd, path.join(this.dir, `${task.id}-scratch-history.json`));
      } else {
        cwd = this.host.workspacePath;
        const outside = this.host.ws.begin();
        if (outside.length) this.host.emit({ type: 'files_changed', changes: outside });
        if (this.host.registry.isApi(member.engine)) ws = this.host.ws;
      }

      const api = this.host.registry.isApi(member.engine);
      const access = this.host.access === 'read' ? 'edit' : this.host.access;
      const text = await this.call(member, {
        system: workerSystem(this.host, d, task, member, { api, cwd }),
        prompt: workerPrompt(this.host, d, task, { files: ws ? ws.snapshot() : null, conflict }),
        cwd,
        access,
        key: task.id,
        sink: attempt,
        wsForApi: ws,
      });
      const rep = parseReport(text);
      attempt.text = text.trim();
      attempt.report = rep.report;
      attempt.outcome = rep.outcome;
      if (rep.outcome === 'question') { task.question = rep.detail || rep.report.split('\n').at(-1); task.answer = null; }
      if (rep.outcome === 'failed') attempt.error = rep.detail || '它报告没有完成';
    } catch (e) {
      attempt.error = e.aborted ? '被你中止了' : e.message;
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
        if (ch.length) {
          this.host.emit({ type: 'files_changed', changes: ch });
          const known = new Map((task.changes || []).map((c) => [c.path, c]));
          for (const c of ch) known.set(c.path, { ...c, ids: [...(known.get(c.path)?.ids || []), c.id] });
          task.changes = [...known.values()];
        }
      }
    } catch (e) {
      attempt.error = `${attempt.error ? `${attempt.error}；` : ''}记录改动失败：${e.message}`;
    }

    attempt.endedAt = Date.now();
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
    if (t.status !== 'review') throw new Error('这个子任务现在不能通过');
    if (this.merging.has(t.id)) throw new Error('这个子任务正在合并，请稍等');
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
    const r = await G.merge(g.intPath, t.git.branch, `合并 ${t.id} ${t.title}`);
    if (r.ok) return { ok: true };
    if (!r.conflicts.length) throw new Error(`合并进集成分支失败（不是内容冲突）：${r.error || '未知错误'}`);
    // 冲突：把集成分支合进它自己的副本（留下冲突标记），让负责人解决
    const back = await G.merge(t.git.path, g.intBranch, `同步集成分支到 ${t.id}`, { abortOnConflict: false });
    if (!back.ok && !back.conflicts.length) throw new Error(`把集成分支同步到 ${t.id} 的副本失败：${back.error || '未知错误'}`);
    const files = back.ok ? [] : back.conflicts;
    t.feedbacks.push({ ts: Date.now(), text: `合并时和其他已通过的子任务冲突（${(files.length ? files : r.conflicts).join('、')}），请解决冲突。` });
    return { conflict: true, files: files.length ? files : r.conflicts };
  }

  rejectTask(taskId, feedback) {
    const t = this.task(taskId);
    if (!['review', 'failed'].includes(t.status)) throw new Error('这个子任务现在不能退回');
    const text = str(feedback, 4000);
    if (!text) throw new Error('请写下要怎么改');
    this.data.paused = false;
    t.feedbacks.push({ ts: Date.now(), text });
    this.host.track(this.dispatch(t));
  }

  retryTask(taskId) {
    const t = this.task(taskId);
    if (!['failed', 'ready', 'review'].includes(t.status)) throw new Error('这个子任务现在不能重试');
    if (this.data.status !== 'executing') throw new Error('任务不在执行中');
    this.data.paused = false;
    this.host.track(this.dispatch(t));
  }

  answer(taskId, text) {
    const t = this.task(taskId);
    if (t.status !== 'blocked') throw new Error('这个子任务没有在等你回答');
    t.answer = str(text, 4000);
    if (!t.answer) throw new Error('请写下回答');
    this.data.paused = false;
    this.host.track(this.dispatch(t));
  }

  reassign(taskId, memberId) {
    const t = this.task(taskId);
    if (t.status === 'running') throw new Error('先停止这个子任务再改派');
    if (!this.member(memberId)) throw new Error('没有这个成员');
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
    if (this.data.mode !== 'direct') throw new Error('git 模式下没通过的改动本来就不会进入你的项目');
    if (t.status === 'running') throw new Error('先停止这个子任务');
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
      sink.text = (await this.call(coord, { system: summarySystem(this.host, coord), prompt: summaryPrompt(this.host, d), cwd: this.host.workspacePath, access: 'read', key: 'summary', sink })).trim();
    } catch (e) {
      sink.error = e.aborted ? '总结被取消了' : e.message;
    }
    sink.streaming = false;
    d.status = 'done';
    d.finishedAt = Date.now();
    this.emit('done');
    this.changed();
  }

  /** git 模式：把集成分支合并到你当前的分支。 */
  async mergeIntoProject() {
    const d = this.data;
    if (d.mode !== 'git' || d.status !== 'done') throw new Error('现在不能合并');
    const g = d.git;
    const approved = d.tasks.filter((t) => t.status === 'approved');
    if (!approved.length) throw new Error('没有通过审查的子任务，不需要合并');
    const info = await G.repoInfo(g.repo);
    if (info.dirtyTracked) throw new Error(`你的项目（${info.branch} 分支）有 ${info.dirtyTracked} 个文件改了还没提交。请先提交或暂存，再合并。`);
    const r = await G.merge(g.repo, g.intBranch, `Agenda 任务：${d.objective.split('\n')[0].slice(0, 60)}`);
    if (!r.ok && r.conflicts.length) throw new Error(`合并冲突（${r.conflicts.join('、')}）。已放弃这次合并，你的项目没有变化。可以手动合并分支 ${g.intBranch}。`);
    if (!r.ok) throw new Error(`合并失败：${r.error || '未知错误'}。你的项目没有变化，可以稍后再试，或手动合并分支 ${g.intBranch}。`);
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
    this.data.paused = true;
    for (const c of this.controllers.values()) c.abort();
    clearTimeout(this.timer);
  }

  async cancel() {
    const d = this.data;
    for (const c of this.controllers.values()) c.abort();
    for (const t of d.tasks) if (!SETTLED.has(t.status) && t.status !== 'failed') t.status = 'cancelled';
    d.status = 'cancelled';
    d.finishedAt = Date.now();
    await this.cleanup({ keepIntegration: false }).catch((e) => { d.error = `清理副本失败：${e.message}`; });
    this.changed();
  }

  /** 结束这次任务（done / failed 后），收起面板。git 模式下未合并的分支保留。 */
  async close() {
    const d = this.data;
    if (ACTIVE.has(d.status) && d.status !== 'plan_review') throw new Error('任务还在进行，先取消');
    if (d.status === 'plan_review') d.status = 'cancelled';
    d.closed = true;
    if (d.mode === 'git' && !d.merged) await this.cleanup({ keepIntegration: true }).catch(() => {});
    this.changed();
  }

  /** 子任务某个文件改动前后的内容。 */
  async fileDiff(taskId, file) {
    const t = this.task(taskId);
    const c = (t.changes || []).find((x) => x.path === file);
    if (!c) throw new Error('这个子任务没有改这个文件');
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
