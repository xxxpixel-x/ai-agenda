import { CURATED_MARKETPLACE as offline } from './library-data.mjs';
import { safeId, webUrl } from './library-store.mjs';
import { t as tr } from './i18n.mjs';

const groups = ['skills','mcp','roles','teams'];
export async function request(fetchFn, url, timeout = 8000) {
  const r = await fetchFn(url, { signal: AbortSignal.timeout(timeout) });
  if (!r || r.ok === false) throw new Error(tr('下载失败'));
  return r;
}

export function marketplace(fetchFn, installed) {
  let catalog = offline;
  function valid(data) {
    return data?.version === '1' && groups.every(k => Array.isArray(data[k]) && data[k].every(x => {
      safeId(x.id);
      if (!x.name || !x.summary) return false;
      if (k === 'skills') return typeof x.template === 'string';
      if (k === 'mcp') return ['readonly','mutating'].includes(x.mode) && Array.isArray(x.envKeys);
      return k === 'teams' ? Array.isArray(x.roleIds) : !!x.instructions;
    }));
  }
  async function getMarketplace({ refresh = false } = {}) {
    let offlineFallback = false;
    if (refresh) {
      try {
        const data = await (await request(fetchFn, offline.catalogUrl, 5000)).json();
        if (!valid(data)) throw new Error();
        catalog = data;
      } catch { catalog = offline; offlineFallback = true; }
    }
    const ids = installed();
    const view = { version: '1', catalogUrl: offline.catalogUrl, source: catalog === offline ? 'offline' : 'remote', offlineFallback };
    for (const k of groups) view[k] = catalog[k].map(x => ({ ...x, installed: ids[k]?.has(x.id) || false }));
    return view;
  }

  async function searchMcpRegistry(query = '') {
    const q = String(query).trim().slice(0, 200), results = new Map();
    let registryError = '';
    try {
      const data = await (await request(fetchFn, 'https://registry.modelcontextprotocol.io/v0/servers?search=' + encodeURIComponent(q) + '&limit=20')).json();
      for (const row of (Array.isArray(data) ? data : data.servers).slice(0, 20)) {
        const s = row.server || row, pkg = s.packages?.find(p => ['npm','pypi'].includes(p.registryType)), remote = s.remotes?.find(r => webUrl(r.url));
        if (!s.name || !(remote || pkg || s.command || s.url)) continue;
        const id = safeId((s.id || s.name).toLowerCase().replace(/[^a-z0-9_-]+/g,'-').slice(0,64));
        const description = String(s.description || '');
        const describedReadOnly = /\bread[- ]only\b/i.test(description) && !/\b(not|write|create|update|delete|modify|mutating)\b/i.test(description);
        const mode = s.mode === 'readonly' || (!s.mode && (s.annotations?.readOnlyHint === true || describedReadOnly)) ? 'readonly' : 'mutating';
        const vars = remote?.headers || pkg?.environmentVariables || [];
        const envKeys = vars.filter(x => x.name).map(x => ({ key: x.name, label: { en: x.description || x.name, zh: x.name },
          required: !!x.isRequired, secret: x.isSecret !== false, ...(remote && { header: true }) }));
        const url = webUrl(remote?.url || s.url);
        const argsOf = list => (list || []).flatMap(arg => arg.type === 'named' ? [arg.name, arg.value ?? arg.default].filter(Boolean) : [arg.value ?? arg.default].filter(Boolean));
        const args = pkg ? [...(pkg.registryType === 'npm' ? ['-y'] : []), ...argsOf(pkg.runtimeArguments), pkg.identifier, ...argsOf(pkg.packageArguments)] : [];
        results.set(id, { id, name: s.title || s.name, description, mode, sourceUrl: webUrl(s.sourceUrl || s.repository?.url || s.websiteUrl),
          transport: url ? 'http' : 'stdio', ...(url ? { url } : { command: s.command || (pkg.registryType === 'npm' ? 'npx' : 'uvx'),
            args: s.args || args }), envKeys: s.envKeys || envKeys });
      }
    } catch (e) { registryError = e.message || tr('注册表暂不可用'); }
    for (const x of catalog.mcp) if (JSON.stringify([x.id,x.name,x.summary]).toLowerCase().includes(q.toLowerCase()) && !results.has(x.id)) results.set(x.id, x);
    return { servers: [...results.values()], registryError };
  }
  return { getMarketplace, searchMcpRegistry, find: (group, id) => catalog[group].find(x => x.id === id) };
}

export function githubLocation(repo, subdir) {
  const parts = String(repo).replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '').split('/');
  const [owner, name, ...rest] = parts;
  const dirs = [...rest, ...(subdir ? String(subdir).split('/') : [])];
  if (![owner,name,...dirs].every(s => typeof s === 'string' && /^[\w.-]+$/.test(s) && !s.includes('..') && s !== '.')) throw new Error(tr('无效的 GitHub 路径'));
  return { repo: owner + '/' + name, dir: dirs.join('/'), id: safeId(dirs.at(-1) || name) };
}

export async function githubFiles(fetchFn, location) {
  const base = 'https://api.github.com/repos/' + location.repo + '/contents/' + (location.dir ? location.dir + '/' : '');
  const files = Object.create(null);
  let count = 0, size = 0;
  async function visit(relative) {
    if (++count > 80) throw new Error(tr('资源太大'));
    const r = await request(fetchFn, base + relative.split('/').map(encodeURIComponent).join('/'));
    const data = await r.json();
    if (Array.isArray(data)) {
      for (const entry of data) {
        if (!['file','dir'].includes(entry.type)) continue;
        if (!/^[a-z0-9._ -]+$/i.test(entry.name) || entry.name.includes('..') || entry.name === '.') throw new Error(tr('无效的 GitHub 路径'));
        await visit((relative ? relative + '/' : '') + entry.name);
      }
    } else {
      if (!relative || data.encoding !== 'base64' || typeof data.content !== 'string') throw new Error(tr('下载失败'));
      const buf = Buffer.from(data.content, 'base64');
      if ((size += buf.length) > 5_000_000) throw new Error(tr('资源太大'));
      files[relative] = buf;
    }
  }
  try { await visit(''); }
  catch {
    const url = 'https://raw.githubusercontent.com/' + location.repo + '/HEAD/' + (location.dir ? location.dir + '/' : '') + 'SKILL.md';
    return { 'SKILL.md': await (await request(fetchFn, url)).text() };
  }
  return files;
}
