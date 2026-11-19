// 暂存的附件用随机 ID 命名；只有发送时才把普通文件复制到共享文件夹。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { t as tr } from './i18n.mjs';

const MB = 1024 * 1024;
const imageExt = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const missing = () => Object.assign(new Error(tr('找不到这个附件')), { status: 404 });

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const header = bytes.toString('latin1', 0, 12);
  if (/^GIF8[79]a/.test(header)) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8) === 'WEBP') return 'image/webp';
  return null;
}

export class Attachments {
  constructor(spaceDir, check) {
    this.dir = path.resolve(spaceDir, 'attachments');
    this.check = check;
  }

  pathOf(a) {
    const ext = a.kind === 'image' ? imageExt[a.type] : path.extname(a.name);
    return path.join(this.dir, a.id + (Buffer.byteLength(ext) > 210 ? '.bin' : ext));
  }

  stage({ name, data, type }) {
    if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || /[/\\\x00-\x1f]/.test(name)) {
      throw new Error(tr('文件名不合法'));
    }
    if (process.platform === 'win32' && (/[<>:"|?*]|[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))) {
      throw new Error(tr('文件名不合法'));
    }
    if ((process.platform === 'win32' ? name.length : Buffer.byteLength(name)) > 255) throw new Error(tr('文件名不合法'));
    if (typeof data !== 'string') throw new Error(tr('附件数据不合法'));
    if (data.length > 4 * Math.ceil(50 * MB / 3)) throw new Error(tr('单个文件不能超过 50 MB'));
    if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || /\s/.test(data)) throw new Error(tr('附件数据不合法'));
    const bytes = Buffer.from(data, 'base64');
    const mime = imageType(bytes);
    if (mime && bytes.length > 5 * MB) throw new Error(tr('单张图片不能超过 5 MB'));
    if (bytes.length > 50 * MB) throw new Error(tr('单个文件不能超过 50 MB'));
    const a = {
      id: randomUUID(), kind: mime ? 'image' : 'file', name, size: bytes.length,
      type: mime || (typeof type === 'string' && type.slice(0, 120)) || 'application/octet-stream',
    };
    this.check(a);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.pathOf(a), bytes, { flag: 'wx' });
    try { fs.writeFileSync(path.join(this.dir, a.id + '.meta.json'), JSON.stringify(a), { flag: 'wx' }); }
    catch (e) { fs.unlinkSync(this.pathOf(a)); throw e; }
    return a;
  }

  get(id) {
    if (typeof id !== 'string' || !uuid.test(id)) throw missing();
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, id + '.meta.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') throw missing(); throw e; }
  }

  remove(a) {
    fs.rmSync(this.pathOf(a), { force: true });
    fs.rmSync(path.join(this.dir, a.id + '.meta.json'), { force: true });
  }

  images(items = []) {
    return items.filter((a) => a.kind === 'image').map((a) => ({ path: this.pathOf(a), type: a.type, name: a.name }));
  }

  copyFile(a, root, folder) {
    const dir = path.join(root, folder);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.lstatSync(dir).isDirectory()) throw new Error(tr('附件目录不是普通文件夹'));
    const { name: stem, ext } = path.parse(a.name);
    for (let n = 1; ; n++) {
      const name = n === 1 ? a.name : stem + ' (' + n + ')' + ext;
      const dest = path.join(dir, name);
      if (fs.lstatSync(dest, { throwIfNoEntry: false })) continue;
      try { fs.copyFileSync(this.pathOf(a), dest, fs.constants.COPYFILE_EXCL); }
      catch (e) { if (e.code === 'EEXIST') continue; throw e; }
      return { kind: 'file', path: folder + '/' + name, name, size: a.size };
    }
  }
}
