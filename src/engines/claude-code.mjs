// Claude Code（本机命令行，headless 模式）。默认用 Claude Code 自己的登录；
// 成员选了模型来源（设置里「也给 Claude Code 用」的接口）时改连那个接口，用独立的配置目录，不需要登录 Claude 账号。
import { t as tr } from '../i18n.mjs';
import fs from 'node:fs';
import { mountedSkills, skillPrompt } from './mounted-skills.mjs';
import os from 'node:os';
import path from 'node:path';
import { findOnPath, isFile, capture, runJsonl, brief, relPath } from './proc.mjs';
import { usageOf, quotaOf, contextOf } from './usage-fields.mjs';

export const meta = {
  skills: true, mcp: true, noTools: true,
  images: true,
  id: 'claude-code',
  label: 'Claude Code',
  kind: 'cli',
  vendor: 'Anthropic',
  defaultName: 'Claude',
  color: '#d97757',
  logo: 'claude', // public/icons 里的图标名
  // 命令行列不出可用型号，只能写死；列表里没有的型号（含 opus / sonnet 这类别名）可以手填
  get models() { return [
    ['', tr('默认')],
    ['claude-opus-5-5', 'Opus 5.5'], ['claude-opus-5', 'Opus 5'], ['claude-opus-4-8', 'Opus 4.8'], ['claude-opus-4-7', 'Opus 4.7'],
    ['claude-fable-5-2', 'Fable 5.2'], ['claude-fable-5-1', 'Fable 5.1'], ['claude-fable-5', 'Fable 5'],
    ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-sonnet-5', 'Sonnet 5'], ['claude-sonnet-4-6', 'Sonnet 4.6'],
    ['claude-haiku-5-5', 'Haiku 5.5'], ['claude-haiku-4-5', 'Haiku 4.5'],
  ]; },
  efforts: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
  get capabilities() { return tr('读写共享文件、联网搜索'); },
  approvals: true, // 运行命令前可以先问你
  privateSessions: true,
  continuesImports: true, // 导入它自己的对话时，对应成员复制一份原会话接着聊（runTurn 的 sessionId + fork）
  usage: { tokens: true, context: true, quota: true }, // 结果里的 token 和上下文窗口、rate_limit_event 里的账号额度（2.1.325 实测）
  sources: true, // 能换模型来源（Anthropic 兼容接口）
  get accountLabel() { return tr('你的 Claude 账号'); }, // 不选接口时用的是什么
};

// 你本机环境里可能有的 Claude 设置：用别家接口时一律清空，免得盖过这个成员的接口
const INHERITED = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH|CLAUDE_CONFIG_DIR$)/i;
const MODEL_VARS = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];

/**
 * 配别家模型时的环境变量（2.1.326 实测：独立的 CLAUDE_CONFIG_DIR + ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN，不登录也能用）。
 * 各档型号（含后台用的 haiku、子代理）都指向同一个型号，Kimi 文档说缺了 haiku / 子代理会让后台任务失败。
 */
export function sourceEnv(source, { configDir, model, base = process.env } = {}) {
  const env = {};
  for (const k of Object.keys(base)) if (INHERITED.test(k)) env[k] = '';
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: source.anthropicUrl,
    ANTHROPIC_AUTH_TOKEN: source.apiKey || '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    API_TIMEOUT_MS: '3000000',
  });
  const name = model || source.model;
  if (name) for (const k of MODEL_VARS) env[k] = name;
  return env;
}

function compareVersions(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Claude 桌面 app 自带的 Claude Code：<AppData>/Claude/claude-code/<版本>/<hash>/claude(.exe)
function findInDesktopApp() {
  const roots = [];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'Claude', 'claude-code'));
  roots.push(path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code'));
  roots.push(path.join(os.homedir(), '.config', 'Claude', 'claude-code'));
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const root of roots) {
    let versions;
    try { versions = fs.readdirSync(root); } catch { continue; }
    versions.sort(compareVersions).reverse();
    for (const v of versions) {
      const vdir = path.join(root, v);
      const candidates = [];
      if (isFile(path.join(vdir, exe))) candidates.push(path.join(vdir, exe));
      try {
        for (const sub of fs.readdirSync(vdir)) {
          const p = path.join(vdir, sub, exe);
          if (isFile(p)) candidates.push(p);
        }
      } catch { /* 不是目录 */ }
      if (candidates.length) {
        candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        return candidates[0];
      }
    }
  }
  return null;
}

export function findBin(override) {
  if (override && isFile(override)) return override;
  if (process.env.CLAUDE_BIN && isFile(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  return findOnPath('claude') || findInDesktopApp();
}

const loginCmd = (bin) => (/^[A-Za-z]:\\/.test(bin) ? `& "${bin}" auth login` : `"${bin}" auth login`);

export async function detect({ binOverride } = {}) {
  const bin = findBin(binOverride);
  if (!bin) {
    return { available: false, ready: false, note: tr('没有找到 Claude Code。安装 Claude 桌面 app 或 Claude Code 命令行后重新检测。') };
  }
  const r = await capture(bin, ['auth', 'status']);
  let loggedIn = false;
  let method = null;
  try {
    const j = JSON.parse(r.stdout);
    loggedIn = !!j.loggedIn;
    method = j.authMethod;
  } catch { /* 旧版本没有 JSON 输出 */ }
  return {
    available: true,
    ready: loggedIn,
    bin,
    note: loggedIn ? tr('已登录（{0}）', [method]) : tr('还没有登录。在终端运行下面的命令，在弹出的浏览器里用你的 Claude 账号登录：'),
    command: loggedIn ? null : loginCmd(bin),
  };
}

// 按权限档位开放的工具
const TOOLS = {
  read: 'Read,Glob,Grep,WebSearch,WebFetch',
  edit: 'Read,Edit,Write,Glob,Grep,WebSearch,WebFetch',
  run: 'Read,Edit,Write,Glob,Grep,WebSearch,WebFetch,Bash,PowerShell',
  full: null, // 不限工具
};

const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

// ask：运行命令要先问你。命令工具照常提供，但不预先放行，由软件回答 Claude 的权限请求
function accessArgs(access, ask = false, mcpTools = []) {
  if (access === 'full') return ['--dangerously-skip-permissions'];
  const tools = TOOLS[access] || TOOLS.edit;
  const allowed = ask ? tools.split(',').filter((t) => !COMMAND_TOOLS.has(t)).join(',') : tools;
  return [
    '--tools', tools,
    '--allowedTools', [allowed, ...mcpTools].join(','),
    '--permission-mode', access === 'read' ? 'default' : 'acceptEdits',
    ...(ask
      ? ['--permission-prompts', 'host', '--permission-prompt-tool', 'stdio']
      : ['--permission-prompts', 'none']), // 没人能回答弹窗：未放行的操作直接拒绝
  ];
}

const refusal = (note) => tr('「我」没有同意运行这条命令{0}。按这个调整做法，不要换一种写法绕过。', [note ? tr('，理由：{0}', [note]) : '']);
const approvalNote = (note) => tr('「我」同意了刚才那条命令，并补充：{0}', [note]);

export function extensionOptions({ skills = [], mcp = {}, access = 'edit', ask = false, mcpConfigFile = '', noTools = false } = {}) {
  if (noTools) {
    return { args: ['--tools', '', '--allowedTools', '', '--permission-mode', 'default', '--permission-prompts', 'none', '--safe-mode', '--strict-mcp-config'], skillPrompt: '' };
  }
  const names = mcpConfigFile ? Object.keys(mcp) : [];
  const args = [...accessArgs(access, ask, names.map(name => `mcp__${name}__*`)), '--safe-mode', '--strict-mcp-config'];
  if (names.length) args.push('--mcp-config', mcpConfigFile);
  for (const dir of mountedSkills(skills)) args.push('--add-dir', dir);
  return { args, skillPrompt: skillPrompt(skills) };
}

function activityOf(block, cwd) {
  const i = block.input || {};
  switch (block.name) {
    case 'Read': return { kind: 'read', label: tr('读取 {0}', [relPath(i.file_path, cwd)]) };
    case 'Edit': case 'MultiEdit': return { kind: 'edit', label: tr('修改 {0}', [relPath(i.file_path, cwd)]) };
    case 'Write': return { kind: 'edit', label: tr('写入 {0}', [relPath(i.file_path, cwd)]) };
    case 'Glob': case 'Grep': return { kind: 'read', label: tr('查找 {0}', [brief(i.pattern, 40)]) };
    case 'WebSearch': return { kind: 'search', label: tr('搜索：{0}', [brief(i.query, 60)]) };
    case 'WebFetch': return { kind: 'search', label: tr('打开网页 {0}', [brief(i.url, 60)]) };
    case 'Bash': case 'PowerShell': return { kind: 'command', label: tr('运行 {0}', [brief(i.command, 70)]) };
    default: return { kind: 'tool', label: block.name };
  }
}

/**
 * 用量（Claude Code 2.1.325 实测）：
 *   result.usage 是这一轮所有请求的合计，usage.iterations 的最后一项是最后一次请求（算上下文长度）；
 *   result.modelUsage[型号].contextWindow 是窗口大小（用了子代理时取用量最大的那个型号）；
 *   rate_limit_event 的 unifiedWindows（five_hour / seven_day）里有 utilization（0–1）和 resetsAt（秒）。
 */
export function usageFrom(result, rateLimit) {
  const u = result?.usage;
  if (!u) return undefined;
  const last = u.iterations?.at(-1);
  const size = (m) => (m?.inputTokens || 0) + (m?.cacheReadInputTokens || 0) + (m?.cacheCreationInputTokens || 0);
  const main = Object.values(result.modelUsage || {}).reduce((a, b) => (size(b) > size(a) ? b : a), null);
  const windows = rateLimit ? Object.values(rateLimit.unifiedWindows || { one: rateLimit }) : [];
  return usageOf({
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens,
    cacheWrite: u.cache_creation_input_tokens,
    contextUsed: last ? contextOf({ input: last.input_tokens, cacheRead: last.cache_read_input_tokens, cacheWrite: last.cache_creation_input_tokens, output: last.output_tokens }) : undefined,
    contextWindow: main?.contextWindow,
    quota: quotaOf(windows.map((w) => ({ usedPct: typeof w?.utilization === 'number' ? w.utilization * 100 : undefined, resetsAt: w?.resetsAt }))),
  });
}

function friendly(text, bin, source) {
  const t = brief(text, 300);
  if (source) {
    if (/invalid api key|authentication|unauthorized|401/i.test(t)) return tr('{0} 的 API key 不对或没有填（{1}）', [source.name, t]);
    return t ? `${source.name}：${t}` : tr('{0} 没有返回内容', [source.name]);
  }
  if (/not logged in|\/login|invalid api key|authentication/i.test(t)) {
    return tr('Claude Code 还没有登录（{0}）。请在终端运行 {1}，登录后再试。', [t, loginCmd(bin)]);
  }
  if (/rate limit|usage limit|limit reached|\b429\b/i.test(t)) return tr('Claude 账号额度已用完或被限流（{0}）。', [t]);
  return t || tr('Claude Code 没有返回内容');
}

/**
 * 平时每次发言都是一次性的（不保存会话）。
 * sessionId：接续导入的 Claude Code 对话。fork 为 true 时先复制一份再接（原会话不动），返回新的会话 ID。
 * resumeAt：复制时只复制到这条消息为止（导入时的最后一条）。导入后你在 Claude Code 里接着聊的内容不带进来；
 *   用的是帮助里没列出的 --resume-session-at（Claude Code 2.1.325 实测），找不到这条消息时按接续失败处理。
 * 接续时用 --system-prompt-snapshot off，否则会一直沿用原会话第一次记下的系统提示，Agenda 的规则传不进去。
 */
/** source / configDir：成员的模型来源（接口）和它独立的配置目录，由注册表给。 */
export async function runTurn({ system, prompt, images = [], skills = [], mcp = {}, model, effort, cwd, access = 'edit', noTools = false, signal, onDelta, onActivity, onRaw, onApproval, binOverride, sessionId, fork = false, resumeAt, source, configDir, keepSession = false, sessionHome, imported = false }) {
  const ask = !noTools && access === 'run' && !!onApproval;
  const bin = findBin(binOverride);
  if (!bin) throw new Error(tr('没有找到 Claude Code'));
  const sysFile = path.join(os.tmpdir(), `rt-sys-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const mcpConfigFile = sysFile + '.json';
  const ext = extensionOptions({ skills: noTools ? [] : skills, mcp: noTools ? {} : mcp, access, ask, mcpConfigFile, noTools });

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--append-system-prompt-file', sysFile,
    ...(ask || images.length ? ['--input-format', 'stream-json'] : []),
    ...ext.args,
  ];
  const persist = !!sessionId || !!keepSession;
  const isImported = !!imported || !!fork || !!resumeAt;
  if (sessionId) {
    args.push('--resume', sessionId, '--system-prompt-snapshot', 'off');
    if (fork) args.push('--fork-session');
    if (fork && resumeAt) args.push('--resume-session-at', resumeAt);
  } else if (!persist) {
    args.push('--no-session-persistence');
  }
  if (model && !source) args.push('--model', model); // 用接口时型号走环境变量
  if (effort) args.push('--effort', effort);
  let env;
  if (source) {
    fs.mkdirSync(configDir, { recursive: true });
    env = sourceEnv(source, { configDir, model });
  } else if (persist && !isImported && sessionHome) {
    fs.mkdirSync(sessionHome, { recursive: true });
    env = { CLAUDE_CONFIG_DIR: sessionHome,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? '' };
  }

  let text = '';
  let result = null;
  let rateLimit = null;
  let blocks = 0;
  const emit = (t) => { if (t) { text += t; onDelta?.(t); } };

  // Claude 想用一个没预先放行的工具：命令交给你决定；其他（比如改共享文件夹以外的文件）照旧拒绝
  async function answerPermission(msg, ctl) {
    const { tool_name: tool, input = {} } = msg.request;
    let response;
    let note = '';
    if (COMMAND_TOOLS.has(tool)) {
      const d = await ctl.hold(onApproval({ command: input.command || '' }));
      response = d.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: refusal(d.note) };
      if (d.allow) note = d.note;
    } else {
      response = { behavior: 'deny', message: tr('超出了当前权限。') };
    }
    ctl.send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
    // 同意时附的话：紧跟着发一条消息，Claude 在这一轮里就会读到（Claude Code 2.1.321 实测）
    if (note) ctl.send({ type: 'user', message: { role: 'user', content: approvalNote(note) }, parent_tool_use_id: null, session_id: '' });
  }

  try {
    fs.writeFileSync(sysFile, system + ext.skillPrompt, { mode: 0o600, flag: 'wx' });
    if (Object.keys(mcp).length) fs.writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: mcp }), { mode: 0o600, flag: 'wx' });
    const r = await runJsonl({
      cmd: bin,
      args,
      cwd,
      env,
      // 双向通信时先握手（不握手 Claude 不会把权限请求发过来），再发这次的输入
      input: ask || images.length ? [
        ...(ask ? [{ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } }] : []),
        { type: 'user', message: { role: 'user', content: images.length ? [
          { type: 'text', text: prompt },
          ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.type, data: fs.readFileSync(i.path, 'base64') } })),
        ] : prompt }, parent_tool_use_id: null, session_id: '' },
      ] : prompt,
      keepInput: ask,
      signal,
      onRaw,
      onEvent(msg, ctl) {
        if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
          answerPermission(msg, ctl);
        } else if (msg.type === 'stream_event') {
          const ev = msg.event || {};
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') {
            if (blocks++ > 0 && text && !text.endsWith('\n')) emit('\n\n');
            emit(ev.content_block.text || '');
          } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            emit(ev.delta.text);
          }
        } else if (msg.type === 'assistant') {
          for (const b of msg.message?.content || []) {
            if (b.type === 'tool_use') onActivity?.(activityOf(b, cwd));
          }
        } else if (msg.type === 'rate_limit_event') {
          rateLimit = msg.rate_limit_info || null;
        } else if (msg.type === 'result') {
          result = msg;
          if (ask) ctl.finish();
        }
      },
    });
    const fail = (why) => {
      const err = new Error(friendly(why, bin, source));
      // 接不上原会话：原因有时只写在 stderr 里（比如 --resume-session-at 找不到消息，结果里只有 error_during_execution）
      if (sessionId && /no conversation found|session.*not found|no message found with message\.uuid|unknown option.*resume-session-at/i.test(`${why}\n${r.stderr || ''}`)) err.resumeFailed = true;
      return err;
    };
    if (result?.is_error) throw fail(result.result || result.subtype);
    if (!result && r.code !== 0) throw fail(r.stderr || tr('退出码 {0}', [r.code]));
    if (!text && result?.result) emit(result.result);
    if (!text.trim()) throw fail(r.stderr);
    const usage = usageFrom(result, rateLimit);
    // 别家型号 Claude Code 不认识，报的上下文窗口是它猜的，不显示
    if (source && usage) delete usage.contextWindow;
    return { text, sessionId: persist ? result?.session_id || null : undefined, ...(usage ? { usage } : {}) };
  } finally {
    fs.rmSync(sysFile, { force: true });
    fs.rmSync(mcpConfigFile, { force: true });
  }
}
