// 命令审批：从一条命令里认出要运行哪些程序，判断「一直允许」的记录能不能直接放行。

// 用 &&、||、|、;、& 和换行连起来的每一段都算一条命令（拆多了只会多问一次，不会漏问）
const SEGMENTS = /&&|\|\||[|;&\n]/;
// 命令里再套命令（$(…)、反引号），里面跑什么看不出来：不自动放行
const NESTED = /\$\(|`/;

function programOf(segment) {
  let s = segment.trim().replace(/^[({!\s]+/, '');
  s = s.replace(/^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, ''); // 开头的环境变量赋值
  const m = s.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (!m) return '';
  const name = (m[1] || m[2] || m[3]).split(/[\\/]/).pop().toLowerCase();
  return name.replace(/\.(exe|cmd|bat|ps1|com)$/, '');
}

/** { programs: 用到的程序名（小写、去掉路径和扩展名）, nested: 是否套了命令 } */
export function parseCommand(command) {
  const text = String(command || '');
  const programs = [...new Set(text.split(SEGMENTS).map(programOf).filter(Boolean))];
  return { programs, nested: NESTED.test(text) };
}

/** 每一段的程序都「一直允许」过，并且没有套命令，才直接放行。 */
export function isPreapproved(command, allowed = []) {
  const { programs, nested } = parseCommand(command);
  return !nested && programs.length > 0 && programs.every((p) => allowed.includes(p));
}

/** 「一直允许」的记录：只留合法的程序名，去重、排序。 */
export function normalizeAllowed(list) {
  const ok = (Array.isArray(list) ? list : []).filter((p) => typeof p === 'string' && /^[\w.+-]{1,60}$/.test(p)).map((p) => p.toLowerCase());
  return [...new Set(ok)].sort();
}
