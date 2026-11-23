<img src="public/brand/agenda.svg" width="64" height="64" alt="">

# Agenda

[中文](README.md) · English

Agenda is a desktop workspace where you can bring Claude Code, Codex, Gemini, DeepSeek, and other AIs together to discuss, divide up work, and edit the same folder. Start with a discussion or continue a conversation from another AI app. Step in when it's time to approve a plan, review the results, or merge.

**Windows / macOS / Linux · MIT licensed**

> **Upgrading from 0.3.x?** On first launch, Agenda removes legacy spaces from before the split into chat and task spaces, including shared folders that Agenda created for them. Folders you selected yourself are kept. Before upgrading, use **Export** in the top right of each old space and copy any shared files you want to keep.

## Two kinds of space

| Space | How it works |
| --- | --- |
| **Chat space** | Discuss a plan, write together, or edit shared files. Multiple members take turns and can respond to one another. Use `@` to address a member, **Ask only** to direct a message to one member, or interrupt, skip, or stop at any time. A chat space with a single member automatically switches to solo chat without turn limits and uses a private long session when supported. |
| **Task space** | Give a coordinator a goal. If the goal is ambiguous, it asks up to three clarifying questions with default answers before breaking work into subtasks with dependencies and listed assumptions. Approve plans and review results yourself, or enable automatic starts and approvals. Git projects can run in parallel in separate worktrees, and you merge the result with a drafted commit message after review. Other folders are edited sequentially. |

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

Requires Node.js **22.19.0 or later**. Parallel task execution in a Git project also requires Git.

```sh
git clone https://github.com/xxxpixel-x/ai-agenda.git
cd ai-agenda
npm ci
npm start
```

To explore the interface and workflow first, run `npm run mock`. Demo mode needs no AI account or API key.

On Windows, you can also double-click `启动.cmd` in the project folder. It installs dependencies on first run. Use `npm run build:launcher -- -DesktopShortcut` to generate an `Agenda.exe` launcher in the project folder and a desktop shortcut.

## Start collaborating

1. **Connect an AI.** Open **Settings → AI connections** in the lower left. You can mix local tools, embedded `pi`, API models, and custom ACP tools. CLI tools use your existing accounts and quotas, and Claude Code can also point to an Anthropic-compatible third-party provider.
2. **Create a space.** Choose a chat or task space and add members, or load members, instructions, and tools from **Role cards** and **Teams**. Pick a folder and permission level directly, or use a shared folder created by Agenda. You can add the same AI more than once, with different roles, model sources, models, and supported reasoning levels.
3. **Send a message or set a goal.** Send a message in a chat space; AI replies include a compact summary of commands they ran. In a task space, planning starts on creation (with clarifying questions if needed). Open **Plan** in the right sidebar to see subtasks, assumptions, dependencies, progress, and items awaiting review.
4. **Review files, context, and memory.** Switch between **Files**, **Changes**, **Plan** (task spaces), **Context**, and **Memory** in the collapsible right sidebar. Preview and edit shared files, send inline diff comments, inspect each member's context breakdown and memory references, reopen a session manually, or view and edit the chat recap. Drag files and images into the message field; image input depends on the engine.

| Connection | Supported AIs | Setup |
| --- | --- | --- |
| Local tool | Claude Code, Codex, DeepSeek Harness, Gemini CLI | Install and sign in to the tool. Set its executable path manually if Agenda can't find it. Claude Code can also use any provider marked for Claude Code. |
| Embedded `pi` | Runs API models as hands-on file/command agents with skill and MCP mounting | Bundled with Agenda—no extra install required. Configure an API provider below, then pick `Pi · <Provider>`. |
| Custom AI (ACP) | Any CLI AI supporting Agent Client Protocol over stdio JSON-RPC | Add name, launch command, and arguments under **AI connections → Custom AI (ACP)**; saving runs a handshake check automatically. |
| Gemini API | Gemini models | Enter an API key. |
| OpenAI-compatible API | DeepSeek, Qwen, Kimi, Zhipu, OpenAI, Ollama, and others | Enter the endpoint, model, and any key required by the service (local services like Ollama can leave the key blank). Optionally enable **Also use with Claude Code**. |

In **Settings → General**, choose Chinese, English, or the system language, switch between light and dark appearance, and manage desktop notifications, sleep prevention while AI is working, and the automatic session handoff threshold (50% by default). When Agenda is in the background, it can notify you that a discussion has ended, the coordinator has clarifying questions, a task needs attention, or a command is waiting for approval. Click a notification to open its space.

## Role cards, memory, and scheduling

- **Library and marketplace.** Open **Library** in the sidebar to manage **Role cards**, **Teams**, **Skills and MCP**, and the **Marketplace**. Includes 7 built-in bilingual role cards and preset teams, custom overrides with reset, single-file Markdown export and previewed import, local skill/MCP discovery, cross-AI skill linking, isolated MCP secret storage, and per-member mounting for `pi`, Claude Code, and Codex.
- **Context management and space memory.** Agenda organizes decisions, constraints, preferences, rejected approaches, proposals, and task results into a structured space memory, injects layered context per member/dependency with message-number citations, maintains an editable rolling recap when older messages roll out, performs automatic session handoffs at the configured context threshold, and shows context rings and quota warnings on member badges.
- **Scheduling.** Configure one-time, weekly, or fixed-interval schedules in space settings (**Schedules**) or global settings (**Schedules**) to create task spaces or post messages to chat spaces. Overlapping or missed runs are skipped. With an enabled schedule, closing the window hides Agenda in the system tray or menu bar; both the computer and Agenda must keep running.

## Import conversations and hand off work

- **Bring in an existing conversation.** Read local sessions from Claude Code, Codex, DeepSeek Harness, Gemini CLI, WorkBuddy / CodeBuddy, and ZCode. You can also paste text or import an export from ChatGPT, Claude.ai, Gemini on the web, or another tool.
- **Keep the context you need.** Retain the transcript, summarize the older portion, or write a Markdown handoff. Agenda can copy a Claude Code session up to the last imported message and continue from there. You can import later additions separately.
- **Hand off a single topic.** Choose **By topic** and enter a topic. Agenda writes the relevant background, decisions, constraints, and open items into a Markdown brief in the shared folder, ready for other members to use.

Import instructions and supported formats are documented in Chinese. [Conversation import guide](docs/usage.md#导入别处的对话) · [Supported import sources](docs/importers.md)

## Permissions and data

- Spaces have four permission levels, **Read only**, **Edit files**, **Run commands**, and **Full access**. Restrictions depend on each engine's tools, sandbox, or prompts. **Full access** allows access outside the shared folder.
- With **Run commands**, Claude Code, Codex, and embedded `pi` in chat spaces ask for approval. You can allow a command once, allow a program, or deny the request, with an optional note. Custom ACP tools also route file-edit and command permission requests to approval cards in **Read only** and **Edit files** modes (ACP tools that do not enforce permissions are flagged on the member badge). DeepSeek Harness and Gemini CLI use the **Edit files** level in this case. Task workers run with at least **Edit files**, and their engines handle commands according to the applicable permissions. Mounting a mutating MCP server in a space with lower permissions prompts you to raise access, skip the MCP server, or cancel.
- File history tracks up to 3,000 text files of at most 1 MiB each. Recover large or binary files through your project's version history or backups. **Raw output** in task spaces shows the execution log.
- Chat history, space memory, role cards, and settings are stored locally. The default paths for installed apps are `%APPDATA%\Agenda\data` on Windows, `~/Library/Application Support/Agenda/data` on macOS, and `~/.config/Agenda/data` on Linux. Source runs use the project's `data/` directory, and demo mode uses `data-mock/`.
- API keys and MCP secrets are stored in config files inside the data directory. They are encrypted when system encryption is available and stored in plain text otherwise. Real AI calls send relevant conversation and file context to the selected engine or API service.

## Ongoing verification

- **Live provider and account verification.** Embedded `pi`, Claude Code with third-party providers, automatic handoff, long-discussion space memory, role-card skill/MCP mounting, and ACP support are verified with automated mock tests. Live end-to-end verification with real API keys/accounts and migrating legacy API members onto `pi` are still pending.
- **Cross-platform verification.** Recent changes were tested primarily on Windows; live verification on macOS and Linux (including tray and notification behavior) is pending.

## Development and documentation

```sh
npm run verify     # Syntax checks and automated tests using mock AIs
npm run dist       # Build an installer for the current system into dist/
```

The detailed documentation is in Chinese.

- [Usage guide](docs/usage.md)
- [Development and release notes](docs/development.md)
- [Contributing guide](CONTRIBUTING.md)

Agenda is MIT licensed. AI brand icons come from LobeHub. Orca informed the coordinator and worker roles and the dependency graph in task spaces. [MIT License](LICENSE) · [Icon license](public/icons/LICENSE.md) · [Third-party notices](THIRD_PARTY_NOTICES.md) · [Orca](https://github.com/stablyai/orca)
