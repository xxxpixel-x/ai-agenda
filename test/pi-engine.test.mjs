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
import { createRegistry } from '../src/engines/index.mjs';
import { createSettings } from '../src/settings.mjs';
import { createExtensionsManager } from '../src/extensions.mjs';
import { isMemoryCall, libraryFixture, MEMORY_IDLE, settleSpace, tempDir, testInChinese as test, until } from './helpers.mjs';

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
  assert.deepEqual(toolsFor('run', 'powershell'), edit);
  assert.deepEqual(toolsFor('run', 'powershell', { onApproval() {} }), [...edit, 'powershell']);
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
  const { AgentSession, ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  let runtime, selected, blockImages;
  const prompt = AgentSession.prototype.prompt;
  t.mock.method(AgentSession.prototype, 'prompt', function (...args) {
    blockImages = this.settingsManager.getBlockImages();
    return prompt.apply(this, args);
  });
  const stream = ModelRuntime.prototype.streamSimple;
  // 保留真实的模型注册和鉴权，只把最终的流式请求交给 faux。
  t.mock.method(ModelRuntime.prototype, 'streamSimple', function (model, ctx, opts) {
    runtime = this;
    selected = model;
    this.registerNativeProvider(faux.provider);
    return stream.call(this, faux.getModel(), ctx, opts);
  });
  for (const [apiKey, override, vision, flags] of [
    ['$AGENDA_FAKE_KEY', false, true, { disabledImages: ['member-model'] }],
    ['!fake-key', true, false, { disabledImages: ['member-model'] }],
    ['legacy-key', false, false, { images: false }],
  ]) {
    const conn = { id: 'sample', name: '模拟', model: 'default-model', baseUrl: 'https://example.invalid/v1', apiKey, ...flags };
    faux.setResponses([reply('ok')]);
    const r = await runTurn({ cwd, agentDir, conn, model: override ? 'member-model' : '', effort: override ? 'high' : 'off', prompt: 'hello' });
    assert.equal(r.text, 'ok');
    assert.equal(selected.provider, 'agenda-sample');
    assert.equal(selected.api, 'openai-completions');
    assert.equal(selected.baseUrl, conn.baseUrl);
    assert.equal(selected.id, override ? 'member-model' : 'default-model');
    assert.deepEqual(selected.input, vision ? ['text', 'image'] : ['text']);
    assert.equal(blockImages, !vision);
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
    assert.deepEqual(actual.map((r) => !!r.isError), [false, !full, !full, !full, !full, !full, access === 'read', !full]);
    assert.match(contents(actual[0]), /inside-data/);
    for (const r of actual.slice(1, 4)) assert.match(contents(r), full ? /outside-secret/ : /只能访问共享文件夹里的文件/);
    assert.equal(fs.readFileSync(file, 'utf8'), full ? 'changed' : 'outside-secret');
    assert.equal(fs.existsSync(path.join(root, 'outside-dir/new/deep.txt')), full);
    assert.equal(fs.existsSync(path.join(cwd, 'ok.txt')), access !== 'read');
    assert.equal(fs.existsSync(path.join(cwd, 'made.txt')), full);
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
  assert.deepEqual(requests, commands.map((command) => ({ command, canAlways: false })));
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
  const { turn, root, cwd, faux } = setup(t);
  const log = path.join(root, 'calls.jsonl');
  const command = { command: process.execPath, args: [fixture('mcp-server'), log] };
  const manager = createExtensionsManager(libraryFixture(t));
  manager.installMcp({ id: 'read-only', mode: 'readonly', ...command });
  manager.installMcp({ id: 'writer', mode: 'mutating', ...command });
  const registry = createRegistry(createSettings(path.join(root, 'settings.json')), { extensions: manager });
  const reader = 'mcp__read_only__echo', writer = 'mcp__writer__echo';
  const tool = 'mcp__mock__echo';
  const mcp = { mock: command };
  const executed = [];
  for (const access of ['full', 'read', 'edit', 'run']) {
    let actual, declared;
    const asked = [];
    const readArgs = { text: 'read-' + access }, writeArgs = { text: 'write-' + access };
    faux.setResponses([(ctx) => {
      declared = ctx.messages.filter((m) => m.role === 'system').flatMap((m) => m.toolsAdded || []).map((v) => v.name);
      return call(reader, readArgs);
    }, call(writer, writeArgs), (ctx) => { actual = results(ctx); return reply('done'); }]);
    await registry.runTurn('pi', {
      cwd, prompt: 'Hello', provider: faux.provider, mcp: ['read-only', 'writer'], access,
      onApproval: (req) => { asked.push(req); return { allow: true }; },
    });
    const canWrite = access === 'full' || access === 'run';
    assert.ok(declared.includes(reader));
    assert.equal(declared.includes(writer), canWrite);
    assert.ok(!declared.includes('tool_search') && !declared.includes('codemode'));
    assert.deepEqual(actual.map(r => !!r.isError), [false, !canWrite]);
    assert.match(contents(actual[0]), new RegExp('echo: ' + readArgs.text));
    executed.push(readArgs.text);
    if (canWrite) executed.push(writeArgs.text);
    assert.deepEqual(asked, access === 'run' ? [{ command: writer + ' ' + JSON.stringify(writeArgs), canAlways: false }] : []);
  }
  const long = { text: 'x'.repeat(250) };
  let denied;
  await turn([call(tool, long), (ctx) => { denied = results(ctx).at(-1); return reply('done'); }], {
    access: 'run', mcp, onApproval: ({ command }) => {
      assert.equal(command, tool + ' ' + JSON.stringify(long));
      return { allow: false, note: '稍后调用' };
    },
  });
  assert.ok(denied.isError);
  assert.match(contents(denied), /稍后调用/);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map((s) => JSON.parse(s).text), executed);
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

for (const imageFailure of [false, true]) {
  test('Pi 空闲超时保留 stalled 错误：' + (imageFailure ? '带图中止后不重试' : '中止后正常返回部分文字'), async t => {
    const { root, turn } = setup(t);
    const { AgentSession } = await import('@earendil-works/pi-coding-agent');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const started = Promise.withResolvers(), stopped = Promise.withResolvers();
    let emit;
    t.mock.method(AgentSession.prototype, 'subscribe', listener => { emit = listener; return () => {}; });
    const abort = t.mock.method(AgentSession.prototype, 'abort', async () => stopped.resolve());
    const prompt = t.mock.method(AgentSession.prototype, 'prompt', async (_prompt, { images }) => {
      assert.equal(images.length, Number(imageFailure));
      emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } });
      started.resolve();
      await stopped.promise;
      if (imageFailure) throw new Error('400 unsupported image');
      emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted' } });
    });
    const file = path.join(root, 'pixel.png');
    fs.writeFileSync(file, Buffer.from(png, 'base64'));
    const delta = t.mock.fn(), fallback = t.mock.fn();
    const running = turn([], {
      idleMs: 40, conn: { name: '测试接口' }, images: imageFailure ? [{ path: file, type: 'image/png' }] : [],
      onDelta: delta, onNoImages: fallback,
    });
    await started.promise;
    t.mock.timers.tick(39);
    emit({ type: 'tool_execution_update' }); // 没有文字的事件也重新计时
    t.mock.timers.tick(39);
    assert.equal(abort.mock.callCount(), 0);
    t.mock.timers.tick(1);
    await assert.rejects(running, { stalled: true, message: /测试接口.*1 分钟/ });
    assert.equal(delta.mock.calls[0].arguments[0], 'partial');
    assert.equal(abort.mock.callCount(), 1);
    assert.equal(fallback.mock.callCount(), 0);
    assert.equal(prompt.mock.callCount(), 1);
  });
}

test('Pi 创建会话尚未完成也会空闲超时', async t => {
  const { turn } = setup(t);
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = Promise.withResolvers();
  t.mock.method(ModelRuntime, 'create', ({ signal }) => { started.resolve(signal); return new Promise(() => {}); });
  const running = turn([], { idleMs: 40 });
  const signal = await started.promise;
  t.mock.timers.tick(40);
  await assert.rejects(running, { stalled: true });
  assert.ok(signal.aborted);
});

test('Pi 绑定和关闭扩展都卡住时仍然释放会话', async t => {
  const { turn } = setup(t);
  const { AgentSession } = await import('@earendil-works/pi-coding-agent');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const binding = Promise.withResolvers(), shuttingDown = Promise.withResolvers();
  const dispose = t.mock.method(AgentSession.prototype, 'dispose');
  t.mock.method(AgentSession.prototype, 'bindExtensions', function () {
    t.mock.method(this.extensionRunner, 'emit', event => {
      assert.equal(event.type, 'session_shutdown');
      shuttingDown.resolve();
      return new Promise(() => {});
    });
    binding.resolve();
    return new Promise(() => {});
  });
  const running = turn([], { idleMs: 40 });
  await binding.promise;
  t.mock.timers.tick(40);
  await shuttingDown.promise;
  t.mock.timers.tick(3000);
  await assert.rejects(running, { stalled: true });
  assert.equal(dispose.mock.callCount(), 1);
});

test('Pi 审批等待暂停计时，决定后恢复计时', async t => {
  const { turn } = setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const asked = Promise.withResolvers(), answer = Promise.withResolvers(), resumed = Promise.withResolvers();
  const running = turn([call(findShell().tool, { command: 'echo approved' }), (_ctx, opts) => {
    resumed.resolve(opts.signal);
    return new Promise(resolve => opts.signal.addEventListener('abort', () => resolve(reply('stopped')), { once: true }));
  }], {
    idleMs: 40, access: 'run', onApproval: () => { asked.resolve(); return answer.promise; },
  });
  await asked.promise;
  t.mock.timers.tick(4000);
  answer.resolve({ allow: false });
  const signal = await resumed.promise;
  t.mock.timers.tick(39);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(running, { stalled: true });
  assert.ok(signal.aborted);
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

test('带只读记忆目录时，run 有审批可逐条放行、无审批禁用，full 放行且仍拦截文件工具写入只读目录', async t => {
  const { root, cwd, turn } = setup(t);
  const memory = path.join(root, 'memory');
  fs.mkdirSync(memory);
  const memFile = path.join(memory, 'memory.md');
  fs.writeFileSync(memFile, 'original');
  const log = path.join(root, 'calls.jsonl');
  const mcp = { writer: { command: process.execPath, args: [fixture('mcp-server'), log] } };
  const shell = findShell().tool;

  // run 无审批通道（如无人值守任务子任务）：禁用 shell 和可写 MCP
  let unattended;
  await turn([call(shell, { command: 'echo x > unattended.txt' }), call('mcp__writer__echo', { text: 'unattended' }),
    (ctx) => { unattended = results(ctx); return reply('done'); }], { access: 'run', mcp, readOnlyDirs: [memory] });
  assert.deepEqual(unattended.map(r => !!r.isError), [true, true]);
  assert.equal(fs.existsSync(path.join(cwd, 'unattended.txt')), false);
  assert.equal(fs.existsSync(log), false);

  // run 有审批通道（真实聊天空间，含 readOnlyDirs）：可逐次批准命令和可写 MCP，且禁用“总是允许”
  const asked = [];
  let chatRun;
  await turn([
    call('write', { path: memFile, content: 'hacked' }),
    call(shell, { command: 'echo x > chat-run.txt' }),
    call('mcp__writer__echo', { text: 'chat-run' }),
    (ctx) => { chatRun = results(ctx); return reply('done'); },
  ], {
    access: 'run', mcp, readOnlyDirs: [memory],
    onApproval: (req) => { asked.push(req); return { allow: true }; },
  });
  assert.deepEqual(chatRun.map(r => !!r.isError), [true, false, false]);
  assert.equal(asked.length, 2);
  assert.ok(asked.every(req => req.canAlways === false));
  assert.equal(fs.existsSync(path.join(cwd, 'chat-run.txt')), true);
  assert.equal(fs.readFileSync(memFile, 'utf8'), 'original');

  // full 带只读目录：放行命令、可写 MCP 和工作区外读写，但文件工具仍不能直接写只读目录
  const outside = path.join(root, 'outside.txt');
  let fullRun;
  await turn([
    call('write', { path: memFile, content: 'hacked' }),
    call('write', { path: outside, content: 'ok' }),
    call(shell, { command: 'echo x > full-run.txt' }),
    call('mcp__writer__echo', { text: 'full-run' }),
    (ctx) => { fullRun = results(ctx); return reply('done'); },
  ], { access: 'full', mcp, readOnlyDirs: [memory] });
  assert.deepEqual(fullRun.map(r => !!r.isError), [true, false, false, false]);
  assert.equal(fs.readFileSync(memFile, 'utf8'), 'original');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'ok');
  assert.equal(fs.existsSync(path.join(cwd, 'full-run.txt')), true);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map((s) => JSON.parse(s).text), ['chat-run', 'full-run']);
});
