// 引擎注册表：把各种 AI（本机命令行 / API）统一成同一套接口。
//   detect(opts)  -> { available, ready, note, command?, bin?, models?, efforts?, defaultModel? }
//     models：查到的型号（字符串或 [型号, 显示名]）；efforts：{ 型号: [该型号支持的思考档位] }
//     meta.models / meta.efforts 是写死的常用型号和这个 AI 的全部档位（查不到时用）
//   runTurn(opts) -> { text, sessionId? }   流式内容通过 onDelta，工具动作通过 onActivity
// 引擎的能力写在它自己模块的 meta 里：kind（'cli' | 'api'）、resume（能否续接会话）等，
// 注册表只看 meta，不按具体 id 做判断。
// 以后要接新的 AI：在 engines/ 下加一个模块，再在下面 ENGINES 里加一行。
import * as claudeCode from './claude-code.mjs';
import * as codex from './codex.mjs';
import * as dsh from './dsh.mjs';
import * as gemini from './gemini.mjs';
import * as openai from './openai-compat.mjs';
import * as mock from './mock.mjs';

/**
 * 每一项是一种接入方式：
 *   module               引擎模块（meta / detect / runTurn）
 *   owns(engineId)       这个 id 归不归它管
 *   instances(settings)  在成员列表里显示成哪些 AI（一个接入方式可以有多个，比如多个 OpenAI 兼容接口）
 *   options(settings, engineId)  调用 detect / runTurn 时额外带上的连接参数
 *   builtin              固定内置的（演示模式只模拟这些）
 */
const cli = (module) => ({
  module,
  builtin: true,
  owns: (id) => id === module.meta.id,
  instances: () => [module.meta],
  options: (s) => ({ binOverride: s.paths?.[module.meta.id] || '' }),
});

const OPENAI_PREFIX = 'openai:';

const ENGINES = [
  cli(claudeCode),
  cli(codex),
  cli(dsh),
  {
    module: gemini,
    builtin: true,
    owns: (id) => id === gemini.meta.id,
    instances: () => [gemini.meta],
    options: (s) => ({ conn: s.gemini }),
  },
  {
    module: openai,
    owns: (id) => typeof id === 'string' && id.startsWith(OPENAI_PREFIX),
    instances: (s) => s.providers.map((p) => ({
      ...openai.meta,
      id: `${OPENAI_PREFIX}${p.id}`,
      label: p.name || 'OpenAI 兼容接口',
      defaultName: p.name || 'AI',
      models: [['', p.model ? `默认（${p.model}）` : '接口默认模型']],
    })),
    options: (s, id) => ({ conn: s.providers.find((p) => p.id === id.slice(OPENAI_PREFIX.length)) || null }),
  },
];

/** 需要在设置里填“程序位置”的引擎 id（给 settings 用，避免它自己写死一份）。 */
export const CLI_ENGINE_IDS = ENGINES.filter((e) => e.module.meta.kind === 'cli').map((e) => e.module.meta.id);

export function createRegistry(settings, { mock: mockMode = false } = {}) {
  const cache = new Map(); // engineId -> { at, status }

  const entryOf = (engineId) => ENGINES.find((e) => e.owns(engineId)) || null;

  function moduleOf(engineId) {
    if (mockMode) return mock;
    return entryOf(engineId)?.module || null;
  }

  function optionsFor(engineId) {
    if (mockMode) return {};
    return entryOf(engineId)?.options(settings.get(), engineId) || {};
  }

  function list() {
    if (mockMode) {
      // 演示模式：外观照搬内置的几种 AI，实际都由演示引擎回答
      return ENGINES.filter((e) => e.builtin).flatMap((e) => e.instances(settings.get())).map((m) => ({
        ...mock.meta, id: m.id, label: `演示 · ${m.defaultName}`, defaultName: m.defaultName, color: m.color, models: m.models, efforts: m.efforts,
      }));
    }
    return ENGINES.flatMap((e) => e.instances(settings.get())).map((m) => ({ ...m }));
  }

  async function detect(engineId, { refresh = false } = {}) {
    const mod = moduleOf(engineId);
    if (!mod) return { available: false, ready: false, note: '未知的 AI 类型' };
    const hit = cache.get(engineId);
    if (!refresh && hit && Date.now() - hit.at < 60_000) return hit.status;
    let status;
    try {
      status = await mod.detect(optionsFor(engineId));
    } catch (e) {
      status = { available: false, ready: false, note: e.message };
    }
    cache.set(engineId, { at: Date.now(), status });
    return status;
  }

  async function detectAll(opts) {
    const engines = list();
    const statuses = await Promise.all(engines.map((e) => detect(e.id, opts)));
    return engines.map((e, i) => ({ ...e, status: statuses[i] }));
  }

  function runTurn(engineId, opts) {
    const mod = moduleOf(engineId);
    if (!mod) throw new Error(`未知的 AI 类型：${engineId}`);
    return mod.runTurn({ ...optionsFor(engineId), ...opts });
  }

  // 演示模式下 moduleOf 拿到的是演示引擎（meta 里没有 kind / resume），自然都是 false
  const isApi = (engineId) => moduleOf(engineId)?.meta?.kind === 'api';
  const supportsResume = (engineId) => !!moduleOf(engineId)?.meta?.resume;

  return { list, detect, detectAll, runTurn, isApi, supportsResume, invalidate: () => cache.clear() };
}
