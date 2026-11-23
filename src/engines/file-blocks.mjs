import { t as tr } from '../i18n.mjs';

// API 型 AI 没有文件工具：把共享文件内容放进提示词，让它在回复里用约定格式给出改动，由本软件写入。

export const fileBlockRules = () => tr('files.rules');

const BLOCK_RE = /^<<<\s*(?:文件|File)\s*[:：]\s*(.+?)\s*\r?\n([\s\S]*?)\r?\n>>>[ \t]*$/gim;

/** 从回复中拆出文件块。返回 { text: 去掉文件块后的正文, files: [{ path, content }] } */
export function extractFileBlocks(reply) {
  const files = [];
  const text = String(reply || '').replace(BLOCK_RE, (_, p, content) => {
    files.push({ path: p.trim().replace(/^["'`]|["'`]$/g, ''), content: content.endsWith('\n') ? content : `${content}\n` });
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { text, files };
}

/** 生成放进提示词里的“共享文件现状”。 */
export function filesForPrompt(snapshot, { maxTotal = 60000, maxEach = 20000 } = {}) {
  if (!snapshot.length) return tr('## 共享文件夹\n（目前是空的）');
  let used = 0;
  const parts = [tr('## 共享文件夹里的文件（最新内容）')];
  const skipped = [];
  const sensitive = [];
  for (const f of snapshot) {
    if (f.sensitive === true) {
      sensitive.push(f.path);
      continue;
    }
    if (f.content == null || f.content.length > maxEach || used + f.content.length > maxTotal) {
      skipped.push(f.path);
      continue;
    }
    used += f.content.length;
    parts.push(`### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``);
  }
  if (skipped.length) parts.push(tr('（以下文件太大或太多，没有附上内容：{0}{1}）', [skipped.slice(0, 50).join(tr('、')), skipped.length > 50 ? tr(' 等') : '']));
  if (sensitive.length) parts.push(tr('（以下文件可能含密钥，没有附上内容：{0}{1}）', [sensitive.slice(0, 50).join(tr('、')), sensitive.length > 50 ? tr(' 等') : '']));
  return parts.join('\n\n');
}
