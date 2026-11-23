// 模型来源：接口的「也给 Claude Code 用」、成员的 source 校验、Claude Code 的独立配置目录和环境变量。
// 用一个假的 claude 程序记下它收到的参数和环境变量，不联网、不碰你本机的 Claude Code。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testInChinese as test, tempDir } from './helpers.mjs';
import { createSettings } from '../src/settings.mjs';
import { createRegistry, CLI_ENGINE_IDS } from '../src/engines/index.mjs';
import { normalizeMembers } from '../src/members.mjs';
import { runAgentTurn } from '../src/turn-runner.mjs';
import { supportsPrivateSessions } from '../src/engines/index.mjs';
import { sourceEnv, meta as claudeMeta } from '../src/engines/claude-code.mjs';
import { setFetch } from '../src/engines/http.mjs';
import { GEMINI_BASE_URL } from '../public/js/settings/connection-origin.js';

const KIMI = { name: 'Kimi', baseUrl: 'https://api.example.test/v1', model: 'kimi-fake', anthropicUrl: 'https://api.example.test/anthropic', claudeCode: true, apiKey: 'sk-fake-123' };
const LOCAL = { name: '本地', baseUrl: 'http://127.0.0.1:9/v1', model: 'local-fake' };

function setup(t) {
  const root = tempDir(t);
  const settings = createSettings(path.join(root, 'data', 'settings.json'), { pathKeys: CLI_ENGINE_IDS });
  return { root, settings };
}

// 假的 claude：把参数和相关环境变量写进 FAKE_CLAUDE_OUT，再输出一条 stream-json 的结果
function fakeClaude(root) {
  const script = path.join(root, 'fake-claude.mjs');
  fs.writeFileSync(script, `#!/usr/bin/env node
import fs from 'node:fs';
const pick = (re) => Object.fromEntries(Object.entries(process.env).filter(([k]) => re.test(k)));
fs.writeFileSync(process.env.FAKE_CLAUDE_OUT, JSON.stringify({ args: process.argv.slice(2), env: pick(/^(ANTHROPIC_|CLAUDE_|API_TIMEOUT_MS$)/i) }));
const usage = { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, iterations: [{ input_tokens: 3, output_tokens: 2 }] };
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'fake-session', result: '收到', usage, modelUsage: { m: { inputTokens: 3, contextWindow: 200000 } } }));
`);
  if (process.platform === 'win32') {
    const cmd = path.join(root, 'fake-claude.cmd');
    fs.writeFileSync(cmd, `@node "%~dp0fake-claude.mjs" %*\r\n`);
    return cmd;
  }
  fs.chmodSync(script, 0o755);
  return script;
}

function withEnv(t, vars) {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  t.after(() => {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

test('接口的「也给 Claude Code 用」必须有 Anthropic 兼容地址，没传时保留原值', (t) => {
  const { root, settings } = setup(t);
  assert.equal(settings.dir, path.join(root, 'data'));
  assert.throws(() => settings.update({ providers: [{ ...KIMI, anthropicUrl: '' }] }), /Anthropic 兼容地址/);
  const view = settings.update({ providers: [KIMI, LOCAL] });
  assert.deepEqual(view.providers.map((p) => [p.name, p.claudeCode, p.anthropicUrl]), [['Kimi', true, KIMI.anthropicUrl], ['本地', false, '']]);
  assert.equal(JSON.stringify(view).includes('sk-fake-123'), false);
  // 界面整表替换时只带了 id / name / model / baseUrl：不能把别的接口的这两项冲掉
  const again = settings.update({ providers: view.providers.map(({ id, name, model, baseUrl }) => ({ id, name, model, baseUrl })) });
  assert.equal(again.providers[0].claudeCode, true);
  assert.equal(again.providers[0].anthropicUrl, KIMI.anthropicUrl);
  assert.equal(settings.get().providers[0].apiKey, KIMI.apiKey);
  const reloaded = createSettings(path.join(root, 'data', 'settings.json'), { pathKeys: CLI_ENGINE_IDS });
  assert.equal(reloaded.publicView().providers[0].claudeCode, true);
});

test('接口密钥随两个地址的来源重置，路径修改和新填密钥正常保存', (t) => {
  const { settings, root } = setup(t);
  for (const field of ['baseUrl', 'anthropicUrl']) {
    for (const [url, keep] of [
      ['https://API.EXAMPLE.TEST:443/v1beta?q=1', true], ['http://api.example.test/v1', false],
      ['https://api.example.test:8443/v1', false], ['https://other.example.test/v1', false],
      ['api.example.test/v1', false], ['https://[', false],
    ]) {
      const [row] = settings.update({ providers: [KIMI] }).providers;
      const key = keep ? {} : { apiKey: '  ' };
      settings.update({ providers: [{ ...row, [field]: url, ...key }] });
      assert.equal(createSettings(path.join(root, 'data', 'settings.json')).get().providers[0].apiKey, keep ? KIMI.apiKey : '', url);
    }
    const [row] = settings.update({ providers: [KIMI] }).providers;
    settings.update({ providers: [{ ...row, [field]: 'https://new.example.test', apiKey: ' replacement ' }] });
    assert.equal(settings.get().providers[0].apiKey, 'replacement');
    settings.update({ providers: [{ ...row, [field]: 'https://different.example.test' }] });
    assert.equal(settings.get().providers[0].apiKey, '');
  }
});

test('Gemini 默认地址与官方地址同源，与代理互换时清空密钥', async t => {
  const { settings } = setup(t);
  const save = gemini => settings.update({ gemini }).gemini.hasKey;
  assert.ok(save({ apiKey: 'fixture' }));
  assert.ok(save({ baseUrl: GEMINI_BASE_URL + ':443/v1beta' }));
  assert.ok(save({ baseUrl: '' }));
  assert.equal(save({ baseUrl: 'https://proxy.example.test' }), false);
  const registry = createRegistry(settings);
  const probe = t.mock.fn(() => new Response('{}'));
  setFetch(probe);
  t.after(() => setFetch((...args) => globalThis.fetch(...args)));
  assert.equal((await registry.detect('gemini')).ready, false);
  assert.equal(probe.mock.callCount(), 0);
  assert.ok(save({ apiKey: 'proxy-key' }));
  assert.ok(save({ baseUrl: 'https://proxy.example.test/v1' }));
  assert.equal(save({ baseUrl: '', apiKey: '  ' }), false);
  assert.ok(save({ baseUrl: 'https://proxy.example.test', apiKey: 'new-key' }));
  assert.equal(settings.get().gemini.apiKey, 'new-key');
});

test('换地址后可探测免密本地模型，需要认证时明确提示', async t => {
  const { settings } = setup(t);
  const [row] = settings.update({ providers: [KIMI] }).providers;
  settings.update({ providers: [{ ...row, baseUrl: LOCAL.baseUrl }] });
  const registry = createRegistry(settings);
  const sent = [];
  let status = 200;
  setFetch((url, req) => {
    sent.push([url, new Headers(req.headers).get('Authorization')]);
    return Response.json({ data: [{ id: 'local-model' }] }, { status });
  });
  t.after(() => setFetch((...args) => globalThis.fetch(...args)));
  const detect = () => registry.detect('openai:' + row.id, { refresh: true });
  const available = await detect();
  assert.equal(available.ready, true);
  assert.deepEqual(available.models, ['local-model']);
  for (status of [401, 403]) {
    const info = await detect();
    assert.equal(info.ready, false);
    assert.match(info.note, /需要填写 API key/);
  }
  assert.deepEqual(sent, Array(3).fill([LOCAL.baseUrl + '/models', null]));
});

test('连接行随着输入和撤回地址修改切换密钥提示', async t => {
  const { settings } = setup(t);
  const view = settings.update({ gemini: { apiKey: 'fixture' }, providers: [KIMI] });
  t.mock.method(globalThis, 'fetch', async url => Response.json(url === '/api/app' ? { language: 'zh' } : view));
  const previous = globalThis.document;
  globalThis.document = { documentElement: {}, querySelectorAll: () => [] };
  t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; });
  await import('../public/js/settings/connections.js');
  const { list } = await import('../public/js/slots.js');
  const panel = { querySelectorAll: () => [] };
  await list('settings').find(s => s.id === 'connections').render(panel);
  for (const [id, saved] of [['gemini', view.gemini], ['openai:' + view.providers[0].id, view.providers[0]]]) {
    const key = { name: 'apiKey', value: '' };
    const urls = ['baseUrl', ...(id === 'gemini' ? [] : ['anthropicUrl'])].map(name =>
      ({ name, value: saved[name], defaultValue: saved[name] }));
    const row = { dataset: { conn: id }, querySelector: () => key, querySelectorAll: () => urls };
    key.closest = () => row;
    for (const url of urls) {
      url.closest = () => row;
      url.value = (url.defaultValue || GEMINI_BASE_URL) + '/v1beta';
      panel.oninput({ target: url });
      const original = key.placeholder;
      assert.match(original, /已保存/);
      url.value = 'https://changed.example.test';
      panel.oninput({ target: url });
      assert.equal(key.placeholder, '地址换了，请重新填写密钥');
      key.value = 'replacement';
      panel.oninput({ target: key });
      assert.equal(key.placeholder, original);
      key.value = '';
      panel.oninput({ target: key });
      assert.equal(key.placeholder, '地址换了，请重新填写密钥');
      url.value = url.defaultValue;
      panel.oninput({ target: url });
      assert.equal(key.placeholder, original);
    }
  }
});

test('注册表：Claude Code 只能选给它用的接口，pi 能选全部接口', (t) => {
  const { settings } = setup(t);
  settings.update({ providers: [KIMI, LOCAL] });
  const list = createRegistry(settings).list();
  const cc = list.find((e) => e.id === 'claude-code');
  const pi = list.find((e) => e.id === 'pi');
  assert.equal(cc.sources, true);
  assert.equal(!!cc.sourceRequired, false);
  assert.deepEqual(cc.sourceChoices.map((c) => c.name), ['Kimi']);
  assert.equal(pi.sources, true);
  assert.equal(pi.sourceRequired, true);
  assert.deepEqual(pi.sourceChoices.map((c) => c.name), ['Kimi', '本地']);
  assert.equal(JSON.stringify(list).includes('sk-fake-123'), false);
  // 演示模式也带上可选的模型来源（界面一样能选）
  const demo = createRegistry(settings, { mock: true }).list().find((e) => e.id === 'claude-code');
  assert.deepEqual(demo.sourceChoices.map((c) => c.name), ['Kimi']);
});

test('成员的 source：校验、默认、显示名', (t) => {
  const { settings } = setup(t);
  settings.update({ providers: [KIMI, LOCAL] });
  const engines = createRegistry(settings).list();
  const [kimiId, localId] = settings.get().providers.map((p) => p.id);
  const [cc, plain, pi, codex] = normalizeMembers([
    { engine: 'claude-code', name: 'A', source: kimiId },
    { engine: 'claude-code', name: 'B' },
    { engine: 'pi', name: 'C' },
    { engine: 'codex', name: 'D', source: kimiId },
  ], engines);
  assert.equal(cc.source, kimiId);
  assert.equal(cc.engineLabel, 'Claude Code · Kimi');
  assert.equal(plain.source, undefined);
  assert.equal(plain.engineLabel, 'Claude Code');
  assert.equal(pi.source, kimiId, 'pi 没选接口时用第一个');
  assert.equal(pi.engineLabel, 'Pi · Kimi');
  assert.equal(codex.source, undefined, '不能换模型来源的 AI 不留 source');
  assert.throws(() => normalizeMembers([{ engine: 'claude-code', name: 'A', source: localId }], engines), /模型来源已经不能用了/);
  assert.throws(() => normalizeMembers([{ engine: 'claude-code', name: 'A', source: 'nope' }], engines), /模型来源已经不能用了/);
  settings.update({ providers: [] });
  assert.throws(() => normalizeMembers([{ engine: 'pi', name: 'C' }], createRegistry(settings).list()), /先在「AI 连接」里添加 API 接口/);
});

test('配别家模型的环境变量：清掉你本机的 Claude 设置，各档型号都指向同一个', () => {
  const env = sourceEnv(KIMI, { configDir: 'X:/cfg', base: { ANTHROPIC_API_KEY: 'user', anthropic_base_url: 'user', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'user', PATH: 'p' } });
  assert.equal(env.ANTHROPIC_API_KEY, '');
  assert.equal(env.anthropic_base_url, '');
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, '');
  assert.equal(env.PATH, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, 'X:/cfg');
  assert.equal(env.ANTHROPIC_BASE_URL, KIMI.anthropicUrl);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-fake-123');
  for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) assert.equal(env[k], 'kimi-fake');
  assert.equal(sourceEnv(KIMI, { configDir: 'X', model: 'kimi-other', base: {} }).ANTHROPIC_MODEL, 'kimi-other');
});

test('Claude Code 成员用接口时走独立的配置目录，没选接口时照旧', async (t) => {
  const { root, settings } = setup(t);
  const out = path.join(root, 'fake-out.json');
  withEnv(t, { FAKE_CLAUDE_OUT: out, ANTHROPIC_API_KEY: 'user-own-key' });
  settings.update({ paths: { 'claude-code': fakeClaude(root) }, providers: [KIMI] });
  const registry = createRegistry(settings);
  const kimiId = settings.get().providers[0].id;
  const [withSource, own] = normalizeMembers([
    { engine: 'claude-code', name: 'A', source: kimiId },
    { engine: 'claude-code', name: 'B', model: 'claude-opus-5-5' },
  ], registry.list());
  const cwd = path.join(root, 'ws');
  fs.mkdirSync(cwd);
  const turn = (member) => runAgentTurn(registry, member, { system: '规则', prompt: '你好', cwd, access: 'edit', sink: {} });

  const r = await turn(withSource);
  assert.equal(r.text, '收到');
  assert.equal(r.usage.contextWindow, undefined, '别家型号的上下文窗口 Claude Code 只能猜，不显示');
  let seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  const configDir = path.join(root, 'data', 'claude-code', kimiId);
  assert.equal(seen.env.CLAUDE_CONFIG_DIR, configDir);
  assert.ok(fs.statSync(configDir).isDirectory());
  assert.equal(seen.env.ANTHROPIC_BASE_URL, KIMI.anthropicUrl);
  assert.equal(seen.env.ANTHROPIC_AUTH_TOKEN, 'sk-fake-123');
  assert.equal(seen.env.ANTHROPIC_MODEL, 'kimi-fake');
  assert.equal(seen.env.ANTHROPIC_API_KEY || '', '', '不带上你本机的 key');
  assert.equal(seen.args.includes('--model'), false);
  assert.ok(seen.args.includes('--safe-mode'));

  await turn(own);
  seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(seen.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
  assert.equal(seen.env.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_BASE_URL);
  assert.equal(seen.env.ANTHROPIC_API_KEY, 'user-own-key');
  assert.equal(seen.args[seen.args.indexOf('--model') + 1], 'claude-opus-5-5');

  // 接口不再给 Claude Code 用：报错，不悄悄换回自己的账号
  settings.update({ providers: [{ ...KIMI, id: kimiId, claudeCode: false }] });
  await assert.rejects(turn(withSource), /模型来源已经不能用了/);
});

test('Claude 的私有会话隔离配置，导入与一次性发言沿用原目录', async (t) => {
  const { root, settings } = setup(t);
  assert.equal(claudeMeta.privateSessions, true);
  for (const capability of [supportsPrivateSessions, createRegistry(settings).supportsPrivateSessions,
    createRegistry(settings, { mock: true }).supportsPrivateSessions]) {
    assert.equal(capability('claude-code'), true);
    assert.equal(capability('codex'), false);
  }
  assert.equal(createRegistry(settings, { mock: true }).list().find((m) => m.id === 'claude-code').privateSessions, true);
  const out = path.join(root, 'out.json');
  const original = path.join(root, 'claude');
  withEnv(t, { FAKE_CLAUDE_OUT: out, CLAUDE_CONFIG_DIR: original, CLAUDE_SECURESTORAGE_CONFIG_DIR: 'keychain' });
  settings.update({ paths: { 'claude-code': fakeClaude(root) } });
  const registry = createRegistry(settings), home = path.join(settings.dir, 'sessions', 'claude-code');
  for (const opts of [{ keepSession: true }, { sessionId: 'private' }, { sessionId: 'import', imported: true },
    { sessionId: 'forked', fork: true, resumeAt: 'leaf' }, {}]) {
    const result = await runAgentTurn(registry, { engine: 'claude-code' }, { ...opts, system: 's', prompt: 'p', cwd: root, sink: {} });
    const { args, env } = JSON.parse(fs.readFileSync(out, 'utf8'));
    const persist = !!(opts.keepSession || opts.sessionId);
    assert.equal(args.includes('--no-session-persistence'), !persist);
    assert.equal(env.CLAUDE_CONFIG_DIR, persist && !opts.imported && !opts.fork ? home : original);
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, 'keychain');
    assert.equal(result.sessionId, persist ? 'fake-session' : undefined);
    if (opts.sessionId) {
      assert.equal(args[args.indexOf('--resume') + 1], opts.sessionId);
      assert.equal(args[args.indexOf('--system-prompt-snapshot') + 1], 'off');
    }
    assert.equal(args.includes('--fork-session'), !!opts.fork);
    if (opts.resumeAt) assert.equal(args[args.indexOf('--resume-session-at') + 1], opts.resumeAt);
  }
  delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  await registry.runTurn('claude-code', { system: 's', prompt: 'p', cwd: root, keepSession: true });
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).env.CLAUDE_SECURESTORAGE_CONFIG_DIR, original);
  delete process.env.CLAUDE_CONFIG_DIR;
  await registry.runTurn('claude-code', { system: 's', prompt: 'p', cwd: root, keepSession: true });
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).env.CLAUDE_SECURESTORAGE_CONFIG_DIR, '');
  assert.ok(fs.statSync(home).isDirectory());
});
