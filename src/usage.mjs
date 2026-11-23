// 从空间里的聊天和任务记录读取每轮用量，供成员标签、上下文面板和后续优化使用。

/** 遍历空间里所有能归到成员名下的用量记录。 */
export function records(spaceData) {
  const result = [];
  function add(sink, at, fallbackId) {
    const memberId = sink?.memberId ?? fallbackId;
    if (memberId && sink?.usage) result.push({ memberId, at, usage: sink.usage });
  }

  for (const msg of spaceData?.messages ?? []) add(msg, msg?.ts);
  for (const run of spaceData?.runs ?? []) {
    for (const msg of run?.planning?.messages ?? []) add(msg, msg?.ts);
    for (const task of run?.tasks ?? []) {
      for (const attempt of task?.attempts ?? []) add(attempt, attempt?.startedAt, task.assigneeId);
    }
    add(run?.summary, run?.finishedAt ?? run?.updatedAt, run?.coordinatorId);
  }
  return result;
}

/** 按成员汇总 token 和轮数；指定 since 时仅统计时间达到起点的记录。 */
export function summarize(spaceData, { since } = {}) {
  const totals = new Map();
  for (const { memberId, at, usage } of records(spaceData)) {
    if (since != null && (!Number.isFinite(at) || at < since)) continue;
    if (!totals.has(memberId)) totals.set(memberId, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 });
    const total = totals.get(memberId);
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      if (Number.isFinite(usage[key])) total[key] += usage[key];
    }
    total.turns++;
  }
  return Object.fromEntries(totals);
}

/** 取成员最近一次的用量；没有时间的排在最早，同一时间取后遍历到的。 */
export function latest(spaceData, memberId) {
  let usage = null;
  let newest = -Infinity;
  for (const record of records(spaceData)) {
    if (record.memberId !== memberId) continue;
    const at = Number.isFinite(record.at) ? record.at : -Infinity;
    if (at >= newest) {
      newest = at;
      usage = record.usage;
    }
  }
  return usage;
}

/** 独立统计后台整理与会话交接的用量（不与前台成员发言混淆）。 */
export function summarizeBackground(spaceData, { since } = {}) {
  const sum = (items = []) => {
    const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
    for (const item of items) {
      if (!item?.usage) continue;
      if (since != null && (!Number.isFinite(item.at) || item.at < since)) continue;
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
        if (Number.isFinite(item.usage[key])) total[key] += item.usage[key];
      }
      total.turns++;
    }
    return total;
  };
  return {
    organize: sum(spaceData?.organizeLogs),
    handoff: sum(spaceData?.handoffLogs),
  };
}
