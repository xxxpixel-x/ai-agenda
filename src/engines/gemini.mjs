// Google Gemini API（需要 Gemini API key，在“设置”里填写）。支持 Google 搜索联网。
import { t as tr } from '../i18n.mjs';
import { request, errorText, readJson, readSse } from './http.mjs';
import { GEMINI_BASE_URL } from '../../public/js/settings/connection-origin.js';
import fs from 'node:fs';
import { AbortedError, brief } from './proc.mjs';
import { usageOf, uncached } from './usage-fields.mjs';

export const meta = {
  images: true, noTools: true,
  id: 'gemini',
  label: 'Gemini API',
  vendor: 'Google',
  kind: 'api',
  defaultName: 'Gemini',
  color: '#4285f4',
  logo: 'gemini',
  get models() { return [['', tr('自动选择')]]; },
  freeModel: true,
  efforts: ['', 'minimal', 'low', 'medium', 'high'], // thinkingLevel；接口不说哪个型号支持哪几档，选了不支持的会看到报错
  get capabilities() { return tr('联网搜索（Google 搜索）；通过软件修改共享文件'); },
  usage: { tokens: true, context: true, quota: false }, // 按官方文档，未实测（没有 key）
};

const baseOf = (conn) => (conn?.baseUrl || GEMINI_BASE_URL).replace(/\/+$/, '');

let modelCache = { key: null, at: 0, list: [], limits: {} };

export async function listModels(conn, { signal } = {}) {
  if (!conn?.apiKey) return [];
  if (signal?.aborted) throw new AbortedError();
  if (modelCache.key === conn.apiKey + baseOf(conn) && Date.now() - modelCache.at < 10 * 60_000) return modelCache.list;
  const res = await request(`${baseOf(conn)}/v1beta/models?pageSize=200`, {
    headers: { 'x-goog-api-key': conn.apiKey }, idleMs: 30_000, signal, name: 'Gemini',
  });
  if (!res.ok) throw new Error(`Gemini：${await errorText(res)}`);
  const j = await readJson(res);
  const limits = Object.fromEntries((j.models || []).filter((m) => m.inputTokenLimit).map((m) => [m.name.replace(/^models\//, ''), m.inputTokenLimit]));
  const list = (j.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /^gemini-/.test(n) && !/(image|tts|audio|live|embedding|vision|robotics|computer)/i.test(n));
  modelCache = { key: conn.apiKey + baseOf(conn), at: Date.now(), list, limits };
  return list;
}

// 没指定模型时：挑版本号最高的 pro，其次 flash（不要 lite / 预览代号太怪的）
function pickDefault(list) {
  const score = (n) => {
    const v = parseFloat((n.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');
    const tier = /-pro\b/.test(n) ? 2 : /-flash\b/.test(n) && !/lite/.test(n) ? 1 : 0;
    const clean = /^gemini-[\d.]+-(pro|flash)(-latest)?$/.test(n) ? 0.5 : 0;
    return v * 10 + tier + clean;
  };
  return [...list].sort((a, b) => score(b) - score(a))[0];
}

export async function detect({ conn } = {}) {
  if (!conn?.apiKey) {
    return { available: true, ready: false, note: tr('需要 Gemini API key。在 Google AI Studio（aistudio.google.com）创建后填到下面。') };
  }
  try {
    const list = await listModels(conn);
    return { available: true, ready: true, note: tr('API key 有效，可用模型 {0} 个', [list.length]), models: list, defaultModel: pickDefault(list) };
  } catch (e) {
    return { available: true, ready: false, note: brief(e.message, 300) };
  }
}

export async function runTurn({ system, prompt, images = [], model, effort, conn, noTools = false, signal, onDelta, onActivity }) {
  if (!conn?.apiKey) throw new Error(tr('还没有填写 Gemini API key（左下角“设置”）'));
  const name = model || pickDefault(await listModels(conn, { signal }));
  if (!name) throw new Error(tr('Gemini：没有可用的模型'));

  const res = await request(`${baseOf(conn)}/v1beta/models/${encodeURIComponent(name)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'x-goog-api-key': conn.apiKey },
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [
        { text: prompt },
        ...images.map((i) => ({ inline_data: { mime_type: i.type, data: fs.readFileSync(i.path, 'base64') } })),
      ] }],
      ...(noTools ? {} : { tools: [{ google_search: {} }] }),
      ...(effort ? { generationConfig: { thinkingConfig: { thinkingLevel: effort.toUpperCase() } } } : {}),
    },
    signal, name: 'Gemini',
  });
  if (!res.ok) throw new Error(`Gemini：${await errorText(res)}`);

  let text = '';
  let finish = null;
  let usageMeta = null; // usageMetadata：每个分片都带，取最后一个
  const searched = new Set();
  await readSse(res, (chunk) => {
    if (chunk.usageMetadata) usageMeta = chunk.usageMetadata;
    const c = chunk.candidates?.[0];
    if (!c) {
      if (chunk.promptFeedback?.blockReason) finish = tr('被拦截（{0}）', [chunk.promptFeedback.blockReason]);
      return;
    }
    for (const p of c.content?.parts || []) {
      if (p.text && !p.thought) { text += p.text; onDelta?.(p.text); }
    }
    for (const q of c.groundingMetadata?.webSearchQueries || []) {
      if (!searched.has(q)) { searched.add(q); onActivity?.({ kind: 'search', label: tr('搜索：{0}', [brief(q, 60)]) }); }
    }
    if (c.finishReason && c.finishReason !== 'STOP' && c.finishReason !== 'MAX_TOKENS') finish = c.finishReason;
  }, signal);

  if (!text.trim()) throw new Error(tr('Gemini 没有返回内容{0}', [finish ? `（${finish}）` : '']));
  const usage = usageFrom(usageMeta, modelCache.limits[name]);
  return { text, model: name, ...(usage ? { usage } : {}) };
}

/**
 * 用量：usageMetadata { promptTokenCount（含 cachedContentTokenCount）, cachedContentTokenCount, candidatesTokenCount,
 * thoughtsTokenCount, toolUsePromptTokenCount }；窗口是型号列表里的 inputTokenLimit。按官方文档写，没有 key，未实测。
 */
export function usageFrom(m, window) {
  if (!m) return undefined;
  const prompt = (m.promptTokenCount || 0) + (m.toolUsePromptTokenCount || 0);
  const output = (m.candidatesTokenCount || 0) + (m.thoughtsTokenCount || 0);
  return usageOf({
    input: uncached(prompt, m.cachedContentTokenCount),
    output,
    cacheRead: m.cachedContentTokenCount ?? 0,
    contextUsed: prompt + output,
    contextWindow: window,
  });
}
