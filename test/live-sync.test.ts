import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import {AgentRuntime} from '../src/bridge/runtime.js';import {BridgeStore} from '../src/bridge/store.js';import {validateAction} from '../src/shared/protocol.js';
// @ts-ignore Browser scheduler is exercised as shipped.
import {LivePoller} from '../web/timeline.js';

test('foreground polls serialize slow requests, pause in background and back off after failure',async()=>{
  let visible=true,clock=0,count=0,finish!:(ok:boolean)=>void;const timers=new Map<number,{fn:Function;ms:number}>();let seq=0;
  const poller=new LivePoller({enabled:()=>visible,interval:()=>1000,now:()=>clock,run:()=>{count++;return new Promise<boolean>(r=>finish=r);},setTimer:(fn:Function,ms:number)=>{timers.set(++seq,{fn,ms});return seq;},clearTimer:(id:number)=>timers.delete(id)});
  const fire=()=>{const [id,t]=[...timers][0];timers.delete(id);return t.fn();};
  poller.wake();assert.equal([...timers.values()][0].ms,0);const pending=fire();assert.equal(count,1);
  poller.wake();assert.equal(timers.size,0);clock=1800;finish(true);await pending;
  assert.equal([...timers.values()][0].ms,250);visible=false;poller.pause();assert.equal(timers.size,0);
  visible=true;poller.wake();const next=fire();finish(false);await next;assert.equal([...timers.values()][0].ms,2000);
  poller.pause();poller.wake();const third=fire();finish(true);await third;assert.equal([...timers.values()][0].ms,1000);poller.pause();
});

test('fast native history returns messages before desktop metadata and deduplicates metadata reads',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-fast-history-')),work=join(root,'work');mkdirSync(work);const store=new BridgeStore(join(root,'bridge'));let release!:(r:any)=>void,calls=0,focused=0;const published:any[]=[];
  const desktop:any={status:()=>undefined,available:()=>false,watch:async()=>{},close:()=>{},readSettings:()=>{calls++;return new Promise(r=>release=r);}};
  const runtime=new AgentRuntime({hostId:'pc',name:'pc',relayUrl:'ws://unused',dataDir:join(root,'bridge'),projects:[{id:'p',name:'p',path:work}],codexHome:join(root,'none'),claudeHome:join(root,'empty')},store,s=>published.push(...s),()=>{},undefined,desktop);
  const s={id:'pc:codex:'+randomUUID(),hostId:'pc',provider:'codex' as const,nativeId:randomUUID(),cwd:work,title:'test',status:'running' as const,updatedAt:1};
  runtime.history.list=()=>[{...s}];runtime.history.get=()=>({...s});runtime.history.settings=()=>({model:'transcript',settingsSource:'transcript'});runtime.history.page=async()=>({messages:[{id:'latest',role:'assistant',text:'current output'}],cursor:null,source:'fixture'});runtime.history.asyncQuestions=()=>[];runtime.history.refreshFocusedStatus=()=>{focused++;};
  try{
    const first=await runtime.handle({id:randomUUID(),type:'history',sessionId:s.id,live:true});assert.equal(first.messages[0].text,'current output');
    await runtime.handle({id:randomUUID(),type:'history',sessionId:s.id,live:true});assert.equal(calls,1);assert.equal(focused,2);
    release({model:'desktop-current',effort:'high',settingsSource:'desktop'});await new Promise(r=>setImmediate(r));
    assert.equal(published.at(-1).model,'desktop-current');
    await runtime.handle({id:randomUUID(),type:'history',sessionId:s.id,live:true});assert.equal(calls,1);assert.equal(runtime.list()[0].model,'desktop-current');
  }finally{await runtime.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('fast-history flag cannot be applied to writes or older-page cursors',()=>{
  assert.equal(validateAction({id:randomUUID(),type:'history',sessionId:'pc:codex:x',live:true}).live,true);
  assert.throws(()=>validateAction({id:randomUUID(),type:'send',sessionId:'pc:codex:x',text:'hello',live:true}));
  assert.throws(()=>validateAction({id:randomUUID(),type:'history',sessionId:'pc:codex:x',cursor:50,live:true}));
});
