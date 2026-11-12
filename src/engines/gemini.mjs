// Google Gemini API（需要 Gemini API key，在“连接与登录”里填写）。支持 Google 搜索联网。
import { request, errorText, readSse } from './http.mjs';
import { brief } from './proc.mjs';

export const meta = {
  id: 'gemini',
  label: 'Gemini',
  vendor: 'Google',
  kind: 'api',
  defaultName: 'Gemini',
  color: '#4285f4',
  models: [['', '自动选择']],
  freeModel: true,
  efforts: [['', '默认']],
  capabilities: '联网搜索（Google 搜索）；通过软件修改共享文件',
};

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';
const baseOf = (conn) => (conn?.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');

let modelCache = { key: null, at: 0, list: [] };

export async function listModels(conn) {
  if (!conn?.apiKey) return [];
  if (modelCache.key === conn.apiKey + baseOf(conn) && Date.now() - modelCache.at < 10 * 60_000) return modelCache.list;
  const res = await request(`${baseOf(conn)}/v1beta/models?pageSize=200`, { headers: { 'x-goog-api-key': conn.apiKey } });
  if (!res.ok) throw new Error(`Gemini：${await errorText(res)}`);
  const j = await res.json();
  const list = (j.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /^gemini-/.test(n) && !/(image|tts|audio|live|embedding|vision|robotics|computer)/i.test(n));
  modelCache = { key: conn.apiKey + baseOf(conn), at: Date.now(), list };
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
    return { available: true, ready: false, note: '需要 Gemini API key。在 Google AI Studio（aistudio.google.com）创建后填到下面。' };
  }
  try {
    const list = await listModels(conn);
    return { available: true, ready: true, note: `API key 有效，可用模型 ${list.length} 个`, models: list, defaultModel: pickDefault(list) };
  } catch (e) {
    return { available: true, ready: false, note: brief(e.message, 300) };
  }
}

export async function runTurn({ system, prompt, model, conn, signal, onDelta, onActivity }) {
  if (!conn?.apiKey) throw new Error('还没有填写 Gemini API key（左下角“连接与登录”）');
  const name = model || pickDefault(await listModels(conn));
  if (!name) throw new Error('Gemini：没有可用的模型');

  const res = await request(`${baseOf(conn)}/v1beta/models/${encodeURIComponent(name)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'x-goog-api-key': conn.apiKey },
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
    },
    signal,
  });
  if (!res.ok) throw new Error(`Gemini：${await errorText(res)}`);

  let text = '';
  let finish = null;
  const searched = new Set();
  await readSse(res, (chunk) => {
    const c = chunk.candidates?.[0];
    if (!c) {
      if (chunk.promptFeedback?.blockReason) finish = `被拦截（${chunk.promptFeedback.blockReason}）`;
      return;
    }
    for (const p of c.content?.parts || []) {
      if (p.text && !p.thought) { text += p.text; onDelta?.(p.text); }
    }
    for (const q of c.groundingMetadata?.webSearchQueries || []) {
      if (!searched.has(q)) { searched.add(q); onActivity?.({ kind: 'search', label: `搜索：${brief(q, 60)}` }); }
    }
    if (c.finishReason && c.finishReason !== 'STOP' && c.finishReason !== 'MAX_TOKENS') finish = c.finishReason;
  }, signal);

  if (!text.trim()) throw new Error(`Gemini 没有返回内容${finish ? `（${finish}）` : ''}`);
  return { text, model: name };
}
