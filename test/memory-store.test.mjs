import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testInChinese as test, tempDir } from './helpers.mjs';
import { withLanguage } from '../src/i18n.mjs';
import { openMemory } from '../src/memory/store.mjs';
import { tokenize } from '../src/memory/tokens.mjs';

const fact = { type: 'fact', text: '演示文件存在', source: { files: ['demo.js'] } };
const sms = { type: 'decision', origin: 'user', text: '登录用短信验证码', reason: '目标用户多数没有邮箱',
  source: { messages: [128], tasks: ['T3'] }, related: [7, 15], topics: ['登录'] };
const line = '#12 [决定·你定的] 登录用短信验证码——目标用户多数没有邮箱（出处：消息 128、任务 T3；相关：#7、#15）';
const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');

test('条目递增、只追加，派生状态和更正不回写到原行', (t) => {
  const dir = path.join(tempDir(t), 'memory');
  const mem = openMemory(dir);
  const initial = mem.append(Array.from({ length: 11 }, () => fact));
  assert.deepEqual(initial.map((e) => e.id), Array.from({ length: 11 }, (_, i) => i + 1));
  const [entry] = mem.append([sms]);
  assert.ok(entry.addedAt > 0);
  const prefix = read(dir, 'entries.jsonl');
  assert.ok(!prefix.includes('"status"'));
  assert.equal(mem.render({ layer: 1 }), line);
  const [next] = mem.append([{ ...sms, text: '登录改回短信', supersedes: [12] }]);
  assert.equal(next.id, 13);
  assert.ok(read(dir, 'entries.jsonl').startsWith(prefix));
  assert.deepEqual([mem.get(12).status, mem.get(12).by], ['superseded', 13]);
  assert.ok(!mem.active().some((e) => e.id === 12));
  const rows = mem.entries();
  rows[11].source.messages.pop();
  assert.deepEqual(openMemory(dir).get(12).source.messages, [128]);
  assert.deepEqual(mem.corrections(12), ['#13 取代 #12：登录改回短信']);
  assert.deepEqual(mem.corrections(13), []);
  assert.ok(read(dir, 'memory.md').includes(line + '〔已被 #13 取代〕'));
});

test('重整前第 1 层始终只在末尾追加，重整后按当时有效的条目重新开始', (t) => {
  const mem = openMemory(tempDir(t));
  assert.equal(mem.render(), '');
  assert.equal(mem.compactedAt, 0);
  mem.append([sms, { ...sms, text: '登录改用邮箱', supersedes: [1] }]);
  const first = mem.render({ layer: 1 });
  assert.equal(first, mem.render({ layer: 1 }));
  assert.ok(first.endsWith('#2 取代 #1：登录改用邮箱'));
  mem.append([{ ...sms, text: '以前用密码', supersededBy: 2 }]);
  assert.equal(mem.render({ layer: 1 }), first);
  assert.deepEqual(mem.compact(), { compactedAt: 3 });
  const compacted = mem.render({ layer: 1 });
  assert.ok(compacted.startsWith('#2 ['));
  assert.ok(!compacted.includes('\n'));
  mem.append([{ ...sms, text: '登录改回短信', supersedes: [2] }]);
  const after = mem.render({ layer: 1 });
  assert.ok(after.startsWith(compacted + '\n#4 ['));
  assert.ok(after.endsWith('#4 取代 #2：登录改回短信'));
  mem.append([{ ...fact, supersedes: [4] }]);
  assert.equal(mem.render({ layer: 1 }), after + '\n#5 取代 #4：演示文件存在');
  assert.deepEqual(mem.compact(), { compactedAt: 5 });
  assert.equal(mem.render({ layer: 1 }), '');
  assert.equal(openMemory(mem.dir).compactedAt, 5);
});

test('主题和任务目录只列有效项，条目详情保留双向历史和现有原话路径', (t) => {
  const mem = openMemory(tempDir(t));
  mem.append([{ ...sms, source: { messages: [128, 129] } },
    { ...sms, supersedes: [1], source: { tasks: ['T3/2', 'T1'] }, topics: ['登录', '短信'] },
    { ...fact, task: 'T3', topics: ['短信'] }, { ...sms, text: '早期方案', supersededBy: 1 },
    { ...fact, type: 'question', text: '开放注册吗？' }, { ...sms, resolves: [5], topics: [] }]);
  assert.equal(mem.get(5).status, 'resolved');
  assert.deepEqual(mem.corrections(4), ['#6 解决 #5：登录用短信验证码']);
  assert.equal(mem.render({ layer: 2 }), '### 主题\n- 登录：#2\n- 短信：#2、#3\n### 任务\n- T3：#2、#3、#6\n- T1：#2');
  mem.archive([{ seq: 128, text: '第一行\n第二行' }]);
  mem.archive([{ seq: 128, text: '不能覆盖原话' }]);
  assert.equal(mem.readMessage(128), '# 消息 128 ·  · \n\n第一行\n第二行\n');
  assert.equal(mem.readMessage(129), null);
  assert.equal(mem.readMessage('../state'), null);
  const detail = mem.render({ layer: 3, ids: [1] });
  for (const s of ['状态：已被 #2 取代', '取代了：#4', '后来被取代：#2', 'messages/128.md']) assert.ok(detail.includes(s));
  assert.ok(!detail.includes('messages/129.md'));
  assert.ok(mem.render({ layer: 3, ids: [4] }).includes('后来被取代：#1、#2'));
  assert.ok(read(mem.dir, 'memory.md').includes('〔已解决：#6〕'));
  assert.equal(mem.render({ layer: 3, ids: [999] }), '');
  assert.ok(read(mem.dir, 'memory.md').includes(mem.render()));
});

test('协调者看全局，工作者四段按编号去重，只收直接依赖的最新有效结果', (t) => {
  const mem = openMemory(tempDir(t));
  const result = { type: 'result', task: 'T1', text: '第一版接口', source: { tasks: ['T1/1'] } };
  mem.append([{ ...fact, type: 'constraint', reason: '项目要求', text: '需要离线运行' },
    { ...fact, type: 'preference', scope: 'T3' }, { ...fact, source: { tasks: ['T3/1'] } },
    result, { ...result, text: '第二版接口', source: { tasks: ['T1/2'] }, supersedes: [4] },
    { ...sms, source: { messages: [1] }, topics: ['验证码'] },
    { ...fact, files: ['src/ui.js'] }, { ...result, task: 'T2', source: { tasks: ['T2/1'] } },
    { ...fact, type: 'preference', scope: 'T9' }]);
  const global = mem.render({ layer: 1 });
  assert.equal(mem.render({ layer: 1, task: { coordinator: true } }), global);
  assert.ok(global.includes('#9 ['));
  const view = mem.render({ layer: 1, member: { id: 'a' }, task: { id: 'T3', deps: ['T1'], files: ['src/ui.js'], text: '验证码' } });
  assert.deepEqual(view.split('\n').map((s) => s.match(/^#\d+/)?.[0] || s),
    ['### 全员都要遵守', '#1', '### 你的子任务 T3', '#2', '#3', '### 前置任务的结果', '#5', '### 相关', '#6', '#7']);
  assert.ok(mem.render({ layer: 3, ids: [4] }).includes('第一版接口'));
  assert.ok(view.includes('任务 T1 第 2 次执行'));
});

test('预算计入换行和标题，有查询保留高分，无查询保留最新', (t) => {
  const mem = openMemory(tempDir(t));
  mem.append(['查询短信', '更新页面', '清空记录'].map((text) => ({ ...sms, text, topics: [], related: [] })));
  const lines = mem.render({ layer: 1 }).split('\n');
  const budget = lines[0].length;
  assert.equal(mem.render({ layer: 1, budget, query: '短信' }), lines[0]);
  assert.equal(mem.render({ layer: 1, budget }), lines[2]);
  assert.equal(mem.render({ layer: 1, budget: 1 }), '');
  const task = { id: 'T3', deps: [] };
  assert.equal(mem.render({ layer: 1, task, budget, query: '短信' }), '');
  assert.equal(mem.render({ layer: 1, task, budget: budget + '### 你的子任务 T3\n'.length, query: '短信' }), '### 你的子任务 T3\n' + lines[0]);
});

test('中文相邻两字、英文词和罕见词权重；同分按较新的编号排', (t) => {
  assert.deepEqual(tokenize('登录方式 A 甲 HTTP_2 33 𠀀丁'), ['登录', '录方', '方式', '甲', 'http_2', '33', '𠀀丁']);
  const mem = openMemory(tempDir(t));
  mem.append([{ ...fact, text: '登录方式', reason: '较少', scope: 'api', files: ['src/Parser.js'] },
    { ...fact, text: '登录' }, { ...fact, text: '原方法 legacy' }, { ...fact, text: '登录', supersedes: [3] }]);
  assert.deepEqual(mem.search('登录 登录').map((r) => r.entry.id), [4, 2, 1]);
  assert.equal(mem.search('登录 登录')[0].score, Math.log1p(3 / 3));
  assert.deepEqual(mem.search('录方式', { limit: 1 }).map((r) => r.score), [2 * Math.log1p(3)]);
  for (const q of ['PARSER', 'api', '较少']) assert.equal(mem.search(q)[0].entry.id, 1);
  assert.deepEqual(mem.search('legacy'), []);
  assert.equal(mem.search('LEGACY', { all: true })[0].entry.status, 'superseded');
});

test('坏行和未写完的末行可跳过，序号、状态和日志重开后保留', (t) => {
  const dir = tempDir(t), mem = openMemory(dir);
  const warnings = t.mock.method(console, 'warn', () => {});
  mem.append([fact]);
  fs.appendFileSync(path.join(dir, 'entries.jsonl'), 'null\n{"id":12');
  assert.equal(mem.append([fact])[0].id, 2);
  assert.deepEqual(openMemory(dir).entries().map((e) => e.id), [1, 2]);
  assert.ok(warnings.mock.callCount() >= 2);
  mem.setLastSeq(8);
  mem.setLastSeq(3);
  mem.compact();
  assert.deepEqual(JSON.parse(read(dir, 'state.json')), { lastSeq: 8, compactedAt: 2 });
  assert.equal(openMemory(dir).lastSeq, 8);
  mem.log({ at: 1 });
  mem.log({ at: 2 });
  assert.deepEqual(mem.logs(1), [{ at: 2 }]);
  assert.deepEqual(mem.logs(2), [{ at: 1 }, { at: 2 }]);
});

test('结果、否决和分歧使用固定的单行文字和出处格式', (t) => {
  const mem = openMemory(tempDir(t));
  mem.append(Array.from({ length: 17 }, () => fact));
  mem.append([{ type: 'result', task: 'T3', text: 'T3 登录页做完，改了 src/login.js', source: { tasks: ['T3/2'] } },
    fact, fact, { type: 'rejected', text: '登录不用邮箱', reason: '目标用户多数没有邮箱', source: { messages: [40] } },
    { type: 'disagreement', text: '代码现在用邮箱登录，和 #12 不一致', ask: true, source: { tasks: ['T4'] }, related: [12] }]);
  const lines = read(mem.dir, 'memory.md').split('\n');
  for (const expected of [
    '#18 [任务结果] T3 登录页做完，改了 src/login.js（出处：任务 T3 第 2 次执行）',
    '#21 [否决过] 登录不用邮箱——目标用户多数没有邮箱（出处：消息 40）',
    '#22 [分歧·问你] 代码现在用邮箱登录，和 #12 不一致（出处：任务 T4；相关：#12）',
  ]) assert.ok(lines.includes(expected));
});

test('英文渲染保留原文，翻译类型、出处、历史和目录标题', (t) => withLanguage('en', () => {
  const mem = openMemory(tempDir(t));
  mem.append([{ ...sms, importedAt: Date.UTC(2026, 10, 20) }, { ...sms, supersedes: [1] }]);
  assert.ok(mem.render({ layer: 1 }).startsWith('#1 [Decision·yours] 登录用短信验证码 — 目标用户多数没有邮箱 (source: message 128, task T3; imported on 2026-11-20; related: #7, #15)'));
  assert.ok(mem.render().includes('### Topics'));
  assert.ok(read(mem.dir, 'memory.md').includes('[replaced by #2]'));
}));
