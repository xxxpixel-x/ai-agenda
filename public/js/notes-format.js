// 批注里的行号一律沿用 diff 左侧显示的那一侧。
export const lineNumber = (row) => row.nb ?? row.na;
const prefix = { add: '+', del: '-', same: ' ' };
export const quoteLine = (row) => prefix[row.type] + row.t;

export function lineLabel({ start, end }, tr) {
  return start === end ? tr('第 {0} 行', [start]) : tr('第 {0}–{1} 行', [start, end]);
}

export function notesByMember(notes) {
  const groups = new Map();
  for (const note of notes) {
    if (!groups.has(note.to)) groups.set(note.to, []);
    groups.get(note.to).push(note);
  }
  return groups;
}

export function formatNotes(notes, tr, name) {
  const sorted = [...notes].sort((a, b) => a.path.localeCompare(b.path) || a.from.start - b.from.start);
  const blocks = sorted.map(({ path, from, quote, text }) => {
    let size = 3;
    for (const run of quote.matchAll(/`+/g)) size = Math.max(size, run[0].length + 1);
    const fence = '`'.repeat(size);
    const heading = tr('{0} {1}：', [`\`${path}\``, lineLabel(from, tr)]);
    return `${heading}\n${fence}diff\n${quote}\n${fence}\n${text}`;
  });
  return (name ? `@${name}\n` : '') + blocks.join('\n\n');
}

// 增删行的行号可能重叠。先按符号和行号定位，再核对原文，避免把旧批注贴到新改动上。
export function locateNotes(lines, notes) {
  const marked = new Set();
  const ending = new Map();
  if (notes.length) {
    const starts = new Map();
    lines.forEach((row, i) => starts.set(prefix[row.type] + lineNumber(row), i));
    for (const note of notes) {
      const first = starts.get(note.quote[0] + note.from.start);
      if (first === undefined) continue;
      const quote = note.quote.split('\n');
      const last = first + quote.length - 1;
      if (!lines[last] || lineNumber(lines[last]) !== note.from.end || !quote.every((s, i) => s === quoteLine(lines[first + i]))) continue;
      for (let i = first; i <= last; i++) marked.add(i);
      if (!ending.has(last)) ending.set(last, []);
      ending.get(last).push(note);
    }
  }
  return { marked, ending };
}
