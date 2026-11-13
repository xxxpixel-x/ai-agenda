// OpenAI Codex 命令行（codex exec）。使用 Codex 自己的登录（ChatGPT 账号或其配置的服务商）。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findOnPath, isFile, isWin, capture, runJsonl, brief } from './proc.mjs';

export const meta = {
  id: 'codex',
  label: 'Codex',
  kind: 'cli',
  vendor: 'OpenAI',
  defaultName: 'Codex',
  color: '#10a37f',
  models: [['', '默认']],
  freeModel: true, // 允许手动填模型名
  efforts: ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], // 具体型号支持哪些，detect 时从 codex debug models 查
  capabilities: '读写共享文件、在共享文件夹内运行命令（沙箱）、联网搜索',
};

// Windows 上 Codex 桌面版是应用商店应用，codex.exe 在包目录里，需要问系统要安装位置
let storeLookup = null;
function findInStorePackage() {
  if (!isWin) return Promise.resolve(null);
  storeLookup ||= new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation'],
    { windowsHide: true, timeout: 20000 }, (err, stdout) => {
      const loc = String(stdout || '').trim();
      const exe = loc ? path.join(loc, 'app', 'resources', 'codex.exe') : null;
      resolve(exe && isFile(exe) ? exe : null);
    });
  });
  return storeLookup;
}

export async function findBin(override) {
  if (override && isFile(override)) return override;
  if (process.env.CODEX_BIN && isFile(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
  const onPath = findOnPath('codex');
  if (onPath) return onPath;
  const found = await findInStorePackage();
  if (!found) storeLookup = null; // 之后装了还能再找到
  return found;
}

export async function detect({ binOverride } = {}) {
  const bin = await findBin(binOverride);
  if (!bin) return { available: false, ready: false, note: '没有找到 Codex。安装 Codex 桌面版或 Codex 命令行后重新检测。' };
  const [ver, login, catalog] = await Promise.all([capture(bin, ['--version']), capture(bin, ['login', 'status']), capture(bin, ['debug', 'models'])]);
  const status = brief(login.stdout || login.stderr, 120);
  const loggedIn = login.ok && /logged in/i.test(status) && !/not logged in/i.test(status);
  return {
    available: true,
    ready: loggedIn,
    bin,
    version: brief(ver.stdout, 40),
    ...modelsOf(catalog.stdout),
    note: loggedIn ? `已登录（${status}）` : `还没有登录（${status || '未知状态'}）。打开 Codex 桌面版登录，或在终端运行：`,
    command: loggedIn ? null : `& "${bin}" login`,
  };
}

// codex debug models 输出的型号目录：可选的型号，以及每个型号支持的思考档位
function modelsOf(json) {
  let list;
  try { list = JSON.parse(json).models; } catch { return {}; }
  if (!Array.isArray(list)) return {};
  const shown = list.filter((m) => m?.slug && m.visibility !== 'hide').sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  return {
    models: shown.map((m) => [m.slug, m.display_name || m.slug]),
    efforts: Object.fromEntries(shown.map((m) => [m.slug, (m.supported_reasoning_levels || []).map((l) => l.effort).filter(Boolean)])),
  };
}

function shortCommand(cmd) {
  // Codex 在 Windows 上用 PowerShell 包了一层，去掉外壳只留真正的命令
  let c = String(cmd || '');
  const m = c.match(/powershell(?:\.exe)?"?\s+-Command\s+(.*)$/is);
  if (m) c = m[1].replace(/^['"]|['"]$/g, '');
  return brief(c.replace(/\s+/g, ' '), 70);
}

// 除了「全部权限」，不让 Codex 用上你账号和个人配置里的外部连接：
// 应用连接器（Gmail、Slack、GitHub…）、插件、hooks、MCP 服务。型号、登录等其余设置照旧。
export function isolationArgs(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  const args = ['--disable', 'apps', '--disable', 'plugins', '--disable', 'hooks', '-c', 'notify=[]'];
  let config = '';
  try { config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch { /* 没有个人配置 */ }
  const names = new Set([...config.matchAll(/^\s*\[mcp_servers\.("[^"\n]+"|'[^'\n]+'|[\w-]+)\]/gm)].map((m) => m[1]));
  for (const name of names) args.push('-c', `mcp_servers.${name}.enabled=false`);
  return args;
}

export async function runTurn({ system, prompt, model, effort, cwd, access = 'edit', signal, onDelta, onActivity, onRaw, binOverride }) {
  const bin = await findBin(binOverride);
  if (!bin) throw new Error('没有找到 Codex');

  // Codex 的沙箱：只读档 = read-only；全部权限 = 不设沙箱；其余 = 只能写共享文件夹（它运行命令也被限制在这个沙箱里）
  const sandbox = access === 'read' ? 'read-only' : access === 'full' ? 'danger-full-access' : 'workspace-write';
  const args = ['--search', 'exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', sandbox, '-C', cwd];
  if (access !== 'full') args.push(...isolationArgs());
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  args.push('-');

  let text = '';
  let failure = null;
  const warnings = [];
  const emit = (t) => {
    if (!t) return;
    const piece = (text ? '\n\n' : '') + t.trim();
    text += piece;
    onDelta?.(piece);
  };

  const r = await runJsonl({
    cmd: bin,
    args,
    cwd,
    input: `${system}\n\n${prompt}`,
    signal,
    onRaw,
    onEvent(ev, ctl) {
      const item = ev.item || {};
      if (ev.type === 'item.started') {
        if (item.type === 'command_execution') onActivity?.({ kind: 'command', label: `运行 ${shortCommand(item.command)}` });
        else if (item.type === 'web_search' && item.query) onActivity?.({ kind: 'search', label: `搜索：${brief(item.query, 60)}` });
      } else if (ev.type === 'item.completed') {
        if (item.type === 'agent_message') emit(item.text);
        else if (item.type === 'file_change') {
          // changes 可能是数组 [{ path }]，也可能是 { 路径: {...} }
          const list = Array.isArray(item.changes) ? item.changes.map((c) => c.path) : Object.keys(item.changes || {});
          for (const p of list) onActivity?.({ kind: 'edit', label: `修改 ${path.basename(p || '')}` });
        } else if (item.type === 'web_search' && item.query) onActivity?.({ kind: 'search', label: `搜索：${brief(item.query, 60)}` });
        else if (item.type === 'mcp_tool_call') onActivity?.({ kind: 'tool', label: `${item.server || ''} ${item.tool || ''}`.trim() || '工具' });
        else if (item.type === 'error' && !/Ignored unsupported/i.test(item.message || '')) warnings.push(item.message);
      } else if (ev.type === 'turn.completed') {
        ctl.finish(); // 回合结束后进程还会逗留几十秒，不等它
      } else if (ev.type === 'turn.failed') {
        failure = ev.error?.message || '回合失败';
        ctl.finish();
      } else if (ev.type === 'error') {
        failure = ev.message || '未知错误';
      }
    },
  });

  if (failure) throw new Error(`Codex：${brief(failure, 300)}`);
  if (!text.trim()) {
    const why = warnings[0] || r.stderr || `退出码 ${r.code}`;
    throw new Error(`Codex 没有返回内容：${brief(why, 300)}`);
  }
  return { text };
}
