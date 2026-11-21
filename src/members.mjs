// 空间成员：校验、补全成员列表，起不重名的名字。空间和导入共用。
import { t as tr } from './i18n.mjs';
import { randomUUID } from 'node:crypto';

const MAX_MEMBERS = 8;
const MODEL_RE = /^[a-z0-9._:\-/[\]]{0,100}$/i;
const EFFORTS = ['', 'none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * 模型来源（meta.sources 的引擎才有）：engine.sourceChoices 里的某个接口 { id, name }。
 * 不填是这个 AI 自己的账号；sourceRequired 的引擎没有自己的账号，不填就用第一个接口。
 */
function sourceOf(m, engine, name) {
  if (!engine.sources) return null;
  const choices = engine.sourceChoices || [];
  const id = str(m.source, 40);
  if (id) {
    const found = choices.find((c) => c.id === id);
    if (!found) throw new Error(tr('成员「{0}」的模型来源已经不能用了，换一个', [name]));
    return found;
  }
  if (!engine.sourceRequired) return null;
  if (!choices.length) throw new Error(tr('成员「{0}」需要一个模型来源，先在「AI 连接」里添加 API 接口', [name]));
  return choices[0];
}

/** engines：注册表 list() 的结果。成员不合法时抛出给用户看的错误。 */
export function normalizeMembers(input, engines) {
  const byId = new Map(engines.map((e) => [e.id, e]));
  const names = new Set();
  const list = (Array.isArray(input) ? input : []).slice(0, MAX_MEMBERS).map((m, i) => {
    const engine = byId.get(m?.engine);
    if (!engine) throw new Error(tr('第 {0} 个成员的 AI 类型无效', [i + 1]));
    const name = str(m.name, 20).replace(/[@\s]/g, '') || engine.defaultName;
    if (/^(me|我)$/i.test(name)) throw new Error(tr('成员不能叫「我」'));
    if (names.has(name)) throw new Error(tr('成员名「{0}」重复了，给它们起不同的名字', [name]));
    names.add(name);
    const model = str(m.model, 100);
    if (!MODEL_RE.test(model)) throw new Error(tr('成员「{0}」的模型名不合法', [name]));
    const source = sourceOf(m, engine, name);
    return {
      id: typeof m.id === 'string' && /^[a-z0-9-]{4,40}$/i.test(m.id) ? m.id : randomUUID().slice(0, 8),
      name,
      engine: engine.id,
      engineLabel: source ? `${engine.label} · ${source.name}` : engine.label,
      ...(source ? { source: source.id } : {}),
      model,
      effort: EFFORTS.includes(m.effort) ? m.effort : '',
      persona: str(m.persona, 2000),
      color: /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : engine.color,
    };
  });
  if (!list.length) throw new Error(tr('至少需要一个 AI 成员'));
  return list;
}

export const membersFull = (members) => members.length >= MAX_MEMBERS;

/** base 被占用时依次试 base2、base3…… */
export function uniqueName(members, base) {
  let name = base;
  for (let k = 2; members.some((m) => m.name === name); k++) name = `${base}${k}`;
  return name;
}
