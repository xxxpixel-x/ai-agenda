// API 引擎共用的 HTTP 工具。
// 在桌面版里会换成 Electron 的 net.fetch：它走系统代理（访问 Google 等服务通常需要）。
import { t as tr } from '../i18n.mjs';
import { AbortedError, API_IDLE_MS, brief, stalledError } from './proc.mjs';

let fetchImpl = (...a) => globalThis.fetch(...a);
export function setFetch(fn) { fetchImpl = fn; }

const requests = new WeakMap();

function linkAbort(signal, abort) {
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  return () => signal?.removeEventListener('abort', abort);
}

function requestContext(signal, idleMs, name) {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(new AbortedError());
  return { controller, signal, onExternalAbort, idleMs, name, cleanup: linkAbort(signal, onExternalAbort) };
}

// 每个阶段只建一次竞态。即使传输层不响应 abort 或 cancel，调用方也能及时返回。
async function withIdle(controller, idleMs, name, run, cancel) {
  const { signal } = controller;
  const stopped = Promise.withResolvers();
  let timer;
  const touch = () => {
    clearTimeout(timer);
    if (idleMs > 0) timer = setTimeout(() => controller.abort(stalledError(name, idleMs)), idleMs);
  };
  const stop = () => {
    stopped.reject(signal.reason);
    cancel?.();
  };
  if (signal.aborted) { cancel?.(); throw signal.reason; }
  signal.addEventListener('abort', stop, { once: true });
  try {
    touch();
    return await Promise.race([stopped.promise, run(touch)]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}

export async function request(url, { method = 'GET', headers = {}, body, signal, idleMs = API_IDLE_MS, name } = {}) {
  const ctx = requestContext(signal, idleMs, name);
  try {
    const res = await withIdle(ctx.controller, idleMs, name, () => fetchImpl(url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctx.controller.signal,
    }));
    requests.set(res, ctx);
    return res;
  } catch (e) {
    ctx.cleanup();
    if (signal?.aborted) throw new AbortedError();
    if (ctx.controller.signal.aborted) throw ctx.controller.signal.reason;
    throw new Error(tr('网络请求失败（{0}）。如果需要代理才能访问，请确认代理已开启。', [brief(e.cause?.message || e.message, 200)]));
  }
}

async function readBody(res, onChunk, { idleMs, name, signal }) {
  const ctx = requests.get(res) || requestContext(signal);
  const unlink = signal && signal !== ctx.signal ? linkAbort(signal, ctx.onExternalAbort) : null;
  let reader;
  try {
    reader = res.body?.getReader();
    await withIdle(ctx.controller, idleMs ?? ctx.idleMs ?? API_IDLE_MS, name ?? ctx.name, async (touch) => {
      while (reader) {
        const { value, done } = await reader.read();
        if (done || ctx.controller.signal.aborted) break;
        touch();
        onChunk(value);
      }
    }, () => { void reader?.cancel().catch(() => {}); });
  } catch (err) {
    if (signal?.aborted || ctx.signal?.aborted) throw new AbortedError();
    if (ctx.controller.signal.aborted) throw ctx.controller.signal.reason;
    throw err;
  } finally {
    unlink?.();
    ctx.cleanup();
    requests.delete(res);
    reader?.releaseLock();
  }
}

export async function readText(res, { idleMs = 30_000, name } = {}) {
  const decoder = new TextDecoder();
  let text = '';
  await readBody(res, (chunk) => { text += decoder.decode(chunk, { stream: true }); }, { idleMs, name });
  return text + decoder.decode();
}

export async function readJson(res, opts) {
  return JSON.parse(await readText(res, opts));
}

export function cancelBody(res) {
  const ctx = requests.get(res);
  try {
    ctx?.controller.abort();
    // 只丢弃响应，不等传输层确认取消（半开的连接可能一直不确认）。
    void res.body?.cancel().catch(() => {});
  } finally {
    ctx?.cleanup();
    requests.delete(res);
  }
}

export async function readErrorBody(res) {
  try { return await readText(res, { idleMs: 30_000 }); }
  catch (err) {
    if (err.aborted || err.stalled) throw err;
    return '';
  }
}

export async function errorText(res, raw) {
  raw ??= await readErrorBody(res);
  try {
    const j = JSON.parse(raw);
    const e = Array.isArray(j) ? j[0]?.error : j.error;
    if (e?.message) return `${res.status} ${brief(e.message, 300)}`;
  } catch { /* 不是 JSON */ }
  return `${res.status} ${brief(raw, 300)}`;
}

/** 读取 Server-Sent Events 流，每个 data 行解析成 JSON 后回调。 */
export async function readSse(res, onData, signal, { idleMs, name } = {}) {
  const decoder = new TextDecoder();
  let buf = '';
  await readBody(res, (chunk) => {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { onData(JSON.parse(data)); } catch { /* 半行或非 JSON */ }
    }
  }, { idleMs, name, signal });
}
