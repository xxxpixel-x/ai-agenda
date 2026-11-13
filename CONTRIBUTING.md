# 贡献指南

欢迎提交问题反馈、功能建议和 Pull Request。新功能可以先用 Issue 说明使用场景和预期行为。

## 本地开发

1. 安装 Node.js 22.12.0 或以上，以及 Git。
2. 克隆仓库，执行 `npm ci`。
3. 用 `npm run mock` 体验不需要账号的演示模式，或用 `npm start` 接入本机 AI。
4. 修改后执行 `npm run verify`；涉及界面时，手动检查相应操作。

模块分工和测试范围见 [开发说明](docs/development.md)。想让 Agenda 能导入某个 AI 软件的对话，见 [导入来源与新增方法](docs/importers.md)。

## 改动约定

- 使用 ES modules（`.mjs`）；Electron 入口与 preload 保持 CommonJS（`.cjs`）。
- 沿用现有风格：两个空格缩进、单引号、分号；按 `.editorconfig` 保存。
- 只在新增行为或修复回归时补充有意义的测试；普通文案无需专门测试。
- 新增依赖时同时更新 `package.json` 和 `package-lock.json`，说明引入原因。
- 用户可见行为变化时，同步更新 README 或使用指南。
- 一个 PR 聚焦一个问题，说明改前、改后和验证结果。真实 AI 没有实测时请明确写出。

## 反馈与数据

Issue 中附上复现步骤、Windows / Node.js / CLI 版本、脱敏报错。不要提交 `data/`、`data-mock/`、API key、真实会话或原始调试日志；测试样例应自行构造。

提交的贡献按本项目 [MIT License](LICENSE) 发布。第三方代码或素材需要保留来源与原许可。
