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
  efforts: ['', 'off', 'low', 'medium', 'high', 'xhigh', 'max'], // 具体型号支持哪些，detect 时从型号目录查
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
  const [ver, models] = await Promise.all([capture(c.cmd, c.args, { env: c.env }), modelsFor(root)]);
  const hasCred = fs.existsSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'));
  return {
    available: true,
    ready: hasCred,
    bin: path.join(root, EXE),
    version: brief(ver.stdout, 30),
    ...models,
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

// 型号 / 思考档位：headless 没有对应参数，用 --patch 临时叠一层配置（不改用户自己的配置文件）。
// 叠加层要同时写服务商和型号，所以先读出当前配置。
let cfgCache = { root: null, at: 0, value: null };
async function readConfig(root) {
  if (cfgCache.root === root && Date.now() - cfgCache.at < 60_000) return cfgCache.value;
  const c = command(root, ['--profile', 'headless', '--dump-config']);
  const r = await capture(c.cmd, c.args, { env: c.env });
  const text = String(r.stdout || '').replace(/\r/g, '');
  const block = (id) => (text.match(new RegExp(`^- id: ${id}\\n((?:[ \\t].*(?:\\n|$))*)`, 'm')) || [])[1] || '';
  const field = (b, k) => {
    const v = (b.match(new RegExp(`^\\s+${k}:[ \\t]*(.+)$`, 'm')) || [])[1]?.trim() || '';
    return v.startsWith('!!') ? '' : v.replace(/^(['"])(.*)\1$/, '$2');
  };
  const agent = block('agent-default-model');
  const value = { provider: field(agent, 'provider'), model: field(agent, 'model'), planTier: field(block('commandcode-plans-provider'), 'planTier') };
  if (r.ok) cfgCache = { root, at: Date.now(), value };
  return value;
}

// commandcode 服务商的型号目录：和它的插件读同一份官方文件（Min plan 列决定套餐能不能用，Efforts 列是支持的档位）
const CATALOG_URL = 'https://unpkg.com/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md';
const TIERS = ['go', 'goat', 'pro', 'max'];
const GATEWAY_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
let catalogCache = { at: 0, rows: null };
async function commandcodeCatalog() {
  if (catalogCache.rows && Date.now() - catalogCache.at < 10 * 60_000) return catalogCache.rows;
  const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = [];
  let col = null;
  for (const line of (await res.text()).split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((s) => s.trim());
    const head = cells.map((s) => s.toLowerCase());
    if (head.includes('min plan')) { col = { name: head.indexOf('name'), efforts: head.indexOf('efforts'), plan: head.indexOf('min plan') }; continue; }
    if (!col || !cells[0].startsWith('`')) continue;
    // 插件的规则：有档位的型号多一个 off（不传档位）
    const levels = String(cells[col.efforts] || '').split(',').map((s) => s.trim()).filter((s) => GATEWAY_EFFORTS.includes(s));
    rows.push({
      id: cells[0].replace(/`/g, ''),
      name: cells[col.name] || '',
      tier: TIERS.indexOf(String(cells[col.plan] || '').split(/\s+/)[0].toLowerCase()),
      efforts: levels.length ? ['off', ...levels] : [],
    });
  }
  if (!rows.length) throw new Error('型号目录是空的');
  catalogCache = { at: Date.now(), rows };
  return rows;
}

async function modelsFor(root) {
  const cfg = await readConfig(root);
  const out = cfg.model ? { defaultModel: cfg.model } : {};
  if (cfg.provider !== 'commandcode') return out;
  try {
    const tier = TIERS.includes(cfg.planTier) ? TIERS.indexOf(cfg.planTier) : TIERS.length - 1;
    const rows = (await commandcodeCatalog()).filter((r) => r.tier >= 0 && r.tier <= tier);
    return { ...out, models: rows.map((r) => [r.id, r.name]), efforts: Object.fromEntries(rows.map((r) => [r.id, r.efforts])) };
  } catch {
    return out;
  }
}

async function writePatch(root, model, effort) {
  const cfg = await readConfig(root);
  const name = model || cfg.model;
  if (!cfg.provider || !name) return null;
  const lines = [
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    `    provider: ${JSON.stringify(cfg.provider)}`,
    `    model: ${JSON.stringify(name)}`,
  ];
  if (effort) lines.push(`    reasoningEffort: ${JSON.stringify(effort)}`);
  const file = path.join(os.tmpdir(), `rt-dsh-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.yml`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

// commandcode 插件启动后要联网加载型号目录（几秒），加载完之前带档位的请求会被拒：等一会儿再发一次
const EFFORT_RETRY_DELAY = 12_000;

export async function runTurn({ system, prompt, model, effort, cwd, access = 'edit', signal, onDelta, onActivity, onRaw, sessionId, binOverride }) {
  const root = await findRoot(binOverride);
  if (!root) throw new Error('没有找到 DeepSeek Harness');
  const patch = model || effort ? await writePatch(root, model, effort) : null;

  async function once(inputDelay) {
    // approval-policy never：需要批准的操作直接拒绝（没人能在后台点批准）
    const preset = access === 'read' ? 'read-only' : access === 'full' ? 'danger-full-access' : 'workspace-write';
    const rest = ['headless'];
    if (patch) rest.push('--patch', patch); // 必须紧跟在 headless 后面，否则会被当成 headless 自己的参数
    rest.push('--json', '--permission-mode', preset, '--approval-policy', 'never');
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
      inputDelay,
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
    const reason = final.reason || {};
    const why = reason.error?.message || reason.message || final.text || '';
    if (reason.error?.code === 'UNSUPPORTED_REASONING_EFFORT' && !text) return { effortRejected: true, why };
    if (reason.kind && reason.kind !== 'completed') {
      throw new Error(`DeepSeek Harness 未完成（${reason.kind}）：${brief(why, 300)}`);
    }
    if (!text && final.text) emit(final.text);
    if (!text.trim()) throw new Error('DeepSeek Harness 没有返回内容');
    return { text, sessionId: newSession };
  }

  try {
    let r = await once(0);
    if (r.effortRejected) r = await once(EFFORT_RETRY_DELAY);
    if (r.effortRejected) throw new Error(`DeepSeek Harness 不接受这个思考档位：${brief(r.why, 300)}`);
    return r;
  } finally {
    if (patch) fs.rm(patch, { force: true }, () => {});
  }
}
