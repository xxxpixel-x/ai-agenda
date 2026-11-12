// 讨论记录持久化：每场讨论一个 JSON 文件。
import fs from 'node:fs';
import path from 'node:path';

const ID_RE = /^[a-z0-9-]{8,64}$/i;

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(id) {
    if (!ID_RE.test(id)) throw new Error('非法的讨论 id');
    return path.join(this.dir, `${id}.json`);
  }

  loadAll() {
    const out = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')));
      } catch (e) {
        console.warn(`跳过无法读取的记录 ${name}：${e.message}`);
      }
    }
    return out;
  }

  save(data) {
    const file = this.file(data.id);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  remove(id) {
    fs.rmSync(this.file(id), { force: true });
  }
}
