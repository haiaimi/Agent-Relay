import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BridgeStore} from '../src/bridge/store.js';
import {AgentRuntime} from '../src/bridge/runtime.js';
import {CodexDesktop} from '../src/bridge/codex-desktop.js';
import type {Session,RelayEvent} from '../src/shared/protocol.js';

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
