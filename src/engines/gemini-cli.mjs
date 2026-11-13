// Gemini CLI（Google 官方命令行，headless 模式）。使用它自己的登录（Google 账号），不需要 API key。
// 没装时界面上不出现它（hideWhenMissing），只用 Gemini API。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findOnPath, isFile, capture, runJsonl, brief, relPath, resolveNodeShim, nodeRunner } from './proc.mjs';

export const meta = {
  id: 'gemini-cli',
  label: 'Gemini CLI',
  kind: 'cli',
  vendor: 'Google',
  defaultName: 'Gemini',
  color: '#4285f4',
  hideWhenMissing: true,
  // 命令行列不出型号，只有这几个别名；具体型号名可以手填
  models: [['', '自动'], ['pro', 'Pro'], ['flash', 'Flash'], ['flash-lite', 'Flash-Lite']],
  freeModel: true,
  efforts: [''], // 命令行没有思考档位参数
  capabilities: '读写共享文件、联网搜索（Google 搜索）',
};

const homeDir = () => path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini');

export function findBin(override) {
  if (override && isFile(override)) return override;
  if (process.env.GEMINI_BIN && isFile(process.env.GEMINI_BIN)) return process.env.GEMINI_BIN;
  return findOnPath('gemini');
}

// npm 装的是 gemini.cmd：能解析出 .js 入口就直接用 node 启动，避开 cmd.exe 的转义
function command(bin, args) {
  const js = resolveNodeShim(bin);
  if (!js) return { cmd: bin, args, env: {} };
  const node = nodeRunner();
  return { cmd: node.cmd, args: [js, ...args], env: node.env };
}

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

/** 命令行没有“登录状态”命令：看它自己记下的登录方式和凭证。 */
export function loginState(home = homeDir()) {
  const s = readJson(path.join(home, 'settings.json')) || {};
  const type = s.security?.auth?.selectedType || s.selectedAuthType || '';
  if (type === 'oauth-personal') {
    const account = readJson(path.join(home, 'google_accounts.json'))?.active || '';
    const ok = !!account || isFile(path.join(home, 'oauth_creds.json'));
    return { loggedIn: ok, method: account ? `Google 账号 ${account}` : 'Google 账号' };
  }
  if (type === 'gemini-api-key') {
    const ok = !!process.env.GEMINI_API_KEY || isFile(path.join(home, '.env'));
    return { loggedIn: ok, method: 'Gemini API key' };
  }
  if (type) return { loggedIn: true, method: type === 'vertex-ai' ? 'Vertex AI' : type };
  return { loggedIn: false, method: '' };
}

const loginCmd = (bin) => (/^[A-Za-z]:\\/.test(bin) ? `& "${bin}"` : `"${bin}"`);

export async function detect({ binOverride } = {}) {
  const bin = findBin(binOverride);
  if (!bin) return { available: false, ready: false, note: '没有找到 Gemini CLI。' };
  const c = command(bin, ['--version']);
  const ver = await capture(c.cmd, c.args, { env: c.env });
  const { loggedIn, method } = loginState();
  return {
    available: true,
    ready: loggedIn,
    bin,
    version: brief(ver.stdout, 30),
    note: loggedIn ? `已登录（${method}）` : '还没有登录。在终端运行下面的命令，选择用 Google 账号登录，登录后退出即可：',
    command: loggedIn ? null : loginCmd(bin),
  };
}

/**
 * 权限档位 → approval-mode（headless 下需要批准的工具直接不给用）：
 *   只读 = default（只剩读和搜索）；可编辑 = auto_edit；可运行命令 / 全部权限 = yolo。
 * 它的文件工具本来就只能碰工作区（共享文件夹）。
 * 除了「全部权限」，不加载个人的扩展和 MCP 服务。
 */
export function buildArgs({ access = 'edit', model } = {}) {
  const mode = access === 'read' ? 'default' : access === 'edit' ? 'auto_edit' : 'yolo';
  const args = ['--output-format', 'stream-json', '--approval-mode', mode, '--skip-trust'];
  if (access !== 'full') args.push('--extensions', 'none', '--allowed-mcp-server-names', 'agenda-none');
  if (model) args.push('--model', model);
  return args;
}

function activityOf(ev, cwd) {
  const i = ev.parameters || {};
  const file = relPath(i.file_path || i.absolute_path || i.path, cwd);
  switch (ev.tool_name) {
    case 'read_file': case 'read_many_files': return { kind: 'read', label: `读取 ${file || brief((i.paths || []).join(', '), 40)}` };
    case 'replace': case 'edit': return { kind: 'edit', label: `修改 ${file}` };
    case 'write_file': return { kind: 'edit', label: `写入 ${file}` };
    case 'list_directory': case 'glob': case 'search_file_content': case 'grep_search':
      return { kind: 'read', label: `查找 ${brief(i.pattern || file, 40)}` };
    case 'google_web_search': return { kind: 'search', label: `搜索：${brief(i.query, 60)}` };
    case 'web_fetch': return { kind: 'search', label: `打开网页 ${brief(i.url || i.prompt, 60)}` };
    case 'run_shell_command': return { kind: 'command', label: `运行 ${brief(i.command, 70)}` };
    default: return { kind: 'tool', label: String(ev.tool_name || '工具') };
  }
}

function friendly(text, bin) {
  const t = brief(text, 300);
  if (/auth|login|credential|unauthenticated|\b401\b/i.test(t)) {
    return `Gemini CLI 还没有登录（${t}）。请在终端运行 ${loginCmd(bin)} 用 Google 账号登录，再试。`;
  }
  if (/quota|rate limit|resource_exhausted|\b429\b/i.test(t)) return `Gemini 账号额度已用完或被限流（${t}）。`;
  return t || 'Gemini CLI 没有返回内容';
}

/** 每次发言都是一次性的；Agenda 的规则放在消息开头（命令行没有“追加系统提示”的参数）。 */
export async function runTurn({ system, prompt, model, cwd, access = 'edit', signal, onDelta, onActivity, onRaw, binOverride }) {
  const bin = findBin(binOverride);
  if (!bin) throw new Error('没有找到 Gemini CLI');
  const c = command(bin, buildArgs({ access, model }));

  let text = '';
  let result = null;
  let toolSince = false; // 上一段文字之后用过工具：下一段另起
  const errors = [];
  const emit = (t) => { if (t) { text += t; onDelta?.(t); } };

  const r = await runJsonl({
    cmd: c.cmd,
    args: c.args,
    env: c.env,
    cwd,
    input: `${system}\n\n${prompt}`,
    signal,
    onRaw,
    onEvent(ev, ctl) {
      if (ev.type === 'message' && ev.role === 'assistant') {
        if (toolSince && text && !text.endsWith('\n')) emit('\n\n');
        toolSince = false;
        emit(ev.content);
      } else if (ev.type === 'tool_use') {
        toolSince = true;
        onActivity?.(activityOf(ev, cwd));
      } else if (ev.type === 'error' && ev.severity === 'error') {
        errors.push(ev.message);
      } else if (ev.type === 'result') {
        result = ev;
        ctl.finish();
      }
    },
  });

  if (result?.status === 'error') throw new Error(friendly(result.error?.message || errors.join('；'), bin));
  if (!result && r.code !== 0) throw new Error(friendly(errors.join('；') || r.stderr || `退出码 ${r.code}`, bin));
  if (!text.trim()) throw new Error(friendly(errors.join('；') || r.stderr, bin));
  return { text };
}
