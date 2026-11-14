// 通用 OpenAI 兼容接口（/chat/completions）：DeepSeek、通义千问、Kimi、智谱、OpenAI、本地 Ollama 等都能接。
// 每个“接口”在“设置”里单独配置：名称、地址、API key、默认模型。
import { t as tr } from '../i18n.mjs';
import { request, errorText, readSse } from './http.mjs';
import { brief } from './proc.mjs';

export const meta = {
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
};

const baseOf = (conn) => String(conn?.baseUrl || '').replace(/\/+$/, '');

export async function detect({ conn } = {}) {
  if (!baseOf(conn)) return { available: true, ready: false, note: tr('请填写接口地址') };
  const headers = conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {};
  try {
    const res = await request(`${baseOf(conn)}/models`, { headers });
    if (!res.ok) return { available: true, ready: false, note: tr('连接失败：{0}', [await errorText(res)]) };
    const j = await res.json().catch(() => ({}));
    const models = (j.data || []).map((m) => m.id).filter(Boolean);
    return { available: true, ready: true, note: tr('连接正常{0}', [models.length ? tr('，可用模型 {0} 个', [models.length]) : '']), models };
  } catch (e) {
    return { available: true, ready: false, note: brief(e.message, 300) };
  }
}

export async function runTurn({ system, prompt, model, effort, conn, signal, onDelta }) {
  const base = baseOf(conn);
  if (!base) throw new Error(tr('这个接口还没有填写地址'));
  const name = model || conn.model;
  if (!name) throw new Error(tr('这个接口还没有指定模型（在成员设置或接口设置里填写）'));

  const res = await request(`${base}/chat/completions`, {
    method: 'POST',
    headers: conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {},
    body: {
      model: name,
      stream: true,
      ...(effort ? { reasoning_effort: effort } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    },
    signal,
  });
  if (!res.ok) throw new Error(`${conn.name || tr('接口')}：${await errorText(res)}`);

  let text = '';
  await readSse(res, (chunk) => {
    const d = chunk.choices?.[0]?.delta;
    if (d?.content) { text += d.content; onDelta?.(d.content); }
  }, signal);
  if (!text.trim()) throw new Error(tr('{0} 没有返回内容', [conn.name || tr('接口')]));
  return { text, model: name };
}
