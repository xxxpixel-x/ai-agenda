import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createExtensionsManager } from '../src/extensions.mjs';
import { CURATED_MARKETPLACE } from '../src/library-data.mjs';
import { createRegistry } from '../src/engines/index.mjs';
import { createSettings } from '../src/settings.mjs';
import { extensionOptions } from '../src/engines/claude-code.mjs';
import { isolationArgs, skillPrompt } from '../src/engines/codex.mjs';
import { runAgentTurn } from '../src/turn-runner.mjs';
import { libraryFixture, libraryHttp } from './helpers.mjs';

function write(file, text) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,text);
}
const writeSkill = (dir,id,content) => write(path.join(dir,id,'SKILL.md'),content);
const read = file => fs.readFileSync(file,'utf8');
const json = data => ({ok:true, json:async () => structuredClone(data)});
const hooks = {
  protect: s => ({ encoded:Buffer.from(s).toString('base64') }),
  unprotect: o => Buffer.from(o.encoded,'base64').toString(),
};

test('scan both skill roots, deduplicate by directory or frontmatter name, and toggle local resources', async t => {
  const opts = libraryFixture(t), mgr = createExtensionsManager(opts);
  writeSkill(opts.agentsSkillsDir,'design','---\nname: Design\ndescription: >\n  Use design tokens\n  and semantic controls.\n---\n');
  writeSkill(opts.claudeSkillsDir,'design','old copy');
  writeSkill(opts.claudeSkillsDir,'alias','---\nname: Design\n---\nDuplicate.');
  writeSkill(opts.claudeSkillsDir,'edit','# Guidelines\n\nReview prose.');
  fs.mkdirSync(path.join(opts.agentsSkillsDir,'empty'));
  const skills = mgr.listSkills();
  assert.equal(skills.length,2);
  const design = skills.find(x => x.id === 'design');
  assert.equal(design.description,'Use design tokens and semantic controls.');
  assert.equal(design.dir,path.join(opts.agentsSkillsDir,'design'));
  assert.equal(skills.find(x => x.id === 'edit').description,'Review prose.');
  assert.ok(skills.every(x => x.origin === 'local' && x.enabled && !x.removable));
  assert.ok((await mgr.installSkill({id:'design',content:'different'})).alreadyInstalled);
  assert.equal((await mgr.installSkill({id:'alias'})).skill.id,'design');
  assert.ok((await mgr.installSkill({id:'other',content:'---\nname: Design\n---\nDifferent.'})).alreadyInstalled);
  assert.throws(() => mgr.removeSkill('design'),/local/i);
  mgr.setSkillEnabled('design',false);
  assert.deepEqual(createExtensionsManager(opts).resolveForMember({skills:['design']}),{skills:[],mcp:{}});
  mgr.setSkillEnabled('design',true);
  assert.deepEqual(mgr.resolveForMember({skills:['design','absent']}).skills,[design.dir]);
});

for (const copy of [false,true]) test('managed skill install, duplicate detection and removal with ' + (copy ? 'copy fallback' : 'directory link'), async t => {
  const opts = libraryFixture(t,copy ? {linkDirFn:() => { throw new Error('link unavailable'); }} : {});
  const mgr = createExtensionsManager(opts);
  const {skill} = await mgr.installSkill({id:'frontend-design',repo:'example/missing'});
  assert.equal(skill.origin,'agenda'); assert.equal(skill.removable,true);
  assert.equal(fs.lstatSync(skill.claudeLink).isSymbolicLink(),!copy);
  assert.equal(skill.linkMethod,copy ? 'copy' : process.platform === 'win32' ? 'junction' : 'symlink');
  assert.equal(read(path.join(skill.claudeLink,'SKILL.md')),CURATED_MARKETPLACE.skills[0].template);
  assert.equal((await mgr.installSkill({id:skill.id})).alreadyInstalled,true);
  assert.equal(mgr.listSkills().length,1);
  mgr.setSkillEnabled(skill.id,false); assert.equal(mgr.listSkills()[0].enabled,false);
  mgr.setSkillEnabled(skill.id,true);
  mgr.removeSkill(skill.id); assert.ok(!fs.existsSync(skill.dir)); assert.ok(!fs.existsSync(skill.claudeLink));
  assert.deepEqual(mgr.listSkills(),[]);
  for (const input of [{id:'..'}, {id:'x',repo:'example/repo/../a'}, {id:'x',content:'ok',files:{'../bad':'x'}}, {id:'x',content:'ok',files:{'sub\\bad':'x'}}]) {
    await assert.rejects(mgr.installSkill(input));
  }
  assert.ok(!fs.existsSync(path.join(opts.agentsSkillsDir,'x')));
});

test('scan Claude, plugin and Codex configs without modifying them; resolve only selected local tools', t => {
  const opts = libraryFixture(t), mgr = createExtensionsManager(opts);
  const file = path.join(opts.codexHome,'config.toml'), settings = path.join(opts.claudeConfigDir,'settings.json');
  write(opts.claudeJsonPath,JSON.stringify({mcpServers:{fetch:{command:'reader',args:['--plain'],env:{AUTH:'local-credential'}}}}));
  write(settings,JSON.stringify({mcpServers:{fetch:{command:'shadowed'},custom:{url:'https://example.test/api'}}}));
  const plugin = path.join(opts.claudeConfigDir,'installed','fixture');
  write(path.join(opts.claudeConfigDir,'plugins','installed_plugins.json'),JSON.stringify({plugins:{demo:[{installPath:plugin}]}}));
  write(path.join(plugin,'.mcp.json'),JSON.stringify({pluginsvc:{command:'fixture'}}));
  write(path.join(plugin,'.claude-plugin','plugin.json'),JSON.stringify({mcpServers:'./config/servers.json'}));
  write(path.join(plugin,'config','servers.json'),JSON.stringify({extra:{command:'extra'}}));
  writeSkill(path.join(plugin,'skills'),'plugin-skill','Read these notes.');
  write(file,'[mcp_servers."sql.db"]\ncommand = "test-db"\nargs = [\n "a",\n \'b#c\',\n]\n[mcp_servers."sql.db".env]\nDSN = "private"\n[mcp_servers.remote]\nurl = "https://example.test"\nenabled = false\n[mcp_servers.remote.http_headers]\nAuthorization = "credential"\n');
  const originals = [opts.claudeJsonPath,settings,file].map(read);
  const list = mgr.listMcp();
  assert.equal(list.length,6); assert.ok(list.every(x => !x.removable && x.origin === 'local'));
  assert.equal(mgr.listSkills()[0].id,'plugin-skill');
  assert.equal(list.find(x => x.id === 'fetch').localSource,'claude-code');
  const sql = list.find(x => x.id === 'sql.db');
  assert.equal(sql.localSource,'codex'); assert.equal(sql.mode,'mutating');
  assert.equal(list.find(x => x.id === 'remote').enabled,false);
  assert.doesNotMatch(JSON.stringify(list),/local-credential|"private"|"credential"/);
  const member = {mcp:['fetch','sql.db','remote']};
  assert.deepEqual(Object.keys(mgr.resolveForMember(member,{access:'read'}).mcp),['fetch']);
  const {mcp} = mgr.resolveForMember(member,{access:'run'});
  assert.deepEqual(mcp['sql.db'],{command:'test-db',args:['a','b#c'],env:{DSN:'private'}});
  assert.equal(mcp.fetch.command,'reader'); assert.equal(mcp.fetch.env.AUTH,'local-credential');
  mgr.updateMcp('sql.db',{mode:'readonly'}); mgr.updateMcp('fetch',{enabled:false}); mgr.updateMcp('remote',{enabled:true});
  assert.deepEqual(Object.keys(mgr.resolveForMember(member).mcp),['sql.db']);
  assert.equal(mgr.resolveForMember(member,{access:'run'}).mcp.remote.headers.Authorization,'credential');
  assert.ok(mgr.installMcp({id:'fetch'}).alreadyInstalled);
  assert.throws(() => mgr.updateMcp('fetch',{command:'change'})); assert.throws(() => mgr.removeMcp('fetch'));
  assert.deepEqual([opts.claudeJsonPath,settings,file].map(read),originals);
});

test('managed MCPs protect secrets at rest, mask short values, rotate and clear keys, and resolve runtime transport', t => {
  const opts = libraryFixture(t,hooks), mgr = createExtensionsManager(opts);
  const file = path.join(opts.dataDir,'mcp-servers.json');
  for (const input of [{id:'../bad',command:'x'},{id:'x',mode:'wrong',command:'x'},{id:'x',transport:'udp'},
    {id:'x',transport:'http',url:'file:///private'}, {id:'x',args:[]}, {id:'github'}]) assert.throws(() => mgr.installMcp(input));
  const token = 'secret-fixture-sample';
  const {mcp:publicView} = mgr.installMcp({id:'github',env:{GITHUB_PERSONAL_ACCESS_TOKEN:token,OPTION:'on'}});
  assert.deepEqual(publicView.env.GITHUB_PERSONAL_ACCESS_TOKEN,{hasSecret:true,keyHint:'secr…mple'});
  assert.equal(publicView.env.OPTION,'on'); assert.ok(!read(file).includes(token));
  const next = createExtensionsManager(opts), runtime = () => next.resolveForMember({mcp:['github']},{access:'run'}).mcp.github;
  assert.equal(runtime().env.GITHUB_PERSONAL_ACCESS_TOKEN,token);
  next.updateMcp('github',{env:{OTHER_TOKEN:'abc'},enabled:false});
  assert.equal(runtime(),undefined); next.updateMcp('github',{enabled:true});
  assert.equal(runtime().env.GITHUB_PERSONAL_ACCESS_TOKEN,token);
  assert.ok(!JSON.stringify(next.listExtensions()).includes('abc'));
  next.updateMcp('github',{env:{GITHUB_PERSONAL_ACCESS_TOKEN:'new-credential',OTHER_TOKEN:''}});
  assert.equal(runtime().env.GITHUB_PERSONAL_ACCESS_TOKEN,'new-credential'); assert.equal(runtime().env.OTHER_TOKEN,undefined);
  next.installMcp({id:'linear',env:{LINEAR_API_KEY:token}});
  assert.equal(next.resolveForMember({mcp:['linear']},{access:'full'}).mcp.linear.headers.Authorization,'Bearer ' + token);
  next.installMcp({id:'postgres-readonly',env:{DATABASE_URL:'postgresql://fixture'}});
  assert.equal(next.resolveForMember({mcp:['postgres-readonly']},{access:'read'}).mcp['postgres-readonly'].args.at(-1),'postgresql://fixture');
  next.removeMcp('github'); assert.equal(runtime(),undefined); assert.ok(!read(file).includes('new-credential'));
  assert.equal(fs.existsSync(opts.claudeJsonPath),false); assert.equal(fs.existsSync(path.join(opts.codexHome,'config.toml')),false);
});

test('marketplace caches a valid refresh, falls back on invalid or offline responses, and searches registry formats', async t => {
  const remote = structuredClone(CURATED_MARKETPLACE); remote.skills[0].name = 'Remote edition';
  let response = remote, last;
  const opts = libraryFixture(t,{fetchFn: async (url,options) => {
    last = {url,options};
    if (response instanceof Error) throw response;
    return json(response);
  }});
  const mgr = createExtensionsManager(opts);
  assert.equal((await mgr.getMarketplace()).source,'offline');
  assert.equal((await mgr.getMarketplace({refresh:true})).source,'remote');
  assert.ok(last.options.signal); assert.equal(last.url,remote.catalogUrl);
  assert.equal((await mgr.getMarketplace()).skills[0].name,'Remote edition');
  await mgr.installSkill({id:'frontend-design'});
  assert.equal((await mgr.getMarketplace()).skills[0].installed,true);
  for (response of [{},new Error('offline')]) {
    const result = await mgr.getMarketplace({refresh:true});
    assert.ok(result.offlineFallback); assert.equal(result.source,'offline'); assert.deepEqual(result.roles.map(x => x.id),['architect','devops']);
  }
  const row = {server:{name:'org.example/tool',description:'Read-only documentation',packages:[{registryType:'npm',identifier:'fixture-package',
    environmentVariables:[{name:'TOKEN',isRequired:true,isSecret:true}]}]}};
  for (response of [{servers:[row]},[row]]) {
    const r = await mgr.searchMcpRegistry('docs & files');
    assert.equal(last.url,'https://registry.modelcontextprotocol.io/v0/servers?search=docs%20%26%20files&limit=20');
    assert.equal(r.registryError,''); const [s] = r.servers;
    assert.equal(s.mode,'readonly'); assert.deepEqual(s.args,['-y','fixture-package']); assert.equal(s.envKeys[0].key,'TOKEN');
  }
  response = new Error('offline'); const r = await mgr.searchMcpRegistry('github');
  assert.match(r.registryError,/offline/); assert.equal(r.servers[0].id,'github');
});

test('GitHub Contents install downloads nested files and concurrent requests do not duplicate a skill', async t => {
  const files = {'SKILL.md':'# Tools\n\nSample.','snippets/a.txt':'literal text'};
  const base = 'https://api.github.com/repos/fixture/tools/contents/docs/';
  const opts = libraryFixture(t,{fetchFn:async url => {
    assert.ok(url.startsWith(base));
    const rel = url.slice(base.length);
    if (!rel) return json([{name:'SKILL.md',type:'file'},{name:'snippets',type:'dir'}]);
    if (rel === 'snippets') return json([{name:'a.txt',type:'file'}]);
    return json({encoding:'base64',content:Buffer.from(files[rel]).toString('base64')});
  }});
  const mgr = createExtensionsManager(opts);
  const results = await Promise.all(['https://github.com/fixture/tools/docs','fixture/tools/docs'].map(repo => mgr.installSkill({repo})));
  assert.equal(results.filter(r => r.alreadyInstalled).length,1);
  const [s] = mgr.listSkills();
  for (const [file,content] of Object.entries(files)) assert.equal(read(path.join(s.claudeLink,file)),content);
});

test('permission conflicts identify individual members, honor overrides and exclude mutating mounts at runtime', t => {
  const mgr = createExtensionsManager(libraryFixture(t));
  mgr.installMcp({id:'custom',mode:'mutating',command:'example'});
  mgr.installMcp({id:'fetch'});
  const members = [{id:'a',name:'Alice',skills:['github'],mcp:['fetch']},{id:'b',name:'Bob',mcp:['custom','playwright']}];
  for (const access of ['read','edit','run','full']) {
    const result = mgr.checkPermissionConflicts({access,members});
    assert.equal(result.requiredAccess,'run'); assert.equal(result.access,access);
    const restricted = ['read','edit'].includes(access);
    assert.equal(result.hasConflict,restricted);
    assert.deepEqual(result.conflicts.map(c => [c.memberIndex,c.memberId,c.memberName,c.mcpId]),restricted ? [[1,'b','Bob','custom'],[1,'b','Bob','playwright']] : []);
    assert.equal(!!mgr.resolveForMember(members[1],{access}).mcp.custom,!restricted);
    assert.ok(mgr.resolveForMember(members[0],{access}).mcp.fetch);
  }
  assert.ok(!mgr.checkPermissionConflicts({access:'read',members:[members[0]]}).hasConflict);
  mgr.updateMcp('custom',{mode:'readonly'});
  assert.ok(mgr.resolveForMember(members[1]).mcp.custom);
});

test('Claude and Codex invocations isolate global MCPs and inject only mounted skill instructions', t => {
  const opts = libraryFixture(t), dir = path.join(opts.agentsSkillsDir,'selected');
  writeSkill(opts.agentsSkillsDir,'selected','MOUNTED'); writeSkill(opts.agentsSkillsDir,'unselected','DO NOT LOAD');
  write(path.join(opts.codexHome,'config.toml'),'[mcp_servers."with.dot"]\ncommand="old"\n[mcp_servers.keep]\ncommand="keep"\n');
  const mcp = {keep:{command:'fixture',args:['a"b'],env:{'a.b':'line\nbreak'}}, managed:{url:'https://example.test',headers:{Authorization:'literal'}}};
  const skills = [dir,path.join(dir,'absent')];
  for (const access of ['read','edit','run']) {
    const c = extensionOptions({skills,mcp,access,ask:access === 'run',mcpConfigFile:'mounted.json'});
    assert.ok(c.args.includes('--safe-mode')); assert.ok(c.args.includes('--strict-mcp-config'));
    assert.equal(c.args[c.args.indexOf('--mcp-config') + 1],'mounted.json');
    const allowed = c.args[c.args.indexOf('--allowedTools') + 1];
    assert.match(allowed,/mcp__managed__\*/); assert.doesNotMatch(allowed,/Bash|with.dot/);
    assert.equal(c.args[c.args.indexOf('--add-dir') + 1],dir);
    assert.match(c.skillPrompt,/MOUNTED/); assert.doesNotMatch(c.skillPrompt,/DO NOT LOAD/);
  }
  assert.ok(!extensionOptions().args.includes('--mcp-config'));
  const args = isolationArgs(opts.codexHome,{skills,mcp,agentsSkillsDir:opts.agentsSkillsDir});
  assert.match(args.join(' '),/--disable apps --disable plugins --disable hooks -c notify=\[\]/);
  for (const kv of ['mcp_servers."with.dot".enabled=false','mcp_servers.keep.enabled=true','mcp_servers.keep.command="fixture"',
    'mcp_servers.keep.args=["a\\"b"]','mcp_servers.keep.env."a.b"="line\\nbreak"','mcp_servers.managed.url="https://example.test"','mcp_servers.managed.http_headers.Authorization="literal"']) assert.ok(args.includes(kv),kv);
  const config = args.find(arg => arg.startsWith('skills.config='));
  assert.ok(config.includes('unselected')); assert.ok(!config.includes(JSON.stringify(path.join(dir,'SKILL.md'))));
  assert.match(skillPrompt(skills),/MOUNTED/); assert.doesNotMatch(skillPrompt(skills),/DO NOT LOAD/);
});

test('runAgentTurn and registry preserve resolved configs and filter by engine capability', async t => {
  const opts = libraryFixture(t), manager = createExtensionsManager(opts);
  const skill = (await manager.installSkill({id:'test-strategy'})).skill;
  manager.installMcp({id:'fetch'}); manager.installMcp({id:'playwright'});
  const resolve = t.mock.method(manager,'resolveForMember');
  const registry = createRegistry(createSettings(path.join(opts.dataDir,'settings.json')),{mock:true,extensions:manager});
  const ids = {skills:[skill.id],mcp:['fetch','playwright'],access:'read'};
  for (const e of registry.list()) {
    const supported = ['pi','codex','claude-code'].includes(e.id);
    assert.equal(registry.supportsExtensions(e.id),supported);
    assert.equal(e.skills,supported); assert.equal(e.mcp,supported);
    const options = registry.extensionOptionsFor(e.id,ids);
    if (supported) { assert.deepEqual(options.skills,[skill.dir]); assert.deepEqual(Object.keys(options.mcp),['fetch']); }
    else assert.deepEqual(options,{});
  }
  const pre = {skills:[skill.dir],mcp:{supplied:{command:'fixture'}}};
  resolve.mock.resetCalls();
  assert.deepEqual(registry.extensionOptionsFor('pi',pre),pre); assert.equal(resolve.mock.callCount(),0);
  const sink = {};
  await runAgentTurn(registry,{engine:'codex',...ids},{system:'Fixture',prompt:'Hi',cwd:opts.dataDir,access:'read',sink});
  assert.ok(sink.text);
  assert.deepEqual(resolve.mock.calls[0].arguments,[{skills:ids.skills,mcp:ids.mcp},{access:'read'}]);
  await runAgentTurn(registry,{engine:'gemini',...ids},{system:'Fixture',prompt:'Hi',cwd:opts.dataDir,access:'read',sink:{}});
  assert.equal(resolve.mock.callCount(),1);
});

test('HTTP marketplace, skill and MCP lifecycle includes key redaction, permissions and team dependencies', async t => {
  const req = await libraryHttp(t), api = (route,...args) => req('library/' + route,...args);
  assert.deepEqual(await api('extensions'),{skills:[],mcp:[]});
  await api('skills/install','POST',{id:'copy-editing'},201);
  assert.ok((await api('skills/install','POST',{id:'copy-editing'},200)).alreadyInstalled);
  assert.equal((await api('skills/copy-editing','PATCH',{enabled:false})).enabled,false);
  await api('mcp/install','POST',{id:'github'},400);
  await api('mcp/install','POST',{id:'github',env:{GITHUB_PERSONAL_ACCESS_TOKEN:'fixture-secret-token'}},201);
  assert.doesNotMatch(JSON.stringify(await api('extensions')),/fixture-secret-token/);
  assert.ok((await api('check-permissions','POST',{access:'edit',members:[{name:'Writer',mcp:['github']}]})).hasConflict);
  await api('mcp/github','PATCH',{mode:'readonly'});
  assert.equal((await api('marketplace?refresh=1')).offlineFallback,true);
  assert.equal((await api('marketplace/mcp-search?q=fetch')).servers[0].id,'fetch');
  await api('marketplace/install-role','POST',{id:'architect'},201);
  await api('marketplace/install-team','POST',{id:'fullstack-ops'},201);
  assert.ok((await api('marketplace')).roles.every(r => r.installed));
  assert.ok((await api('marketplace')).teams[0].installed);
  assert.equal((await api('teams/fullstack-ops')).members.length,3);
  await api('mcp/github','DELETE',{}); await api('skills/copy-editing','DELETE',{});
  assert.deepEqual(await api('extensions'),{skills:[],mcp:[]});
});

test('space form conflict dialog keeps the parent open and applies only the selected resolution', async t => {
  const members = [{id:'a',name:'Editor',mcp:['write','docs']},{id:'b',name:'QA',mcp:['docs']}];
  const original = structuredClone(members);
  const conflicts = [{memberIndex:0,memberName:'Editor',mcpId:'write',mcpName:'Write tool'}];
  t.mock.method(globalThis,'fetch',async (_url,req) => {
    if (_url === '/api/app') return new Response(JSON.stringify({language:'en'}));
    const data = JSON.parse(req.body);
    assert.deepEqual(data,{access:'edit',members});
    return new Response(JSON.stringify({hasConflict:true,requiredAccess:'run',conflicts}));
  });
  const parent = {open:true};
  let next;
  class Dialog extends EventTarget {
    querySelector() { return null; }
    showModal() {
      assert.match(this.innerHTML,/Editor · Write tool/);
      queueMicrotask(() => this.close(next));
    }
    close(choice) { this.returnValue = choice; this.dispatchEvent(new Event('close')); }
    remove() { mounted.splice(mounted.indexOf(this),1); }
  }
  const mounted = [parent], originalDocument = globalThis.document;
  globalThis.document = {documentElement:{},querySelectorAll:() => [],createElement: () => new Dialog(),body:{append: dlg => mounted.push(dlg)}};
  t.after(() => { if (originalDocument) globalThis.document = originalDocument; else delete globalThis.document; });
  const {permissions} = await import('../public/js/library/member-tools.js');
  for (next of ['', 'remove','run']) {
    const body = {access:'edit'};
    assert.equal(await permissions(body,members),!!next);
    assert.equal(body.access,next === 'run' ? 'run' : 'edit');
    if (next === 'remove') assert.deepEqual(body.members.map(m => m.mcp),[['docs'],['docs']]);
    else assert.equal(body.members,undefined);
    assert.deepEqual(members,original);
    assert.deepEqual(mounted,[parent]); assert.equal(parent.open,true);
  }
});
