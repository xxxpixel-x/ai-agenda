// 全局设置：各命令行的路径、Gemini API key、OpenAI 兼容接口列表。保存在 data/settings.json。
// 桌面版里 API key 用系统加密（Electron safeStorage，绑定当前 Windows 账户）后再存盘。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// paths 里有哪些键由调用方传入（命令行引擎的 id），这里不写死
const defaults = (pathKeys) => ({
  paths: Object.fromEntries(pathKeys.map((k) => [k, ''])),
  gemini: { apiKey: '', baseUrl: '' },
  providers: [], // [{ id, name, baseUrl, apiKey, model }]
});

const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * @param opts.pathKeys   需要“程序位置”的引擎 id 列表
 * @param opts.protect / unprotect   API key 的加密 / 解密
 */
export function createSettings(file, { pathKeys = [], protect = (s) => ({ plain: s }), unprotect = (o) => o?.plain ?? '' } = {}) {
  const DEFAULTS = defaults(pathKeys);
  let data = structuredClone(DEFAULTS);

  const decodeKey = (v) => {
    if (!v) return '';
    if (typeof v === 'string') return v;
    try { return unprotect(v) || ''; } catch { return ''; }
  };
  const encodeKey = (s) => (s ? protect(s) : '');

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = {
      paths: { ...DEFAULTS.paths, ...(raw.paths || {}) },
      gemini: { baseUrl: raw.gemini?.baseUrl || '', apiKey: decodeKey(raw.gemini?.apiKey) },
      providers: (raw.providers || []).map((p) => ({ ...p, apiKey: decodeKey(p.apiKey) })),
    };
  } catch { /* 第一次运行 */ }

  function save() {
    const out = {
      paths: data.paths,
      gemini: { baseUrl: data.gemini.baseUrl, apiKey: encodeKey(data.gemini.apiKey) },
      providers: data.providers.map((p) => ({ ...p, apiKey: encodeKey(p.apiKey) })),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(out, null, 2), 'utf8');
    fs.renameSync(`${file}.tmp`, file);
  }

  const mask = (k) => (k ? `${k.slice(0, 4)}…${k.slice(-4)}` : '');

  return {
    get: () => data,
    /** 给界面看的版本：不回传 key 本身 */
    publicView: () => ({
      paths: data.paths,
      gemini: { baseUrl: data.gemini.baseUrl, hasKey: !!data.gemini.apiKey, keyHint: mask(data.gemini.apiKey) },
      providers: data.providers.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model, hasKey: !!p.apiKey, keyHint: mask(p.apiKey) })),
    }),
    /** 局部更新。apiKey 传 undefined 表示不变，传 '' 表示清空。 */
    update(patch) {
      if (patch.paths) {
        for (const k of Object.keys(DEFAULTS.paths)) {
          if (k in patch.paths) data.paths[k] = str(patch.paths[k], 1000);
        }
      }
      if (patch.gemini) {
        if ('baseUrl' in patch.gemini) data.gemini.baseUrl = str(patch.gemini.baseUrl);
        if (typeof patch.gemini.apiKey === 'string') data.gemini.apiKey = str(patch.gemini.apiKey);
      }
      if (Array.isArray(patch.providers)) {
        const old = new Map(data.providers.map((p) => [p.id, p]));
        data.providers = patch.providers.slice(0, 20).map((p) => {
          const prev = old.get(p.id) || {};
          const name = str(p.name, 30).replace(/[@\s]/g, '');
          if (!name) throw new Error('每个接口都需要一个名字');
          return {
            id: prev.id || randomUUID().slice(0, 8),
            name,
            baseUrl: str(p.baseUrl),
            model: str(p.model, 100),
            apiKey: typeof p.apiKey === 'string' ? str(p.apiKey) : prev.apiKey || '',
          };
        });
      }
      save();
      return this.publicView();
    },
  };
}
