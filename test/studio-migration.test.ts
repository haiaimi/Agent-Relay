import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,randomBytes} from 'node:crypto';
import {prepareStudioWorkspace} from '../src/bridge/studio-workspace.js';
import {exportMigration,importMigration,probeMigrationProject} from '../src/bridge/studio-migration.js';
import {MigrationCache,MIGRATION_CHUNK} from '../src/shared/studio-migration.js';
import {BridgeStore} from '../src/bridge/store.js';
import {RelayStore} from '../src/relay/store.js';
import {Studio,STUDIO_ROLES,type StudioRun} from '../src/relay/studio.js';
import {validateAction,type Action,type Session} from '../src/shared/protocol.js';
import {migrationView} from '../web/studio-migration.js';
import {createRelay} from '../src/relay/server.js';
import {startBridge} from '../src/bridge/connector.js';
import {once} from 'node:events';
import {FileStore} from '../src/shared/files.js';
import {createHash} from 'node:crypto';

const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','core.fsmonitor=false','-c','user.name=Migration QA','-c','user.email=qa@localhost',...args],{cwd,windowsHide:true,timeout:30000,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(submodule=false){
  const root=mkdtempSync(join(tmpdir(),'relay-migrate-')),repo=join(root,'source'),target=join(root,'target'),data=join(root,'old-data'),newData=join(root,'new-data');mkdirSync(repo);
  git(repo,'init','-b','main');writeFileSync(join(repo,'game.txt'),'baseline\n');writeFileSync(join(repo,'.gitignore'),'cache/\n.studio/\n');git(repo,'add','.');git(repo,'commit','-m','Baseline');
  if(submodule){const child=join(root,'engine');mkdirSync(child);git(child,'init','-b','main');writeFileSync(join(child,'engine.txt'),'engine baseline');git(child,'add','.');git(child,'commit','-m','Engine');git(repo,'-c','protocol.file.allow=always','submodule','add',child,'engine');git(repo,'commit','-am','Add engine');}
  git(root,'clone',repo,target);const sourceStore=new BridgeStore(data),targetStore=new BridgeStore(newData);
  return {root,repo,target,data,newData,sourceStore,targetStore,project:{id:'game',name:'Game',path:repo},targetProject:{id:'new-game',name:'Game',path:target},close(){sourceStore.close();targetStore.close();assert.ok(root.startsWith(tmpdir()));rmSync(root,{recursive:true,force:true});}};
}
async function transfer(from:MigrationCache,to:MigrationCache){const m=from.manifest()!;to.save(m);for(const [i,r] of m.repositories.entries())for(let n=to.size(i);n<r.size;){const chunk=from.read(i,n);n=to.write(i,n,chunk.data);}await to.verify();}

test('device handoff transfers actual dirty files, ignored deliverables and engine submodules; both source and destination working changes survive',async()=>{
  const f=fixture(true);try{
    const runId=randomUUID(),id=randomUUID(),w=await prepareStudioWorkspace(f.sourceStore,f.data,f.project,0,runId);
    writeFileSync(join(w.project.path,'game.txt'),'staged');git(w.project.path,'add','game.txt');writeFileSync(join(w.project.path,'game.txt'),'staged and unstaged');
    const binary=randomBytes(MIGRATION_CHUNK+9000);writeFileSync(join(w.project.path,'asset.blend'),binary);mkdirSync(join(w.project.path,'.studio'));writeFileSync(join(w.project.path,'.studio','approved.png'),'approved ignored image');mkdirSync(join(w.project.path,'cache'));writeFileSync(join(w.project.path,'cache','skip.bin'),'rebuild cache');
    writeFileSync(join(w.project.path,'engine','engine.txt'),'dirty engine');writeFileSync(join(w.project.path,'engine','extra.txt'),'engine untracked');
    writeFileSync(join(f.target,'game.txt'),'target unsaved changes');writeFileSync(join(f.target,'keep.txt'),'keep');
    const before=git(w.project.path,'status','--porcelain=v1'),index=git(w.project.path,'diff','--cached'),head=git(w.project.path,'rev-parse','HEAD'),targetBefore=git(f.target,'status','--porcelain=v1');
    const manifest=await exportMigration(f.sourceStore,f.data,runId,id,['.studio/approved.png']);assert.equal(manifest.repositories.length,2);
    const from=new MigrationCache(f.data,id),to=new MigrationCache(f.newData,id);to.save(manifest);const first=from.read(0,0);assert.equal(to.write(0,0,first.data),MIGRATION_CHUNK);assert.equal(to.write(0,0,first.data),MIGRATION_CHUNK);await transfer(from,to);
    const restored=await importMigration(f.targetStore,f.newData,f.targetProject,runId,id);
    assert.equal(readFileSync(join(restored.project.path,'game.txt'),'utf8'),'staged and unstaged');assert.deepEqual(readFileSync(join(restored.project.path,'asset.blend')),binary);assert.equal(readFileSync(join(restored.project.path,'.studio','approved.png'),'utf8'),'approved ignored image');assert.equal(existsSync(join(restored.project.path,'cache')),false);
    assert.equal(readFileSync(join(restored.project.path,'engine','engine.txt'),'utf8'),'dirty engine');assert.equal(readFileSync(join(restored.project.path,'engine','extra.txt'),'utf8'),'engine untracked');assert.match(git(join(restored.project.path,'engine'),'branch','--show-current'),/migration/);
    assert.equal(git(w.project.path,'status','--porcelain=v1'),before);assert.equal(git(w.project.path,'diff','--cached'),index);assert.equal(git(w.project.path,'rev-parse','HEAD'),head);assert.equal(git(f.target,'status','--porcelain=v1'),targetBefore);assert.equal(readFileSync(join(f.target,'game.txt'),'utf8'),'target unsaved changes');
    assert.deepEqual(await importMigration(f.targetStore,f.newData,f.targetProject,runId,id),restored);assert.deepEqual(await exportMigration(f.sourceStore,f.data,runId,id),manifest);
  }finally{f.close();}
});

test('wrong repository and corrupt transfer cannot create a runnable worktree',async()=>{
  const f=fixture();try{
    const runId=randomUUID(),id=randomUUID();await prepareStudioWorkspace(f.sourceStore,f.data,f.project,0,runId);const m=await exportMigration(f.sourceStore,f.data,runId,id),from=new MigrationCache(f.data,id),to=new MigrationCache(f.newData,id);to.save(m);
    const chunk=from.read(0,0);to.write(0,0,chunk.data);assert.throws(()=>to.write(0,0,Buffer.alloc(Buffer.from(chunk.data,'base64').length).toString('base64')),/不一致/);assert.throws(()=>to.write(0,m.repositories[0].size+1,'AAAA'),/越界/);await transfer(from,to);
    const other=join(f.root,'other');mkdirSync(other);git(other,'init','-b','main');writeFileSync(join(other,'other.txt'),'unrelated');git(other,'add','.');git(other,'commit','-m','Other baseline');
    await assert.rejects(importMigration(f.targetStore,f.newData,{...f.targetProject,path:other},runId,id),/基线不匹配/);assert.equal(git(other,'branch','--show-current'),'main');assert.equal(f.targetStore.projects().length,0);
  }finally{f.close();}
});

test('migration protocol bounds chunks, validates identity and rejects path traversal',()=>{
  const id=randomUUID(),base={id,type:'studio-migration',migration:{id,op:'read',file:0,offset:0}};assert.equal(validateAction(base).type,'studio-migration');assert.throws(()=>validateAction({...base,migration:{...base.migration,offset:-1}}));assert.throws(()=>validateAction({...base,migration:{...base.migration,op:'write',data:'a'.repeat(MIGRATION_CHUNK*2)}}));assert.throws(()=>validateAction({...base,migration:{...base.migration,manifest:{version:1,id,runId:id,projectRelative:'../escape',repositories:[]}}}));
  assert.equal(migrationView({migration:{phase:'failed',error:'network'}}).failed,true);assert.equal(migrationView({migration:{phase:'uploading',total:10,done:5}}).progress,50);
});

test('local-only branch commits can move to a clone without pushing them first',async()=>{
  const f=fixture();try{const runId=randomUUID(),id=randomUUID(),w=await prepareStudioWorkspace(f.sourceStore,f.data,f.project,0,runId);writeFileSync(join(w.project.path,'local.txt'),'local commit');git(w.project.path,'add','local.txt');git(w.project.path,'commit','-m','Local task commit');writeFileSync(join(f.target,'destination.txt'),'target commit');git(f.target,'add','destination.txt');git(f.target,'commit','-m','Destination branch commit');const before=git(f.target,'rev-parse','HEAD');await exportMigration(f.sourceStore,f.data,runId,id);await transfer(new MigrationCache(f.data,id),new MigrationCache(f.newData,id));const restored=await importMigration(f.targetStore,f.newData,f.targetProject,runId,id);assert.equal(readFileSync(join(restored.project.path,'local.txt'),'utf8'),'local commit');assert.equal(git(f.target,'rev-parse','HEAD'),before);assert.equal(readFileSync(join(f.target,'destination.txt'),'utf8'),'target commit');}finally{f.close();}
});

test('studio hands off once, preserves approvals and histories, and retries transfer after the source goes offline',async()=>{
  const f=fixture(),relayDir=join(f.root,'relay'),store=new RelayStore(relayDir),calls:{host:string;action:Action}[]=[];let failUpload=true,sourceOnline=true;
  const oldHost={id:'old',name:'旧电脑',online:true,lastSeen:Date.now(),projects:[f.project],capabilities:{studioMigration:true,studioWorkspaces:true}},newHost={id:'new',name:'新电脑',online:true,lastSeen:Date.now(),projects:[f.targetProject],capabilities:{studioMigration:true,studioWorkspaces:true}};store.host(oldHost);store.host(newHost);
  const remote=async(host:string,a:Action)=>{
    validateAction(a);calls.push({host,action:a});if(host==='old'&&!sourceOnline)throw Error('old offline');
    if(a.type==='create-project')return {project:f.targetProject};
    if(a.type==='studio-migration'){
      const m=a.migration!,cache=new MigrationCache(host==='old'?f.data:f.newData,m.id);
      if(m.op==='probe')return probeMigrationProject(f.targetProject);
      if(m.op==='status'){cache.save(m.manifest!);return {offsets:m.manifest!.repositories.map((_,i)=>cache.size(i))};}
      if(m.op==='freeze'){for(const s of store.sessions().filter(s=>s.hostId==='old'))store.session({...s,status:'interrupted'});return {ok:true};}
      if(m.op==='export')return {manifest:await exportMigration(f.sourceStore,f.data,a.workspaceId!,m.id,m.paths)};
      if(m.op==='read')return cache.read(m.file!,m.offset!);
      if(m.op==='write'){if(failUpload&&cache.size(m.file!)>0)throw Error('simulated transfer interrupted');if(m.manifest)cache.save(m.manifest);return {offset:cache.write(m.file!,m.offset!,m.data!)};}
      const workspace=await importMigration(f.targetStore,f.newData,f.targetProject,a.workspaceId!,m.id);return {workspace,session:{id:'new:api:migration-'+m.id,hostId:'new',provider:'api',nativeId:'migration-'+m.id,projectId:workspace.project.id,cwd:workspace.project.path,updatedAt:Date.now(),title:'产物',status:'idle'}};
    }
    if(a.type==='start'){const s:Session={id:'new:codex:'+randomUUID(),hostId:'new',provider:'codex',nativeId:randomUUID(),projectId:a.projectId,cwd:f.target,title:'接力',status:'running',updatedAt:Date.now()};store.session(s);return {sessionId:s.id};}throw Error('Unexpected '+a.type);
  };
  let studio=new Studio(store,remote,host=>host!=='old'||sourceOnline,()=>{});
  const roles=STUDIO_ROLES.map(([role])=>({role,enabled:true,provider:'codex' as const,instructions:'',tools:''}));
  try{
    const p=studio.saveProject({name:'团队',hostId:'old',projectId:'game',workspaceIndex:0,roles,permissionMode:'request',concurrency:1,reviewPlan:true}),runId=randomUUID(),w=await prepareStudioWorkspace(f.sourceStore,f.data,f.project,0,runId);
    writeFileSync(join(w.project.path,'game.txt'),'unfinished implementation');writeFileSync(join(w.project.path,'model.blend'),randomBytes(MIGRATION_CHUNK*2));const sid='old:codex:'+randomUUID();store.session({id:sid,hostId:'old',provider:'codex',nativeId:randomUUID(),title:'原任务',cwd:w.project.path,projectId:w.project.id,status:'running',updatedAt:Date.now()});store.event({id:randomUUID(),sessionId:sid,hostId:'old',type:'message',data:{id:randomUUID(),role:'assistant',text:'已经实现一半，下一步检查碰撞'},at:Date.now()});
    const task=(id:string,status:any)=>({id,title:id,role:'engineering',brief:'续做',acceptance:'实际验证',dependencies:[],status});
    const r:StudioRun={id:runId,projectId:p.id,title:'迁移制作',brief:'保留批准的 C 方案',status:'executing',paused:false,planner:{...task('studio-plan','done'),approvedAt:1},tasks:[{...task('design','done'),summary:'C 方案已完成',approvedAt:123},{...task('approval','done'),kind:'visual-review',approvedAt:456,reviewId:'original-review'},{...task('implementation','running'),sessionId:sid}],workspace:{status:'ready',value:w},workflow:{kind:'general',version:2} as any,createdAt:Date.now(),updatedAt:Date.now(),revision:1,log:[]};store.db.prepare('INSERT INTO studio_runs VALUES(?,?)').run(runId,JSON.stringify(r));
    const siblingId=randomUUID(),siblingWorkspace=await prepareStudioWorkspace(f.sourceStore,f.data,f.project,0,siblingId),sibling={...r,id:siblingId,title:'原电脑上的其他需求',status:'accepted',paused:true,tasks:[],workspace:{status:'ready',value:siblingWorkspace}};store.db.prepare('INSERT INTO studio_runs VALUES(?,?)').run(siblingId,JSON.stringify(sibling));
    const req={runId,hostId:'new',path:f.target};
    store.db.exec('CREATE TABLE studio_mainline_jobs(id TEXT PRIMARY KEY,run_id TEXT,json TEXT)');store.db.prepare('INSERT INTO studio_mainline_jobs VALUES(?,?,?)').run('merge',runId,JSON.stringify({phase:'running'}));
    assert.throws(()=>studio.migrate(req),/合入/);assert.equal(calls.length,0,'handoff must not freeze a workspace during mainline integration');store.db.prepare('DELETE FROM studio_mainline_jobs WHERE id=?').run('merge');
    studio.migrate(req);studio.migrate(req);
    await waitFor(()=>studio.runs().find(r=>r.id===runId)?.migration?.phase==='failed');let current=studio.runs().find(r=>r.id===runId)!;assert.ok(current.migration?.manifest);assert.equal(current.paused,true);assert.equal(current.projectId,p.id);await assert.rejects(studio.command({runId,op:'resume'}),/迁移接力/);
    await studio.close();studio=new Studio(store,remote,host=>host!=='old'||sourceOnline,()=>{});
    failUpload=false;sourceOnline=false;studio.migrate(req);await waitFor(()=>studio.runs().find(r=>r.id===runId)?.migration?.phase==='complete');current=studio.runs().find(r=>r.id===runId)!;
    assert.equal(current.projectId,p.id);assert.equal(studio.projects().length,1);assert.equal(studio.projects()[0].hostId,'new');assert.equal(current.device?.hostId,'new');assert.deepEqual(studio.projects()[0].devices!.map(d=>d.hostId).sort(),['new','old']);assert.equal(current.tasks[0].approvedAt,123);assert.equal(current.tasks[1].reviewId,'original-review');assert.equal(current.tasks[1].approvedAt,456);assert.equal(current.tasks[2].status,'queued');assert.equal(current.tasks[2].sessionId,undefined);assert.match(current.tasks[2].migrationContext!,/检查碰撞/);assert.equal(current.tasks[2].attempts!.at(-1)!.sessionId,sid);assert.equal(readFileSync(join(current.workspace!.value!.project.path,'game.txt'),'utf8'),'unfinished implementation');
    assert.equal(existsSync(new MigrationCache(store.dir,current.migration!.id).file(0)),false,'relay must remove temporary bundles after successful handoff');
    assert.equal(calls.filter(c=>c.action.migration?.op==='export').length,1);assert.equal(calls.filter(c=>c.action.type==='start').length,0);
    assert.equal(calls.filter(c=>c.action.migration?.op==='write'&&c.action.migration.offset===0).length,1,'retry must resume after the acknowledged first chunk');
    const untouched=studio.runs().find(r=>r.id===siblingId)!;assert.equal(untouched.projectId,p.id);assert.equal(untouched.device?.hostId,'old');assert.equal(studio.projectForRun(untouched).hostId,'old');assert.equal(untouched.workspace!.value!.project.path,siblingWorkspace.project.path);
    await studio.tick();await new Promise(r=>setTimeout(r,20));assert.equal(calls.filter(c=>c.action.type==='start').length,1);assert.match(calls.find(c=>c.action.type==='start')!.action.text!,/跨电脑接力/);assert.match(calls.find(c=>c.action.type==='start')!.action.text!,/检查碰撞/);
  }finally{await studio.close();store.close();f.close();}
});
async function waitFor(predicate:()=>boolean){for(let n=0;n<300;n++){if(predicate())return;await new Promise(r=>setTimeout(r,20));}assert.fail('migration did not settle');}

test('authenticated HTTP and real bridge WebSockets migrate a delivered demand and keep its previews accessible on the new host',async()=>{
  const f=fixture(),phone='qa-phone-'+randomUUID(),token='qa-bridge-'+randomUUID(),app=createRelay({dataDir:join(f.root,'http-relay'),phoneToken:phone,bridgeToken:token});let oldBridge:ReturnType<typeof startBridge>|undefined,newBridge:ReturnType<typeof startBridge>|undefined;
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base='http://127.0.0.1:'+(app.server.address() as any).port;let cookie='';
  const request=async(path:string,payload?:unknown)=>{const response=await fetch(base+path,{method:payload?'POST':'GET',headers:{cookie,...payload?{Origin:base,'Content-Type':'application/json'}:{}},body:payload?JSON.stringify(payload):undefined});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie')!.split(';')[0];return response;};
  try{
    assert.equal((await request('/api/studio/migrate',{})).status,401);await request('/api/login',{token:phone});
    const runId=randomUUID(),w=await prepareStudioWorkspace(f.sourceStore,f.data,f.project,0,runId),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');writeFileSync(join(w.project.path,'concept.png'),png);writeFileSync(join(w.project.path,'game.txt'),'delivered changes');
    const sid='old:api:'+randomUUID();f.sourceStore.save({id:sid,hostId:'old',provider:'api',nativeId:sid.split(':').at(-1)!,projectId:w.project.id,cwd:w.project.path,title:'已完成设计',status:'idle',managed:true,updatedAt:Date.now()});
    const config={relayUrl:base.replace('http','ws')+'/bridge',name:'QA',discoverCodexProjects:false,syncHistory:false,codexHome:join(f.root,'empty-codex'),claudeHome:join(f.root,'empty-claude')};
    oldBridge=startBridge({...config,hostId:'old',dataDir:f.data,projects:[f.project]},token);newBridge=startBridge({...config,hostId:'new',dataDir:f.newData,projects:[f.targetProject]},token);
    await waitFor(()=>app.store.hosts().length===2);assert.ok(app.store.hosts().every(h=>h.capabilities?.studioMigration));
    const roles=STUDIO_ROLES.map(([role])=>({role,enabled:true,provider:'codex',instructions:'',tools:''})),p=app.studio.saveProject({name:'HTTP 团队',hostId:'old',projectId:'game',workspaceIndex:0,roles,permissionMode:'request',concurrency:1,reviewPlan:true});
    const referenceBytes=Buffer.from('producer reference document'),reference={id:randomUUID(),name:'reference.txt',mime:'application/octet-stream',size:referenceBytes.length,sha256:createHash('sha256').update(referenceBytes).digest('hex')};oldBridge.runtime.files.put('old|'+sid,reference,referenceBytes);const relayFiles=new FileStore(join(f.root,'http-relay'),app.store.db);relayFiles.register('old|'+sid,reference);relayFiles.link('old|'+sid,'studio:'+runId,reference.id);
    const t={id:'concept',title:'已确认设计',role:'concept',brief:'设计',acceptance:'实际原画',dependencies:[],status:'done' as const,sessionId:sid,artifacts:[{path:'concept.png',description:'已批准原画'}],approvedAt:123};
    const r:StudioRun={id:runId,projectId:p.id,title:'已交付成果迁移',brief:'保留原画',status:'accepted',paused:false,planner:{...t,id:'studio-plan'},tasks:[t],delivery:{...t,id:'studio-delivery'},attachments:[reference],workspace:{status:'ready',value:w},workflow:{kind:'general',version:2} as any,createdAt:Date.now(),updatedAt:Date.now(),revision:1,log:[]};app.store.db.prepare('INSERT INTO studio_runs VALUES(?,?)').run(runId,JSON.stringify(r));
    const accepted=await request('/api/studio/migrate',{runId,hostId:'new',path:f.target});assert.equal(accepted.status,202);await accepted.json();
    await waitFor(()=>['complete','failed'].includes(app.studio.runs()[0]?.migration?.phase??''));const current=app.studio.runs()[0];assert.equal(current.migration?.phase,'complete',current.migration?.error);assert.equal(current.status,'accepted');assert.equal(current.tasks[0].approvedAt,123);
    const image=await request('/api/studio/artifact?'+new URLSearchParams({runId,taskId:'concept',index:'0'}));assert.equal(image.status,200,await image.clone().text());assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
    assert.deepEqual(newBridge.runtime.files.read('new|project:'+w.project.id,reference.id).bytes,referenceBytes);assert.deepEqual(relayFiles.read('studio:'+runId,reference.id).bytes,referenceBytes);assert.equal(app.studio.projects().length,1);assert.equal(current.projectId,p.id);
    await assert.rejects(oldBridge.runtime.handle({id:randomUUID(),type:'start',projectId:w.project.id,provider:'codex',text:'must never start'}),/冻结/);
    assert.equal((await request('/api/actions',{id:randomUUID(),type:'studio-migration',projectId:'game',workspaceId:runId,migration:{id:current.migration!.id,op:'probe'}})).status,400);
    assert.equal(readFileSync(join(f.target,'game.txt'),'utf8'),'baseline\n');assert.equal(readFileSync(join(current.workspace!.value!.project.path,'game.txt'),'utf8'),'delivered changes');
  }finally{await oldBridge?.close();await newBridge?.close();await app.close();f.close();}
});
