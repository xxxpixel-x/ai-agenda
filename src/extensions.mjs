import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t as tr, getLanguage } from './i18n.mjs';
import { atomicWrite, readJsonFile, safeId, webUrl } from './library-store.mjs';
import { dirs, hasSkill, parseSkillInfo, pluginDirs, skillInfo, scanLocalMcp } from './extension-scan.mjs';
import { githubFiles, githubLocation, marketplace } from './extension-market.mjs';

const localOnly = () => { throw new Error(tr('本机已有的资源只能停用')); };
const invalid = () => { throw new Error(tr('工具配置无效')); };
const modeOf = v => ['readonly','mutating'].includes(v) ? v : invalid();
const sensitive = key => /key|token|secret|pass|auth|dsn|url|cookie/i.test(key);
const hint = v => ({ hasSecret: !!v, keyHint: !v ? '' : v.length > 8 ? v.slice(0,4) + '…' + v.slice(-4) : '••••' });
function removeDir(root, id) {
  const file = path.resolve(root, safeId(id));
  if (path.dirname(file) !== path.resolve(root)) invalid();
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink()) fs.unlinkSync(file);
  else fs.rmSync(file, { recursive: true, force: true });
}
function fileParts(file) {
  const parts = file.split('/');
  if (parts.some(s => !/^[\w. -]+$/.test(s) || s === '.' || s.includes('..') || /[. ]$/.test(s)
      || /^(con|nul|aux|prn|com[1-9]|lpt[1-9])(\.|$)/i.test(s))) invalid();
  return parts;
}

export function createExtensionsManager({
  dataDir, agentsSkillsDir = process.env.AGENDA_AGENTS_SKILLS_DIR || path.join(os.homedir(), '.agents','skills'),
  claudeSkillsDir = process.env.AGENDA_CLAUDE_SKILLS_DIR || path.join(os.homedir(), '.claude','skills'),
  claudeConfigDir = process.env.AGENDA_CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  claudeJsonPath = process.env.AGENDA_CLAUDE_JSON || path.join(os.homedir(), '.claude.json'),
  codexHome = process.env.AGENDA_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  protect = s => ({ plain: s }), unprotect = o => o?.plain ?? '', fetchFn = globalThis.fetch, linkDirFn = null,
  roleLibrary = null,
} = {}) {
  const stateFile = path.join(dataDir, 'extensions.json'), mcpFile = path.join(dataDir, 'mcp-servers.json');
  const state = readJsonFile(stateFile, { installedSkills: {}, disabledSkills: [], disabledMcp: [], mcpModeOverrides: {} });
  const config = readJsonFile(mcpFile, { servers: {} });
  const save = () => atomicWrite(stateFile, state);
  const saveMcp = () => atomicWrite(mcpFile, config);
  if (!fs.existsSync(stateFile)) save();
  if (!fs.existsSync(mcpFile)) saveMcp();
  const localOptions = { claudeJsonPath, claudeConfigDir, codexHome };
  const market = marketplace(fetchFn, () => ({
    skills: new Set(listSkills().map(x => x.id)), mcp: new Set(allMcp().keys()),
    roles: new Set(roleLibrary?.listRoles().map(r => r.id)), teams: new Set(roleLibrary?.listTeams().map(r => r.id)),
  }));

  function listSkills() {
    const result = [], names = new Set(), ids = new Set();
    const roots = [agentsSkillsDir, claudeSkillsDir, ...pluginDirs(claudeConfigDir).map(root => path.join(root,'skills'))];
    for (const root of roots) for (const folder of dirs(root)) {
      let id;
      try { id = safeId(folder); } catch { continue; }
      const dir = path.resolve(root, folder);
      if (ids.has(id) || !hasSkill(dir)) continue;
      const info = skillInfo(dir);
      if (names.has(info.name.toLowerCase())) continue;
      ids.add(id); names.add(info.name.toLowerCase());
      const tracked = state.installedSkills[id];
      const owned = tracked && path.resolve(tracked.dir) === dir;
      result.push({ ...(owned && tracked), id, ...info, dir, origin: owned ? 'agenda' : 'local', removable: !!owned, enabled: !state.disabledSkills.includes(id) });
    }
    return result;
  }
  function toggle(key, id, enabled) {
    if (typeof enabled !== 'boolean') invalid();
    state[key] = state[key].filter(v => v !== id);
    if (!enabled) state[key].push(id);
  }
  async function installSkill(input) {
    const repo = input.repo ? githubLocation(input.repo, input.subdir) : null;
    const id = safeId(input.id ?? repo?.id ?? input.name);
    const existing = () => {
      const skills = listSkills();
      const local = [agentsSkillsDir,claudeSkillsDir].map(root => path.join(root,id)).find(hasSkill);
      const name = local ? skillInfo(local).name : input.name || id;
      return skills.find(s => s.id === id || s.name.toLowerCase() === name.toLowerCase());
    };
    let skill = existing();
    if (skill) return { alreadyInstalled: true, skill };
    const known = market.find('skills', id);
    let files = { ...input.files };
    if (input.content !== undefined) files['SKILL.md'] = input.content;
    if (!files['SKILL.md'] && repo) {
      try { files = { ...await githubFiles(fetchFn, repo), ...files }; }
      catch (e) { if (!known?.template) throw e; }
    }
    files['SKILL.md'] ||= known?.template;
    if (!files['SKILL.md'] || !String(files['SKILL.md']).trim()) invalid();
    const entries = Object.entries(files).map(([name, content]) => {
      if (typeof content !== 'string' && !Buffer.isBuffer(content)) invalid();
      return [fileParts(name), content];
    });
    // A second request can finish downloading the same skill while this request awaits GitHub.
    const parsed = parseSkillInfo(String(files['SKILL.md']), id);
    skill = existing() || listSkills().find(s => s.name.toLowerCase() === parsed.name.toLowerCase());
    if (skill) return { alreadyInstalled: true, skill };
    const dir = path.resolve(agentsSkillsDir, id), link = path.resolve(claudeSkillsDir, id);
    for (const root of [agentsSkillsDir, claudeSkillsDir]) fs.mkdirSync(root, { recursive: true });
    if (fs.lstatSync(link, { throwIfNoEntry: false })) invalid();
    fs.mkdirSync(dir);
    let linkMethod = 'symlink', ownsLink = false;
    try {
      for (const [parts, content] of entries) {
        const file = path.join(dir, ...parts);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, { flag: 'wx' });
      }
      if (dir !== link) {
        try {
          (linkDirFn || fs.symlinkSync)(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
          ownsLink = true;
          linkMethod = process.platform === 'win32' ? 'junction' : 'symlink';
        } catch {
          fs.mkdirSync(link); ownsLink = true;
          fs.cpSync(dir, link, { recursive: true }); linkMethod = 'copy';
        }
      }
      state.installedSkills[id] = { id, name: skillInfo(dir).name, dir, claudeLink: link, linkMethod,
        source: String(input.source || known?.sourceUrl || repo?.repo || ''), ...(repo && { repo: repo.repo }), installedAt: Date.now() };
      save();
    } catch (e) {
      delete state.installedSkills[id];
      if (ownsLink) removeDir(claudeSkillsDir, id);
      removeDir(agentsSkillsDir, id); throw e;
    }
    return { alreadyInstalled: false, skill: listSkills().find(x => x.id === id) };
  }
  function setSkillEnabled(id, enabled) {
    if (!listSkills().some(s => s.id === id)) invalid();
    toggle('disabledSkills', id, enabled); save(); return listSkills().find(s => s.id === id);
  }
  function removeSkill(id) {
    const skill = state.installedSkills[safeId(id)];
    if (!skill || path.resolve(skill.dir) !== path.resolve(agentsSkillsDir, id)) localOnly();
    if (path.resolve(claudeSkillsDir) !== path.resolve(agentsSkillsDir) && skill.claudeLink === path.resolve(claudeSkillsDir, id)) removeDir(claudeSkillsDir, id);
    removeDir(agentsSkillsDir, id);
    delete state.installedSkills[id]; toggle('disabledSkills', id, true); save(); return { ok: true };
  }

  function allMcp() {
    const local = scanLocalMcp(localOptions);
    for (const s of Object.values(config.servers)) if (!local.has(s.id)) local.set(s.id, s);
    const result = new Map();
    for (const [id,s] of local) {
      const managed = !s.localSource;
      result.set(id, { ...s, origin: managed ? 'agenda' : 'local', removable: managed,
        enabled: !state.disabledMcp.includes(id) && (s.enabled !== false || !!state.enabledLocalMcp?.includes(id)),
        mode: state.mcpModeOverrides[id] || (['readonly','mutating'].includes(s.mode) ? s.mode : market.find('mcp', id)?.mode) || 'mutating' });
    }
    return result;
  }
  function values(server, field, masked) {
    return Object.fromEntries(Object.entries(server[field] || {}).map(([k, stored]) => {
      const encoded = server.origin === 'agenda' && server.secretKeys?.includes(k);
      let v = stored;
      if (encoded) { try { v = unprotect(stored) || ''; } catch { v = ''; } }
      const secret = encoded || sensitive(k) || field === 'headers' || server.origin === 'local';
      return [k, masked && secret ? hint(v) : v];
    }));
  }
  const publicMcp = s => ({ ...s, env: values(s,'env',true), headers: values(s,'headers',true) });
  const listMcp = () => [...allMcp().values()].map(publicMcp);
  function definition(id, input, old = {}) {
    const known = market.find('mcp', id);
    const v = { ...known, ...old, ...input };
    const mode = modeOf(v.mode ?? 'mutating'), transport = v.transport ?? (v.url ? 'http' : 'stdio');
    const fields = transport === 'stdio' ? { command: v.command, args: v.args ?? [] } : { url: webUrl(v.url) };
    if (transport === 'stdio' ? typeof fields.command !== 'string' || !fields.command.trim() || !Array.isArray(fields.args) || !fields.args.every(a => typeof a === 'string')
        : transport !== 'http' || !fields.url) invalid();
    const declared = v.secretKeys ?? [];
    const sameTarget = old.id && old.transport === transport && (transport === 'stdio'
      ? old.command === fields.command : new URL(old.url).origin === new URL(fields.url).origin);
    if (!Array.isArray(declared) || !declared.every(k => typeof k === 'string')) invalid();
    const envKeys = known?.envKeys ?? input.envKeys ?? [];
    if (!Array.isArray(envKeys)) invalid();
    const secrets = new Set([...(old.secretKeys || []), ...declared, ...envKeys.filter(k => k.secret).map(k => k.key),
      ...Object.keys(input.headers || known?.headers || {}), ...Object.keys(input.env || {}).filter(sensitive)]);
    const maps = {};
    for (const field of ['env','headers']) {
      const previous = sameTarget ? old[field] || {} : {};
      const patch = input[field] ?? (old.id ? {} : known?.[field] || {});
      if (typeof patch !== 'object' || Array.isArray(patch)) invalid();
      const entries = new Map(Object.entries(previous));
      for (const [k, val] of Object.entries(patch)) {
        if (!/^[\w.-]{1,128}$/.test(k) || Object.hasOwn(Object.prototype,k)) invalid();
        if (val === undefined) continue;
        if (typeof val !== 'string') invalid();
        if (field === 'headers' || sensitive(k)) secrets.add(k);
        if (val === '') entries.delete(k);
        else entries.set(k, secrets.has(k) ? protect(val) : val);
      }
      for (const [k, val] of entries) if (secrets.has(k) && !old.secretKeys?.includes(k) && patch[k] === undefined) entries.set(k, protect(val));
      maps[field] = Object.fromEntries(entries);
    }
    for (const k of envKeys) if (!old.id && k.required && !(Object.hasOwn(maps.env,k.key) || Object.hasOwn(maps.headers,k.key))) throw new Error(tr('请填写 {0}', [k.key]));
    return { id, name: String(v.name || id), description: String(v.description ?? known?.summary?.[getLanguage()] ?? ''),
      mode, transport, ...fields, ...maps, secretKeys: [...secrets], source: webUrl(v.source || known?.sourceUrl), installedAt: old.installedAt || Date.now() };
  }
  function installMcp(input) {
    const id = safeId(input.id || input.name);
    const found = allMcp().get(id);
    if (found) return { alreadyInstalled: true, mcp: publicMcp(found) };
    config.servers[id] = definition(id, input); saveMcp();
    return { alreadyInstalled: false, mcp: publicMcp(allMcp().get(id)) };
  }
  function updateMcp(id, patch) {
    const s = allMcp().get(id);
    if (!s || ('enabled' in patch && typeof patch.enabled !== 'boolean')) invalid();
    if (s.removable) { config.servers[id] = definition(id, patch, config.servers[id]); saveMcp(); }
    else {
      if (Object.keys(patch).some(k => !['enabled','mode'].includes(k))) localOnly();
      if ('mode' in patch) state.mcpModeOverrides[id] = modeOf(patch.mode);
      if ('enabled' in patch) state.enabledLocalMcp = [...new Set([...(state.enabledLocalMcp || []), id])];
    }
    if ('enabled' in patch) toggle('disabledMcp', id, patch.enabled);
    save(); return publicMcp(allMcp().get(id));
  }
  function removeMcp(id) {
    if (!allMcp().get(id)?.removable) localOnly();
    delete config.servers[id]; saveMcp(); delete state.mcpModeOverrides[id]; toggle('disabledMcp', id, true); save(); return { ok: true };
  }
  function checkPermissionConflicts({ access, members = [] }) {
    const conflicts = [];
    if (['read','edit'].includes(access) && members.some(m => m.mcp?.length)) {
      const known = allMcp();
      members.forEach((m, memberIndex) => {
        for (const mcpId of new Set(m.mcp || [])) {
          const s = known.get(mcpId) || market.find('mcp',mcpId);
          if (s?.mode === 'mutating') conflicts.push({ memberIndex, memberId: m.id || '', memberName: m.name, mcpId, mcpName: s.name, mode: s.mode });
        }
      });
    }
    return { hasConflict: !!conflicts.length, access, requiredAccess: 'run', conflicts };
  }
  function resolveForMember(member, { access = 'edit' } = {}) {
    const skills = member.skills?.length ? listSkills().filter(s => s.enabled && member.skills.includes(s.id)).map(s => s.dir) : [];
    const mcp = {};
    const readonlyMcp = [];
    if (member.mcp?.length) for (const [id,s] of allMcp()) {
      if (!member.mcp.includes(id) || !s.enabled || (s.mode !== 'readonly' && !['run','full'].includes(access))) continue;
      if (s.mode === 'readonly') readonlyMcp.push(id);
      const env = values(s,'env',false), headers = values(s,'headers',false);
      const expand = str => str.replace(/\$\{([\w]+)\}/g, (match,k) => Object.hasOwn(env,k) ? env[k] : match);
      mcp[id] = s.transport === 'http' ? { type: 'http', url: s.url, headers: Object.fromEntries(Object.entries(headers).map(([k,v]) => [k,expand(v)])) }
        : { command: s.command, args: s.args.map(expand), env };
    }
    return { skills, mcp, readonlyMcp };
  }
  return { listExtensions: () => ({ skills: listSkills(), mcp: listMcp() }), listSkills, listMcp, installSkill, setSkillEnabled, removeSkill,
    installMcp, updateMcp, removeMcp, checkPermissionConflicts, resolveForMember,
    getMarketplace: market.getMarketplace, searchMcpRegistry: market.searchMcpRegistry };
}
