// API 引擎共用的 HTTP 工具。
// 在桌面版里会换成 Electron 的 net.fetch：它走系统代理（访问 Google 等服务通常需要）。
import { AbortedError, brief } from './proc.mjs';

let fetchImpl = (...a) => globalThis.fetch(...a);
export function setFetch(fn) { fetchImpl = fn; }

export async function request(url, { method = 'GET', headers = {}, body, signal } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw new AbortedError();
    throw new Error(`网络请求失败（${brief(e.cause?.message || e.message, 200)}）。如果需要代理才能访问，请确认代理已开启。`);
  }
  return res;
}

export async function errorText(res) {
  const raw = await res.text().catch(() => '');
  try {
    const j = JSON.parse(raw);
    const e = Array.isArray(j) ? j[0]?.error : j.error;
    if (e?.message) return `${res.status} ${brief(e.message, 300)}`;
  } catch { /* 不是 JSON */ }
  return `${res.status} ${brief(raw, 300)}`;
}

/** 读取 Server-Sent Events 流，每个 data 行解析成 JSON 后回调。 */
export async function readSse(res, onData, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { onData(JSON.parse(data)); } catch { /* 半行或非 JSON */ }
      }
    }
  } catch (e) {
    if (signal?.aborted) throw new AbortedError();
    throw e;
  }
}
