import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeDir, appDataDir } from '../src/importers/common.mjs';
import { meta, list, read } from '../src/importers/zcode.mjs';

// Node 22.13 以下没有 node:sqlite（Agenda 运行在 Electron 自带的 Node 24 上，不受影响），这时跳过
const sqlite = await import('node:sqlite').catch(() => null);
const test = sqlite ? nodeTest : nodeTest.skip;
const { DatabaseSync } = sqlite || {};

const TIME = 1800000000000;

// 所有内容均为自造；先导入模块，再改环境变量，验证路径没有在模块顶层缓存。
function fixture(t, { create = true, sequence = true, desktop = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-zcode-test-'));
  const saved = {};
  const handles = [];
  for (const name of ['USERPROFILE', 'HOME', 'APPDATA', 'XDG_CONFIG_HOME']) {
    saved[name] = process.env[name];
    process.env[name] = name === 'USERPROFILE' || name === 'HOME' ? root : path.join(root, name);
  }
  t.after(() => {
    for (const db of handles) db.close();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('agenda-zcode-test-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const file = homeDir('.zcode', 'cli', 'db', 'db.sqlite');
  const indexFile = homeDir('.zcode', 'v2', 'tasks-index.sqlite');
  const cwd = path.join(root, 'example-project');
  if (!create) return { root, file, indexFile, cwd };
  const open = (file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    handles.push(db);
    return db;
  };
  const db = open(file);
  const seq = sequence ? ', sequence INTEGER' : '';
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, parent_id TEXT,
      task_type TEXT DEFAULT 'interactive', time_updated INTEGER, time_deleted INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT${seq});
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT${seq});
    CREATE INDEX message_session ON message(session_id);
    CREATE INDEX part_session ON part(session_id);
  `);
  let index;
  if (desktop) {
    index = open(indexFile);
    index.exec(`CREATE TABLE tasks (task_id TEXT, title TEXT, title_overridden INTEGER DEFAULT 0,
      deleted INTEGER DEFAULT 0, updated_at INTEGER, acp_session_id TEXT);`);
  }
  const session = (id, title = '测试对话', extra = {}) => db.prepare(`INSERT INTO session
    (id, title, directory, parent_id, task_type, time_updated, time_deleted) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, title, extra.cwd || cwd, extra.parent || null, extra.type || 'interactive', extra.time || TIME, extra.deleted || null);
  const message = (sid, id, role, parts, extra = {}, position = 0, time = TIME) => {
    db.prepare(`INSERT INTO message (id, session_id, time_created, data${sequence ? ', sequence' : ''})
      VALUES (?, ?, ?, ?${sequence ? ', ?' : ''})`)
      .run(id, sid, time, JSON.stringify({ role, time: { created: time }, ...extra }), ...(sequence ? [position] : []));
    parts.forEach((part, n) => db.prepare(`INSERT INTO part
      (id, message_id, session_id, time_created, data${sequence ? ', sequence' : ''})
      VALUES (?, ?, ?, ?, ?${sequence ? ', ?' : ''})`)
      .run(`${id}-${n}`, id, sid, time, JSON.stringify(part), ...(sequence ? [n] : [])));
  };
  return { root, file, indexFile, cwd, db, index, session, message };
}

const text = (value, extra = {}) => ({ type: 'text', text: value, ...extra });
const tool = (name, input) => ({ type: 'tool', tool: name, state: {
  status: 'completed', input, output: '排除：工具原始输出', metadata: { fullOutput: '排除：额外输出' },
} });

test('ZCode 元信息和缺失数据目录', (t) => {
  fixture(t, { create: false });
  assert.deepEqual(meta, { id: 'zcode', label: 'ZCode', engine: null });
  assert.deepEqual(list(), []);
  assert.throws(() => read('missing'), /无法读取 ZCode 对话/);
});

test('共享库同时列出桌面版和 CLI，桌面标题覆盖且不重复', (t) => {
  const f = fixture(t);
  f.session('sess-desktop', '原始标题');
  f.session('sess-cli', '终端任务', { time: TIME - 1000 });
  f.index.prepare('INSERT INTO tasks (task_id, title, title_overridden, updated_at) VALUES (?, ?, 1, ?)')
    .run('sess-desktop', '桌面重命名', TIME + 500);
  f.message('sess-desktop', 'd-user', 'user', [text('请检查示例项目')]);
  f.message('sess-cli', 'c-user', 'user', [text('解释示例函数')]);
  assert.deepEqual(list(), [
    { id: 'sess-desktop', title: '桌面重命名', cwd: f.cwd, updatedAt: TIME + 500 },
    { id: 'sess-cli', title: '终端任务', cwd: f.cwd, updatedAt: TIME - 1000 },
  ]);
  assert.equal(read('sess-desktop').title, '桌面重命名');
  assert.equal(read('sess-desktop').cwd, f.cwd);
  assert.equal(read('sess-cli').entries[0].text, '解释示例函数');
});

test('按 sequence 整理一问一答，合并用户分块和连续 AI 消息', (t) => {
  const f = fixture(t, { desktop: false });
  f.session('ordered', '整理示例');
  // 故意乱序插入；时间和 ID 也与对话顺序相反。
  f.message('ordered', 'a-last', 'assistant', [text('第二轮回答')], {}, 4, TIME - 500);
  f.message('ordered', 'b-user', 'user', [text('继续')], {}, 3);
  f.message('ordered', 'c-ai', 'assistant', [text('补充说明')], {}, 2);
  f.message('ordered', 'd-ai', 'assistant', [text('第一轮回答')], {}, 1);
  f.message('ordered', 'z-first', 'user', [text('第一行'), text('第二行')], {
    semantics: { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible' },
    anchor: { origin: 'realUser' },
  }, 0);
  const result = read('ordered');
  assert.equal(result.title, '整理示例');
  assert.equal(result.cwd, f.cwd);
  assert.deepEqual(result.entries.map(({ role, text, acts }) => ({ role, text, acts })), [
    { role: 'user', text: '第一行\n第二行', acts: [] },
    { role: 'ai', text: '第一轮回答\n\n补充说明', acts: [] },
    { role: 'user', text: '继续', acts: [] },
    { role: 'ai', text: '第二轮回答', acts: [] },
  ]);
  assert.equal(result.entries[0].ts, TIME);
  assert.equal(result.entries[1].key, 'c-ai-0');
});

test('操作只保留简短摘要，排除工具输出、思考、系统注入和后台消息', (t) => {
  const f = fixture(t);
  f.session('filtered');
  const hidden = [
    ['system', {}],
    ['user', { synthetic: true }],
    ['user', { source: 'subagent_message' }],
    ['user', { visibility: 'model-only' }],
    ['user', { anchor: { origin: 'goalContinuation' } }],
    ['user', { semantics: { origin: 'system', kind: 'system_reminder' } }],
    ['user', { semantics: { origin: 'agent_runtime', kind: 'background_notification' } }],
    ['assistant', { summary: true }],
    ['assistant', { semantics: { origin: 'system', kind: 'timeline_event' } }],
    ['assistant', { semantics: { kind: 'compact_summary' } }],
    ['assistant', { semantics: { uiVisibility: 'hidden' } }],
  ];
  hidden.forEach(([role, extra], n) => f.message('filtered', `hidden-${n}`, role, [text('排除：注入消息')], extra, n));
  f.message('filtered', 'human', 'user', [
    text('<environment_context>排除：环境</environment_context>修复示例<system-reminder>排除：提醒</system-reminder>'),
    text('<skills_instructions>排除：技能目录</skills_instructions>'),
    text('排除：合成分块', { synthetic: true }),
    text('排除：忽略分块', { ignored: true }),
    { type: 'file', url: '排除：附件' },
    { type: 'tool_result', content: '排除：工具返回' },
  ], { contextSnapshot: { envInfo: '排除：上下文快照' }, system: '排除：系统指令' }, 20);
  f.message('filtered', 'answer', 'assistant', [
    { type: 'reasoning', text: '排除：思考过程' },
    tool('Read', { file_path: path.join(f.cwd, 'a.js') }),
    tool('Edit', { file_path: path.join(f.cwd, 'b.md'), old_string: '排除：旧文件', new_string: '排除：新文件' }),
    tool('Write', { file_path: path.join(f.cwd, 'c.txt'), content: '排除：文件全文' }),
    tool('Bash', { command: 'npm test', description: '排除：冗长说明' }),
    tool('WebSearch', { query: '示例接口' }),
    tool('WebFetch', { url: 'https://example.com/help' }),
    tool('TodoWrite', { todos: ['排除：内部工具'] }),
    tool('Read', {}),
    { type: 'step-finish', text: '排除：步骤信息' },
    text('排除：合成回答', { synthetic: true }),
    text('已修复示例'),
  ], { semantics: { origin: 'agent_runtime', kind: 'assistant_response', uiVisibility: 'visible' } }, 21);
  const result = read('filtered');
  assert.deepEqual(result.entries.map((e) => [e.role, e.text]), [['user', '修复示例'], ['ai', '已修复示例']]);
  assert.deepEqual(result.entries[1].acts, [
    '读取 a.js', '修改 b.md', '写入 c.txt', '运行 npm test', '搜索：示例接口', '打开网页 https://example.com/help',
  ]);
  assert.doesNotMatch(JSON.stringify(result), /排除：/);
});

test('子代理、子任务及已删除会话不会单独列出或读取', (t) => {
  const f = fixture(t);
  f.session('main');
  f.session('child', '派生会话', { parent: 'main' });
  f.session('worker', '子代理', { type: 'subagent_child' });
  f.session('workflow', '子任务', { type: 'workflow_child' });
  f.session('nested', '嵌套任务', { type: 'nested_workflow_child' });
  f.session('deleted', '已删除', { deleted: TIME });
  f.session('desktop-deleted');
  f.index.exec("INSERT INTO tasks (task_id, deleted) VALUES ('desktop-deleted', 1)");
  assert.deepEqual(list().map((r) => r.id), ['main']);
  for (const id of ['child', 'worker', 'workflow', 'nested', 'deleted', 'desktop-deleted']) {
    assert.throws(() => read(id), /找不到这段 ZCode 对话/);
  }
});

test('旧版无 sequence 的库按时间读取，兼容桌面旧 ACP 映射', (t) => {
  const f = fixture(t, { sequence: false });
  f.db.exec('ALTER TABLE session DROP COLUMN task_type; ALTER TABLE session DROP COLUMN time_deleted');
  f.db.prepare('INSERT INTO session (id, title, directory, time_updated) VALUES (?, ?, ?, ?)')
    .run('legacy-session', '旧标题', f.cwd, TIME);
  f.index.exec("INSERT INTO tasks (task_id, acp_session_id, title, title_overridden) VALUES ('wrapper', 'legacy-session', '旧桌面标题', 1)");
  f.message('legacy-session', 'first', 'user', [text('旧版问题')], {}, 0, TIME);
  f.message('legacy-session', 'second', 'assistant', [text('旧版回答')], {}, 0, TIME + 100);
  assert.equal(list()[0].title, '旧桌面标题');
  assert.deepEqual(read('legacy-session').entries.map((e) => e.text), ['旧版问题', '旧版回答']);
});

test('新版本 assistant blockIndex 决定文本与操作顺序', (t) => {
  const f = fixture(t);
  f.session('blocks');
  f.message('blocks', 'user', 'user', [text('整理步骤')]);
  f.message('blocks', 'ai', 'assistant', [
    { ...text('结束'), blockIndex: 4 },
    { ...tool('Bash', { command: 'npm test' }), blockIndex: 3 },
    { type: 'reasoning', text: '排除：思考', blockIndex: 1 },
    { ...tool('Read', { file_path: path.join(f.cwd, 'a.js') }), blockIndex: 2 },
    { ...text('开始'), blockIndex: 0 },
  ], {}, 1);
  const ai = read('blocks').entries[1];
  assert.equal(ai.text, '开始\n\n结束');
  assert.deepEqual(ai.acts, ['读取 a.js', '运行 npm test']);
});

test('几百段会话的列表查询不读取 message / part 正文', (t) => {
  const f = fixture(t);
  f.db.exec('BEGIN');
  for (let n = 0; n < 500; n++) f.session(`bulk-${n}`, `虚构任务 ${n}`);
  f.db.exec('COMMIT');
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    assert.doesNotMatch(sql, /\b(?:message|part)\b/i, '列表只能查询元数据');
    return prepare.call(this, sql);
  });
  assert.equal(list().length, 500);
});

test('每次调用重新计算目录，Electron 应用缓存和 rollout 不冒充对话', (t) => {
  const f = fixture(t, { create: false });
  const cache = appDataDir('ZCode');
  const rollout = homeDir('.zcode', 'cli', 'rollout');
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(rollout, { recursive: true });
  fs.writeFileSync(path.join(rollout, 'model-io-sess_fake.jsonl'), '{"type":"model-io","text":"自造的请求日志"}\n');
  assert.ok(cache.startsWith(f.root));
  assert.deepEqual(list(), []);
});

test('损坏数据库返回空列表及明确的中文读取错误', (t) => {
  const f = fixture(t, { create: false });
  fs.mkdirSync(path.dirname(f.file), { recursive: true });
  fs.writeFileSync(f.file, '自造的损坏数据库');
  assert.deepEqual(list(), []);
  assert.throws(() => read('fake'), /无法读取 ZCode 对话.*格式不受支持/);
  assert.deepEqual(list(), []);
});

test('数据库被独占时可恢复，读取不留下连接或修改正文', (t) => {
  const f = fixture(t);
  f.session('locked');
  f.message('locked', 'user', 'user', [text('锁测试问题')]);
  const before = fs.readFileSync(f.file);
  f.db.exec('BEGIN EXCLUSIVE');
  try {
    assert.deepEqual(list(), []);
    assert.throws(() => read('locked'), /无法读取 ZCode 对话.*数据库可能被占用/);
  } finally { f.db.exec('ROLLBACK'); }
  assert.equal(list().length, 1);
  assert.equal(read('locked').entries[0].text, '锁测试问题');
  f.db.exec('BEGIN EXCLUSIVE; ROLLBACK');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('桌面索引读取失败也安全返回，恢复后可正常导入', (t) => {
  const f = fixture(t);
  f.session('indexed');
  f.index.exec('BEGIN EXCLUSIVE');
  try {
    assert.deepEqual(list(), []);
    assert.throws(() => read('indexed'), /无法读取 ZCode 对话/);
  } finally { f.index.exec('ROLLBACK'); }
  assert.equal(list().length, 1);
});

test('坏消息分块可跳过，未知 id 和 SQL 片段不能读到其它会话', (t) => {
  const f = fixture(t);
  f.session('safe');
  f.message('safe', 'user', 'user', [text('有效问题')]);
  f.db.exec("INSERT INTO message VALUES ('bad-message', 'safe', 0, '{', 1)");
  f.db.exec("INSERT INTO part VALUES ('bad-part', 'user', 'safe', 0, '{', 1)");
  assert.deepEqual(read('safe').entries.map((e) => e.text), ['有效问题']);
  assert.throws(() => read("' OR 1=1 --"), /找不到这段 ZCode 对话/);
  assert.throws(() => read(null), /ZCode 会话 id 不对/);
});
