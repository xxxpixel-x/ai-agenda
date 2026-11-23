<img src="public/brand/agenda.svg" width="64" height="64" alt="Agenda">

# Agenda · v0.4.0

**A local-first multi-AI collaborative desktop workspace.** Agenda brings **Claude Code**, **Codex**, **Gemini**, **DeepSeek**, embedded **Pi**, and custom **ACP** agents into the same room to discuss ideas, divide up work, and edit the same project folder together. Start from a round-table discussion, or import an ongoing conversation from another AI app and keep building—stepping in whenever it is time to approve a plan, authorize a command, review diffs, or merge into Git.

English | [简体中文](./README.zh-CN.md)

[![Latest Release](https://img.shields.io/github/v/release/xxxpixel-x/ai-agenda?color=1D8468&label=Release)](https://github.com/xxxpixel-x/ai-agenda/releases/latest)
[![CI](https://github.com/xxxpixel-x/ai-agenda/actions/workflows/ci.yml/badge.svg)](https://github.com/xxxpixel-x/ai-agenda/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/License-MIT-173732)](./LICENSE)
![Local-First](https://img.shields.io/badge/Local--First-Desktop_App-1D8468)
![Platforms](https://img.shields.io/badge/Platforms-Windows%20%7C%20macOS%20%7C%20Linux-4A5B56)
![Engines](https://img.shields.io/badge/Engines-Claude%20%7C%20Codex%20%7C%20Gemini%20%7C%20DeepSeek%20%7C%20Pi%20%7C%20ACP-2C6CB3)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19.0-4A5B56)

> **Upgrading from 0.3.x?** On first launch, Agenda removes legacy spaces created before the split into Chat Spaces and Task Spaces (along with Agenda-managed folders for those spaces; user-selected folders are never deleted). Before upgrading, click **Export** in the top-right corner of each 0.3.x space and back up any managed files you want to keep.

---

## Why Agenda?

Most AI coding and writing tools lock you into a single model or a single thread. When you want a second opinion, or want one AI to architect a solution while others implement and review it, you end up copy-pasting prompts and file paths between windows.

Agenda gives your AIs a shared workspace:

- **One folder, multiple AIs** — Mix local CLI tools (using your existing logins and subscriptions), API models, embedded `pi` coding agents, and custom ACP tools in the same space.
- **Two collaboration modes** — Brainstorm and co-edit in a **Chat Space**, then turn decisions into a dependency-tracked execution graph in a **Task Space**.
- **Shared memory, not prompt bloat** — Consensus is distilled into a structured **Space Memory** with message citations (`#N`), paired with rolling recaps and automatic session handoffs when context fills up.
- **Cross-tool relay** — Pull in existing sessions from Claude Code, Codex, Gemini CLI, DeepSeek Harness, WorkBuddy, ZCode, or web exports from ChatGPT and Claude.ai without starting over.
- **Human in the loop** — Four workspace permission levels, interactive command approval cards, inline diff annotations, and isolated Git worktrees keep you in control of every change.

---

## Two Ways to Collaborate

| Mode | Best For | How It Works |
| --- | --- | --- |
| **Chat Space** | Brainstorming, design reviews, co-writing, interactive file edits | Members take turns responding to you and to each other over a shared folder. Use `@member` to route turns, **Ask only** to speak to a single AI, or interrupt, skip, and stop at any time. Spaces with a single member automatically switch to **Solo Chat**—no turn limits, with persistent private long sessions where supported. |
| **Task Space** | Multi-step implementation, refactoring, parallel delivery | Give a **Coordinator** a goal. If anything is ambiguous, it asks up to 3 clarifying questions (with sensible defaults) before planning subtasks, dependencies, and explicit assumptions. Workers execute subtasks—in parallel via isolated `git worktree` checkouts for Git repos, or sequentially for plain folders—and pause for your review before merging. |

### Moving Between Chat and Tasks

1. **From discussion to execution** — Once a Chat Space settles on an approach, select the relevant messages and click **Move to a task space** (either verbatim or distilled into a task spec by a chosen member).
2. **Mid-flight steering** — Send new requirements or questions to the Coordinator while subtasks are running. It automatically decides whether to attach notes to active/upcoming subtasks, pause affected subtasks and revise the plan, or answer directly.
3. **Closing the loop** — When a Task Space finishes, review the final summary, merge approved Git changes with an AI-drafted commit message matched to your repository's style, and optionally post the summary back to the original Chat Space.

---

## Key Features

### 1. Mix Any AI Engine

Add different engines—or multiple instances of the same engine with distinct names, personas, models, and reasoning effort levels—into one space:

| Connection Type | Supported Engines & Models | How It Connects |
| --- | --- | --- |
| **Local CLI Tools** | **Claude Code**, **Codex**, **DeepSeek Harness** (`dsh`), **Gemini CLI** | Uses your existing CLI installation, login, and subscription quota. Auto-detected from your `PATH`, or point to a custom binary. Claude Code can also be routed through third-party Anthropic-compatible providers. |
| **Embedded `pi` Agent** | Any OpenAI-compatible model acting as a full coding agent | Bundled with Agenda—no extra install required. Equips API models with native file read/write, command execution, and skill/MCP mounting (`Pi · <Provider>`). |
| **Custom AI (ACP)** | Any CLI agent speaking **Agent Client Protocol** (stdio JSON-RPC) | Register a name, command, and arguments under **Settings → AI connections → Custom AI (ACP)**. Automatically tests handshake on save and maps tool calls to Agenda's permission cards. |
| **Gemini API** | Google Gemini models | Connect directly with a Gemini API key (and optional custom endpoint). |
| **OpenAI-Compatible API** | DeepSeek, Qwen, Kimi, Zhipu, OpenAI, local **Ollama**, etc. | Configure endpoint URL, model, and API key (key optional for local servers like Ollama). Can also be marked **Also use with Claude Code**. |

### 2. Space Memory & Context Budget

Long multi-AI discussions quickly exhaust context windows or lose track of earlier decisions. Agenda manages context as a first-class system:

- **Structured Space Memory** — Automatically organizes space consensus into **Decisions**, **Constraints**, **Preferences**, **Project Facts**, **Rejected Approaches** (distinguishing user-declined options from per-model/attempt trial-and-error), **Questions / Proposals / Disagreements**, and **Task Results**, complete with reasons, source citations (`#N`), and immediate zero-token message archiving (`messages/<seq>.md`).
- **Layered, Cache-Friendly Injection & Throttled Organization** — Orders prompts to preserve shared prefixes (`imports → L1 → history → L2/extras`), protects mandatory user constraints during budget trimming, and runs tool-less background organization on an idle debounce schedule (or using an optional cheap global API organizer model).
- **Rolling Recaps & Auto-Handoff** — Older chat history rolls into a versioned, user-editable recap. When a persistent session crosses your context threshold (50% by default), Agenda writes a handoff brief during idle time and rotates to a fresh session.
- **Interactive Memory & Context Panels** — Member badges display context usage rings and quota warnings. Open the **Context** panel to inspect the latest estimated prompt breakdown or manually restart a session, and use the **Memory** panel to **Accept / Reject** disagreements and proposals, **Answer** questions, **Edit**, **Retract**, or trigger **Organize now** (with a sidebar dot indicator for items awaiting your decision).

### 3. Role Cards, Teams, Skills & MCP Library

Open **Library** in the left sidebar to manage reusable building blocks across spaces:

- **Role Cards & Teams** — Ships with 7 built-in bilingual role cards and preset teams. Customize instructions, reset defaults anytime, or export/import cards as standalone Markdown files with preview.
- **Skills & MCP Servers** — Scan local skills and MCP configurations already on your machine, install from the built-in **Marketplace**, link skills across engines, and store MCP secrets in isolated storage without polluting global CLI configs.
- **Per-Member Mounting** — Mount specific skills and MCP servers per member for embedded `pi`, Claude Code, and Codex, with automatic permission prompts if a mutating MCP server exceeds the space's current access level.

### 4. Import Conversations & Topic Handoffs

Bring context from outside Agenda into a new or existing space:

- **Direct Local Session Discovery** — Reads local conversation history from **Claude Code**, **Codex**, **DeepSeek Harness**, **Gemini CLI**, **WorkBuddy / CodeBuddy**, and **ZCode** (read-only; never modifies original files).
- **Paste or Upload Exports** — Paste raw chat text or drop export files (`.zip`, `.json`, `.md`, `.txt`) from **ChatGPT**, **Claude.ai**, **Gemini web**, and other tools.
- **Native Claude Code Continuation** — When importing a Claude Code session, Agenda branches from the last imported message so the Claude member retains its prior session state, and lets you incrementally import new messages if you continue chatting in Claude Code.
- **Flexible Context Modes** — Import the **Full transcript**, **Summarize older history**, generate a **Markdown handoff document**, or extract **By topic** (distills a specific keyword/subject into a `Topic-<name>.md` brief inside the shared folder).

See the [Conversation Import Guide](docs/usage.md#导入别处的对话) and [Supported Import Sources](docs/importers.md) (in Chinese) for details.

### 5. File Review, Diff Annotations & Schedules

- **Workspace & Diff Panel** — Browse, edit, and create files in the right sidebar. Inspect per-turn file diffs, revert individual edits (with conflict warnings if modified later), and click or Shift-select diff lines to batch **inline code comments** into `@member` feedback messages.
- **Attachments & Images** — Drag or paste images (`Ctrl+V` / `⌘V`) and files into the message box. Vision-capable engines receive new images directly; regular files are staged into the workspace's `attachments/` folder (and excluded from Git status via `.git/info/exclude`).
- **Scheduled Automations** — Configure one-time, weekly, or fixed-interval schedules per space or globally to spin up task spaces or post prompts into chat spaces. When a schedule is active, closing the window keeps Agenda running in the system tray / menu bar.

---

## Installation

> This README reflects the current source tree (`v0.4.0`). Refer to the [Release Notes](https://github.com/xxxpixel-x/ai-agenda/releases/latest) for features packaged in each prebuilt binary, or run from source to try the latest changes.

### Download Prebuilt Installers

Download the installer for your platform from [**GitHub Releases**](https://github.com/xxxpixel-x/ai-agenda/releases/latest):

| Platform | Package |
| --- | --- |
| **Windows 10 / 11 (x64)** | `Agenda-<version>-win-x64.exe` |
| **macOS (Apple Silicon)** | `Agenda-<version>-mac-arm64.dmg` |
| **macOS (Intel)** | `Agenda-<version>-mac-x64.dmg` |
| **Linux (x64)** | `Agenda-<version>-linux-x86_64.AppImage` or `Agenda-<version>-linux-amd64.deb` |

<details>
<summary><strong>First-launch notes for unsigned installers (Windows / macOS / Linux)</strong></summary>

Installers are currently not code-signed:

- **Windows**: If Microsoft Defender SmartScreen appears, click **More info → Run anyway**.
- **macOS**: Open the `.dmg`, drag **Agenda** to **Applications**, then right-click **Agenda** in Applications and choose **Open**. If macOS says the app is damaged, run `xattr -cr /Applications/Agenda.app` in Terminal and open it again.
- **Linux (AppImage)**: Make the file executable first with `chmod +x Agenda-*.AppImage`.

</details>

### Run from Source

Requires **Node.js 22.19.0 or later** (and **Git** for parallel worktree execution in Task Spaces).

```sh
git clone https://github.com/xxxpixel-x/ai-agenda.git
cd ai-agenda
npm ci
npm start
```

- **Try Demo Mode (no AI accounts or API keys needed)**:
  ```sh
  npm run mock
  ```
- **Windows Launcher**: Double-click `启动.cmd` in the project root (installs dependencies on first run), or run `npm run build:launcher -- -DesktopShortcut` to generate a local `Agenda.exe` launcher and desktop shortcut.

---

## Quick Start

1. **Connect your AIs** — Open **Settings → AI connections** (bottom-left). Local CLI tools are detected automatically if installed and signed in; add API keys or custom ACP agents as needed.
2. **Create a space** — Click **New Space** to create a **Chat Space** or **Task Space**, or start directly from **Import Conversation**. Add members individually or load a preset from **Role Cards / Teams**, then pick an existing project folder (or let Agenda create a managed folder).
3. **Collaborate** — In a Chat Space, send a message or `@mention` specific members. In a Task Space, answer any clarifying questions from the Coordinator, review or edit the generated dependency plan in the **Plan** tab, and start execution.
4. **Inspect & merge** — Use the collapsible right sidebar to switch between **Files**, **Changes**, **Plan** (Task Spaces), **Context**, and **Memory**. Annotate diffs inline, approve or request rework on subtasks, and merge completed Git task branches when ready.

In **Settings → General**, you can switch the UI and AI prompt language between **English**, **Chinese**, or **System default**, toggle light/dark themes, configure background desktop notifications, prevent system sleep while AIs are working, adjust the automatic context handoff threshold, and optionally select a dedicated global memory organizer model.

---

## Permissions, Security & Data

- **Four Permission Tiers**:
  - **Read only** — Inspect files and discuss without modifying the workspace.
  - **Edit files** — Read and modify files inside the shared folder.
  - **Run commands** — The shared folder is the starting directory. Chat engines that support approval can request permission before executing a command. Engines without that support use *Edit files* in chat.
  - **Full access** — Unrestricted file and command access, including paths outside the shared folder.
  - **Embedded Pi** — Its shell runs with your operating-system account and can access files outside the shared folder. At *Run commands*, each shell command and mutating MCP call requires one-time approval; without an interactive approval channel (such as unattended task workers), both are disabled. Protected read-only directories (such as the space memory directory) remain protected against file-tool writes.
- **Credential Protection**:
  - API keys and MCP secrets are stored in your local data directory and encrypted with OS-level encryption (`Electron safeStorage`) whenever available, falling back to plain text if unavailable.
  - Common credential files (such as `.env`, `.npmrc`, `.pypirc`, SSH keys, and `.pem`/`.key` certificates) are automatically excluded from workspace file snapshots sent to direct API models.
- **Local Storage Locations**:
  - **Installed app**: `%APPDATA%\Agenda\data` (Windows), `~/Library/Application Support/Agenda/data` (macOS), `~/.config/Agenda/data` (Linux)
  - **From source**: `./data/` (normal mode) and `./data-mock/` (demo mode)
- **File History & Idle Guard**:
  - Built-in undo history tracks up to 3,000 text files (up to 1 MiB each). Use Git or project backups for binary and large files.
  - Stalled CLI/Pi processes (20 min idle) and stalled API streams (10 min idle) are automatically terminated so tasks do not hang indefinitely (customizable via `RT_IDLE_MINUTES`).

---

## Verification Status

- **Live Provider & Account Verification** — Embedded `pi`, Claude Code with third-party providers, automatic session handoff, long-discussion space memory, per-member skill/MCP mounting, and ACP integration are covered by automated tests using mock engines. End-to-end verification across all live third-party providers and migration of legacy API members to `pi` are ongoing.
- **Cross-Platform Testing** — Recent releases are primarily verified on Windows. macOS and Linux packages are built via GitHub Actions; full live hardware verification (including system tray and notification behavior) is ongoing. [Report an issue](https://github.com/xxxpixel-x/ai-agenda/issues).

---

## Development & Documentation

```sh
npm run verify     # Run JS syntax checks, metadata validation, and the automated test suite
npm run mock       # Launch desktop app with mock AI engines and isolated data-mock/ storage
npm run dist       # Package an installer for the current OS into dist/
node scripts/replay-memory.mjs --space data/spaces/<id>.json --mock  # Replay a space chronologically to evaluate memory organizers
```

Detailed documentation (currently in Chinese):

- [Usage Guide](docs/usage.md)
- [Supported Import Sources & Adding Importers](docs/importers.md)
- [Architecture, Development & Release Guide](docs/development.md)
- [Contributing Guide](CONTRIBUTING.md) (includes English instructions for adding translations)

---

## License & Acknowledgements

Agenda is released under the [MIT License](LICENSE).

- AI provider brand icons are from [LobeHub](public/icons/LICENSE.md).
- The Coordinator / Worker architecture and subtask dependency graph in Task Spaces were inspired by [Orca](https://github.com/stablyai/orca).
- See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for additional credits.
