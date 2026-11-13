// 一个“空间”：一组 AI 成员 + 一个共享文件夹 + 一串聊天记录。
// 发言规则：依次发言（同一时间只有一个 AI 在说话、改文件）；被 @ 的成员优先；
// 所有成员连续表示“没有补充”，或者达到每轮来回上限，就停下来等你。
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Workspace } from './workspace.mjs';
import { systemPrompt, turnPrompt, parseMarkers, mentionsIn, ACCESS } from './prompts.mjs';
import { runAgentTurn } from './turn-runner.mjs';
import { TaskRun, preflight, cleanupRunFiles, runDir } from './taskrun.mjs';
import { importsBackground, briefVersions, syncBriefs } from './imports.mjs';
import { isPreapproved, parseCommand, normalizeAllowed } from './approvals.mjs';

const MODEL_RE = /^[a-z0-9._:\-/[\]]{0,100}$/i;
const EFFORTS = ['', 'none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

/** 任务协作在等你：确认计划、审查、回答问题、处理失败、合并。 */
export const runNeedsUser = (r) => !!r && !r.closed && (r.status === 'plan_review' || !!r.paused
  || r.tasks.some((t) => ['review', 'blocked', 'failed'].includes(t.status))
  || (r.status === 'done' && r.mode === 'git' && !r.merged && r.tasks.some((t) => t.status === 'approved')));

export function normalizeMembers(input, engines) {
  const byId = new Map(engines.map((e) => [e.id, e]));
  const names = new Set();
  const list = (Array.isArray(input) ? input : []).slice(0, 8).map((m, i) => {
    const engine = byId.get(m?.engine);
    if (!engine) throw new Error(`第 ${i + 1} 个成员的 AI 类型无效`);
    const name = str(m.name, 20).replace(/[@\s]/g, '') || engine.defaultName;
    if (name === '我') throw new Error('成员不能叫「我」');
    if (names.has(name)) throw new Error(`成员名「${name}」重复了，给它们起不同的名字`);
    names.add(name);
    const model = str(m.model, 100);
    if (!MODEL_RE.test(model)) throw new Error(`成员「${name}」的模型名不合法`);
    return {
      id: typeof m.id === 'string' && /^[a-z0-9-]{4,40}$/i.test(m.id) ? m.id : randomUUID().slice(0, 8),
      name,
      engine: engine.id,
      engineLabel: engine.label,
      model,
      effort: EFFORTS.includes(m.effort) ? m.effort : '',
      persona: str(m.persona, 2000),
      color: /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : engine.color,
    };
  });
  if (!list.length) throw new Error('至少需要一个 AI 成员');
  return list;
}

export class Space extends EventEmitter {
  constructor(data, { registry, store, dataDir }) {
    super();
    this.setMaxListeners(100);
    this.data = data;
    this.registry = registry;
    this.store = store;
    this.dir = path.join(dataDir, 'spaces', data.id);
    data.memberState ||= {};
    data.allowedPrograms = normalizeAllowed(data.allowedPrograms);
    data.status = 'idle';
    for (const m of data.messages) {
      if (m.streaming) { m.streaming = false; m.interrupted = true; }
      for (const a of m.approvals || []) if (a.status === 'pending') a.status = 'cancelled';
    }
    this.approvals = new Map(); // 等你确认的命令：id -> { ap, msg, resolve }
    this.ws = new Workspace(this.workspacePath, path.join(this.dir, 'history.json'));
    this.running = false;
    this.queue = [];
    this.current = null;
    this.pendingOperations = new Set();
    this.deleting = false;
    this.deleted = false;
    data.runs ||= [];
    this.runHost = this.createRunHost();
    const open = data.runs.filter((r) => !r.closed).at(-1);
    this.run = open ? this.attachRun(new TaskRun(this.runHost, open)) : null;
  }

  /** 任务协作看到的空间：只暴露它需要的这些，不把整个 Space 交出去。 */
  createRunHost() {
    const space = this;
    return {
      get members() { return space.data.members; },
      get access() { return space.data.access; },
      get workspacePath() { return space.workspacePath; },
      get workspaceType() { return space.data.workspace.type; },
      get dir() { return space.dir; },
      get registry() { return space.registry; },
      get ws() { return space.ws; },
      get chatRunning() { return space.running; },
      get importBackground() { return importsBackground(space.data.messages); },
      get deleting() { return space.deleting; },
      track: (operation) => space.track(operation),
      emit: (ev) => space.emitEvent(ev),
      save: () => space.save(),
    };
  }

  attachRun(run) {
    run.on('done', () => this.postRunSummary(run));
    return run;
  }

  static create(input, deps) {
    const engines = deps.registry.list();
    const id = randomUUID();
    let workspace;
    if (input.workspace?.type === 'folder') {
      const p = str(input.workspace.path, 1000);
      if (!p || !path.isAbsolute(p)) throw new Error('请选择一个文件夹');
      if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error('这个文件夹不存在');
      workspace = { type: 'folder', path: path.resolve(p) };
    } else {
      workspace = { type: 'managed', path: path.join(deps.dataDir, 'spaces', id, 'files') };
    }
    const title = str(input.title, 60) || '新的空间';
    const now = Date.now();
    const data = {
      id,
      title,
      members: normalizeMembers(input.members, engines),
      workspace,
      access: ACCESS[input.access] ? input.access : 'edit',
      maxTurns: clampInt(input.maxTurns, 1, 30, 6),
      messages: [],
      memberState: {},
      createdAt: now,
      updatedAt: now,
    };
    if (workspace.type === 'managed') {
      fs.mkdirSync(workspace.path, { recursive: true });
      fs.writeFileSync(path.join(workspace.path, '共享文档.md'), `# ${title}\n\n`, 'utf8');
    }
    const space = new Space(data, deps);
    space.save();
    return space;
  }

  get id() { return this.data.id; }
  get workspacePath() { return this.data.workspace.path; }

  toJSON() {
    const { runs, ...rest } = this.data;
    return {
      ...rest,
      run: this.run ? this.run.publicView() : null,
      pastRuns: runs.filter((r) => r.closed).map((r) => ({
        id: r.id, objective: r.objective, status: r.status, mode: r.mode, createdAt: r.createdAt, finishedAt: r.finishedAt,
        tasks: r.tasks.length, approved: r.tasks.filter((t) => t.status === 'approved').length, merged: r.merged,
        branch: r.mode === 'git' && !r.merged && r.tasks.some((t) => t.status === 'approved') ? r.git?.intBranch : null,
      })).reverse(),
      workspacePath: this.workspacePath,
      speaking: this.current?.msg.id || null,
      queue: this.queue.map((q) => q.memberId),
      running: this.running,
    };
  }

  listItem() {
    const d = this.data;
    const last = [...d.messages].reverse().find((m) => m.text);
    return {
      id: d.id, title: d.title, updatedAt: d.updatedAt, running: this.running,
      waiting: this.approvals.size > 0,
      needsYou: runNeedsUser(this.run?.data),
      lastAt: last?.ts || null,
      members: d.members.map((m) => ({ name: m.name, color: m.color })),
      preview: last ? `${last.kind === 'user' ? '我' : last.name}：${last.text.slice(0, 40)}` : '',
      workspaceType: d.workspace.type,
    };
  }

  // ---------- 修改设置 ----------
  update(patch) {
    if (this.running) throw new Error('请先停止当前讨论再修改设置');
    if (this.run?.active && 'members' in patch) throw new Error('任务协作进行中，不能修改成员');
    if ('title' in patch) this.data.title = str(patch.title, 60) || this.data.title;
    if ('members' in patch) {
      const next = normalizeMembers(patch.members, this.registry.list());
      // 成员换了引擎或设定后，之前的会话不再适用（接续导入对话的 Claude 只在换引擎时断开）
      for (const m of next) {
        const old = this.data.members.find((o) => o.id === m.id);
        const imported = !!this.data.memberState[m.id]?.importId;
        if (!old || old.engine !== m.engine || (old.persona !== m.persona && !imported)) delete this.data.memberState[m.id];
      }
      this.data.members = next;
    }
    if ('access' in patch && ACCESS[patch.access] && patch.access !== this.data.access) {
      this.data.access = patch.access;
      // 续接的会话不会再收到系统提示，权限说明换了就开新会话（接续导入对话的 Claude 每次都重发，不用断开）
      for (const [id, st] of Object.entries(this.data.memberState)) if (!st?.importId) delete this.data.memberState[id];
    }
    if ('maxTurns' in patch) this.data.maxTurns = clampInt(patch.maxTurns, 1, 30, this.data.maxTurns);
    if ('allowedPrograms' in patch) this.data.allowedPrograms = normalizeAllowed(patch.allowedPrograms);
    this.save();
    this.emitEvent({ type: 'snapshot', space: this.toJSON() });
  }

  /** 换某个成员的型号 / 思考档位：讨论进行中也可以，下一次发言生效。 */
  updateMember(memberId, patch = {}) {
    const i = this.data.members.findIndex((m) => m.id === memberId);
    if (i < 0) throw new Error('没有这个成员');
    const next = this.data.members.map((m, k) => (k === i ? { ...m, model: patch.model ?? m.model, effort: patch.effort ?? m.effort } : m));
    this.data.members = normalizeMembers(next, this.registry.list());
    this.save();
    this.emitEvent({ type: 'members', members: this.data.members });
    return this.data.members[i];
  }

  // ---------- 对外操作 ----------
  assertChatAllowed() {
    if (this.run?.blocksChat) throw new Error('任务协作进行中，聊天先暂停（避免和正在干活的 AI 冲突）。可以在任务面板里给子任务提意见。');
    if (this.importing) throw new Error('正在整理导入的对话，稍等一下');
  }

  userMessage(text) {
    text = str(text, 20000);
    if (!text) throw new Error('消息不能为空');
    this.assertChatAllowed();
    const msg = { id: randomUUID(), kind: 'user', name: '我', text, ts: Date.now() };
    this.data.messages.push(msg);
    this.emitEvent({ type: 'message', message: msg });
    this.save();

    const mentioned = this.mentionsOfUser(text);
    this.turns = 0;
    this.passesInRow = 0;
    if (mentioned.length) {
      // 点名了：只让被点名的人回应（他们之间再互相 @ 会继续）
      this.queue = [...mentioned.map((id) => ({ memberId: id, reason: 'mention' })), ...(this.running ? this.queue : [])];
      if (!this.running) this.onlyQueued = true;
    } else if (!this.running) {
      this.onlyQueued = false;
      this.queue = this.rotation({ includeLast: true });
    } else {
      this.onlyQueued = false; // 进行中插话：下一位就会看到并回应
    }
    this.emitState();
    this.track(this.pump());
    return msg;
  }

  continueDiscussion() {
    if (this.running) return;
    this.assertChatAllowed();
    this.turns = 0;
    this.passesInRow = 0;
    this.onlyQueued = false;
    this.queue = this.rotation({ includeLast: this.data.members.length === 1 });
    this.track(this.pump());
  }

  /** 让某个成员发言（点头像旁的“让 TA 说”）。 */
  ask(memberId) {
    if (!this.data.members.some((m) => m.id === memberId)) throw new Error('没有这个成员');
    this.assertChatAllowed();
    this.queue = [{ memberId, reason: 'mention' }, ...this.queue.filter((q) => q.memberId !== memberId)];
    if (!this.running) { this.turns = 0; this.passesInRow = 0; this.onlyQueued = true; }
    this.emitState();
    this.track(this.pump());
  }

  stop() {
    this.stopRequested = true;
    this.queue = [];
    this.current?.controller.abort();
    this.emitState();
  }

  skip() {
    this.current?.controller.abort();
  }

  // ---------- 调度 ----------
  mentionsOfUser(text) {
    return mentionsIn(text, this.data.members, null);
  }

  /** 从上一位发言者之后开始，轮一圈。 */
  rotation({ includeLast = false } = {}) {
    const ms = this.data.members;
    const lastAi = [...this.data.messages].reverse().find((m) => m.kind === 'ai' && !m.error);
    const lastIdx = lastAi ? ms.findIndex((m) => m.id === lastAi.memberId) : -1;
    const order = ms.map((_, i) => ms[(lastIdx + 1 + i) % ms.length]);
    const list = includeLast || ms.length === 1 ? order : order.filter((m) => m.id !== lastAi?.memberId);
    return list.map((m) => ({ memberId: m.id, reason: 'turn' }));
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.emitState();
    const n = this.data.members.length;
    try {
      while (!this.stopRequested) {
        if (!this.queue.length) {
          if (this.onlyQueued || n === 1) break;
          if (this.passesInRow >= n) break;
          this.queue = this.rotation();
          if (!this.queue.length) break;
        }
        if (this.turns >= this.data.maxTurns) break;
        const item = this.queue.shift();
        const member = this.data.members.find((m) => m.id === item.memberId);
        if (!member) continue;
        const r = await this.runTurn(member, item.reason);
        this.turns++;
        if (r.error) break;                       // 出错就停下，等你处理
        if (r.passed || r.done) this.passesInRow++;
        else this.passesInRow = 0;
        if (this.passesInRow >= n) break;
        if (r.mentions.length) {
          // AI 点名了别人：被点名的人接着说
          const rest = this.queue.filter((q) => !r.mentions.includes(q.memberId));
          this.queue = [...r.mentions.map((id) => ({ memberId: id, reason: 'mention' })), ...rest];
        }
        this.emitState();
      }
    } finally {
      this.running = false;
      this.queue = [];
      this.onlyQueued = false;
      this.save();
      this.emitState();
    }
  }

  async runTurn(member, reason) {
    const api = this.registry.isApi(member.engine);
    const state = this.data.memberState[member.id] || {};
    const imported = state.importId ? state : null; // 接续导入对话的 Claude
    const canResume = this.registry.supportsResume(member.engine) || !!imported;
    const outside = this.ws.begin();
    if (outside.length) this.emitEvent({ type: 'files_changed', changes: outside });
    // 「可运行命令」档：能先问的 AI 每条命令先问你；问不了的只能改文件（API 型本来就不能运行命令，不受影响）
    const asks = this.data.access === 'run' && !api && this.registry.supportsApproval(member.engine);
    const access = this.data.access === 'run' && !api && !asks ? 'edit' : this.data.access;

    const build = (resume) => ({
      system: systemPrompt(this.toJSON(), member, { api, access, approvals: asks }) + (resume && imported?.note ? `\n${imported.note}\n` : ''),
      prompt: turnPrompt(this.data, member, {
        reason, api,
        files: api ? this.ws.snapshot() : null,
        since: resume ? state.seen : null,
        background: importsBackground(this.data.messages, { from: resume ? state.seen : 0, excludeId: resume ? imported?.importId : null, briefs: resume ? state.briefs || {} : null }),
      }),
    });

    const msg = { id: randomUUID(), kind: 'ai', memberId: member.id, name: member.name, engine: member.engine, text: '', ts: Date.now(), streaming: true, activities: [] };
    if (member.model) msg.model = member.model;
    const controller = new AbortController();
    this.current = { msg, controller, member };
    this.data.messages.push(msg);
    this.emitEvent({ type: 'message', message: msg });
    this.emitState();

    const started = Date.now();
    const result = { passed: false, done: false, mentions: [], error: false };
    const call = (resume) => {
      const { system, prompt } = build(resume);
      return runAgentTurn(this.registry, member, {
        system,
        prompt,
        cwd: this.workspacePath,
        access,
        sessionId: resume ? state.sessionId : undefined,
        fork: resume && !!imported?.fork,
        signal: controller.signal,
        sink: msg,
        ws: this.ws,
        onDelta: (t) => this.emitEvent({ type: 'delta', id: msg.id, text: t }),
        onActivity: (a) => this.emitEvent({ type: 'activity', id: msg.id, activity: a }),
        onApproval: asks ? (req) => this.requestApproval(msg, req, controller.signal) : undefined,
      });
    };

    try {
      const resume = canResume && !!state.sessionId && state.seen != null;
      let r;
      let fellBack = false;
      try {
        r = await call(resume);
      } catch (e) {
        if (!resume || !e.resumeFailed) throw e;
        msg.text = '';
        fellBack = true;
        r = await call(false); // 旧会话失效：开新会话重来
      }
      const mk = parseMarkers(r.text);
      msg.text = mk.text;
      msg.passed = mk.passed;
      msg.done = mk.done;
      if (r.model && !member.model) msg.model = r.model;
      result.passed = mk.passed;
      result.done = mk.done;
      result.mentions = mk.passed ? [] : mentionsIn(mk.text, this.data.members, member.id);
      if (imported && fellBack) {
        delete this.data.memberState[member.id];
        this.emitEvent({ type: 'notice', level: 'error', text: `${member.name} 接不上导入的原会话了，之后按普通成员发言。` });
      } else if (imported) {
        this.data.memberState[member.id] = { ...imported, sessionId: r.sessionId || imported.sessionId, fork: false, seen: this.data.messages.length, briefs: briefVersions(this.data.messages) };
      } else if (canResume) {
        this.data.memberState[member.id] = { sessionId: r.sessionId, seen: this.data.messages.length, briefs: briefVersions(this.data.messages) };
      }
    } catch (e) {
      if (e.aborted) {
        msg.interrupted = true;
        msg.text = msg.text.trim();
      } else {
        msg.error = e.message;
        result.error = true;
        this.emitEvent({ type: 'notice', level: 'error', text: `${member.name}：${e.message}` });
      }
      if (!imported) delete this.data.memberState[member.id]; // 下次开新会话（接续导入对话的保留，下次接着试）
    } finally {
      // 就算出错或被打断，它已经改了的文件也要记下来
      const changes = this.ws.commit(member.name, msg.id);
      if (changes.length) {
        msg.changes = changes;
        this.emitEvent({ type: 'files_changed', changes });
      }
      msg.streaming = false;
      msg.durationMs = Date.now() - started;
      this.current = null;
      this.emitEvent({ type: 'message_done', message: msg });
      this.save();
    }
    return result;
  }

  // ---------- 命令审批 ----------
  /** AI 想运行命令：放行过的程序直接允许，否则在它的发言里出一张卡片，等你决定。 */
  requestApproval(msg, { command }, signal) {
    command = String(command || '').trim();
    if (isPreapproved(command, this.data.allowedPrograms)) return Promise.resolve({ allow: true });
    if (signal?.aborted) return Promise.resolve({ allow: false });
    const ap = { id: randomUUID().slice(0, 8), command, programs: parseCommand(command).programs, status: 'pending', ts: Date.now() };
    (msg.approvals ||= []).push(ap);
    return new Promise((resolve) => {
      this.approvals.set(ap.id, { ap, msg, resolve });
      signal?.addEventListener('abort', () => this.settleApproval(ap.id, 'cancelled'), { once: true });
      this.emitEvent({ type: 'approval', id: msg.id, approval: ap });
    });
  }

  /** decision：allow / always（这些程序以后都不问）/ deny（可附理由） */
  decideApproval(id, decision, reason) {
    const p = this.approvals.get(id);
    if (!p) throw new Error('这条请求已经处理过了');
    if (!['allow', 'always', 'deny'].includes(decision)) throw new Error('未知的决定');
    if (decision === 'always') this.data.allowedPrograms = normalizeAllowed([...this.data.allowedPrograms, ...p.ap.programs]);
    const status = { allow: 'allowed', always: 'always', deny: 'denied' }[decision];
    this.settleApproval(id, status, decision === 'deny' ? str(reason, 500) : '');
    return p.ap;
  }

  settleApproval(id, status, reason = '') {
    const p = this.approvals.get(id);
    if (!p) return;
    this.approvals.delete(id);
    p.ap.status = status;
    if (reason) p.ap.reason = reason;
    this.emitEvent({ type: 'approval', id: p.msg.id, approval: p.ap, allowedPrograms: this.data.allowedPrograms });
    this.save();
    p.resolve({ allow: status === 'allowed' || status === 'always', reason });
  }

  // ---------- 文件 ----------
  writeFile(rel, content) {
    const changes = this.ws.write(rel, String(content ?? ''), '我');
    if (changes.length) this.emitEvent({ type: 'files_changed', changes });
    return changes;
  }

  undo(changeId, opts) {
    if (this.running) throw new Error('讨论进行中，先停止再撤销');
    const changes = this.ws.undo(changeId, opts);
    if (changes.length) this.emitEvent({ type: 'files_changed', changes });
    return changes;
  }

  // ---------- 任务协作 ----------
  async taskPreflight() {
    return preflight(this.runHost);
  }

  async startRun(opts) {
    if (this.running) throw new Error('聊天里的讨论还在进行，先停止');
    if (this.importing) throw new Error('正在整理导入的对话，稍等一下再开始任务');
    if (this.run && !this.run.data.closed) throw new Error('还有一个任务没结束');
    const pre = await preflight(this.runHost);
    if (this.deleting || this.deleted) throw new Error('这个空间正在删除');
    const run = this.attachRun(TaskRun.create(this.runHost, opts, pre));
    this.data.runs.push(run.data);
    this.run = run;
    this.save();
    this.track(run.plan()); // 后台进行，进度通过事件推送
    return run.publicView();
  }

  async runAction(action, body = {}) {
    const run = this.run;
    if (!run) throw new Error('没有进行中的任务');
    const actions = {
      'approve-plan': () => run.approvePlan(body.tasks),
      replan: () => run.replan(body.feedback),
      resume: () => run.resume(),
      'approve-task': () => run.approveTask(body.taskId),
      'reject-task': () => run.rejectTask(body.taskId, body.feedback),
      'retry-task': () => run.retryTask(body.taskId),
      'stop-task': () => run.stopTask(body.taskId),
      'skip-task': () => run.skipTask(body.taskId),
      'undo-task': () => run.undoTask(body.taskId),
      reassign: () => run.reassign(body.taskId, body.memberId),
      answer: () => run.answer(body.taskId, body.answer),
      merge: () => run.mergeIntoProject(),
      cancel: () => run.cancel(),
      close: async () => {
        await run.close();
        this.run = null;
        this.save();
        this.emitEvent({ type: 'snapshot', space: this.toJSON() });
      },
    };
    if (!actions[action]) throw new Error(`未知操作：${action}`);
    const r = await this.track(actions[action]());
    return r ?? { ok: true };
  }

  /** 任务结束后，把协调者的总结也发到聊天里。 */
  postRunSummary(run) {
    if (this.deleting || this.deleted) return;
    const coord = run.coordinator;
    const s = run.data.summary;
    const done = run.data.tasks.filter((t) => t.status === 'approved').length;
    const msg = {
      id: randomUUID(), kind: 'ai', memberId: coord.id, name: coord.name, engine: coord.engine, ts: Date.now(), runId: run.id,
      text: `**任务完成：${run.data.objective.split('\n')[0].slice(0, 80)}**（${done}/${run.data.tasks.length} 个子任务通过）\n\n${s?.text || s?.error || ''}`,
      activities: [],
    };
    this.data.messages.push(msg);
    this.emitEvent({ type: 'message', message: msg });
    this.save();
  }

  // ---------- 其他 ----------
  emitEvent(ev) {
    if (this.deleted) return;
    this.emit('event', ev);
    if (ev.type === 'files_changed' && ev.changes?.length) syncBriefs(this, ev.changes); // 主题简报被改了
  }

  emitState() {
    this.emitEvent({ type: 'state', running: this.running, speaking: this.current?.msg.id || null, queue: this.queue.map((q) => q.memberId) });
  }

  save() {
    if (this.deleted) return;
    this.data.updatedAt = Date.now();
    try { this.store.save(this.data); } catch (e) { console.error('保存失败：', e.message); }
  }

  track(operation) {
    const promise = Promise.resolve(operation);
    this.pendingOperations.add(promise);
    const done = () => this.pendingOperations.delete(promise);
    promise.then(done, done);
    return promise;
  }

  remove() {
    if (!this.removal) this.removal = this.removeData().finally(() => { this.removal = null; });
    return this.removal;
  }

  async removeData() {
    this.deleting = true;
    try {
      this.stop();
      this.importController?.abort();
      this.run?.stopForRemoval();
      // 等发言、任务和导入的收尾写入结束，再删文件，避免后台把空间重新保存出来。
      while (this.pendingOperations.size) await Promise.allSettled([...this.pendingOperations]);
      for (const r of this.data.runs) {
        await cleanupRunFiles(r, runDir(this.runHost, r.id), { keepIntegration: false }).catch(() => {});
      }
      // 软件内的共享文件夹属于这个空间；用户自己的文件夹绝不动。
      await fs.promises.rm(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      this.store.remove(this.id);
      this.deleted = true;
      this.run?.removeAllListeners();
      this.removeAllListeners();
    } finally {
      this.deleting = false;
    }
  }

  toMarkdown() {
    const d = this.data;
    const lines = [`# ${d.title}`, '', `- 成员：${d.members.map((m) => `${m.name}（${m.engineLabel}）`).join('、')}`, `- 共享文件夹：${this.workspacePath}`, '', '---', ''];
    for (const m of d.messages) {
      if (m.passed || (!m.text && !m.changes?.length)) continue;
      const time = new Date(m.ts).toLocaleString('zh-CN', { hour12: false });
      lines.push(`### ${m.kind === 'user' ? '我' : m.name}　<small>${time}</small>`, '');
      if (m.text) lines.push(m.text, '');
      if (m.changes?.length) lines.push(`> 修改了：${m.changes.map((c) => c.path).join('、')}`, '');
    }
    return lines.join('\n');
  }
}
