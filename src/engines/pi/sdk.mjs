import path from 'node:path';
import * as pi from '@earendil-works/pi-coding-agent';
import { t as tr } from '../../i18n.mjs';
import { permissionExtension } from './tools.mjs';
import { supportsModelImages } from '../image-error.mjs';

// 1.5.2 的公开入口没有导出工具的路径解析、会话目录和 MCP 凭据存储。
// 沿用 SDK 自己的实现，保证权限检查与实际执行解析到同一文件。
const sdkFile = (file) => new URL(file, import.meta.resolve('@earendil-works/pi-coding-agent')).href;
const paths = await import(sdkFile('./core/tools/path-utils.js'));
const { getDefaultSessionDir } = await import(sdkFile('./core/session-manager.js'));

async function turnModel(runtime, { provider, conn, model, effort }) {
  if (provider) {
    const native = provider.provider || provider;
    runtime.registerNativeProvider(native);
    return model ? runtime.getModel(native.id, model) : runtime.getModels(native.id)[0];
  }
  const id = model || conn.model;
  const source = `agenda-${conn.id}`;
  runtime.registerProvider(source, {
    baseUrl: conn.baseUrl.trim(), api: 'openai-completions',
    models: [{
      id, name: id, input: supportsModelImages(conn, id) ? ['text', 'image'] : ['text'], reasoning: !!effort && effort !== 'off',
      // registerProvider 要求完整的模型描述，沿用 pi 自定义接口的默认值。
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: conn.contextWindow || 128000, maxTokens: Math.min(16384, Math.floor((conn.contextWindow || 128000) / 2)),
    }],
  });
  // 本地免鉴权接口也需要一个非空占位符才能经过 pi 的鉴权预检。
  await runtime.setRuntimeApiKey(source, conn.apiKey || 'no-key');
  return runtime.getModel(source, id);
}

function sessionsFor(cwd, agentDir, sessionId) {
  const dir = getDefaultSessionDir(cwd, agentDir);
  if (!sessionId) return pi.SessionManager.create(cwd, dir);
  const file = pi.SessionManager.findById(cwd, sessionId, dir);
  if (!file) throw Object.assign(new Error(tr('找不到 Pi 会话 {0}', [sessionId])), { resumeFailed: true });
  return pi.SessionManager.open(file, dir, cwd);
}

async function mcpExtension(mcp, agentDir) {
  const { McpOAuthCredentialStore } = await import(sdkFile('./extensions/mcp/oauth.js'));
  const { FileAuthStorageBackend } = await import(sdkFile('./core/auth-storage.js'));
  const backend = new FileAuthStorageBackend(path.join(agentDir, 'mcp-auth.json'));
  const servers = Object.entries(mcp).map(([name, config]) => ({
    name, config: { ...config, exposure: 'direct' }, scope: 'extension', source: 'Agenda',
  }));
  return pi.createMcpExtension({
    loadConfig: () => ({ servers, errors: [], autoEnableCodemode: false }),
    logPath: path.join(agentDir, 'mcp.log'), credentials: new McpOAuthCredentialStore(backend, agentDir),
  });
}

export async function createSession(options) {
  const { cwd, agentDir, sessionId, system, shell, skills, tools, mcp, signal } = options;
  const sessionManager = sessionsFor(cwd, agentDir, sessionId);
  const modelRuntime = await pi.ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false, signal,
  });
  const model = await turnModel(modelRuntime, options);
  if (!model) throw new Error(tr('找不到模型 {0}', [options.model || '']));
  const settingsManager = pi.SettingsManager.inMemory({
    shellPath: shell.shellPath, cacheWarming: 'off', enableInstallTelemetry: false,
    retry: { enabled: true, maxRetries: 2 }, // pi 只重试限流、5xx、网络这类可以重试的错误
    images: { blockImages: !options.provider && !model.input.includes('image') },
  });
  const extensionFactories = [permissionExtension({ ...options, paths })];
  const useMcp = Object.keys(mcp || {}).length > 0;
  if (useMcp) extensionFactories.push(await mcpExtension(mcp, agentDir));
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd, agentDir, settingsManager, extensionFactories, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalSkillPaths: skills.map((dir) => path.join(dir, 'SKILL.md')),
    systemPrompt: '', appendSystemPrompt: [], appendSystemPromptOverride: () => system ? [system] : [],
  });
  // 1.5.2 的 no* 选项只过滤扫描结果；在此实例上跳过扫描，以免遍历个人的 ~/.agents。
  resourceLoader.packageManager.addAutoDiscoveredResources = () => {};
  await resourceLoader.reload();
  if (resourceLoader.getExtensions().errors.length) throw new Error(resourceLoader.getExtensions().errors[0].error);
  return pi.createAgentSession({
    cwd, agentDir, model, modelRuntime, resourceLoader, settingsManager, sessionManager,
    thinkingLevel: options.effort || 'off', tools: useMcp ? [...tools, 'mcp__*'] : tools,
  });
}
