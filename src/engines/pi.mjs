// Agenda 内嵌的 pi：模型、会话、权限和资源都由当前空间提供。
import fs from 'node:fs/promises';
import path from 'node:path';
import { t as tr } from '../i18n.mjs';
import { AbortedError, brief } from './proc.mjs';
import { contextOf, usageOf } from './usage-fields.mjs';
import { activityOf, findShell, toolsFor } from './pi/tools.mjs';

export { findShell, insideDir, toolsFor } from './pi/tools.mjs';

process.env.PI_OFFLINE = '1';
process.env.PI_SKIP_VERSION_CHECK = '1';
process.env.PI_TELEMETRY = '0';

export const meta = {
  skills: true, mcp: true,
  id: 'pi', label: 'Pi', kind: 'embedded', vendor: 'pi.dev', defaultName: 'Pi', color: '#0f766e',
  images: true, approvals: true, resume: true, sources: true, sourceRequired: true,
  get models() { return [['', tr('接口默认模型')]]; }, freeModel: true,
  efforts: ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  get capabilities() { return tr('读写共享文件、在共享文件夹内运行命令'); },
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

function imageError(message) {
  if (/\b(?:401|403|408|429|5\d\d)\b|authenticat|unauthori|forbidden|api.?key|network|fetch failed|timeout|timed out|ECONN|ENOTFOUND/i.test(message)) return false;
  return /\b4\d\d\b|image|vision|multimodal|图片/i.test(message);
}

export async function runTurn({
  system, prompt, images = [], onNoImages, model, effort, cwd, access = 'edit', readOnlyDirs = [], signal,
  onDelta, onActivity, onRaw, onApproval, sessionId, conn, agentDir, skills = [], mcp = {}, provider,
}) {
  if (!agentDir) throw new Error(tr('缺少 Pi 数据目录'));
  if (signal?.aborted) throw new AbortedError();
  if (!provider && !conn?.baseUrl?.trim()) throw new Error(tr('这个接口还没有填写地址'));
  if (!provider && !(model || conn.model)) throw new Error(tr('这个接口还没有指定模型（在成员设置或接口设置里填写）'));
  agentDir = path.resolve(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const shell = findShell();
  const tools = toolsFor(access, shell);
  const { createSession } = await import('./pi/sdk.mjs');
  let session;
  const abort = () => { void session.abort(); };
  const name = conn?.name || 'Pi';
  try {
    ({ session } = await createSession({
      cwd, agentDir, sessionId, model, conn, effort, provider, access, readOnlyDirs, tools, shell, system, skills, mcp, signal, onApproval,
    }));
    signal?.addEventListener('abort', abort);
    await session.bindExtensions({});
    let text = '';
    const messages = [];
    const emit = (s) => { text += s; onDelta?.(s); };
    session.subscribe((e) => {
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
      if (signal?.aborted) throw new AbortedError();
      try {
        if (continueAfterTool) await session.agent.continue();
        else await session.prompt(prompt, { images: attachments, expandPromptTemplates: false,
          preflightResult: () => { if (signal?.aborted) abort(); } });
        const last = messages.at(-1);
        if (last?.stopReason === 'error') throw new Error(last.errorMessage || tr('请求失败'));
        break;
      } catch (err) {
        if (signal?.aborted) throw new AbortedError();
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
    if (signal?.aborted) throw new AbortedError();
    if (!text.trim()) throw new Error(tr('{0} 没有返回内容', [name]));
    return { text, sessionId: session.sessionId, usage: usageFrom(messages), model: session.model.id };
  } catch (err) {
    if (signal?.aborted) throw new AbortedError();
    throw err;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (session) {
      try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); }
      finally { session.dispose(); }
    }
  }
}
