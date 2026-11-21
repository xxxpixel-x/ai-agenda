import { t as tr } from './i18n.mjs';

const invalid = () => new Error(tr('无法读取角色卡或团队 Markdown'));
const header = (fields) => '---\n' + Object.entries(fields).map(([key, value]) =>
  key + ': ' + (key === 'agenda_export' ? value : JSON.stringify(value))).join('\n') + '\n---\n';

function readHeader(text) {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!match) throw invalid();
  const fields = Object.create(null);
  for (const line of match[1].split('\n')) {
    const item = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!item) continue;
    try { fields[item[1]] = JSON.parse(item[2]); } catch { fields[item[1]] = item[2]; }
  }
  return { fields, body: text.slice(match[0].length) };
}

function roleFields(r) {
  return { id: r.id, name: r.name, summary: r.summary, suggested_engine: r.suggestedEngine,
    recommended_skills: r.recommendedSkills, recommended_mcp: r.recommendedMcp };
}
function roleInput(f, instructions) {
  return { id: f.id, name: f.name, summary: f.summary, suggestedEngine: f.suggested_engine,
    recommendedSkills: f.recommended_skills, recommendedMcp: f.recommended_mcp, instructions };
}

export const roleMarkdown = (r) => header({ agenda_export: 'role', version: 1, ...roleFields(r) }) + '\n' + r.instructions + '\n';

export function teamMarkdown(team, roles) {
  const fields = { agenda_export: 'team', version: 1, id: team.id, name: team.name, summary: team.summary,
    coordinator_index: team.coordinatorIndex, members: roles.map(r => r.id) };
  return header(fields) + roles.map(r => '\n## Role: ' + r.name.replace(/[\r\n]/g, ' ') + '\n\n'
    + header({ ...roleFields(r), instruction_lines: r.instructions.split('\n').length }) + r.instructions + '\n').join('');
}

export function parseMarkdown(markdown) {
  if (typeof markdown !== 'string' || markdown.length > 256_000) throw invalid();
  let { fields: f, body } = readHeader(markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));
  if (f.version !== 1) throw invalid();
  if (f.agenda_export === 'role') return { kind: 'role', roles: [roleInput(f, body.trim())] };
  if (f.agenda_export !== 'team' || !Array.isArray(f.members) || !f.members.length || f.members.length > 8) throw invalid();
  const roles = [];
  for (const id of f.members) {
    const heading = /^\s*## Role: [^\n]+\n\n/.exec(body);
    if (!heading) throw invalid();
    const section = readHeader(body.slice(heading[0].length));
    const count = section.fields.instruction_lines;
    if (id !== section.fields.id || !Number.isInteger(count) || count < 1) throw invalid();
    const lines = section.body.split('\n');
    if (count > lines.length) throw invalid();
    roles.push(roleInput(section.fields, lines.slice(0, count).join('\n')));
    body = lines.slice(count).join('\n');
  }
  if (body.trim()) throw invalid();
  return { kind: 'team', team: { id: f.id, name: f.name, summary: f.summary, roleIds: f.members, coordinatorIndex: f.coordinator_index }, roles };
}
