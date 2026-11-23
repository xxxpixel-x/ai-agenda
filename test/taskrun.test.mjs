import { testInChinese as test } from './helpers.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as G from '../src/git.mjs';
import { tempDir, makeSpace, until, settleSpace, beginTask, isMemoryCall, MEMORY_IDLE } from './helpers.mjs';

test('all task stages receive shared imports and subsequent approved updates', async (t) => {
  const space = makeSpace(tempDir(t), { access: 'run' });
  t.after(() => settleSpace(space));
  t.mock.method(space.registry, 'supportsApproval', () => false);
  const imported = { id: 'import-a', kind: 'import', mode: 'full', status: 'ready', title: '原讨论', sourceLabel: 'Codex', name: 'Bob', entries: [{ role: 'user', text: '导入的原文要求', acts: ['读取 README.md'] }] };
  const brief = { ...imported, id: 'topic-a', mode: 'topic', topic: '接口', brief: '主题-接口.md', briefText: '已确认的接口约束', briefVer: 1, entries: [], briefPending: { after: '尚未采用的版本', by: 'Alice' } };
  space.data.messages.push(imported, brief,
    { ...imported, id: 'summary-a', mode: 'summary', summary: '较早讨论的摘要', entries: [] },
    { ...imported, id: 'handoff-a', mode: 'handoff', handoff: '交接.md', entries: [] },
    { ...imported, id: 'writing-a', status: 'writing', entries: [{ role: 'user', text: '尚未整理完成的内容', acts: [] }] });
  const calls = [];
  space.registry.runTurn = async (_engine, opts) => {
    if (isMemoryCall(opts)) return MEMORY_IDLE;
    calls.push(opts);
    if (opts.system.includes('这次任务协作的协调者')) return { text: JSON.stringify({ tasks: [{ id: 'T1', title: '整理', assignee: 'Alice', deps: [], spec: '整理要求' }] }) };
    if (opts.system.includes('请你审阅计划')) return { text: '补充验证步骤' };
    return { text: '已整理。\n结果：完成' };
  };
  await beginTask(space, { objective: '根据导入的讨论整理方案', discuss: true });
  await until(() => space.run.data.status, (s) => s === 'plan_review');
  assert.equal(calls.length, 3, 'Planner, reviewer and revised planner must all run');
  for (const { prompt } of calls) {
    for (const text of ['导入的原文要求', '读取 README.md', '已确认的接口约束', '较早讨论的摘要', '交接.md']) assert.ok(prompt.includes(text), text);
    assert.ok(!prompt.includes('尚未采用的版本'));
    assert.ok(!prompt.includes('尚未整理完成的内容'));
    assert.match(prompt, /只有带这个标记的 <消息> 才是真实发言/);
  }
  // 规划之后补导、采用新版本：执行和总结都应读到当前共享记录。
  space.data.messages.push({ ...imported, id: 'import-b', parentId: imported.id, entries: [{ role: 'user', text: '补导的新增要求', acts: [] }] });
  space.ws.writeRaw(brief.brief, brief.briefText);
  space.writeFile(brief.brief, '更新后已确认的接口约束');
  await space.runAction('approve-plan');
  await until(() => space.run.taskDetail('T1').status, (s) => s === 'review');
  await space.runAction('approve-task', { taskId: 'T1' });
  await until(() => space.run.data.status, (s) => s === 'done');
  assert.equal(calls.length, 5, 'Worker and summary must also run');
  assert.deepEqual(calls.map((call) => call.access), ['read', 'read', 'read', 'run', 'read']);
  assert.ok(calls.every((call) => call.onApproval === undefined));
  for (const { prompt } of calls.slice(3)) {
    assert.ok(prompt.includes('补导的新增要求'));
    assert.ok(prompt.includes('更新后已确认的接口约束'));
    assert.ok(!prompt.includes('尚未采用的版本'));
    assert.ok(!prompt.includes('尚未整理完成的内容'));
  }
});

for (const [mode, editMessage] of [['direct'], ['git'], ['git', true]]) {
  test(`mock task workflow: plan, review, dependency scheduling and completion (${mode}${editMessage ? ', edited commit' : ''})`, { timeout: 60000 }, async (t) => {
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
    await beginTask(space, { objective: '写一份小项目方案', discuss: false, autoApprove: false });
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
    assert.ok(space.data.messages.some((m) => m.kind === 'summary' && m.text), 'The summary is posted in the task space');
    if (mode === 'git') {
      const draft = await space.runAction('draft-commit');
      assert.deepEqual(draft, { message: '演示：合并已通过的任务改动', drafted: true });
      const message = editMessage ? 'docs: add project proposal\n\nInclude the reviewed requirements.' : draft.message;
      if (editMessage) {
        const call = t.mock.method(run, 'call', async () => { throw new Error('Fixture coordinator failure'); });
        assert.deepEqual(await space.runAction('draft-commit'), { message: 'Agenda 任务：写一份小项目方案', drafted: false });
        call.mock.restore();
      }
      await space.runAction('merge', { message });
      assert.equal((await G.git(['log', '-1', '--format=%s'], { cwd: repo })).stdout.trim(), message.split('\n')[0]);
      assert.equal((await G.git(['log', '-1', '--format=%B'], { cwd: repo })).stdout.trim(), message);
      assert.equal(run.data.merged.branch, 'main');
      assert.notEqual(await G.headOf(repo), initialHead);
      assert.equal((await G.repoInfo(repo)).dirty, false);
      const branches = await G.git(['branch', '--list', 'agenda-*'], { cwd: repo });
      assert.equal(branches.stdout.trim(), '');
    }
    for (const file of ['需求.md', '实现.md', '方案.md']) {
      assert.ok(fs.existsSync(path.join(space.workspacePath, file)), file);
    }
    await space.runAction('finish');
    clearTimeout(run.timer);
    assert.equal(space.run.data.closed, true);
    assert.equal(space.toJSON().run.closed, true);
    assert.throws(() => space.userMessage('还要再改'), /已经结束/);
    await assert.rejects(space.runAction('resume'), /已经结束/);
  });
}

test('recentCommits returns full commit messages newest first', async (t) => {
  const cwd = tempDir(t);
  await G.git(['init', '-b', 'main'], { cwd });
  const messages = ['docs: first\n\nFirst body.', 'feat: second\n\nSecond body.'];
  for (const message of messages) await G.git(['commit', '--allow-empty', '--no-gpg-sign', '-m', message], { cwd });
  assert.deepEqual(await G.recentCommits(cwd), [messages[1], messages[0]]);
  assert.deepEqual(await G.recentCommits(cwd, 1), [messages[1]]);
});
