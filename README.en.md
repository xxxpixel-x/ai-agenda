# Agenda

[中文](README.md) · English

A meeting room for you and several AIs. Claude Code, Codex, Gemini and DeepSeek sit at the same table, discuss, split up the work, and edit the same folder together. Code works, and so do documents, papers and plans.

Started something in another AI and got halfway? Bring that conversation in and keep going. Or pull out just one topic, turn it into a brief, and hand it to a different AI.

**Desktop app · Windows / macOS / Linux · MIT licensed**

> The app's interface is currently in Chinese only.

## How it works

1. **Connect an AI.** Agenda does not ship with an AI of its own. You need at least one: a locally installed and signed-in Claude Code, Codex, DeepSeek Harness or Gemini CLI, or an API key (Gemini, DeepSeek, Qwen, Kimi, Zhipu, OpenAI, local Ollama and so on).
2. **Create a space.** A space is one meeting: the AIs taking part (members), a shared folder they all work in, and the permission level you give them.
3. **Send a message.** You say something, members reply in turn, react to each other and edit files when needed. You can `@` a specific AI, cut in, or stop at any time.
4. **Review the result.** The file panel on the right shows who changed what, with diffs and undo. For bigger jobs, use Tasks: the AIs draw up a plan first and then work on it in parallel.

No AI account? Try demo mode to see the interface and workflow.

## Features

- **Open discussion**: members speak in turn and build on each other. Supports `@` mentions, interrupting, skipping, stopping and a round limit. When everyone has nothing to add, it stops and waits for you.
- **Edit files together**: use a folder the app creates, or an existing project on your computer. Whichever AI changes a file, and however it does it, every change is recorded with its author and can be diffed or undone.
- **Tasks**: plan → you approve → run by dependency → you review → summary. In Git projects each AI works in its own worktree in parallel, then you merge with one click.
- **Import conversations**: automatically lists local sessions from Claude Code, Codex, DeepSeek Harness, Gemini CLI, WorkBuddy / CodeBuddy and ZCode. For other apps such as ChatGPT, Claude.ai or Gemini on the web, paste the conversation or pick an exported file. Imported Claude Code sessions can be resumed in place; long ones are summarized automatically; if the original conversation grows, you can import the new part.
- **Topic handoff**: building a game in Claude Code and only want to hand the script to Gemini? Enter "script" and Agenda picks out just the relevant parts and writes a brief (background / decided / constraints and interfaces / open questions / relevant quotes), saved in the shared folder as `主题-<topic>.md`. Other members read only the brief, not the whole original conversation.
- **Mixed members**: command-line AIs use their own account quota, and API models can edit files too. You can add the same AI more than once with different roles (e.g. "you find the flaws"), models and reasoning levels.
- **Command approval**: when AIs are allowed to run commands, each command shows a card first. You can allow it once, always allow that program, or deny it with a reason.

## Install

### Download

Get the installer for your system from [Releases](https://github.com/xxxpixel-x/ai-agenda/releases/latest):

| System | Download | First launch |
| --- | --- | --- |
| Windows 10 / 11 | `Agenda-<version>-win-x64.exe` | The installer is unsigned. When SmartScreen appears, click "More info" → "Run anyway" |
| macOS (Apple silicon: M1 and later) | `Agenda-<version>-mac-arm64.dmg` | See below |
| macOS (Intel) | `Agenda-<version>-mac-x64.dmg` | See below |
| Linux | `Agenda-<version>-linux-x86_64.AppImage` or `Agenda-<version>-linux-amd64.deb` | Make the AppImage executable first: `chmod +x Agenda-*.AppImage` |

**macOS**: open the dmg and drag Agenda into Applications. Because the app is not signed by Apple, the first time you need to right-click Agenda in Applications and choose "Open". If macOS says the app "is damaged and can't be opened", run this once in Terminal and try again:

```sh
xattr -cr /Applications/Agenda.app
```

The Windows build has been tested. The macOS and Linux installers are built automatically by GitHub Actions and have not yet been fully tested on real machines. Please [open an issue](https://github.com/xxxpixel-x/ai-agenda/issues) if you run into problems.

### Run from source

Requires [Node.js](https://nodejs.org/) **22.12.0 or later**. Parallel Tasks in Git projects also need [Git](https://git-scm.com/).

```sh
git clone https://github.com/xxxpixel-x/ai-agenda.git
cd ai-agenda
npm ci
npm start          # open the app
npm run mock       # or: demo mode, no AI calls
```

On Windows you can also double-click [`启动.cmd`](启动.cmd). The first run installs dependencies and downloads Electron through a mirror in China by default (your own `ELECTRON_MIRROR` is used if set).

To open it with a double-click like a regular app, run `npm run build:launcher -- -DesktopShortcut` to generate `Agenda.exe` and a desktop shortcut (Windows only; it must stay with the project folder).

## Connecting AIs

After opening the app, click "连接与登录" (Connections & sign-in) at the bottom left:

| AI | How it connects | What you need to do |
| --- | --- | --- |
| Claude Code | Local CLI, found automatically | Sign in once as prompted; set the path manually if it is not found |
| Codex | Local CLI, found automatically | Be signed in to Codex |
| DeepSeek Harness | Local install, found automatically | Be signed in to DeepSeek Harness |
| Gemini CLI | Local CLI, shown only if installed | Run `gemini` once in a terminal and sign in with your Google account |
| Gemini API | API | Enter an API key |
| OpenAI-compatible API | API | Enter the endpoint, API key and model; presets for DeepSeek, Qwen, Kimi, Zhipu, OpenAI and Ollama |

Command-line AIs use your account and quota in that tool, no API key needed. Which models you can pick and how much you can use depend on your account and local install.

## Permissions

Each space has one level, changeable any time in Settings:

| Level | What the AIs can do |
| --- | --- |
| Read only | Read the shared folder, no changes |
| Edit files | Change files in the shared folder |
| Run commands | Also run commands in the shared folder, asking you before each one |
| Full access | No limits: read and write anywhere on the computer, run any command |

Permissions are enforced through each AI's own tool restrictions, sandbox or prompts, not OS-level isolation. The first three levels turn off external connections on your accounts (plugins, MCP and so on). See the [usage guide](docs/usage.md#使用) (Chinese) for per-AI details.

## Data and privacy

- Chats and settings are stored on your computer:
  - Installed app: Windows `%APPDATA%\Agenda`, macOS `~/Library/Application Support/Agenda`, Linux `~/.config/Agenda`
  - From source: `data/` in the project (`data-mock/` for demo mode)
- API keys are kept in a local `settings.json`, encrypted when the system supports it and in plain text otherwise. Don't share that file.
- Stored locally does not mean offline: when an AI speaks, the relevant chat and file content is sent to the AI service you configured.

## Known limitations

- Installers are not code-signed; the macOS and Linux builds have not yet been fully tested on real machines.
- Command approval cards only work for Claude Code and Codex in chat. Codex uses its `codex app-server` protocol, which Codex marks as experimental, so a Codex update may require changes here.
- The terminal view in Tasks is an output log, not an interactive terminal.
- File history only tracks text files under 1 MiB, up to 3,000 files; large and binary files can't be undone.
- Automated tests use mock AIs. Sign-in, network and model compatibility of real AIs need to be checked in their own environments.

## Documentation

The detailed docs are in Chinese:

- [Usage guide](docs/usage.md): discussion, files, permissions, importing, Tasks and troubleshooting
- [Development notes](docs/development.md): code layout, engine interface, tests, packaging and releases
- [Contributing](CONTRIBUTING.md): local checks and commit conventions
- [Import sources](docs/importers.md): start here to make Agenda read conversations from another AI app

## Development

```sh
npm run verify     # syntax checks + automated tests; no window, no real AI calls
npm run dist       # build an installer for the current system into dist/
```

Pushing a `v*` tag makes GitHub Actions build installers for all three systems and upload them to the release. See [development notes](docs/development.md#打包与发布).

## License and credits

[MIT License](LICENSE). AI brand icons come from LobeHub; see the [icon notice](public/icons/LICENSE.md) for copyright and license. Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The coordinator / worker and dependency-graph design of Tasks was inspired by [orca](https://github.com/stablyai/orca).
