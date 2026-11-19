<img src="public/brand/agenda.svg" width="64" height="64" alt="">

# Agenda

中文 · [English](README.en.md)

Agenda 是一个多 AI 协作桌面应用。把 Claude Code、Codex、Gemini、DeepSeek 等 AI 加进同一个空间，让它们围绕同一个文件夹讨论、分工和交付。你可以从讨论开始，也可以把其他 AI 软件里的对话带进来继续做，在确认计划、审查结果或合并时介入。

**Windows / macOS / Linux · MIT 开源**

> **从 0.3.x 升级？** 首次启动会删除尚未区分聊天和任务的旧空间，以及 Agenda 为这些空间创建的共享文件夹。手动选择的文件夹会保留。升级前，请在旧版每个空间右上角点「导出」，并复制要保留的共享文件。

## 两种空间

| 空间 | 怎么用 |
| --- | --- |
| **聊天空间** | 适合讨论方案、写作和一起改文件。成员按顺序发言，可以互相接话。你可以用 `@` 点名，也可以随时插话、跳过或停止。 |
| **任务空间** | 给出目标，由协调者拆成有依赖的子任务。可以等你确认计划和审查结果，也可以开启自动开始和自动通过。用 Git 的项目可以在独立 worktree 中并行处理，审查后由你合并到当前分支。普通文件夹按顺序修改。 |

聊天里定下方案后，可以选中几条消息「转到任务空间」。执行中有新想法，可以发给协调者，由它补充说明或调整计划。结束任务时，可以把总结发回原聊天空间。

## 安装

本 README 对应仓库当前源码。安装包提供的功能以各版本的发布说明为准，想体验当前源码可直接按下方步骤运行。

### 下载安装包

| 系统 | 安装包 |
| --- | --- |
| Windows 10 / 11（x64） | `Agenda-<版本>-win-x64.exe` |
| macOS（Apple 芯片） | `Agenda-<版本>-mac-arm64.dmg` |
| macOS（Intel 芯片） | `Agenda-<版本>-mac-x64.dmg` |
| Linux（x64） | `Agenda-<版本>-linux-x86_64.AppImage` 或 `Agenda-<版本>-linux-amd64.deb` |

到发布页下载对应系统和架构的安装包。[Releases](https://github.com/xxxpixel-x/ai-agenda/releases/latest)

安装包尚未签名。Windows 遇到 SmartScreen 提示时，可选「更多信息」→「仍要运行」。macOS 打开 DMG 后，把 Agenda 拖到「应用程序」，然后在「应用程序」里右键点 Agenda，选「打开」。如果 macOS 提示应用已损坏，可在终端执行 `xattr -cr /Applications/Agenda.app` 后再打开。使用 Linux AppImage 时，先执行 `chmod +x Agenda-*.AppImage`。

近期改动主要在 Windows 上验证。macOS 和 Linux 的安装包由 GitHub Actions 构建，完整的真机验证待完成。[问题反馈](https://github.com/xxxpixel-x/ai-agenda/issues)

### 从源码运行

需要 Node.js **22.12.0 或以上**。用 Git 项目并行执行任务时，还需要 Git。

```sh
git clone https://github.com/xxxpixel-x/ai-agenda.git
cd ai-agenda
npm ci
npm start
```

想先体验界面和流程，可以用 `npm run mock` 打开演示模式，无需 AI 账号或 API 密钥。

Windows 上也可以双击项目里的 `启动.cmd`，首次运行会安装依赖。运行 `npm run build:launcher -- -DesktopShortcut` 可以生成项目内的 `Agenda.exe` 和桌面快捷方式。

## 开始协作

1. **连接 AI。** 打开左下角「设置 → AI 连接」。本机程序和 API 可以混用，CLI 使用你在各自工具里的账号和额度。
2. **创建空间。** 选择聊天或任务空间，添加成员。展开「更多选项」可选择已有文件夹和权限，也可以用 Agenda 创建的共享文件夹。同一个 AI 可以添加多个成员，分别设置角色、模型和可用的思考档位。
3. **发消息或填写目标。** 聊天空间里直接发消息。任务空间创建后开始规划，在右侧「计划」里看子任务、依赖、进度和待审查项。
4. **检查文件。** 在可收起的右侧栏切换「文件」「改动」和「计划」（任务空间）。你可以预览和编辑共享文件，对受跟踪的改动查看差异、撤销或在 diff 上逐行批注并发给对应成员。发送消息时可以拖入文件或图片，图片读取取决于引擎。

| 接入方式 | 支持的 AI | 配置 |
| --- | --- | --- |
| 本机程序 | Claude Code、Codex、DeepSeek Harness、Gemini CLI | 安装并登录对应工具。自动检测失败时可手动指定程序路径。 |
| Gemini API | Gemini 模型 | 填 API 密钥。 |
| OpenAI 兼容接口 | DeepSeek、通义千问、Kimi、智谱、OpenAI、Ollama 等 | 填接口地址、模型和服务要求的密钥。Ollama 等本地服务可以留空密钥。 |

「设置 → 通用」里可以切换中文、English 或跟随系统，选择深浅主题，并管理桌面通知和工作时防睡眠。窗口在后台时，讨论结束、任务进展需要处理或命令等待审批等情况会触发系统通知。点击通知可返回对应空间。

## 导入对话与交接

- **带入已有对话。** 可以从本机读取 Claude Code、Codex、DeepSeek Harness、Gemini CLI、WorkBuddy / CodeBuddy 和 ZCode 的会话，也可以粘贴文本或导入 ChatGPT、Claude.ai、Gemini 网页版等工具导出的文件。
- **保留需要的上下文。** 可以保留原文、把较早的内容压成摘要，或写成 Markdown 交接文档。Claude Code 可从导入时的最后一条消息复制会话并接着聊，源会话后续新增的内容可以补导。
- **只交接一个主题。** 选「按主题」并填入关键词，Agenda 会把相关背景、决定、约束和待办写成共享文件夹里的 Markdown 简报，供其他成员继续处理。

导入步骤和各来源支持的格式详见文档。[对话导入指南](docs/usage.md#导入别处的对话) · [导入来源列表](docs/importers.md)

## 权限与数据

- 空间有四档权限，分别是「只读」「可改文件」「可运行命令」「全部权限」。约束由各引擎的工具配置、沙箱或提示词实现，强度因引擎而异。「全部权限」可访问共享文件夹以外的位置。
- 聊天空间的 Claude Code 和 Codex 在「可运行命令」档会请求审批，可以单次允许、按程序放行或拒绝，并附上说明。DeepSeek Harness 和 Gemini CLI 在这一档按「可改文件」处理。任务工作者至少以「可改文件」运行，任务执行期间由引擎按权限处理命令。
- 文件历史最多跟踪 3,000 个不超过 1 MiB 的文本文件。大文件和二进制文件的恢复需要依赖项目自身的版本历史或备份。任务空间的「原始输出」用于查看执行日志。
- 聊天记录和设置保存在本机。安装版默认位于 Windows 的 `%APPDATA%\Agenda\data`、macOS 的 `~/Library/Application Support/Agenda/data` 或 Linux 的 `~/.config/Agenda/data`。源码版使用项目的 `data/`，演示模式使用 `data-mock/`。
- API 密钥存于数据目录的 `settings.json`，系统加密可用时加密保存，否则以明文保存。调用真实 AI 时，相关对话和文件上下文会交给所选引擎或 API 服务。

## 正在开发

- **定时任务。** 本地 `/api/schedules` 已支持单次、每周和固定间隔调度，可自动创建任务空间或向聊天空间发消息。重叠和错过的执行会跳过。启用定时任务时，关闭窗口会将应用收进系统托盘或菜单栏，电脑和 Agenda 需保持运行。桌面配置界面待接入。[定时任务设计](docs/需求-定时任务.md)
- **用量与上下文。** 后端会记录引擎提供的 token、缓存、上下文和额度数据，字段因引擎而异。成员用量显示、上下文面板和自动交接仍在规划中。[上下文与额度设计](docs/需求-上下文与额度.md)
- 角色卡、团队、记忆库和其他功能的进度记录在项目待办中。[项目待办](docs/待办.md)

## 开发与文档

```sh
npm run verify     # 语法检查与自动化测试，使用模拟 AI
npm run dist       # 构建当前系统的安装包，输出到 dist/
```

- [使用指南](docs/usage.md)
- [开发说明与发布流程](docs/development.md)
- [贡献指南](CONTRIBUTING.md)
- [需求与产品方向](docs/需求说明.md)

Agenda 采用 MIT 许可。AI 品牌图标来自 LobeHub，任务空间的协调者、工作者与依赖图设计参考了 Orca。[MIT License](LICENSE) · [图标许可](public/icons/LICENSE.md) · [第三方声明](THIRD_PARTY_NOTICES.md) · [Orca](https://github.com/stablyai/orca)
