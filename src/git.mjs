// git 辅助：任务协作模式用它给每个 AI 建独立副本（git worktree）、提交、对比、合并。
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const IDENTITY = (name) => ['-c', `user.name=${name}`, '-c', 'user.email=agenda@localhost', '-c', 'core.quotepath=false'];

export function git(args, { cwd, input, author = 'Agenda', allowFail = false, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...IDENTITY(author), ...args], {
      cwd, timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C.UTF-8' },
    }, (err, stdout, stderr) => {
      if (err && !allowFail) {
        const e = new Error(`git ${args[0]} 失败：${String(stderr || err.message).trim().slice(0, 500)}`);
        e.stdout = stdout; e.stderr = stderr; e.code = err.code;
        return reject(e);
      }
      resolve({ ok: !err, code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || '' });
    });
    if (input != null) child.stdin.end(input);
  });
}

let available = null;
export async function gitAvailable() {
  if (available === null) available = (await git(['--version'], { allowFail: true }).catch(() => ({ ok: false }))).ok;
  return available;
}

/** 文件夹所在 git 仓库的信息；不是仓库返回 null。 */
export async function repoInfo(dir) {
  if (!(await gitAvailable())) return null;
  const top = await git(['rev-parse', '--show-toplevel'], { cwd: dir, allowFail: true });
  if (!top.ok) return null;
  const head = await git(['rev-parse', 'HEAD'], { cwd: dir, allowFail: true });
  if (!head.ok) return { root: top.stdout.trim(), noCommits: true };
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })).stdout.trim();
  const status = (await git(['status', '--porcelain'], { cwd: dir })).stdout.split('\n').filter(Boolean);
  const tracked = status.filter((l) => !l.startsWith('??'));
  return {
    root: top.stdout.trim(), head: head.stdout.trim(), branch,
    dirty: status.length > 0, dirtyFiles: status.length,      // 含未跟踪的文件（AI 的副本里看不到它们）
    dirtyTracked: tracked.length,                           // 已跟踪文件的未提交改动（会挡住合并）
  };
}

export const headOf = async (cwd, ref = 'HEAD') => (await git(['rev-parse', ref], { cwd })).stdout.trim();

export async function addWorktree(repo, wtPath, branch, base) {
  await git(['worktree', 'add', '--no-track', '-b', branch, wtPath, base], { cwd: repo });
}

export async function removeWorktree(repo, wtPath, branch) {
  if (wtPath && fs.existsSync(wtPath)) await git(['worktree', 'remove', '--force', wtPath], { cwd: repo, allowFail: true });
  await git(['worktree', 'prune'], { cwd: repo, allowFail: true });
  if (branch) await git(['branch', '-D', branch], { cwd: repo, allowFail: true });
}

/** 把副本里的所有改动提交成一个提交；没有改动返回 null。 */
export async function commitAll(cwd, message, author) {
  await git(['add', '-A'], { cwd });
  const st = (await git(['status', '--porcelain'], { cwd })).stdout;
  // 合并冲突解决后可能“没有新改动但处于合并中”
  const merging = (await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd, allowFail: true })).ok;
  if (!st.trim() && !merging) return null;
  await git(['commit', '--no-verify', '-m', message], { cwd, author });
  return headOf(cwd);
}

export async function mergeBase(cwd, a, b) {
  const r = await git(['merge-base', a, b], { cwd, allowFail: true });
  return r.ok ? r.stdout.trim() : null;
}

/** base..head 之间改了哪些文件。 */
export async function changedFiles(cwd, base, head) {
  if (!base || !head || base === head) return [];
  const out = (await git(['diff', '--name-status', '--no-renames', base, head], { cwd })).stdout;
  const stat = (await git(['diff', '--numstat', '--no-renames', base, head], { cwd })).stdout;
  const nums = new Map(stat.split('\n').filter(Boolean).map((l) => { const [a, r, ...p] = l.split('\t'); return [p.join('\t'), { added: +a || 0, removed: +r || 0 }]; }));
  return out.split('\n').filter(Boolean).map((l) => {
    const [s, ...p] = l.split('\t');
    const file = p.join('\t');
    return { path: file, status: s[0], ...(nums.get(file) || { added: 0, removed: 0 }) };
  });
}

export async function showFile(cwd, rev, file) {
  const r = await git(['show', `${rev}:${file}`], { cwd, allowFail: true });
  if (!r.ok) return null;
  return r.stdout.includes('\u0000') ? '（二进制文件）' : r.stdout;
}

/** 在 cwd 所在副本里合并 branch。冲突时返回冲突文件（并保持合并中状态，除非 abortOnConflict）。 */
export async function merge(cwd, branch, message, { abortOnConflict = true } = {}) {
  const r = await git(['merge', '--no-ff', '--no-edit', '-m', message, branch], { cwd, allowFail: true });
  if (r.ok) return { ok: true, head: await headOf(cwd) };
  const conflicts = (await git(['diff', '--name-only', '--diff-filter=U'], { cwd, allowFail: true })).stdout.split('\n').filter(Boolean);
  if (abortOnConflict) await git(['merge', '--abort'], { cwd, allowFail: true });
  return { ok: false, conflicts, error: (r.stderr || r.stdout).trim().slice(0, 500) };
}
