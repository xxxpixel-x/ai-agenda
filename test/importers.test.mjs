// 导入来源：WorkBuddy、Gemini CLI 的读取，粘贴文字 / 导出文件的整理，以及没有对应成员的导入。
// 测试数据全是编造的，写在临时文件夹里；用户主目录指到临时文件夹。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { tempDir, makeSpace } from './helpers.mjs';
import * as workbuddy from '../src/importers/workbuddy.mjs';
import * as geminiCli from '../src/importers/gemini-cli.mjs';
import { parseImport } from '../src/importers/parse.mjs';
import { configureImporters, stagePasted, readSession } from '../src/importers/index.mjs';
import { importSession, importsBackground } from '../src/imports.mjs';

function fakeHome(t) {
  const root = tempDir(t);
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = process.env.HOME = root;
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  return root;
}
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n');

test('workbuddy: only your own words, the current branch, and short action summaries', (t) => {
  const home = fakeHome(t);
  assert.deepEqual(workbuddy.list(), []);
  const id = '11111111-2222-4333-8444-555555555555';
  const cwd = path.join(home, 'proj');
  const msg = (mid, parentId, role, content) => ({ id: mid, parentId, timestamp: 1000, type: 'message', role, content, sessionId: id, cwd });
  write(path.join(home, '.workbuddy', 'projects', 'p1', `${id}.jsonl`), jsonl([
    { type: 'session-meta', id: 's', sessionId: id, timestamp: 1, meta: {} },
    msg('u1', undefined, 'user', [{ type: 'input_text', text: '<system-reminder>规则一大段</system-reminder>\n<user_query>帮我写一份大纲</user_query>' }]),
    { type: 'file-history-snapshot', messageId: 'u1' },
    { id: 'r1', parentId: 'u1', type: 'reasoning', content: [] },
    { id: 't', timestamp: 2, type: 'ai-title', aiTitle: '写大纲', sessionId: id, cwd },
    { id: 'f1', parentId: 'r1', type: 'function_call', name: 'Read', arguments: JSON.stringify({ file_path: path.join(cwd, 'a.md') }), cwd },
    { id: 'f1r', parentId: 'f1', type: 'function_call_result', name: 'Read', output: { type: 'text', text: '文件原文不该出现' } },
    { id: 'f2', parentId: 'f1r', type: 'function_call', name: 'TaskCreate', arguments: '{}' },
    msg('a1', 'f2', 'assistant', [{ type: 'output_text', text: '大纲如下' }]),
    msg('old', 'a1', 'user', [{ type: 'input_text', text: '<user_query>被编辑掉的话</user_query>' }]),
    msg('oldA', 'old', 'assistant', [{ type: 'output_text', text: '旧回答' }]),
    { id: 'fork', type: 'resend-fork-notice', editedUserItemId: 'old' },
    msg('tm', 'a1', 'user', '<teammate-message>子代理的汇报</teammate-message>'),
    msg('u2', 'tm', 'user', [{ type: 'input_text', text: '<user_query>改短一点</user_query>' }]),
    msg('a2', 'u2', 'assistant', [{ type: 'output_text', text: '好的' }]),
  ]));
  write(path.join(home, '.workbuddy', 'projects', 'p1', id, 'subagents', 'agent-1.jsonl'), jsonl([msg('x', undefined, 'user', [{ text: '<user_query>子代理</user_query>' }])]));

  const [s, ...rest] = workbuddy.list();
  assert.equal(rest.length, 0);
  assert.deepEqual([s.id, s.title, s.cwd], [id, '写大纲', cwd]);
  const r = workbuddy.read(id);
  assert.deepEqual(r.entries.map((e) => [e.role, e.text, e.acts]), [
    ['user', '帮我写一份大纲', []],
    ['ai', '大纲如下', ['读取 a.md']],
    ['user', '改短一点', []],
    ['ai', '好的', []],
  ]);
});

test('gemini cli: new jsonl and old json sessions, without its own context block', (t) => {
  const home = fakeHome(t);
  assert.deepEqual(geminiCli.list(), []);
  const proj = path.join(home, '.gemini', 'tmp', 'game');
  write(path.join(proj, '.project_root'), path.join(home, 'game'));
  write(path.join(proj, 'chats', 'session-2026-11-11T10-00-aaaa1111.jsonl'), jsonl([
    { sessionId: 'a', projectHash: 'h', startTime: '2026-11-11T10:00:00Z', lastUpdated: '2026-11-11T10:00:00Z', kind: 'main' },
    { id: 'u0', timestamp: '2026-11-11T10:00:00Z', type: 'user', content: [{ text: '<session_context>\n运行环境\n</session_context>' }] },
    { id: 'u1', timestamp: '2026-11-11T10:00:01Z', type: 'user', content: [{ text: '做一个打砖块游戏' }] },
    { id: 'g1', timestamp: '2026-11-11T10:00:02Z', type: 'gemini', content: '先看看' },
    { id: 'g1', toolCalls: [{ name: 'read_file', args: { file_path: path.join(home, 'game', 'main.js') }, result: [{ text: '原文' }] }, { name: 'run_shell_command', args: { command: 'npm test' } }] },
    { id: 'i1', timestamp: '2026-11-11T10:00:03Z', type: 'info', content: '登录成功' },
    { $set: { summary: '打砖块游戏' } },
  ]));
  write(path.join(proj, 'chats', 'session-only-login.jsonl'), jsonl([
    { sessionId: 'b', kind: 'main' },
    { id: 'u0', type: 'user', content: [{ text: '<session_context>x</session_context>' }] },
  ]));
  write(path.join(home, '.gemini', 'tmp', 'old', 'chats', 'session-old.json'), JSON.stringify({
    sessionId: 'c', messages: [{ id: 'm1', type: 'user', content: '旧版的问题' }, { id: 'm2', type: 'gemini', content: '旧版的回答' }],
  }));

  const list = geminiCli.list().sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(list.map((s) => [s.id, s.title]), [['session-2026-11-11T10-00-aaaa1111', '打砖块游戏'], ['session-old', '旧版的问题']]);
  assert.equal(list[0].cwd, path.join(home, 'game'));
  assert.deepEqual(geminiCli.read(list[0].id).entries.map((e) => [e.role, e.text, e.acts]), [
    ['user', '做一个打砖块游戏', []],
    ['ai', '先看看', ['读取 main.js', '运行 npm test']],
  ]);
  assert.equal(geminiCli.read('session-old').entries.length, 2);
});

test('pasted text is split by speaker labels from common chat apps', () => {
  const [gpt] = parseImport('You said:\n写首诗\nChatGPT said:\n春眠不觉晓\n处处闻啼鸟\nYou said:\n再来一首');
  assert.equal(gpt.sourceLabel, 'ChatGPT');
  assert.deepEqual(gpt.entries.map((e) => [e.role, e.text]), [['user', '写首诗'], ['ai', '春眠不觉晓\n处处闻啼鸟'], ['user', '再来一首']]);

  const [cn] = parseImport('我：今天吃什么\n豆包：火锅吧\n我：好');
  assert.equal(cn.sourceLabel, '豆包');
  assert.equal(cn.entries.length, 3);

  const [md] = parseImport('## User\n\n怎么排序\n\n## Assistant\n\n用 sort\n\n注意：默认按字符串');
  assert.equal(md.sourceLabel, '');
  assert.deepEqual(md.entries.map((e) => e.text), ['怎么排序', '用 sort\n\n注意：默认按字符串']);

  const [plain] = parseImport('只是一段笔记\n注意：没有说话人');
  assert.deepEqual(plain.entries.map((e) => e.role), ['ai']);
  assert.deepEqual(parseImport('   '), []);
});

test('exports from ChatGPT, Claude.ai and Google Takeout, including zip files', () => {
  const node = (id, parent, role, text, extra = {}) => ({ id, parent, message: { id, author: { role }, content: { content_type: 'text', parts: [text] }, create_time: 1700000000, recipient: 'all', ...extra } });
  const chatgpt = [{
    title: '旅行计划', current_node: 'a2',
    mapping: {
      root: { id: 'root', parent: null, message: null },
      s: node('s', 'root', 'system', '系统提示'),
      u1: node('u1', 's', 'user', '去哪玩'),
      old: node('old', 'u1', 'assistant', '被重新生成掉的回答'),
      a1: node('a1', 'u1', 'assistant', '去杭州'),
      w: { id: 'w', parent: 'a1', message: { id: 'w', author: { role: 'assistant' }, recipient: 'web', content: { content_type: 'code', text: '杭州 景点' } } },
      a2: node('a2', 'w', 'assistant', '推荐西湖'),
    },
  }];
  const [c] = parseImport(JSON.stringify(chatgpt));
  assert.equal(c.sourceLabel, 'ChatGPT');
  assert.deepEqual(c.entries.map((e) => [e.role, e.text, e.acts]), [['user', '去哪玩', []], ['ai', '去杭州\n\n推荐西湖', ['搜索：杭州 景点']]]);

  const claudeAi = [{ name: '起名', chat_messages: [{ sender: 'human', text: '给猫起名' }, { sender: 'assistant', content: [{ type: 'text', text: '叫年糕' }] }] }];
  const [cl] = parseImport(JSON.stringify(claudeAi));
  assert.deepEqual([cl.title, cl.sourceLabel, cl.entries.length], ['起名', 'Claude.ai', 2]);

  const takeout = [
    { header: 'Gemini Apps', title: 'Prompted 第二天的问题', time: '2026-11-12T08:00:00Z', safeHtmlItem: [{ html: '<p>回答&amp;解释</p>' }] },
    { header: 'Gemini Apps', title: 'Prompted 第一天的问题', time: '2026-11-10T08:00:00Z', safeHtmlItem: [{ html: '<p>好</p>' }] },
    { header: 'Search', title: '无关的记录', time: '2026-11-10T09:00:00Z' },
  ];
  const days = parseImport(JSON.stringify(takeout));
  assert.equal(days.length, 2);
  assert.deepEqual(days[0].entries.map((e) => e.text), ['第二天的问题', '回答&解释']);

  // 手工拼一个 zip（一个压缩、一个不压缩的文件），看能不能找到 conversations.json
  const entry = (name, data, method) => {
    const body = method ? zlib.deflateRawSync(data) : data;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(method, 8); local.writeUInt32LE(zlib.crc32(data), 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    return { name: n, method, body, local: Buffer.concat([local, n, body]), crc: zlib.crc32(data), size: data.length };
  };
  const files = [entry('chat.html', Buffer.from('<html></html>'), 0), entry('export/conversations.json', Buffer.from(JSON.stringify(chatgpt)), 8)];
  let offset = 0;
  const central = files.map((f) => {
    const h = Buffer.alloc(46); h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(f.method, 10); h.writeUInt32LE(f.crc, 16);
    h.writeUInt32LE(f.body.length, 20); h.writeUInt32LE(f.size, 24); h.writeUInt16LE(f.name.length, 28); h.writeUInt32LE(offset, 42);
    offset += f.local.length;
    return Buffer.concat([h, f.name]);
  });
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  const [z] = parseImport(Buffer.concat([...files.map((f) => f.local), cd, end]), 'chatgpt-export.zip');
  assert.equal(z.title, '旅行计划');
});

test('a pasted conversation imports as text only, without adding a member', (t) => {
  const root = tempDir(t);
  const space = makeSpace(root);
  configureImporters({ dataDir: path.join(root, 'data') });
  const [s] = stagePasted('You said:\n帮我改标题\nGemini said:\n改成《春》');
  assert.equal(readSession('pasted', s.id).sourceLabel, 'Gemini');
  assert.ok(fs.existsSync(path.join(root, 'data', 'imports', `${s.id}.json`)), '用到时存进数据目录，重新整理时还能读');
  const before = space.data.members.length;
  const msg = importSession(space, { source: 'pasted', sessionId: s.id });
  assert.equal(space.data.members.length, before);
  assert.equal(msg.memberId, null);
  assert.equal(msg.mode, 'full');
  assert.match(importsBackground(space.data.messages), /【我】\n帮我改标题[\s\S]*【Gemini】\n改成《春》/);
});
