// API 型 AI 没有文件工具：把共享文件内容放进提示词，让它在回复里用约定格式给出改动，由本软件写入。

export const FILE_BLOCK_RULES = `## 修改共享文件的方法
你不能直接操作文件，但可以在回复末尾附上文件块，软件会替你写入（每个文件一个块，块里必须是该文件改完后的【完整内容】）：

<<<文件: 相对路径.md
文件的完整新内容……
>>>

- 只在确实需要修改时才附文件块；聊天正文里用一句话说明你改了什么。
- 新建文件同样用文件块。不支持删除文件。`;

const BLOCK_RE = /^<<<\s*文件\s*[:：]\s*(.+?)\s*\r?\n([\s\S]*?)\r?\n>>>[ \t]*$/gm;

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
  if (!snapshot.length) return '## 共享文件夹\n（目前是空的）';
  let used = 0;
  const parts = ['## 共享文件夹里的文件（最新内容）'];
  const skipped = [];
  for (const f of snapshot) {
    if (f.content == null || f.content.length > maxEach || used + f.content.length > maxTotal) {
      skipped.push(f.path);
      continue;
    }
    used += f.content.length;
    parts.push(`### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``);
  }
  if (skipped.length) parts.push(`（以下文件太大或太多，没有附上内容：${skipped.slice(0, 50).join('、')}${skipped.length > 50 ? ' 等' : ''}）`);
  return parts.join('\n\n');
}
