import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { recompressImport } from '../src/imports.mjs';
import { makeSpace, tempDir, until } from './helpers.mjs';

for (const activity of ['chat', 'planning', 'worker', 'topic import']) {
  test(`deleting a space waits for ${activity} to stop and prevents resurrection`, async (t) => {
    const root = tempDir(t);
    const external = path.join(root, 'external');
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, 'keep.txt'), 'keep me');
    const space = makeSpace(root, activity === 'worker' ? { workspace: { type: 'folder', path: external } } : {});
    let started = false;
    let stopped = false;
    space.registry.runTurn = async (_engine, opts) => {
      if (activity === 'worker' && opts.system.includes('这次任务协作的协调者')) {
        return { text: JSON.stringify({ tasks: [{ id: 'T1', title: '测试', assignee: 'Alice', deps: [], spec: '等待中止' }] }) };
      }
      started = true;
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          // 模拟进程收到中止后还需要一点时间退出。
          setTimeout(() => { stopped = true; reject(Object.assign(new Error('已中止'), { aborted: true })); }, 15);
        }, { once: true });
      });
    };
    if (activity === 'chat') space.userMessage('@Alice 等待中止');
    else if (activity === 'topic import') {
      space.data.messages.push({ id: 'topic-a', kind: 'import', mode: 'topic', status: 'error', topic: '接口', name: 'Bob', sourceLabel: 'Codex', writerId: 'member-b', entries: [{ role: 'user', text: '整理接口', acts: [] }] });
      recompressImport(space, 'topic-a');
    } else {
      await space.startRun({ objective: '等待中止', discuss: false });
      if (activity === 'worker') {
        await until(() => space.run.data.status, (s) => s === 'plan_review');
        await space.runAction('approve-plan');
      }
    }
    await until(() => started, Boolean);
    const firstDelete = space.remove();
    assert.equal(space.remove(), firstDelete, 'Repeated deletion shares the same operation');
    await firstDelete;
    assert.ok(stopped, 'Deletion must wait for the active engine to exit');
    assert.equal(space.pendingOperations.size, 0);
    assert.equal(fs.existsSync(space.store.file(space.id)), false);
    assert.equal(fs.existsSync(space.dir), false);
    space.save();
    assert.equal(fs.existsSync(space.store.file(space.id)), false, 'A late save cannot restore the space');
    assert.equal(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8'), 'keep me');
  });
}
