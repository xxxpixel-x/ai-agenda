// DeepSeek Harness（DeepSeek 官方桌面版自带的命令行 dsh，headless 模式）。使用它自己的登录。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isFile, isWin, capture, runJsonl, brief, relPath } from './proc.mjs';

export const meta = {
  id: 'dsh',
  label: 'DeepSeek Harness',
  kind: 'cli',
  vendor: 'DeepSeek',
  defaultName: 'DeepSeek',
  color: '#4d6bfe',
  models: [['', '默认']],
  efforts: [['', '默认']],
  resume: true, // 每个成员复用同一个 dsh 会话，避免在 DeepSeek Harness 里留下一大串会话
  capabilities: '读写共享文件、在共享文件夹内运行命令',
};

const EXE = 'DeepSeek Harness.exe';
const cliOf = (root) => path.join(root, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');

// 从注册表的卸载信息里找安装位置
function findInRegistry() {
  if (!isWin) return Promise.resolve(null);
  const keys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const one = (key) => new Promise((resolve) => {
    execFile('reg', ['query', key, '/s', '/f', 'DeepSeek Harness', '/d'], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      const text = String(stdout || '');
      const m = text.match(/(?:InstallLocation|DisplayIcon|UninstallString)\s+REG_\w+\s+"?([A-Za-z]:\\[^"\r\n,]*)/i);
      if (!m) return resolve(null);
      let dir = m[1].trim();
      if (/\.exe$/i.test(dir)) dir = path.dirname(dir);
      resolve(isFile(path.join(dir, EXE)) ? dir : null);
    });
  });
  return keys.reduce((p, k) => p.then((found) => found || one(k)), Promise.resolve(null));
}

let cachedRoot = null;
export async function findRoot(override) {
  // override 可以是安装目录，也可以是 exe 路径
  if (override) {
    const dir = /\.exe$/i.test(override) ? path.dirname(override) : override;
    if (isFile(path.join(dir, EXE))) return dir;
  }
  if (cachedRoot && isFile(path.join(cachedRoot, EXE))) return cachedRoot;
  const guesses = [
    process.env.DSH_ROOT,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'deepseek-harness'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'deepseek-harness'),
  ].filter(Boolean);
  cachedRoot = guesses.find((d) => isFile(path.join(d, EXE))) || await findInRegistry();
  return cachedRoot;
}

function command(root, rest) {
  return {
    cmd: path.join(root, EXE),
    args: ['--expose-internals', cliOf(root), ...rest],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

export async function detect({ binOverride } = {}) {
  const root = await findRoot(binOverride);
  if (!root) return { available: false, ready: false, note: '没有找到 DeepSeek Harness。安装后重新检测，或在下面手动填写安装目录。' };
  const c = command(root, ['--version']);
  const ver = await capture(c.cmd, c.args, { env: c.env });
  const hasCred = fs.existsSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'));
  return {
    available: true,
    ready: hasCred,
    bin: path.join(root, EXE),
    version: brief(ver.stdout, 30),
    note: hasCred ? '已登录' : '还没有登录。请打开 DeepSeek Harness 桌面版登录一次。',
  };
}

function activityOf(ev, cwd) {
  const i = ev.input || {};
  const file = relPath(i.file_path || i.path || i.filePath, cwd);
  switch (String(ev.tool || '').toLowerCase()) {
    case 'read': return { kind: 'read', label: `读取 ${file}` };
    case 'edit': case 'multi_edit': case 'multiedit': return { kind: 'edit', label: `修改 ${file}` };
    case 'write': return { kind: 'edit', label: `写入 ${file}` };
    case 'glob': case 'grep': case 'ls': case 'list': return { kind: 'read', label: `查找 ${brief(i.pattern || i.path || '', 40)}` };
    case 'bash': case 'shell': case 'exec': case 'powershell': return { kind: 'command', label: `运行 ${brief(i.command || i.cmd || '', 70)}` };
    case 'web_search': case 'websearch': case 'search': return { kind: 'search', label: `搜索：${brief(i.query || '', 60)}` };
    case 'web_fetch': case 'webfetch': case 'fetch': return { kind: 'search', label: `打开网页 ${brief(i.url || '', 60)}` };
    default: return { kind: 'tool', label: String(ev.tool || '工具') };
  }
}

export async function runTurn({ system, prompt, cwd, access = 'edit', signal, onDelta, onActivity, onRaw, sessionId, binOverride }) {
  const root = await findRoot(binOverride);
  if (!root) throw new Error('没有找到 DeepSeek Harness');

  // approval-policy never：需要批准的操作直接拒绝（没人能在后台点批准）
  const preset = access === 'read' ? 'read-only' : 'workspace-write';
  const rest = ['headless', '--json', '--permission-mode', preset, '--approval-policy', 'never'];
  if (sessionId) rest.push('--session-id', sessionId);
  rest.push('-');
  const c = command(root, rest);

  let text = '';
  let final = null;
  let newSession = sessionId || null;
  let steps = 0;
  const emit = (t) => { if (t) { text += t; onDelta?.(t); } };

  const r = await runJsonl({
    cmd: c.cmd,
    args: c.args,
    env: c.env,
    cwd,
    // 续接已有会话时，规则在第一次已经给过了
    input: sessionId ? prompt : `${system}\n\n${prompt}`,
    signal,
    onRaw,
    onEvent(ev) {
      if (ev.type === 'session') newSession = ev.sessionId || newSession;
      else if (ev.type === 'text') {
        if (steps++ > 0 && text && !text.endsWith('\n')) emit('\n\n');
        emit(ev.text);
      } else if (ev.type === 'tool_call') onActivity?.(activityOf(ev, cwd));
      else if (ev.type === 'final') final = ev;
    },
  });

  if (!final) {
    const why = brief(r.stderr || `退出码 ${r.code}`, 300);
    const err = new Error(`DeepSeek Harness 没有返回结果：${why}`);
    // 会话找不到时让调用方换新会话重试
    if (sessionId && /session/i.test(why)) err.resumeFailed = true;
    throw err;
  }
  const kind = final.reason?.kind;
  if (kind && kind !== 'completed') {
    throw new Error(`DeepSeek Harness 未完成（${kind}）：${brief(final.reason?.message || final.text || '', 300)}`);
  }
  if (!text && final.text) emit(final.text);
  if (!text.trim()) throw new Error('DeepSeek Harness 没有返回内容');
  return { text, sessionId: newSession };
}
