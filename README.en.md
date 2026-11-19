<img src="public/brand/agenda.svg" width="64" height="64" alt="">

# Agenda

[中文](README.md) · English

Agenda is a desktop workspace where you can bring Claude Code, Codex, Gemini, DeepSeek, and other AIs together to discuss, divide up work, and edit the same folder. Start with a discussion or continue a conversation from another AI app. Step in when it's time to approve a plan, review the results, or merge.

**Windows / macOS / Linux · MIT licensed**

> **Upgrading from 0.3.x?** On first launch, Agenda removes legacy spaces from before the split into chat and task spaces, including shared folders that Agenda created for them. Folders you selected yourself are kept. Before upgrading, use **Export** in the top right of each old space and copy any shared files you want to keep.

## Two kinds of space

| Space | How it works |
| --- | --- |
| **Chat space** | Discuss a plan, write together, or edit shared files. Members take turns and can respond to one another. Use `@` to address a member, or interrupt, skip, or stop at any time. |
| **Task space** | Give a coordinator a goal and it breaks the work into subtasks with dependencies. Approve the plan and review the results yourself, or enable automatic starts and approvals. Git projects can run in parallel in separate worktrees, and you merge the result into your branch after review. Other folders are edited sequentially. |

Once a discussion settles on a plan, select messages and choose **Move to a task space**. Send new requirements to the coordinator while work is underway. It can record them as notes or revise the plan. When the task ends, you can post the summary back to the original chat space.

## Install

This README describes the current source tree. Check the release notes for features available in the installer, or run from source to try the current changes.

### Download

| System | Installer |
| --- | --- |
| Windows 10 / 11 (x64) | `Agenda-<version>-win-x64.exe` |
| macOS (Apple silicon) | `Agenda-<version>-mac-arm64.dmg` |
| macOS (Intel) | `Agenda-<version>-mac-x64.dmg` |
| Linux (x64) | `Agenda-<version>-linux-x86_64.AppImage` or `Agenda-<version>-linux-amd64.deb` |

Choose the installer for your system and architecture. [Releases](https://github.com/xxxpixel-x/ai-agenda/releases/latest)

Installers are unsigned. On Windows, if SmartScreen appears, choose **More info → Run anyway**. On macOS, open the DMG, drag Agenda into Applications, then right-click it there and choose **Open**. If macOS reports that the app is damaged, run `xattr -cr /Applications/Agenda.app` in Terminal, then open it again. For the Linux AppImage, first run `chmod +x Agenda-*.AppImage`.

Recent changes were tested primarily on Windows. GitHub Actions builds the macOS and Linux installers, and full testing on those platforms is pending. [Report an issue](https://github.com/xxxpixel-x/ai-agenda/issues)

### Run from source

Requires Node.js **22.12.0 or later**. Parallel task execution in a Git project also requires Git.

```sh
git clone https://github.com/xxxpixel-x/ai-agenda.git
cd ai-agenda
npm ci
npm start
```

To explore the interface and workflow first, run `npm run mock`. Demo mode needs no AI account or API key.

On Windows, you can also double-click `启动.cmd` in the project folder. It installs dependencies on first run. Use `npm run build:launcher -- -DesktopShortcut` to generate an `Agenda.exe` launcher in the project folder and a desktop shortcut.

## Start collaborating

1. **Connect an AI.** Open **Settings → AI connections** in the lower left. You can mix local tools and API models. CLI tools use your existing accounts and quotas.
2. **Create a space.** Choose a chat or task space and add members. Expand **More options** to pick a folder and permission level, or use a shared folder created by Agenda. You can add the same AI more than once, with different roles, models, and supported reasoning levels.
3. **Send a message or set a goal.** Send a message in a chat space. In a task space, planning starts on creation. Open **Plan** in the right sidebar to see subtasks, dependencies, progress, and items awaiting review.
4. **Review the files.** Switch between **Files**, **Changes**, and **Plan** (task spaces) in the collapsible right sidebar. Preview and edit shared files, view or undo tracked changes, or send inline diff comments to the member who made a change. Drag files and images into the message field. Image input depends on the engine.

| Connection | Supported AIs | Setup |
| --- | --- | --- |
| Local tool | Claude Code, Codex, DeepSeek Harness, Gemini CLI | Install and sign in to the tool. Set its executable path manually if Agenda can't find it. |
| Gemini API | Gemini models | Enter an API key. |
| OpenAI-compatible API | DeepSeek, Qwen, Kimi, Zhipu, OpenAI, Ollama, and others | Enter the endpoint, model, and any key required by the service. Local services such as Ollama can leave the key blank. |

In **Settings → General**, choose Chinese, English, or the system language, switch between light and dark appearance, and manage desktop notifications and whether to prevent sleep while AI is working. When Agenda is in the background, it can notify you that a discussion has ended, a task needs attention, or a command is waiting for approval. Click a notification to open its space.

## Import conversations and hand off work

- **Bring in an existing conversation.** Read local sessions from Claude Code, Codex, DeepSeek Harness, Gemini CLI, WorkBuddy / CodeBuddy, and ZCode. You can also paste text or import an export from ChatGPT, Claude.ai, Gemini on the web, or another tool.
- **Keep the context you need.** Retain the transcript, summarize the older portion, or write a Markdown handoff. Agenda can copy a Claude Code session up to the last imported message and continue from there. You can import later additions separately.
- **Hand off a single topic.** Choose **By topic** and enter a topic. Agenda writes the relevant background, decisions, constraints, and open items into a Markdown brief in the shared folder, ready for other members to use.

Import instructions and supported formats are documented in Chinese. [Conversation import guide](docs/usage.md#导入别处的对话) · [Supported import sources](docs/importers.md)

## Permissions and data

- Spaces have four permission levels, **Read only**, **Edit files**, **Run commands**, and **Full access**. Restrictions depend on each engine's tools, sandbox, or prompts. **Full access** allows access outside the shared folder.
- With **Run commands**, Claude Code and Codex in chat spaces ask for approval. You can allow a command once, allow a program, or deny the request, with an optional note. DeepSeek Harness and Gemini CLI use the **Edit files** level in this case. Task workers run with at least **Edit files**, and their engines handle commands according to the applicable permissions.
- File history tracks up to 3,000 text files of at most 1 MiB each. Recover large or binary files through your project's version history or backups. **Raw output** in task spaces shows the execution log.
- Chat history and settings are stored locally. The default paths for installed apps are `%APPDATA%\Agenda\data` on Windows, `~/Library/Application Support/Agenda/data` on macOS, and `~/.config/Agenda/data` on Linux. Source runs use the project's `data/` directory, and demo mode uses `data-mock/`.
- API keys are stored in `settings.json` in the data directory. They are encrypted when system encryption is available and stored in plain text otherwise. Real AI calls send relevant conversation and file context to the selected engine or API service.

## In development

- **Scheduling.** The local `/api/schedules` endpoint supports one-time, weekly, and fixed-interval scheduling. It can create task spaces or post messages to chat spaces. Overlapping or missed runs are skipped. With an enabled schedule, closing the window hides Agenda in the system tray or menu bar. The computer and Agenda must both keep running. Desktop configuration is pending. [Scheduling design](docs/需求-定时任务.md)
- **Usage and context.** The backend records token, cache, context, and quota data when the engine reports it. Member usage indicators, the context panel, and automatic handoff are planned. [Context and quota design](docs/需求-上下文与额度.md)
- The backlog tracks progress on role cards, teams, memory, and other features. [Project backlog](docs/待办.md)

## Development and documentation

```sh
npm run verify     # Syntax checks and automated tests using mock AIs
npm run dist       # Build an installer for the current system into dist/
```

The detailed documentation is in Chinese.

- [Usage guide](docs/usage.md)
- [Development and release notes](docs/development.md)
- [Contributing guide](CONTRIBUTING.md)
- [Requirements and product direction](docs/需求说明.md)

Agenda is MIT licensed. AI brand icons come from LobeHub. Orca informed the coordinator and worker roles and the dependency graph in task spaces. [MIT License](LICENSE) · [Icon license](public/icons/LICENSE.md) · [Third-party notices](THIRD_PARTY_NOTICES.md) · [Orca](https://github.com/stablyai/orca)
