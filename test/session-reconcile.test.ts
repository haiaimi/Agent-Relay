import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BridgeStore} from '../src/bridge/store.js';
import {AgentRuntime} from '../src/bridge/runtime.js';
import {CodexDesktop} from '../src/bridge/codex-desktop.js';
import type {Session,RelayEvent} from '../src/shared/protocol.js';
import {randomUUID} from 'node:crypto';
import {SteerDeliveryError} from '../src/bridge/claude-steer.js';

test('native Codex activity and title replace a stale relay failure',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-reconcile-'));
  const store=new BridgeStore(join(root,'data'));
  const stale:Session={id:'pc:codex:native',hostId:'pc',provider:'codex',nativeId:'native',cwd:root,title:'旧的完整提问',updatedAt:1,status:'failed',statusOrigin:'relay',managed:true};
  store.save(stale);
  const runtime=new AgentRuntime({relayUrl:'ws://localhost',hostId:'pc',name:'PC',dataDir:join(root,'data'),projects:[{id:'p',name:'P',path:root}],codexHome:join(root,'codex'),claudeHome:join(root,'claude')},store,()=>{},()=>{},undefined,new CodexDesktop(''));
  const native:Session={...stale,title:'优化 Voxel 光照采集读取',status:'running',statusOrigin:'native',managed:undefined,updatedAt:2};
  runtime.history.list=()=>[native];
  try{
    const current=runtime.list()[0];
    assert.equal(current.title,native.title);
    assert.equal(current.status,'running');
    assert.equal(current.statusOrigin,'native');
    assert.equal(current.managed,false);
    assert.equal(store.sessions()[0].status,'running');
    native.status='idle';
    assert.equal(runtime.list()[0].status,'idle');
    runtime.codex.emit('failure',new Error('unrelated metadata process exited'));
    assert.equal(runtime.list()[0].status,'idle');
  }finally{await runtime.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('an idle native desktop owner accepts queued followups without a second writer; unknown deliveries never retry',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-native-idle-')),store=new BridgeStore(join(root,'data'));
  const desktop=new CodexDesktop(''),nativeId=randomUUID(),sent:any[]=[];
  desktop.owner=async()=>randomUUID();
  let nativeStatus:Session['status']='running',uncertain=false;
  desktop.startTurn=async(thread,id,text,input,settings)=>{sent.push({thread,id,text,input,settings});if(uncertain)throw new SteerDeliveryError('Disconnected after sending',true);nativeStatus='running';return {turnId:randomUUID()};};
  const session:Session={id:'pc:codex:'+nativeId,hostId:'pc',provider:'codex',nativeId,cwd:root,title:'native',updatedAt:1,status:'running',statusOrigin:'native',managed:false};store.save(session);
  const runtime=new AgentRuntime({relayUrl:'ws://localhost',hostId:'pc',name:'PC',dataDir:join(root,'data'),projects:[{id:'p',name:'P',path:root}],codexHome:join(root,'empty'),claudeHome:join(root,'empty')},store,()=>{},()=>{},undefined,desktop);
  runtime.history.list=()=>[{...session,status:nativeStatus}];
  runtime.codex.start=async()=>{throw new Error('Must not start a second writer');};
  try{
    runtime.list();
    const a={id:randomUUID(),type:'send' as const,sessionId:session.id,text:'first'},b={...a,id:randomUUID(),text:'second'};
    await runtime.handle(a);await runtime.handle(b);await runtime.drainInputs();assert.equal(sent.length,0);
    nativeStatus='idle';runtime.list();await runtime.drainInputs();
    assert.equal(sent.length,1);assert.equal(sent[0].id,a.id);assert.equal(runtime.list()[0].status,'running');
    assert.deepEqual(store.queued().map(x=>x.id),[b.id]);
    await runtime.drainInputs();assert.equal(sent.length,1);
    nativeStatus='idle';
    // Move beyond the acceptance grace period, as if the native turn has finished.
    runtime.history.list=()=>[{...session,status:nativeStatus,updatedAt:Date.now()+1000}];
    uncertain=true;runtime.list();await runtime.drainInputs();await runtime.drainInputs();
    assert.equal(sent.length,2);assert.equal(store.queued().length,0);
    assert.equal(store.db.prepare('SELECT state FROM input_queue WHERE id=?').get(b.id)?.state,'unknown');
    assert.equal(runtime.list()[0].pendingCount,0);
  }finally{await runtime.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('active writer rejection queues the message without failing a native Codex turn',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-writer-'));
  const store=new BridgeStore(join(root,'data'));
  const current:Session={id:'pc:codex:native',hostId:'pc',provider:'codex',nativeId:'native',cwd:root,title:'本机标题',updatedAt:1,status:'idle',statusOrigin:'native',managed:false};
  store.save(current);
  const events:RelayEvent[]=[];
  const runtime=new AgentRuntime({relayUrl:'ws://localhost',hostId:'pc',name:'PC',dataDir:join(root,'data'),projects:[{id:'p',name:'P',path:root}],codexHome:join(root,'codex'),claudeHome:join(root,'claude')},store,()=>{},event=>events.push(event),undefined,new CodexDesktop(''));
  let nativeActive=false;
  runtime.history.list=()=>[{...current,status:nativeActive?'running':'idle'}];
  runtime.codex.start=async()=>{};
  runtime.codex.call=async(method:string)=>{
    if(method==='thread/resume')return {model:'fixture'};
    if(method==='turn/start'){nativeActive=true;throw new Error('thread native already has an active writer');}
    throw new Error(`Unexpected method: ${method}`);
  };
  try{
    const result=await runtime.handle({id:'writer-conflict-1',type:'send',sessionId:current.id,text:'继续检查'});
    assert.equal(result.queued,true);
    assert.equal(store.queued().length,1);
    assert.equal(runtime.list()[0].status,'running');
    assert.equal(runtime.list()[0].managed,false);
    assert.equal(events.some(event=>event.type==='error'),false);
    assert.equal(events.some(event=>event.type==='status'&&event.data.status==='failed'),false);
  }finally{await runtime.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('idle writer conflicts retain a single queued message without fake running events or busy retries',async()=>{
 const root=mkdtempSync(join(tmpdir(),'relay-idle-writer-')),store=new BridgeStore(join(root,'data')),events:RelayEvent[]=[],desktop=new CodexDesktop('');
 const session:Session={id:'pc:codex:native',hostId:'pc',provider:'codex',nativeId:'native',cwd:root,title:'native',updatedAt:1,status:'idle',statusOrigin:'native',managed:false};store.save(session);
 const runtime=new AgentRuntime({relayUrl:'ws://localhost',hostId:'pc',name:'PC',dataDir:join(root,'data'),projects:[{id:'p',name:'P',path:root}],codexHome:join(root,'empty'),claudeHome:join(root,'empty')},store,()=>{},e=>events.push(e),undefined,desktop);
 let resumes=0;runtime.history.list=()=>[session];runtime.history.refreshSessionStatus=async()=>{};desktop.available=()=>false;runtime.codex.start=async()=>{};
 runtime.codex.call=async(method:string)=>{if(method==='thread/resume'){resumes++;throw Error('thread native already has an active writer');}throw Error('Unexpected '+method);};
 try{
  const a={id:randomUUID(),type:'send' as const,sessionId:session.id,text:'keep exactly once'};assert.equal((await runtime.handle(a)).queued,true);
  await runtime.drainInputs();await runtime.drainInputs();assert.equal(resumes,1);assert.deepEqual(store.queued().map(x=>x.id),[a.id]);
  assert.equal(events.some(e=>e.type==='status'&&e.data.status==='running'),false);assert.equal(runtime.list()[0].status,'idle');
  desktop.available=()=>true;desktop.owner=async()=>randomUUID();desktop.startTurn=async()=>({turnId:randomUUID()});
  await runtime.drainInputs();assert.equal(store.queued().length,0);assert.equal(events.filter(e=>e.type==='status'&&e.data.status==='running').length,1);
 }finally{await runtime.close();store.close();rmSync(root,{recursive:true,force:true});}
});


test('send and queued followups await fresh native status instead of reusing a stale running snapshot',async()=>{
 const root=mkdtempSync(join(tmpdir(),'relay-fresh-send-')),store=new BridgeStore(join(root,'data')),desktop=new CodexDesktop(''),nativeId=randomUUID(),sent:string[]=[];
 const session:Session={id:'pc:codex:'+nativeId,hostId:'pc',provider:'codex',nativeId,cwd:root,title:'native',updatedAt:1,status:'running',statusOrigin:'native',managed:false};store.save(session);
 const runtime=new AgentRuntime({relayUrl:'ws://localhost',hostId:'pc',name:'PC',dataDir:join(root,'data'),projects:[{id:'p',name:'P',path:root}],codexHome:join(root,'empty'),claudeHome:join(root,'empty')},store,()=>{},()=>{},undefined,desktop);
 let status:Session['status']='running',probes=0;
 runtime.history.list=()=>[{...session,status,updatedAt:Date.now()+1000}];
 runtime.history.refreshSessionStatus=async()=>{probes++;await new Promise(r=>setImmediate(r));status='idle';};
 desktop.owner=async()=>randomUUID();desktop.startTurn=async(thread,id)=>{sent.push(id);status='running';return {turnId:randomUUID()};};
 runtime.codex.start=async()=>{throw Error('Must not create another writer');};
 try{
  runtime.list();const direct={id:randomUUID(),type:'send' as const,sessionId:session.id,text:'fresh'};
  assert.equal((await runtime.handle(direct)).queued,undefined);assert.deepEqual(sent,[direct.id]);assert.equal(probes,1);
  const queued={...direct,id:randomUUID(),text:'queued'};store.enqueue(queued);
  runtime.list();await runtime.drainInputs();assert.deepEqual(sent,[direct.id,queued.id]);assert.equal(store.queued().length,0);assert.equal(probes,2);
 }finally{await runtime.close();store.close();rmSync(root,{recursive:true,force:true});}
});


test('idle native Claude without a control peer reports unavailable instead of queuing forever',async()=>{
 const root=mkdtempSync(join(tmpdir(),'relay-claude-idle-')),store=new BridgeStore(join(root,'data'));
 const session:Session={id:'pc:claude:native',hostId:'pc',provider:'claude',nativeId:'native',cwd:root,title:'native',updatedAt:1,status:'idle',statusOrigin:'native',managed:false};store.save(session);
 const runtime=new AgentRuntime({relayUrl:'ws://localhost',hostId:'pc',name:'PC',dataDir:join(root,'data'),projects:[{id:'p',name:'P',path:root}],codexHome:join(root,'empty'),claudeHome:join(root,'empty')},store,()=>{},()=>{},undefined,new CodexDesktop(''));
 runtime.history.list=()=>[session];runtime.history.claudeLiveStatus=()=> 'idle';
 try{runtime.list();await assert.rejects(runtime.handle({id:randomUUID(),type:'send',sessionId:session.id,text:'continue'}),/消息未加入排队/);assert.equal(store.queued().length,0);}
 finally{await runtime.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('native owner status keeps an active Mac-style session running even when history only reports cached content',async()=>{
 const root=mkdtempSync(join(tmpdir(),'relay-native-stream-')),store=new BridgeStore(join(root,'data')),desktop=new CodexDesktop('');
 const session:Session={id:'pc:codex:native',hostId:'pc',provider:'codex',nativeId:'native',cwd:root,title:'native',updatedAt:1,status:'idle',statusOrigin:'native',managed:false};store.save(session);
 const runtime=new AgentRuntime({relayUrl:'ws://localhost',hostId:'pc',name:'PC',dataDir:join(root,'data'),projects:[{id:'p',name:'P',path:root}],codexHome:join(root,'empty'),claudeHome:join(root,'empty')},store,()=>{},()=>{},undefined,desktop);
 let live:Session['status']='running';runtime.history.list=()=>[{...session,status:'history',statusOrigin:undefined}];desktop.status=()=>({status:live,at:Date.now()});
 try{assert.equal(runtime.list()[0].status,'running');live='waiting';assert.equal(runtime.list()[0].status,'waiting');live='idle';assert.equal(runtime.list()[0].status,'idle');}
 finally{await runtime.close();store.close();rmSync(root,{recursive:true,force:true});}
});
