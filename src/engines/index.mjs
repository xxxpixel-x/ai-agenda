// 引擎注册表：把各种 AI（本机命令行 / API）统一成同一套接口。
//   detect(opts)  -> { available, ready, note, command?, bin?, models?, efforts?, defaultModel? }
//     models：查到的型号（字符串或 [型号, 显示名]）；efforts：{ 型号: [该型号支持的思考档位] }
//     meta.models / meta.efforts 是写死的常用型号和这个 AI 的全部档位（查不到时用）
//   runTurn(opts) -> { text, sessionId?, usage? }   流式内容通过 onDelta，工具动作通过 onActivity
//     usage：这一轮的用量 { input, output, cacheRead, cacheWrite, contextUsed?, contextWindow?, quota?: { usedPct, resetsAt } }，
//     input 不含缓存命中，拿不到的字段不写（见 usage-fields.mjs）；meta.usage = { tokens, context, quota } 写这个引擎能报哪几样
//     （context 指能算出上下文百分比，即同时有 contextUsed 和 contextWindow）
//     meta.approvals 为 true 的引擎：opts.onApproval({ command }) 存在时，运行命令前先 await 它，
//     得到 { allow, reason } 再决定运行还是拒绝（reason 转告 AI）
//     meta.sources 为 true 的引擎能换模型来源：成员的 source 是设置里某个接口的 id，runTurn 时换成 opts.source（接口本身）；
//     list() 里带上 sourceChoices（可选的接口），sourceRequired 为 true 表示没有「自己的账号」这一项
// 引擎的能力写在它自己模块的 meta 里：kind（'cli' | 'api' | 'embedded'）、resume（能否续接会话）、
// continuesImports（能接着导入的原会话聊）、logo（界面图标）等，
// 注册表只看 meta，不按具体 id 做判断。
// 以后要接新的 AI：在 engines/ 下加一个模块，再在下面 ENGINES 里加一行。
import path from 'node:path';
import { t as tr, getLanguage } from '../i18n.mjs';
import * as claudeCode from './claude-code.mjs';
import * as codex from './codex.mjs';
import * as dsh from './dsh.mjs';
import * as geminiCli from './gemini-cli.mjs';
import * as gemini from './gemini.mjs';
import * as openai from './openai-compat.mjs';
import * as pi from './pi.mjs';
import * as mock from './mock.mjs';

/**
 * 每一项是一种接入方式：
 *   module               引擎模块（meta / detect / runTurn）
 *   owns(engineId)       这个 id 归不归它管
 *   instances(settings)  在成员列表里显示成哪些 AI（一个接入方式可以有多个，比如多个 OpenAI 兼容接口）
 *   options(settings, engineId, { source, dataDir })  调用 detect / runTurn 时额外带上的连接参数
 *   sources(settings)    能当模型来源的接口（meta.sources 的引擎才有）
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

const providerOf = (s, id) => s.providers.find((p) => p.id === id) || null;

const ENGINES = [
  {
    ...cli(claudeCode),
    // 也给 Claude Code 用的接口；每个接口一个独立的配置目录，不动你本机的 Claude Code 设置
    sources: (s) => s.providers.filter((p) => p.claudeCode && p.anthropicUrl),
    options: (s, id, { source, dataDir }) => ({
      binOverride: s.paths?.[claudeCode.meta.id] || '',
      sessionHome: path.join(dataDir, 'sessions', 'claude-code'),
      ...(source ? { source: claudeCodeSource(s, source), configDir: path.join(dataDir, 'claude-code', source) } : {}),
    }),
  },
  cli(codex),
  cli(dsh),
  cli(geminiCli),
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
      images: p.images !== false,
      id: `${OPENAI_PREFIX}${p.id}`,
      label: p.name || tr('OpenAI 兼容接口'),
      defaultName: p.name || 'AI',
      models: [['', p.model ? tr('默认（{0}）', [p.model]) : tr('接口默认模型')]],
    })),
    options: (s, id) => ({ conn: providerOf(s, id.slice(OPENAI_PREFIX.length)) }),
  },
  {
    // 内嵌的 pi：打包在 Agenda 里，模型来源是设置里的某个 API 接口
    module: pi,
    builtin: true,
    owns: (id) => id === pi.meta.id,
    instances: () => [pi.meta],
    sources: (s) => s.providers,
    options: (s, id, { source, dataDir }) => ({ sources: s.providers, conn: source ? providerOf(s, source) : null, agentDir: path.join(dataDir, 'pi') }),
  },
];

function claudeCodeSource(s, id) {
  const p = providerOf(s, id);
  return p?.claudeCode && p.anthropicUrl ? p : null;
}

/** 需要在设置里填“程序位置”的引擎 id（给 settings 用，避免它自己写死一份）。 */
export const CLI_ENGINE_IDS = ENGINES.filter((e) => e.module.meta.kind === 'cli').map((e) => e.module.meta.id);

export const supportsPrivateSessions = (id) => !!ENGINES.find((e) => e.owns(id))?.module.meta.privateSessions;

export function createRegistry(settings, { mock: mockMode = false } = {}) {
  const cache = new Map(); // engineId -> { at, status }

  const entryOf = (engineId) => ENGINES.find((e) => e.owns(engineId)) || null;

  function moduleOf(engineId) {
    if (mockMode) return mock;
    return entryOf(engineId)?.module || null;
  }

  function optionsFor(engineId, source) {
    if (mockMode) return {};
    return entryOf(engineId)?.options(settings.get(), engineId, { source, dataDir: settings.dir || '.' }) || {};
  }

  // 可选的模型来源（只给界面和成员校验看名字，不带 key）
  function withSources(entry, m) {
    if (!m.sources || !entry.sources) return m;
    return { ...m, sourceChoices: entry.sources(settings.get()).map((p) => ({ id: p.id, name: p.name, model: p.model || '' })) };
  }

  function list() {
    if (mockMode) {
      // 演示模式：外观照搬内置的几种 AI，实际都由演示引擎回答
      return ENGINES.filter((e) => e.builtin).flatMap((e) => e.instances(settings.get()).map((m) => withSources(e, m))).map((m) => ({
        ...mock.meta, id: m.id, label: tr('演示 · {0}', [m.defaultName]), defaultName: m.defaultName, color: m.color, logo: m.logo, kind: m.kind, models: m.models, efforts: m.efforts,
        privateSessions: m.privateSessions, continuesImports: m.continuesImports, hideWhenMissing: m.hideWhenMissing,
        sources: m.sources, sourceRequired: m.sourceRequired, sourceChoices: m.sourceChoices,
      }));
    }
    return ENGINES.flatMap((e) => e.instances(settings.get()).map((m) => withSources(e, { ...m })));
  }

  async function detect(engineId, { refresh = false } = {}) {
    const mod = moduleOf(engineId);
    if (!mod) return { available: false, ready: false, note: tr('未知的 AI 类型') };
    const cacheKey = `${getLanguage()}:${engineId}`;
    const hit = cache.get(cacheKey);
    if (!refresh && hit && Date.now() - hit.at < 60_000) return hit.status;
    let status;
    try {
      status = await mod.detect(optionsFor(engineId));
    } catch (e) {
      status = { available: false, ready: false, note: e.message };
    }
    cache.set(cacheKey, { at: Date.now(), status });
    return status;
  }

  async function detectAll(opts) {
    const engines = list();
    const statuses = await Promise.all(engines.map((e) => detect(e.id, opts)));
    return engines.map((e, i) => ({ ...e, status: statuses[i] }));
  }

  function runTurn(engineId, { source, ...opts }) {
    const mod = moduleOf(engineId);
    if (!mod) throw new Error(tr('未知的 AI 类型：{0}', [engineId]));
    const options = optionsFor(engineId, source);
    // 选的接口删了、或者不再给 Claude Code 用：不要悄悄换回自己的账号
    if (!mockMode && source && !options.source && !options.conn) throw new Error(tr('这个成员的模型来源已经不能用了，在空间设置里换一个'));
    if (!opts.images?.length) return mod.runTurn({ ...options, ...opts });
    const { images, onNoImages, ...rest } = opts;
    if (!supportsImages(engineId)) {
      onNoImages?.();
      return mod.runTurn({ ...options, ...rest });
    }
    return mod.runTurn({ ...options, ...rest, images, onNoImages: () => {
      onNoImages?.();
      const conn = options.conn || options.source;
      if (conn?.id) settings.disableProviderImages(conn);
    } });
  }

  // 演示模式下 moduleOf 拿到的是演示引擎（meta 里没有 kind / resume），自然都是 false
  const isApi = (engineId) => moduleOf(engineId)?.meta?.kind === 'api';
  const supportsImages = (engineId) => !!moduleOf(engineId)?.meta.images && optionsFor(engineId).conn?.images !== false;
  const supportsResume = (engineId) => !!moduleOf(engineId)?.meta?.resume;
  // 能不能在运行命令前停下来问你（runTurn 收到 onApproval 时）
  const supportsApproval = (engineId) => !!moduleOf(engineId)?.meta?.approvals;
  // 演示模式也按真实引擎判断，导入流程和正式版一致（演示引擎会忽略会话 ID）
  const continuesImports = (engineId) => !!entryOf(engineId)?.module.meta.continuesImports;

  const supportsPrivateSessions = (engineId) => !!entryOf(engineId)?.module.meta.privateSessions;

  return { settings, list, detect, supportsPrivateSessions, detectAll, runTurn, isApi, supportsImages, supportsResume, supportsApproval, continuesImports, invalidate: () => cache.clear() };
}
