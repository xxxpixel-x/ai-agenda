import fs from 'node:fs';
import path from 'node:path';
import { t as tr } from '../../i18n.mjs';
import { AbortedError, brief, isFile, relPath } from '../proc.mjs';

const readTools = ['read', 'grep', 'find', 'ls'];
const fileTools = [...readTools, 'write', 'edit'];

export function toolsFor(access, shell = 'bash') {
  if (access === 'full' || access === 'run') return [...fileTools, shell.tool || shell];
  return [...(access === 'edit' ? fileTools : readTools)];
}

let cachedShell;
export function findShell(options) {
  if (!options) return cachedShell ??= findShell({ platform: process.platform, env: process.env, isFile });
  const { platform, env, isFile: exists } = options;
  if (platform !== 'win32') return { tool: 'bash' };
  const win = path.win32;
  const dirs = (env.PATH || env.Path || '').split(';').map((dir) => dir.replace(/^"|"$/g, '')).filter((dir) => win.isAbsolute(dir));
  const standard = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)
    .map((dir) => win.join(dir, 'Git', 'bin', 'bash.exe')).find(exists);
  if (standard) return { tool: 'bash', shellPath: standard };
  for (const dir of dirs) {
    if (!exists(win.join(dir, 'git.exe'))) continue;
    const parent = win.dirname(dir);
    const root = /^mingw64$/i.test(win.basename(parent)) ? win.dirname(parent) : parent;
    const shellPath = win.join(root, 'bin', 'bash.exe');
    if (exists(shellPath)) return { tool: 'bash', shellPath };
  }
  const system32 = win.join(env.SystemRoot || 'C:\\Windows', 'System32').toLowerCase();
  const shellPath = dirs.filter((dir) => {
    const name = win.normalize(dir).toLowerCase();
    return name !== system32 && !name.startsWith(system32 + '\\') && !name.split('\\').includes('windowsapps');
  }).map((dir) => win.join(dir, 'bash.exe')).find(exists);
  return shellPath ? { tool: 'bash', shellPath } : { tool: 'powershell' };
}

function contains(root, target) {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

export function insideDir(target, cwd) {
  let p = path.resolve(cwd, target || '.');
  if (!contains(cwd, p)) return false;
  try {
    const root = fs.realpathSync.native(cwd);
    // 新文件可能还缺好几层目录。遇到断链、无权访问等情况一律拒绝。
    while (!fs.lstatSync(p, { throwIfNoEntry: false })) p = path.dirname(p);
    return contains(root, fs.realpathSync.native(p));
  } catch { return false; }
}

export function activityOf({ toolName, args }, cwd) {
  const file = relPath(args?.path, cwd);
  switch (toolName) {
    case 'read': return { kind: 'read', label: tr('读取 {0}', [file]) };
    case 'grep': case 'find': case 'ls': return { kind: 'read', label: tr('查找 {0}', [brief(args?.pattern || file || '.', 40)]) };
    case 'write': return { kind: 'edit', label: tr('写入 {0}', [file]) };
    case 'edit': return { kind: 'edit', label: tr('修改 {0}', [file]) };
    case 'bash': case 'powershell': return { kind: 'command', label: tr('运行 {0}', [brief(args?.command, 70)]) };
    default: return { kind: 'tool', label: toolName };
  }
}

async function approvalFor(command, onApproval, signal) {
  if (signal?.aborted) throw new AbortedError();
  if (!signal) return onApproval({ command });
  let stop;
  const stopped = new Promise((_, reject) => { stop = () => reject(new AbortedError()); });
  signal.addEventListener('abort', stop, { once: true });
  try {
    return await Promise.race([stopped, onApproval({ command })]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

export function permissionExtension({ access, cwd, tools, onApproval, signal, paths }) {
  const notes = new Map();
  return (api) => {
    api.on('tool_call', async ({ toolName, toolCallId, input }) => {
      const mcp = toolName.startsWith('mcp__');
      if (!tools.includes(toolName) && !(mcp && ['run', 'full'].includes(access))) {
        return { block: true, reason: tr('超出了当前权限。') };
      }
      if (access === 'full') return;
      if (fileTools.includes(toolName)) {
        // 先按 pi 的规则展开 @、~、file URL、Windows 的 /c/ 等，再检查实际访问的路径。
        const target = paths.resolveToCwd(input.path || '.', cwd);
        if (!insideDir(target, cwd) || (toolName === 'read' && !insideDir(paths.resolveReadPath(input.path || '.', cwd), cwd))) {
          return { block: true, reason: tr('只能访问共享文件夹里的文件') };
        }
      } else if (access === 'run' && onApproval) {
        const command = mcp ? brief(`${toolName} ${JSON.stringify(input)}`, 199) : input.command;
        const { allow, note } = await approvalFor(command, onApproval, signal);
        if (!allow || signal?.aborted) {
          const reason = note ? tr('，理由：{0}', [note]) : '';
          return { block: true, reason: tr('「我」没有同意运行这条命令{0}。按这个调整做法，不要换一种写法绕过。', [reason]) };
        }
        if (note) notes.set(toolCallId, note);
      }
    });
    api.on('tool_result', ({ toolCallId, content }) => {
      const note = notes.get(toolCallId);
      if (!note) return;
      notes.delete(toolCallId);
      return { content: [...content, { type: 'text', text: tr('「我」同意了刚才那条命令，并补充：{0}', [note]) }] };
    });
  };
}
