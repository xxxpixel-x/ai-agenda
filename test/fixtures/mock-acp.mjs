// A separate ACP process. Commands are reported, and only permitted fixture
// edits are applied to files in the session's working directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const flags = process.argv.slice(2);
const has = (key) => flags.includes('--' + key);
function option(key, fallback) {
  const i = flags.indexOf('--' + key);
  const v = i >= 0 && flags[i + 1];
  return typeof v === 'string' && !v.startsWith('--') ? v : fallback;
}
const models = {
  availableModels: option('models', '').split(',').filter(Boolean).map((s) => {
    const [modelId, name] = s.split(':');
    return { modelId, name: name || modelId };
  }),
  currentModelId: option('default-model', ''),
};
let cwd, sessionId, model, cancelled = false, next = 0;
const pending = new Map();
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const result = (id, value) => send({ id, result: value });
const error = (id, code, message) => send({ id, error: { code, message } });
function request(method, params) {
  const id = 'agent-' + ++next;
  return new Promise((resolve) => { pending.set(id, resolve); send({ id, method, params }); });
}
function update(data) {
  send({ method: has('aliases') ? 'session/updateNotification' : 'session/update',
    params: has('flat') ? { sessionId, ...data } : { sessionId, update: data } });
}
const chunk = (content) => update({ sessionUpdate: 'agent_message_chunk', content });
const block = (text) => ({ type: 'text', text });
const tool = (call) => update({ sessionUpdate: 'tool_call', ...call });

async function ask(kind, target) {
  const edit = kind === 'edit';
  const toolCall = { toolCallId: 'tool-' + kind, kind, title: kind, rawInput: kind === 'execute' ? { command: target } : { path: target } };
  const kinds = has('no-reject') ? ['allow_once'] : edit ? ['allow_once', 'reject_once'] : ['allow_always', 'reject_once', 'allow_once'];
  const options = kinds.map((k) => ({ kind: k, optionId: 'opt-' + k, name: k }));
  if (has('announce-first')) tool(toolCall);
  const { result: decision } = await request(has('aliases') ? 'session/requestPermission' : 'session/request_permission', {
    sessionId, toolCall: has('announce-first') ? { toolCallId: toolCall.toolCallId } : toolCall, options,
  });
  const selected = decision.outcome.optionId || decision.outcome.outcome;
  if (selected.startsWith('opt-allow')) {
    tool(toolCall);
    if (edit) {
      const file = path.resolve(cwd, target);
      const rel = path.relative(cwd, file);
      assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'fixture edit must be inside cwd');
      fs.writeFileSync(file, 'ACP fixture edit\n');
    }
    update({ sessionUpdate: 'tool_call_update', toolCallId: toolCall.toolCallId, status: 'completed' });
  }
  return [kind, selected, decision._meta?.note, decision._meta?.message].filter(Boolean).join(' ');
}

async function taskReply(prompt) {
  if (/这次任务协作的协调者|coordinator for this task run/.test(prompt)) {
    const assignee = prompt.match(/^- @([^\s（(]+)/m)?.[1] || 'Agent';
    const task = { id: 'T1', title: 'Write report', assignee, deps: [], spec: 'Write acp-report.md' };
    return '```json\n' + JSON.stringify({ tasks: [task] }) + '\n```';
  }
  if (/要你审阅计划|请你审阅计划|review the plan/i.test(prompt)) return '[Agree]';
  if (/请写总结。|Write the summary\./i.test(prompt)) return 'Reviewed and completed acp-report.md.';
  if (/子任务 T1|assigned task T1/.test(prompt)) {
    const decision = await ask('edit', 'acp-report.md');
    return decision + '\n' + (prompt.includes('子任务 T1') ? '结果：完成' : 'Result: Done');
  }
  throw new Error('Unexpected task prompt');
}

async function promptTurn(id, params) {
  assert.equal(params.sessionId, sessionId);
  const prompt = params.prompt[0].text;
  if (/记忆库的整理者|organizer of this space memory|交接说明|handoff/i.test(prompt)) {
    chunk(block('```json\n{"ops":[]}\n```'));
    return result(id, { stopReason: 'end_turn' });
  }
  const parts = [];
  if (has('unknown-request')) {
    const response = await request('fs/read_text_file', { sessionId, path: 'unused' });
    parts.push('unknown=' + response.error?.code);
  }
  if (has('request-edit')) parts.push(await ask('edit', option('request-edit', 'note.md')));
  if (has('request-read')) parts.push(await ask('read', 'note.md'));
  if (has('request-other')) parts.push(await ask('other', 'item'));
  if (has('request-command')) parts.push(await ask('execute', option('request-command', 'echo hello')));
  if (has('bypass-permissions')) tool({ kind: 'edit', toolCallId: 'bypass', locations: [{ path: 'bypass.md' }] });
  if (has('crash-prompt')) {
    process.stderr.write('fixture crashed during prompt\n');
    process.exitCode = 2;
    process.stdin.destroy();
    return;
  }
  if (has('activities')) {
    for (const [kind, rawInput] of [['read', { path: 'notes.md' }], ['fetch', { query: 'agenda' }], ['other', {}]]) {
      tool({ toolCallId: kind, kind, title: 'Inspect', rawInput });
      update({ sessionUpdate: 'tool_call_update', toolCallId: kind, status: 'completed' });
    }
  }
  if (has('echo-model')) parts.push('model=' + model);
  if (has('echo-prompt')) parts.push(prompt + ' access=' + params._meta.access);
  if (option('scenario') === 'task') parts.push(await taskReply(prompt));
  if (has('stream')) parts.push(...option('stream', '').split('|'));
  if (!parts.length && !has('empty') && !has('output')) parts.push('Hello from ACP');
  for (const [i, text] of parts.entries()) {
    if (i && has('delay-ms')) await delay(Number(option('delay-ms')));
    if (cancelled) break;
    chunk(i % 3 === 0 ? block(text) : i % 3 === 1 ? text : [block(text), { type: 'image', data: 'ignored' }]);
  }
  result(id, { stopReason: cancelled ? 'cancelled' : 'end_turn', usage: { inputTokens: 11, outputTokens: 5 }, ...(has('output') ? { output: option('output') } : {}) });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (!method) {
    pending.get(id)?.(msg);
    pending.delete(id);
    return;
  }
  switch (method) {
    case 'initialize':
      assert.equal(msg.jsonrpc, '2.0');
      assert.deepEqual(params, { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'agenda', title: 'Agenda', version: '1' } });
      if (has('pid-file')) fs.writeFileSync(option('pid-file'), String(process.pid));
      if (has('hang-init')) return;
      if (has('crash-init')) { process.stderr.write('fixture crashed during initialize\n'); process.exitCode = 1; process.stdin.destroy(); return; }
      if (has('fail-init')) return error(id, -32001, option('fail-init', 'fixture initialize failure'));
      return result(id, { protocolVersion: 1, agentInfo: { name: 'mock-acp', version: '1.2.3', title: 'Fixture' },
        agentCapabilities: { loadSession: true, ...(has('no-permissions') ? {} : { permissions: true }) },
        ...(has('models-in-session') ? {} : { models }) });
    case 'session/load':
      if (has('fail-load')) return error(id, -32002, 'session expired');
      cwd = params.cwd;
      sessionId = params.sessionId;
      chunk(block('history replay'));
      return result(id, {}); // Standard load response may omit the ID.
    case 'session/new':
      if (has('auth-error')) return error(id, -32000, 'Login required');
      if (has('fail-new')) return error(id, -32001, 'probe unavailable');
      assert.ok(path.isAbsolute(params.cwd));
      assert.deepEqual(params.mcpServers, []);
      cwd = params.cwd;
      sessionId = 'fixture-session';
      model = params.model || models.currentModelId;
      return result(id, { sessionId, models });
    case 'session/set_model':
      if (has('no-set-model')) return error(id, -32601, 'Method not found');
      assert.equal(params.sessionId, sessionId);
      model = params.modelId;
      return result(id, {});
    case 'session/prompt': return promptTurn(id, params);
    case 'session/cancel': cancelled = true; return;
    default: return error(id, -32601, 'Method not found');
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const msg = JSON.parse(line);
  handle(msg).catch((err) => error(msg.id, -32603, err.message));
});
