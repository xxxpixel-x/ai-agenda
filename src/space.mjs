// 一个“空间”：一组 AI 成员 + 一个共享文件夹 + 一串消息。空间分两类：
//   聊天空间（kind: 'chat'）：自由讨论，输入框发给所有成员，按轮流和 @ 规则发言（chat.mjs）
//   任务空间（kind: 'task'）：围绕一个目标让成员分工干活，输入框只发给协调者（taskrun.mjs），一个空间只做一个任务
// Space 负责数据、保存和事件，并把聊天、任务、导入（imports.mjs）接到一起：它们各自只通过 Space 给的宿主接口读写空间。
import { t as tr, getLanguage } from './i18n.mjs';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Workspace } from './workspace.mjs';
import { ACCESS, attachmentText } from './prompts.mjs';
import { Attachments } from './attachments.mjs';
import { excludeFolder } from './git.mjs';
import { Chat } from './chat.mjs';
import { TaskRun, preflight, cleanupRunFiles, runDir, PLAN_CONFIRM } from './taskrun.mjs';
import { importsBackground, syncBriefs } from './imports.mjs';
import { runAgentTurn } from './turn-runner.mjs';
import { distillSystem, distillPrompt } from './task-prompts.mjs';
import { normalizeAllowed } from './approvals.mjs';
import { normalizeMembers } from './members.mjs';

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
export const KINDS = ['chat', 'task'];
/** 比较两个文件夹是不是同一个（Windows / macOS 不分大小写）。 */
export const folderKey = (p) => {
  const r = path.resolve(p);
  return process.platform === 'linux' ? r : r.toLowerCase();
};

/** 任务在等你：确认计划（含改过的计划）、审查、回答问题、处理失败、合并。 */
export const runNeedsUser = (r) => !!r && !r.closed && (r.status === 'clarifying' || r.status === 'plan_review' || !!r.paused || !!r.hold
  || r.tasks.some((t) => ['review', 'blocked', 'failed'].includes(t.status))
  || (r.status === 'done' && r.mode === 'git' && !r.merged && r.tasks.some((t) => t.status === 'approved')));

export class Space extends EventEmitter {
  constructor(data, { registry, store, dataDir, hooks = {} }) {
    super();
    this.setMaxListeners(100);
    this.data = data;
    this.registry = registry;
    this.store = store;
    this.hooks = hooks; // 跨空间的事：folderLock(space)、folderInUse(path, exceptId)、postToSpace(id, msg)
    this.dir = path.join(dataDir, 'spaces', data.id);
    data.kind = KINDS.includes(data.kind) ? data.kind : 'chat';
    data.memberState ||= {};
    data.allowedPrograms = normalizeAllowed(data.allowedPrograms);
    data.status = 'idle';
    for (const m of data.messages) {
      if (m.streaming && data.kind === 'chat') { m.streaming = false; m.interrupted = true; }
      for (const a of m.approvals || []) if (a.status === 'pending') a.status = 'cancelled';
    }
    this.ws = new Workspace(this.workspacePath, path.join(this.dir, 'history.json'));
    this.attachments = new Attachments(this.dir, (a) => this.checkAttachment(a));
    this.chat = new Chat(this.createChatHost());
    this.importHost = this.createImportHost();
    this.pendingOperations = new Set();
    this.deleting = false;
    this.deleted = false;
    data.runs ||= [];
    this.runHost = this.createRunHost();
    // 任务空间只有一个任务；聊天空间没有任务
    this.run = data.kind === 'task' && data.runs[0] ? new TaskRun(this.runHost, data.runs[0]) : null;
  }

  get isTask() { return this.data.kind === 'task'; }
  /** 结束了的任务空间：只读，留作记录。 */
  get finished() { return this.isTask && !!this.run?.data.closed; }
  /** 同一个文件夹正被某个任务空间“依次直接改”：这个聊天空间暂时只能读。 */
  get readOnly() { return this.isTask ? null : this.hooks.folderLock?.(this) || null; }

  /** 任务看到的空间：只暴露它需要的这些，不把整个 Space 交出去。 */
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
      get messages() { return space.data.messages; },
      images: (items) => space.attachments.images(items),
      get importBackground() { return importsBackground(space.data.messages); },
      get deleting() { return space.deleting; },
      addMessage: (msg) => {
        space.data.messages.push(msg);
        space.emitEvent({ type: 'message', message: msg });
      },
      messageDone: (msg) => {
        space.emitEvent({ type: 'message_done', message: msg });
        space.save();
      },
      track: (operation) => space.track(operation),
      emit: (ev) => space.emitEvent(ev),
      save: () => space.save(),
    };
  }

  /** 聊天用的宿主接口：chat.mjs 只通过它读写空间，不直接碰 Space。 */
  createChatHost() {
    const space = this;
    return {
      get registry() { return space.registry; },
      get ws() { return space.ws; },
      get workspacePath() { return space.workspacePath; },
      get members() { return space.data.members; },
      get messages() { return space.data.messages; },
      get memberState() { return space.data.memberState; },
      // 文件夹暂时只读时，这一轮发言按“只读”来（聊天照常进行）
      get access() { return space.readOnly ? 'read' : space.data.access; },
      get maxTurns() { return space.data.maxTurns; },
      get allowedPrograms() { return space.data.allowedPrograms; },
      set allowedPrograms(v) { space.data.allowedPrograms = v; },
      images: (items) => space.attachments.images(items),
      promptView: () => space.toJSON(),
      assertAllowed: () => space.assertChatAllowed(),
      track: (operation) => space.track(operation),
      emit: (ev) => space.emitEvent(ev),
      save: () => space.save(),
    };
  }

  /** 导入流程用的宿主接口：imports.mjs 只通过它读写空间，不直接碰 Space。 */
  createImportHost() {
    const space = this;
    return {
      get registry() { return space.registry; },
      get ws() { return space.ws; },
      get workspacePath() { return space.workspacePath; },
      get members() { return space.data.members; },
      set members(v) { space.data.members = v; },
      get messages() { return space.data.messages; },
      set messages(v) { space.data.messages = v; },
      get memberState() { return space.data.memberState; },
      get chatRunning() { return space.running; },
      get importing() { return space.importing; },
      set importing(v) { space.importing = v; },
      get importController() { return space.importController; },
      set importController(v) { space.importController = v; },
      get deleting() { return space.deleting; },
      assertChatAllowed: () => space.assertChatAllowed(),
      snapshot: () => space.toJSON(),
      track: (operation) => space.track(operation),
      emit: (ev) => space.emitEvent(ev),
      save: () => space.save(),
    };
  }

  /**
   * 新建空间。任务空间要另外调用 startTask() 开始规划（要先检查文件夹是不是 git 项目）。
   * input.kind：'chat' | 'task'
   * 任务空间：input.objective、coordinatorId、planConfirm、clarify、discuss、autoApprove、maxParallel、source（{ spaceId, title }，从聊天空间转来时）

   */
  static create(input, deps) {
    const engines = deps.registry.list();
    const id = randomUUID();
    const kind = input.kind === 'task' ? 'task' : 'chat';
    const objective = str(input.objective, 8000);
    if (kind === 'task' && !objective) throw new Error(tr('请写下这次要完成的目标'));
    const members = normalizeMembers(input.members, engines);
    let workspace;
    if (input.workspace?.type === 'folder') {
      const p = str(input.workspace.path, 1000);
      if (!p || !path.isAbsolute(p)) throw new Error(tr('请选择一个文件夹'));
      if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(tr('这个文件夹不存在'));
      workspace = { type: 'folder', path: path.resolve(p) };
    } else {
      workspace = { type: 'managed', path: path.join(deps.dataDir, 'spaces', id, 'files') };
    }
    const title = str(input.title, 60) || (kind === 'task' ? objective.split('\n')[0].replace(/^#+\s*/, '').slice(0, 60) : '') || tr('新的空间');
    const now = Date.now();
    const data = {
      id,
      kind,
      title,
      members,
      workspace,
      access: ACCESS[input.access] ? input.access : 'edit',
      maxTurns: clampInt(input.maxTurns, 1, 30, 6),
      messages: [],
      memberState: {},
      createdAt: now,
      updatedAt: now,
    };
    // 定时任务建出来的空间记住是哪个定时任务建的（侧栏按它分组）
    const scheduleId = str(input.scheduleId, 100);
    if (scheduleId) data.scheduleId = scheduleId;
    if (kind === 'task') {
      const src = input.source && deps.hooks?.spaceTitle?.(input.source.spaceId);
      if (src) data.source = { spaceId: input.source.spaceId, title: src, messages: clampInt(input.source.messages, 0, 9999, 0) };
      data.pendingTask = {
        objective,
        clarify: !input.source && input.clarify !== false,
        coordinatorId: members.some((m) => m.id === input.coordinatorId) ? input.coordinatorId : members[Math.max(0, clampInt(input.coordinatorIndex, 0, members.length - 1, 0))].id,
        planConfirm: PLAN_CONFIRM.includes(input.planConfirm) ? input.planConfirm : 'manual',
        discuss: input.discuss !== false,
        autoApprove: !!input.autoApprove,
        maxParallel: input.maxParallel,
      };
    }
    if (workspace.type === 'managed') {
      fs.mkdirSync(workspace.path, { recursive: true });
      if (kind === 'chat') fs.writeFileSync(path.join(workspace.path, tr('共享文档.md')), `# ${title}\n\n`, 'utf8');
    }
    const space = new Space(data, deps);
    space.save();
    return space;
  }

  /** 任务空间：建好之后直接进入规划，不用再填一遍目标。 */
  async startTask() {
    if (!this.isTask) throw new Error(tr('只有任务空间能开始任务'));
    if (this.run) throw new Error(tr('这个任务空间已经有任务了'));
    const opts = this.data.pendingTask;
    if (!opts) throw new Error(tr('请写下这次要完成的目标'));
    const pre = await preflight(this.runHost);
    if (this.deleting || this.deleted) throw new Error(tr('这个空间正在删除'));
    const run = TaskRun.create(this.runHost, opts, pre);
    delete this.data.pendingTask;
    this.data.runs = [run.data];
    this.run = run;
    this.save();
    this.emitEvent({ type: 'snapshot', space: this.toJSON() });
    this.track(run.plan()); // 后台进行，进度通过事件推送
    return run.publicView();
  }

  get id() { return this.data.id; }
  get workspacePath() { return this.data.workspace.path; }
  get running() { return this.chat.running; }
  get approvals() { return this.chat.approvals; }

  toJSON() {
    const { runs, pendingTask, ...rest } = this.data;
    return {
      ...rest,
      run: this.run ? this.run.publicView() : null,
      workspacePath: this.workspacePath,
      readOnly: this.readOnly,
      ...this.chat.status,
    };
  }

  listItem() {
    const d = this.data;
    const last = [...d.messages].reverse().find((m) => (m.text || m.attachments?.length) && m.kind !== 'import');
    const r = this.run?.data;
    return {
      id: d.id, kind: d.kind, title: d.title, updatedAt: d.updatedAt,
      running: this.running || (!!r && !r.closed && ['planning', 'executing', 'summarizing'].includes(r.status) && !r.paused && !r.hold) || !!this.run?.thinking,
      waiting: this.approvals.size > 0,
      needsYou: runNeedsUser(r),
      finished: !!r?.closed,
      lastAt: last?.ts || null,
      members: d.members.map((m) => ({ name: m.name, color: m.color, engine: m.engine })),
      preview: last ? `${last.kind === 'user' ? tr('我') : last.name}：${(last.text || last.attachments[0].name).slice(0, 40)}` : (r ? r.objective.split('\n')[0].slice(0, 60) : ''),
      workspaceType: d.workspace.type,
      readOnly: !!this.readOnly,
      scheduleId: d.scheduleId || null,
    };
  }

  // ---------- 修改设置 ----------
  update(patch) {
    if (this.running) throw new Error(tr('请先停止当前讨论再修改设置'));
    if (this.finished && Object.keys(patch).some((k) => k !== 'title')) throw new Error(tr('这个任务已经结束，只能改名字'));
    if (this.run?.active && 'members' in patch) throw new Error(tr('任务进行中，不能修改成员'));
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
    // 任务空间的选项：计划确认方式、审阅计划、自动通过、最多同时几个、协调者
    if (this.run && patch.task) this.run.updateSettings(patch.task);
    this.save();
    this.emitEvent({ type: 'snapshot', space: this.toJSON() });
  }

  /** 换某个成员的型号 / 思考档位：讨论进行中也可以，下一次发言生效。 */
  updateMember(memberId, patch = {}) {
    if (this.finished) throw new Error(tr('这个任务已经结束，只能查看'));
    const i = this.data.members.findIndex((m) => m.id === memberId);
    if (i < 0) throw new Error(tr('没有这个成员'));
    const next = this.data.members.map((m, k) => (k === i ? { ...m, model: patch.model ?? m.model, effort: patch.effort ?? m.effort } : m));
    this.data.members = normalizeMembers(next, this.registry.list());
    this.save();
    this.emitEvent({ type: 'members', members: this.data.members });
    return this.data.members[i];
  }

  // ---------- 对外操作 ----------
  assertChatAllowed() {
    if (this.isTask) throw new Error(tr('任务空间的消息只发给协调者'));
    if (this.importing) throw new Error(tr('正在整理导入的对话，稍等一下'));
  }

  /** 输入框：聊天空间发给所有成员（opts.only：只问这个成员）；任务空间只发给协调者。 */
  userMessage(text, ids = [], opts = {}) {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw new Error(tr('附件列表不合法'));
    if (ids.length) return this.track(this.sendAttachments(text, ids, opts));
    return this.postMessage(text, [], opts);
  }

  postMessage(text, attachments, opts = {}) {
    if (!this.isTask) return this.chat.userMessage(text, attachments, opts);
    if (!this.run) throw new Error(tr('任务还没开始'));
    return this.run.userMessage(text, attachments);
  }

  checkAttachment(a) {
    if (this.deleting || this.deleted) throw new Error(tr('这个空间正在删除'));
    if (this.finished) throw new Error(tr('这个任务已经结束，只能查看'));
    const lock = a.kind === 'file' && this.readOnly;
    if (lock) throw new Error(tr('任务空间「{0}」正在依次修改这个文件夹，现在不能加附件', [lock.title]));
  }

  staged(id) {
    const a = this.attachments.get(id);
    if (a.kind === 'image' && this.data.messages.some((m) => m.attachments?.some((item) => item.id === id)))
      throw new Error(tr('附件已经发送'));
    return a;
  }

  async sendAttachments(text, ids, opts = {}) {
    const items = ids.map((id) => this.staged(id));
    for (const a of items) this.checkAttachment(a);
    if (items.filter((a) => a.kind === 'image').length > 10) throw new Error(tr('每条消息最多 10 张图片'));
    const folder = tr('附件');
    if (items.some((a) => a.kind === 'file')) await excludeFolder(this.workspacePath, folder);

    // Git 查询期间可能又发送、删除或锁定了空间。重新检查后同步复制并发消息。
    const copied = [];
    let msg;
    try {
      const attachments = items.map(({ id }) => {
        const a = this.staged(id);
        this.checkAttachment(a);
        if (a.kind === 'image') return a;
        const file = this.attachments.copyFile(a, this.workspacePath, folder);
        copied.push(file.path);
        return file;
      });
      for (const rel of copied) {
        this.ws.acceptCopy(rel);
        this.hooks.acceptCopy?.(this, rel);
      }
      msg = this.postMessage(text, attachments, opts);
    } catch (e) {
      for (const rel of copied) {
        fs.unlinkSync(this.ws.resolve(rel));
        this.ws.acceptCopy(rel);
        this.hooks.acceptCopy?.(this, rel);
      }
      throw e;
    }
    for (const a of items) if (a.kind === 'file') this.attachments.remove(a);
    if (copied.length) this.emitEvent({ type: 'files_changed', changes: [] });
    return msg;
  }
  continueDiscussion() { this.chat.continueDiscussion(); }
  ask(memberId) { this.chat.ask(memberId); }
  stop() { this.chat.stop(); }
  skip() { this.chat.skip(); }
  decideApproval(id, decision, note) { return this.chat.decideApproval(id, decision, note); }

  /** 选出的消息（转到任务空间时用）。 */
  pickMessages(ids) {
    const want = new Set(Array.isArray(ids) ? ids : []);
    const list = this.data.messages.filter((m) => want.has(m.id) && (m.kind === 'user' || m.kind === 'ai' || m.kind === 'task') && m.text?.trim() && !m.passed);
    if (!list.length) throw new Error(tr('先选几条消息'));
    return list;
  }

  /** 让一个成员把选出的讨论提炼成任务目标（只读，不开会话，你看过、改过再用）。 */
  async distill(ids, memberId) {
    if (this.isTask) throw new Error(tr('只能从聊天空间转到任务空间'));
    const list = this.pickMessages(ids);
    const member = this.data.members.find((m) => m.id === memberId) || this.data.members[0];
    const controller = new AbortController();
    this.distillController = controller;
    try {
      const r = await this.track(runAgentTurn(this.registry, member, {
        system: distillSystem(member), prompt: distillPrompt(list), cwd: this.workspacePath, access: 'read', signal: controller.signal, sink: { text: '', activities: [] },
      }));
      return { text: r.text.trim(), by: member.name };
    } finally {
      if (this.distillController === controller) this.distillController = null;
    }
  }

  // ---------- 文件 ----------
  assertWritable() {
    const lock = this.readOnly;
    if (lock) throw new Error(tr('任务空间「{0}」正在依次修改这个文件夹，文件暂时只读', [lock.title]));
    if (this.finished) throw new Error(tr('这个任务已经结束，只能查看'));
  }

  writeFile(rel, content) {
    this.assertWritable();
    const changes = this.ws.write(rel, String(content ?? ''), '我');
    if (changes.length) this.emitEvent({ type: 'files_changed', changes });
    return changes;
  }

  undo(changeId, opts) {
    this.assertWritable();
    if (this.running) throw new Error(tr('讨论进行中，先停止再撤销'));
    const changes = this.ws.undo(changeId, opts);
    if (changes.length) this.emitEvent({ type: 'files_changed', changes });
    return changes;
  }

  // ---------- 任务 ----------
  async taskPreflight() {
    return preflight(this.runHost);
  }

  async runAction(action, body = {}) {
    const run = this.run;
    if (!run) throw new Error(tr('没有进行中的任务'));
    if (run.data.closed) throw new Error(tr('这个任务已经结束，只能查看'));
    const actions = {
      'clarify-answer': () => run.answerClarify(body.answers),
      'clarify-defaults': () => run.useDefaults(),
      'approve-plan': () => run.approvePlan(body.tasks),
      'confirm-plan': () => run.confirmPlan(),
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
      'draft-commit': () => run.draftCommitMessage(),
      merge: () => run.mergeIntoProject(body.message),
      finish: async () => {
        await run.finish();
        let posted = false;
        if (body.postBack && this.data.source) posted = this.postBack();
        this.save();
        this.emitEvent({ type: 'snapshot', space: this.toJSON() });
        return { ok: true, posted };
      },
    };
    if (!actions[action]) throw new Error(tr('未知操作：{0}', [action]));
    const r = await this.track(actions[action]());
    return r ?? { ok: true };
  }

  /** 任务结束：把协调者最后的总结发回原来的聊天空间。 */
  postBack() {
    const run = this.run.data;
    const summary = [...this.data.messages].reverse().find((m) => m.kind === 'summary' && m.text);
    const coord = this.run.coordinator;
    const msg = {
      id: randomUUID(), kind: 'task', ts: Date.now(), name: coord.name, engine: coord.engine,
      taskSpaceId: this.id, title: this.data.title, objective: run.objective.split('\n')[0].slice(0, 120),
      approved: run.tasks.filter((t) => t.status === 'approved').length, total: run.tasks.filter((t) => !t.removed).length,
      merged: run.merged?.branch || null,
      text: summary?.text || tr('（协调者没有写总结）'),
    };
    return !!this.hooks.postToSpace?.(this.data.source.spaceId, msg);
  }

  /** 别的空间发来的消息（任务空间结束时发回的总结）。 */
  receive(msg) {
    if (this.deleting || this.deleted || this.isTask) return false;
    this.data.messages.push(msg);
    this.emitEvent({ type: 'message', message: msg });
    this.save();
    return true;
  }

  // ---------- 其他 ----------
  /**
   * 软件退出：先把眼下的状态存好，再结束这个空间里所有正在运行的 AI（聊天、任务、整理导入）。
   * 之后不再保存：被结束的发言和子任务别记成“被你中止了”，下次打开时按“软件关闭，中断了”恢复。
   */
  shutdown() {
    if (this.closing) return;
    this.save();
    this.closing = true;
    this.chat.shutdown();
    if (this.run) { clearTimeout(this.run.timer); for (const c of this.run.controllers.values()) c.abort(); }
    this.importController?.abort();
  }

  emitEvent(ev) {
    if (this.deleted || this.closing) return;
    this.emit('event', ev);
    if (ev.type === 'files_changed' && ev.changes?.length) syncBriefs(this.importHost, ev.changes); // 主题简报被改了
  }

  save() {
    if (this.deleted || this.closing) return;
    this.data.updatedAt = Date.now();
    try { this.store.save(this.data); } catch (e) { console.error(tr('保存失败：'), e.message); }
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
      this.distillController?.abort();
      this.run?.stopForRemoval();
      // 等发言、任务和导入的收尾写入结束，再删文件，避免后台把空间重新保存出来。
      while (this.pendingOperations.size) await Promise.allSettled([...this.pendingOperations]);
      await removeSpaceFiles(this.data, this.dir, {
        // 软件建的共享文件夹还被别的空间（比如从它转出去的任务空间）用着：先留着
        keepFiles: this.data.workspace.type === 'managed' && !!this.hooks.folderInUse?.(this.workspacePath, this.id),
      });
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
    const lines = [`# ${d.title}`, '', tr('- 成员：{0}', [d.members.map((m) => `${m.name}（${m.engineLabel}）`).join('、')]), tr('- 共享文件夹：{0}', [this.workspacePath])];
    if (this.run) lines.push(tr('- 目标：{0}', [this.run.data.objective.replace(/\s+/g, ' ').slice(0, 300)]));
    lines.push('', '---', '');
    for (const m of d.messages) {
      if (m.passed || (!m.text && !m.changes?.length && !m.attachments?.length)) continue;
      const time = new Date(m.ts).toLocaleString(getLanguage(), { hour12: false });
      const who = m.kind === 'user' ? tr('我') : m.kind === 'summary' ? tr('{0}（总结）', [m.name]) : m.kind === 'task' ? tr('{0}（任务「{1}」的总结）', [m.name, m.title]) : m.name;
      lines.push(`### ${who}　<small>${time}</small>`, '');
      if (m.text || m.attachments?.length) lines.push(attachmentText(m), '');
      if (m.changes?.length) lines.push(tr('> 修改了：{0}', [m.changes.map((c) => c.path).join('、')]), '');
    }
    return lines.join('\n');
  }
}

/**
 * 删掉一个空间的数据：任务的副本和临时分支、空间目录（含软件建的共享文件夹）。
 * 用户自己选的文件夹和里面的文件不动。keepFiles：软件建的共享文件夹还有别的空间在用，先不删它。
 */
export async function removeSpaceFiles(data, dir, { keepFiles = false } = {}) {
  for (const r of data.runs || []) {
    await cleanupRunFiles(r, path.join(dir, 'runs', r.id), { keepIntegration: false }).catch(() => {});
  }
  if (!keepFiles) {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return;
  }
  for (const name of await fs.promises.readdir(dir).catch(() => [])) {
    if (name === 'files') continue;
    await fs.promises.rm(path.join(dir, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export { runDir };
