// 命令审批：从一条命令里认出要运行哪些程序，判断「一直允许」的记录能不能直接放行。
import fs from 'node:fs';
import path from 'node:path';

// 用 &&、||、|、;、& 和换行连起来的每一段都算一条命令（拆多了只会多问一次，不会漏问）
const SEGMENTS = /&&|\|\||[|;&\n]/;
// 命令里再套命令（$(…)、反引号），里面跑什么看不出来：不自动放行
const NESTED = /\$\(|`/;

const PROGRAM_NAME = /^[\w.+-]{1,60}$/;
const PROGRAM_EXT = /\.(exe|cmd|bat|ps1|com)$/;
const NEVER_ALLOW = new Set(['sh', 'bash', 'zsh', 'cmd', 'powershell', 'pwsh']);
const WINDOWS_EXECUTABLES = ['.exe', '.cmd', '.bat', '.com'];

function canRememberProgram(p) {
  return typeof p === 'string' && PROGRAM_NAME.test(p) && !NEVER_ALLOW.has(p.toLowerCase().replace(PROGRAM_EXT, ''));
}

function programOf(segment) {
  let s = segment.trim().replace(/^[({!\s]+/, '');
  s = s.replace(/^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, ''); // 开头的环境变量赋值
  const m = s.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (!m) return '';
  const raw = (m[1] || m[2] || m[3]).toLowerCase();
  return /[\\/]/.test(raw) ? raw : raw.replace(PROGRAM_EXT, '');
}

// cmd.exe 会先在当前目录找同名程序；无法核实时也要逐次确认。
function hasLocalExecutable(cwd, program) {
  try {
    return WINDOWS_EXECUTABLES.some((ext) => fs.statSync(path.join(cwd, program + ext), { throwIfNoEntry: false })?.isFile());
  } catch { return true; }
}

/** 带路径的程序保留原路径；只有每一段都是可记住的裸程序名才能「一直允许」。 */
export function parseCommand(command, { cwd, platform = process.platform } = {}) {
  const text = String(command || '');
  const programs = [...new Set(text.split(SEGMENTS).map(programOf).filter(Boolean))];
  const nested = NESTED.test(text);
  const canAlways = !nested && programs.length > 0 && programs.every((p) =>
    canRememberProgram(p) && !(platform === 'win32' && cwd && hasLocalExecutable(cwd, p)));
  return { programs, nested, canAlways };
}

/** 每一段的程序都「一直允许」过，并且没有套命令，才直接放行。 */
export function isPreapproved(command, allowed = [], opts) {
  const { programs, canAlways } = parseCommand(command, opts);
  return canAlways && programs.every((p) => allowed.includes(p));
}

/** 「一直允许」的记录：只留合法的程序名，去重、排序。 */
export function normalizeAllowed(list) {
  const ok = (Array.isArray(list) ? list : []).filter(canRememberProgram).map((p) => p.toLowerCase());
  return [...new Set(ok)].sort();
}
