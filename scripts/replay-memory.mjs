#!/usr/bin/env node
// 离线时序回放脚本：按事件时序回放真实空间的消息与当时时刻的 tasks 快照（不泄露未来验收状态），
// 用于离线对比不同整理模型的产出条目、被拒原因、工具步数、耗时与实付 token/缓存回执。
// 用法：node scripts/replay-memory.mjs --space data/spaces/<id>.json [--mock | --engine gemini --model gemini-2.5-flash] [--batch-size 10] [--out report.json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSettings } from '../src/settings.mjs';
import { createRegistry, CLI_ENGINE_IDS } from '../src/engines/index.mjs';
import { openMemory } from '../src/memory/store.mjs';
import { organize, isArchivableMessage } from '../src/memory/organize.mjs';

/** 还原某个时间点 atTs 的子任务快照：未来验收、未来执行与未来打回意见一律隐藏。 */
export function taskSnapshotAt(tasks, atTs) {
  return (tasks || []).map((t) => {
    const attempts = (t.attempts || [])
      .filter((a) => (a.startedAt ?? a.endedAt ?? 0) <= atTs)
      .map((a) => {
        if (a.endedAt != null && a.endedAt > atTs) {
          const { endedAt, outcome, report, error, ...running } = a;
          return running;
        }
        return { ...a };
      });
    const feedbacks = (t.feedbacks || []).filter((f) => (f.ts ?? 0) <= atTs).map((f) => ({ ...f }));
    let status = t.status;
    let approvedAt = t.approvedAt;
    if (status === 'approved' && approvedAt != null && approvedAt > atTs) {
      status = 'review';
      approvedAt = undefined;
    }
    return {
      ...t,
      status,
      ...(approvedAt != null ? { approvedAt } : {}),
      attempts,
      feedbacks,
      changes: status === 'approved' || attempts.some((a) => a.endedAt != null) ? [...(t.changes || [])] : [],
    };
  });
}

export async function replaySpace({ spaceData, registry, writer, batchSize = 10, outDir = null }) {
  const workDir = outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-replay-'));
  const cleanup = !outDir;
  try {
    const memory = openMemory(path.join(workDir, 'memory'));
    const allMessages = (spaceData.messages || [])
      .map((m, i) => ({ ...m, seq: Number.isInteger(m.seq) ? m.seq : i + 1 }))
      .sort((a, b) => a.seq - b.seq);
    const allTasks = (spaceData.runs || []).flatMap((r) => r.tasks || []);
    const archivable = allMessages.filter(isArchivableMessage);
    const batches = [];
    for (let i = 0; i < archivable.length; i += Math.max(1, batchSize)) {
      const slice = archivable.slice(i, i + Math.max(1, batchSize));
      const cutoffSeq = slice.at(-1).seq;
      const cutoffTs = slice.reduce((max, m) => Math.max(max, Number.isFinite(m.ts) ? m.ts : 0), 0);
      const visibleSoFar = allMessages.filter((m) => m.seq <= cutoffSeq);
      const tasksAtPoint = taskSnapshotAt(allTasks, cutoffTs);
      const host = {
        registry,
        members: spaceData.members || [writer],
        workspacePath: workDir,
        kind: spaceData.kind || 'chat',
        access: 'read',
        messages: (since = 0) => visibleSoFar.filter((m) => m.seq > since && !m.streaming),
        tasks: () => tasksAtPoint,
      };
      const record = await organize(host, memory, { writer, limit: { messages: batchSize } });
      batches.push(record);
    }
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let totalDurationMs = 0, totalToolCalls = 0, totalAdded = 0, totalRejected = 0;
    const rejectedReasons = {};
    for (const b of batches) {
      totalDurationMs += b.durationMs || 0;
      totalToolCalls += b.toolCalls || 0;
      totalAdded += b.added?.length || 0;
      totalRejected += b.rejected?.length || 0;
      for (const r of b.rejected || []) rejectedReasons[r.reason] = (rejectedReasons[r.reason] || 0) + 1;
      if (b.usage) for (const k of Object.keys(usage)) if (Number.isFinite(b.usage[k])) usage[k] += b.usage[k];
    }
    return {
      writer: { id: writer.id, name: writer.name, engine: writer.engine, model: writer.model || '' },
      batchCount: batches.length,
      totalAdded,
      totalRejected,
      rejectedReasons,
      totalToolCalls,
      totalDurationMs,
      usage,
      entries: memory.entries(),
      batches,
    };
  } finally {
    if (cleanup) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = { mock: false, batchSize: 10, dataDir: path.resolve('data') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--space') args.space = argv[++i];
    else if (a === '--engine') args.engine = argv[++i];
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--data-dir') args.dataDir = path.resolve(argv[++i]);
    else if (a === '--batch-size') args.batchSize = Math.max(1, parseInt(argv[++i], 10) || 10);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--mock') args.mock = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.space) {
    console.error('Usage: node scripts/replay-memory.mjs --space <space.json> [--mock | --engine <id> --model <name>] [--batch-size 10] [--out report.json]');
    process.exit(1);
  }
  const spaceData = JSON.parse(fs.readFileSync(path.resolve(args.space), 'utf8'));
  const settings = createSettings(path.join(args.dataDir, 'settings.json'), { pathKeys: CLI_ENGINE_IDS });
  const registry = createRegistry(settings, { mock: args.mock });
  const baseWriter = spaceData.members?.[0] || { id: 'replay', name: 'Replay', engine: 'codex' };
  const writer = {
    ...baseWriter,
    ...(args.engine ? { engine: args.engine } : {}),
    ...(args.model ? { model: args.model } : {}),
  };
  const report = await replaySpace({ spaceData, registry, writer, batchSize: args.batchSize });
  const summary = {
    writer: report.writer,
    batchCount: report.batchCount,
    totalAdded: report.totalAdded,
    totalRejected: report.totalRejected,
    rejectedReasons: report.rejectedReasons,
    totalToolCalls: report.totalToolCalls,
    totalDurationMs: report.totalDurationMs,
    usage: report.usage,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (args.out) fs.writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
