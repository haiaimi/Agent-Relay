import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {QuestionAnswers} from '../src/relay/question-answers.js';
import {RelayStore} from '../src/relay/store.js';
import {createRelay} from '../src/relay/server.js';
import {normalizeQuestions} from '../src/shared/questions.js';
import {missingDesktopOwner,questionReplyId} from '../src/shared/async-answers.js';

function fixture(remote?:(host:string,action:any)=>Promise<any>){
 const dir=mkdtempSync(join(tmpdir(),'question-delivery-')),store=new RelayStore(dir),sid='pc:codex:'+randomUUID(),qid=randomUUID(),calls:any[]=[],events:any[]=[],notes:any[]=[];
 store.session({id:sid,hostId:'pc',provider:'codex',nativeId:sid.split(':').at(-1)!,cwd:dir,title:'Original thread',status:'idle',updatedAt:Date.now()});
 const card={id:qid,sessionId:sid,source:'async:call_original',createdAt:Date.now(),status:'pending' as const,questions:normalizeQuestions([{title:'采用哪种方案？',options:['伸缩臂','控制台']}],'async').map(q=>({...q,sourceIndex:1}))};
 store.event({id:randomUUID(),sessionId:sid,type:'question',at:Date.now(),data:card});
 const service=new QuestionAnswers(store,{runs:()=>[],noteQuestionAnswer:(...v:any[])=>notes.push(v)} as any,async(host,a)=>{calls.push(a);return remote?remote(host,a):{sessionId:sid};},e=>events.push(e));
 const answer=()=>({id:randomUUID(),type:'answer' as const,sessionId:sid,questionId:qid,answers:{q0:['伸缩臂']}});
 return {dir,store,sid,qid,card,calls,events,notes,service,answer,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('definite missing desktop replies use the same thread and original item indices, with a durable receipt per question source',async()=>{
 const f=fixture();try{
  const action=f.answer(),result=await f.service.fallback('pc',action,Error('未找到本地 Codex 窗口；消息尚未投递'));
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].type,'send');assert.equal(f.calls[0].sessionId,f.sid);assert.equal(f.calls[0].id,questionReplyId(f.sid,f.card.source));
  const reply=JSON.parse(f.calls[0].text.split('\n')[1])[0];assert.deepEqual(JSON.parse(reply.questionItemId),['request_user_input_async','call_original',1]);assert.equal(reply.answer,'伸缩臂');
  f.service.confirmed('pc',action,f.card,result,Date.now());assert.equal(f.events[0].data.status,'answered');assert.equal(f.events[0].data.delivery,'sent');
  await f.service.fallback('pc',f.answer(),Error('未找到本地 Codex 窗口；消息尚未投递'));assert.equal(f.calls.length,1);
  await assert.rejects(f.service.fallback('pc',{...f.answer(),answers:{q0:['控制台']}},Error('未找到本地 Codex 窗口')),/不同/);assert.equal(f.calls.length,1);
 }finally{f.close();}
});

test('question fallback never duplicates uncertain delivery, handles queued replies honestly, and rejects unsafe errors or sessions',async()=>{
 const f=fixture(async()=>{throw Error('response lost after send');});try{
  await assert.rejects(f.service.fallback('pc',f.answer(),Error('未找到本地 Codex 窗口')),/response lost/);
  await assert.rejects(f.service.fallback('pc',f.answer(),Error('未找到本地 Codex 窗口')),/尚未确认/);assert.equal(f.calls.length,1);
 }finally{f.close();}
 const queued=fixture(async()=>({ok:true,queued:true}));try{
  const action=queued.answer(),result=await queued.service.fallback('pc',action,Error('未找到支持引导的本地 Codex 窗口；消息仍保留在队列中'));queued.service.confirmed('pc',action,queued.card,result,Date.now());assert.equal(queued.events[0].data.delivery,'queued');
  const count=queued.calls.length;await assert.rejects(queued.service.fallback('pc',queued.answer(),Error('Codex 续聊结果未确认')),/未确认/);assert.equal(queued.calls.length,count);
  await assert.rejects(queued.service.fallback('pc',{...queued.answer(),sessionId:'other'},Error('未找到本地 Codex 窗口')),/未找到/);
  assert.equal(missingDesktopOwner(Object.assign(Error('未找到本地 Codex 窗口'),{uncertain:true})),false);
 }finally{queued.close();}
});

test('HTTP question submissions recover on legacy headless workers without a second send on repeated submissions',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'question-http-')),phone='phone-'+randomUUID(),bridge='bridge-'+randomUUID(),relay=createRelay({dataDir:dir,phoneToken:phone,bridgeToken:bridge});relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
 const base='http://127.0.0.1:'+(relay.server.address() as any).port,sid='pc:codex:'+randomUUID(),qid=randomUUID();let ws:WebSocket|undefined,cookie='',sends=0;
 const request=async(path:string,payload:any)=>{const r=await fetch(base+path,{method:'POST',headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(payload)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie')!.split(';')[0];return {status:r.status,value:await r.json() as any};};
 try{
  assert.equal((await request('/api/actions',{id:randomUUID(),type:'answer',sessionId:sid,questionId:qid,answers:{q0:['A']}})).status,401);
  await request('/api/login',{token:phone});ws=new WebSocket(base.replace('http','ws')+'/bridge',{headers:{Authorization:'Bearer '+bridge}});await once(ws,'open');
  ws.send(JSON.stringify({type:'hello',host:{id:'pc',name:'Headless PC',projects:[]}}));await once(ws,'message');
  relay.store.session({id:sid,hostId:'pc',provider:'codex',nativeId:sid.split(':').at(-1)!,cwd:dir,title:'Headless answer',status:'idle',updatedAt:Date.now()});
  relay.store.event({id:randomUUID(),sessionId:sid,type:'question',at:Date.now(),data:{id:qid,sessionId:sid,source:'async:call_http',createdAt:Date.now(),status:'pending',questions:normalizeQuestions([{title:'选哪个？',options:['A','B']}],'async')}});
  ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.type!=='action')return;if(m.action.type==='answer')ws!.send(JSON.stringify({type:'result',id:m.action.id,error:'未找到本地 Codex 窗口；消息尚未投递'}));else{assert.equal(m.action.type,'send');assert.equal(m.action.sessionId,sid);sends++;ws!.send(JSON.stringify({type:'result',id:m.action.id,result:{ok:true,sessionId:sid,queued:true}}));}});
  const payload={id:randomUUID(),type:'answer',sessionId:sid,questionId:qid,answers:{q0:['A']}};
  const first=await request('/api/actions',payload);assert.equal(first.status,200);assert.equal(first.value.answerFallback,true);assert.equal(first.value.queued,true);
  assert.equal((await request('/api/actions',payload)).status,200);assert.equal((await request('/api/actions',{...payload,id:randomUUID()})).status,200);assert.equal(sends,1);
  const event=relay.store.sessionEvents(sid).at(-1)!;assert.equal(event.type,'question.resolved');assert.equal(event.data.status,'answered');
 }finally{ws?.terminate();await relay.close();rmSync(dir,{recursive:true,force:true});}
});
