import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getLanguage, t as tr } from './i18n.mjs';
import { BUILTIN_ROLES, BUILTIN_TEAMS, CURATED_MARKETPLACE } from './library-data.mjs';
import { atomicWrite, readJsonFile, safeId, webUrl } from './library-store.mjs';
import { parseMarkdown, roleMarkdown, teamMarkdown } from './role-markdown.mjs';
import { MAX_PERSONA } from './members.mjs';

const builtinRoles = new Map(BUILTIN_ROLES.map(r => [r.id, r]));
const builtinTeams = new Map(BUILTIN_TEAMS.map(r => [r.id, r]));
const loc = (v, lang = getLanguage()) => typeof v === 'string' ? v : v?.[lang === 'zh' ? 'zh' : 'en'] || '';
const fail = () => { throw new Error(tr('角色卡或团队的内容无效')); };
function string(v, max, required = false) {
  if (typeof v !== 'string' || v.length > max || (required && !v.trim())) fail();
  return v.trim();
}
function localized(v, max, required = false) {
  return typeof v === 'string' ? string(v, max, required) : {
    zh: string(v?.zh, max, required), en: string(v?.en, max, required),
  };
}
function resourceId(v) {
  const id = safeId(v);
  if (/\.(en|zh|custom)$/.test(id)) fail();
  return id;
}
function engineId(v) {
  if (typeof v !== 'string' || !/^(?:[a-z0-9._-]+|openai:[a-z0-9_-]+)$/i.test(v) || v.length > 80) fail();
  return v;
}
function recommendations(items, kind) {
  if (!Array.isArray(items) || items.length > 20) fail();
  const values = new Map();
  for (const item of items) {
    const id = safeId(typeof item === 'string' ? item : item?.id);
    const known = CURATED_MARKETPLACE[kind].find(v => v.id === id);
    const name = string(item.name ?? known?.name ?? id, 100, true);
    const original = string(item.source ?? known?.sourceUrl ?? '', 2000);
    const link = webUrl(original);
    const url = link && new URL(link);
    if (url) for (const key of [...url.searchParams.keys()]) if (/key|token|secret|pass|auth|signature/i.test(key)) url.searchParams.delete(key);
    const source = url ? url.href : /^[\w.-]+(?:\/[\w.-]+)*$/.test(original) ? original : '';
    const ref = { id, name, source };
    if (kind === 'mcp') {
      ref.mode = item.mode ?? known?.mode ?? 'mutating';
      if (!['readonly','mutating'].includes(ref.mode)) fail();
    }
    values.set(id, ref);
  }
  return [...values.values()];
}
function roleFields(v) {
  return { name: localized(v.name, 100, true), summary: localized(v.summary ?? '', 1000),
    suggestedEngine: engineId(v.suggestedEngine ?? v.engine ?? 'claude-code'),
    recommendedSkills: recommendations(v.recommendedSkills ?? v.skills ?? [], 'skills'),
    recommendedMcp: recommendations(v.recommendedMcp ?? v.mcp ?? [], 'mcp') };
}
function freshId(base, exists) {
  let id = base;
  for (let i = 2; exists(id); i++) id = base.slice(0, 56) + '-' + i;
  return id;
}
function newId(v, exists) {
  if (v.id != null) {
    const id = resourceId(v.id);
    if (exists(id)) throw new Error(tr('这个资源标识已存在'));
    return id;
  }
  const slug = loc(v.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 56);
  return freshId(resourceId(slug || 'card-' + randomUUID().slice(0, 8)), exists);
}
function coordinator(v, members) {
  const n = v.coordinatorIndex ?? Math.max(0, members.findIndex(m => m.roleId === v.coordinatorRoleId));
  if (!Number.isInteger(n) || n < 0 || n >= members.length) fail();
  return n;
}

export function createRoleLibrary(dataDir) {
  const dir = path.join(dataDir, 'roles');
  const file = (id, suffix) => path.join(dir, resourceId(id) + suffix + '.md');
  const indexPath = path.join(dir, 'index.json'), teamsPath = path.join(dataDir, 'teams.json');
  let index = readJsonFile(indexPath, { overrides: {}, custom: {}, defaults: {} });
  let teams = readJsonFile(teamsPath, { overrides: {}, custom: {} });
  let journal = null;
  function write(target, content) {
    const previous = journal && !journal.has(target) && fs.existsSync(target) ? fs.readFileSync(target,'utf8') : null;
    if (content === null) fs.rmSync(target, { force:true });
    else atomicWrite(target,content);
    if (journal && !journal.has(target)) journal.set(target,previous);
  }
  function transaction(operation) {
    return (...args) => {
      const oldIndex = structuredClone(index), oldTeams = structuredClone(teams);
      journal = new Map();
      try { return operation(...args); }
      catch (error) {
        index = oldIndex; teams = oldTeams;
        for (const [target, previous] of [...journal].reverse()) {
          if (previous === null) fs.rmSync(target,{force:true});
          else atomicWrite(target,previous);
        }
        throw error;
      } finally { journal = null; }
    };
  }
  const save = () => write(indexPath, index);
  const saveTeams = () => write(teamsPath, teams);
  for (const r of BUILTIN_ROLES) for (const lang of ['zh','en']) atomicWrite(file(r.id, '.' + lang), r.instructions[lang]);
  if (!fs.existsSync(indexPath)) save();
  if (!fs.existsSync(teamsPath)) saveTeams();
  const hasRole = id => builtinRoles.has(id) || Object.hasOwn(index.custom, id);
  const hasTeam = id => builtinTeams.has(id) || Object.hasOwn(teams.custom, id);
  const requireRole = id => { if (resourceId(id) !== id || !hasRole(id)) fail(); };
  const roleMeta = id => ({ ...(builtinRoles.get(id) || index.custom[id]), ...index.overrides[id] });
  function getRoleInstructions(id, lang = getLanguage()) {
    if (!hasRole(id)) return null;
    const r = roleMeta(id);
    const suffix = r.hasCustomInstructions ? '.custom' : builtinRoles.has(id) || r.bilingual ? (lang === 'zh' ? '.zh' : '.en') : '';
    return fs.readFileSync(file(id, suffix), 'utf8');
  }
  function getRole(id, lang = getLanguage()) {
    if (!hasRole(id)) return null;
    const r = roleMeta(id);
    return { ...roleFields(r), id, name: loc(r.name, lang), summary: loc(r.summary, lang),
      builtin: builtinRoles.has(id), customized: !!index.overrides[id], myDefault: index.defaults[id] || null,
      instructions: getRoleInstructions(id, lang) };
  }
  function writeInstructions(id, v, builtin) {
    if (builtin || typeof v === 'string') {
      write(file(id, builtin ? '.custom' : ''), string(v, MAX_PERSONA));
      return false;
    }
    const pair = localized(v, MAX_PERSONA);
    for (const lang of ['zh','en']) write(file(id, '.' + lang), pair[lang]);
    return true;
  }
  function createRole(v) {
    const id = newId(v, hasRole), meta = roleFields(v);
    const bilingual = writeInstructions(id, v.instructions ?? v.persona ?? '', false);
    index.custom[id] = { id, ...meta, bilingual, createdAt: Date.now(), updatedAt: Date.now() };
    save();
    return getRole(id);
  }
  function updateRole(id, patch) {
    requireRole(id);
    const builtin = builtinRoles.has(id), old = roleMeta(id);
    const changes = roleFields({ ...old, ...patch });
    const record = builtin ? { ...index.overrides[id] } : { ...index.custom[id] };
    for (const k of Object.keys(changes)) if (k in patch) record[k] = changes[k];
    if ('instructions' in patch && (typeof patch.instructions !== 'string' || patch.instructions !== getRoleInstructions(id))) {
      const bilingual = writeInstructions(id, patch.instructions, builtin);
      if (builtin) record.hasCustomInstructions = true;
      else record.bilingual = bilingual;
    }
    (builtin ? index.overrides : index.custom)[id] = { ...record, updatedAt: Date.now() };
    save();
    return getRole(id);
  }
  function resetRole(id) {
    if (!builtinRoles.has(id)) throw new Error(tr('只能恢复内置资源'));
    delete index.overrides[id]; save();
    write(file(id, '.custom'), null);
    return getRole(id);
  }
  function deleteRole(id) {
    requireRole(id);
    if (builtinRoles.has(id)) throw new Error(tr('不能删除内置资源'));
    // Keep saved teams usable after a referenced custom card is deleted.
    for (const team of listTeams()) {
      if (!team.members.some(m => m.roleId === id)) continue;
      const stored = teams.overrides[team.id] || teams.custom[team.id];
      const members = stored.members.map((m,i) => {
        if (m.roleId !== id) return m;
        const { roleId, roleCustomized, reference, ...draft } = team.members[i];
        return draft;
      });
      updateTeam(team.id, { members });
    }
    delete index.custom[id]; delete index.defaults[id]; save();
    for (const suffix of ['', '.en', '.zh']) write(file(id, suffix), null);
    return { ok: true };
  }
  function setRoleDefault(id, pref) {
    requireRole(id);
    if (!pref?.engine) delete index.defaults[id];
    else index.defaults[id] = { engine: engineId(pref.engine), source: string(pref.source ?? '', 80),
      model: string(pref.model ?? '', 100), effort: string(pref.effort ?? '', 20) };
    save(); return getRole(id);
  }
  function resolveRoleToMember(id, engines, { lang, existingNames = [], installedSkillIds = null, installedMcpIds = null } = {}) {
    requireRole(id);
    const r = getRole(id, lang), pref = r.myDefault;
    const ready = e => (e.status || e).ready ?? (e.status || e).available;
    const chosen = engines.find(e => e.id === pref?.engine);
    const suggested = engines.find(e => e.id === r.suggestedEngine && (ready(e) || (e.status || e).available));
    const e = chosen || suggested || engines.find(ready) || engines[0];
    if (!e) fail();
    const base = r.name.replace(/@/g, '').slice(0, 20);
    const used = new Set(existingNames.map(n => n.replace(/[@\s]/g, '')));
    let name = base;
    for (let i = 2; used.has(name.replace(/\s/g,'')); i++) name = base.slice(0, 20 - String(i).length) + i;
    const ids = (refs, installed) => refs.map(v => v.id).filter(id => installed == null || new Set(installed).has(id));
    return { engine: e.id, name, source: chosen ? pref.source : '', model: chosen ? pref.model : '', effort: chosen ? pref.effort : '',
      persona: r.instructions, roleId: id, roleCustomized: false, skills: ids(r.recommendedSkills, installedSkillIds), mcp: ids(r.recommendedMcp, installedMcpIds) };
  }

  function snapshot(m) {
    if (m.roleId && Object.keys(m).length === 1) { requireRole(m.roleId); return { roleId: m.roleId }; }
    const r = roleFields(m);
    return { name: r.name, engine: r.suggestedEngine, persona: string(m.persona ?? '', MAX_PERSONA),
      model: string(m.model ?? '', 100), effort: string(m.effort ?? '', 20), source: string(m.source ?? '', 80),
      ...(hasRole(m.roleId) ? { roleId: m.roleId, roleCustomized: !!m.roleCustomized } : {}),
      skills: r.recommendedSkills.map(x => x.id), mcp: r.recommendedMcp.map(x => x.id) };
  }
  function teamFields(v) {
    const rows = v.members ?? v.roleIds?.map(roleId => ({ roleId }));
    if (!Array.isArray(rows) || !rows.length || rows.length > 8) fail();
    const members = rows.map(snapshot), coordinatorIndex = coordinator(v, members);
    return { name: localized(v.name, 100, true), summary: localized(v.summary ?? '', 1000), members,
      roleIds: members.map(m => m.roleId).filter(Boolean), coordinatorIndex, coordinatorRoleId: members[coordinatorIndex].roleId || null };
  }
  function getTeam(id, lang = getLanguage()) {
    if (!hasTeam(id)) return null;
    const team = teamFields(teams.overrides[id] || builtinTeams.get(id) || teams.custom[id]);
    const members = team.members.map(m => {
      if (m.engine) return { ...m, name: loc(m.name, lang), ...m.roleId && !m.roleCustomized && { persona: getRoleInstructions(m.roleId, lang) } };
      const r = getRole(m.roleId, lang);
      return { ...m, reference: true, name: r.name, persona: r.instructions, engine: r.suggestedEngine,
        skills: r.recommendedSkills.map(x => x.id), mcp: r.recommendedMcp.map(x => x.id) };
    });
    return { ...team, id, name: loc(team.name, lang), summary: loc(team.summary, lang), builtin: builtinTeams.has(id), customized: !!teams.overrides[id], members };
  }
  function listTeams(lang) { return [...builtinTeams.keys(), ...Object.keys(teams.custom)].map(id => getTeam(id, lang)); }
  function createTeam(v) {
    const id = newId(v, hasTeam);
    teams.custom[id] = teamFields(v); saveTeams(); return getTeam(id);
  }
  function updateTeam(id, patch) {
    if (!hasTeam(id)) fail();
    const v = { ...(teams.overrides[id] || teams.custom[id] || builtinTeams.get(id)), ...patch };
    if ('roleIds' in patch && !('members' in patch)) delete v.members;
    if ('coordinatorRoleId' in patch && !('coordinatorIndex' in patch)) delete v.coordinatorIndex;
    (builtinTeams.has(id) ? teams.overrides : teams.custom)[id] = teamFields(v);
    saveTeams(); return getTeam(id);
  }
  function resetTeam(id) {
    if (!builtinTeams.has(id)) throw new Error(tr('只能恢复内置资源'));
    delete teams.overrides[id]; saveTeams(); return getTeam(id);
  }
  function deleteTeam(id) {
    if (!hasTeam(id)) fail();
    if (builtinTeams.has(id)) throw new Error(tr('不能删除内置资源'));
    delete teams.custom[id]; saveTeams(); return { ok: true };
  }
  function exportTeamMarkdown(id, lang) {
    const team = getTeam(id, lang);
    if (!team) fail();
    const used = new Set();
    return teamMarkdown(team, team.members.map((m,i) => {
      const card = m.reference ? getRole(m.roleId, lang) : { ...roleFields(m), instructions: m.persona };
      const id = freshId(m.roleId || 'member-' + (i + 1), id => used.has(id));
      used.add(id); return { ...card, id };
    }));
  }
  function previewImportMarkdown(md) {
    const parsed = parseMarkdown(md);
    const roles = parsed.roles.map(v => ({ id: resourceId(v.id), ...roleFields(v), instructions: string(v.instructions, MAX_PERSONA) }));
    const ids = new Set(roles.map(r => r.id));
    if (ids.size !== roles.length) fail();
    const conflicts = roles.filter(r => hasRole(r.id)).map(r => ({ kind: 'role', id: r.id }));
    let team;
    if (parsed.team) {
      const v = parsed.team;
      team = { id: resourceId(v.id), name: localized(v.name, 100, true), summary: localized(v.summary ?? '', 1000),
        roleIds: roles.map(r => r.id), coordinatorIndex: coordinator(v, roles) };
      if (hasTeam(team.id)) conflicts.push({ kind: 'team', id: team.id });
    }
    return { kind: parsed.kind, ...(team && { team }), roles, conflicts, warnings: conflicts.length ? [tr('同名资源将另存一份')] : [] };
  }
  function commitImportMarkdown(md, { overwrite = false } = {}) {
    const p = previewImportMarkdown(md);
    const reserved = new Set(p.roles.map(v => v.id));
    const roles = p.roles.map(v => {
      if (!hasRole(v.id)) return createRole(v);
      if (overwrite && !builtinRoles.has(v.id)) return updateRole(v.id, v);
      const id = freshId(v.id, candidate => hasRole(candidate) || reserved.has(candidate));
      return createRole({ ...v, id });
    });
    let team;
    if (p.team) {
      const v = { ...p.team, roleIds: roles.map(r => r.id) };
      team = overwrite && hasTeam(v.id) && !builtinTeams.has(v.id) ? updateTeam(v.id, v) : createTeam({ ...v, id: freshId(v.id, hasTeam) });
    }
    return { kind: p.kind, roles, ...(team && { team }) };
  }
  function installCatalogTeam(entry, catalogRoles) {
    for (const id of entry.roleIds) {
      if (hasRole(id)) continue;
      const role = catalogRoles.find(r => r.id === id);
      if (!role) fail();
      createRole(role);
    }
    return createTeam(entry);
  }
  const mutations = { createRole, updateRole, resetRole, deleteRole, setRoleDefault,
    createTeam, updateTeam, deleteTeam, resetTeam, installCatalogTeam, commitImportMarkdown };
  return {
    ...Object.fromEntries(Object.entries(mutations).map(([name,fn]) => [name,transaction(fn)])),
    listRoles: lang => [...builtinRoles.keys(), ...Object.keys(index.custom)].map(id => getRole(id, lang)),
    getRole, getRoleInstructions, resolveRoleToMember, listTeams, getTeam, exportTeamMarkdown, previewImportMarkdown,
    exportRoleMarkdown(id, lang) { requireRole(id); return roleMarkdown(getRole(id, lang)); },
  };
}
