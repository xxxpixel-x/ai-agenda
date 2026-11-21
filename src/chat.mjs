// 聊天：轮流发言的调度、单次发言（含会话续接）和运行命令前的审批。
// 发言规则：依次发言（同一时间只有一个 AI 在说话、改文件）；被 @ 的成员优先；
// 所有成员连续表示“没有补充”，或者达到每轮来回上限，就停下来等你。
// 只有一个成员时是单人聊天：你说一句它回一句，不轮流、不限轮次、不认 [跳过] / [结束]。
// 「只问某个人」（userMessage 的 only）：只让这个成员回答，其他人不接话，回答大家照样看得到。
//
// 会话：引擎 meta.resume 的成员一直续接；单人聊天里 meta.privateSessions 的成员也续接（会话只放在 Agenda 自己的地方）。
// 续接时只发上次之后的新消息；单人 / 多人、引擎、型号、档位、设定、权限变了就换新会话，新的长会话先带最近几轮原文。
//
// 依赖的是一个很窄的“宿主”接口（见 space.mjs 的 createChatHost），不直接碰 Space：
//   host.members / messages / memberState / access / maxTurns / allowedPrograms（可写）
//   host.registry / ws / workspacePath / promptView() / assertAllowed()
//   host.track(promise) / emit(ev) / save()
import { t as tr } from './i18n.mjs';
import { randomUUID } from 'node:crypto';
import { systemPrompt, turnPrompt, parseMarkers, mentionsIn, recentStart } from './prompts.mjs';
import { runAgentTurn } from './turn-runner.mjs';
import { importsBackground, briefVersions, resumeNote, resumeOpts } from './imports.mjs';
import { isPreapproved, parseCommand, normalizeAllowed } from './approvals.mjs';

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
// 新开的长会话先带最近几轮原文（更早的等第三批的交接说明和记忆库）
const RECENT_ROUNDS = 3;
// 这些变了，之前的会话就不再适用（续接的会话不会再收到新的系统提示）
const sessionSig = (member, solo, access, asks) => JSON.stringify([solo, member.engine, member.model || '', member.effort || '', member.persona || '', access, asks]);

export class Chat {
  constructor(host) {
    this.host = host;
    this.running = false;
    this.queue = [];
    this.current = null;
    this.approvals = new Map(); // 等你确认的命令：id -> { ap, msg, resolve }
  }

  /** 给界面的发言状态。 */
  get status() {
    return { running: this.running, speaking: this.current?.msg.id || null, queue: this.queue.map((q) => q.memberId) };
  }

  /** 只有一个成员：单人聊天。 */
  get solo() { return this.host.members.length === 1; }

  // ---------- 对外操作 ----------
  /** opts.only：成员 id，只让他回答这一条，其他人不接话。 */
  userMessage(text, attachments = [], { only = null } = {}) {
    const h = this.host;
    text = str(text, 20000);
    if (!text && !attachments.length) throw new Error(tr('消息不能为空'));
    if (only != null && !h.members.some((m) => m.id === only)) throw new Error(tr('没有这个成员'));
    h.assertAllowed();
    const msg = { id: randomUUID(), kind: 'user', name: tr('我'), text, ts: Date.now() };
    if (attachments.length) msg.attachments = attachments;
    if (only && !this.solo) msg.only = only;
    h.messages.push(msg);
    h.emit({ type: 'message', message: msg });
    h.save();

    const mentioned = mentionsIn(text, h.members, null);
    this.turns = 0;
    this.passesInRow = 0;
    if (this.solo || msg.only) {
      // 单人聊天：你说一句它回一句（它正在说时发的，等它说完再回一次）；只问某人：其他人这次都不接话
      const id = msg.only || h.members[0].id;
      this.queue = [{ memberId: id, reason: msg.only ? 'only' : 'turn' }];
      this.onlyQueued = true;
      this.onlyMember = msg.only || null;
    } else if (mentioned.length) {
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
    h.track(this.pump());
    return msg;
  }

  continueDiscussion() {
    if (this.running) return;
    this.host.assertAllowed();
    this.turns = 0;
    this.passesInRow = 0;
    this.onlyQueued = false;
    this.queue = this.rotation({ includeLast: this.host.members.length === 1 });
    this.host.track(this.pump());
  }

  /** 让某个成员发言（点头像旁的“让 TA 说”）。 */
  ask(memberId) {
    if (!this.host.members.some((m) => m.id === memberId)) throw new Error(tr('没有这个成员'));
    this.host.assertAllowed();
    this.queue = [{ memberId, reason: 'mention' }, ...this.queue.filter((q) => q.memberId !== memberId)];
    if (!this.running) { this.turns = 0; this.passesInRow = 0; this.onlyQueued = true; }
    this.emitState();
    this.host.track(this.pump());
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

  /** 软件退出：结束正在进行的发言，不再推送状态。 */
  shutdown() {
    this.stopRequested = true;
    this.queue = [];
    this.current?.controller.abort();
  }

  // ---------- 调度 ----------
  /** 从上一位发言者之后开始，轮一圈。 */
  rotation({ includeLast = false } = {}) {
    const ms = this.host.members;
    const lastAi = [...this.host.messages].reverse().find((m) => m.kind === 'ai' && !m.error);
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
    const n = this.host.members.length;
    let failed = null; // 出错停下的成员名
    try {
      while (!this.stopRequested) {
        if (!this.queue.length) {
          if (this.onlyQueued || n === 1) break;
          if (this.passesInRow >= n) break;
          this.queue = this.rotation();
          if (!this.queue.length) break;
        }
        if (n > 1 && this.turns >= this.host.maxTurns) break;
        const item = this.queue.shift();
        const member = this.host.members.find((m) => m.id === item.memberId);
        if (!member) continue;
        const r = await this.runTurn(member, item.reason);
        this.turns++;
        if (r.error) { failed = member.name; break; } // 出错就停下，等你处理
        if (r.passed || r.done) this.passesInRow++;
        else this.passesInRow = 0;
        if (this.passesInRow >= n) break;
        if (r.mentions.length && !this.onlyMember) {
          // AI 点名了别人：被点名的人接着说（只问某人时不接）
          const rest = this.queue.filter((q) => !r.mentions.includes(q.memberId));
          this.queue = [...r.mentions.map((id) => ({ memberId: id, reason: 'mention' })), ...rest];
        }
        this.emitState();
      }
    } finally {
      this.running = false;
      this.queue = [];
      this.onlyQueued = false;
      this.onlyMember = null;
      this.host.save();
      this.emitState();
      // 这一轮停下了（宿主据此提醒你；你自己点的停止不算）
      this.host.emit({ type: 'round_end', failed, stopped: !!this.stopRequested });
    }
  }

  async runTurn(member, reason) {
    const h = this.host;
    const api = h.registry.isApi(member.engine);
    const state = h.memberState[member.id] || {};
    const imported = state.importId ? state : null; // 接续导入对话的成员
    const solo = h.members.length === 1;
    // 长会话：引擎本来就续接（meta.resume），或者单人聊天里会话能放在 Agenda 自己的地方（meta.privateSessions）
    const longSession = h.registry.supportsResume(member.engine) || (solo && !!h.registry.supportsPrivateSessions?.(member.engine));
    const canResume = longSession || !!imported;
    const outside = h.ws.begin();
    if (outside.length) h.emit({ type: 'files_changed', changes: outside });
    // 「可运行命令」档：能先问的 AI 每条命令先问你；问不了的只能改文件（API 型本来就不能运行命令，不受影响）
    const asks = h.access === 'run' && !api && h.registry.supportsApproval(member.engine);
    const access = h.access === 'run' && !api && !asks ? 'edit' : h.access;
    const sig = sessionSig(member, solo, access, asks);
    const stale = !imported && state.sig !== sig; // 设定变了：换新会话

    const build = (resume) => ({
      system: systemPrompt(h.promptView(), member, { api, access, approvals: asks, solo }) + (resume && imported
        ? `\n${resumeNote(h.messages.find((m) => m.id === imported.importId) || { sourceLabel: member.engineLabel }, h.workspacePath)}\n` : ''),
      prompt: turnPrompt(h.promptView(), member, {
        reason: solo ? 'solo' : reason, api,
        files: api ? h.ws.snapshot() : null,
        since: resume ? state.seen : null,
        recent: !resume && solo && longSession && !imported ? recentStart(h.messages, RECENT_ROUNDS) : null,
        background: importsBackground(h.messages, { from: resume ? state.seen : 0, excludeId: resume ? imported?.importId : null, briefs: resume ? state.briefs || {} : null }),
      }),
    });

    const msg = { id: randomUUID(), kind: 'ai', memberId: member.id, name: member.name, engine: member.engine, text: '', ts: Date.now(), streaming: true, activities: [] };
    const last = h.messages.findLastIndex((m) => m.kind === 'ai' && m.memberId === member.id);
    const images = h.images(h.messages.slice(last + 1).filter((m) => m.kind === 'user').flatMap((m) => m.attachments || []));
    const seen = h.messages.length + 1;
    if (member.model) msg.model = member.model;
    const controller = new AbortController();
    this.current = { msg, controller, member };
    h.messages.push(msg);
    h.emit({ type: 'message', message: msg });
    this.emitState();

    const started = Date.now();
    const result = { passed: false, done: false, mentions: [], error: false };
    const call = (resume) => {
      const { system, prompt } = build(resume);
      return runAgentTurn(h.registry, member, {
        system,
        prompt,
        cwd: h.workspacePath,
        access,
        ...resumeOpts(resume, state),
        keepSession: longSession && !imported, // 新开的会话要留着下次续接
        signal: controller.signal,
        sink: msg,
        images,
        onNoImages: () => h.emit({ type: 'no_images', id: msg.id }),
        ws: h.ws,
        onDelta: (t) => h.emit({ type: 'delta', id: msg.id, text: t }),
        onActivity: (a) => h.emit({ type: 'activity', id: msg.id, activity: a }),
        onApproval: asks ? (req) => this.requestApproval(msg, req, controller.signal) : undefined,
      });
    };

    try {
      const resume = canResume && !!state.sessionId && state.seen != null && !stale;
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
      const mk = parseMarkers(r.text, { markers: !solo });
      msg.text = mk.text;
      msg.passed = mk.passed;
      msg.done = mk.done;
      if (r.model && !member.model) msg.model = r.model;
      result.passed = mk.passed;
      result.done = mk.done;
      result.mentions = mk.passed ? [] : mentionsIn(mk.text, h.members, member.id);
      if (imported && fellBack) {
        delete h.memberState[member.id];
        h.emit({ type: 'notice', level: 'error', text: tr('{0} 接不上导入的原会话了，之后按普通成员发言。', [member.name]) });
      } else if (imported) {
        h.memberState[member.id] = { ...imported, sessionId: r.sessionId || imported.sessionId, fork: false, seen, briefs: briefVersions(h.messages) };
      } else if (canResume) {
        h.memberState[member.id] = { sessionId: r.sessionId, seen, briefs: briefVersions(h.messages), sig };
      } else {
        delete h.memberState[member.id]; // 切回一次性对话（比如单人聊天加了成员）：之前的长会话不再用
      }
    } catch (e) {
      if (e.aborted) {
        msg.interrupted = true;
        msg.text = msg.text.trim();
      } else {
        msg.error = e.message;
        result.error = true;
        h.emit({ type: 'notice', level: 'error', text: `${member.name}：${e.message}` });
      }
      if (!imported) delete h.memberState[member.id]; // 下次开新会话（接续导入对话的保留，下次接着试）
    } finally {
      this.expireApprovals(msg);
      // 就算出错或被打断，它已经改了的文件也要记下来
      const changes = h.ws.commit(member.name, msg.id);
      if (changes.length) {
        msg.changes = changes;
        h.emit({ type: 'files_changed', changes });
      }
      msg.streaming = false;
      msg.durationMs = Date.now() - started;
      this.current = null;
      h.emit({ type: 'message_done', message: msg });
      h.save();
    }
    return result;
  }

  emitState() {
    this.host.emit({ type: 'state', ...this.status });
  }

  // ---------- 命令审批 ----------
  /** AI 想运行命令：放行过的程序直接允许，否则在它的发言里出一张卡片，等你决定。 */
  requestApproval(msg, { command }, signal) {
    command = String(command || '').trim();
    if (isPreapproved(command, this.host.allowedPrograms)) return Promise.resolve({ allow: true });
    if (signal?.aborted) return Promise.resolve({ allow: false });
    const ap = { id: randomUUID().slice(0, 8), command, programs: parseCommand(command).programs, status: 'pending', ts: Date.now() };
    (msg.approvals ||= []).push(ap);
    return new Promise((resolve) => {
      this.approvals.set(ap.id, { ap, msg, resolve });
      signal?.addEventListener('abort', () => this.settleApproval(ap.id, 'cancelled'), { once: true });
      this.host.emit({ type: 'approval', id: msg.id, approval: ap });
    });
  }

  /** decision：allow / always（这些程序以后都不问）/ deny。note：附给 AI 的一句话，同意、拒绝都可以带 */
  decideApproval(id, decision, note) {
    const p = this.approvals.get(id);
    if (!p) throw new Error(tr('这条请求已经处理过了'));
    if (!['allow', 'always', 'deny'].includes(decision)) throw new Error(tr('未知的决定'));
    if (decision === 'always') this.host.allowedPrograms = normalizeAllowed([...this.host.allowedPrograms, ...p.ap.programs]);
    const status = { allow: 'allowed', always: 'always', deny: 'denied' }[decision];
    this.settleApproval(id, status, str(note, 500));
    return p.ap;
  }

  settleApproval(id, status, note = '') {
    const p = this.approvals.get(id);
    if (!p) return;
    this.approvals.delete(id);
    p.ap.status = status;
    if (note) p.ap.note = note;
    this.host.emit({ type: 'approval', id: p.msg.id, approval: p.ap, allowedPrograms: this.host.allowedPrograms });
    this.host.save();
    p.resolve({ allow: status === 'allowed' || status === 'always', note });
  }

  /** 这一轮发言结束了（包括 AI 进程自己退出）：还没处理的卡片作废，不再显示“等你确认” */
  expireApprovals(msg) {
    for (const [id, p] of this.approvals) if (p.msg === msg) this.settleApproval(id, 'cancelled');
  }
}
