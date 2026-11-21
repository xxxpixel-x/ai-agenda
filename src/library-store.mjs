import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { t as tr } from './i18n.mjs';

export function safeId(value, max = 64) {
  if (typeof value !== 'string' || value.length > max || !/^[a-z0-9_-][a-z0-9._-]*$/i.test(value)
      || value.includes('..') || value.endsWith('.') || Object.hasOwn(Object.prototype, value.toLowerCase())
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(value)) throw new Error(tr('无效的资源标识'));
  return value.toLowerCase();
}

export function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

export function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, typeof content === 'string' ? content : JSON.stringify(content, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

export function webUrl(v) {
  try { const url = new URL(v); return ['http:', 'https:'].includes(url.protocol) && !url.password && !url.username ? url.href : ''; }
  catch { return ''; }
}
