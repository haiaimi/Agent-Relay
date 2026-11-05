import {test} from 'node:test';
import assert from 'node:assert/strict';
import {modelConnectionFailure,pendingProducerInput,handoffContext} from '../src/relay/studio-recovery.js';
test('only transient model transport or capacity errors qualify for automatic recovery',()=>{
 for(const message of ['stream disconnected before completion','network connection reset','Selected model is at capacity. Please try a different model.','HTTP 503','fetch failed','连接超时'])assert.equal(modelConnectionFailure(message),true,message);
 for(const message of ['QA 验收失败','Approval denied after network connection failed','invalid API key','quota exceeded','execution stopped','UV2 receiver missing','context length limit exceeded'])assert.equal(modelConnectionFailure(message),false,message);
});
test('producer questions and tool approvals remain blockers until their own resolved events',()=>{
 const e=(type:any,data:any)=>({id:type,sessionId:'s',type,data,at:1});
 assert.equal(pendingProducerInput([e('question',{id:'q',status:'pending'})]),true);
 assert.equal(pendingProducerInput([e('question',{id:'q',status:'pending'}),e('question.resolved',{id:'q',status:'answered'})]),false);
 assert.equal(pendingProducerInput([e('approval',{approvalId:'a'}),e('approval.resolved',{approvalId:'a',unconfirmed:true})]),true);
 assert.equal(pendingProducerInput([e('approval',{approvalId:'a'}),e('approval.resolved',{approvalId:'a',allow:false})]),false);
 assert.equal(pendingProducerInput([],1),true);
});
test('handoff context is bounded and labels partial tool records instead of asserting completion',()=>{
 const text=handoffContext(Array.from({length:40},(_,i)=>({id:String(i),sessionId:'s',type:'message' as const,at:i,data:{role:'tool',text:'path/to/worktree/report '+'.'.repeat(2000)}})),'progress');assert.ok(text.length<=8000);assert.match(text,/progress/);
});
