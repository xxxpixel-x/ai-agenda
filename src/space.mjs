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
import { assertSpaceId, spaceDirectory } from './store.mjs';
import { containsPath, directChild, physicalPath } from './paths.mjs';
import { attachmentText, visible } from './prompts.mjs';
import { assertTaskSpaceAccess, isAccessLevel, resolveTurnAccess } from './access.mjs';
import { Attachments } from './attachments.mjs';
import { excludeFolder } from './git.mjs';
import { Chat } from './chat.mjs';
import { TaskRun, preflight, cleanupRunFiles, runDir, PLAN_CONFIRM } from './taskrun.mjs';
import { syncBriefs } from './imports.mjs';
import { runAgentTurn } from './turn-runner.mjs';
import { distillSystem, distillPrompt } from './task-prompts.mjs';
import { normalizeAllowed } from './approvals.mjs';
import { normalizeMembers } from './members.mjs';
import { openMemory } from './memory/store.mjs';
import { organize, recordPlanDecisions, recordApprovedResults, messageView, isArchivableMessage } from './memory/organize.mjs';

import { handoffSystem, handoffPrompt, budgetFor, contextWindowFor } from './context.mjs';

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
  static memoryAuto = true;
  static memoryDebounceMs = 75_000;
  static memoryMaxWaitMs = 5 * 60_000;
  static memoryMinUserMessages = 2;
  static memoryMinChars = 3000;
  static memoryCompactThreshold = 3;
  static clock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
  };

  constructor(data, { registry, store, dataDir, hooks = {} }) {
    super();
    this.setMaxListeners(100);
    this.data = data;
    this.registry = registry;
    this.store = store;
    this.hooks = hooks; // 跨空间的事：folderLock(space)、folderInUse(path, exceptId)、postToSpace(id, msg)
    this.dir = spaceDirectory(path.join(dataDir, 'spaces'), data.id);
    data.kind = KINDS.includes(data.kind) ? data.kind : 'chat';
    data.memberState = Object.assign(Object.create(null), data.memberState);
    data.recap ||= { text: '', uptoSeq: 0, version: 0, editedByUser: false, updatedAt: null };
    data.memberContext = Object.assign(Object.create(null), data.memberContext);
    data.handoffs = Object.assign(Object.create(null), data.handoffs);
    data.organizeLogs ||= [];
    data.handoffLogs ||= [];
    data.recapTargetSeq ||= 0;
    data.lastCompactedSeq ||= 0;
    if (typeof data.memoryAuto !== 'boolean') data.memoryAuto = true;
    this.pendingHandoffNotes = data.pendingHandoffNotes ||= [];
    this.handoffing = new Set();
    this.handoffJobs = new Map();
    this.handoffControllers = new Set();
    this.memoryTimer = null;
    this.memoryFirstPendingAt = 0;
    data.pendingConfigHandoffs = Object.assign(Object.create(null), data.pendingConfigHandoffs);
    for (const [id, snapshot] of Object.entries(data.pendingConfigHandoffs)) data.memberState[id] ??= snapshot.oldState;
    data.allowedPrograms = normalizeAllowed(data.allowedPrograms);
    data.status = 'idle';
    for (const m of data.messages) {
      if (m.streaming && data.kind === 'chat') { m.streaming = false; m.interrupted = true; }
      for (const a of m.approvals || []) if (a.status === 'pending') a.status = 'cancelled';
    }
    this.numberMessages(); // 旧空间：按顺序补上消息编号
    this.ws = new Workspace(this.workspacePath, path.join(this.dir, 'history.json'));
    this.attachments = new Attachments(this.dir, (a) => this.checkAttachment(a));
    this.chatHost = this.createChatHost();
    this.chat = new Chat(this.chatHost);
    this.importHost = this.createImportHost();
    this.pendingOperations = new Set();
    this.deleting = false;
    this.deleted = false;
    data.runs ||= [];
    this.runHost = this.createRunHost();
    // 任务空间只有一个任务；聊天空间没有任务
    this.run = data.kind === 'task' && data.runs[0] ? new TaskRun(this.runHost, data.runs[0]) : null;
    if (this.run) recordPlanDecisions(this.memory, this.run.data);
    this.memoryHost = this.createMemoryHost();
    this.approvedSeen = this.approvedKey();
    // 重启后按 lastSeq、未完成 recapTargetSeq 与持久化交接便笺补欠账。
    if (this.memoryAutoEnabled && (data.messages.length || data.recapTargetSeq > data.recap.uptoSeq || this.pendingHandoffNotes.length)) {
      const backlog = this.memoryBacklog();
      if (backlog.needsRecap || backlog.hasHandoffs || backlog.meetsThreshold) {
        this.scheduleMemoryOrganize({ immediate: backlog.needsRecap || backlog.hasHandoffs || backlog.hitsBatchCap });
      }
    }
  }

  get isTask() { return this.data.kind === 'task'; }
  /** 结束了的任务空间：只读，留作记录。 */
  get finished() { return this.isTask && !!this.run?.data.closed; }
  /** 同一个文件夹正被某个任务空间“依次直接改”：这个聊天空间暂时只能读。 */
  get readOnly() { return this.isTask ? null : this.hooks.folderLock?.(this) || null; }

  contextOptions(member) {
    const settings = this.registry.settings?.get();
    const providerId = member.source || member.engine.replace(/^openai:/, '');
    return { provider: settings?.providers?.find((p) => p.id === providerId), learnedLimits: settings?.contextLimits };
  }

  contextHost() {
    const space = this;
    return {
      memory: space.memory,
      memoryDir: space.memoryDir,
      contextOptions: (member) => space.contextOptions(member),
      rememberContextLimit: (key, n) => space.registry.settings?.rememberContextLimit?.(key, n),
      recordContext: (id, breakdown) => { space.data.memberContext[id] = { lastTurnAt: Date.now(), breakdown }; },
    };
  }

  /** 任务看到的空间：只暴露它需要的这些，不把整个 Space 交出去。 */
  createRunHost() {
    const space = this;
    return {
      ...this.contextHost(),
      recordApprovedTask: (task) => {
        const rec = recordApprovedResults(space.memory, [task]);
        if (rec.added.length) space.emitEvent({ type: 'memory_changed' });
        return rec;
      },
      recordPlanDecisions: (run) => {
        const before = space.memory.latestId;
        recordPlanDecisions(space.memory, run);
        if (space.memory.latestId > before) space.emitEvent({ type: 'memory_changed' });
      },
      get members() { return space.data.members; },
      get access() { return space.data.access; },
      get workspacePath() { return space.workspacePath; },
      get workspaceType() { return space.data.workspace.type; },
      get dir() { return space.dir; },
      get registry() { return space.registry; },
      get ws() { return space.ws; },
      get messages() { return space.data.messages; },
      images: (items) => space.attachments.images(items),
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
      ...this.contextHost(),
      get recap() { return space.data.recap; },
      rollover: (seq) => space.rollover(seq),
      waitHandoff: (id) => space.handoffJobs.get(id)?.catch(() => {}) || (space.data.pendingConfigHandoffs?.[id]
        ? space.handoffMember(id, 'config_changed', space.data.pendingConfigHandoffs[id]) : null),
      get registry() { return space.registry; },
      get ws() { return space.ws; },
      get workspacePath() { return space.workspacePath; },
      get members() { return space.data.members; },
      get messages() { return space.data.messages; },
      get memberState() { return space.data.memberState; },
      get access() { return space.data.access; },
      get readOnly() { return space.readOnly; },
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

  /** 记忆库整理用的宿主接口：memory/organize.mjs 只通过它读空间（只读）。 */
  createMemoryHost() {
    const space = this;
    return {
      get registry() { return space.registry; },
      get members() { return space.data.members; },
      get workspacePath() { return space.workspacePath; },
      get kind() { return space.data.kind; },
      get access() { return space.data.access; },
      contextOptions: (member) => space.contextOptions(member),
      // 编号大于 since 的消息，按编号排；遇到还在写的就停，免得跳过它
      messages: (since = 0) => {
        const out = [];
        for (const m of [...space.data.messages].sort((a, b) => a.seq - b.seq)) {
          if (!(m.seq > since)) continue;
          if (m.streaming) break;
          out.push(m);
        }
        return out;
      },
      tasks: () => space.run?.data.tasks || [],
    };
  }

  /**
   * 新建空间。任务空间要另外调用 startTask() 开始规划（要先检查文件夹是不是 git 项目）。
   * input.kind：'chat' | 'task'
   * 任务空间：input.objective、coordinatorId、planConfirm、clarify、discuss、autoApprove、maxParallel、source（{ spaceId, title }，从聊天空间转来时）

   */
  static create(input, deps, workspaceOwnerId) {
    const engines = deps.registry.list();
    const id = randomUUID();
    const kind = input.kind === 'task' ? 'task' : 'chat';
    if (kind === 'task') assertTaskSpaceAccess(input.access);
    const objective = str(input.objective, 8000);
    if (kind === 'task' && !objective) throw new Error(tr('请写下这次要完成的目标'));
    const members = normalizeMembers(input.members, engines);
    let workspace;
    if (input.workspace?.type === 'folder') {
      const p = str(input.workspace.path, 1000);
      if (!p || !path.isAbsolute(p)) throw new Error(tr('请选择一个文件夹'));
      if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(tr('这个文件夹不存在'));
      const authorizedPath = deps.hooks?.assertFolderAllowed?.(p, kind === 'task' ? workspaceOwnerId ?? input.source?.spaceId : undefined);
      workspace = { type: 'folder', path: authorizedPath ?? path.resolve(p) };
      if (authorizedPath && kind === 'task' && containsPath(physicalPath(deps.dataDir), authorizedPath)) {
        workspace.managedSpaceId = path.basename(path.dirname(authorizedPath));
      }
    } else {
      workspace = { type: 'managed', path: physicalPath(directChild(spaceDirectory(deps.store.dir, id), 'files')) };
    }
    const title = str(input.title, 60) || (kind === 'task' ? objective.split('\n')[0].replace(/^#+\s*/, '').slice(0, 60) : '') || tr('新的空间');
    const now = Date.now();
    const data = {
      id,
      kind,
      title,
      members,
      workspace,
      access: isAccessLevel(input.access) ? input.access : 'edit',
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
    const { runs, pendingTask, pendingConfigHandoffs, pendingHandoffNotes, ...rest } = this.data;
    return {
      ...rest,
      run: this.run ? this.run.publicView() : null,
      workspacePath: this.workspacePath,
      folderSharedWith: this.data.workspace.type === 'managed' ? this.hooks.folderSharedWith?.(this.workspacePath, this.id) || [] : [],
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
      needsYou: runNeedsUser(r) || this.memoryAskCount > 0,
      memoryAskCount: this.memoryAskCount,
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
    if (this.isTask && patch.access !== this.data.access) assertTaskSpaceAccess(patch.access);
    if (this.running) throw new Error(tr('请先停止当前讨论再修改设置'));
    if (this.finished && Object.keys(patch).some((k) => k !== 'title')) throw new Error(tr('这个任务已经结束，只能改名字'));
    if (this.run?.active && 'members' in patch) throw new Error(tr('任务进行中，不能修改成员'));
    if ('title' in patch) this.data.title = str(patch.title, 60) || this.data.title;
    const previous = this.data.members;
    const oldAccess = this.data.access;
    if ('members' in patch) {
      const next = normalizeMembers(patch.members, this.registry.list());
      this.data.members = next;
    }
    if (isAccessLevel(patch.access) && patch.access !== this.data.access) {
      this.data.access = patch.access;
    }
    this.resetChangedSessions(previous, oldAccess);
    if ('maxTurns' in patch) this.data.maxTurns = clampInt(patch.maxTurns, 1, 30, this.data.maxTurns);
    if ('allowedPrograms' in patch) this.data.allowedPrograms = normalizeAllowed(patch.allowedPrograms);
    // 整理记忆库的成员（不给或已不在空间里：走全局设置或第一个成员）
    if ('memoryWriterId' in patch) {
      if (this.data.members.some((m) => m.id === patch.memoryWriterId)) this.data.memoryWriterId = patch.memoryWriterId;
      else delete this.data.memoryWriterId;
    }
    if (typeof patch.memoryAuto === 'boolean') {
      this.data.memoryAuto = patch.memoryAuto;
      if (!patch.memoryAuto) this.clearMemoryTimer();
    }
    // 任务空间的选项：计划确认方式、审阅计划、自动通过、最多同时几个、协调者
    if (this.run && patch.task) this.run.updateSettings(patch.task);
    this.save();
    this.emitEvent({ type: 'snapshot', space: this.toJSON() });
  }

  resetChangedSessions(previous, oldAccess) {
    for (const old of previous) {
      const state = this.data.memberState[old.id];
      const member = this.data.members.find((m) => m.id === old.id);
      if (!member) { delete this.data.memberState[old.id]; delete this.data.pendingConfigHandoffs[old.id]; continue; }
      if (!state) continue;
      const changed = ['engine', 'source', 'persona', 'model', 'effort'].some((k) => old[k] !== member[k])
        || ['skills', 'mcp'].some((k) => JSON.stringify(old[k] || []) !== JSON.stringify(member[k] || []));
      const soloChanged = (previous.length === 1) !== this.chat.solo;
      if (!(changed || soloChanged || oldAccess !== this.data.access)) continue;
      if (state.importId && old.engine === member.engine && old.source === member.source && !soloChanged) continue;
      if (this.memberBusy(old.id)) continue;
      delete this.data.memberState[old.id];
      if (state.sessionId && !this.handoffing.has(old.id)) this.handoffMember(old.id, 'config_changed', { oldMember: old, oldState: state });
    }
  }

  /** 换某个成员的型号 / 思考档位：讨论进行中也可以，下一次发言生效。 */
  updateMember(memberId, patch = {}) {
    if (this.finished) throw new Error(tr('这个任务已经结束，只能查看'));
    const i = this.data.members.findIndex((m) => m.id === memberId);
    if (i < 0) throw new Error(tr('没有这个成员'));
    const next = this.data.members.map((m, k) => (k === i ? { ...m, model: patch.model ?? m.model, effort: patch.effort ?? m.effort } : m));
    const previous = this.data.members;
    this.data.members = normalizeMembers(next, this.registry.list());
    this.resetChangedSessions(previous, this.data.access);
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
      const { access } = resolveTurnAccess({ spaceKind: this.data.kind, spaceAccess: this.data.access, role: 'distill' });
      const r = await this.track(runAgentTurn(this.registry, member, {
        system: distillSystem(member), prompt: distillPrompt(list), cwd: this.workspacePath, access, signal: controller.signal, sink: { text: '', activities: [] },
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

  writeFile(rel, content, { createOnly = false } = {}) {
    this.assertWritable();
    const changes = this.ws.write(rel, String(content ?? ''), '我', { createOnly });
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

  // ---------- 记忆库 ----------
  get memoryDir() { return path.join(this.dir, 'memory'); }
  get memoryAutoEnabled() { return Space.memoryAuto && this.data.memoryAuto !== false; }
  get memoryAskCount() {
    if (!fs.existsSync(path.join(this.memoryDir, 'entries.jsonl'))) return 0;
    return this.memory.active().filter((e) => e.ask === true).length;
  }

  archiveMessage(msg, { overwrite = false } = {}) {
    if (!msg || !Number.isInteger(msg.seq) || !isArchivableMessage(msg)) return;
    try { this.memory.archive([messageView(msg)], { overwrite }); } catch (e) { console.warn(tr('归档消息失败：'), e.message); }
  }

  archiveSnapshot() {
    const toWrite = [], toOverwrite = [];
    for (const m of this.data.messages) {
      if (!Number.isInteger(m.seq) || !isArchivableMessage(m)) continue;
      if (m.kind === 'import') toOverwrite.push(messageView(m));
      else toWrite.push(messageView(m));
    }
    try {
      if (toWrite.length) this.memory.archive(toWrite);
      if (toOverwrite.length) this.memory.archive(toOverwrite, { overwrite: true });
    } catch (e) { console.warn(tr('归档消息失败：'), e.message); }
  }

  rollover(seq) {
    if (seq <= this.data.recapTargetSeq) return;
    if (seq > this.data.lastCompactedSeq && this.memory.compactableCount() >= Space.memoryCompactThreshold) {
      this.memory.compact();
      this.data.lastCompactedSeq = seq;
    }
    this.data.recapTargetSeq = seq;
    this.save();
    if (this.memoryAutoEnabled) this.scheduleMemoryOrganize({ immediate: true });
  }

  recapView() { return { ...this.data.recap }; }

  updateRecap(text, version) {
    if (typeof text !== 'string') throw Object.assign(new Error(tr('前情提要必须是文本')), { status: 400 });
    if (version !== this.data.recap.version) throw Object.assign(new Error(tr('前情提要已经更新')), { status: 409, recap: this.recapView() });
    Object.assign(this.data.recap, { text: text.trim().slice(0, 50000), version: version + 1, updatedAt: Date.now(), editedByUser: true });
    this.save();
    this.emitEvent({ type: 'recap', recap: this.recapView() });
    return this.recapView();
  }

  memberBusy(id) {
    return this.chat.current?.member.id === id || !!this.run?.data.tasks.some((t) => t.status === 'running' && t.assigneeId === id)
      || [...(this.run?.controllers.values() || [])].some((c) => c.memberId === id);
  }

  sessionMode(m) { return !this.isTask && (this.chat.longSession(m) || !!this.data.memberState[m.id]?.importId); }

  contextView() {
    const members = Object.fromEntries(this.data.members.map((m) => {
      const session = this.sessionMode(m);
      const running = this.memberBusy(m.id) || this.handoffing.has(m.id);
      const saved = this.data.memberContext[m.id];
      const tokenBudget = budgetFor(contextWindowFor(m, this.contextOptions(m)));
      const breakdown = saved?.breakdown ?? (this.run ? this.run.previewContext(m, tokenBudget) : this.chat.buildContext(m, { tokenBudget })).breakdown;
      return [m.id, { mode: session ? 'session' : 'stateless', lastTurnAt: saved?.lastTurnAt || 0,
        canHandoff: session && !running, running, breakdown, handoffs: this.data.handoffs[m.id] || [] }];
    }));
    return { recap: this.recapView(), members };
  }

  getAutoHandoffPct() { return this.registry.settings?.get()?.autoHandoffPct ?? 50; }

  autoHandoff() {
    const pct = this.getAutoHandoffPct();
    if (!pct || this.running || this.isTask || this.deleting || this.closing) return;
    for (const member of this.data.members) {
      if (!this.sessionMode(member) || !this.data.memberState[member.id]?.sessionId) continue;
      const usage = this.data.messages.findLast((m) => m.kind === 'ai' && m.memberId === member.id)?.usage;
      if (usage?.contextUsed > 0 && usage.contextWindow > 0 && usage.contextUsed * 100 >= pct * usage.contextWindow) {
        this.handoffMember(member.id, 'auto');
      }
    }
  }

  async handoffMember(id, reason = 'manual', { oldMember, oldState } = {}) {
    const member = oldMember || this.data.members.find((m) => m.id === id);
    if (!member) throw Object.assign(new Error(tr('没有这个成员')), { status: 404 });
    if (this.memberBusy(id) || this.handoffing.has(id)) {
      if (reason !== 'manual') return null;
      throw Object.assign(new Error(tr('这个成员正在发言，稍后再重开会话')), { status: 409 });
    }
    this.handoffing.add(id);
    const controller = new AbortController();
    this.handoffControllers.add(controller);
    const state = oldState || this.data.memberState[id];
    if (oldState && reason === 'config_changed') this.data.pendingConfigHandoffs[id] = { oldMember, oldState };
    const work = async () => {
      let summary = '';
      const anchorSeq = this.data.messages.at(-1)?.seq || 0;
      if (state?.sessionId) {
        const { access } = resolveTurnAccess({ spaceKind: this.data.kind, spaceAccess: this.data.access, role: 'handoff' });
        const recent = this.data.messages.filter(visible).slice(-6).map((m) => tr('消息 {0}', [m.seq]) + ' · ' + attachmentText(m).slice(0, 500)).join('\n');
        const r = await runAgentTurn(this.registry, member, { system: handoffSystem(), prompt: handoffPrompt(recent), cwd: this.workspacePath,
          access, sessionId: state.sessionId, fork: !!state.fork, resumeAt: state.resumeAt, imported: !!state.importId, keepSession: !state.importId,
          readOnlyDirs: [this.memoryDir], signal: controller.signal, sink: { text: '', activities: [] } });
        controller.signal.throwIfAborted();
        summary = r.text.trim().replace(/^\[(?:无|none)\]$/i, '').slice(0, 3000);
        if (r.usage) {
          this.data.handoffLogs.push({ at: Date.now(), memberId: id, reason, usage: r.usage });
          this.data.handoffLogs.splice(0, Math.max(0, this.data.handoffLogs.length - 100));
        }
      }
      const handoff = { at: Date.now(), reason, summary };
      const history = this.data.handoffs[id] ||= [];
      history.push(handoff);
      if (history.length > 30) history.shift();
      const active = this.data.memberState[id];
      const replacing = !active?.sessionId || active.sessionId === state?.sessionId;
      if (replacing) delete this.data.memberState[id];
      delete this.data.pendingConfigHandoffs[id];
      const current = this.data.members.find((m) => m.id === id);
      if (replacing && current && this.sessionMode(current) && summary) this.data.memberState[id] = { pendingHandoff: summary };
      if (summary) {
        this.pendingHandoffNotes.push({ memberId: id, memberName: member.name, engine: member.engine || '', model: member.model || '', summary, at: handoff.at, anchorSeq });
        if (this.memoryAutoEnabled) this.organizeMemory();
      }
      this.save();
      this.emitEvent({ type: 'handoff', memberId: id, handoff });
      return handoff;
    };
    const job = this.track(work().catch((err) => {
      if (oldState && this.data.members.some((m) => m.id === id)) {
        this.data.pendingConfigHandoffs[id] = { oldMember, oldState };
        this.data.memberState[id] ??= oldState;
      }
      this.save();
      if (reason === 'manual') throw err;
      if (!controller.signal.aborted) console.warn(tr('会话交接失败：{0}', [err.message]));
      return null;
    }).finally(() => {
      this.handoffControllers.delete(controller);
      this.handoffing.delete(id);
      this.handoffJobs.delete(id);
    }));
    this.handoffJobs.set(id, job);
    return job;
  }

  get memory() { return (this.memoryStore ||= openMemory(this.memoryDir)); }

  resolveMemoryWriter() {
    if (this.data.memoryWriterId) {
      const explicit = this.data.members.find((m) => m.id === this.data.memoryWriterId);
      if (explicit) return { writer: explicit, source: 'space', error: null };
    }
    const settings = this.registry.settings?.get?.();
    const org = settings?.memoryOrganizer;
    if (org?.engine) {
      const isMock = this.registry.list().some((e) => e.label?.startsWith('演示') || e.label?.startsWith('Demo'));
      if (org.engine === 'gemini') {
        if (!isMock && !settings.gemini?.apiKey) {
          return { writer: null, source: 'global', error: tr('全局记忆整理模型（Gemini API）未配置 API key，请在设置中检查') };
        }
        return { writer: { id: 'global:gemini', name: 'Gemini', engine: 'gemini', model: org.model || '' }, source: 'global', error: null };
      }
      if (org.engine.startsWith('openai:')) {
        const pid = org.engine.slice('openai:'.length);
        const provider = (settings.providers || []).find((p) => p.id === pid);
        if (!provider || (!isMock && !provider.baseUrl?.trim())) {
          return { writer: null, source: 'global', error: tr('全局记忆整理模型指定的接口已失效，请在设置中重新选择') };
        }
        return { writer: { id: `global:${org.engine}`, name: provider.name || 'AI', engine: org.engine, model: org.model || provider.model || '' }, source: 'global', error: null };
      }
      return { writer: null, source: 'global', error: tr('全局记忆整理模型配置无效，请在设置中重新选择') };
    }
    const first = this.data.members[0] || null;
    return { writer: first, source: 'first', error: null };
  }

  get memoryWriter() { return this.resolveMemoryWriter().writer; }

  /** 子任务通过的情况（编号 + 通过时间），用来发现新通过的子任务。 */
  approvedKey() {
    return (this.run?.data.tasks || []).filter((t) => t.status === 'approved').map((t) => `${t.id}@${t.approvedAt}`).join(',');
  }

  memoryBacklog() {
    const msgs = this.memoryHost.messages(this.memory.lastSeq).filter(isArchivableMessage);
    let userCount = 0, chars = 0;
    for (const m of msgs) {
      if (m.kind === 'user') userCount++;
      const view = messageView(m);
      chars += view.text.length + view.changes.join(' ').length;
    }
    const needsRecap = this.data.recapTargetSeq > (this.data.recap?.uptoSeq || 0);
    const hasHandoffs = this.pendingHandoffNotes.length > 0;
    const meetsThreshold = userCount >= Space.memoryMinUserMessages || chars >= Space.memoryMinChars || msgs.length >= 40;
    const hitsBatchCap = msgs.length >= 40 || chars >= 30000;
    return { count: msgs.length, userCount, chars, needsRecap, hasHandoffs, meetsThreshold, hitsBatchCap };
  }

  clearMemoryTimer({ resetPendingAt = true } = {}) {
    if (this.memoryTimer != null) Space.clock.clearTimeout(this.memoryTimer);
    this.memoryTimer = null;
    if (resetPendingAt) this.memoryFirstPendingAt = 0;
  }

  scheduleMemoryOrganize({ immediate = false } = {}) {
    if (this.deleting || this.deleted || this.closing || !this.memoryAutoEnabled) {
      this.clearMemoryTimer();
      return;
    }
    const b = this.memoryBacklog();
    if (immediate || b.needsRecap || b.hasHandoffs || b.hitsBatchCap) {
      this.clearMemoryTimer();
      this.organizeMemory();
      return;
    }
    if (!b.meetsThreshold) return;
    if (Space.memoryDebounceMs <= 0) {
      this.clearMemoryTimer();
      this.organizeMemory();
      return;
    }
    const now = Space.clock.now();
    this.memoryFirstPendingAt ||= now;
    const elapsed = now - this.memoryFirstPendingAt;
    const delay = Math.min(Space.memoryDebounceMs, Math.max(0, Space.memoryMaxWaitMs - elapsed));
    if (this.memoryTimer != null) Space.clock.clearTimeout(this.memoryTimer);
    const timer = Space.clock.setTimeout(() => {
      if (this.memoryTimer !== timer) return;
      this.clearMemoryTimer();
      if (!this.deleting && !this.deleted && !this.closing && this.memoryAutoEnabled) this.organizeMemory();
    }, delay);
    timer?.unref?.();
    this.memoryTimer = timer;
  }

  /**
   * 空闲时把新的聊天和任务结果整理进记忆库：在后台进行，不阻塞下一轮；
   * 正在整理时又来新内容就排到下一次。整理失败只记日志（memory/organize.jsonl），不影响聊天。
   */
  organizeMemory({ manual = false } = {}) {
    if (this.deleting || this.deleted || this.closing || !this.data.members.length) return null;
    this.clearMemoryTimer();
    const resolved = this.resolveMemoryWriter();
    if (!resolved.writer) {
      const msg = resolved.error || tr('没有可用的记忆整理成员');
      this.memory.log({ at: Date.now(), writerId: null, fromSeq: this.memory.lastSeq, toSeq: this.memory.lastSeq, added: [], rejected: [], notes: [], error: msg });
      this.emitEvent({ type: 'notice', level: 'error', text: msg });
      return null;
    }
    if (this.memoryRun) { this.memoryAgain = true; return this.memoryRun; }
    this.memoryAgain = false;
    const controller = new AbortController();
    this.memoryController = controller;
    const writer = resolved.writer;
    const work = (async () => {
      await new Promise((resolve) => setImmediate(resolve));
      let next = false;
      try {
        const recap = { ...this.data.recap, targetSeq: this.data.recapTargetSeq };
        const handoffs = this.pendingHandoffNotes.slice();
        const r = await organize(this.memoryHost, this.memory, { writer, signal: controller.signal, recap, handoffs });
        if (controller.signal.aborted) return;
        next = !!r.more && !r.error;
        if (!r.skipped) {
          const log = this.recordOrganizerRun(r, recap.uptoSeq);
          if (!r.error) this.pendingHandoffNotes.splice(0, handoffs.length);
          if (r.recapText && this.data.recap.version === recap.version) {
            Object.assign(this.data.recap, { text: [recap.text, r.recapText].filter(Boolean).join('\n\n'),
              uptoSeq: r.recapUptoSeq, version: recap.version + 1, updatedAt: Date.now() });
            this.emitEvent({ type: 'recap', recap: this.recapView() });
          } else if (r.recapText) log.note = tr('前情提要已经更新');
          this.save();
          if (r.added.length || manual) this.emitEvent({ type: 'memory_changed' });
        } else if (r.added.length) {
          this.emitEvent({ type: 'memory_changed' });
        }
      } catch (e) {
        if (e.organizeRecord && !controller.signal.aborted) {
          this.recordOrganizerRun(e.organizeRecord, this.data.recap.uptoSeq);
          this.save();
        }
        if (!e.aborted) console.warn(tr('整理记忆库失败：'), e.message);
      } finally {
        this.memoryRun = null;
        this.memoryController = null;
      }
      if ((next || this.memoryAgain) && !controller.signal.aborted) this.organizeMemory();
    })();
    this.memoryRun = this.track(work);
    return this.memoryRun;
  }

  recordOrganizerRun(record, uptoSeq) {
    const log = { at: record.at, memberId: record.writerId, fromSeq: record.fromSeq, toSeq: record.toSeq,
      recapUptoSeq: record.recapUptoSeq ?? uptoSeq, usage: record.usage ?? null,
      ...(record.durationMs != null ? { durationMs: record.durationMs } : {}),
      ...(record.toolCalls != null ? { toolCalls: record.toolCalls } : {}) };
    if (record.error) log.error = record.error;
    this.data.organizeLogs.push(log);
    this.data.organizeLogs.splice(0, Math.max(0, this.data.organizeLogs.length - 100));
    return log;
  }

  /** 面板人工纠偏（程序直写，白名单校验，严守只追加与并发 409）。 */
  applyMemoryAction(entryId, body = {}) {
    if (this.deleting || this.deleted) throw Object.assign(new Error(tr('这个空间正在删除，请稍等')), { status: 409 });
    if (this.finished) throw Object.assign(new Error(tr('这个任务已经结束，不能修改记忆库')), { status: 409 });
    if (!Number.isSafeInteger(entryId) || entryId < 1) throw Object.assign(new Error(tr('条目编号不合法')), { status: 400 });
    const action = typeof body?.action === 'string' ? body.action.trim() : '';
    const ALLOWED_ACTIONS = new Set(['retract', 'edit', 'accept', 'reject', 'answer']);
    const EDITABLE_TYPES = new Set(['decision', 'constraint', 'preference', 'rejected', 'fact', 'question', 'proposal', 'disagreement']);
    const USER_ORIGIN_TYPES = new Set(['decision', 'constraint', 'preference', 'rejected']);
    if (!ALLOWED_ACTIONS.has(action)) throw Object.assign(new Error(tr('不支持的记忆库操作')), { status: 400 });

    const cleanText = (s, max) => typeof s === 'string' ? s.trim().replace(/[\r\n]+/g, ' ').slice(0, max) : '';
    const compact = (s) => cleanText(s, 300).replace(/\s/g, '');
    const entries = this.memory.entries();
    const target = entries.find((e) => e.id === entryId);
    if (!target) throw Object.assign(new Error(tr('条目 #{0} 不存在', [entryId])), { status: 404 });

    if (action === 'retract') {
      if (target.status === 'retracted') throw Object.assign(new Error(tr('这条记忆已经撤回了')), { status: 409 });
      if (target.status !== 'active') throw Object.assign(new Error(tr('这条记忆已失效或已处理，请刷新')), { status: 409 });
      const seqAt = this.data.messages.reduce((n, m) => Math.max(n, Number.isInteger(m.seq) ? m.seq : 0), 0);
      const { control, entry } = this.memory.retract(entryId, { seqAt });
      this.emitEvent({ type: 'memory_changed' });
      return { ok: true, action, control, entry, hadSupersedes: !!(target.supersedes?.length), memory: this.memoryView() };
    }

    if (target.status !== 'active') throw Object.assign(new Error(tr('这条记忆已失效或已处理，请刷新')), { status: 409 });

    const now = Date.now();
    const baseMeta = {
      source: structuredClone(target.source || {}),
      topics: [...(target.topics || [])],
      files: [...(target.files || [])],
      related: [...(target.related || [])],
      ...(target.task ? { task: target.task } : {}),
    };
    const assertNotDup = (next, excludeIds = []) => {
      const excluded = new Set(excludeIds);
      const dup = entries.find((e) => e.status === 'active' && !excluded.has(e.id)
        && e.type === next.type && cleanText(e.scope, 100) === cleanText(next.scope, 100)
        && cleanText(e.task, 100) === cleanText(next.task, 100) && compact(e.text) === compact(next.text));
      if (dup) throw Object.assign(new Error(tr('和 #{0} 重复', [dup.id])), { status: 409 });
    };

    let record;
    if (action === 'edit') {
      if (target.type === 'result') throw Object.assign(new Error(tr('任务结果不支持直接编辑，如需作废请点撤回')), { status: 400 });
      const type = body.type != null && body.type !== '' ? cleanText(body.type, 30) : target.type;
      if (!EDITABLE_TYPES.has(type)) throw Object.assign(new Error(tr('不允许改为该条目类型')), { status: 400 });
      const text = cleanText(body.text, 300);
      if (!text) throw Object.assign(new Error(tr('条目内容为空')), { status: 400 });
      const reason = body.reason !== undefined ? cleanText(body.reason, 200) : cleanText(target.reason, 200);
      record = {
        ...baseMeta,
        type,
        ...(USER_ORIGIN_TYPES.has(type) ? { origin: 'user' } : {}),
        confirmedBy: 'user',
        text,
        ...(reason ? { reason } : {}),
        scope: target.scope || '',
        supersedes: [entryId],
        at: now,
      };
      assertNotDup(record, [entryId]);
    } else if (action === 'accept') {
      if (!['disagreement', 'proposal'].includes(target.type)) throw Object.assign(new Error(tr('只能采纳分歧或提议')), { status: 400 });
      if (target.type === 'disagreement') {
        const proposed = target.proposed || {};
        const type = body.type != null && body.type !== '' ? cleanText(body.type, 30) : (EDITABLE_TYPES.has(proposed.type) ? proposed.type : 'decision');
        if (!EDITABLE_TYPES.has(type)) throw Object.assign(new Error(tr('不允许改为该条目类型')), { status: 400 });
        const text = cleanText(body.text, 300) || cleanText(proposed.text, 300) || target.text;
        if (!text) throw Object.assign(new Error(tr('条目内容为空')), { status: 400 });
        const reason = body.reason !== undefined ? cleanText(body.reason, 200) : cleanText(proposed.reason || target.reason || '', 200);
        const liveConflicts = (target.conflicts || []).filter((cid) => entries.find((e) => e.id === cid)?.status === 'active');
        const firstConflict = liveConflicts.length ? entries.find((e) => e.id === liveConflicts[0]) : null;
        const scope = firstConflict?.scope ?? target.scope ?? '';
        record = {
          ...baseMeta,
          type,
          ...(USER_ORIGIN_TYPES.has(type) ? { origin: 'user' } : {}),
          confirmedBy: 'user',
          text,
          ...(reason ? { reason } : {}),
          scope,
          resolves: [entryId],
          ...(liveConflicts.length ? { supersedes: liveConflicts } : {}),
          at: now,
        };
        assertNotDup(record, [entryId, ...liveConflicts]);
      } else {
        const text = cleanText(body.text, 300) || target.text;
        const reason = body.reason !== undefined ? cleanText(body.reason, 200) : cleanText(target.reason || '', 200);
        record = {
          ...baseMeta,
          type: 'decision',
          origin: 'user',
          confirmedBy: 'user',
          text,
          ...(reason ? { reason } : {}),
          scope: target.scope || '',
          resolves: [entryId],
          at: now,
        };
        assertNotDup(record, [entryId]);
      }
    } else if (action === 'reject') {
      if (!['disagreement', 'proposal'].includes(target.type)) throw Object.assign(new Error(tr('只能驳回分歧或提议')), { status: 400 });
      const text = cleanText(body.text, 300) || cleanText(target.proposed?.text, 300) || target.text;
      const reason = cleanText(body.reason, 200);
      record = {
        ...baseMeta,
        type: 'rejected',
        origin: 'user',
        confirmedBy: 'user',
        text,
        ...(reason ? { reason } : {}),
        scope: target.scope || '',
        resolves: [entryId],
        at: now,
      };
      assertNotDup(record, [entryId]);
    } else if (action === 'answer') {
      if (target.type !== 'question') throw Object.assign(new Error(tr('只能回答问题类型的条目')), { status: 400 });
      const text = cleanText(body.text, 300);
      if (!text) throw Object.assign(new Error(tr('请填写回答内容')), { status: 400 });
      const type = body.type === 'fact' ? 'fact' : 'decision';
      const reason = cleanText(body.reason, 200);
      record = {
        ...baseMeta,
        type,
        ...(type === 'decision' ? { origin: 'user' } : {}),
        confirmedBy: 'user',
        text,
        ...(reason ? { reason } : {}),
        scope: target.scope || '',
        resolves: [entryId],
        at: now,
      };
      assertNotDup(record, [entryId]);
    }

    const [saved] = this.memory.append([record]);
    this.emitEvent({ type: 'memory_changed' });
    return { ok: true, action, entry: saved, memory: this.memoryView() };
  }

  /** 查看记忆库（面板与排查用）。 */
  memoryView() {
    if (this.deleting || this.deleted) throw Object.assign(new Error(tr('这个空间正在删除，请稍等')), { status: 409 });
    const mem = this.memory;
    const resolved = this.resolveMemoryWriter();
    const entries = mem.entries();
    return {
      writerId: resolved.writer?.id || null,
      writerSource: resolved.source,
      organizerError: resolved.error || null,
      memoryAuto: this.data.memoryAuto !== false,
      organizing: !!this.memoryRun,
      lastSeq: mem.lastSeq,
      latestId: mem.latestId,
      compactedAt: mem.compactedAt,
      askCount: entries.filter((e) => e.status === 'active' && e.ask === true).length,
      entries,
      text: mem.render({}),
      logs: mem.logs(20),
    };
  }

  /** 空间自己的事件里，哪些说明有新内容可以整理：聊天一轮结束、任务空间的回复写完、收到任务总结回传、子任务通过。 */
  memoryTrigger(ev) {
    if (ev.type === 'round_end' || (ev.type === 'message_done' && this.isTask && !ev.message?.streaming)
      || (ev.type === 'message' && ev.message?.kind === 'task')) return 'debounced';
    if (ev.type !== 'run') return null;
    const key = this.approvedKey();
    const fresh = key !== this.approvedSeen && key.split(',').some((k) => k && !this.approvedSeen.split(',').includes(k));
    this.approvedSeen = key;
    return fresh ? 'approved' : null;
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
    this.clearMemoryTimer();
    this.memoryController?.abort();
    for (const c of this.handoffControllers) c.abort();
  }

  /**
   * 消息编号 seq：空间内递增、不复用（删掉的消息的编号也不再用）。在这里统一补，聊天、任务、导入都不用管。
   * 只有一条消息时只补这一条；不给时把所有还没编号的按顺序补上（打开旧空间、导入直接改了消息列表时）。
   */
  numberMessages(msg) {
    const d = this.data;
    if (!Number.isInteger(d.nextSeq)) d.nextSeq = d.messages.reduce((n, m) => (Number.isInteger(m.seq) ? Math.max(n, m.seq + 1) : n), 1);
    for (const m of msg ? [msg] : d.messages) if (!Number.isInteger(m.seq)) m.seq = d.nextSeq++;
  }

  syncRoleLanguage(roleLibrary, lang) {
    const members = this.data.members.filter(m => m.roleId && !m.roleCustomized);
    if (!members.length || this.finished) return { updated: 0, deferred: false };
    if (this.running || this.run?.active) {
      this.pendingRoleSync = { roleLibrary, lang };
      return { updated: 0, deferred: true };
    }
    let updated = 0;
    for (const m of members) {
      const persona = roleLibrary.getRoleInstructions(m.roleId, lang);
      if (persona == null || persona === m.persona) continue;
      m.persona = persona;
      delete this.data.memberState[m.id];
      updated++;
    }
    if (updated) { this.save(); this.emitEvent({ type: 'members', members: this.data.members }); }
    return { updated, deferred: false };
  }

  emitEvent(ev) {
    if (ev.type === 'message' && ev.message) {
      this.numberMessages(ev.message);
      if (!ev.message.streaming) this.archiveMessage(ev.message);
    } else if (ev.type === 'message_done' && ev.message) {
      this.numberMessages(ev.message);
      this.archiveMessage(ev.message);
    } else if (ev.type === 'snapshot') {
      this.numberMessages();
      this.archiveSnapshot();
    }
    if (this.deleted || this.closing) return;
    this.emit('event', ev);
    if (ev.type === 'state' && ev.running) this.clearMemoryTimer({ resetPendingAt: false });
    if (this.pendingRoleSync && (ev.type === 'round_end' || (ev.type === 'run' && this.isTask && !this.run?.active))) {
      const { roleLibrary, lang } = this.pendingRoleSync;
      this.pendingRoleSync = null;
      this.syncRoleLanguage(roleLibrary, lang);
    }
    if (ev.type === 'files_changed' && ev.changes?.length) syncBriefs(this.importHost, ev.changes); // 主题简报被改了
    if (ev.type === 'round_end' && !ev.failed && !ev.stopped) this.autoHandoff();
    const trigger = this.memoryTrigger(ev);
    if (trigger === 'approved') {
      try {
        const rec = recordApprovedResults(this.memory, this.run?.data.tasks || []);
        if (rec.added.length) this.emitEvent({ type: 'memory_changed' });
      } catch (e) { console.warn(tr('写入任务结果到记忆库失败：'), e.message); }
    } else if (trigger === 'debounced' && this.memoryAutoEnabled) {
      this.scheduleMemoryOrganize();
    }
  }

  save() {
    if (this.deleted || this.closing) return;
    this.numberMessages();
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
      this.clearMemoryTimer();
      this.memoryController?.abort();
      for (const c of this.handoffControllers) c.abort();
      this.run?.stopForRemoval();
      // 等发言、任务和导入的收尾写入结束，再删文件，避免后台把空间重新保存出来。
      while (this.pendingOperations.size) await Promise.allSettled([...this.pendingOperations]);
      await removeSpaceFiles(this.data, this.dir, { inUse: p => this.hooks.folderInUse?.(p, this.id) });
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
      if (m.passed || (!m.text && !m.changes?.length && !m.attachments?.length && !m.actions?.length)) continue;
      const time = new Date(m.ts).toLocaleString(getLanguage(), { hour12: false });
      const who = m.kind === 'user' ? tr('我') : m.kind === 'summary' ? tr('{0}（总结）', [m.name]) : m.kind === 'task' ? tr('{0}（任务「{1}」的总结）', [m.name, m.title]) : m.name;
      lines.push(`### ${who}　<small>${time}</small>`, '');
      if (m.text || m.attachments?.length) lines.push(attachmentText(m), '');
      if (m.actions?.length) lines.push(tr('> 运行了：{0}', [m.actions.join(tr('、'))]), '');
      if (m.changes?.length) lines.push(tr('> 修改了：{0}', [m.changes.map((c) => c.path).join('、')]), '');
    }
    return lines.join('\n');
  }
}

/**
 * 删掉一个空间的数据：任务的副本和临时分支、空间目录（含软件建的共享文件夹）。
 * 只清理没有被其他空间用作工作区的目录。
 */
export async function removeSpaceFiles(data, dir, { keepFiles = false, inUse = () => false } = {}) {
  if (path.relative(spaceDirectory(path.dirname(dir), data.id), dir) !== '') throw new Error(tr('目录超出了空间的数据范围'));
  const runs = directChild(dir, 'runs');
  // Validate the entire record before the first removal or git cleanup.
  const runDirs = (data.runs ?? []).map(r => {
    assertSpaceId(r?.id);
    const run = directChild(runs, r.id);
    if (r.mode === 'git') {
      const worktrees = [r.git?.intPath, ...r.tasks.map(task => task.git?.path)].filter(Boolean);
      for (const worktree of worktrees) {
        const expected = directChild(run, path.basename(worktree));
        if (!path.isAbsolute(worktree) || path.relative(expected, worktree) !== '') throw new Error(tr('目录超出了空间的数据范围'));
      }
    }
    return run;
  });
  for (const [i, run] of runDirs.entries()) {
    if (!inUse(run)) await cleanupRunFiles(data.runs[i], run, { keepIntegration: false });
  }
  if (!keepFiles && !inUse(dir)) {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return;
  }
  for (const name of ['history.json', 'history.json.tmp', 'attachments', 'memory', 'runs']) {
    const child = path.join(dir, name);
    if (!inUse(child)) await fs.promises.rm(child, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export { runDir };
