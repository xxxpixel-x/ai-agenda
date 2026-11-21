import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Store } from '../src/store.mjs';
import { Space } from '../src/space.mjs';
import { createSettings } from '../src/settings.mjs';
import { createRegistry } from '../src/engines/index.mjs';
import { withLanguage, t as tr } from '../src/i18n.mjs';

// Existing fixtures assert Chinese copy. Bilingual tests choose their own context.
export function testInChinese(name, options, fn) {
  if (typeof options === 'function') { fn = options; options = {}; }
  return nodeTest(name, options, (t) => withLanguage('zh', () => fn(t)));
}
testInChinese.skip = nodeTest.skip;

/** 后台整理记忆库的调用（记录调用次数的假 AI 用它跳过，回一个空的整理结果）。 */
export const isMemoryCall = (opts) => ['zh', 'en'].some((lang) => opts?.system?.startsWith(tr('你是这个空间记忆库的整理者', {}, lang)));
export const isHandoffCall = (opts) => ['zh', 'en'].some((lang) => opts?.system === tr('你正在为自己的下一个会话写交接说明。', {}, lang));
export const HANDOFF_IDLE = { text: '[None]' };
export const MEMORY_IDLE = { text: '{"ops":[]}' };

// 文件级清理晚于每个测试的 server.close()/settleSpace()。
const tempRoots = [];
nodeTest.after(() => {
  for (const root of tempRoots) {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('agenda-test-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

export function tempDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-test-'));
  tempRoots.push(root);
  return root;
}

export function makeSpace(root, input = {}) {
  const dataDir = path.join(root, 'data');
  const registry = createRegistry(createSettings(path.join(dataDir, 'settings.json')), { mock: true });
  const store = new Store(path.join(dataDir, 'spaces'));
  const space = Space.create({
    title: '测试空间',
    members: [
      { id: 'member-a', engine: 'claude-code', name: 'Alice' },
      { id: 'member-b', engine: 'codex', name: 'Bob' },
    ],
    access: 'edit',
    maxTurns: 2,
    ...input,
  }, { registry, store, dataDir });
  return space;
}

/**
 * 把 makeSpace 建的空间变成任务空间并开始规划（等同于新建任务空间时填的目标和选项）。
 * 需要先往空间里放东西（比如导入的对话）再开始的测试用它。
 */
export function beginTask(space, { objective, coordinatorId, planConfirm = 'manual', discuss = true, autoApprove = false, maxParallel } = {}) {
  space.data.kind = 'task';
  space.data.pendingTask = { objective, coordinatorId: coordinatorId || space.data.members[0].id, planConfirm, discuss, autoApprove, maxParallel };
  return space.startTask();
}

export async function until(read, predicate, { timeout = 20000, message = 'Timed out waiting for state' } = {}) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await setTimeout(30);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

export async function settleSpace(space) {
  space.stop();
  if (space.run?.controllers.size) await space.run.cancel();
  await until(() => ({ chat: space.running, calls: space.run?.controllers.size || 0 }), (s) => !s.chat && !s.calls);
  if (space.run) clearTimeout(space.run.timer);
  // 后台整理记忆库：停掉并等它收尾（含排队的下一次）
  while (space.memoryRun) { space.memoryAgain = false; space.memoryController?.abort(); await space.memoryRun; }
}
