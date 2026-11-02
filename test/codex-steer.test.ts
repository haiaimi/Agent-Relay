import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CodexDesktop} from '../src/bridge/codex-desktop.js';
import {AgentRuntime} from '../src/bridge/runtime.js';
import {BridgeStore} from '../src/bridge/store.js';
import type {Session} from '../src/shared/protocol.js';

test('managed Codex promotes exactly one queued message into the current turn without restarting it',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-codex-steer-'));mkdirSync(join(root,'work'));const store=new BridgeStore(join(root,'bridge')),events:any[]=[];
  const runtime=new AgentRuntime({relayUrl:'ws://127.0.0.1/bridge',hostId:'test',name:'test',dataDir:join(root,'bridge'),projects:[{id:'p',name:'p',path:join(root,'work')}],codexHome:join(root,'empty'),claudeHome:join(root,'empty'),codexCommand:process.execPath,codexArgs:[fileURLToPath(new URL('./fixtures/codex.mjs',import.meta.url))]},store,()=>{},e=>events.push(e));
  try{
    const {sessionId}=await runtime.handle({id:randomUUID(),type:'start',provider:'codex',projectId:'p',text:'wait'});
    const a={id:randomUUID(),type:'send' as const,sessionId,text:'keep queued'},b={...a,id:randomUUID(),text:'change direction'};
    await runtime.handle(a);await runtime.handle(b);assert.equal(runtime.list()[0].canSteer,true);
    assert.equal((await runtime.handle({id:randomUUID(),type:'steer',sessionId,queuedId:b.id})).mode,'active-turn');
    assert.deepEqual(store.queued().map(a=>a.id),[a.id]);assert.equal(runtime.list()[0].status,'running');
    for(let i=0;i<50&&!events.some(e=>e.data.text==='STEERED:change direction');i++)await new Promise(r=>setTimeout(r,10));
    assert.ok(events.some(e=>e.data.text==='STEERED:change direction'));
    await assert.rejects(runtime.handle({id:randomUUID(),type:'steer',sessionId,queuedId:b.id}),/不在等待队列/);
  }finally{await runtime.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('native Codex discovers the desktop owner, targets it and keeps rejected input queued without opening another writer',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-desktop-steer-'));mkdirSync(join(root,'work'));
  const path=process.platform==='win32'?'\\\\.\\pipe\\relay-desktop-test-'+randomUUID():join(root,'test.sock');
  const nativeId=randomUUID(),ownerId=randomUUID(),clientId=randomUUID(),turnId=randomUUID(),frames:any[]=[];let reject=false,disconnect=false;
  const server=createServer(socket=>{let buffer=Buffer.alloc(0);socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4&&buffer.length>=buffer.readUInt32LE()+4){const size=buffer.readUInt32LE(),m=JSON.parse(buffer.subarray(4,4+size).toString());buffer=buffer.subarray(4+size);frames.push(m);let result:any;
    if(m.method==='initialize')result={clientId};
    else if(m.method==='thread-owner-discovery'){assert.equal(m.params.conversationId,nativeId);result={supportsUntrustedAppInput:true};}
    else {assert.equal(m.method,'thread-follower-steer-turn');assert.equal(m.version,1);assert.equal(m.targetClientId,ownerId);assert.equal(m.params.conversationId,nativeId);assert.equal(m.params.restoreMessage.context!=null,true);result={method:m.method,result:{result:{turnId}}};}
    if(disconnect&&m.method==='thread-follower-steer-turn'){socket.destroy();return;}
    const r=reject&&m.method==='thread-follower-steer-turn'?{type:'response',requestId:m.requestId,resultType:'error',error:'no active turn to steer'}:{type:'response',requestId:m.requestId,resultType:'success',method:m.method,handledByClientId:ownerId,result};
    const data=Buffer.from(JSON.stringify(r)),frame=Buffer.alloc(4+data.length);frame.writeUInt32LE(data.length);data.copy(frame,4);socket.write(frame.subarray(0,2));socket.write(frame.subarray(2));
  }});});server.listen(path);await once(server,'listening');
  const desktop=new CodexDesktop(path),store=new BridgeStore(join(root,'bridge')),events:any[]=[];
  const runtime=new AgentRuntime({relayUrl:'ws://127.0.0.1/bridge',hostId:'test',name:'test',dataDir:join(root,'bridge'),projects:[{id:'p',name:'p',path:join(root,'work')}],codexHome:join(root,'empty'),claudeHome:join(root,'empty')},store,()=>{},e=>events.push(e),undefined,desktop);
  const session:Session={id:'test:codex:'+nativeId,hostId:'test',provider:'codex',nativeId,cwd:join(root,'work'),status:'running',title:'native',updatedAt:Date.now(),statusOrigin:'native'};
  runtime.history.get=()=>session;runtime.history.list=()=>[session];
  try{
    assert.equal(await desktop.owner(nativeId),ownerId);assert.equal(runtime.list()[0].canSteer,true);
    const a={id:randomUUID(),type:'send' as const,sessionId:session.id,text:'keep queued'},b={...a,id:randomUUID(),text:'native guidance'};
    await runtime.handle(a);await runtime.handle(b);
    assert.equal((await runtime.handle({id:randomUUID(),type:'steer',sessionId:session.id,queuedId:b.id})).mode,'active-turn');
    assert.deepEqual(store.queued().map(a=>a.id),[a.id]);assert.equal(frames.filter(f=>f.method==='thread-follower-steer-turn').length,1);
    reject=true;await assert.rejects(runtime.handle({id:randomUUID(),type:'steer',sessionId:session.id,queuedId:a.id}),/未接受引导/);assert.deepEqual(store.queued().map(a=>a.id),[a.id]);
    const c={...a,id:randomUUID(),text:'still queued'};await runtime.handle(c);disconnect=true;
    await assert.rejects(runtime.handle({id:randomUUID(),type:'steer',sessionId:session.id,queuedId:a.id}),/连接已断开/);
    assert.deepEqual(store.queued().map(a=>a.id),[c.id]);assert.equal(store.db.prepare('SELECT state FROM input_queue WHERE id=?').get(a.id)?.state,'unknown');
    assert.equal(frames.some(f=>f.method==='thread/resume'||f.method==='turn/start'),false);
  }finally{await runtime.close();store.close();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});
