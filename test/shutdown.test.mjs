import { isMemoryCall, MEMORY_IDLE } from './helpers.mjs';
import { testInChinese as test } from './helpers.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { runJsonl, AbortedError } from '../src/engines/proc.mjs';
import { Space } from '../src/space.mjs';
import { tempDir, makeSpace, until, settleSpace, beginTask } from './helpers.mjs';

// 一个先输出一行、之后隔 gapMs 再输出一行就退出的“CLI”
const cli = (gapMs) => ({
  cmd: process.execPath,
  args: ['-e', `console.log('{"n":1}'); setTimeout(() => console.log('{"n":2}'), ${gapMs});`],
});

test('a CLI that goes silent is stopped, but waiting on the person does not count', async () => {
  await assert.rejects(
    runJsonl({ ...cli(3000), idleMs: 300, onEvent() {} }),
    (e) => e.stalled === true && /没有任何动静/.test(e.message),
  );

  const seen = [];
  const r = await runJsonl({
    ...cli(900),
    idleMs: 500,
    onEvent(obj, ctl) {
      seen.push(obj.n);
      if (obj.n === 1) ctl.hold(sleep(800)); // 像在等你确认一条命令
    },
  });
  assert.deepEqual(seen, [1, 2]);
  assert.equal(r.code, 0);
});

test('quitting stops task workers without recording them as cancelled by the user', { timeout: 30000 }, async (t) => {
  const space = makeSpace(tempDir(t));
  t.after(() => settleSpace(space));
  let aborted = 0;
  space.registry.runTurn = (_engine, opts) => {
    if (isMemoryCall(opts)) return MEMORY_IDLE;
    if (opts.system.includes('这次任务协作的协调者')) return Promise.resolve({ text: JSON.stringify({ tasks: [{ id: 'T1', title: '慢活', assignee: 'Alice', deps: [], spec: '一直做' }] }) });
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => { aborted++; reject(new AbortedError()); }, { once: true });
    });
  };
  await beginTask(space, { objective: '做一件很慢的事', discuss: false });
  await until(() => space.run.data.status, (s) => s === 'plan_review');
  await space.runAction('approve-plan');
  await until(() => space.run.taskDetail('T1').status, (s) => s === 'running');

  space.shutdown();
  assert.equal(aborted, 1, 'the worker process must be stopped');
  await sleep(300);

  const [saved] = space.store.loadAll();
  assert.equal(saved.runs[0].tasks[0].status, 'running', 'nothing is saved after shutdown');
  const dataDir = path.resolve(space.dir, '..', '..');
  const reopened = new Space(saved, { registry: space.registry, store: space.store, dataDir });
  const task = reopened.run.data.tasks[0];
  assert.equal(task.status, 'ready');
  assert.match(task.attempts.at(-1).error, /软件关闭/);
  assert.equal(reopened.run.data.paused, true);
});
