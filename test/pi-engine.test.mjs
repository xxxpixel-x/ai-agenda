import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { fauxAssistantMessage as reply, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { detect, findShell, insideDir, meta, runTurn, toolsFor, usageFrom } from '../src/engines/pi.mjs';
import { Space } from '../src/space.mjs';
import { Store } from '../src/store.mjs';
import { isMemoryCall, MEMORY_IDLE, settleSpace, tempDir, testInChinese as test, until } from './helpers.mjs';

const fixture = (name) => fileURLToPath(new URL('./fixtures/pi-' + name + '.mjs', import.meta.url));
const call = (name, args) => reply(fauxToolCall(name, args), { stopReason: 'toolUse' });
const results = (ctx) => ctx.messages.filter((m) => m.role === 'toolResult');
const contents = (message) => message.content.map((c) => c.text).join('\n');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4L6gEAANFATOhpbMQAAAAAElFTkSuQmCC';

function setup(t) {
  const root = tempDir(t);
  const cwd = path.join(root, 'shared');
  const agentDir = path.join(root, 'pi');
  const home = path.join(root, 'home');
  fs.mkdirSync(cwd);
  fs.mkdirSync(home);
  for (const key of ['HOME', 'USERPROFILE', 'PI_CODING_AGENT_DIR']) {
    const previous = process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  process.env.HOME = process.env.USERPROFILE = home;
  const faux = fauxProvider({ provider: 'agenda-mock', models: [{ id: 'm1', reasoning: true, input: ['text', 'image'] }] });
  const turn = (steps, options = {}) => {
    faux.setResponses(steps);
    return runTurn({ cwd, agentDir, prompt: 'Hello', provider: faux.provider, ...options });
  };
  return { root, cwd, agentDir, home, faux, turn };
}

test('工具表、Windows shell 探测、接口检测和配置错误', async (t) => {
  const { cwd, agentDir } = setup(t);
  const read = ['read', 'grep', 'find', 'ls'];
  const edit = [...read, 'write', 'edit'];
  assert.deepEqual(toolsFor('read', 'bash'), read);
  assert.deepEqual(toolsFor('edit', 'bash'), edit);
  assert.deepEqual(toolsFor('run', 'powershell'), [...edit, 'powershell']);
  assert.deepEqual(toolsFor('full', 'bash'), [...edit, 'bash']);
  const locate = (files, env = {}, platform = 'win32') => findShell({ platform, env, isFile: (p) => files.includes(p) });
  const bash = 'F:\\Git\\bin\\bash.exe';
  for (const dir of ['cmd', 'bin', 'mingw64\\bin']) {
    const bin = 'F:\\Git\\' + dir;
    assert.deepEqual(locate([bin + '\\git.exe', bash], { PATH: bin }), { tool: 'bash', shellPath: bash });
  }
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const file = 'C:\\Programs\\Git\\bin\\bash.exe';
    assert.deepEqual(locate([file, bash], { [key]: 'C:\\Programs', PATH: 'F:\\Git\\bin' }), { tool: 'bash', shellPath: file });
  }
  assert.deepEqual(locate([bash], { PATH: 'F:\\Git\\bin' }), { tool: 'bash', shellPath: bash });
  const wsl = ['C:\\Windows\\System32', 'D:\\Apps\\WindowsApps\\demo'];
  assert.deepEqual(locate(wsl.map((p) => p + '\\bash.exe'), { PATH: wsl.join(';') }), { tool: 'powershell' });
  assert.deepEqual(locate([]), { tool: 'powershell' });
  assert.deepEqual(locate([], {}, 'linux'), { tool: 'bash' });
  assert.equal((await detect()).ready, false);
  const available = await detect({ sources: [{ name: 'Sample', baseUrl: 'https://example.invalid' }, { name: 'Empty', baseUrl: '  ' }] });
  assert.equal(available.available && available.ready, true);
  assert.match(available.note, /Sample/);
  assert.doesNotMatch(available.note, /Empty/);
  await assert.rejects(runTurn({ cwd }), /Pi 数据目录/);
  await assert.rejects(runTurn({ cwd, agentDir }), /填写地址/);
  await assert.rejects(runTurn({ cwd, agentDir, conn: { baseUrl: 'https://example.invalid' } }), /指定模型/);
});

test('按成员或接口选择模型，运行时密钥保留字面值', async (t) => {
  const { cwd, agentDir, faux } = setup(t);
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  let runtime, selected;
  const stream = ModelRuntime.prototype.streamSimple;
  // 保留真实的模型注册和鉴权，只把最终的流式请求交给 faux。
  t.mock.method(ModelRuntime.prototype, 'streamSimple', function (model, ctx, opts) {
    runtime = this;
    selected = model;
    this.registerNativeProvider(faux.provider);
    return stream.call(this, faux.getModel(), ctx, opts);
  });
  for (const apiKey of ['$AGENDA_FAKE_KEY', '!fake-key']) {
    const override = apiKey.startsWith('!');
    const conn = { id: 'sample', name: '模拟', model: 'default-model', baseUrl: 'https://example.invalid/v1', apiKey, images: !override };
    faux.setResponses([reply('ok')]);
    const r = await runTurn({ cwd, agentDir, conn, model: override ? 'member-model' : '', effort: override ? 'high' : 'off', prompt: 'hello' });
    assert.equal(r.text, 'ok');
    assert.equal(selected.provider, 'agenda-sample');
    assert.equal(selected.api, 'openai-completions');
    assert.equal(selected.baseUrl, conn.baseUrl);
    assert.equal(selected.id, override ? 'member-model' : 'default-model');
    assert.deepEqual(selected.input, override ? ['text'] : ['text', 'image']);
    assert.equal(selected.reasoning, override);
    assert.equal(runtime.getRegisteredProviderConfig('agenda-sample').apiKey, undefined);
    assert.equal((await runtime.getAuth(selected)).auth.apiKey, apiKey);
    const auth = path.join(agentDir, 'auth.json');
    assert.ok(!fs.existsSync(auth) || !fs.readFileSync(auth, 'utf8').includes(apiKey));
  }
});

for (const access of ['read', 'edit', 'run', 'full']) {
  test(access + ' 档的工具、文件边界和目录联接', async (t) => {
    const { root, cwd, turn } = setup(t);
    const file = path.join(root, 'outside.txt');
    fs.writeFileSync(file, 'outside-secret');
    fs.writeFileSync(path.join(cwd, 'inside.txt'), 'inside-data');
    fs.mkdirSync(path.join(root, 'outside-dir'));
    fs.symlinkSync(path.join(root, 'outside-dir'), path.join(cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const shell = findShell().tool;
    const calls = [
      ['read', { path: 'inside.txt' }], ['read', { path: '../outside.txt' }], ['read', { path: file }],
      ['read', { path: pathToFileURL(file).href }], ['write', { path: 'link/new/deep.txt', content: 'escaped' }],
      ['write', { path: file, content: 'changed' }], ['write', { path: 'ok.txt', content: 'ok' }],
      [shell, { command: 'echo x > made.txt' }],
    ];
    let actual;
    await turn([...calls.map(([name, args]) => call(name, args)),
      (ctx) => { actual = results(ctx); return reply('done'); }], { access });
    const full = access === 'full';
    assert.equal(actual.length, calls.length);
    assert.deepEqual(actual.map((r) => !!r.isError), [false, !full, !full, !full, !full, !full, access === 'read', !['run', 'full'].includes(access)]);
    assert.match(contents(actual[0]), /inside-data/);
    for (const r of actual.slice(1, 4)) assert.match(contents(r), full ? /outside-secret/ : /只能访问共享文件夹里的文件/);
    assert.equal(fs.readFileSync(file, 'utf8'), full ? 'changed' : 'outside-secret');
    assert.equal(fs.existsSync(path.join(root, 'outside-dir/new/deep.txt')), full);
    assert.equal(fs.existsSync(path.join(cwd, 'ok.txt')), access !== 'read');
    assert.equal(fs.existsSync(path.join(cwd, 'made.txt')), ['run', 'full'].includes(access));
    assert.ok(insideDir('.', cwd));
    assert.ok(insideDir('new/dir/file', cwd));
    assert.ok(!insideDir('link/missing', cwd));
    if (process.platform === 'win32') assert.ok(insideDir(cwd.toUpperCase(), cwd));
  });
}

test('命令审批的决定、附言、活动、逐条事件和流式分段', async (t) => {
  const { cwd, turn } = setup(t);
  const shell = findShell().tool;
  const commands = ['echo x > allowed.txt', 'echo x > denied.txt', 'echo x > noted.txt'];
  const decisions = [{ allow: true }, { allow: false, note: '稍后再试' }, { allow: true, note: '记录耗时' }];
  const requests = [], activities = [], raw = [], deltas = [];
  let actual;
  const r = await turn([
    reply([fauxText('开始'), fauxToolCall(shell, { command: commands[0] })], { stopReason: 'toolUse' }),
    ...commands.slice(1).map((command) => call(shell, { command })),
    (ctx) => { actual = results(ctx); return reply('结束'); },
  ], {
    access: 'run', onApproval: (req) => { requests.push(req); return decisions.shift(); },
    onActivity: (a) => activities.push(a), onDelta: (s) => deltas.push(s), onRaw: (line) => raw.push(JSON.parse(line)),
  });
  assert.deepEqual(requests, commands.map((command) => ({ command })));
  assert.deepEqual(commands.map((c) => fs.existsSync(path.join(cwd, c.split(' ').at(-1)))), [true, false, true]);
  assert.match(contents(actual[1]), /没有同意.*稍后再试/);
  assert.match(contents(actual[2]), /同意了刚才那条命令，并补充：记录耗时/);
  assert.ok(activities.some((a) => a.kind === 'command' && a.label === '运行 ' + commands[0]));
  assert.ok(raw.some((e) => e.type === 'tool_execution_end'));
  assert.equal(deltas.join(''), r.text);
  assert.equal(r.text, '开始\n\n结束');
});

test('空间把 pi 的文件改动记在发言成员名下', async (t) => {
  const { root, faux, agentDir } = setup(t);
  const dataDir = path.join(root, 'data');
  const registry = {
    list: () => [{ ...meta, sourceChoices: [{ id: 'mock', name: '本地模拟' }] }], detect,
    isApi: () => false, supportsImages: () => true, supportsResume: () => true,
    supportsApproval: () => true, continuesImports: () => false,
    runTurn: (id, opts) => { if (isMemoryCall(opts)) return MEMORY_IDLE; assert.equal(id, 'pi'); return runTurn({ ...opts, provider: faux.provider, agentDir }); },
  };
  const space = Space.create({ title: '测试', members: [{ id: 'member-a', engine: 'pi', name: '小林' }], access: 'edit', maxTurns: 1 },
    { registry, dataDir, store: new Store(path.join(dataDir, 'spaces')) });
  t.after(() => settleSpace(space));
  faux.setResponses([call('write', { path: 'note.txt', content: 'agenda' }), reply('已写入')]);
  space.userMessage('@小林 写个文件');
  await until(() => space.running, (running) => !running);
  const msg = space.data.messages.find((m) => m.kind === 'ai');
  assert.equal(msg.error, undefined);
  const [change] = msg.changes;
  assert.equal(change.path, 'note.txt');
  const history = JSON.parse(fs.readFileSync(space.ws.historyFile, 'utf8'));
  assert.ok(history.some((c) => c.id === change.id && c.msgId === msg.id && c.by === '小林' && c.after === 'agenda'));
});

test('子进程隔离个人和项目资源', async (t) => {
  const { root, cwd, agentDir, home } = setup(t);
  const poison = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  for (const dir of [path.join(home, '.pi/agent'), agentDir, path.join(cwd, '.pi')]) {
    poison(path.join(dir, 'settings.json'), '{"images":{"blockImages":true}}');
    poison(path.join(dir, 'extensions/x.ts'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(root, 'loaded'))}, 'poison'); export default () => {};`);
    poison(path.join(dir, 'SYSTEM.md'), 'poison-system');
    poison(path.join(dir, 'skills/poison/SKILL.md'), '---\nname: poison\ndescription: poison skill\n---\n');
  }
  poison(path.join(home, '.agents/skills/poison/SKILL.md'), '---\nname: poison\ndescription: poison home\n---\n');
  poison(path.join(cwd, 'AGENTS.md'), 'poison-project');
  fs.writeFileSync(path.join(cwd, 'pixel.png'), Buffer.from(png, 'base64'));
  const snapshot = () => fs.readdirSync(home, { recursive: true }).sort();
  const before = snapshot();
  await promisify(execFile)(process.execPath, [fixture('isolation'), cwd, agentDir], {
    env: { ...process.env, HOME: home, USERPROFILE: home }, windowsHide: true, timeout: 60000,
  });
  assert.deepEqual(snapshot(), before);
  assert.equal(fs.existsSync(path.join(root, 'loaded')), false);
  assert.ok(fs.readdirSync(path.join(agentDir, 'sessions'), { recursive: true }).some((p) => p.endsWith('.jsonl')));
});

test('指定 skill、默认系统提示、思考档位和图片一起传给模型', async (t) => {
  const { root, turn } = setup(t);
  const dir = path.join(root, 'agenda-skill');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: agenda-skill\ndescription: Describe the notebook\n---\nbody');
  const file = path.join(root, 'pixel.png');
  fs.writeFileSync(file, Buffer.from(png, 'base64'));
  let request;
  const r = await turn([(ctx, opts) => { request = { ctx, opts }; return reply('done'); }], {
    skills: [dir], system: 'agenda-system-marker', effort: 'high', images: [{ path: file, name: 'pixel.png', type: 'image/png' }],
  });
  const system = JSON.stringify(request.ctx.messages.filter((m) => m.role === 'system'));
  for (const s of ['agenda-skill', 'Describe the notebook', 'agenda-system-marker', 'read']) assert.ok(system.includes(s), s);
  const user = request.ctx.messages.findLast((m) => m.role === 'user');
  assert.ok(user.content.some((b) => b.type === 'image' && b.data && b.mimeType === 'image/png'), JSON.stringify(user));
  assert.equal(request.opts.reasoning, 'high');
  assert.equal(r.model, 'm1');
});

test('MCP 工具的暴露、执行和逐条审批', async (t) => {
  const { turn, root } = setup(t);
  const log = path.join(root, 'calls.jsonl');
  const tool = 'mcp__mock__echo';
  const mcp = { mock: { command: process.execPath, args: [fixture('mcp-server'), log], cwd: root } };
  for (const access of ['full', 'read', 'edit', 'run']) {
    let actual, declared;
    const asked = [];
    const args = { text: access };
    await turn([(ctx) => {
      declared = ctx.messages.filter((m) => m.role === 'system').flatMap((m) => m.toolsAdded || []).map((v) => v.name);
      return call(tool, args);
    }, (ctx) => { actual = results(ctx).at(-1); return reply('done'); }], {
      mcp, access, onApproval: (req) => { asked.push(req); return { allow: true }; },
    });
    const allowed = access === 'full' || access === 'run';
    assert.equal(declared.includes(tool), allowed, JSON.stringify({ access, declared, actual }));
    assert.ok(!declared.includes('tool_search') && !declared.includes('codemode'));
    assert.equal(!!actual.isError, !allowed);
    if (allowed) assert.match(contents(actual), new RegExp('echo: ' + access));
    assert.deepEqual(asked, access === 'run' ? [{ command: tool + ' ' + JSON.stringify(args) }] : []);
  }
  const long = { text: 'x'.repeat(250) };
  let denied;
  await turn([call(tool, long), (ctx) => { denied = results(ctx).at(-1); return reply('done'); }], {
    access: 'run', mcp, onApproval: ({ command }) => {
      assert.equal(command.length, 200);
      assert.ok(command.startsWith(tool + ' {"text":"'));
      return { allow: false, note: '稍后调用' };
    },
  });
  assert.ok(denied.isError);
  assert.match(contents(denied), /稍后调用/);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map((s) => JSON.parse(s).text), ['full', 'run']);
});

test('只累计本轮用量，续聊带上旧消息，未知会话可回退', async (t) => {
  const { turn, agentDir } = setup(t);
  const first = await turn([call('ls', {}), reply('first answer')], { prompt: 'first question' });
  const second = await turn([(ctx) => {
    assert.match(JSON.stringify(ctx.messages), /first question/);
    assert.match(JSON.stringify(ctx.messages), /first answer/);
    return reply('second answer');
  }], { sessionId: first.sessionId, prompt: 'second question' });
  assert.ok(first.sessionId);
  assert.equal(first.sessionId, second.sessionId);
  const sessions = path.join(agentDir, 'sessions');
  const file = fs.readdirSync(sessions, { recursive: true }).find((p) => p.endsWith('.jsonl'));
  const usage = fs.readFileSync(path.join(sessions, file), 'utf8').trim().split('\n').map((s) => JSON.parse(s).message)
    .filter((m) => m?.role === 'assistant').map((m) => m.usage);
  assert.equal(usage.length, 3);
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    assert.equal(first.usage[field], usage[0][field] + usage[1][field]);
    assert.equal(second.usage[field], usage[2][field]);
  }
  assert.equal(first.usage.contextUsed, usage[1].totalTokens);
  assert.equal(second.usage.contextUsed, usage[2].totalTokens);
  assert.equal(first.usage.contextWindow, undefined);
  assert.equal(usageFrom([]), undefined);
  await assert.rejects(turn([], { sessionId: 'missing' }), { resumeFailed: true });
});

test('看图被拒只重试一次，鉴权失败保留接口名', async (t) => {
  const { root, turn, faux } = setup(t);
  const file = path.join(root, 'pixel.png');
  fs.writeFileSync(file, Buffer.from(png, 'base64'));
  let retries = 0;
  const opts = { images: [{ path: file, type: 'image/png' }], onNoImages: () => retries++, conn: { name: '模拟接口' } };
  const failure = (errorMessage) => reply([], { stopReason: 'error', errorMessage });
  await turn([failure('400 unsupported image'), (ctx) => {
    const users = ctx.messages.filter((m) => m.role === 'user');
    assert.equal(users.length, 1);
    assert.doesNotMatch(JSON.stringify(users), /image\/png/);
    return reply('text only');
  }], opts);
  assert.equal(retries, 1);
  await assert.rejects(turn([failure('401 invalid API key')], opts), /模拟接口.*401/);
  assert.equal(retries, 1);
  assert.equal(faux.state.callCount, 3);
  await assert.rejects(turn([reply([])]), /Pi 没有返回内容/);
});

test('看图在工具执行后失败，保留工具结果继续', async (t) => {
  const { root, turn } = setup(t);
  const file = path.join(root, 'pixel.png');
  fs.writeFileSync(file, Buffer.from(png, 'base64'));
  let warned = 0;
  await turn([
    call('ls', {}),
    reply([], { stopReason: 'error', errorMessage: '400 unsupported image' }),
    (ctx) => {
      assert.doesNotMatch(JSON.stringify(ctx.messages), /image\/png/);
      assert.equal(results(ctx).length, 1);
      assert.equal(ctx.messages.at(-1).role, 'toolResult');
      return reply('done');
    },
  ], { images: [{ path: file, type: 'image/png' }], onNoImages: () => warned++ });
  assert.equal(warned, 1);
});

test('等待审批时中止，命令不会执行', { timeout: 30000 }, async (t) => {
  const { cwd, turn } = setup(t);
  const controller = new AbortController();
  const r = turn([call(findShell().tool, { command: 'echo x > stopped.txt' })], {
    access: 'run', signal: controller.signal, onApproval: () => {
      setImmediate(() => controller.abort());
      return new Promise(() => {});
    },
  });
  await assert.rejects(r, { aborted: true });
  assert.equal(fs.existsSync(path.join(cwd, 'stopped.txt')), false);
  await assert.rejects(turn([], { signal: controller.signal }), { aborted: true });
});

test('流式输出期间中止', async (t) => {
  const { turn } = setup(t);
  const controller = new AbortController();
  let streamed = false;
  await assert.rejects(turn([reply('hello '.repeat(80))], {
    signal: controller.signal, onDelta: () => { streamed = true; controller.abort(); },
  }), { aborted: true });
  assert.ok(streamed);
});

test('任务副本可读取空间记忆库，写入、编辑以及跨界联接被拒绝', async (t) => {
  const { root, turn } = setup(t);
  const memory = path.join(root, 'memory');
  fs.mkdirSync(memory);
  const file = path.join(memory, 'memory.md');
  fs.writeFileSync(file, 'original');
  fs.symlinkSync(root, path.join(memory, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  let actual;
  await turn([call('read', { path: file }), call('ls', { path: memory }),
    call('write', { path: file, content: 'modified' }),
    call('edit', { path: file, edits: [{ oldText: 'original', newText: 'modified' }] }),
    call('ls', { path: path.join(memory, 'link') }),
    (ctx) => { actual = results(ctx); return reply('done'); }], { access: 'edit', readOnlyDirs: [memory] });
  assert.deepEqual(actual.map((r) => !!r.isError), [false, false, true, true, true]);
  assert.match(contents(actual[0]), /original/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
});

test('工作区内的只读目录经另一条目录联接访问仍然只读', async (t) => {
  const { cwd, turn } = setup(t);
  const memory = path.join(cwd, 'memory');
  fs.mkdirSync(memory);
  fs.symlinkSync(memory, path.join(cwd, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  let actual;
  await turn([call('write', { path: 'alias/messages/new.md', content: 'unexpected' }),
    (ctx) => { actual = results(ctx); return reply('done'); }], { access: 'edit', readOnlyDirs: [memory] });
  assert.ok(actual[0].isError);
  assert.equal(fs.existsSync(path.join(memory, 'messages/new.md')), false);
});
