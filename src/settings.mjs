// 全局设置：语言、提醒和防睡眠开关、各命令行的路径、Gemini API key、OpenAI 兼容接口列表（可以同时给 Claude Code、pi 当模型来源）。保存在 data/settings.json。
// 桌面版里 API key 用系统加密（Electron safeStorage，绑定当前 Windows 账户）后再存盘。
import { t as tr } from './i18n.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// paths 里有哪些键由调用方传入（命令行引擎的 id），这里不写死
const defaults = (pathKeys) => ({
  autoHandoffPct: 50,
  contextLimits: {},
  language: 'system',
  notify: true,    // AI 做完或等你处理时弹系统通知（桌面版）
  keepAwake: true, // 有 AI 在干活时不让电脑睡眠（桌面版）
  paths: Object.fromEntries(pathKeys.map((k) => [k, ''])),
  gemini: { apiKey: '', baseUrl: '' },
  providers: [], // [{ id, name, baseUrl, apiKey, model, anthropicUrl, claudeCode }]
});

const validPct = (n) => Number.isInteger(n) && (n === 0 || (n >= 10 && n <= 95));
const validWindow = (n) => Number.isSafeInteger(n) && n >= 1024 && n <= 4000000;
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
      autoHandoffPct: validPct(raw.autoHandoffPct) ? raw.autoHandoffPct : 50,
      contextLimits: Object.fromEntries(Object.entries(raw.contextLimits || {}).filter(([, n]) => Number.isSafeInteger(n) && n > 0)),
      language: ['system', 'zh', 'en'].includes(raw.language) ? raw.language : 'system',
      notify: raw.notify !== false,
      keepAwake: raw.keepAwake !== false,
      paths: { ...DEFAULTS.paths, ...(raw.paths || {}) },
      gemini: { baseUrl: raw.gemini?.baseUrl || '', apiKey: decodeKey(raw.gemini?.apiKey) },
      providers: (raw.providers || []).map(({ contextWindow, ...p }) => ({ ...p, apiKey: decodeKey(p.apiKey),
        ...(validWindow(contextWindow) ? { contextWindow } : {}) })),
    };
  } catch { /* 第一次运行 */ }

  function save() {
    const out = {
      autoHandoffPct: data.autoHandoffPct,
      contextLimits: { ...data.contextLimits },
      language: data.language,
      notify: data.notify,
      keepAwake: data.keepAwake,
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
    dir: path.dirname(file), // 数据目录：引擎自己的配置（pi、Claude Code 的独立配置目录）放这里
    get: () => data,
    rememberContextLimit(key, tokens) {
      if (!key || !Number.isSafeInteger(tokens) || tokens <= 0) return;
      const previous = data.contextLimits;
      data.contextLimits = { ...previous, [key]: Math.min(previous[key] ?? Infinity, tokens) };
      try { save(); } catch (e) { data.contextLimits = previous; throw e; }
    },
    disableProviderImages(conn) {
      const current = data.providers.find((p) => p.id === conn.id && p.baseUrl === conn.baseUrl);
      if (!current || current.images === false) return;
      current.images = false;
      try { save(); } catch (e) { delete current.images; throw e; }
    },
    /** 给界面看的版本：不回传 key 本身 */
    publicView: () => ({
      autoHandoffPct: data.autoHandoffPct,
      contextLimits: { ...data.contextLimits },
      language: data.language,
      notify: data.notify,
      keepAwake: data.keepAwake,
      paths: data.paths,
      gemini: { baseUrl: data.gemini.baseUrl, hasKey: !!data.gemini.apiKey, keyHint: mask(data.gemini.apiKey) },
      providers: data.providers.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model, ...(validWindow(p.contextWindow) ? { contextWindow: p.contextWindow } : {}), anthropicUrl: p.anthropicUrl || '', claudeCode: !!p.claudeCode, hasKey: !!p.apiKey, keyHint: mask(p.apiKey) })),
    }),
    /** 局部更新。apiKey 传 undefined 表示不变，传 '' 表示清空。 */
    update(patch) {
      const previous = data;
      data = structuredClone(data);
      try {
        if ('autoHandoffPct' in patch) {
          if (!validPct(patch.autoHandoffPct)) throw new Error(tr('自动交接阈值必须是 0（关闭）或 10 到 95 之间的整数'));
          data.autoHandoffPct = patch.autoHandoffPct;
        }
        if ('language' in patch) {
          if (!['system', 'zh', 'en'].includes(patch.language)) throw new Error(tr('无效的语言设置'));
          data.language = patch.language;
        }
        for (const k of ['notify', 'keepAwake']) if (typeof patch[k] === 'boolean') data[k] = patch[k];
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
            const window = 'contextWindow' in p ? p.contextWindow : prev.contextWindow;
            if (window != null && !validWindow(window)) throw new Error(tr('上下文窗口必须是 1024 到 4000000 之间的整数'));
            const name = str(p.name, 30).replace(/[@\s]/g, '');
            if (!name) throw new Error(tr('每个接口都需要一个名字'));
            // 也给 Claude Code 用：要有 Anthropic 兼容地址（没传这两项时保留原来的）
            const anthropicUrl = 'anthropicUrl' in p ? str(p.anthropicUrl) : prev.anthropicUrl || '';
            const claudeCode = 'claudeCode' in p ? p.claudeCode === true : !!prev.claudeCode;
            if (claudeCode && !anthropicUrl) throw new Error(tr('「{0}」要给 Claude Code 用，需要填 Anthropic 兼容地址', [name]));
            return {
              id: prev.id || randomUUID().slice(0, 8),
              name,
              ...(window != null ? { contextWindow: window } : {}),
              baseUrl: str(p.baseUrl),
              ...(prev.images === false && prev.baseUrl === str(p.baseUrl) ? { images: false } : {}),
              model: str(p.model, 100),
              ...(anthropicUrl ? { anthropicUrl } : {}),
              ...(claudeCode ? { claudeCode } : {}),
              apiKey: typeof p.apiKey === 'string' ? str(p.apiKey) : prev.apiKey || '',
            };
          });
        }
        save();
        return this.publicView();
      } catch (e) {
        data = previous;
        throw e;
      }
    },
  };
}
