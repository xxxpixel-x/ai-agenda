// 通用 OpenAI 兼容接口（/chat/completions）：DeepSeek、通义千问、Kimi、智谱、OpenAI、本地 Ollama 等都能接。
// 每个“接口”在“设置”里单独配置：名称、地址、API key、默认模型。
import { t as tr } from '../i18n.mjs';
import { request, errorText, readSse } from './http.mjs';
import fs from 'node:fs';
import { brief } from './proc.mjs';
import { usageOf, uncached } from './usage-fields.mjs';

export const meta = {
  images: true,
  id: 'openai',
  get label() { return tr('OpenAI 兼容接口'); },
  get vendor() { return tr('自定义'); },
  kind: 'api',
  defaultName: 'AI',
  color: '#7c3aed',
  get models() { return [['', tr('接口默认模型')]]; },
  freeModel: true,
  efforts: ['', 'minimal', 'low', 'medium', 'high', 'xhigh'], // reasoning_effort；各家支持的不一样，选了不支持的会看到报错
  get capabilities() { return tr('通过软件修改共享文件（不能联网）'); },
  usage: { tokens: true, context: false, quota: false }, // 接口支持 stream_options.include_usage 时才有；按 OpenAI 文档写，未实测
};

// 不接受 stream_options 的接口（按地址记住，之后不再带）
const noUsageOption = new Set();

/**
 * 用量：最后一个分片的 usage { prompt_tokens（含缓存命中）, completion_tokens, prompt_tokens_details.cached_tokens }；
 * DeepSeek 用 prompt_cache_hit_tokens。按 OpenAI / DeepSeek 文档写，没有 key，未实测。上下文窗口要等预设或你填写（见需求「预算跟着模型走」）。
 */
export function usageFrom(u) {
  if (!u) return undefined;
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens;
  return usageOf({
    input: uncached(u.prompt_tokens, cached),
    output: u.completion_tokens,
    cacheRead: cached,
    contextUsed: typeof u.prompt_tokens === 'number' ? u.prompt_tokens + (u.completion_tokens || 0) : undefined,
  });
}

const baseOf = (conn) => String(conn?.baseUrl || '').replace(/\/+$/, '');

export async function detect({ conn } = {}) {
  if (!baseOf(conn)) return { available: true, ready: false, note: tr('请填写接口地址') };
  const headers = conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {};
  try {
    const res = await request(`${baseOf(conn)}/models`, { headers });
    if (!res.ok) return { available: true, ready: false, note: tr('连接失败：{0}', [await errorText(res)]) };
    const j = await res.json().catch(() => ({}));
    const models = (j.data || []).map((m) => m.id).filter(Boolean);
    return { available: true, ready: true, note: tr('连接正常{0}', [models.length ? tr('，可用模型 {0} 个', [models.length]) : '']), models, ...(conn.model ? { defaultModel: conn.model } : {}) };
  } catch (e) {
    return { available: true, ready: false, note: brief(e.message, 300) };
  }
}

export async function runTurn({ system, prompt, images = [], onNoImages, model, effort, conn, signal, onDelta }) {
  const base = baseOf(conn);
  if (!base) throw new Error(tr('这个接口还没有填写地址'));
  const name = model || conn.model;
  if (!name) throw new Error(tr('这个接口还没有指定模型（在成员设置或接口设置里填写）'));

  const post = (content, withUsage) => request(`${base}/chat/completions`, {
    method: 'POST',
    headers: conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {},
    body: {
      model: name,
      stream: true,
      ...(withUsage ? { stream_options: { include_usage: true } } : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content }],
    },
    signal,
  });
  // 先带上「返回用量」；报错里提到这个参数时去掉再发一次，并记住这个接口。别的 4xx 原样交给下面（比如不支持图片）
  const send = async (content) => {
    if (noUsageOption.has(base)) return post(content, false);
    const res = await post(content, true);
    if (res.status < 400 || res.status >= 500) return res;
    const raw = await res.text().catch(() => '');
    if (!/stream_options|include_usage/i.test(raw)) return new Response(raw, { status: res.status, headers: res.headers });
    noUsageOption.add(base);
    return post(content, false);
  };
  let res = await send(images.length ? [
    { type: 'text', text: prompt },
    ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.type};base64,${fs.readFileSync(i.path, 'base64')}` } })),
  ] : prompt);
  if (images.length && res.status >= 400 && res.status < 500) {
    await res.body?.cancel();
    onNoImages?.();
    res = await send(prompt);
  }
  if (!res.ok) throw new Error(`${conn.name || tr('接口')}：${await errorText(res)}`);

  let text = '';
  let usage;
  await readSse(res, (chunk) => {
    if (chunk.usage) usage = usageFrom(chunk.usage);
    const d = chunk.choices?.[0]?.delta;
    if (d?.content) { text += d.content; onDelta?.(d.content); }
  }, signal);
  if (!text.trim()) throw new Error(tr('{0} 没有返回内容', [conn.name || tr('接口')]));
  return { text, model: name, ...(usage ? { usage } : {}) };
}
