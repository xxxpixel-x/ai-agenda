import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Store } from '../src/store.mjs';
import { Space } from '../src/space.mjs';
import { createSettings } from '../src/settings.mjs';
import { createRegistry } from '../src/engines/index.mjs';

export function tempDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('agenda-test-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
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
}
