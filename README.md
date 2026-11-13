# Agenda

你和几个 AI 的协作会议室。Claude Code、Codex、Gemini、DeepSeek 坐在同一张桌上讨论、分工，一起改同一个文件夹。写代码可以，写文档、论文、方案也可以。

在别的 AI 里做到一半的事，可以把对话带进来接着做；也可以只挑出其中一个主题，整理成简报，交给另一个 AI 接手。

**桌面应用 · Windows / macOS / Linux · Electron · 原生 JavaScript · MIT**

## 能做什么

- **导入对话**：自动列出本机 Claude Code、Codex、DeepSeek Harness、Gemini CLI、WorkBuddy / CodeBuddy、ZCode 的会话；其他软件（ChatGPT、Claude.ai、Gemini 网页版等）可以粘贴对话或选导出文件。导入的 Claude Code 对话可以接着原会话继续；太长时自动压成摘要或交接文档，原对话有新内容时可以补导。
- **按主题交接**：在 Claude Code 里做游戏，只想把剧本交给 Gemini？填“剧本”，只挑出相关内容写成简报（背景 / 已定的 / 约束和接口 / 待讨论 / 相关原文），存成共享文件夹里的 `主题-剧本.md`。其他成员只看简报，不看整段原对话，默认在原项目的主题子文件夹里工作。成员改了简报要你采用才生效；补导时只并入和主题相关的新内容。
- **自由讨论**：成员依次发言、互相接话，支持 `@` 点名、插话、跳过、停止和轮次上限。
- **一起改文件**：用软件新建的文件夹或现有项目。不管哪个 AI 用什么方式改，每次改动都记下是谁改的，可以对比、撤销。
- **任务协作**：规划 → 你确认 → 按依赖执行 → 你审查 → 汇总。Git 项目里各 AI 在独立 worktree 并行，最后一键合并。
- **混合成员**：命令行 AI 用各自账号的额度，API 模型（Gemini、通义、Kimi、智谱、Ollama 等）也能参与改文件。同一种 AI 可以加多个，分别设定角色、型号和思考档位（引擎支持时）。
- **演示模式**：无需 AI 账号即可体验界面和协作流程。

## 快速开始

### 下载安装包

到 [Releases](https://github.com/xxxpixel-x/ai-agenda/releases) 下载对应系统的安装包：

| 系统 | 文件 | 首次打开 |
| --- | --- | --- |
| Windows 10 / 11 | `Agenda-<版本>-win-x64.exe` | 安装包没有签名，SmartScreen 提示时点「更多信息 → 仍要运行」 |
| macOS（Apple 芯片） | `Agenda-<版本>-mac-arm64.dmg` | 没有签名，见下方说明 |
| macOS（Intel） | `Agenda-<版本>-mac-x64.dmg` | 同上 |
| Linux | `.AppImage`（加执行权限后直接运行）或 `.deb` | — |

macOS 上把 Agenda 拖进「应用程序」后，第一次请右键点它选「打开」；如果提示“已损坏”，在终端运行一次：

```sh
xattr -cr /Applications/Agenda.app
```

Windows 版已实测；macOS 和 Linux 安装包由 GitHub Actions 自动打出，还没有在真机上完整实测，遇到问题欢迎提 Issue。

### 从源码运行

- Windows 10 / 11、macOS 或 Linux；`启动.cmd` 和 exe 启动器仅限 Windows。
- [Node.js](https://nodejs.org/) **22.12.0 或以上**，包含 npm。此下限与锁定的 Electron 安装依赖一致。
- 使用 Git 项目的并行任务协作时，需要已加入 PATH 的 [Git](https://git-scm.com/)。
- 真实 AI 调用需要相应 CLI 登录或 API key；演示模式不需要。

克隆仓库后，在项目根目录执行：

```sh
npm ci
npm start
```

Windows 也可以双击 [`启动.cmd`](启动.cmd)。首次运行按锁文件安装依赖，并默认通过国内镜像下载 Electron；已有 `ELECTRON_MIRROR` 设置时使用你的设置。

无需账号体验：

```sh
npm run mock
```

演示模式使用独立的 `data-mock/`，会真实写入你选择的共享文件夹。体验时可选“新建空文件夹”。

### Windows 启动器（可选）

装好依赖后运行 `npm run build:launcher`，会在项目根目录生成 `Agenda.exe`；加 `-- -DesktopShortcut` 同时创建桌面快捷方式。之后双击即可打开，不弹命令行窗口，再次打开会切回已有窗口。构建用 Windows 自带的 .NET Framework C# 编译器，不需要额外打包工具。

启动器要和装好依赖的项目文件夹配套使用，请通过快捷方式打开，不要单独移动 exe。

### 连接 AI

在窗口左下角打开“连接与登录”：

| 接入 | 配置方式 |
| --- | --- |
| Claude Code | 自动查找本机 CLI；按界面提示登录，或手动指定路径 |
| Codex | 自动查找本机 CLI；使用本机登录状态 |
| DeepSeek Harness | 自动查找本机安装；使用已有账号配置 |
| Gemini CLI | 装了才出现；自动查找本机 CLI，使用它的 Google 账号登录 |
| Gemini API | 填写 Gemini API key |
| OpenAI 兼容接口 | 填写接口地址、API key 和模型；内置 DeepSeek、通义千问、Kimi、智谱、OpenAI、Ollama 预设 |

CLI 可用模型、账号额度及权限行为取决于本机安装和服务商配置。完整操作说明见 [使用指南](docs/usage.md)。

## 数据与权限

- 安装版的数据在系统的用户数据目录：Windows `%APPDATA%\Agenda`，macOS `~/Library/Application Support/Agenda`，Linux `~/.config/Agenda`。从源码运行时在项目里的 `data/`，演示模式在 `data-mock/`，这些目录已从 Git 排除。
- API key 存在本机 `settings.json`。桌面版在系统加密可用时使用 Electron safeStorage；不可用时回退到明文。
- AI 请求会把相应聊天和文件上下文发送给你配置的引擎；“本地保存”不代表 AI 推理离线进行。
- 权限档位通过各引擎的工具限制、沙箱或提示词实现，不能视为统一的操作系统级隔离。详见 [权限说明](docs/development.md#权限与数据边界)。

## 开发与验证

```sh
npm run verify
```

该命令执行 JavaScript 语法检查和自动化测试，不启动桌面窗口、不调用真实 AI。测试在临时目录创建空间与 Git 仓库，不读取你的真实会话和配置。

| 命令 | 用途 |
| --- | --- |
| `npm start` | 启动桌面应用 |
| `npm run mock` | 启动演示模式 |
| `npm run build:launcher` | 生成 Windows 无命令行窗口启动器；加 `-- -DesktopShortcut` 创建桌面快捷方式 |
| `npm run check` | 检查源码语法与包元数据一致性 |
| `npm test` | 运行核心逻辑和本机接口测试 |
| `npm run verify` | 运行全部自动检查 |
| `npm run dist` | 打当前系统的安装包，输出到 `dist/` |

```text
electron/       桌面入口、预加载与图标
public/         原生 HTML / CSS / JavaScript 界面
src/            本机服务、空间调度、任务协作、存储
  engines/      CLI / API 引擎适配器
  importers/    外部会话读取器
scripts/        检查脚本与启动器构建
test/           自动化测试
docs/           使用指南、开发说明和需求记录
.github/        CI、发布打包、Issue 与 PR 模板
```

## 文档

- [使用指南](docs/usage.md)：讨论、文件、对话导入、任务协作和排查方法。
- [开发说明](docs/development.md)：模块职责、引擎接口、测试与数据边界。
- [贡献指南](CONTRIBUTING.md)：本地检查与提交约定。
- [需求与实现记录](docs/需求说明.md)、[对话导入设计](docs/需求-导入对话.md)、[导入来源与新增方法](docs/importers.md)。

## 当前限制

- 安装包没有代码签名；macOS 和 Linux 版尚未在真机上完整实测。
- 命令审批卡片只覆盖聊天中的 Claude Code 和 Codex；Codex 这一路走的是标为实验性的 `codex app-server` 协议，Codex 升级后可能需要跟着调整。
- 任务的终端视图是原始输出记录，不是可交互终端。
- 文件改动历史主要跟踪 1 MiB 以下的文本文件，最多 3,000 个；大文件和二进制文件不具备同等撤销保障。
- 自动测试使用模拟引擎，真实 CLI / API 的登录、网络和模型兼容性仍需在对应环境实测。

## 许可与致谢

项目采用 [MIT License](LICENSE)。AI 品牌图标来自 LobeHub，版权和许可保留在 [图标声明](public/icons/LICENSE.md)；第三方组件信息见 [第三方说明](THIRD_PARTY_NOTICES.md)。

任务协作的协调者 / 工作者和依赖图设计参考了 [orca](https://github.com/stablyai/orca)。
