import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {StudioLauncher} from '../src/bridge/studio-launcher.js';
import {StudioPlaytests} from '../src/relay/studio-playtests.js';
import {launchTargets} from '../src/shared/playtests.js';
import {validateAction,type Action} from '../src/shared/protocol.js';
import {createRelay} from '../src/relay/server.js';
import {RelayStore} from '../src/relay/store.js';

const pause=(n:number)=>new Promise(r=>setTimeout(r,n));
test('launch entries are structured workspace-relative paths, never browser shell commands',()=>{
 const t={id:'functional',kind:'functional',title:'白模',script:'project/Play.ps1',cwd:'.',scene:'res://tests/3c.tscn',controls:'按现有输入操作'};
 assert.equal(launchTargets([t])[0].script,t.script);for(const script of ['../source/run.ps1','C:\\source\\run.ps1','/source/run.sh','project/run.exe'])assert.throws(()=>launchTargets([{...t,script}]));
 assert.throws(()=>launchTargets([t,t]));assert.throws(()=>validateAction({id:randomUUID(),type:'send',sessionId:'h:s',text:'x',launch:{op:'start',target:t}}));
 assert.throws(()=>validateAction({id:randomUUID(),type:'studio-launch',sessionId:'h:s',workspaceId:randomUUID(),launch:{op:'start',target:t,hash:'bad'}}));
});

test('local launcher verifies workspace/script identity and deduplicates real process starts',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-launcher-')),data=join(dir,'data'),root=join(dir,'work'),source=join(dir,'source');for(const p of [data,root,source])mkdirSync(p);const rid=randomUUID(),sid='h:codex:one';
 const db=new DatabaseSync(join(data,'bridge.sqlite'));db.exec('CREATE TABLE studio_workspaces(id TEXT PRIMARY KEY,json TEXT);CREATE TABLE sessions(id TEXT PRIMARY KEY,json TEXT)');db.prepare('INSERT INTO studio_workspaces VALUES(?,?)').run(rid,JSON.stringify({runId:rid,project:{id:'studio-'+rid,path:root},sourcePath:source,branch:'test'}));db.prepare('INSERT INTO sessions VALUES(?,?)').run(sid,JSON.stringify({projectId:'studio-'+rid}));db.close();
 const windows=process.platform==='win32',file=windows?'Play.ps1':'Play.sh';
 writeFileSync(join(root,file),windows?`Add-Content -LiteralPath '${join(root,'starts.txt').replaceAll("'","''")}' -Value 'start'\n@{pid=$PID;workspace=$env:AGENT_RELAY_WORKSPACE;scene='res://tests/functional.tscn';ready=$true}|ConvertTo-Json|Set-Content -LiteralPath $env:AGENT_RELAY_LAUNCH_RECEIPT -Encoding UTF8\nStart-Sleep -Seconds 2\n`:`echo start >> '${join(root,'starts.txt')}'\nsleep 2\n`);
 const target=launchTargets([{id:'functional',kind:'functional',title:'本机测试脚本',script:file,cwd:'.',scene:'res://tests/functional.tscn',controls:'测试'}])[0];let starts=0;let ownedChild:any;
 const launcher=new StudioLauncher(data,'h',{verifyBranch:()=>{},spawn:((...args:any[])=>{starts++;ownedChild=(spawn as any)(...args);return ownedChild;}) as typeof spawn});
 const action=(op:'inspect'|'start'|'status',extra={})=>({id:randomUUID(),type:'studio-launch' as const,sessionId:sid,workspaceId:rid,launch:{op,target,...extra}});
 try{
  const inspected:any=await launcher.handle(action('inspect'));assert.equal(inspected.worktree,realpathSync.native(root));
  await assert.rejects(launcher.handle(action('start',{hash:'0'.repeat(64)})),/已变化/);assert.equal(starts,0);
  const a=action('start',{hash:inspected.hash}),first:any=await launcher.handle(a);assert.equal(first.status,'started');assert.ok(first.pid>0);assert.equal(starts,1);
  const again:any=await launcher.handle(a);assert.equal(again.reused,true);assert.equal(starts,1);assert.equal((await launcher.handle(action('start',{hash:inspected.hash})) as any).reused,true);assert.equal(starts,1);
  await assert.rejects(launcher.handle({...action('inspect'),sessionId:'other:codex:one'}),/不匹配/);
  if(windows){let ready:any;for(let n=0;n<100;n++){ready=await launcher.handle(action('status',{requestId:a.id}));if(ready.status==='ready')break;await pause(50);}assert.equal(ready.status,'ready');assert.equal(ready.scene,target.scene);}
  await pause(2800);const state:any=await launcher.handle(action('status',{requestId:a.id}));assert.equal(state.status,'exited');assert.equal(existsSync(join(root,'starts.txt')),true,readFileSync(state.logPath,'utf8'));assert.equal(readFileSync(join(root,'starts.txt'),'utf8').trim(),'start');
 }finally{if(ownedChild?.pid&&ownedChild.exitCode===null&&ownedChild.signalCode===null){const ended=once(ownedChild,'exit');ownedChild.kill();await Promise.race([ended,pause(3000)]);}launcher.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('relay launches only delivered targets, preserves an unknown receipt, and status reads never resend',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-launch-api-')),store=new RelayStore(dir),rid=randomUUID(),sid='h:codex:one';let starts=0,unknown=false;
 const target=launchTargets([{id:'game',kind:'game',title:'游戏',script:'Play.ps1',cwd:'.',scene:'res://game.tscn',controls:'实际操作'}])[0];
 const run:any={id:rid,projectId:'p',status:'review',workspace:{status:'ready',value:{project:{id:'studio-'+rid,path:dir}}},planner:{status:'done'},tasks:[{id:'code',status:'done',sessionId:sid,launchers:[target]}]};store.host({id:'h',name:'工作电脑',projects:[],online:true,lastSeen:1});store.session({id:sid,hostId:'h',projectId:'studio-'+rid,provider:'codex',nativeId:'one',title:'one',cwd:dir,status:'idle',updatedAt:1});
 const calls:any[]=[],service=new StudioPlaytests(store,{runs:()=>[run],projects:()=>[{id:'p',hostId:'h'}]} as any,async(_h,a)=>{calls.push(a);if(a.launch!.op==='inspect')return {hash:'a'.repeat(64),worktree:dir};if(a.launch!.op==='start'){starts++;if(unknown)throw Error('response lost');return {id:a.id,status:'started',pid:123};}return {id:a.launch!.requestId,status:'ready',pid:123,scene:'res://game.tscn'};},()=>true,()=>{});
 try{
  await assert.rejects(service.start({id:randomUUID(),runId:rid,targetId:'wrong'}),/尚未/);const v={id:randomUUID(),runId:rid,targetId:'code:game'};
  unknown=true;assert.equal((await service.start(v)).phase,'uncertain');assert.equal(starts,1);await service.start(v);assert.equal(starts,1);assert.equal((await service.status(rid,v.id)).result.status,'ready');assert.equal(starts,1);
  run.tasks[0].status='running';await assert.rejects(service.start({...v,id:randomUUID()}),/尚未|制作/);assert.equal(starts,1);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('launcher companion cannot replace the main bridge, publish sessions or accept raw browser launch actions',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'launcher-http-')),token='phone-'+randomUUID(),bridge='bridge-'+randomUUID(),app=createRelay({dataDir:dir,phoneToken:token,bridgeToken:bridge});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base='http://127.0.0.1:'+(app.server.address() as any).port;
 let main:WebSocket|undefined,launcher:WebSocket|undefined;
 try{
  assert.equal((await fetch(base+'/api/studio/playtests?runId=missing')).status,401);
  main=new WebSocket(base.replace('http','ws')+'/bridge',{headers:{Authorization:'Bearer '+bridge}});await once(main,'open');main.send(JSON.stringify({type:'hello',host:{id:'h',name:'PC',projects:[]}}));await once(main,'message');
  launcher=new WebSocket(base.replace('http','ws')+'/bridge',{headers:{Authorization:'Bearer '+bridge}});await once(launcher,'open');launcher.send(JSON.stringify({type:'hello',host:{id:'h',name:'PC launcher',service:'launcher',projects:[]}}));await once(launcher,'message');assert.equal(app.store.hosts()[0].name,'PC');assert.equal(app.store.hosts()[0].capabilities?.studioLaunch,true);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({token})}),cookie=login.headers.get('set-cookie')!.split(';')[0];
  const payload={id:randomUUID(),type:'studio-launch',sessionId:'h:s',workspaceId:randomUUID(),launch:{op:'inspect',target:{id:'f',kind:'functional',title:'f',script:'run.ps1',cwd:'.',scene:'test',controls:''}}};
  const response=await fetch(base+'/api/actions',{method:'POST',headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(payload)});assert.equal(response.status,400);
  launcher.send(JSON.stringify({type:'sessions',sessions:[]}));await once(launcher,'close');assert.equal(main.readyState,WebSocket.OPEN);for(let n=0;n<100&&app.store.hosts()[0].capabilities?.studioLaunch!==false;n++)await pause(10);assert.equal(app.store.hosts()[0].capabilities?.studioLaunch,false);
  assert.equal((await fetch(base+'/studio-playtests.js')).status,200);
 }finally{launcher?.terminate();main?.terminate();await app.close();rmSync(dir,{recursive:true,force:true});}
});


test('relay shutdown drains companion disconnect handlers before closing the database',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'launcher-shutdown-')),token='phone-'+randomUUID(),bridge='bridge-'+randomUUID(),app=createRelay({dataDir:dir,phoneToken:token,bridgeToken:bridge});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const url='ws://127.0.0.1:'+(app.server.address() as any).port+'/bridge';
 let main:WebSocket|undefined,launcher:WebSocket|undefined,closed=false;
 try{
  main=new WebSocket(url,{headers:{Authorization:'Bearer '+bridge}});await once(main,'open');main.send(JSON.stringify({type:'hello',host:{id:'shutdown-host',name:'main',projects:[]}}));await once(main,'message');
  launcher=new WebSocket(url,{headers:{Authorization:'Bearer '+bridge}});await once(launcher,'open');launcher.send(JSON.stringify({type:'hello',host:{id:'shutdown-host',name:'launcher',service:'launcher',projects:[]}}));await once(launcher,'message');
  const closeStore=app.store.close.bind(app.store);app.store.close=()=>{assert.equal(app.store.hosts()[0].capabilities?.studioLaunch,false,'disconnect state must be persisted while the store is open');closeStore();};
  const disconnected=Promise.all([once(main,'close'),once(launcher,'close')]);await app.close();closed=true;await disconnected;
 }finally{main?.terminate();launcher?.terminate();if(!closed)await app.close();rmSync(dir,{recursive:true,force:true});}
});
