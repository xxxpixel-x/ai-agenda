// 挂载点：设置分类、资源库分类、空间设置标签、右侧栏面板都在这里注册。
// 加一个功能就加一个文件调用 register，不用改布局。不依赖其他模块。
//
// register(slot, { id, label, icon, order, when?(ctx), render(el, ctx), dispose?() })
// list(slot, ctx) → 按 order 排好、when 通过的定义
// onSlotsChange(fn) → 有注册变化时回调（侧栏据此决定显不显示入口）

const SLOTS = ['settings', 'library', 'spaceTabs', 'panels'];
const registry = new Map(SLOTS.map((s) => [s, []]));
const listeners = new Set();

export function register(slot, def) {
  const list = registry.get(slot);
  if (!list) throw new Error(`Unknown slot: ${slot}`);
  if (!def?.id || typeof def.render !== 'function') throw new Error(`Slot ${slot}: id and render() are required`);
  const i = list.findIndex((d) => d.id === def.id);
  const entry = { order: 100, ...def };
  if (i >= 0) list[i] = entry; else list.push(entry);
  list.sort((a, b) => a.order - b.order);
  for (const fn of listeners) fn(slot);
}

export function list(slot, ctx) {
  return (registry.get(slot) || []).filter((d) => {
    try { return !d.when || d.when(ctx); } catch { return false; }
  });
}

export function onSlotsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
