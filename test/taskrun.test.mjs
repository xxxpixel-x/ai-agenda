import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as G from '../src/git.mjs';
import { tempDir, makeSpace, until, settleSpace } from './helpers.mjs';

for (const mode of ['direct', 'git']) {
  test(`mock task workflow: plan, review, dependency scheduling and completion (${mode})`, { timeout: 60000 }, async (t) => {
    let space;
    t.after(async () => { if (space) await settleSpace(space); });
    const root = tempDir(t);
    const repo = path.join(root, 'project');
    let initialHead;
    if (mode === 'git') {
      fs.mkdirSync(repo);
      await G.git(['init', '-b', 'main'], { cwd: repo });
      await G.git(['config', 'commit.gpgsign', 'false'], { cwd: repo });
      await G.git(['config', 'core.autocrlf', 'false'], { cwd: repo });
      fs.writeFileSync(path.join(repo, 'README.md'), '# Fixture\n');
      initialHead = await G.commitAll(repo, 'Initialize test repository');
    }
    space = makeSpace(root, mode === 'git' ? { workspace: { type: 'folder', path: repo } } : {});
    assert.equal((await space.taskPreflight()).mode, mode);
    await space.startRun({ objective: '写一份小项目方案', discuss: false, autoApprove: false });
    const run = space.run;
    await until(() => run.publicView(), (r) => r.status === 'plan_review', { message: 'Plan was not ready' });
    assert.equal(run.data.tasks.length, 3);
    await space.runAction('approve-plan');
    const ready = await until(() => run.publicView(), (r) => r.tasks[0].status === 'review', { message: 'First task did not reach review' });
    assert.equal(ready.tasks[2].attempts.length, 0, 'Dependent task must wait for approval');
    assert.ok(run.taskDetail('T1').attempts[0].report);
    const diff = await run.fileDiff('T1', '需求.md');
    assert.ok(JSON.stringify(diff).includes('Alice'));
    if (mode === 'git') {
      assert.equal(await G.headOf(repo), initialHead);
      assert.equal(fs.existsSync(path.join(repo, '需求.md')), false);
    }
    for (const id of ['T1', 'T2', 'T3']) {
      await until(() => run.taskDetail(id), (task) => task.status === 'review', { message: `${id} did not reach review` });
      assert.equal(run.taskDetail(id).attempts[0].outcome, 'done');
      await space.runAction('approve-task', { taskId: id });
    }
    await until(() => run.publicView(), (r) => r.status === 'done', { message: 'Summary did not finish' });
    assert.ok(run.data.tasks.every((task) => task.status === 'approved'));
    assert.ok(run.data.summary.text && !run.data.summary.error);
    assert.ok(space.data.messages.some((m) => m.runId === run.id));
    if (mode === 'git') {
      await space.runAction('merge');
      assert.equal(run.data.merged.branch, 'main');
      assert.notEqual(await G.headOf(repo), initialHead);
      assert.equal((await G.repoInfo(repo)).dirty, false);
      const branches = await G.git(['branch', '--list', 'agenda-*'], { cwd: repo });
      assert.equal(branches.stdout.trim(), '');
    }
    for (const file of ['需求.md', '实现.md', '方案.md']) {
      assert.ok(fs.existsSync(path.join(space.workspacePath, file)), file);
    }
    await space.runAction('close');
    clearTimeout(run.timer);
    assert.equal(space.run, null);
    assert.equal(space.toJSON().pastRuns.length, 1);
  });
}
