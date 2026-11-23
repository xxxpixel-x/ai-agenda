import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRoleLibrary } from '../src/roles.mjs';
import { BUILTIN_ROLES, CURATED_MARKETPLACE } from '../src/library-data.mjs';
import { normalizeMembers, MAX_PERSONA } from '../src/members.mjs';
import { makeSpace, tempDir, libraryHttp } from './helpers.mjs';

const catalog = CURATED_MARKETPLACE;
const engines = [{ id: 'pi', ready: true, defaultName: 'Pi' }, { id: 'claude-code', status: { ready: true } }, { id: 'codex', ready: false }];
const fixture = t => {
  const root = tempDir(t), lib = createRoleLibrary(root);
  return { root, lib, file: name => path.join(root, 'roles',name) };
};

test('seven bilingual role cards load exactly one language from disk and reference installable tools', t => {
  const { lib,file } = fixture(t);
  assert.deepEqual(lib.listRoles('en').map(r => r.id), ['frontend','backend','qa','product','reviewer','editor','researcher']);
  for (const r of BUILTIN_ROLES) {
    for (const lang of ['zh','en']) assert.equal(fs.readFileSync(file(r.id + '.' + lang + '.md'),'utf8'),r.instructions[lang]);
    assert.equal(lib.getRole(r.id,'zh').instructions,r.instructions.zh);
    assert.doesNotMatch(lib.getRole(r.id,'en').instructions,/[\u3400-\u9fff]/);
    assert.ok(['pi','codex','claude-code'].includes(r.suggestedEngine));
    assert.equal(r.model,undefined);
    for (const x of r.recommendedSkills) assert.ok(catalog.skills.some(s => s.id === x.id && s.template));
    for (const x of r.recommendedMcp) assert.ok(catalog.mcp.some(s => s.id === x.id && s.mode === x.mode));
  }
  fs.unlinkSync(file('frontend.en.md'));
  assert.equal(lib.listRoles('zh').length,7);
  assert.throws(() => lib.listRoles('en'),{code:'ENOENT'});
  assert.equal(lib.getRoleInstructions('absent','en'),null);
});

test('upgrades refresh built-in files and preserve overrides, metadata and independent defaults', t => {
  const { root,lib,file } = fixture(t);
  const original = lib.getRole('frontend','en');
  const pref = { engine:'codex',source:'personal',model:'fixture',effort:'high' };
  assert.equal(lib.setRoleDefault('frontend',pref).customized,false);
  lib.updateRole('frontend',{name:'Interface',instructions:'Only my version'});
  assert.equal(fs.readFileSync(file('frontend.custom.md'),'utf8'),'Only my version');
  assert.equal(fs.readFileSync(file('frontend.en.md'),'utf8'),original.instructions);
  fs.writeFileSync(file('frontend.en.md'),'obsolete edition');
  const restored = createRoleLibrary(root);
  for (const lang of ['zh','en']) assert.equal(restored.getRole('frontend',lang).instructions,'Only my version');
  assert.deepEqual(restored.getRole('frontend').myDefault,pref);
  restored.resetRole('frontend');
  assert.equal(fs.existsSync(file('frontend.custom.md')),false);
  assert.equal(restored.getRole('frontend','en').instructions,original.instructions);
  assert.deepEqual(restored.getRole('frontend').myDefault,pref);
  assert.equal(restored.setRoleDefault('frontend',null).myDefault,null);
});

test('member drafts select available AI, personal preferences, unique names and installed recommendations', t => {
  const {lib} = fixture(t);
  const options = {lang:'en',existingNames:['FrontendEngineer'],installedSkillIds:[],installedMcpIds:['context7']};
  let draft = lib.resolveRoleToMember('frontend',engines,options);
  assert.equal(draft.engine,'claude-code'); assert.equal(draft.name,'Frontend Engineer2');
  assert.deepEqual(draft.skills,[]); assert.deepEqual(draft.mcp,['context7']);
  assert.equal(draft.persona,lib.getRoleInstructions('frontend','en')); assert.equal(draft.roleCustomized,false);
  assert.equal(lib.resolveRoleToMember('backend',engines).engine,'pi');
  assert.equal(lib.resolveRoleToMember('backend',[{id:'x'}]).engine,'x');
  lib.setRoleDefault('frontend',{engine:'codex',model:'mine',effort:'low',source:'my-source'});
  draft = lib.resolveRoleToMember('frontend',engines);
  assert.deepEqual([draft.engine,draft.source,draft.model,draft.effort],['codex','my-source','mine','low']);
  assert.equal(lib.resolveRoleToMember('frontend',engines.slice(0,2)).model,'');
  assert.equal(lib.setRoleDefault('frontend',{engine:''}).myDefault,null);
});

test('custom cards, bilingual imports and team snapshots persist through restart', t => {
  const {root,lib,file} = fixture(t);
  const member = { name:'Copy desk',engine:'codex',persona:'Revise only headings.', model:'local-model', skills:['copy-editing'],mcp:['fetch'] };
  const card = lib.createRole(member);
  assert.equal(card.instructions,member.persona); assert.equal(card.recommendedSkills[0].id,member.skills[0]);
  assert.equal(lib.createRole(member).id,'copy-desk-2');
  assert.throws(() => lib.resetRole(card.id)); assert.throws(() => lib.deleteRole('editor'));
  assert.throws(() => lib.createRole({...member,id:'../escape'}));
  assert.throws(() => lib.createRole({...member,id:'__PROTO__'}));
  assert.throws(() => lib.createRole({...member,id:'frontend.custom'}));
  assert.throws(() => lib.createRole({...member,instructions:'a'.repeat(16001)}));
  assert.throws(() => lib.createRole({...member,skills:[{id:'../bad'}]}));
  const paired = lib.createRole({...member,name:'Pair',instructions:{zh:'文字',en:'Words'}});
  assert.equal(lib.getRole(paired.id,'zh').instructions,'文字');
  assert.equal(lib.updateRole(paired.id,{instructions:'Custom'}).instructions,'Custom');
  lib.setRoleDefault(paired.id,{engine:'pi'});
  lib.deleteRole(paired.id);
  for (const ext of ['.md','.zh.md','.en.md']) assert.ok(!fs.existsSync(file(paired.id + ext)));
  assert.equal(JSON.parse(fs.readFileSync(file('index.json'))).defaults[paired.id],undefined);

  const web = lib.getTeam('web-dev','en');
  assert.deepEqual(web.roleIds,['frontend','backend','qa']); assert.equal(web.members[web.coordinatorIndex].roleId,'frontend');
  const team = lib.createTeam({name:'Writing',coordinatorIndex:1,members:[{roleId:'editor'},member]});
  assert.equal(team.members[0].reference,true);
  assert.equal(team.members[1].persona,member.persona); assert.equal(team.members[1].model,'local-model');
  assert.deepEqual(createRoleLibrary(root).getTeam(team.id,'en'),lib.getTeam(team.id,'en'));
  lib.updateTeam('web-dev',{roleIds:['product','qa'],coordinatorRoleId:'qa'});
  assert.equal(lib.getTeam('web-dev').coordinatorIndex,1);
  assert.deepEqual(lib.resetTeam('web-dev').roleIds,web.roleIds);
  assert.throws(() => lib.deleteTeam('web-dev')); assert.throws(() => lib.resetTeam(team.id));
  assert.throws(() => lib.createTeam({name:'Missing',roleIds:['missing']}));
  assert.throws(() => lib.createTeam({name:'Bad',roleIds:['qa'],coordinatorIndex:1}));
  lib.updateTeam(team.id,{roleIds:[card.id],coordinatorIndex:0});
  lib.deleteRole(card.id);
  assert.equal(lib.getTeam(team.id).members[0].persona,member.persona);
  assert.equal(lib.getTeam(team.id).members[0].roleId,undefined);
  lib.deleteTeam(team.id);
  assert.equal(lib.getTeam(team.id),null); assert.equal(lib.getRole(card.id),null);
});

test('Markdown sharing uses an allowlist, previews without writes and imports self-contained teams on conflict', t => {
  const {lib,file} = fixture(t);
  const extra = Object.fromEntries(['apiKey','secret','token','env','headers','access','permissions','messages','chatHistory'].map(key=>[key,'FORBIDDEN']));
  const member = {name:'A reviewer',engine:'codex',persona:'## Role: not another member\n\nReview this.',skills:['code-review'],mcp:['fetch'],...extra};
  const team = lib.createTeam({name:'Desk',members:[member,{roleId:'editor'}],coordinatorIndex:1,...extra});
  const md = lib.exportTeamMarkdown(team.id,'en');
  assert.match(md,/agenda_export: team/); assert.match(md,/## Role: A reviewer/); assert.doesNotMatch(md,/FORBIDDEN/);
  const malicious = md.replaceAll('---\nid:', '---\nheaders: {"authorization":"FORBIDDEN"}\nid:').replace('version: 1','version: 1\naccess: full\nmessages: ["FORBIDDEN"]');
  const before = fs.readFileSync(file('index.json'),'utf8');
  const p = lib.previewImportMarkdown(malicious);
  assert.equal(fs.readFileSync(file('index.json'),'utf8'),before);
  assert.equal(p.roles.length,2); assert.equal(p.team.coordinatorIndex,1); assert.equal(p.conflicts.length,2);
  assert.doesNotMatch(JSON.stringify(p),/FORBIDDEN/);
  const imported = lib.commitImportMarkdown(malicious);
  assert.notEqual(team.id,imported.team.id); assert.equal(imported.team.members[0].persona,member.persona);
  assert.equal(imported.team.members[1].persona,lib.getRoleInstructions('editor','en'));
  assert.notEqual(imported.roles[1].id,'editor');
  const card = lib.createRole({...member,id:'example',recommendedSkills:[{id:'code-review',...extra}]});
  const roleMd = lib.exportRoleMarkdown(card.id,'en');
  assert.doesNotMatch(roleMd,/FORBIDDEN/);
  const replacement = lib.commitImportMarkdown(roleMd.replace('Review this.','New instructions.'),{overwrite:true});
  assert.equal(replacement.roles[0].id,card.id); assert.match(replacement.roles[0].instructions,/New instructions/);
  assert.notEqual(lib.commitImportMarkdown(lib.exportRoleMarkdown('editor','en'),{overwrite:true}).roles[0].id,'editor');
  assert.throws(() => lib.commitImportMarkdown(md.replace('coordinator_index: 1','coordinator_index: 50')));
  assert.throws(() => lib.commitImportMarkdown(md.replace('version: 1','version: 2')));
});

test('failed team installs roll back dependency cards and files and can be retried', t => {
  const {lib,file,root} = fixture(t);
  const team = {...catalog.teams[0],roleIds:['architect','unknown']};
  assert.throws(() => lib.installCatalogTeam(team,catalog.roles));
  assert.equal(lib.getRole('architect'),null);
  assert.equal(fs.existsSync(file('architect.en.md')),false);
  assert.equal(createRoleLibrary(root).getRole('architect'),null);
  assert.equal(lib.installCatalogTeam(catalog.teams[0],catalog.roles).id,team.id);
});

test('importing repeated roles reserves later member IDs before assigning conflict suffixes', t => {
  const {lib} = fixture(t);
  const team = lib.createTeam({name:'Review pair',members:[{roleId:'qa'},
    {name:'Checklist',roleId:'qa',roleCustomized:true,engine:'codex',persona:'Check the layout.'}]});
  const result = lib.commitImportMarkdown(lib.exportTeamMarkdown(team.id,'en'),{overwrite:true});
  assert.deepEqual(result.team.roleIds,['qa-3','qa-2']);
  assert.equal(result.team.members[0].persona,lib.getRoleInstructions('qa','en'));
  assert.equal(result.team.members[1].persona,'Check the layout.');
});

test('normalization bounds tool IDs and persona, and mounting changes invalidate a session', t => {
  const tools = Array.from({length:24},(_,i) => 's' + i);
  const [m] = normalizeMembers([{engine:'pi',persona:'a'.repeat(16001),roleId:'qa',skills:['../bad',null,tools[0],...tools],mcp:['fetch','fetch']}],engines);
  assert.equal(m.persona.length,MAX_PERSONA); assert.deepEqual(m.skills,tools.slice(0,20)); assert.deepEqual(m.mcp,['fetch']); assert.equal(m.roleCustomized,false);
  const [legacy] = normalizeMembers([{engine:'pi',roleId:'/bad',skills:{}}],engines);
  for (const k of ['roleId','roleCustomized','skills','mcp']) assert.ok(!(k in legacy));
  const sp = makeSpace(tempDir(t)); const [a,b] = sp.data.members;
  for (const k of ['skills','mcp']) {
    sp.data.memberState[a.id] = {sessionId:'old'}; sp.data.memberState[b.id] = {sessionId:'keep'};
    sp.update({members:[{...a,[k]:['fixture']},b]});
    assert.equal(sp.data.memberState[a.id],undefined); assert.equal(sp.data.memberState[b.id].sessionId,'keep');
  }
});

test('language sync defers until idle, applies the last request and preserves edited or finished members', t => {
  const root = tempDir(t), lib = createRoleLibrary(root), sp = makeSpace(root);
  const [a,b] = sp.data.members;
  Object.assign(a,{roleId:'qa',persona:'initial'}); Object.assign(b,{roleId:'qa',roleCustomized:true,persona:'Mine'});
  sp.data.memberState[a.id] = {sessionId:'old'}; sp.data.memberState[b.id] = {sessionId:'keep'};
  sp.chat.running = true;
  for (const lang of ['zh','en']) assert.deepEqual(sp.syncRoleLanguage(lib,lang),{updated:0,deferred:true});
  assert.equal(a.persona,'initial');
  sp.chat.running = false; sp.emitEvent({type:'round_end'});
  assert.equal(a.persona,lib.getRoleInstructions('qa','en')); assert.equal(b.persona,'Mine');
  assert.equal(sp.data.memberState[a.id],undefined); assert.equal(sp.data.memberState[b.id].sessionId,'keep');
  sp.data.kind = 'task'; sp.run = {active:true,data:{closed:false}};
  assert.ok(sp.syncRoleLanguage(lib,'zh').deferred);
  sp.run.active = false; sp.emitEvent({type:'run'});
  assert.equal(a.persona,lib.getRoleInstructions('qa','zh'));
  sp.run.data.closed = true;
  assert.equal(sp.syncRoleLanguage(lib,'en').updated,0);
});

test('library HTTP CRUD, export, import and settings language change through normal entry points', async t => {
  const { api: req } = await libraryHttp(t);
  const api = (route,...args) => req('library/' + route,...args);
  assert.equal((await api('roles')).length,7); assert.equal((await api('teams')).length,3);
  const zh = await api('roles/qa');
  await api('roles/qa/default','PUT',{engine:'codex',effort:'high'});
  const draft = await api('roles/qa/resolve','POST',{});
  const sp = await req('spaces','POST',{members:[draft,{...draft,name:'Edited',persona:'Mine',roleCustomized:true}]});
  await req('settings','PUT',{language:'en'});
  const changed = await req('spaces/' + sp.id);
  assert.notEqual(changed.members[0].persona,zh.instructions); assert.equal(changed.members[0].persona,(await api('roles/qa')).instructions);
  assert.equal(changed.members[1].persona,'Mine');
  await api('roles/qa','PATCH',{instructions:'Override'}); await api('roles/qa/reset','POST',{});
  const role = await api('roles','POST',{name:'Fixture',instructions:'Notes'},201);
  const markdown = await api('roles/' + role.id + '/export');
  assert.equal((await api('import/preview','POST',{markdown})).kind,'role');
  await api('import/commit','POST',{markdown});
  const team = await api('teams','POST',{name:'Fixture team',roleIds:[role.id]},201);
  await api('teams/' + team.id,'PATCH',{name:'Changed'});
  await api('teams/web-dev','PATCH',{name:'Custom'}); await api('teams/web-dev/reset','POST',{});
  assert.match(await api('teams/' + team.id + '/export'),/agenda_export: team/);
  await api('teams/' + team.id,'DELETE',{}); await api('roles/' + role.id,'DELETE',{});
  await api('roles/' + role.id,'GET',undefined,404);
});
