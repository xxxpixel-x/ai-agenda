import fs from 'node:fs';
import path from 'node:path';
import { t as tr } from './i18n.mjs';

// 新文件可能缺好几层目录。先解析存在的祖先，再补回尚未创建的路径。
export function physicalPath(target) {
  const absolute = path.resolve(target);
  let parent = absolute;
  while (!fs.lstatSync(parent, { throwIfNoEntry: false })) {
    const next = path.dirname(parent);
    if (next === parent) throw new Error(tr('只能访问共享文件夹里的文件'));
    parent = next;
  }
  return path.resolve(fs.realpathSync.native(parent), path.relative(parent, absolute));
}

export function containsPath(root, target) {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

// 管理目录下的固定条目必须仍是原位置，不能经目录联接指向根、兄弟目录或外部目录。
export function directChild(root, name) {
  const child = path.join(root, name);
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)
      || path.relative(path.join(physicalPath(root), name), physicalPath(child)) !== '') {
    throw new Error(tr('目录超出了空间的数据范围'));
  }
  return child;
}

export function insideDir(target, cwd) {
  const p = path.resolve(cwd, target || '.');
  try { return containsPath(path.resolve(cwd), p) && containsPath(fs.realpathSync.native(cwd), physicalPath(p)); }
  catch { return false; }
}

export function pathsOverlap(a, b) {
  const realA = physicalPath(a);
  const realB = physicalPath(b);
  return containsPath(realA, realB) || containsPath(realB, realA);
}
