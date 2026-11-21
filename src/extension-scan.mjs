import fs from 'node:fs';
import path from 'node:path';
import { safeId } from './library-store.mjs';

function tryRead(fn, fallback) { try { return fn(); } catch { return fallback; } }
export const readText = file => tryRead(() => fs.readFileSync(file, 'utf8'), '');
const json = file => tryRead(() => JSON.parse(readText(file)), {});
export const dirs = root => tryRead(() => fs.readdirSync(root).filter(name => tryRead(() => fs.statSync(path.join(root, name)).isDirectory(), false)), []);
export const hasSkill = dir => tryRead(() => fs.statSync(path.join(dir, 'SKILL.md')).isFile(), false);
const unquote = v => v?.trim().replace(/^(['"])(.*)\1$/, '$2');
export function skillInfo(dir) {
  return parseSkillInfo(readText(path.join(dir, 'SKILL.md')), path.basename(dir));
}
export function parseSkillInfo(content, fallbackName) {
  const text = content.replace(/^\uFEFF/, '');
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const field = key => {
    const m = new RegExp('^' + key + ':[ \\t]*(.*)((?:\\r?\\n[ \\t]+[^\\n]*)*)', 'm').exec(header?.[1] || '');
    if (m && /^[|>][-+]?$/.test(m[1].trim())) return m[2].trim().split(/\r?\n\s*/).join(m[1][0] === '>' ? ' ' : '\n');
    return unquote(m?.[1]);
  };
  return { name: field('name') || fallbackName, description: field('description')
    || text.slice(header?.[0].length || 0).trim().split(/\r?\n\s*\r?\n/).find(p => !p.startsWith('#')) || '' };
}

const tomlName = String.raw`("[^"\n]+"|'[^'\n]+'|[\w-]+)`;
const table = new RegExp('^\\[\\s*mcp_servers\\.' + tomlName + '(?:\\.(env|http_headers))?\\s*\\]$');
function literal(text) {
  try { return JSON.parse(text); } catch { /* TOML single-quoted strings and arrays */ }
  if (/^'[^']*'$/.test(text)) return text.slice(1,-1);
  if (text.startsWith('[') && text.endsWith(']')) return [...text.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'/g)].map(m => literal(m[0]));
}
export function parseCodexServers(text) {
  const servers = Object.create(null);
  let current = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const uncomment = line => line.replace(/("(?:\\.|[^"\\])*"|'[^']*')|#.*/g, (_, quoted) => quoted || '').trim();
    let line = uncomment(lines[i]);
    if (line.startsWith('[')) {
      const match = table.exec(line);
      current = null;
      if (match) {
        const name = unquote(match[1]);
        const server = servers[name] ??= Object.create(null);
        current = match[2] ? (server[match[2]] ??= Object.create(null)) : server;
      }
    } else if (current) {
      const kv = /^("[^"]+"|'[^']+'|[\w-]+)\s*=\s*(.*)$/.exec(line);
      if (!kv) continue;
      let value = kv[2];
      while (value.startsWith('[') && !value.endsWith(']') && i + 1 < lines.length) value += uncomment(lines[++i]);
      const decoded = literal(value);
      if (decoded !== undefined) current[unquote(kv[1])] = decoded;
    }
  }
  return servers;
}

export function pluginDirs(claudeConfigDir, settings = json(path.join(claudeConfigDir, 'settings.json'))) {
  const plugins = json(path.join(claudeConfigDir,'plugins','installed_plugins.json')).plugins || settings.installedPlugins || {};
  return Object.entries(plugins).filter(([name]) => settings.enabledPlugins?.[name] !== false)
    .flatMap(([,entries]) => Array.isArray(entries) ? entries : [entries])
    .map(entry => entry?.installPath).filter(dir => typeof dir === 'string' && path.isAbsolute(dir));
}
export function scanLocalMcp({ claudeJsonPath, claudeConfigDir, codexHome }) {
  const found = new Map();
  function merge(config, localSource) {
    for (const [key, v] of Object.entries(config || {})) {
      const id = tryRead(() => safeId(key.trim().replace(/\s+/g,'-')), null);
      if (!id || found.has(id) || !(typeof v?.url === 'string' || typeof v?.command === 'string')) continue;
      if (v.args && (!Array.isArray(v.args) || !v.args.every(arg => typeof arg === 'string'))) continue;
      const strings = map => Object.fromEntries(Object.entries(map || {}).filter(([,value]) => typeof value === 'string'));
      found.set(id, { id, name: key, description: v.description || '', localSource, enabled: v.enabled !== false,
        mode: v.mode, transport: v.url ? 'http' : 'stdio', ...(v.url ? { url: v.url } : { command: v.command, args: v.args || [] }),
        env: strings(v.env), headers: strings(v.headers || v.http_headers) });
    }
  }
  const settings = json(path.join(claudeConfigDir, 'settings.json'));
  merge(json(claudeJsonPath).mcpServers, 'claude-code');
  merge(settings.mcpServers, 'claude-code');
  for (const root of pluginDirs(claudeConfigDir,settings)) {
    const manifest = json(path.join(root,'.claude-plugin','plugin.json'));
    for (const spec of ['.mcp.json', ...[manifest.mcpServers || {}].flat()]) {
      let config = spec;
      if (typeof spec === 'string') {
        const file = path.resolve(root,spec);
        if (!file.startsWith(path.resolve(root) + path.sep)) continue;
        config = json(file);
      }
      merge(config?.mcpServers || config,'claude-code');
    }
  }
  merge(parseCodexServers(readText(path.join(codexHome, 'config.toml'))), 'codex');
  return found;
}
