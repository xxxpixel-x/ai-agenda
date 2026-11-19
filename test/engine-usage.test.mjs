import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { tempDir } from './helpers.mjs';
import { createSettings } from '../src/settings.mjs';
import { createRegistry } from '../src/engines/index.mjs';
import { setFetch } from '../src/engines/http.mjs';
import { runAgentTurn } from '../src/turn-runner.mjs';
import * as claudeCode from '../src/engines/claude-code.mjs';
import * as codex from '../src/engines/codex.mjs';
import * as dsh from '../src/engines/dsh.mjs';
import * as geminiCli from '../src/engines/gemini-cli.mjs';
import * as gemini from '../src/engines/gemini.mjs';
import * as openai from '../src/engines/openai-compat.mjs';

// 样本按 Claude Code 2.1.325、Codex 0.169 实测输出的字段写（数字是一次「回复 ok」的结果）

test('claude code usage sums the turn, takes context from the last request and the tightest quota window', () => {
  const result = {
    usage: {
      input_tokens: 17, cache_creation_input_tokens: 2217, cache_read_input_tokens: 10660, output_tokens: 289,
      iterations: [{ input_tokens: 8, output_tokens: 45, cache_read_input_tokens: 6290, cache_creation_input_tokens: 297 }],
    },
    modelUsage: {
      'claude-haiku-4-5': { inputTokens: 17, cacheReadInputTokens: 10660, cacheCreationInputTokens: 2217, contextWindow: 200000 },
      'claude-sub': { inputTokens: 3, contextWindow: 1 },
    },
  };
  const rateLimit = {
    utilization: 0.94, resetsAt: 1795087200,
    unifiedWindows: { five_hour: { utilization: 0.94, resetsAt: 1795087200 }, seven_day: { utilization: 0.72, resetsAt: 1795435200 } },
  };
  assert.deepEqual(claudeCode.usageFrom(result, rateLimit), {
    input: 17, output: 289, cacheRead: 10660, cacheWrite: 2217,
    contextUsed: 8 + 6290 + 297 + 45, contextWindow: 200000,
    quota: { usedPct: 94, resetsAt: 1795087200000 },
  });
  const plain = claudeCode.usageFrom({ usage: { input_tokens: 5, output_tokens: 1 } }, null);
  assert.deepEqual(plain, { input: 5, output: 1 });
  assert.equal(claudeCode.usageFrom(null, null), undefined);
});

test('codex usage subtracts cached input, and app-server adds context window and rate limits', () => {
  assert.deepEqual(codex.execUsage({ input_tokens: 15096, cached_input_tokens: 9600, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 }), {
    input: 5496, output: 5, cacheRead: 9600, cacheWrite: 0,
  });
  assert.equal(codex.execUsage(undefined), undefined);
  const tokens = {
    total: { totalTokens: 16513, inputTokens: 16508, cachedInputTokens: 11136, cacheWriteInputTokens: 0, outputTokens: 5 },
    last: { totalTokens: 16513, inputTokens: 16508, cachedInputTokens: 11136, cacheWriteInputTokens: 0, outputTokens: 5 },
    modelContextWindow: 475000,
  };
  const limits = { primary: { usedPercent: 32, windowDurationMins: 10080, resetsAt: 1795448194 }, secondary: null };
  assert.deepEqual(codex.appServerUsage(tokens, limits), {
    input: 5372, output: 5, cacheRead: 11136, cacheWrite: 0, contextUsed: 16513, contextWindow: 475000,
    quota: { usedPct: 32, resetsAt: 1795448194000 },
  });
  assert.deepEqual(codex.appServerUsage(null, limits), { quota: { usedPct: 32, resetsAt: 1795448194000 } });
  assert.equal(codex.appServerUsage(null, null), undefined);
});

test('deepseek harness, gemini and openai-compatible usage map to the shared shape', () => {
  assert.deepEqual(dsh.usageFrom([
    { inputTokens: 100, outputTokens: 20, cacheReadTokens: 1000 },
    { inputTokens: 50, outputTokens: 10, cacheReadTokens: 1100, cacheWriteTokens: 5 },
  ]), { input: 150, output: 30, cacheRead: 2100, cacheWrite: 5, contextUsed: 50 + 1100 + 5 + 10 });
  assert.deepEqual(dsh.usageFrom([{ inputTokens: 7, outputTokens: 3 }]), { input: 7, output: 3, contextUsed: 10 });
  assert.equal(dsh.usageFrom([]), undefined);

  assert.deepEqual(geminiCli.usageFrom({ total_tokens: 250, input_tokens: 50, output_tokens: 200, cached: 10, input: 40 }), { input: 40, output: 200, cacheRead: 10 });
  assert.deepEqual(geminiCli.usageFrom({ input_tokens: 50, output_tokens: 2, cached: 30 }), { input: 20, output: 2, cacheRead: 30 });
  assert.equal(geminiCli.usageFrom(undefined), undefined);

  assert.deepEqual(gemini.usageFrom({ promptTokenCount: 120, cachedContentTokenCount: 100, candidatesTokenCount: 30, thoughtsTokenCount: 10 }, 1048576), {
    input: 20, output: 40, cacheRead: 100, contextUsed: 160, contextWindow: 1048576,
  });
  assert.equal(gemini.usageFrom(null), undefined);

  assert.deepEqual(openai.usageFrom({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64 } }), { input: 36, output: 20, cacheRead: 64, contextUsed: 120 });
  assert.deepEqual(openai.usageFrom({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80 }), { input: 20, output: 5, cacheRead: 80, contextUsed: 105 });
  assert.equal(openai.usageFrom({}), undefined);
});

test('openai-compatible asks for usage, records it, and drops the option for endpoints that reject it', async (t) => {
  const root = tempDir(t);
  const settings = createSettings(path.join(root, 'fixture.json'));
  const providers = settings.update({ providers: [
    { name: 'Accepts', baseUrl: 'https://accepts.invalid', model: 'test' },
    { name: 'Rejects', baseUrl: 'https://rejects.invalid', model: 'test' },
  ] }).providers;
  const registry = createRegistry(settings);
  const sent = [];
  setFetch(async (url, req) => {
    const body = JSON.parse(req.body);
    sent.push({ url, usage: !!body.stream_options?.include_usage });
    if (url.startsWith('https://rejects.invalid') && body.stream_options) {
      return new Response('{"error":{"message":"Unrecognized request argument supplied: stream_options"}}', { status: 400 });
    }
    return new Response([
      'data: {"choices":[{"delta":{"content":"fixture reply"}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":30}}}',
      'data: [DONE]',
      '',
    ].join('\n'));
  });
  t.after(() => setFetch((...args) => globalThis.fetch(...args)));

  const sink = { text: '', activities: [] };
  await runAgentTurn(registry, { id: 'm1', engine: `openai:${providers[0].id}`, name: 'Fixture' }, { system: 's', prompt: 'p', sink });
  assert.deepEqual(sink.usage, { input: 10, output: 4, cacheRead: 30, contextUsed: 44 });

  const other = { text: '', activities: [] };
  await runAgentTurn(registry, { id: 'm2', engine: `openai:${providers[1].id}`, name: 'Fixture' }, { system: 's', prompt: 'p', sink: other });
  await runAgentTurn(registry, { id: 'm2', engine: `openai:${providers[1].id}`, name: 'Fixture' }, { system: 's', prompt: 'p', sink: { text: '', activities: [] } });
  assert.equal(other.text, 'fixture reply');
  assert.deepEqual(sent.map((s) => [new URL(s.url).host, s.usage]), [
    ['accepts.invalid', true],
    ['rejects.invalid', true],
    ['rejects.invalid', false],
    ['rejects.invalid', false], // 记住了，不再带
  ]);
});
