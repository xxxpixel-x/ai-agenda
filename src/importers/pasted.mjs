// 粘贴的文字和选择的文件：整理好的对话先放在内存里，选中用到时存进 Agenda 数据目录的 imports/ 下，
// 之后重新整理等还要再读。导入列表里不列出它们（每次都是重新粘贴或选择）。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseImport } from './parse.mjs';

export const meta = { id: 'pasted', label: '粘贴的对话', engine: null };

let dir = null;
const staged = new Map(); // id -> 对话（还没用到的）
const ID_RE = /^[0-9a-f-]{36}$/i;

export function configure(dataDir) { dir = path.join(dataDir, 'imports'); }

/** 整理一段粘贴的文字或一个文件，返回其中的对话（一个导出文件里可能有很多段）。 */
export function stage(input, fileName) {
  const list = parseImport(input, fileName);
  if (!list.length) throw new Error('没有找到对话内容');
  if (staged.size > 2000) staged.clear(); // 只是暂存，清掉也只是要重新选
  return list.map((c) => {
    const id = randomUUID();
    const s = { id, title: c.title || '粘贴的对话', sourceLabel: c.sourceLabel || meta.label, cwd: '', entries: c.entries };
    staged.set(id, s);
    const last = c.entries.reduce((n, e) => Math.max(n, e.ts || 0), 0);
    return { id, title: s.title, sourceLabel: s.sourceLabel, cwd: '', updatedAt: last || Date.now(), source: meta.id, engine: null };
  });
}

export const list = () => [];

export function read(id) {
  if (!ID_RE.test(id) || !dir) throw new Error('找不到这段对话');
  const file = path.join(dir, `${id}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = staged.get(id);
  if (!s) throw new Error('找不到这段对话，请重新粘贴或选择文件');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s));
  staged.delete(id);
  return s;
}
