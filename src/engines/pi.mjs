// Agenda 内嵌的 pi：模型、会话、权限和资源都由当前空间提供。
import fs from 'node:fs/promises';
import path from 'node:path';
import { t as tr } from '../i18n.mjs';
import { AbortedError, brief, IDLE_MS, stalledError } from './proc.mjs';
import { imageError } from './image-error.mjs';
import { contextOf, usageOf } from './usage-fields.mjs';
import { activityOf, canRunUnconfined, findShell, toolsFor } from './pi/tools.mjs';

export { findShell, insideDir, toolsFor } from './pi/tools.mjs';

process.env.PI_OFFLINE = '1';
process.env.PI_SKIP_VERSION_CHECK = '1';
process.env.PI_TELEMETRY = '0';

export const meta = {
  skills: true, mcp: true, readOnlyDirs: true, noTools: true,
  id: 'pi', label: 'Pi', kind: 'embedded', vendor: 'pi.dev', defaultName: 'Pi', color: '#0f766e',
  images: true, approvals: true, resume: true, sources: true, sourceRequired: true,
  get models() { return [['', tr('接口默认模型')]]; }, freeModel: true,
  efforts: ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  get capabilities() { return tr('读写共享文件。Pi 命令以当前用户权限运行，可访问共享文件夹以外的位置。「可运行命令」档每条命令和可写 MCP 调用均需逐次确认；无审批通道时禁用命令和可写 MCP。'); },
  usage: { tokens: true, context: false, quota: false },
};

export async function detect({ sources = [] } = {}) {
  const names = sources.filter((s) => s.baseUrl?.trim()).map((s) => s.name || s.id);
  return { available: true, ready: !!names.length, note: names.length
    ? tr('Pi 已内置，可用接口：{0}', [names.join(', ')])
    : tr('Pi 已内置，先在「AI 连接」里添加 API 接口') };
}

export function usageFrom(messages) {
  const totals = {};
  let last;
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    last = msg.usage;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      if (Number.isFinite(last?.[key])) totals[key] = (totals[key] || 0) + last[key];
    }
  }
  return usageOf({ ...totals, contextUsed: last && contextOf(last) });
}

export async function runTurn({
  system, prompt, images = [], onNoImages, model, effort, cwd, access = 'edit', readOnlyDirs = [], noTools = false, signal,
  onDelta, onActivity, onRaw, onApproval, sessionId, conn, agentDir, skills = [], mcp = {}, readonlyMcp = [], provider, idleMs = IDLE_MS,
}) {
  if (!agentDir) throw new Error(tr('缺少 Pi 数据目录'));
  if (signal?.aborted) throw new AbortedError();
  if (!provider && !conn?.baseUrl?.trim()) throw new Error(tr('这个接口还没有填写地址'));
  if (!provider && !(model || conn.model)) throw new Error(tr('这个接口还没有指定模型（在成员设置或接口设置里填写）'));
  agentDir = path.resolve(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const shell = noTools ? null : findShell();
  const policy = { readOnlyDirs: noTools ? [] : readOnlyDirs, onApproval: noTools ? undefined : onApproval };
  const tools = noTools ? [] : toolsFor(access, shell, policy);
  if (noTools) { skills = []; mcp = {}; readOnlyDirs = []; }
  else if (!canRunUnconfined(access, policy)) mcp = Object.fromEntries(Object.entries(mcp).filter(([id]) => readonlyMcp.includes(id)));
  const name = conn?.name || 'Pi';
  const controller = new AbortController();
  const stopped = Promise.withResolvers();
  let session;
  let timer;
  let holds = 0;
  let finished = false;
  let stalledErr;
  const abort = async () => {
    try { await session?.abort(); } catch { /* 即使 SDK 无法中止，也要结束这轮等待 */ }
  };
  const stop = () => {
    controller.abort();
    void abort();
    stopped.reject(stalledErr || new AbortedError());
  };
  const touch = () => {
    clearTimeout(timer);
    if (idleMs > 0 && !holds && !finished && !controller.signal.aborted) timer = setTimeout(() => {
      stalledErr = stalledError(name, idleMs);
      stop();
    }, idleMs);
  };
  const checkStopped = () => {
    if (stalledErr) throw stalledErr;
    if (signal?.aborted) throw new AbortedError();
  };
  const approval = onApproval && (async (req) => {
    holds++;
    clearTimeout(timer);
    try { return await onApproval(req); }
    finally { holds--; touch(); }
  });

  async function execute() {
    const { createSession } = await import('./pi/sdk.mjs');
    checkStopped();
    ({ session } = await createSession({
      cwd, agentDir, sessionId, model, conn, effort, provider, access, readOnlyDirs, tools, shell, system, skills, mcp, readonlyMcp,
      signal: controller.signal, onApproval: approval,
    }));
    // 创建期间可能已经超时并跑完了外层 finally；迟到的会话还没有绑定扩展。
    if (finished) { session.dispose(); return; }
    checkStopped();
    await session.bindExtensions({});
    checkStopped();
    let text = '';
    const messages = [];
    const emit = (s) => { text += s; onDelta?.(s); };
    session.subscribe((e) => {
      if (finished || controller.signal.aborted) return;
      touch();
      onRaw?.(JSON.stringify({ type: e.type, tool: e.toolName, role: e.message?.role, update: e.assistantMessageEvent?.type }));
      if (e.type === 'message_start' && e.message.role === 'assistant' && text && !text.endsWith('\n')) emit('\n\n');
      if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') emit(e.assistantMessageEvent.delta);
      if (e.type === 'message_end' && e.message.role === 'assistant') messages.push(e.message);
      if (e.type === 'tool_execution_start') {
        onActivity?.(activityOf(e, cwd));
      }
    });
    const leaf = session.sessionManager.getLeafId();
    let attachments = await Promise.all(images.map(async (i) => ({
      type: 'image', mimeType: i.type, data: await fs.readFile(i.path, 'base64'),
    })));
    let continueAfterTool = false;
    for (;;) {
      checkStopped();
      try {
        if (continueAfterTool) await session.agent.continue();
        else await session.prompt(prompt, { images: attachments, expandPromptTemplates: false,
          preflightResult: () => { if (controller.signal.aborted) void abort(); } });
        checkStopped(); // SDK 中止时也可能带着部分文字正常返回
        const last = messages.at(-1);
        if (last?.stopReason === 'error') throw new Error(last.errorMessage || tr('请求失败'));
        break;
      } catch (err) {
        checkStopped();
        if (!attachments.length || !imageError(err.message)) {
          throw new Error(tr('{0} 请求失败：{1}', [name, brief(err.message)]), { cause: err });
        }
        onNoImages?.();
        session.settingsManager.setBlockImages(true);
        // 有工具已经执行时，从本轮最后一个工具结果继续，保留副作用并避免重复发命令。
        const branch = session.sessionManager.getBranch();
        const turn = branch.slice(branch.findIndex((e) => e.id === leaf) + 1);
        const tool = turn.findLast((e) => e.type === 'message' && e.message.role === 'toolResult');
        await session.navigateTree(tool?.id || leaf, { summarize: false });
        continueAfterTool = !!tool;
        attachments = [];
      }
    }
    if (!text.trim()) throw new Error(tr('{0} 没有返回内容', [name]));
    return { text, sessionId: session.sessionId, usage: usageFrom(messages), model: session.model.id };
  }

  signal?.addEventListener('abort', stop, { once: true });
  touch();
  try {
    return await Promise.race([stopped.promise, execute()]);
  } finally {
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    if (session) {
      let shutdownTimer;
      try {
        await Promise.race([session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }),
          new Promise(resolve => { shutdownTimer = setTimeout(resolve, 3000); })]);
      } finally {
        clearTimeout(shutdownTimer);
        session.dispose();
        checkStopped();
      }
    }
  }
}
