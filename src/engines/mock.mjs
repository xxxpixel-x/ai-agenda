// 演示引擎：不调用任何 AI，按固定节奏吐出模拟发言，用于检查界面（npm run mock）。
// 会真的往工作目录写文件，用来演示“改动记录 / 撤销 / 任务协作的副本与合并”。
import fs from 'node:fs';
import path from 'node:path';
import { AbortedError } from './proc.mjs';

export const meta = {
  id: 'mock',
  label: '演示 AI',
  vendor: '演示',
  defaultName: '演示',
  color: '#64748b',
  models: [['', '默认']],
  efforts: [['', '默认']],
  capabilities: '模拟发言与改文件',
};

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new AbortedError()); }, { once: true });
});

export async function detect() {
  return { available: true, ready: true, note: '演示模式，不调用任何 AI' };
}

async function stream(text, onDelta, signal) {
  for (let i = 0; i < text.length; i += 6) {
    await sleep(15, signal);
    onDelta?.(text.slice(i, i + 6));
  }
  return { text };
}

export async function runTurn({ system, prompt, cwd, access, signal, onDelta, onActivity, onRaw }) {
  const me = (system.match(/你是「([^」]+)」/) || [])[1] || '演示';
  const members = [...system.matchAll(/^- @([^（\s]+)/gm)].map((m) => m[1]);
  onRaw?.(`{"type":"mock.start","me":"${me}"}`);
  await sleep(400, signal);

  // ---- 任务协作：规划 / 审阅 / 子任务 / 总结 ----
  if (system.includes('这次任务协作的协调者')) {
    const all = [me, ...members.filter((n) => n !== me)];
    const tasks = [
      { id: 'T1', title: '写需求要点', assignee: all[0], deps: [], spec: '在 需求.md 里写下 3 条核心需求。' },
      { id: 'T2', title: '写实现思路', assignee: all[1] || all[0], deps: [], spec: '在 实现.md 里写下实现思路。' },
      { id: 'T3', title: '汇总成方案', assignee: all[2] || all[0], deps: ['T1', 'T2'], spec: '读 需求.md 和 实现.md，写 方案.md。' },
    ];
    return stream(`我把目标拆成三步，前两步可以同时做。\n\n\`\`\`json\n${JSON.stringify({ tasks }, null, 1)}\n\`\`\``, onDelta, signal);
  }
  if (system.includes('请你审阅计划')) return stream('[同意]', onDelta, signal);
  // ---- 整理导入的对话 ----
  if (prompt.includes('Markdown 交接文档')) return stream('## 讨论到哪\n（演示）讨论到了导入功能。\n\n## 已经定下的\n- 演示内容\n\n## 还没解决的\n- 无\n\n## 下一步\n- 继续讨论\n\n## 涉及的文件\n- 无', onDelta, signal);
  if (prompt.includes('把这段对话写成摘要')) return stream('（演示）较早的部分讨论了导入功能的需求，定下了按篇幅自动选择导入方式。', onDelta, signal);
  if (system.includes('写一份简洁的总结')) return stream('### 完成了什么\n三个子任务都已完成（演示）。\n\n### 需要你注意的地方\n这是演示模式的模拟结果。', onDelta, signal);
  const sub = system.match(/做被分派给你的子任务 ([A-Za-z0-9-]+)/);
  if (sub) {
    const id = sub[1];
    // 解决合并冲突：保留双方内容，去掉冲突标记
    if (prompt.includes('# 合并冲突')) {
      const files = [...prompt.matchAll(/^- (.+)$/gm)].map((m) => m[1]).filter((f) => fs.existsSync(path.join(cwd, f)));
      for (const f of files) {
        const p = path.join(cwd, f);
        fs.writeFileSync(p, fs.readFileSync(p, 'utf8').split('\n').filter((l) => !/^(<<<<<<<|=======|>>>>>>>)/.test(l)).join('\n'));
        onActivity?.({ kind: 'edit', label: `解决冲突 ${f}` });
      }
      return stream(`我解决了 ${files.join('、')} 里的冲突，保留了双方的内容。\n结果：完成`, onDelta, signal);
    }
    const forced = prompt.match(/写入文件 (\S+)/);
    const file = forced ? forced[1] : ({ T1: '需求.md', T2: '实现.md', T3: '方案.md' }[id] || `${id}.md`);
    if (prompt.includes('需要确认') && !prompt.includes('# 用户的回答')) {
      return stream('我需要先知道周报是给谁看的。\n结果：需要确认：周报的读者是老板还是团队成员？', onDelta, signal);
    }
    const feedback = prompt.includes('# 用户的意见') ? '（已按意见修改）' : '';
    onActivity?.({ kind: 'edit', label: `修改 ${file}` });
    onRaw?.(`{"type":"mock.write","file":"${file}"}`);
    fs.writeFileSync(path.join(cwd, file), `# ${file.replace('.md', '')}\n\n- ${me} 写的内容${feedback}\n`);
    await sleep(800, signal);
    return stream(`我在 ${file} 里写好了内容${feedback}。没有发现问题。没有剩下的事。\n结果：完成`, onDelta, signal);
  }

  // ---- 自由群聊 ----
  const lines = prompt.split('\n').filter((l) => l.startsWith('【'));
  const last = lines[lines.length - 1] || '';
  const lastSpeaker = last.slice(1, last.indexOf('】'));
  const myTurns = lines.filter((l) => l.startsWith(`【${me}】`)).length;
  if (myTurns >= 2) return { text: '[跳过]' };
  let text = lastSpeaker === '我' || !lastSpeaker
    ? `收到。我是**${me}**，先说说我的看法：这个问题可以拆成两步——先明确目标，再挑最小的可行方案验证。`
    : `同意 **${lastSpeaker}** 的思路。我补充一点：把结论记到共享文档里，方便之后回看。`;
  if (access !== 'read' && myTurns === 0) {
    onActivity?.({ kind: 'edit', label: '修改 共享文档.md' });
    const f = path.join(cwd, '共享文档.md');
    const old = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '# 共享文档\n';
    fs.writeFileSync(f, `${old.replace(/\n*$/, '\n')}- ${me}：先明确目标，再做最小验证。\n`);
    text += '\n\n（我在 `共享文档.md` 里记了一条。）';
  }
  if (myTurns === 1) text += ' [结束]';
  return stream(text, onDelta, signal);
}
