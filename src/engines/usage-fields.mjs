// 各引擎把自己输出里的用量整理成统一格式（runTurn 返回值里的 usage）：
//   { input, output, cacheRead, cacheWrite, contextUsed?, contextWindow?, quota?: { usedPct, resetsAt } }
// input 是没命中缓存的输入，提示总量 = input + cacheRead + cacheWrite；resetsAt 是毫秒时间戳。
// 拿不到的字段不写；一样都拿不到时返回 undefined。

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function usageOf({ input, output, cacheRead, cacheWrite, contextUsed, contextWindow, quota } = {}) {
  const u = {};
  for (const [k, v] of Object.entries({ input, output, cacheRead, cacheWrite, contextUsed, contextWindow })) {
    if (num(v) !== undefined) u[k] = v;
  }
  if (quota) u.quota = quota;
  return Object.keys(u).length ? u : undefined;
}

/** 几个额度窗口里用得最多的那个（真正卡你的是它）。windows：[{ usedPct, resetsAt }]，resetsAt 可以是秒或毫秒。 */
export function quotaOf(windows) {
  const list = windows.filter((w) => num(w?.usedPct) !== undefined);
  if (!list.length) return undefined;
  const w = list.reduce((a, b) => (b.usedPct > a.usedPct ? b : a));
  const at = num(w.resetsAt);
  return { usedPct: Math.round(w.usedPct * 10) / 10, ...(at !== undefined ? { resetsAt: at < 1e12 ? at * 1000 : at } : {}) };
}

/** 一次请求的上下文长度：提示总量 + 这次的输出（下一轮会带上它）。 */
export function contextOf({ input = 0, cacheRead = 0, cacheWrite = 0, output = 0 }) {
  return (num(input) || 0) + (num(cacheRead) || 0) + (num(cacheWrite) || 0) + (num(output) || 0);
}

/** OpenAI 风格的输入（含缓存命中）换成没命中缓存的部分。 */
export const uncached = (total, ...cached) => {
  if (num(total) === undefined) return undefined;
  return Math.max(0, total - cached.reduce((s, c) => s + (num(c) || 0), 0));
};
