import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {RelayStore} from '../src/relay/store.js';import {RelayRepairs} from '../src/relay/repairs.js';import {StudioAttention} from '../src/relay/studio-attention.js';import {validateAction,type Action} from '../src/shared/protocol.js';
import {createRelay} from '../src/relay/server.js';import {once} from 'node:events';
function fixture(hook?:(a:Action)=>Promise<any>){
 const dir=mkdtempSync(join(tmpdir(),'relay-repairs-')),store=new RelayStore(dir),calls:Action[]=[];let online=true;
 store.host({id:'repair-host',name:'修复电脑',online:true,lastSeen:Date.now(),projects:[{id:'agent-relay',name:'Agent Relay',path:dir},{id:'game',name:'Game',path:dir+'/game'}],agents:[{id:'codex',provider:'codex',name:'Codex'}],capabilities:{studioWorkspaces:true}});
 const run:any={id:'original',projectId:'game-team',title:'游戏制作',status:'executing',revision:9,paused:false,planner:{id:'planner',status:'done',role:'director'},tasks:[{id:'concept',title:'原画',role:'concept',status:'blocked',error:'原画阶段缺少实际图片，Bearer private-token password=topsecret',blockers:[],sessionId:'game-host:codex:original',dependencies:[]}],log:[],workspace:{value:{project:{id:'game-work',path:dir+'/protected-game'},branch:'game-branch'}},workflow:{selection:{approvals:{visual:true}}}};
 const studio:any={runs:()=>[run],projects:()=>[{id:'game-team',hostId:'game-host'}]};
 store.session({id:'game-host:codex:original',hostId:'game-host',nativeId:'original',provider:'codex',projectId:'game-work',cwd:dir+'/protected-game',title:'原画',status:'idle',updatedAt:Date.now()});
 const remote=async(_host:string,a:Action)=>{calls.push(a);validateAction(a);if(hook)return hook(a);if(a.type==='prepare-workspace')return {workspace:{runId:a.workspaceId,project:{id:'studio-'+a.workspaceId,path:dir+'/'+a.workspaceId,name:'Relay repair'},branch:'codex/studio-'+a.workspaceId,sourcePath:dir,sourceBranch:'feature',head:'a'.repeat(40),createdAt:Date.now(),untrackedFiles:0,trackedSnapshot:false}};if(a.type==='start'){const sid='repair-host:codex:'+randomUUID();store.session({id:sid,hostId:'repair-host',nativeId:sid,provider:'codex',projectId:a.projectId,cwd:dir+'/repair',title:'Relay 修复',status:'running',managed:true,updatedAt:Date.now()});return {sessionId:sid};}return {};};
 let repairs=new RelayRepairs(store,studio,remote,()=>online,()=>{});
 const create=(options:any={})=>repairs.create({id:randomUUID(),runId:'original',taskId:'concept',hostId:'repair-host',projectId:'agent-relay',permissionMode:'request',push:true,deploy:false,...options});
 const settle=async()=>{await repairs.tick();await new Promise(r=>setTimeout(r,10));await repairs.tick();};
 const finish=(job:any,result:any)=>{const s=store.getSession(job.sessionId)!;store.event({id:randomUUID(),hostId:s.hostId,sessionId:s.id,type:'message',at:Date.now(),data:{id:randomUUID(),role:'assistant',text:'```RELAY_REPAIR_RESULT\n'+JSON.stringify({outcome:'fixed',cause:'状态读取超时未区分投递',summary:'修复状态反馈',branch:job.workspace.branch,commits:['b'.repeat(40)],checks:['实际回归通过'],pushed:true,deployed:false,next:'原任务按真实交付继续',...result})+'\n```'}});store.session({...s,status:'idle'});};
 return {dir,store,run,studio,calls,remote,get repairs(){return repairs;},create,settle,finish,setOnline:(v:boolean)=>online=v,async restart(){await repairs.close();repairs=new RelayRepairs(store,studio,remote,()=>online,()=>{});},async close(){await repairs.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('repair creates one isolated Codex writer, preserves game state, redacts diagnostics, and commits on its own branch',async()=>{
 const f=fixture();try{
  const before=JSON.stringify(f.run),id=randomUUID(),first=f.create({id,client:{error:'signal timed out',note:'BRIDGE_TOKEN=hidden'}});assert.equal(first.repair.id,id);
  assert.equal(f.create({id}).reused,true);assert.equal(f.create().repair.id,id);await f.settle();const job=f.repairs.list()[0];assert.equal(job.phase,'running');assert.equal(f.calls.length,2);assert.deepEqual(f.calls.map(a=>a.type),['prepare-workspace','start']);const start=f.calls[1];assert.equal(start.provider,'codex');assert.equal(start.projectId,'studio-'+id);assert.equal(start.permissionMode,'request');assert.match(start.text!,/不得靠删除质量检查/);assert.match(start.text!,/不要部署/);assert.match(start.text!,/git push -u origin HEAD/);assert.doesNotMatch(start.text!,/private-token|topsecret|BRIDGE_TOKEN=hidden/);assert.match(start.text!,/原画阶段缺少实际图片/);assert.equal(JSON.stringify(f.run),before);
  f.finish(job,{});await f.settle();assert.equal(f.repairs.list()[0].phase,'completed');assert.equal(f.repairs.list()[0].result.commits[0],'b'.repeat(40));assert.equal(JSON.stringify(f.run),before);await f.restart();await f.settle();assert.equal(f.calls.length,2);assert.equal(f.repairs.list()[0].phase,'completed');
 }finally{await f.close();}
});
test('repair rejects game targets and validates completion rather than treating idle as success',async()=>{
 const f=fixture();try{
  assert.throws(()=>f.create({projectId:'game'}),/Agent Relay/);f.create({deploy:true});await f.settle();const job=f.repairs.list()[0];assert.match(f.calls[1].text!,/用户已勾选修复后部署/);f.finish(job,{commits:[],checks:[],pushed:false,deployed:false});await f.settle();assert.equal(f.repairs.list()[0].phase,'blocked');assert.match(f.repairs.list()[0].error!,/尚未完成/);
  f.finish(job,{outcome:'no-change',cause:'真实交付缺少图片，不是 Relay 缺陷',commits:[],checks:[],pushed:false,deployed:false});await f.settle();assert.equal(f.repairs.list()[0].phase,'completed');assert.equal(f.repairs.list()[0].result.outcome,'no-change');
 }finally{await f.close();}
});
test('a blocked repair report stays stable across polling, and interrupted sessions cannot report completion',async()=>{
 const f=fixture();try{
  f.create();await f.settle();const job=f.repairs.list()[0];f.finish(job,{outcome:'blocked',cause:'需要补充复现',commits:[],checks:[],pushed:false});await f.settle();const saved=f.repairs.list()[0].updatedAt;await new Promise(r=>setTimeout(r,10));await f.repairs.tick();assert.equal(f.repairs.list()[0].updatedAt,saved);
  f.finish(job,{});const session=f.store.getSession(job.sessionId!)!;f.store.session({...session,status:'interrupted'});await f.settle();assert.equal(f.repairs.list()[0].phase,'blocked');assert.match(f.repairs.list()[0].error!,/已中断/);
 }finally{await f.close();}
});
test('ambiguous dispatch survives restart without retry; matching sessions require explicit verified binding',async()=>{
 let pendingResolve:(v:any)=>void=()=>{};const f=fixture(a=>new Promise(resolve=>pendingResolve=resolve));try{
  f.create();assert.equal(f.calls.length,1);pendingResolve({});await f.settle();const job=f.repairs.list()[0];assert.equal(job.phase,'unknown');await f.restart();await f.settle();assert.equal(f.calls.length,1);assert.equal(f.create().repair.id,job.id);assert.throws(()=>f.repairs.bind({id:job.id,sessionId:'game-host:codex:original'}),/核对/);assert.throws(()=>f.repairs.resolve({id:job.id}),/核对/);f.repairs.resolve({id:job.id,confirmedNotStarted:true});assert.equal(f.repairs.list()[0].phase,'blocked');
 }finally{await f.close();}
});
test('offline preparation retries only before dispatch with a one minute interval and five attempts',async()=>{
 const f=fixture(),originalNow=Date.now;let now=originalNow();try{
  Date.now=()=>now;f.setOnline(false);f.create();assert.equal(f.repairs.list()[0].attempts,1);await f.repairs.tick();assert.equal(f.repairs.list()[0].attempts,1);
  for(let i=0;i<4;i++){now+=60000;await f.repairs.tick();}assert.equal(f.repairs.list()[0].phase,'blocked');assert.equal(f.repairs.list()[0].attempts,5);assert.equal(f.calls.length,0);now+=60000;await f.repairs.tick();assert.equal(f.calls.length,0);
 }finally{Date.now=originalNow;await f.close();}
});
test('repair questions from its separate repository appear inline without admitting unrelated sessions',async()=>{
 const f=fixture();let attention:StudioAttention|undefined;try{
  f.create();await f.settle();const job=f.repairs.list()[0],s=f.store.getSession(job.sessionId!)!;f.store.session({...s,status:'waiting',questionCount:1});const card={id:randomUUID(),sessionId:s.id,status:'pending',createdAt:Date.now(),questions:[{id:'q',question:'是否允许执行测试？',header:'测试',options:[],allowOther:true}]};f.store.event({id:randomUUID(),hostId:s.hostId,sessionId:s.id,type:'question',data:card,at:Date.now()});
  attention=new StudioAttention(f.store,f.studio,async()=>({questions:[],questionsAsOf:Date.now()}),()=>{},()=>true,id=>f.repairs.sessionsFor(id));const entries=attention.read('original').entries;assert.equal(entries.length,1);assert.equal(entries[0].sessionId,s.id);assert.equal(entries[0].role,'relay-repair');assert.equal(entries[0].questions[0].id,card.id);
 }finally{await attention?.close();await f.close();}
});
test('repair endpoints authenticate, return durable queued receipts promptly, and deduplicate repeated creation',async()=>{
 const f=fixture(),dir=mkdtempSync(join(tmpdir(),'relay-repair-http-')),token='repair-http-phone-token-123456789',app=createRelay({dataDir:dir,phoneToken:token,bridgeToken:'repair-http-bridge-token-123456789'});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const origin='http://127.0.0.1:'+(app.server.address() as any).port;
 try{
  app.store.host(f.store.hosts()[0]);app.store.db.prepare('INSERT INTO studio_projects VALUES(?,?)').run('game-team',JSON.stringify({id:'game-team',hostId:'game-host',name:'Game',roles:[]}));app.store.db.prepare('INSERT INTO studio_runs VALUES(?,?)').run(f.run.id,JSON.stringify(f.run));
  const path='/api/studio/repairs?runId=original&taskId=concept';assert.equal((await fetch(origin+path)).status,401);const login=await fetch(origin+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token})}),cookie=login.headers.get('set-cookie')!.split(';')[0],headers={Origin:origin,Cookie:cookie,'Content-Type':'application/json'};
  const get=await fetch(origin+path,{headers});assert.equal(get.status,200);const state:any=await get.json();assert.match(state.diagnosis.summary,/原画阶段缺少实际图片/);assert.match(state.version,/^[a-f0-9]{64}$/);const embedded=await (await fetch(origin+'/studio?embedded=1')).text();assert.ok(embedded.includes('name="relay-ui-version" content="'+state.version+'"'));
  const body=JSON.stringify({id:randomUUID(),runId:'original',taskId:'concept',hostId:'repair-host',projectId:'agent-relay',push:true,deploy:false});for(let i=0;i<2;i++){const r=await fetch(origin+'/api/studio/repairs',{method:'POST',headers,body});assert.equal(r.status,202);assert.ok((await r.json() as any).repair.id);}assert.equal(app.repairs.list().length,1);assert.equal(f.calls.length,0);assert.equal((await fetch(origin+'/studio-repairs.js')).status,200);
 }finally{await app.close();await f.close();rmSync(dir,{recursive:true,force:true});}
});
