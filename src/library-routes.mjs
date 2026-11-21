import { t as tr } from './i18n.mjs';

export async function handleLibraryRoute({ req, res, url, p, method, readJson, sendJson, roleLibrary: lib, extensions: ext, registry, language }) {
  if (!p.startsWith('/api/library/')) return false;
  const parts = p.slice('/api/library/'.length).split('/');
  const [group, id, action] = parts;
  const body = () => readJson(req);
  const send = (value, status = 200) => { sendJson(res, status, value); return true; };
  const missing = () => send({ error: tr('未找到') }, 404);
  if (parts.length > 3) return missing();
  if (group === 'roles' || group === 'teams') {
    const role = group === 'roles', lang = language();
    if (!id && method === 'GET') return send(role ? lib.listRoles(lang) : lib.listTeams(lang));
    if (!id && method === 'POST') return send((role ? lib.createRole : lib.createTeam)(await body()), 201);
    const current = (role ? lib.getRole : lib.getTeam)(id, lang);
    if (!current) return missing();
    if (!action && method === 'GET') return send(current);
    if (!action && method === 'PATCH') return send((role ? lib.updateRole : lib.updateTeam)(id, await body()));
    if (!action && method === 'DELETE') return send((role ? lib.deleteRole : lib.deleteTeam)(id));
    if (action === 'reset' && method === 'POST') return send((role ? lib.resetRole : lib.resetTeam)(id));
    if (role && action === 'default' && method === 'PUT') return send(lib.setRoleDefault(id, await body()));
    if (role && action === 'resolve' && method === 'POST') return send(lib.resolveRoleToMember(id, await registry.detectAll(), { ...await body(), lang }));
    if (action === 'export' && method === 'GET') {
      const md = (role ? lib.exportRoleMarkdown : lib.exportTeamMarkdown)(id, lang);
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${id}.md"` });
      res.end(md); return true;
    }
    return missing();
  }
  if (action) return missing();
  if (group === 'import' && method === 'POST') {
    const v = await body();
    if (id === 'preview') return send(lib.previewImportMarkdown(v.markdown));
    if (id === 'commit') return send(lib.commitImportMarkdown(v.markdown, { overwrite: v.overwrite === true }), 201);
  }
  if (group === 'extensions' && !id && method === 'GET') return send(ext.listExtensions());
  if (group === 'skills' || group === 'mcp') {
    const skill = group === 'skills';
    if (id === 'install' && method === 'POST') {
      const result = await (skill ? ext.installSkill : ext.installMcp)(await body());
      return send(result, result.alreadyInstalled ? 200 : 201);
    }
    if (id && method === 'PATCH') {
      const patch = await body();
      return send(skill ? ext.setSkillEnabled(id, patch.enabled) : ext.updateMcp(id, patch));
    }
    if (id && method === 'DELETE') return send((skill ? ext.removeSkill : ext.removeMcp)(id));
  }
  if (group === 'check-permissions' && !id && method === 'POST') return send(ext.checkPermissionConflicts(await body()));
  if (group === 'marketplace') {
    if (!id && method === 'GET') return send(await ext.getMarketplace({ refresh: url.searchParams.get('refresh') === '1' }));
    if (id === 'mcp-search' && method === 'GET') return send(await ext.searchMcpRegistry(url.searchParams.get('q') || ''));
    if (method === 'POST' && ['install-role','install-team'].includes(id)) {
      const catalog = await ext.getMarketplace(), v = await body();
      const role = id === 'install-role';
      const entry = catalog[role ? 'roles' : 'teams'].find(x => x.id === v.id);
      if (!entry) return missing();
      const installed = (role ? lib.getRole : lib.getTeam)(entry.id);
      if (installed) return send(installed);
      return send(role ? lib.createRole(entry) : lib.installCatalogTeam(entry,catalog.roles), 201);
    }
  }
  return missing();
}
