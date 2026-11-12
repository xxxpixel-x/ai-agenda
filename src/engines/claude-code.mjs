// Claude Code（本机命令行，headless 模式）。使用 Claude Code 自己的登录，不需要 API key。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findOnPath, isFile, capture, runJsonl, brief, relPath } from './proc.mjs';

export const meta = {
  id: 'claude-code',
  label: 'Claude Code',
  kind: 'cli',
  vendor: 'Anthropic',
  defaultName: 'Claude',
  color: '#d97757',
  models: [['', '默认'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable']],
  efforts: [['', '默认'], ['low', '快'], ['medium', '中'], ['high', '深']],
  capabilities: '读写共享文件、联网搜索',
};

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
    return { available: false, ready: false, note: '没有找到 Claude Code。安装 Claude 桌面 app 或 Claude Code 命令行后重新检测。' };
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
    note: loggedIn ? `已登录（${method}）` : '还没有登录。在终端运行下面的命令，在弹出的浏览器里用你的 Claude 账号登录：',
    command: loggedIn ? null : loginCmd(bin),
  };
}

// 按权限档位开放的工具
const TOOLS = {
  read: 'Read,Glob,Grep,WebSearch,WebFetch',
  edit: 'Read,Edit,Write,Glob,Grep,WebSearch,WebFetch',
  run: 'Read,Edit,Write,Glob,Grep,WebSearch,WebFetch,Bash,PowerShell',
};

function activityOf(block, cwd) {
  const i = block.input || {};
  switch (block.name) {
    case 'Read': return { kind: 'read', label: `读取 ${relPath(i.file_path, cwd)}` };
    case 'Edit': case 'MultiEdit': return { kind: 'edit', label: `修改 ${relPath(i.file_path, cwd)}` };
    case 'Write': return { kind: 'edit', label: `写入 ${relPath(i.file_path, cwd)}` };
    case 'Glob': case 'Grep': return { kind: 'read', label: `查找 ${brief(i.pattern, 40)}` };
    case 'WebSearch': return { kind: 'search', label: `搜索：${brief(i.query, 60)}` };
    case 'WebFetch': return { kind: 'search', label: `打开网页 ${brief(i.url, 60)}` };
    case 'Bash': case 'PowerShell': return { kind: 'command', label: `运行 ${brief(i.command, 70)}` };
    default: return { kind: 'tool', label: block.name };
  }
}

function friendly(text, bin) {
  const t = brief(text, 300);
  if (/not logged in|\/login|invalid api key|authentication/i.test(t)) {
    return `Claude Code 还没有登录（${t}）。请在终端运行 ${loginCmd(bin)}，登录后再试。`;
  }
  if (/rate limit|usage limit|limit reached|\b429\b/i.test(t)) return `Claude 账号额度已用完或被限流（${t}）。`;
  return t || 'Claude Code 没有返回内容';
}

/**
 * 平时每次发言都是一次性的（不保存会话）。
 * sessionId：接续导入的 Claude Code 对话。fork 为 true 时先复制一份再接（原会话不动），返回新的会话 ID。
 * 接续时用 --system-prompt-snapshot off，否则会一直沿用原会话第一次记下的系统提示，圆桌的规则传不进去。
 */
export async function runTurn({ system, prompt, model, effort, cwd, access = 'edit', signal, onDelta, onActivity, onRaw, binOverride, sessionId, fork = false }) {
  const bin = findBin(binOverride);
  if (!bin) throw new Error('没有找到 Claude Code');
  const sysFile = path.join(os.tmpdir(), `rt-sys-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(sysFile, system, 'utf8');
  const tools = TOOLS[access] || TOOLS.edit;

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--append-system-prompt-file', sysFile,
    '--tools', tools,
    '--allowedTools', tools,
    '--permission-mode', access === 'read' ? 'default' : 'acceptEdits',
    '--permission-prompts', 'none', // 没人能回答弹窗：未放行的操作直接拒绝
    '--safe-mode',            // 不加载个人的 CLAUDE.md / 插件 / hooks / MCP
    '--strict-mcp-config',
  ];
  if (sessionId) {
    args.push('--resume', sessionId, '--system-prompt-snapshot', 'off');
    if (fork) args.push('--fork-session');
  } else {
    args.push('--no-session-persistence');
  }
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);

  let text = '';
  let result = null;
  let blocks = 0;
  const emit = (t) => { if (t) { text += t; onDelta?.(t); } };

  try {
    const r = await runJsonl({
      cmd: bin,
      args,
      cwd,
      input: prompt,
      signal,
      onRaw,
      onEvent(msg) {
        if (msg.type === 'stream_event') {
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
        } else if (msg.type === 'result') {
          result = msg;
        }
      },
    });
    const fail = (why) => {
      const err = new Error(friendly(why, bin));
      if (sessionId && /no conversation found|session.*not found/i.test(String(why))) err.resumeFailed = true;
      return err;
    };
    if (result?.is_error) throw fail(result.result || result.subtype);
    if (!result && r.code !== 0) throw fail(r.stderr || `退出码 ${r.code}`);
    if (!text && result?.result) emit(result.result);
    if (!text.trim()) throw fail(r.stderr);
    return { text, sessionId: sessionId ? result?.session_id || null : undefined };
  } finally {
    fs.rm(sysFile, { force: true }, () => {});
  }
}
