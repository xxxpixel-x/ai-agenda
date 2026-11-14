// 一个“空间”：一组 AI 成员 + 一个共享文件夹 + 一串聊天记录。
// Space 负责数据、保存和事件，并把聊天（chat.mjs）、任务协作（taskrun.mjs）、导入（imports.mjs）
// 接到一起：它们各自只通过 Space 给的宿主接口读写空间。
import { t as tr, getLanguage } from './i18n.mjs';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Workspace } from './workspace.mjs';
import { ACCESS } from './prompts.mjs';
import { Chat } from './chat.mjs';
import { TaskRun, preflight, cleanupRunFiles, runDir } from './taskrun.mjs';
import { importsBackground, syncBriefs } from './imports.mjs';
import { normalizeAllowed } from './approvals.mjs';
import { normalizeMembers } from './members.mjs';

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

/** 任务协作在等你：确认计划、审查、回答问题、处理失败、合并。 */
export const runNeedsUser = (r) => !!r && !r.closed && (r.status === 'plan_review' || !!r.paused
  || r.tasks.some((t) => ['review', 'blocked', 'failed'].includes(t.status))
  || (r.status === 'done' && r.mode === 'git' && !r.merged && r.tasks.some((t) => t.status === 'approved')));

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
    this.ws = new Workspace(this.workspacePath, path.join(this.dir, 'history.json'));
    this.chat = new Chat(this.createChatHost());
    this.importHost = this.createImportHost();
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
      get access() { return space.data.access; },
      get maxTurns() { return space.data.maxTurns; },
      get allowedPrograms() { return space.data.allowedPrograms; },
      set allowedPrograms(v) { space.data.allowedPrograms = v; },
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
      if (!p || !path.isAbsolute(p)) throw new Error(tr('请选择一个文件夹'));
      if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(tr('这个文件夹不存在'));
      workspace = { type: 'folder', path: path.resolve(p) };
    } else {
      workspace = { type: 'managed', path: path.join(deps.dataDir, 'spaces', id, 'files') };
    }
    const title = str(input.title, 60) || tr('新的空间');
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
      fs.writeFileSync(path.join(workspace.path, tr('共享文档.md')), `# ${title}\n\n`, 'utf8');
    }
    const space = new Space(data, deps);
    space.save();
    return space;
  }

  get id() { return this.data.id; }
  get workspacePath() { return this.data.workspace.path; }
  get running() { return this.chat.running; }
  get approvals() { return this.chat.approvals; }

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
      ...this.chat.status,
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
      preview: last ? `${last.kind === 'user' ? tr('我') : last.name}：${last.text.slice(0, 40)}` : '',
      workspaceType: d.workspace.type,
    };
  }

  // ---------- 修改设置 ----------
  update(patch) {
    if (this.running) throw new Error(tr('请先停止当前讨论再修改设置'));
    if (this.run?.active && 'members' in patch) throw new Error(tr('任务协作进行中，不能修改成员'));
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
    if (i < 0) throw new Error(tr('没有这个成员'));
    const next = this.data.members.map((m, k) => (k === i ? { ...m, model: patch.model ?? m.model, effort: patch.effort ?? m.effort } : m));
    this.data.members = normalizeMembers(next, this.registry.list());
    this.save();
    this.emitEvent({ type: 'members', members: this.data.members });
    return this.data.members[i];
  }

  // ---------- 对外操作 ----------
  assertChatAllowed() {
    if (this.run?.blocksChat) throw new Error(tr('任务协作进行中，聊天先暂停（避免和正在干活的 AI 冲突）。可以在任务面板里给子任务提意见。'));
    if (this.importing) throw new Error(tr('正在整理导入的对话，稍等一下'));
  }

  userMessage(text) { return this.chat.userMessage(text); }
  continueDiscussion() { this.chat.continueDiscussion(); }
  ask(memberId) { this.chat.ask(memberId); }
  stop() { this.chat.stop(); }
  skip() { this.chat.skip(); }
  decideApproval(id, decision, note) { return this.chat.decideApproval(id, decision, note); }

  // ---------- 文件 ----------
  writeFile(rel, content) {
    const changes = this.ws.write(rel, String(content ?? ''), '我');
    if (changes.length) this.emitEvent({ type: 'files_changed', changes });
    return changes;
  }

  undo(changeId, opts) {
    if (this.running) throw new Error(tr('讨论进行中，先停止再撤销'));
    const changes = this.ws.undo(changeId, opts);
    if (changes.length) this.emitEvent({ type: 'files_changed', changes });
    return changes;
  }

  // ---------- 任务协作 ----------
  async taskPreflight() {
    return preflight(this.runHost);
  }

  async startRun(opts) {
    if (this.running) throw new Error(tr('聊天里的讨论还在进行，先停止'));
    if (this.importing) throw new Error(tr('正在整理导入的对话，稍等一下再开始任务'));
    if (this.run && !this.run.data.closed) throw new Error(tr('还有一个任务没结束'));
    const pre = await preflight(this.runHost);
    if (this.deleting || this.deleted) throw new Error(tr('这个空间正在删除'));
    const run = this.attachRun(TaskRun.create(this.runHost, opts, pre));
    this.data.runs.push(run.data);
    this.run = run;
    this.save();
    this.track(run.plan()); // 后台进行，进度通过事件推送
    return run.publicView();
  }

  async runAction(action, body = {}) {
    const run = this.run;
    if (!run) throw new Error(tr('没有进行中的任务'));
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
    if (!actions[action]) throw new Error(tr('未知操作：{0}', [action]));
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
      text: tr('**任务完成：{0}**（{1}/{2} 个子任务通过）\n\n{3}', [run.data.objective.split('\n')[0].slice(0, 80), done, run.data.tasks.length, s?.text || s?.error || '']),
      activities: [],
    };
    this.data.messages.push(msg);
    this.emitEvent({ type: 'message', message: msg });
    this.save();
  }

  // ---------- 其他 ----------
  /**
   * 软件退出：先把眼下的状态存好，再结束这个空间里所有正在运行的 AI（聊天、任务协作、整理导入）。
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
    const lines = [`# ${d.title}`, '', tr('- 成员：{0}', [d.members.map((m) => `${m.name}（${m.engineLabel}）`).join('、')]), tr('- 共享文件夹：{0}', [this.workspacePath]), '', '---', ''];
    for (const m of d.messages) {
      if (m.passed || (!m.text && !m.changes?.length)) continue;
      const time = new Date(m.ts).toLocaleString(getLanguage(), { hour12: false });
      lines.push(`### ${m.kind === 'user' ? tr('我') : m.name}　<small>${time}</small>`, '');
      if (m.text) lines.push(m.text, '');
      if (m.changes?.length) lines.push(tr('> 修改了：{0}', [m.changes.map((c) => c.path).join('、')]), '');
    }
    return lines.join('\n');
  }
}
