import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexDesktop} from '../src/bridge/codex-desktop.js';
import {AgentRuntime} from '../src/bridge/runtime.js';
import {BridgeStore} from '../src/bridge/store.js';
import {validateAction,type Session} from '../src/shared/protocol.js';

test('native stop targets the existing desktop owner, keeps queues on rejection and separates queue cancellation',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-native-stop-')),work=join(root,'work');mkdirSync(work);
  const pipe=process.platform==='win32'?'\\\\.\\pipe\\relay-stop-'+randomUUID():join(root,'test.sock');
  const nativeId=randomUUID(),owner=randomUUID(),frames:any[]=[];let failure='rejected',deferred:(()=>void)|undefined;
  const server=createServer(socket=>{let buffer=Buffer.alloc(0);socket.on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4&&buffer.length>=buffer.readUInt32LE()+4){
      const size=buffer.readUInt32LE(),m=JSON.parse(buffer.subarray(4,4+size).toString());buffer=buffer.subarray(4+size);frames.push(m);if(m.type!=='request')continue;
      const reply=(result:any,error?:string)=>{const b=Buffer.from(JSON.stringify({type:'response',requestId:m.requestId,resultType:error?'error':'success',handledByClientId:owner,result,error})),frame=Buffer.alloc(4+b.length);frame.writeUInt32LE(b.length);b.copy(frame,4);socket.write(frame);};
      if(m.method==='initialize'){reply({clientId:randomUUID()});continue;}
      if(m.method==='thread-owner-discovery'){reply({supportsUntrustedAppInput:true});continue;}
      assert.equal(m.method,'thread-follower-interrupt-turn');assert.equal(m.version,3);assert.equal(m.targetClientId,owner);
      assert.deepEqual(m.params,{conversationId:nativeId,mode:'user-stop'});
      if(failure==='rejected')reply(undefined,'native stop refused');
      else if(failure==='disconnect')socket.destroy();
      else deferred=()=>reply({result:{ok:true,interruptedTurnId:'existing-turn'}});
    }
  });});server.listen(pipe);await once(server,'listening');
  const desktop=new CodexDesktop(pipe),store=new BridgeStore(join(root,'bridge'));
  const runtime=new AgentRuntime({relayUrl:'ws://127.0.0.1/bridge',hostId:'pc',name:'pc',dataDir:join(root,'bridge'),projects:[{id:'p',name:'p',path:work}],codexHome:join(root,'empty'),claudeHome:join(root,'empty')},store,()=>{},()=>{},undefined,desktop);
  const session:Session={id:'pc:codex:'+nativeId,hostId:'pc',provider:'codex',nativeId,title:'native',cwd:work,status:'running',statusOrigin:'native',updatedAt:Date.now()};
  runtime.history.list=()=>[session];runtime.history.get=()=>session;
  const stop=()=>runtime.handle({id:randomUUID(),type:'stop',sessionId:session.id});
  const queued={id:randomUUID(),type:'send' as const,sessionId:session.id,text:'next turn'};
  try{
    await desktop.owner(nativeId);assert.equal(runtime.list()[0].canStop,true);
    await runtime.handle(queued);await assert.rejects(stop(),/未接受停止/);assert.equal(store.queued().length,1);
    await runtime.handle(validateAction({id:randomUUID(),type:'stop',sessionId:session.id,queueOnly:true}));
    assert.equal(store.queued().length,0);assert.equal(frames.filter(f=>f.method==='thread-follower-interrupt-turn').length,1);assert.equal(runtime.list()[0].status,'running');
    await runtime.handle({...queued,id:randomUUID()});failure='ok';const pending=stop();
    for(let i=0;i<100&&!deferred;i++)await new Promise(r=>setTimeout(r,5));assert.ok(deferred);
    await assert.rejects(stop(),/正在停止/);await assert.rejects(runtime.handle({...queued,id:randomUUID()}),/正在停止/);
    deferred!();assert.equal((await pending).ok,true);assert.equal(store.queued().length,0);
    // Native status remains authoritative after a successful interrupt acknowledgement.
    session.status='interrupted';assert.equal(runtime.list()[0].status,'interrupted');assert.equal(runtime.list()[0].canStop,false);
    session.status='running';await runtime.handle({...queued,id:randomUUID()});failure='disconnect';await assert.rejects(stop(),/连接已断开/);assert.equal(store.queued().length,1);
    assert.equal(frames.some(f=>['thread/resume','turn/start','thread-follower-start-turn'].includes(f.method)),false);
  }finally{await runtime.close();store.close();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});

test('managed Claude stop aborts the running worker and preserves its transcript; native Claude never claims a false stop',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-claude-stop-')),work=join(root,'work');mkdirSync(work);
  const store=new BridgeStore(join(root,'bridge'));let aborted=false,closed=false;
  const factory=({options}:any)=>Object.assign((async function*(){
    yield {type:'assistant',uuid:randomUUID(),message:{id:'first',content:[{type:'text',text:'running'}]}};
    await new Promise<void>(r=>options.abortController.signal.addEventListener('abort',()=>{aborted=true;r();},{once:true}));
  })(),{close(){closed=true;options.abortController.abort();}});
  const runtime=new AgentRuntime({relayUrl:'ws://127.0.0.1/bridge',hostId:'pc',name:'pc',dataDir:join(root,'bridge'),projects:[{id:'p',name:'p',path:work}],codexHome:join(root,'empty'),claudeHome:join(root,'empty')},store,()=>{},()=>{},factory as any);
  try{
    const {sessionId}=await runtime.handle({id:randomUUID(),type:'start',provider:'claude',projectId:'p',text:'test'});
    for(let i=0;i<100&&!runtime.list()[0].canStop;i++)await new Promise(r=>setTimeout(r,5));
    await runtime.handle({id:randomUUID(),type:'send',sessionId,text:'queued'});
    await runtime.handle({id:randomUUID(),type:'stop',sessionId,queueOnly:true});assert.equal(aborted,false);assert.equal(runtime.list()[0].status,'running');
    await runtime.handle({id:randomUUID(),type:'stop',sessionId});
    assert.ok(aborted&&closed);assert.equal(runtime.list()[0].status,'interrupted');assert.equal(store.sessions().length,1);
    const native:Session={id:'pc:claude:'+randomUUID(),nativeId:randomUUID(),hostId:'pc',provider:'claude',title:'native',cwd:work,status:'running',updatedAt:Date.now()};
    runtime.history.list=()=>[native];runtime.history.get=id=>id===native.id?native:undefined;
    assert.equal(runtime.list().find(s=>s.id===native.id)?.canStop,false);
    await assert.rejects(runtime.handle({id:randomUUID(),type:'stop',sessionId:native.id}),/电脑上按 Esc/);
  }finally{await runtime.close();store.close();rmSync(root,{recursive:true,force:true});}
});
