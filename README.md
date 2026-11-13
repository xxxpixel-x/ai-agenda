# Agenda

中文 · [English](README.en.md)

你和几个 AI 的协作会议室。Claude Code、Codex、Gemini、DeepSeek 坐在同一张桌上讨论、分工，一起改同一个文件夹。写代码可以，写文档、论文、方案也可以。

在别的 AI 里做到一半的事，可以把对话带进来接着做；也可以只挑出其中一个主题，整理成简报，交给另一个 AI 接手。

**桌面应用 · Windows / macOS / Linux · MIT 开源**

## 用起来是这样

1. **连接 AI**：Agenda 本身不带 AI。你至少需要一个：本机装好并登录过的 Claude Code、Codex、DeepSeek Harness、Gemini CLI，或者一个 API key（Gemini、DeepSeek、通义千问、Kimi、智谱、OpenAI、本地 Ollama 等）。
2. **新建空间**：一个空间就是一场会议，包括参加的 AI（成员）、大家一起改的共享文件夹、以及给 AI 的权限。
3. **发消息**：你说一句，成员依次发言、互相接话，需要时直接改文件。可以 `@` 点名某个 AI，也可以随时插话或叫停。
4. **看结果**：右侧文件面板能看到每次改动是谁改的，可以对比、撤销。大一点的活交给「任务协作」，让 AI 先列计划再分头做。

没有 AI 账号也能先用演示模式看看界面和流程。

## 能做什么

- **自由讨论**：成员依次发言、互相接话，支持 `@` 点名、插话、跳过、停止和轮次上限。AI 都觉得说完了就停下来等你。
- **一起改文件**：用软件新建的文件夹，或者电脑上已有的项目。不管哪个 AI 用什么方式改，每次改动都记下是谁改的，可以对比、撤销。
- **任务协作**：规划 → 你确认 → 按依赖执行 → 你审查 → 汇总。Git 项目里各 AI 在各自的 worktree 里并行，最后一键合并。
- **导入对话**：自动列出本机 Claude Code、Codex、DeepSeek Harness、Gemini CLI、WorkBuddy / CodeBuddy、ZCode 的会话；ChatGPT、Claude.ai、Gemini 网页版等其他软件，可以粘贴对话或选导出文件。导入的 Claude Code 对话能接着原会话继续；太长时自动压成摘要；原对话有新内容时可以补导。
- **按主题交接**：在 Claude Code 里做游戏，只想把剧本交给 Gemini？填“剧本”，Agenda 只挑出相关内容写成简报（背景 / 已定的 / 约束和接口 / 待讨论 / 相关原文），存成共享文件夹里的 `主题-剧本.md`。其他成员只看简报，不看整段原对话。
- **混合成员**：命令行 AI 用各自账号的额度，API 模型也能参与改文件。同一种 AI 可以加多个，分别设定角色（比如“你负责挑毛病”）、型号和思考档位。
- **命令审批**：允许 AI 运行命令时，每条命令先弹卡片问你，可以允许、一直允许某个程序或拒绝并说明理由。

## 安装

### 下载安装包

到 [Releases](https://github.com/xxxpixel-x/ai-agenda/releases/latest) 下载对应系统的安装包：

| 系统 | 下载 | 第一次打开 |
| --- | --- | --- |
| Windows 10 / 11 | `Agenda-<版本>-win-x64.exe` | 安装包没有签名，弹出 SmartScreen 时点「更多信息」→「仍要运行」 |
| macOS（Apple 芯片：M1 及以后） | `Agenda-<版本>-mac-arm64.dmg` | 见下方说明 |
| macOS（Intel 芯片） | `Agenda-<版本>-mac-x64.dmg` | 见下方说明 |
| Linux | `Agenda-<版本>-linux-x86_64.AppImage` 或 `Agenda-<版本>-linux-amd64.deb` | AppImage 先加执行权限：`chmod +x Agenda-*.AppImage` |

**macOS**：打开 dmg，把 Agenda 拖进「应用程序」。因为没有 Apple 签名，第一次要在「应用程序」里右键点 Agenda，选「打开」。如果提示“已损坏，无法打开”，在终端运行一次下面的命令再打开：

```sh
xattr -cr /Applications/Agenda.app
```

Windows 版已实测；macOS 和 Linux 安装包由 GitHub Actions 自动打出，还没有在真机上完整实测，遇到问题欢迎[提 Issue](https://github.com/xxxpixel-x/ai-agenda/issues)。

### 从源码运行

需要 [Node.js](https://nodejs.org/) **22.12.0 或以上**。用任务协作的并行模式时，还需要 [Git](https://git-scm.com/)。

```sh
git clone https://github.com/xxxpixel-x/ai-agenda.git
cd ai-agenda
npm ci
npm start          # 打开应用
npm run mock       # 或者：演示模式，不调用任何 AI
```

Windows 上也可以直接双击 [`启动.cmd`](启动.cmd)：第一次会自动安装依赖，默认通过国内镜像下载 Electron（已设置 `ELECTRON_MIRROR` 时用你的设置）。

想像普通软件一样双击打开，可以运行 `npm run build:launcher -- -DesktopShortcut`，生成 `Agenda.exe` 和桌面快捷方式（仅 Windows，要和项目文件夹一起使用）。

## 连接 AI

打开应用后，在窗口左下角点「连接与登录」：

| AI | 怎么接入 | 你需要做的 |
| --- | --- | --- |
| Claude Code | 本机命令行，自动查找 | 按界面提示登录一次；找不到时可以手动指定路径 |
| Codex | 本机命令行，自动查找 | 在 Codex 里登录过即可 |
| DeepSeek Harness | 本机安装，自动查找 | 在 DeepSeek Harness 里登录过即可 |
| Gemini CLI | 本机命令行，装了才出现 | 在终端运行一次 `gemini`，用 Google 账号登录 |
| Gemini API | API | 填 API key |
| OpenAI 兼容接口 | API | 填接口地址、API key 和模型；DeepSeek、通义千问、Kimi、智谱、OpenAI、Ollama 有预设 |

命令行 AI 用的是你在那个软件里的账号和额度，不需要 API key。能选哪些型号、额度多少，取决于你的账号和本机安装。

## 权限

每个空间选一档，随时可以在「设置」里改：

| 权限 | AI 能做什么 |
| --- | --- |
| 只读 | 只能看共享文件夹，不能改 |
| 可改文件 | 可以改共享文件夹里的文件 |
| 可运行命令 | 还可以在共享文件夹里运行命令，每条命令先问你 |
| 全部权限 | 不受限制，可以读写电脑上任何地方、运行任何命令 |

权限靠各 AI 自带的工具限制、沙箱或提示词实现，不是操作系统级的隔离。前三档会关掉你账号里的外部连接（插件、MCP 等）。各 AI 的具体差别见 [使用指南](docs/usage.md#使用)。

## 数据与隐私

- 聊天记录和设置都存在本机：
  - 安装版：Windows `%APPDATA%\Agenda`，macOS `~/Library/Application Support/Agenda`，Linux `~/.config/Agenda`
  - 源码版：项目里的 `data/`（演示模式是 `data-mock/`）
- API key 存在本机 `settings.json`，系统支持时会加密保存，否则是明文，不要把这个文件发给别人。
- 本地保存不代表离线：AI 发言时，相关的聊天和文件内容会发给你配置的 AI 服务。

## 当前限制

- 安装包没有代码签名；macOS 和 Linux 版还没在真机上完整实测。
- 命令审批卡片只支持聊天里的 Claude Code 和 Codex。Codex 这一路用的是它标为实验性的 `codex app-server` 协议，Codex 升级后可能需要跟着调整。
- 任务协作里的终端视图只是输出记录，不能交互。
- 文件改动历史只跟踪 1 MiB 以下的文本文件，最多 3,000 个；大文件和二进制文件撤销不了。
- 自动测试用的是模拟 AI，真实 AI 的登录、网络和型号兼容性需要在各自环境里实测。

## 文档

- [使用指南](docs/usage.md)：讨论、文件、权限、导入对话、任务协作和排查方法
- [开发说明](docs/development.md)：代码结构、引擎接口、测试、打包与发布
- [贡献指南](CONTRIBUTING.md)：本地检查与提交约定
- [导入来源与新增方法](docs/importers.md)：想让 Agenda 读取另一个 AI 软件的对话，从这里开始
- [需求与实现记录](docs/需求说明.md)、[对话导入设计](docs/需求-导入对话.md)

## 参与开发

```sh
npm run verify     # 语法检查 + 自动化测试，不打开窗口、不调用真实 AI
npm run dist       # 打当前系统的安装包，输出到 dist/
```

推送 `v*` 标签后，GitHub Actions 会自动打三个系统的安装包并上传到 release，步骤见 [开发说明](docs/development.md#打包与发布)。

## 许可与致谢

项目采用 [MIT License](LICENSE)。AI 品牌图标来自 LobeHub，版权和许可见 [图标声明](public/icons/LICENSE.md)；第三方组件见 [第三方说明](THIRD_PARTY_NOTICES.md)。

任务协作的协调者 / 工作者和依赖图设计参考了 [orca](https://github.com/stablyai/orca)。
