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
  const reloaded = createSettings(path.join(root, 'data', 'settings.json'), { pathKeys: CLI_ENGINE_IDS });
  assert.equal(reloaded.publicView().providers[0].claudeCode, true);
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
