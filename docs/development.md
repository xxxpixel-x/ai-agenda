# 开发说明

[返回项目首页](../README.md)

## 运行方式

项目使用 Electron 和原生 JavaScript，没有前端打包步骤。`npm ci` 按锁文件安装依赖，`npm start` 打开桌面窗口，`npm run mock` 使用模拟引擎和独立数据目录。

Node.js 最低版本为 22.12.0，与锁文件中的 `@electron/get`、`@electron-internal/extract-zip` 安装依赖要求一致。

Electron 主进程启动仅监听 `127.0.0.1` 的 HTTP 服务，并以随机端口打开本机界面。界面通过 JSON API 操作空间，通过 SSE 接收消息、文件与任务进度。API 请求通过 Electron `net.fetch` 使用系统代理。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `electron/main.cjs` | 桌面生命周期、本机服务、系统代理、系统加密 |
| `electron/preload.cjs` | 仅向界面暴露文件夹选择能力 |
| `src/app-server.mjs` | 静态资源、JSON API、SSE、Host 与跨站请求检查 |
| `src/space.mjs` | 成员配置、聊天队列、点名与停止规则、任务宿主接口 |
| `src/taskrun.mjs` | 规划、依赖调度、审查、退回、冲突处理、总结与合并 |
| `src/turn-runner.mjs` | 聊天与任务共用的单次引擎调用、流式输出、日志和文件块 |
| `src/prompts.mjs` / `src/task-prompts.mjs` | 聊天与任务的提示词、标记和计划解析 |
| `src/workspace.mjs` | 文件扫描、读写、改动记录、撤销冲突检测 |
| `src/git.mjs` | Git worktree、提交、对比与合并 |
| `src/store.mjs` / `src/settings.mjs` | 空间持久化、连接配置、密钥编码与界面脱敏 |
| `src/imports.mjs` | 导入方式、摘要、主题简报、补导和背景版本 |
| `src/importers/` | 只读解析外部工具的会话记录 |
| `src/engines/` | CLI / API 适配器与统一注册表 |
| `public/` | 界面与静态素材 |

`TaskRun` 通过 `Space.createRunHost()` 提供的接口访问空间，完成后发出 `done` 事件；空间负责把总结写入聊天。

## 引擎接口

接入新引擎时，在 `src/engines/` 添加模块，并在 `index.mjs` 的 `ENGINES` 中注册。

- `meta`：引擎标识、显示信息、默认模型 / 档位和能力；`kind` 区分 `cli` / `api`，`resume` 表示会话接续能力。
- `detect(opts)`：返回可用性、登录状态、说明，可附加动态模型、档位与默认模型。
- `runTurn(opts)`：返回 `{ text, sessionId? }`；通过 `onDelta`、`onActivity`、`onRaw` 报告流式文本、动作与原始事件，并响应 `AbortSignal`。
- API 引擎通过 `file-blocks.mjs` 约定的文件块修改共享文件，CLI 引擎在指定工作目录执行。

调用方通过注册表判断能力，避免在空间和任务调度中散落特定厂商判断。

## 自动检查

```sh
npm run check
npm test
# 或一次执行
npm run verify
```

检查脚本递归检查源码、界面、Electron、脚本和测试文件的 JavaScript 语法，并核对包元数据与锁文件。

测试使用 Node.js 内置的 `node:test`，无需第三方测试框架，覆盖设置持久化与密钥脱敏、文件历史与撤销、导入背景、任务计划、本机 HTTP 接口、模拟讨论以及 Git / 非 Git 任务协作。全部测试数据位于操作系统临时目录，测试后清理；Git 测试只操作自己创建的临时仓库。

GitHub Actions 在 Windows 和 Ubuntu、Node.js 22.12.0 和 24 上执行同样的检查。CI 设置 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，不下载桌面二进制、不启动窗口，不需要 AI 凭据。后端测试通过不等同于完整桌面兼容性验证。

涉及 UI 时用 `npm run mock` 检查相关流程。涉及真实引擎时，用对应账号验证登录、模型选择、一次发言、中止与权限，并在 PR 中记录验证范围。

## 数据布局

```text
data/                           正常模式（已忽略）
  settings.json                 本机连接设置
  spaces/
    <空间 ID>.json              成员、消息、任务与导入状态
    <空间 ID>/
      history.json              文件改动历史
      files/                    软件管理的共享文件夹
      runs/<任务 ID>/           临时 worktree 和任务文件
data-mock/                      演示模式（已忽略）
```

用户选择的外部共享文件夹仍位于原路径，不能只备份 `data/` 就认为备份了整个项目。`settings.json` 的加密数据绑定本机系统环境，换电脑后可能需要重新配置 key。

## 权限与数据边界

- 内部服务不应暴露到局域网或公网，也不是多用户服务。桌面窗口启用上下文隔离、renderer sandbox，并禁用 Node integration。
- 权限档位会传给各引擎；实际约束依赖该引擎的工具白名单、沙箱和提示词。工作目录不是文件访问沙箱。
- 任务协作会写文件；当前工作者阶段至少使用“可改文件”，即使空间聊天设为“只读”。
- 文件历史只覆盖扫描范围内的文本，不能替代 Git 或完整备份。
- 真实调用会将聊天、导入背景或共享文件上下文交给所选引擎。模拟引擎不联网调用 AI，但仍会写文件。
- 主进程提供 `safeStorage` 加解密钩子；不可加密或直接使用无钩子的服务时，key 可能明文保存。对外分享前不要复制设置文件。

## 调试

F12 打开开发者工具，Ctrl+R 刷新界面。需要记录 CLI 原始事件时，在 PowerShell 设置：

```powershell
$env:RT_DEBUG_DIR = Join-Path $PWD 'debug'
npm start
```

`debug/` 已忽略。日志可能包含对话和文件内容，提交 Issue 前先脱敏。首次 Electron 下载失败时，可按 [安装排查](publishing.md#安装排查) 配置镜像后重试。
