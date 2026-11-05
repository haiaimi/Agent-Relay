import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {RelayStore} from '../src/relay/store.js';
import {QuestionState} from '../src/relay/question-state.js';
import type {QuestionCard} from '../src/shared/questions.js';

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'question-state-')),store=new RelayStore(dir),state=new QuestionState(store),sid='pc:codex:'+randomUUID();
 const session={id:sid,hostId:'pc',provider:'codex' as const,nativeId:sid.split(':').at(-1)!,cwd:dir,title:'Live task',status:'running' as const,updatedAt:Date.now(),questionCount:1};store.session(session);
 const card:QuestionCard={id:randomUUID(),sessionId:sid,source:'async:original',status:'pending',createdAt:Date.now(),questions:[{id:'q',header:'选择',question:'选哪一个？',options:[{label:'A'}],multiSelect:false,allowOther:false}]};
 const record=(card:QuestionCard)=>{const e={id:randomUUID(),hostId:'pc',sessionId:sid,type:card.status==='pending'?'question' as const:'question.resolved' as const,at:Date.now(),data:card};state.observe(e);store.event(e);};
 return {store,state,sid,session,card,record,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('confirmed answers remove only matching live stale counters and survive reconnects/restarts',()=>{
 const f=fixture();try{
  f.record(f.card);f.state.snapshot(f.sid,{questions:[f.card],questionsAsOf:Date.now()});assert.equal(f.state.project(f.session).questionCount,1);
  f.record({...f.card,status:'answered',delivery:'sent',answers:{q:['A']}});
  assert.equal(f.state.project(f.session).questionCount,0);assert.equal(f.state.project(f.session).status,'running');
  const page=f.state.snapshot(f.sid,{questions:[f.card],questionsAsOf:Date.now()});assert.deepEqual(page.questions,[]);assert.equal(f.store.getSession(f.sid)!.questionCount,0);
  assert.equal(new QuestionState(f.store).project(f.session).questionCount,0,'old worker reconnect cannot resurrect the answered counter');
  const alias={...f.card,id:randomUUID()};assert.deepEqual(f.state.snapshot(f.sid,{questions:[alias],questionsAsOf:Date.now()}).questions,[]);
 }finally{f.close();}
});

test('new questions invalidate old snapshots; different sources/content, unknown answers and count races remain visible',()=>{
 const f=fixture();try{
  f.record({...f.card,status:'answered',delivery:'sent'});f.state.snapshot(f.sid,{questions:[f.card],questionsAsOf:Date.now()});
  const next={...f.card,id:randomUUID(),source:'async:next'};f.record(next);assert.equal(f.state.project(f.session).questionCount,1);
  assert.equal(f.state.snapshot(f.sid,{questions:[next],questionsAsOf:Date.now()}).questions.length,1);
  assert.equal(f.state.project({...f.session,questionCount:2}).questionCount,2);
  const changed={...f.card,questions:[{...f.card.questions[0],question:'新的问题'}]};assert.equal(f.state.snapshot(f.sid,{questions:[changed],questionsAsOf:Date.now()}).questions.length,1);
  f.record({...next,status:'unknown'});assert.equal(f.state.snapshot(f.sid,{questions:[next],questionsAsOf:Date.now()}).questions.length,1);
  assert.equal(f.state.project({...f.session,status:'waiting'}).status,'waiting','never turn an actual tool/native wait into running');
 }finally{f.close();}
});

test('cached, missing and foreign live snapshots never erase current input blockers',()=>{
 const f=fixture();try{
  f.record({...f.card,status:'answered',delivery:'sent'});
  f.state.snapshot(f.sid,{questions:[f.card],questionsAsOf:Date.now(),cached:true});assert.equal(f.state.project(f.session).questionCount,1);
  f.state.snapshot(f.sid,{questions:[f.card]});assert.equal(f.state.project(f.session).questionCount,1);
  const page={questions:[{...f.card,sessionId:'foreign'}],questionsAsOf:Date.now()};assert.equal(f.state.snapshot(f.sid,page),page);assert.equal(f.state.project(f.session).questionCount,1);
 }finally{f.close();}
});

test('an answer snapshot in flight cannot conceal a newly arrived question or overwrite newer history',()=>{
 const f=fixture();try{
  f.record({...f.card,status:'answered',delivery:'sent'});const revision=f.state.revision(f.sid);
  const next={...f.card,id:randomUUID(),source:'async:new'};f.record(next);
  f.state.snapshot(f.sid,{questions:[f.card],questionsAsOf:100},revision);assert.equal(f.state.project(f.session).questionCount,1);
  f.state.snapshot(f.sid,{questions:[next],questionsAsOf:200});f.state.snapshot(f.sid,{questions:[f.card],questionsAsOf:100});assert.equal(f.state.project(f.session).questionCount,1);
 }finally{f.close();}
});
