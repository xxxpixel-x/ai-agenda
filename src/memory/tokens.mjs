// 英文按词，连续汉字按相邻两字切；单独出现的汉字也可以搜。
export function tokenize(text) {
  const words = [];
  for (const [run] of String(text ?? '').toLowerCase().matchAll(/[a-z0-9_]+|\p{Script=Han}+/gu)) {
    if (/^[a-z0-9_]/.test(run)) {
      if (run.length >= 2) words.push(run);
    } else {
      const chars = [...run];
      if (chars.length === 1) words.push(run);
      for (let i = 1; i < chars.length; i++) words.push(chars[i - 1] + chars[i]);
    }
  }
  return words;
}
