import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {createRelay} from '../src/relay/server.js';
import {startBridge} from '../src/bridge/connector.js';
import {claudeSteerSessions,steerClaude} from '../src/bridge/claude-steer.js';
import {validateAction} from '../src/shared/protocol.js';
import {AgentRuntime} from '../src/bridge/runtime.js';
import {BridgeStore} from '../src/bridge/store.js';

test('queued controls require a specific message and never accept an arbitrary target pipe',()=>{
  assert.throws(()=>validateAction({id:randomUUID(),type:'steer',sessionId:'pc:claude:test',text:'replacement'}));
  assert.throws(()=>validateAction({id:randomUUID(),type:'cancel-input',sessionId:'pc:claude:test'}));
  const a=validateAction({id:randomUUID(),type:'steer',sessionId:'pc:claude:test',queuedId:randomUUID(),pipe:'unsafe',token:'secret'});
  assert.equal('pipe' in a,false);assert.equal('token' in a,false);
});

test('phone promotes exactly one queued message into authenticated native steering, without replay', {skip:process.platform!=='win32'},async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-steer-')),home=join(root,'claude'),workspace=join(root,'workspace'),nativeId=randomUUID();
  const registrations=join(home,'sessions');mkdirSync(registrations,{recursive:true});mkdirSync(workspace);mkdirSync(join(home,'projects','fixture'),{recursive:true});
  writeFileSync(join(home,'projects','fixture',nativeId+'.jsonl'),JSON.stringify({type:'user',sessionId:nativeId,cwd:workspace,uuid:randomUUID(),message:{role:'user',content:'owned native fixture'}})+'\n');
  const secret=randomUUID()+randomUUID(),pipe='\\\\.\\pipe\\LOCAL\\cc-msg-'+randomUUID().replaceAll('-','');
  const registry={pid:process.pid,sessionId:nativeId,cwd:workspace,peerProtocol:1,procStart:'123456789',pidDomain:'fixture',messagingSocketPath:pipe,status:'busy'};
  const registryFile=join(registrations,process.pid+'.json'),keyFile=join(registrations,process.pid+'.'+'a'.repeat(64)+'.key');
  writeFileSync(registryFile,JSON.stringify(registry));writeFileSync(keyFile,JSON.stringify({peerToken:secret,procStartFt:registry.procStart,pidDomain:registry.pidDomain}));
  const deliveries:any[][]=[];const receiver=createServer(socket=>{let text='';socket.on('data',chunk=>text+=chunk);socket.on('end',()=>{deliveries.push(text.trim().split('\n').map(line=>JSON.parse(line)));socket.end();});});
  receiver.listen(pipe);await once(receiver,'listening');
  const phone=randomUUID(),token=randomUUID(),relay=createRelay({dataDir:join(root,'relay'),phoneToken:phone,bridgeToken:token});relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  const base='http://127.0.0.1:'+(relay.server.address() as {port:number}).port;let cookie='';
  const request=async(path:string,payload?:unknown)=>{const r=await fetch(base+path,{method:payload?'POST':'GET',headers:{cookie,Origin:base,'Content-Type':'application/json'},body:payload?JSON.stringify(payload):undefined});if(path.endsWith('login'))cookie=r.headers.get('set-cookie')!.split(';')[0];return {status:r.status,value:await r.json() as any};};
  const bridge=startBridge({relayUrl:base.replace('http','ws')+'/bridge',hostId:'fixture',name:'fixture',projects:[{id:'work',name:'work',path:workspace}],dataDir:join(root,'bridge'),claudeHome:home,codexHome:join(root,'empty'),syncHistory:false},token);
  const id='fixture:claude:'+nativeId;
  try{
    for(let n=0;n<100&&!relay.store.getSession(id);n++)await new Promise(r=>setTimeout(r,30));
    assert.equal(relay.store.getSession(id)?.canSteer,true);assert.equal(JSON.stringify(relay.store.sessions()).includes(secret),false);
    await request('/api/login',{token:phone});
    const first={id:randomUUID(),type:'send',sessionId:id,text:'keep waiting'},second={id:randomUUID(),type:'send',sessionId:id,text:'use this direction now'};
    assert.equal((await request('/api/actions',first)).value.queued,true);assert.equal((await request('/api/actions',second)).value.queued,true);
    const promote={id:randomUUID(),type:'steer',sessionId:id,queuedId:second.id};
    const response=await request('/api/actions',promote);assert.equal(response.status,200);assert.equal(response.value.mode,'native');
    await new Promise(r=>setTimeout(r,30));assert.equal(deliveries.length,1);
    assert.deepEqual(deliveries[0][0],{type:'auth',token:secret});assert.equal(deliveries[0][1].priority,'now');assert.equal(deliveries[0][1].session_id,nativeId);assert.equal(deliveries[0][1].uuid,second.id);assert.equal(deliveries[0][1].message.content,second.text);
    assert.deepEqual(bridge.store.queued().map(a=>a.id),[first.id]);assert.deepEqual(relay.store.getSession(id)?.pendingIds,[first.id]);
    assert.equal((await request('/api/actions',promote)).status,200);assert.equal(deliveries.length,1);
    assert.equal((await request('/api/actions',{...promote,id:randomUUID()})).status,409);assert.equal(deliveries.length,1);
    const foreign={id:randomUUID(),type:'cancel-input',sessionId:id,queuedId:randomUUID()};assert.equal((await request('/api/actions',foreign)).status,409);assert.equal(bridge.store.queued().length,1);
    assert.equal((await request('/api/actions',{id:randomUUID(),type:'cancel-input',sessionId:id,queuedId:first.id})).status,200);assert.equal(bridge.store.queued().length,0);
    const third={id:randomUUID(),type:'send',sessionId:id,text:'remain queued on failed delivery'};await request('/api/actions',third);
    writeFileSync(keyFile,JSON.stringify({peerToken:secret,procStartFt:'wrong-process-start',pidDomain:registry.pidDomain}));
    assert.equal(claudeSteerSessions(home).size,0);assert.equal((await request('/api/actions',{id:randomUUID(),type:'steer',sessionId:id,queuedId:third.id})).status,409);assert.deepEqual(bridge.store.queued().map(a=>a.id),[third.id]);
    writeFileSync(keyFile,JSON.stringify({peerToken:secret,procStartFt:registry.procStart,pidDomain:registry.pidDomain}));writeFileSync(registryFile,JSON.stringify({...registry,messagingSocketPath:'\\\\remote\\pipe\\unsafe'}));
    assert.equal(claudeSteerSessions(home).size,0);await assert.rejects(steerClaude(home,nativeId,workspace,randomUUID(),'test'));assert.equal(deliveries.length,1);
    // The terminal remains open. A fresh idle registration overrides stale busy metadata.
    writeFileSync(registryFile,JSON.stringify({...registry,status:'idle'}));
    await bridge.runtime.drainInputs();await new Promise(r=>setTimeout(r,30));assert.equal(bridge.store.queued().length,0);assert.equal(deliveries.length,2);assert.equal(deliveries[1][1].message.content,third.text);
    const idleSend={id:randomUUID(),type:'send',sessionId:id,text:'continue without queueing while terminal is idle'};
    const direct=await request('/api/actions',idleSend);assert.equal(direct.status,200);assert.equal(direct.value.native,true);assert.equal(direct.value.queued,undefined);await new Promise(r=>setTimeout(r,30));assert.equal(deliveries.length,3);assert.equal(bridge.store.queued().length,0);
    // Dead owners must also clear a stale running status before normal SDK resume.
    writeFileSync(registryFile,JSON.stringify({...registry,pid:2147483647,status:'busy'}));assert.equal(bridge.runtime.history.claudeLiveStatus(nativeId),undefined);
  }finally{await bridge.close();await relay.close();await new Promise<void>(r=>receiver.close(()=>r()));assert.ok(root.startsWith(join(tmpdir(),'relay-steer-')));rmSync(root,{recursive:true,force:true});}
});

test('managed steering waits for the old worker cleanup, resumes the same session and preserves other queued input',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-managed-steer-')),workspace=join(root,'workspace');mkdirSync(workspace);
  const store=new BridgeStore(join(root,'bridge')),events:any[]=[],calls:any[]=[];let exited=false;
  const factory=({options}:any)=>{
    const first=calls.length===0;calls.push(options);if(!first)assert.equal(exited,true,'no second writer before original cleanup');
    const generator=(async function*(){try{
      if(first){yield {type:'assistant',uuid:'first-answer',message:{id:'first',content:[{type:'text',text:'started'}]}};await new Promise<void>(r=>{options.abortController.signal.addEventListener('abort',()=>r(),{once:true});if(options.abortController.signal.aborted)r();});}
      else{yield {type:'assistant',uuid:'steered-answer',message:{id:'steered',content:[{type:'text',text:'STEERED_OK'}]}};yield {type:'result',is_error:false};}
    }finally{if(first){await new Promise(r=>setTimeout(r,15));exited=true;}}})();
    return Object.assign(generator,{close(){options.abortController.abort();},async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(){return {rate_limits_available:true,rate_limits:{five_hour:{utilization:20,resets_at:null}}};}});
  };
  const runtime=new AgentRuntime({relayUrl:'ws://127.0.0.1:8787/bridge',hostId:'test',name:'test',dataDir:join(root,'bridge'),projects:[{id:'work',name:'work',path:workspace}],claudeHome:join(root,'empty'),codexHome:join(root,'empty')},store,()=>{},e=>events.push(e),factory as any);
  try{
    const {sessionId}=await runtime.handle({id:randomUUID(),type:'start',provider:'claude',projectId:'work',text:'owned mock task'});
    assert.equal((await runtime.handle({id:randomUUID(),type:'send',sessionId,text:'/usage'})).command,true);assert.equal(calls.length,1);assert.equal(exited,false);assert.equal(store.sessions()[0].status,'running');
    const one={id:randomUUID(),type:'send' as const,sessionId,text:'keep queued'},two={id:randomUUID(),type:'send' as const,sessionId,text:'change direction'};
    assert.equal((await runtime.handle(one)).queued,true);assert.equal((await runtime.handle(two)).queued,true);
    const result=await runtime.handle({id:randomUUID(),type:'steer',sessionId,queuedId:two.id});assert.equal(result.mode,'interrupt-resume');assert.equal(calls.length,2);assert.equal(calls[1].resume,sessionId.split(':').at(-1));
    assert.deepEqual(store.queued().map(a=>a.id),[one.id]);
    for(let i=0;i<50&&store.sessions()[0].status!=='idle';i++)await new Promise(r=>setTimeout(r,10));
    assert.ok(events.some(e=>e.type==='message'&&e.data.text==='STEERED_OK'));assert.equal(store.sessions()[0].status,'idle');
  }finally{await runtime.close();store.close();assert.ok(root.startsWith(join(tmpdir(),'relay-managed-steer-')));rmSync(root,{recursive:true,force:true});}
});
