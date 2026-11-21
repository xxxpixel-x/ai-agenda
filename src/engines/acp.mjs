import os from 'node:os';
import path from 'node:path';
import { channel } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { t as tr } from '../i18n.mjs';
import { AbortedError, brief, findOnPath, isFile, isWin, nodeRunner, relPath, resolveNodeShim, runJsonl } from './proc.mjs';
import { usageOf } from './usage-fields.mjs';

export const meta = {
  id: 'acp', label: 'ACP', kind: 'acp', vendor: 'ACP', defaultName: 'ACP', color: '#6366f1',
  get models() { return [['', tr('默认')]]; },
  freeModel: true, efforts: [],
  get capabilities() { return tr('通过 ACP 协议读写共享文件、运行命令'); },
  approvals: true, usage: { tokens: true, context: false, quota: false },
};

export function splitArgs(input) {
  if (Array.isArray(input)) return input.filter((s) => typeof s === 'string').map((s) => s.trim());
  const args = [];
  let value = '', quote = '', started = false;
  const s = typeof input === 'string' ? input : '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (quote === '"' && c === '\\' && s[i + 1] === '"') { value += '"'; i++; }
      else value += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) args.push(value);
      value = '';
      started = false;
    } else {
      value += c;
      started = true;
    }
  }
  if (started) args.push(value);
  return args;
}

export function formatArgs(args = []) {
  // Close the quotes before any trailing Windows path separator.
  return args.map((s) => s && !/[\s'"]/.test(s) ? s : '"' + s.replace(/"/g, '\\"').replace(/(\\*)$/, '"$1')).join(' ');
}

export function resolveCommand(command, args = []) {
  if (!command) return null;
  let bin;
  if (isFile(command)) bin = path.resolve(command);
  else if (path.basename(command) === command) {
    if (isWin && path.extname(command)) {
      bin = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
        .map((dir) => path.join(dir, command)).find(isFile);
    } else bin = findOnPath(command);
  }
  const argv = splitArgs(args);
  if (!bin) {
    if (command !== 'node') return null;
    const runner = nodeRunner();
    return { ...runner, args: argv, bin: runner.cmd };
  }
  const entry = isWin && resolveNodeShim(bin);
  return entry ? { ...nodeRunner(), args: [entry, ...argv], bin } : { cmd: bin, args: argv, env: {}, bin };
}

export function parseModels(source) {
  const list = Array.isArray(source) ? source : source?.availableModels;
  const models = new Map();
  for (const m of Array.isArray(list) ? list : []) {
    const id = typeof m === 'string' ? m : Array.isArray(m) ? m[0] : m?.modelId || m?.id;
    if (typeof id !== 'string' || !id) continue;
    const label = Array.isArray(m) ? m[1] : m?.name || m?.label;
    models.set(id, typeof label === 'string' && label ? label : id);
  }
  return { models: [...models], defaultModel: source?.currentModelId || '' };
}

const capabilitiesOf = (init) => init?.agentCapabilities || init?.capabilities || {};
export function supportsPermissions(init) {
  const caps = capabilitiesOf(init);
  const p = caps.permissions;
  return p === true || (p !== null && typeof p === 'object' && p.supported !== false && p.request !== false)
    || caps.permissionRequests === true || caps.requestPermission === true || init?.permissions === true;
}
const configKey = (c) => [c.id || '', c.command, JSON.stringify(c.args || [])].join('|');
const runtimeUnverified = new Set();

const initParams = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'agenda', title: 'Agenda', version: '1' },
};
const rpc = (fields) => ({ jsonrpc: '2.0', ...fields });
const methodMissing = () => ({ code: -32601, message: tr('这里不支持这个请求') });
const exitError = ({ code, stderr }) => new Error(tr('ACP 进程已退出（{0}）：{1}', [code ?? '?', brief(stderr, 300)]));

function startTransport(options) {
  if (!isWin) return runJsonl(options);
  // taskkill /T can be denied on managed Windows machines. Retain the
  // direct child handle during this synchronous spawn for a native fallback.
  const spawns = channel('child_process');
  let child;
  const capture = (event) => { child = event.process; };
  spawns.subscribe(capture);
  let running;
  try { running = runJsonl(options); } finally { spawns.unsubscribe(capture); }
  return running.finally(async () => {
    if (!child?.pid || child.exitCode !== null || child.signalCode) return;
    const fallback = setTimeout(() => child.kill(), 300);
    try { await once(child, 'exit'); } finally { clearTimeout(fallback); }
  });
}

// runJsonl exposes its controller on the first incoming line. Send initialize as
// initial input, and use our abort controller even if the child never writes.
async function withAgent(resolved, { cwd, signal, idleMs, onRaw, timeoutMs = 15000, onUpdate, onPermission, cancelSession }, work) {
  if (signal?.aborted) throw new AbortedError();
  const controller = new AbortController();
  const pending = new Map();
  let ctl, closed, nextId = 0;
  function request(method, params, timeout = timeoutMs) {
    if (closed) return Promise.reject(closed);
    const id = ++nextId;
    const response = new Promise((resolve, reject) => {
      const timer = timeout > 0 && setTimeout(() => {
        pending.delete(id);
        reject(new Error(tr('ACP 请求超时：{0}', [method])));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
    });
    ctl?.send(rpc({ id, method, params }));
    return response;
  }
  function close(err) {
    closed = err;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
    pending.clear();
  }
  function onEvent(msg, control) {
    ctl = control;
    if (closed || controller.signal.aborted || msg.jsonrpc !== '2.0') return;
    if (msg.method && msg.id != null) {
      if (['session/request_permission', 'session/requestPermission'].includes(msg.method)) {
        const decision = onPermission ? onPermission(msg.params || {}, ctl) : Promise.resolve({ outcome: { outcome: 'cancelled' } });
        decision.then(
          (result) => { if (!closed) ctl.send(rpc({ id: msg.id, result })); },
          (err) => { if (!closed) ctl.send(rpc({ id: msg.id, error: { code: -32603, message: err.message } })); },
        );
      } else ctl.send(rpc({ id: msg.id, error: methodMissing() }));
    } else if (msg.method) {
      if (['session/update', 'session/updateNotification'].includes(msg.method)) onUpdate?.(msg.params || {});
    } else {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else p.resolve(msg.result);
    }
  }
  const abort = () => {
    const sessionId = cancelSession?.();
    if (sessionId) ctl?.send(rpc({ method: 'session/cancel', params: { sessionId } }));
    controller.abort();
  };
  signal?.addEventListener('abort', abort, { once: true });
  const init = request('initialize', initParams);
  const child = startTransport({
    ...resolved, cwd, keepInput: true, signal: controller.signal, idleMs, onRaw, onEvent,
    input: [rpc({ id: nextId, method: 'initialize', params: initParams })],
  }).then((result) => { close(exitError(result)); return result; }, (err) => { close(err); return { error: err }; });
  try {
    const hello = await init;
    if (hello?.protocolVersion !== 1) throw new Error(tr('不支持的 ACP 协议版本：{0}', [hello?.protocolVersion ?? '?']));
    const value = await work(hello, request);
    ctl.finish();
    const result = await child;
    if (result.error) throw result.error;
    if (!result.finished || result.code) throw exitError(result);
    return { value, stderr: result.stderr };
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!closed) {
      if (ctl) ctl.finish(); else controller.abort();
    }
    await child;
  }
}

export async function detect({ acp, timeoutMs = 15000 } = {}) {
  if (!acp?.command) return { available: false, ready: false, note: tr('请填写启动命令') };
  const resolved = resolveCommand(acp.command, acp.args);
  if (!resolved) return { available: false, ready: false, note: tr('找不到启动命令：{0}', [acp.command]) };
  const base = { available: true, bin: resolved.bin };
  try {
    const { value } = await withAgent(resolved, { timeoutMs, cwd: os.tmpdir() }, async (init, request) => {
      const info = init.agentInfo || {};
      const version = brief(info.version, 40);
      let choices = parseModels(init.models);
      if (!choices.models.length) {
        try {
          const session = await request('session/new', { cwd: os.tmpdir(), mcpServers: [] }, Math.min(5000, timeoutMs));
          if (session?.models) choices = parseModels(session.models);
        } catch (err) {
          if (err.code === -32000 || /auth|login|unauthori|credential|api.?key/i.test(err.message)) {
            return { ...base, ready: false, version, note: brief(err.message, 300) };
          }
          // Model discovery is optional. Transport failures still surface on close.
        }
      }
      const unverifiedPermissions = !supportsPermissions(init) || runtimeUnverified.has(configKey(acp));
      const label = info.title || info.name || acp.name || 'ACP';
      return {
        ...base, ready: true, version, capabilities: capabilitiesOf(init), unverifiedPermissions,
        note: unverifiedPermissions ? tr('ACP 握手成功（{0}）· 这个 AI 的权限无法保证', [label]) : tr('ACP 握手成功（{0}）', [label]),
        ...(choices.models.length ? { models: choices.models } : {}),
        ...(choices.defaultModel ? { defaultModel: choices.defaultModel } : {}),
      };
    });
    return value;
  } catch (err) {
    return { ...base, ready: false, note: tr('ACP 握手失败：{0}', [brief(err.message, 300)]) };
  }
}

function toolKind(call) {
  if (call.rawInput?.command || call.rawInput?.cmd) return 'command';
  for (const hint of [call.kind, call.name, call.title]) {
    const word = String(hint || '').toLowerCase().split(/[\s(]/, 1)[0];
    if (/^(execute|command|exec|bash|shell|terminal|powershell|run_command|run_shell_command)$/.test(word)) return 'command';
    if (/^(edit|write|delete|move|patch|create|file_write|fs_write|write_file|edit_file|apply_patch)$/.test(word)) return 'edit';
    if (/^(search|fetch)$/.test(word)) return 'search';
    if (/^(read|read_file|read_text_file)$/.test(word)) return 'read';
    if (word === 'think') return 'think';
  }
  return 'other';
}

export function classifyPermission({ toolCall = {} }, cwd) {
  const kind = toolKind(toolCall);
  const input = toolCall.rawInput || {};
  const title = toolCall.title || toolCall.name;
  if (kind === 'command') {
    const cmd = input.command || input.cmd || title || 'command';
    return { action: kind, command: Array.isArray(cmd) ? cmd.join(' ') : String(cmd) };
  }
  if (kind === 'edit') {
    const filePath = input.path || input.file_path || toolCall.locations?.[0]?.path;
    return { action: kind, command: filePath ? tr('修改 {0}', [relPath(filePath, cwd)]) : title || tr('修改文件'), ...(filePath ? { filePath } : {}) };
  }
  return { action: kind === 'other' ? 'other' : 'read', command: title || tr('工具操作') };
}

function activity(call, cwd) {
  const kind = toolKind(call);
  const title = call.title || call.name || tr('工具');
  const input = call.rawInput || {};
  const file = relPath(input.path || input.file_path || call.locations?.[0]?.path, cwd) || title;
  if (kind === 'command') return { kind, label: tr('运行 {0}', [brief(classifyPermission({ toolCall: call }, cwd).command, 70)]) };
  if (kind === 'edit') return { kind, label: tr('修改 {0}', [file]) };
  if (kind === 'read') return { kind, label: tr('读取 {0}', [file]) };
  if (kind === 'search') return { kind, label: tr('搜索：{0}', [brief(input.query || title, 60)]) };
  return { kind: 'tool', label: brief(title, 60) };
}

function permissionResult(options, { allow, note }) {
  const kinds = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  const match = allow ? /allow|accept|approve/i : /reject|deny|decline/i;
  const option = kinds.map((k) => options.find((o) => o.kind === k)).find(Boolean)
    || options.find((o) => match.test([o.kind, o.optionId, o.name].join(' '))) || (allow && options[0]);
  const outcome = option?.optionId ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' };
  return {
    outcome,
    ...(note?.trim() ? { _meta: { note, message: allow ? tr('我同意这次操作，并补充：{0}', [note]) : tr('我拒绝这次操作，理由：{0}', [note]) } } : {}),
  };
}

function contentText(content) {
  if (Array.isArray(content)) return content.map(contentText).join('');
  if (typeof content === 'string') return content;
  return content?.type === 'text' && typeof content.text === 'string' ? content.text : '';
}

export async function runTurn({ acp, system, prompt, model, cwd = process.cwd(), access = 'edit', sessionId, signal, onDelta, onActivity, onRaw, onApproval, onUnverified, idleMs }) {
  if (!acp?.command) throw new Error(tr('请填写启动命令'));
  const resolved = resolveCommand(acp.command, acp.args);
  if (!resolved) throw new Error(tr('找不到启动命令：{0}', [acp.command]));
  const tools = new Map(), mutations = new Set(), permissions = new Set();
  let text = '', activeSessionId, prompting = false, declaredPermissions;
  function append(chunk) {
    if (chunk) { text += chunk; onDelta?.(chunk); }
  }
  const current = (params) => prompting && (!params.sessionId || params.sessionId === activeSessionId);
  function onUpdate(params) {
    if (!current(params)) return; // session/load can replay old messages and tools.
    const update = params.update || params;
    if (update.sessionUpdate === 'agent_message_chunk') append(contentText(update.content));
    if (!['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) return;
    const id = update.toolCallId;
    const previous = tools.get(id);
    const call = {};
    // Updates may omit tool metadata. Keep only what descriptions and
    // approvals need, since raw output can contain entire files.
    for (const key of ['kind', 'name', 'title', 'rawInput', 'locations']) call[key] = update[key] ?? previous?.[key];
    if (id != null) tools.set(id, call);
    const a = activity(call, cwd);
    if (access !== 'full' && ['edit', 'command'].includes(a.kind)) mutations.add(id);
    if (!previous) onActivity?.(a);
  }
  async function onPermission(params, ctl) {
    const options = Array.isArray(params.options) ? params.options : [];
    if (!current(params) || signal?.aborted) return { outcome: { outcome: 'cancelled' } };
    const id = params.toolCall?.toolCallId;
    permissions.add(id);
    const toolCall = { ...tools.get(id), ...params.toolCall };
    const { action, command, filePath } = classifyPermission({ toolCall }, cwd);
    let decision;
    if (access === 'full' || action === 'read' || (access === 'run' && action === 'edit')) decision = { allow: true };
    else if (onApproval) decision = await ctl.hold(onApproval({ command, kind: action, ...(filePath ? { path: filePath } : {}) }));
    else decision = { allow: (access === 'edit' && action === 'edit') || (access === 'run' && action === 'command') };
    return permissionResult(options, decision);
  }
  let unverifiedPermissions = false;
  const { value, stderr } = await withAgent(resolved, {
    cwd, signal, idleMs, onRaw, onUpdate, onPermission, cancelSession: () => activeSessionId,
  }, async (init, request) => {
    declaredPermissions = supportsPermissions(init);
    const params = { cwd: path.resolve(cwd), mcpServers: [] };
    if (sessionId && capabilitiesOf(init).loadSession) {
      try {
        const session = await request('session/load', { ...params, sessionId });
        activeSessionId = session?.sessionId || sessionId;
      } catch { /* The previous session may have expired. Open a new one. */ }
    }
    if (!activeSessionId) {
      const session = await request('session/new', { ...params, ...(model ? { model } : {}) });
      activeSessionId = session?.sessionId;
      if (!activeSessionId) throw new Error(tr('ACP 没有返回会话 ID'));
    }
    if (model) {
      try { await request('session/set_model', { sessionId: activeSessionId, modelId: model }); }
      catch (err) { if (err.code !== -32601 && !/unsupported|not supported|not implemented/i.test(err.message)) throw err; }
    }
    prompting = true;
    const res = await request('session/prompt', {
      sessionId: activeSessionId, prompt: [{ type: 'text', text: system ? system + '\n\n' + prompt : prompt }], _meta: { access },
    }, 0); // The idle timer covers the prompt, and pauses during approval.
    prompting = false;
    if (!text) append(contentText(res?.text || res?.output));
    return res;
  }).finally(() => {
    // A crash or cancellation does not undo a tool action already observed.
    unverifiedPermissions = declaredPermissions === false || [...mutations].some((id) => !permissions.has(id));
    if (unverifiedPermissions && !runtimeUnverified.has(configKey(acp))) {
      runtimeUnverified.add(configKey(acp));
      onUnverified?.();
    }
  });
  if (!text.trim()) throw new Error(tr('ACP 没有返回文字：{0}', [brief(stderr || value?.stopReason || 'session/prompt', 300)]));
  const u = value?.usage;
  const usage = u && usageOf({ ...u, input: u.input ?? u.inputTokens, output: u.output ?? u.outputTokens });
  return { text, sessionId: activeSessionId, ...(usage ? { usage } : {}), ...(unverifiedPermissions ? { unverifiedPermissions } : {}) };
}
