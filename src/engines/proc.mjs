// 各命令行引擎共用的进程工具：查找可执行文件、启动、逐行读 JSON、可靠地结束进程树。
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const isWin = process.platform === 'win32';

export const isFile = (p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};

/** 在 PATH 里按名字找可执行文件（Windows 下依次尝试 .exe / .cmd）。 */
export function findOnPath(names) {
  const list = Array.isArray(names) ? names : [names];
  const exts = isWin ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of list) {
      for (const ext of exts) {
        const p = path.join(dir, n + ext);
        if (isFile(p)) return p;
      }
    }
  }
  return null;
}

/** 运行一个短命令并拿到输出（用于 --version、登录状态等探测）。永不抛错。 */
export function capture(cmd, args, { timeout = 20000, env, cwd, input } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnSmart(cmd, args, { env, cwd });
    } catch (e) {
      return resolve({ ok: false, code: -1, stdout: '', stderr: e.message });
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => killTree(child), timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: -1, stdout, stderr: stderr || e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}

const quoteForCmd = (a) => `"${String(a).replace(/"/g, '""')}"`;

/**
 * 启动子进程。.cmd / .bat 只能经 cmd.exe 启动，这时手动给参数加引号；
 * 其他情况直接以参数数组启动（不经过 shell，无转义问题）。
 */
export function spawnSmart(cmd, args, opts = {}) {
  const viaShell = isWin && /\.(cmd|bat)$/i.test(cmd);
  return spawn(viaShell ? quoteForCmd(cmd) : cmd, viaShell ? args.map(quoteForCmd) : args, {
    shell: viaShell,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
    env: { ...process.env, ...(opts.env || {}) },
  });
}

/** 结束进程及其所有子进程（命令行 agent 常常还会再起子进程）。 */
export function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (isWin) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  }
}

/**
 * npm 安装的命令行在 Windows 上是 .cmd 包装脚本。尽量解析出它真正要运行的 .js 入口，
 * 这样可以直接用 node 启动、避开 cmd.exe 的参数转义。解析不出来就返回 null。
 */
export function resolveNodeShim(cmdPath, depth = 0) {
  if (!/\.cmd$/i.test(cmdPath) || depth > 3) return null;
  let text;
  try { text = fs.readFileSync(cmdPath, 'utf8'); } catch { return null; }
  const dir = path.dirname(cmdPath);
  const js = text.match(/"%(?:~)?dp0%?\\?([^"%]+\.(?:js|mjs|cjs))"/i);
  if (js) {
    const p = path.resolve(dir, js[1]);
    if (isFile(p)) return p;
  }
  const next = text.match(/"%~dp0\\?([^"%]+\.cmd)"/i);
  if (next) return resolveNodeShim(path.resolve(dir, next[1]), depth + 1);
  return null;
}

/** 找一个能运行 .js 的 node：优先系统 node，其次用当前进程（Electron 以 node 模式运行）。 */
export function nodeRunner() {
  const sys = findOnPath('node');
  if (sys) return { cmd: sys, env: {} };
  return { cmd: process.execPath, env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
}

export class AbortedError extends Error {
  constructor() { super('已中止'); this.aborted = true; }
}

/**
 * 启动一个输出“每行一个 JSON”的命令行 agent 并等它完成。
 *  - onEvent(obj, ctl)：每解析出一行 JSON 调一次；ctl.finish() 表示“这一轮已经结束”，
 *    之后即使进程迟迟不退出也会被结束（Codex 回合结束后进程还会逗留几十秒）。
 *  - 返回 { code, stderr, finished }；被 signal 中止时抛 AbortedError。
 */
// inputDelay：过这么多毫秒再写入 stdin（给子进程留出启动时间）
export function runJsonl({ cmd, args, env, cwd, input = '', inputDelay = 0, signal, onEvent, onStderr, onRaw }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnSmart(cmd, args, { env, cwd });
    } catch (e) {
      return reject(new Error(`无法启动 ${path.basename(cmd)}：${e.message}`));
    }
    let settled = false;
    let finished = false;
    let buf = '';
    let stderr = '';
    let graceTimer = null;
    let inputTimer = null;

    const settle = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      clearTimeout(inputTimer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve(val);
    };
    const onAbort = () => { killTree(child); settle(new AbortedError()); };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const ctl = {
      finish() {
        if (finished) return;
        finished = true;
        // 给进程一点时间自己退出，否则强制结束
        graceTimer = setTimeout(() => { killTree(child); settle(null, { code: 0, stderr, finished: true }); }, 1500);
      },
    };
    // 设置环境变量 RT_DEBUG_DIR 后，把各 AI 输出的原始事件写进该目录，便于排查
    const debugFile = process.env.RT_DEBUG_DIR
      ? path.join(process.env.RT_DEBUG_DIR, `${path.basename(cmd).replace(/\W+/g, '_')}-${Date.now()}.jsonl`)
      : null;
    const feed = (line) => {
      line = line.trim();
      if (debugFile && line) { try { fs.appendFileSync(debugFile, `${line}\n`); } catch { /* ignore */ } }
      if (line) onRaw?.(line);
      if (!line || line[0] !== '{') return;
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      try { onEvent(obj, ctl); } catch (e) { console.error('事件处理出错：', e); }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        feed(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
      onStderr?.(String(d));
      for (const l of String(d).split('\n')) if (l.trim()) onRaw?.(`[stderr] ${l.trimEnd()}`);
    });
    child.on('error', (e) => settle(new Error(`无法启动 ${path.basename(cmd)}：${e.message}`)));
    child.on('close', (code) => {
      if (buf.trim()) feed(buf);
      settle(null, { code, stderr, finished });
    });
    child.stdin.on('error', () => { /* 进程提前退出时的 EPIPE */ });
    if (inputDelay > 0) inputTimer = setTimeout(() => child.stdin.end(input, 'utf8'), inputDelay);
    else child.stdin.end(input, 'utf8');
  });
}

/** 把很长的报错压成适合显示的一小段。 */
export function brief(text, max = 400) {
  const t = String(text || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 缩短工具参数里的路径，只留相对工作区的部分。 */
export function relPath(p, cwd) {
  if (!p) return '';
  const s = String(p);
  try {
    const rel = path.relative(cwd, path.resolve(cwd, s));
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
  } catch { /* fallthrough */ }
  return path.basename(s);
}
