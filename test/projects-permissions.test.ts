import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {CodexDesktop} from '../src/bridge/codex-desktop.js';
import {createRelay} from '../src/relay/server.js';
import {startBridge} from '../src/bridge/connector.js';
import {BridgeStore} from '../src/bridge/store.js';
import {AgentRuntime} from '../src/bridge/runtime.js';
import {validateAction} from '../src/shared/protocol.js';
import {assertProjectPath} from '../src/shared/security.js';

const pause=(ms=10)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>boolean){for(let i=0;i<150;i++){if(fn())return;await pause();}throw Error('Fixture did not reach expected state');}
function fixture(factory?:any){
  const root=mkdtempSync(join(tmpdir(),'relay-project-permission-')),work=join(root,'work');mkdirSync(work);
  const store=new BridgeStore(join(root,'bridge')),events:any[]=[];
  const config={relayUrl:'ws://127.0.0.1/bridge',hostId:'pc',name:'pc',dataDir:join(root,'bridge'),projects:[{id:'p',name:'p',path:work}],codexHome:join(root,'empty'),claudeHome:join(root,'empty'),discoverCodexProjects:false,codexCommand:process.execPath,codexArgs:[fileURLToPath(new URL('./fixtures/codex.mjs',import.meta.url))]};
  const runtime=new AgentRuntime(config,store,()=>{},e=>events.push(e),factory);
  return {root,work,store,runtime,events,config,async close(){await runtime.close();store.close();rmSync(root,{recursive:true,force:true});}};
}

test('web projects explicitly register an absolute workstation folder, persist across restart and never guess native membership',async()=>{
  const f=fixture();try{
    const path=join(f.root,'outside-original','new-game');assert.throws(()=>assertProjectPath(f.root,[f.work]));
    const a={id:randomUUID(),type:'create-project' as const,projectName:'新游戏',projectPath:path,createFolder:true};
    const {project}=await f.runtime.handle(validateAction(a));assert.ok(existsSync(path));assert.equal(project.nativeProjectId,undefined);
    assert.equal(assertProjectPath(path,f.runtime.projects().map(p=>p.path)),project.path);
    assert.equal((await f.runtime.handle({...a,id:randomUUID()})).project.id,project.id);
    assert.equal(f.store.projects().length,1);
    await assert.rejects(f.runtime.handle({...a,projectPath:'relative/new'}),/绝对路径/);
    const noCreate=join(f.root,'missing');await assert.rejects(f.runtime.handle({...a,projectPath:noCreate,createFolder:false}),/不存在/);assert.equal(existsSync(noCreate),false);
    const file=join(f.root,'file.txt');writeFileSync(file,'fixture');await assert.rejects(f.runtime.handle({...a,projectPath:file}),/不是文件夹/);
    await f.runtime.close();f.store.close();
    const reloaded=new BridgeStore(f.config.dataDir);assert.equal(reloaded.projects()[0].id,project.id);reloaded.close();
  }finally{await f.runtime.close();try{f.store.close();}catch{}rmSync(f.root,{recursive:true,force:true});}
});

test('managed Codex receives explicit permission policies on both thread start and later turns, with safe defaults',async()=>{
  const f=fixture(),calls:any[]=[];const call=f.runtime.codex.call.bind(f.runtime.codex);f.runtime.codex.call=async(method,params)=>{calls.push({method,params});return call(method,params);};
  try{
    const {sessionId}=await f.runtime.handle({id:randomUUID(),type:'start',provider:'codex',projectId:'p',text:'wait',permissionMode:'full'});
    const start=calls.find(c=>c.method==='thread/start');assert.equal(start.params.approvalPolicy,'never');assert.equal(start.params.sandbox,'danger-full-access');
    const turn=calls.find(c=>c.method==='turn/start');assert.deepEqual(turn.params.sandboxPolicy,{type:'dangerFullAccess'});
    const queued=await f.runtime.handle({id:randomUUID(),type:'set-permissions',sessionId,permissionMode:'request'});assert.equal(queued.queued,true);assert.equal(f.runtime.list()[0].permissionMode,'full');assert.equal(f.runtime.list()[0].nextPermissionMode,'request');
    await f.runtime.handle({id:randomUUID(),type:'stop',sessionId});await f.runtime.handle({id:randomUUID(),type:'send',sessionId,text:'wait'});
    const next=calls.filter(c=>c.method==='turn/start').at(-1);assert.equal(next.params.approvalPolicy,'on-request');assert.equal(next.params.approvalsReviewer,'user');assert.equal(next.params.sandboxPolicy.type,'workspaceWrite');assert.equal(next.params.sandboxPolicy.networkAccess,false);
    await f.runtime.handle({id:randomUUID(),type:'stop',sessionId});
    await f.runtime.handle({id:randomUUID(),type:'start',provider:'codex',projectId:'p',text:'wait'});
    assert.equal(calls.filter(c=>c.method==='thread/start').at(-1).params.sandbox,'workspace-write');
    assert.throws(()=>validateAction({id:randomUUID(),type:'start',provider:'codex',projectId:'p',text:'x',permissionMode:'arbitrary'}));
    assert.throws(()=>validateAction({id:randomUUID(),type:'approve',sessionId,approvalId:'a',allow:false,approvalScope:'session'}));
  }finally{await f.close();}
});

test('Claude session grants stay scoped to that tool and conversation, and questions still require actual answers',async()=>{
  const calls:any[]=[],received:any[]=[];
  const factory=({options}:any)=>{
    calls.push(options);const gen=(async function*(){
      const ctx={signal:options.abortController.signal,toolUseID:randomUUID()};
      received.push(await options.canUseTool('PowerShell',{command:'first'},ctx));
      received.push(await options.canUseTool('PowerShell',{command:'second'},ctx));
      received.push(await options.canUseTool('AskUserQuestion',{questions:[{question:'选哪个？',options:[{label:'A'},{label:'B'}]}]},ctx));
      received.push(await options.canUseTool('Bash',{command:'other tool'},ctx));
      yield {type:'result',is_error:false};
    })();return Object.assign(gen,{close(){options.abortController.abort();},async setPermissionMode(mode:any){options.livePermission=mode;}});
  };
  const f=fixture(factory);try{
    const {sessionId}=await f.runtime.handle({id:randomUUID(),type:'start',provider:'claude',projectId:'p',text:'test'});
    await until(()=>f.events.some(e=>e.type==='approval'));const a=f.events.find(e=>e.type==='approval');
    const foreign={id:randomUUID(),type:'approve' as const,sessionId:'wrong',approvalId:a.data.approvalId,allow:true,approvalScope:'session' as const};await assert.rejects(f.runtime.handle(foreign),/another session/);
    await f.runtime.handle({...foreign,id:randomUUID(),sessionId});
    await until(()=>f.runtime.questions.list(sessionId).length===1);assert.equal(received.length,2);assert.equal(f.events.filter(e=>e.type==='approval').length,1);
    assert.equal(received[0].updatedPermissions[0].destination,'session');assert.equal(received[0].updatedPermissions[0].rules[0].toolName,'PowerShell');
    const q=f.runtime.questions.list(sessionId)[0];await f.runtime.handle({id:randomUUID(),type:'answer',sessionId,questionId:q.id,answers:{q0:['A']}});
    await until(()=>f.events.filter(e=>e.type==='approval').length===2);const b=f.events.filter(e=>e.type==='approval')[1];assert.equal(b.data.label,'Bash');
    await f.runtime.handle({id:randomUUID(),type:'set-permissions',sessionId,permissionMode:'full'});assert.equal(calls[0].livePermission,'bypassPermissions');
    await f.runtime.handle({id:randomUUID(),type:'approve',sessionId,approvalId:b.data.approvalId,allow:false});await until(()=>f.runtime.list()[0].status==='idle');
    assert.deepEqual(f.store.sessions()[0].approvedTools,['PowerShell']);
    await f.runtime.handle({id:randomUUID(),type:'start',provider:'claude',projectId:'p',text:'new session'});await until(()=>f.events.filter(e=>e.type==='approval').length===3);assert.equal(f.events.filter(e=>e.type==='approval')[2].data.label,'PowerShell');
    assert.equal(calls[1].permissionMode,'default');
  }finally{await f.close();}
});

test('native Codex permission updates and remembered approvals target the existing owner and await its actual acknowledgement',async()=>{
  const f=fixture(),pipe=process.platform==='win32'?'\\\\.\\pipe\\relay-permissions-'+randomUUID():join(f.root,'ipc.sock'),thread=randomUUID(),owner=randomUUID(),frames:any[]=[];let socket:any,respond:(()=>void)|undefined;
  const send=(r:any)=>{const bytes=Buffer.from(JSON.stringify(r)),frame=Buffer.alloc(4+bytes.length);frame.writeUInt32LE(bytes.length);bytes.copy(frame,4);socket.write(frame);};
  const server=createServer(s=>{socket=s;let buffer=Buffer.alloc(0);s.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4&&buffer.length>=buffer.readUInt32LE()+4){const size=buffer.readUInt32LE(),m=JSON.parse(buffer.subarray(4,4+size).toString());buffer=buffer.subarray(4+size);frames.push(m);
    if(m.type==='broadcast'){send({type:'broadcast',method:'thread-stream-state-changed',sourceClientId:owner,params:{hostId:'local',conversationId:thread,change:{type:'snapshot',revision:1,conversationState:{requests:[{id:99,method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:'turn',command:'echo fixture'}}]}}}});continue;}
    let result=m.method==='initialize'?{clientId:randomUUID()}:m.method==='thread-owner-discovery'?{supportsUntrustedAppInput:true}:m.method==='thread-follower-update-thread-settings'?{applied:true}:{ok:true};
    const reply=()=>send({type:'response',requestId:m.requestId,resultType:'success',handledByClientId:owner,result});
    if(m.method==='thread-follower-command-approval-decision')respond=reply;else reply();
  }});});server.listen(pipe);await once(server,'listening');
  const desktop=new CodexDesktop(pipe);const store=new BridgeStore(join(f.root,'native-store')),events:any[]=[];
  const runtime=new AgentRuntime(f.config,store,()=>{},e=>events.push(e),undefined,desktop);
  const native={id:'pc:codex:'+thread,hostId:'pc',nativeId:thread,provider:'codex' as const,cwd:f.work,title:'native',status:'running' as const,statusOrigin:'native' as const,updatedAt:Date.now()};runtime.history.list=()=>[native];runtime.history.get=()=>native;
  try{
    await desktop.watch(thread);await until(()=>events.some(e=>e.type==='approval'));
    await runtime.handle({id:randomUUID(),type:'set-permissions',sessionId:native.id,permissionMode:'full'});
    const update=frames.find(f=>f.method==='thread-follower-update-thread-settings');assert.equal(update.version,2);assert.equal(update.targetClientId,owner);assert.deepEqual(update.params.threadSettings.sandboxPolicy,{type:'dangerFullAccess'});assert.equal(update.params.threadSettings.approvalPolicy,'never');
    const a=events.find(e=>e.type==='approval');let finished=false;
    const approved=runtime.handle({id:randomUUID(),type:'approve',sessionId:native.id,approvalId:a.data.approvalId,allow:true,approvalScope:'session'}).then(()=>finished=true);
    await until(()=>!!respond);assert.equal(finished,false);assert.equal(events.some(e=>e.type==='approval.resolved'),false);
    const reply=frames.find(f=>f.method==='thread-follower-command-approval-decision');assert.equal(reply.params.decision,'acceptForSession');assert.equal(reply.targetClientId,owner);respond!();await approved;
    assert.equal(events.find(e=>e.type==='approval.resolved').data.remember,true);
    assert.equal(frames.some(f=>['thread/start','thread/resume','turn/start'].includes(f.method)),false);
  }finally{await runtime.close();store.close();await new Promise<void>(r=>server.close(()=>r()));await f.close();}
});

test('authenticated web project creation publishes the new root before starting a session and is idempotent',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-project-http-')),work=join(root,'work');mkdirSync(work);
  const phone=randomUUID()+randomUUID(),token=randomUUID()+randomUUID(),relay=createRelay({dataDir:join(root,'relay'),phoneToken:phone,bridgeToken:token});relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  const base='http://127.0.0.1:'+(relay.server.address() as any).port;
  const bridge=startBridge({relayUrl:base.replace('http','ws')+'/bridge',hostId:'pc',name:'test',dataDir:join(root,'bridge'),projects:[{id:'p',name:'p',path:work}],codexHome:join(root,'empty'),claudeHome:join(root,'empty'),discoverCodexProjects:false,syncHistory:false,codexCommand:process.execPath,codexArgs:[fileURLToPath(new URL('./fixtures/codex.mjs',import.meta.url))]},token);
  let cookie='';const post=async(path:string,data:any)=>{const r=await fetch(base+path,{method:'POST',headers:{Origin:base,cookie,'Content-Type':'application/json'},body:JSON.stringify(data)});if(path.endsWith('login'))cookie=r.headers.get('set-cookie')!.split(';')[0];return {status:r.status,value:await r.json() as any};};
  try{
    await until(()=>relay.store.hosts().some(h=>h.online));assert.equal(relay.store.hosts()[0].capabilities?.permissions,true);
    const a={id:randomUUID(),type:'create-project',hostId:'pc',projectName:'Web Project',projectPath:join(root,'new-folder'),createFolder:true};
    assert.equal((await post('/api/actions',a)).status,401);assert.equal(existsSync(a.projectPath),false);
    await post('/api/login',{token:phone});const created=await post('/api/actions',a);assert.equal(created.status,200);const project=created.value.project;
    assert.ok(relay.store.hosts()[0].projects.some(p=>p.id===project.id));assert.equal((await post('/api/actions',a)).value.project.id,project.id);assert.equal(bridge.store.projects().length,1);
    const started=await post('/api/actions',{id:randomUUID(),type:'start',hostId:'pc',projectId:project.id,provider:'codex',permissionMode:'full',text:'wait'});assert.equal(started.status,200);
    assert.equal(relay.store.getSession(started.value.sessionId)?.cwd,project.path);assert.equal(relay.store.getSession(started.value.sessionId)?.permissionMode,'full');
  }finally{await bridge.close();await relay.close();rmSync(root,{recursive:true,force:true});}
});
