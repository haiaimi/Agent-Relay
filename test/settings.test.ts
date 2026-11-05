import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';import {createServer} from 'node:net';import {once} from 'node:events';
import {CodexDesktop} from '../src/bridge/codex-desktop.js';
import {TranscriptSettings,codexSettings,claudeSettings} from '../src/bridge/settings.js';
import {AgentRuntime} from '../src/bridge/runtime.js';import {BridgeStore} from '../src/bridge/store.js';
import type {Session} from '../src/shared/protocol.js';
// @ts-ignore Browser module is exercised as shipped.
import {settingsPresentation,findModel,modelName} from '../web/session-settings.js';

test('Claude concrete model is not masked by the first generic default alias',()=>{
  const catalog=[
    {id:'default',name:'Default (recommended)',aliases:['claude-opus-5-5'],efforts:['low','high']},
    {id:'opus',name:'Opus 5.5',aliases:['claude-opus-5-5'],efforts:['low','high']},
    {id:'sonnet',name:'Sonnet 5.5',aliases:['claude-sonnet-5-5']}
  ];
  assert.equal(settingsPresentation({provider:'claude',model:'claude-opus-5-5',effort:'high'},catalog).model,'Opus 5.5 · 高');
  assert.equal(findModel(catalog,'claude-opus-5-5').id,'opus');
  assert.equal(modelName(catalog,'default'),'Default (recommended)');
  assert.equal(modelName(catalog.slice(0,1),'claude-opus-5-5'),'claude-opus-5-5');
  assert.equal(modelName([...catalog,{id:'claude-opus-5-5',name:'Exact model'}],'claude-opus-5-5'),'Exact model');
  assert.equal(settingsPresentation({model:'claude-opus-5-5',nextModel:'sonnet'},catalog).pending,'下一轮：Sonnet 5.5 · 强度未读取');
});

test('presentation uses this session, keeps presets separate and never guesses a default model',()=>{
  const catalog=[{id:'sol',name:'Sol',isDefault:true,defaultEffort:'high'},{id:'astra',name:'Astra',defaultEffort:'medium'}];
  assert.equal(settingsPresentation({model:'astra',effort:'high'},catalog).model,'Astra · 高');
  const preset=settingsPresentation({model:'sol',effort:'default',nextModel:'astra',nextEffort:'low',permissionMode:'request',nextPermissionMode:'full'},catalog);
  assert.equal(preset.model,'Sol · 高');assert.equal(preset.pending,'下一轮：Astra · 低');assert.equal(preset.permission,'请求批准');assert.equal(preset.permissionPending,'下一轮：完整权限');
  assert.equal(settingsPresentation({},catalog).model,'模型未读取 · 强度未读取');
  assert.equal(settingsPresentation({model:'custom'},catalog).model,'custom · 强度未读取');
  assert.equal(settingsPresentation({},catalog,true).permission,'读取权限中…');
});

test('native policies retain read-only and custom distinctions rather than implying full access',()=>{
  assert.equal(codexSettings({sandboxPolicy:{type:'dangerFullAccess'},approvalPolicy:'never'}).permissionMode,'full');
  assert.equal(codexSettings({sandboxPolicy:{type:'dangerFullAccess'},approvalPolicy:'on-request'}).permissionMode,undefined);
  assert.match(codexSettings({sandboxPolicy:{type:'readOnly'},approvalPolicy:'never'}).permissionLabel!,/只读/);
  assert.equal(claudeSettings({permissionMode:'acceptEdits'}).permissionLabel,'自动允许编辑');
  assert.equal(claudeSettings({permissionMode:'plan'}).permissionMode,undefined);
});

test('transcript settings read the last actual turn, ignore tools and invalidate on append',()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-settings-')),path=join(root,'session.jsonl'),reader=new TranscriptSettings();
  try{
    writeFileSync(path,[{type:'turn_context',payload:{model:'old',effort:'low',approval_policy:'on-request',sandbox_policy:{type:'workspace-write'}}},{type:'turn_context',payload:{model:'sol',effort:'high',approval_policy:'never',sandbox_policy:{type:'danger-full-access'}}},{type:'response_item',payload:{model:'unrelated-tool-model'}}].map(JSON.stringify as any).join('\n'));
    assert.deepEqual(reader.read('codex',path),{model:'sol',effort:'high',permissionMode:'full',permissionLabel:'完整权限',settingsSource:'transcript'});
    writeFileSync(path,JSON.stringify({type:'assistant',message:{model:'claude-real'}})+'\n'+JSON.stringify({type:'system',permissionMode:'plan'}));
    assert.equal(reader.read('claude',path).model,'claude-real');assert.match(reader.read('claude',path).permissionLabel!,/只读/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('desktop current settings override stale history without starting or resuming a writer',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-current-settings-')),path=process.platform==='win32'?'\\\\.\\pipe\\relay-settings-'+randomUUID():join(root,'socket'),owner=randomUUID(),thread=randomUUID(),frames:any[]=[];
  const server=createServer(socket=>{let buffer=Buffer.alloc(0);const send=(r:any)=>{const bytes=Buffer.from(JSON.stringify(r)),frame=Buffer.alloc(bytes.length+4);frame.writeUInt32LE(bytes.length);bytes.copy(frame,4);socket.write(frame);};socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4&&buffer.length>=buffer.readUInt32LE()+4){const n=buffer.readUInt32LE(),m=JSON.parse(buffer.subarray(4,n+4).toString());buffer=buffer.subarray(n+4);frames.push(m);
    if(m.type==='broadcast'){send({type:'broadcast',method:'thread-stream-state-changed',sourceClientId:owner,params:{hostId:'local',conversationId:thread,change:{type:'snapshot',revision:1,conversationState:{requests:[],currentPermissions:{approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}},latestThreadSettings:{model:'sol',effort:'high'}}}}});continue;}
    const result=m.method==='initialize'?{clientId:randomUUID()}:m.method==='thread-owner-discovery'?{supportsUntrustedAppInput:true}:{settings:{model:'sol',reasoningEffort:null}};
    send({type:'response',requestId:m.requestId,resultType:'success',handledByClientId:owner,result});
  }});});server.listen(path);await once(server,'listening');
  const desktop=new CodexDesktop(path),work=join(root,'work');mkdirSync(work);const store=new BridgeStore(join(root,'bridge')),published:any[]=[];
  const runtime=new AgentRuntime({hostId:'pc',name:'pc',relayUrl:'ws://unused',dataDir:join(root,'bridge'),projects:[{id:'p',name:'p',path:work}],codexHome:join(root,'none'),claudeHome:join(root,'empty')},store,s=>published.push(...s),()=>{},undefined,desktop);
  const s={id:'pc:codex:'+thread,hostId:'pc',provider:'codex' as const,nativeId:thread,cwd:work,title:'test',status:'running' as const,updatedAt:1,model:'astra',effort:'low'};
  runtime.history.list=()=>[{...s}];runtime.history.get=()=>({...s});runtime.history.page=async()=>({messages:[],cursor:null,source:'fixture'});runtime.history.asyncQuestions=()=>[];
  try{
    await runtime.handle({id:randomUUID(),type:'history',sessionId:s.id});const current=runtime.list()[0];assert.equal(current.model,'sol');assert.equal(current.effort,'high');assert.equal(current.permissionMode,'full');assert.equal(published.at(-1).model,'sol');
    assert.equal(frames.filter(f=>f.method==='thread-follower-read-model-settings')[0].version,1);
    assert.equal(frames.some(f=>['thread/start','thread/resume','turn/start','thread-follower-start-turn'].includes(f.method)),false);
  }finally{await runtime.close();store.close();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});

function nativeModelFixture(){
  const root=mkdtempSync(join(tmpdir(),'relay-native-model-')),data=join(root,'data'),store=new BridgeStore(data),desktop=new CodexDesktop('');
  const nativeId=randomUUID(),session:Session={id:'pc:codex:'+nativeId,hostId:'pc',provider:'codex',nativeId,cwd:root,title:'native model test',updatedAt:1,status:'idle',managed:false,model:'old',effort:'high'};
  const config={hostId:'pc',name:'PC',relayUrl:'ws://unused',dataDir:data,projects:[{id:'p',name:'P',path:root}],codexHome:join(root,'empty'),claudeHome:join(root,'empty')};
  const make=()=>{
    const runtime=new AgentRuntime(config,store,()=>{},()=>{},undefined,desktop);
    runtime.models=async()=>[{id:'old',name:'Old',efforts:['high']},{id:'new',name:'New',efforts:['low','high'],defaultEffort:'low'}];
    runtime.history.list=()=>[{...session}];runtime.history.get=()=>({...session});runtime.history.page=async()=>({messages:[],cursor:null,source:'fixture'});runtime.history.settings=()=>({model:'old',effort:'high',settingsSource:'transcript'});
    runtime.history.refreshSessionStatus=async()=>{};runtime.history.asyncQuestions=()=>[];return runtime;
  };
  return {root,store,desktop,session,make};
}

test('an idle native Codex saves model preferences without a desktop or writer and retains them through refresh and restart',async()=>{
  const f=nativeModelFixture();let runtime=f.make();
  f.desktop.owner=async()=>{throw Error('Saving preferences must not discover a desktop owner');};
  f.desktop.setModel=async()=>{throw Error('Saving preferences must not mutate the desktop');};
  runtime.codex.start=async()=>{throw Error('Saving preferences must not start a writer');};
  try{
    const changed=await runtime.handle({id:randomUUID(),type:'set-model',sessionId:f.session.id,model:'new',effort:'default'});
    assert.deepEqual(changed,{ok:true,queued:true,model:'new',effort:'default'});
    assert.equal(runtime.list()[0].model,'old');assert.equal(runtime.list()[0].nextModel,'new');
    await assert.rejects(runtime.handle({id:randomUUID(),type:'set-model',sessionId:f.session.id,model:'unavailable'}),/模型不在/);
    await runtime.close();runtime=f.make();f.desktop.readSettings=async()=>undefined;
    await runtime.handle({id:randomUUID(),type:'history',sessionId:f.session.id});
    const current=runtime.list()[0];assert.equal(current.model,'old');assert.equal(current.nextModel,'new');assert.equal(current.nextEffort,'default');
    assert.equal(f.store.sessions()[0].nextModel,'new');
  }finally{await runtime.close();f.store.close();rmSync(f.root,{recursive:true,force:true});}
});

test('saved native model settings reach the existing owner, reset default effort explicitly and survive uncertain delivery',async()=>{
  const f=nativeModelFixture(),runtime=f.make(),sent:any[]=[];f.desktop.owner=async()=>randomUUID();
  let uncertain=true;
  f.desktop.startTurn=async(thread,id,text,input,settings)=>{sent.push(settings);if(uncertain)throw Error('Delivery outcome unknown');return {turnId:randomUUID()};};
  runtime.codex.start=async()=>{throw Error('Must not open a second writer');};
  try{
    await runtime.handle({id:randomUUID(),type:'set-model',sessionId:f.session.id,model:'new',effort:'default'});
    await assert.rejects(runtime.handle({id:randomUUID(),type:'send',sessionId:f.session.id,text:'fixture'}),/unknown/);
    assert.equal(runtime.list()[0].nextModel,'new');assert.equal(sent.length,1);
    uncertain=false;await runtime.handle({id:randomUUID(),type:'send',sessionId:f.session.id,text:'explicit next send'});
    assert.deepEqual(sent[1],{model:'new',effort:null});assert.equal(runtime.list()[0].nextModel,undefined);assert.equal(runtime.list()[0].model,'new');
  }finally{await runtime.close();f.store.close();rmSync(f.root,{recursive:true,force:true});}
});

test('a newer model selection saved during native turn acknowledgement belongs to the following turn',async()=>{
  const f=nativeModelFixture(),runtime=f.make();f.desktop.owner=async()=>randomUUID();
  let release!:(value:{turnId:string})=>void;const gate=new Promise<{turnId:string}>(r=>release=r);
  f.desktop.startTurn=async()=>gate;
  try{
    await runtime.handle({id:randomUUID(),type:'set-model',sessionId:f.session.id,model:'new',effort:'low'});
    const send=runtime.handle({id:randomUUID(),type:'send',sessionId:f.session.id,text:'fixture'});
    await new Promise(r=>setImmediate(r));
    await runtime.handle({id:randomUUID(),type:'set-model',sessionId:f.session.id,model:'old',effort:'high'});
    release({turnId:randomUUID()});await send;
    assert.equal(runtime.list()[0].nextModel,'old');assert.equal(runtime.list()[0].nextEffort,'high');
  }finally{release?.({turnId:randomUUID()});await runtime.close();f.store.close();rmSync(f.root,{recursive:true,force:true});}
});

test('saved native model settings are also used by standalone resume when the desktop is closed',async()=>{
  const f=nativeModelFixture(),runtime=f.make(),calls:any[]=[];
  runtime.codex.start=async()=>{};runtime.codex.call=async(method,params)=>{calls.push({method,params});if(method==='thread/resume')return {model:params.model};if(method==='turn/start')return {turn:{id:randomUUID()}};throw Error('Unexpected RPC');};
  try{
    await runtime.handle({id:randomUUID(),type:'set-model',sessionId:f.session.id,model:'new',effort:'low'});
    await runtime.handle({id:randomUUID(),type:'send',sessionId:f.session.id,text:'fixture'});
    assert.equal(calls.find(c=>c.method==='thread/resume').params.model,'new');assert.equal(calls.find(c=>c.method==='turn/start').params.effort,'low');assert.equal(f.store.sessions()[0].nextModel,undefined);
  }finally{await runtime.close();f.store.close();rmSync(f.root,{recursive:true,force:true});}
});
