# 导入来源：现状与如何新增

Agenda 能把别的 AI 软件里的对话导进空间。每个软件对应 `src/importers/` 下的一个**读取模块**；没有读取模块的软件，用户可以把对话粘贴进来，或者选择导出的文件。

## 现在支持的

| 来源 | 记录位置（Windows / macOS / Linux） | 导入后 | 验证情况 |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects`（或 `$CLAUDE_CONFIG_DIR/projects`） | Claude 成员接着原会话继续 | 真机验证 |
| Codex | `$CODEX_HOME/sessions`，默认 `~/.codex/sessions` | 只导入文字 | 真机验证 |
| DeepSeek Harness | `~/.dsh/sessions` | 只导入文字 | 真机验证 |
| Gemini CLI | `~/.gemini/tmp/<项目>/chats` | 对应 Gemini CLI 成员；没有这个成员类型时只导入文字 | 按公开源码格式写，真机上只有登录记录，没有完整对话 |
| WorkBuddy | `~/.workbuddy/projects` | 只导入文字 | 真机验证 |
| CodeBuddy Code | `~/.codebuddy/projects`（和 WorkBuddy 同一格式） | 只导入文字 | 按格式推断，没有验证 |
| ZCode（桌面版和命令行） | `~/.zcode/cli/db/db.sqlite`，标题在 `~/.zcode/v2/tasks-index.sqlite` | 只导入文字 | 真机验证（本机只有一段只有提问的对话） |
| 粘贴 / 选文件 | —— | 只导入文字 | 见下文 |

`~` 是用户主目录，三个系统都一样。macOS、Linux 上的位置都是按各软件的惯例推断的；如果你在这两个系统上发现读不到，欢迎提 Issue 或 PR。

**读不了的**：Trae / Trae CN 把对话存在加密数据库里（`ModularData/ai-agent/database.db`，SQLCipher），无法读取，只能粘贴。网页版的 Gemini、ChatGPT、豆包、Kimi 等本机没有记录，用粘贴或导出文件。

### 粘贴和选文件

导入对话时点「粘贴或选文件」。整理规则在 `src/importers/parse.mjs`：

- **导出文件**：ChatGPT 导出、Claude.ai 导出（`conversations.json`，或者直接选整个导出的 `.zip`）、Google Takeout 的 Gemini 活动记录（按天分成一段段，没有拿真实导出验证过）、通用的消息数组 JSON / JSONL（`[{ role, content }]`）；
- **文字和 Markdown**：按说话人标记切开，比如 `You said:` / `ChatGPT said:`、`## User` / `## Assistant`、`我：` / `豆包：`。认不出时整段作一条。

某个软件复制出来的文字认不出说话人？在 `parse.mjs` 的 `USER_NAMES` / `AI_NAMES` 里加上它用的名字，再在 `test/importers.test.mjs` 里加一个例子就行。

## 新增一个读取模块

### 1. 接口

在 `src/importers/` 下新建一个模块，导出三样东西：

```js
export const meta = { id: 'myapp', label: 'MyApp', engine: null };
// engine：Agenda 里对应的 AI 类型（src/engines 里的 id），导入时会让这个成员“认领”这段对话；
//         没有对应的写 null，只导入文字。

export function list() {
  // 列出所有对话，要快：几百段时也不能每段都完整解析（可以只读文件头尾，见 common.mjs 的 readEdges）
  return [{ id, title, cwd, updatedAt }]; // cwd：对话所在的项目文件夹，没有就 ''
}

export function read(id) {
  return {
    id, title, cwd,
    entries: [{ key, role: 'user' | 'ai', text, acts: ['读取 a.js', '运行 npm test'], ts }],
    // sourceLabel: 'MyApp CN',  // 可选：同一个模块读几个版本时，覆盖 meta.label
  };
}
```

然后在 `src/importers/index.mjs` 的 `SOURCES` 里加上它。用 `common.mjs` 里的 `EntryBuilder` 整理一问一答最省事，可以照着 `workbuddy.mjs`（JSONL、树状记录）或 `dsh.mjs`（压缩文件）写。

### 2. 规则

- **只读**：不改动、不移动任何记录文件。
- **只导入说的话和操作摘要**：你打的字、AI 的回答，加上「读取 a.js」「修改 b.md」「运行 npm test」「搜索：xxx」这样的短语。不导入工具的原始输出、思考过程，也不导入软件自己塞进消息里的东西（运行环境说明、系统提醒、技能目录、子代理的汇报）。
- **当前这条线**：记录是树状的（编辑消息、重新生成会分叉），只取最后一条所在的那条线。
- **子代理 / 子任务的会话不单独列出**。
- **读不了不崩**：`list()` 读不了的跳过，`read()` 抛出说清楚的中文错误。软件升级后格式可能变，宁可少读也不要读错。

### 3. 兼容三个系统

- 找文件夹用 `common.mjs` 的 `homeDir('.myapp')`（主目录下）或 `appDataDir('MyApp')`（桌面软件的数据目录：Windows `%APPDATA%`、macOS `~/Library/Application Support`、Linux `~/.config`）。
- 路径在函数里**每次现算**，不要在模块顶层存下来，测试要靠改环境变量指到临时文件夹。
- 软件有自己的环境变量（像 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`）时优先用它。
- 拼路径用 `path.join`，不要手写 `\` 或 `/`。
- 读 SQLite 用 `common.mjs` 的 `openSqlite(file)`（Node 自带，不加依赖），用完 `close()`。软件运行时数据库可能被占用，要能失败。
- 只在一个系统上验证过的位置，在文件开头的注释里写明哪些是推断的，并更新上面的表格。

### 4. 测试

测试放在 `test/`，参考 `test/importers.test.mjs`：

- 用 `tempDir(t)` 建临时文件夹，把 `USERPROFILE` / `HOME`（以及 `APPDATA`、`XDG_CONFIG_HOME`，如果用到）指过去，自己写一份**编造的**记录进去；
- 至少覆盖：列出来、标题和项目文件夹对、角色和文字对、操作摘要对、系统附加内容和工具输出被排除、文件夹不存在时 `list()` 返回 `[]`；
- **不要提交真实对话**，哪怕删减过。只照着真实记录的结构编数据。

运行 `npm run verify`。CI 会在 Windows、Ubuntu、macOS 上跑。

### 5. 提 PR 时写清楚

- 这个软件的记录存在哪、什么格式、在哪些系统上验证过；
- 有没有读不到的情况（加密、只存云端、只有部分记录）。
