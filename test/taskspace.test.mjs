import { isMemoryCall, MEMORY_IDLE } from './helpers.mjs';
import { testInChinese as test } from './helpers.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/app-server.mjs';
import { git } from '../src/git.mjs';
import { parseTriage } from '../src/task-prompts.mjs';
import { AbortedError } from '../src/engines/proc.mjs';
import { tempDir, makeSpace, until, settleSpace, beginTask } from './helpers.mjs';

const plan = (tasks) => ({ text: `计划如下。\n\`\`\`json\n${JSON.stringify({ tasks })}\n\`\`\`` });
const triage = (reply, j) => ({ text: `${reply}\n\n\`\`\`json\n${JSON.stringify(j)}\n\`\`\`` });
const isPlanner = (o) => o.system.includes('这次任务协作的协调者');
const isTriage = (o) => o.system.includes('又发来一条消息');

/** 一个任务空间：T1、T2 两个子任务；worker 由 work(opts) 决定怎么做。 */
async function taskSpace(t, { work, decide, planConfirm = 'manual', tasks } = {}) {
  const space = makeSpace(tempDir(t));
  t.after(() => settleSpace(space));
  const calls = [];
  space.registry.runTurn = async (_engine, opts) => {
    if (isMemoryCall(opts)) return MEMORY_IDLE;
    calls.push(opts);
    if (isPlanner(opts)) return plan(tasks || [
      { id: 'T1', title: '写需求', assignee: 'Alice', deps: [], spec: '写 需求.md' },
      { id: 'T2', title: '写实现', assignee: 'Bob', deps: ['T1'], spec: '写 实现.md' },
    ]);
    if (isTriage(opts)) return decide(opts);
    if (opts.system.includes('写一份简洁的总结')) return { text: '### 完成了什么\n都做完了' };
    return work ? work(opts) : { text: '做完了。\n结果：完成' };
  };
  await beginTask(space, { objective: '写一份方案', discuss: false, planConfirm });
  return { space, calls };
}

test('parseTriage keeps the reply for the user and reads the decision', () => {
  const r = parseTriage('不冲突，交给 T2。\n\n```json\n{"type":"note","why":"补充","notes":[{"task":"T2","text":"带上图片"}]}\n```');
  assert.equal(r.type, 'note');
  assert.equal(r.reply, '不冲突，交给 T2。');
  assert.deepEqual(r.notes, [{ task: 'T2', text: '带上图片' }]);
  assert.equal(parseTriage('只是回答，没有 JSON').type, 'answer');
  // 说要改计划却没给计划：当成普通回答，不动计划
  assert.equal(parseTriage('改\n```json\n{"type":"change"}\n```').type, 'answer');
});

test('task triage receives current images and absolute file paths in current and historical messages', async (t) => {
  const { space, calls } = await taskSpace(t, { decide: () => ({ text: '收到' }) });
  await git(['init', '-q'], { cwd: space.workspacePath });
  const upload = (name, data) => space.attachments.stage({ name, data });
  const image = upload('a.png', 'iVBORw0KGgo=');
  const file = upload('x.txt', 'eA==');
  await space.userMessage('', [image.id, file.id]);
  await until(() => space.data.messages.some((m) => m.decision), Boolean);
  const first = calls.find(isTriage);
  assert.deepEqual(first.images, [{ path: space.attachments.pathOf(image), type: 'image/png', name: 'a.png' }]);
  const abs = path.join(space.workspacePath, '附件', 'x.txt');
  assert.ok(first.prompt.includes('[附件：' + abs + ']'));
  assert.match(first.prompt, /\[图片：a.png\]/);
  space.userMessage('继续');
  await until(() => calls.filter(isTriage).length, (n) => n === 2);
  const next = calls.filter(isTriage)[1];
  assert.ok(next.prompt.includes('[附件：' + abs + ']'));
  assert.equal(next.images, undefined);
});

test('a note reaches the task prompt; unrelated messages leave the plan alone', async (t) => {
  let next;
  const { space, calls } = await taskSpace(t, { decide: () => next });
  await until(() => space.run.data.status, (s) => s === 'plan_review');

  next = triage('不冲突，记为补充说明。', { type: 'note', why: '补充', notes: [{ task: 'T1', text: '需求里写上导出图片' }] });
  space.userMessage('顺便支持导出图片');
  const reply = await until(() => space.data.messages.find((m) => m.decision), Boolean);
  assert.equal(reply.text, '不冲突，记为补充说明。');
  assert.equal(reply.decision.type, 'note');
  assert.equal(space.run.task('T1').notes[0].text, '需求里写上导出图片');
  assert.ok(!space.data.messages.find((m) => m.kind === 'user').queued);

  next = triage('这和目标无关，建议新开一个任务空间。', { type: 'unrelated', why: '无关' });
  space.userMessage('顺便帮我订机票');
  await until(() => space.data.messages.filter((m) => m.decision).length, (n) => n === 2);
  assert.equal(space.run.data.tasks.length, 2);
  assert.equal(space.data.messages.filter((m) => m.decision)[1].decision.type, 'unrelated');

  await space.runAction('approve-plan');
  await until(() => space.run.task('T1').status, (s) => s === 'review');
  const worker = calls.find((o) => o.system.includes('子任务 T1'));
  assert.match(worker.prompt, /用户中途补充的要求/);
  assert.match(worker.prompt, /需求里写上导出图片/);
});

test('a conflicting message stops the running task, discards its edits, and waits for plan confirmation', async (t) => {
  let release;
  const { space } = await taskSpace(t, {
    work: (opts) => {
      if (!opts.system.includes('子任务 T1') || release === null) return { text: '做完了。\n结果：完成' };
      fs.writeFileSync(path.join(opts.cwd, '半成品.md'), '做了一半');
      return new Promise((_resolve, reject) => {
        release = () => reject(new AbortedError());
        opts.signal.addEventListener('abort', () => release(), { once: true });
      });
    },
    decide: () => triage('有冲突：先停下 T1，改成两步。', {
      type: 'change', why: '做法变了', stop: [{ task: 'T1', keep: false }],
      tasks: [
        { id: 'T1', title: '写需求（HTML 版）', assignee: 'Alice', deps: [], spec: '先出 HTML' },
        { id: 'T3', title: '转成 PDF', assignee: 'Bob', deps: ['T1'], spec: '把 HTML 转成 PDF' },
      ],
    }),
  });
  await until(() => space.run.data.status, (s) => s === 'plan_review');
  await space.runAction('approve-plan');
  await until(() => space.run.task('T1').status, (s) => s === 'running');
  await until(() => fs.existsSync(path.join(space.workspacePath, '半成品.md')), Boolean);

  space.userMessage('改成先出 HTML 再转 PDF');
  const reply = await until(() => space.data.messages.find((m) => m.decision), Boolean);
  release = null; // 之后的 T1 直接做完
  const d = reply.decision;
  assert.equal(d.type, 'change');
  assert.deepEqual(d.stopped, [{ task: 'T1', title: '写需求', keep: false }]);
  assert.deepEqual(d.added.map((x) => x.task), ['T3']);
  assert.deepEqual(d.removed.map((x) => x.task), ['T2']);
  assert.equal(d.hold, true);
  assert.equal(fs.existsSync(path.join(space.workspacePath, '半成品.md')), false, 'Discarded edits are undone');
  assert.equal(space.run.task('T2').status, 'cancelled');
  assert.equal(space.run.task('T1').spec, '先出 HTML');
  assert.equal(space.run.task('T1').attempts[0].outcome, 'stopped');

  // 等你确认：确认之前不派新的子任务
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(space.run.task('T1').status, 'pending');
  await space.runAction('confirm-plan');
  await until(() => space.run.task('T1').status, (s) => s === 'review');
});

test('auto-confirm starts right after planning, and a new requirement after the summary reopens the run', async (t) => {
  let next;
  const { space } = await taskSpace(t, {
    planConfirm: 'auto',
    tasks: [{ id: 'T1', title: '写需求', assignee: 'Alice', deps: [], spec: '写 需求.md' }],
    decide: () => next,
  });
  space.run.data.autoApprove = true;
  await until(() => space.run.data.status, (s) => s === 'done');
  assert.equal(space.data.messages.filter((m) => m.kind === 'summary').length, 1);

  next = triage('追加一个子任务。', { type: 'change', why: '新要求', tasks: [
    { id: 'T1', title: '写需求', assignee: 'Alice', deps: [], spec: '写 需求.md' },
    { id: 'T2', title: '补充示例', assignee: 'Bob', deps: [], spec: '加一个示例' },
  ] });
  space.userMessage('再补一个示例');
  await until(() => space.data.messages.filter((m) => m.kind === 'summary').length, (n) => n === 2);
  assert.equal(space.run.data.status, 'done');
  assert.equal(space.run.task('T2').status, 'approved');
  assert.equal(space.run.task('T1').attempts.length, 1, 'Approved tasks are not redone');
});

test('server: legacy spaces are removed, folders lock across spaces, and summaries go back to chat', { timeout: 60000 }, async (t) => {
  const root = tempDir(t);
  const dataDir = path.join(root, 'data');
  const legacyId = '11111111-2222-3333-4444-555555555555';
  const own = path.join(root, 'own-folder');
  fs.mkdirSync(own);
  fs.writeFileSync(path.join(own, 'keep.txt'), 'keep');
  fs.mkdirSync(path.join(dataDir, 'spaces', legacyId, 'files'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'spaces', `${legacyId}.json`), JSON.stringify({ id: legacyId, title: '旧空间', members: [], messages: [], runs: [], workspace: { type: 'folder', path: own } }));

  const server = await startServer({ port: 0, dataDir, mock: true, hooks: { locales: () => ['zh-CN'] } });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const api = async (p, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const read = async (p) => (await api(p)).body;

  assert.equal((await read('/api/app')).removedLegacy, 1);
  assert.equal((await read('/api/spaces')).length, 0);
  assert.equal(fs.existsSync(path.join(dataDir, 'spaces', legacyId)), false);
  assert.equal(fs.readFileSync(path.join(own, 'keep.txt'), 'utf8'), 'keep', 'Folders you chose are never touched');

  const members = [{ engine: 'claude-code', name: 'Alice' }, { engine: 'codex', name: 'Bob' }];
  const chat = (await api('/api/spaces', { title: '讨论', members, workspace: { type: 'folder', path: own } })).body;
  assert.equal(chat.kind, 'chat');
  await api(`/api/spaces/${chat.id}/messages`, { text: '@Alice 说说方案' });
  const talked = await until(() => read(`/api/spaces/${chat.id}`), (s) => !s.running && s.messages.some((m) => m.kind === 'ai'));
  const ids = talked.messages.map((m) => m.id);
  const distilled = (await api(`/api/spaces/${chat.id}/distill`, { ids, memberId: talked.members[0].id })).body;
  assert.match(distilled.text, /演示/);

  assert.equal((await api('/api/spaces', { kind: 'task', members })).status, 400, 'A task space needs a goal');
  const created = await api('/api/spaces', { kind: 'task', objective: distilled.text, members, planConfirm: 'auto', discuss: false, autoApprove: false, workspace: { type: 'folder', path: own }, source: { spaceId: chat.id, messages: ids.length } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const task = created.body;
  assert.equal(task.kind, 'task');
  assert.equal(task.source.title, '讨论');
  assert.equal((await api(`/api/spaces/${chat.id}/run/resume`, {})).status, 400, 'Chat spaces have no task');

  // 依次直接改执行期间：聊天空间只读，聊天照常
  const locked = await until(() => read(`/api/spaces/${chat.id}`), (s) => !!s.readOnly);
  assert.equal(locked.readOnly.spaceId, task.id);
  const upload = await api(`/api/spaces/${chat.id}/attachments`, { name: 'x.txt', data: 'eA==' });
  assert.equal(upload.status, 400);
  assert.match(upload.body.error, /现在不能加附件/);
  const write = await api(`/api/spaces/${chat.id}/file`, { path: 'x.md', content: 'x' }, 'PUT');
  assert.equal(write.status, 400);
  assert.match(write.body.error, /只读/);
  assert.equal((await read('/api/spaces')).find((s) => s.id === chat.id).readOnly, true);

  for (let i = 0; i < 100; i++) {
    const s = await read(`/api/spaces/${task.id}`);
    if (s.run.status === 'done') break;
    for (const k of s.run.tasks.filter((x) => x.status === 'review')) await api(`/api/spaces/${task.id}/run/approve-task`, { taskId: k.id });
    await new Promise((r) => setTimeout(r, 100));
  }
  await until(() => read(`/api/spaces/${chat.id}`), (s) => !s.readOnly);

  const fin = await api(`/api/spaces/${task.id}/run/finish`, { postBack: true });
  assert.deepEqual(fin.body, { ok: true, posted: true });
  const back = (await read(`/api/spaces/${chat.id}`)).messages.at(-1);
  assert.equal(back.kind, 'task');
  assert.equal(back.taskSpaceId, task.id);
  assert.match(back.text, /完成了什么/);
  const ended = await api(`/api/spaces/${task.id}/messages`, { text: '再改一下' });
  assert.equal(ended.status, 400);
  assert.match(ended.body.error, /已经结束/);
  assert.equal((await read('/api/spaces')).find((s) => s.id === task.id).finished, true);
});
