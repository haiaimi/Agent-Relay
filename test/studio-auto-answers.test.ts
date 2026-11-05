import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RelayStore} from '../src/relay/store.js';
import {StudioAutoAnswers} from '../src/relay/studio-auto-answers.js';
import {automaticAnswer,autoQuestionId} from '../src/relay/studio-autonomy.js';
import {normalizeQuestions} from '../src/shared/questions.js';
import {createRelay} from '../src/relay/server.js';
import {once} from 'node:events';
import {WebSocket} from 'ws';

const card=()=>({id:randomUUID(),sessionId:'h:one',source:'async:call-one',status:'pending' as const,createdAt:1,questions:normalizeQuestions([{id:'q',question:'伸缩臂还是重做控制台？',options:['伸缩臂','重做控制台']}],'async')});
const context={brief:'完成机器人动作',directive:'允许伸缩前臂，保留现有控制台',planning:false};
test('automatic decisions follow the latest producer guidance without granting approval or fabricating evidence',()=>{
 const q=card(),decision=automaticAnswer(q,context);assert.match(decision.answers!.q[0],/允许伸缩前臂/);assert.match(decision.answers!.q[0],/不是制作人审批/);assert.match(decision.answers!.q[0],/不编造/);
 assert.equal(autoQuestionId(q.sessionId,q),autoQuestionId(q.sessionId,{...q,id:randomUUID()}));assert.notEqual(autoQuestionId(q.sessionId,q),autoQuestionId(q.sessionId,{...q,source:'async:new'}));
 assert.match(automaticAnswer(q,{...context,planning:true}).answers!.q[0],/只读规划/);
 q.questions[0].secret=true;assert.equal(automaticAnswer(q,context).answers,undefined);
});
test('fixed choices prefer producer instructions, then recommendation, and exclude waiting choices',()=>{
 const q=card();q.questions[0].allowOther=false;q.questions[0].options=[{label:'暂不决定，保持阻断',description:''},{label:'复用现有控制台（推荐）',description:''},{label:'重做控制台',description:''}];
 assert.deepEqual(automaticAnswer(q,context).answers!.q,['复用现有控制台（推荐）']);assert.deepEqual(automaticAnswer(q,{...context,directive:'重做控制台'}).answers!.q,['重做控制台']);
 q.questions[0].options=q.questions[0].options.slice(0,1);assert.equal(automaticAnswer(q,context).answers,undefined);
});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'studio-auto-')),store=new RelayStore(dir);let now=100_000,online=true,discoveries=0,reads=0;
 const q=card(),notes:any[]=[],submissions:any[]=[],run:any={id:'run',projectId:'team',title:'机器人',brief:'保留现有控制台',status:'executing',paused:false,workspace:{status:'ready',value:{project:{id:'work'}}},workflow:{selection:{approvals:{final:true}}},planner:{id:'studio-plan',status:'done',dependencies:[]},tasks:[{id:'task',role:'engineering',status:'running',sessionId:q.sessionId,dependencies:['design']},{id:'design',status:'done',dependencies:[]}],guidance:[{text:context.directive}]};
 store.session({id:q.sessionId,hostId:'h',projectId:'work',nativeId:'one',provider:'codex',title:'one',cwd:dir,status:'waiting',managed:true,updatedAt:now});
 const event=(c=q)=>store.event({id:randomUUID(),sessionId:c.sessionId,type:c.status==='pending'?'question':'question.resolved',at:now,data:c});event();
 let remote=async()=>{reads++;return {questions:[q],questionsAsOf:now};},submit=async(_host:string,a:any)=>{submissions.push(a);return {ok:true,sessionId:q.sessionId};};
 const studio:any={runs:()=>[run],projects:()=>[{id:'team',hostId:'h'}],recordAutomaticAnswer:(...v:any[])=>notes.push(v)};
 const service=()=>new StudioAutoAnswers(store,studio,{read:()=>{discoveries++;}} as any,async()=>remote(),async(h,a)=>submit(h,a),()=>online,()=>{},()=>now,false);
 let auto=service();
 const settle=()=>new Promise(r=>setTimeout(r,20));
 return {q,run,store,notes,submissions,event,get auto(){return auto;},get discoveries(){return discoveries;},get reads(){return reads;},time:(n:number)=>now+=n,setOnline:(v:boolean)=>online=v,setRemote:(v:any)=>remote=v,setSubmit:(v:any)=>submit=v,async cycle(){await auto.tick();await settle();},async restart(){await auto.close();auto=service();},async close(){await auto.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('unattended backend answers ordinary questions on the same thread while final approval remains selected',async()=>{
 const f=fixture();try{await f.cycle();assert.equal(f.submissions.length,0);assert.equal(f.discoveries,1);f.time(10_000);await f.cycle();assert.equal(f.submissions.length,1);assert.equal(f.submissions[0].sessionId,f.q.sessionId);assert.equal(f.run.workflow.selection.approvals.final,true);assert.equal(f.auto.records()[0].phase,'answered');assert.match(f.notes[0][2],/所选制作人审批未改变/);await f.cycle();await f.restart();await f.cycle();assert.equal(f.submissions.length,1);}finally{await f.close();}
});
test('paused, opted-out, completed, approval and foreign-workspace tasks never trigger automatic answers',async()=>{
 for(const change of [(f:any)=>f.run.paused=true,(f:any)=>f.run.autoAnswerQuestions=false,(f:any)=>f.run.status='accepted',(f:any)=>f.run.tasks[0].kind='review',(f:any)=>f.run.workspace.value.project.id='foreign',(f:any)=>f.run.tasks[1].status='queued']){
  const f=fixture();try{change(f);await f.cycle();f.time(20_000);await f.cycle();assert.equal(f.submissions.length,0);}finally{await f.close();}
 }
});
test('fresh live state and a human submission take precedence over a cached pending card',async()=>{
 const f=fixture();try{await f.cycle();f.store.beginAction(randomUUID(),'h',{type:'answer',sessionId:f.q.sessionId,questionId:f.q.id});f.time(10_000);await f.cycle();assert.equal(f.submissions.length,0);assert.equal(f.auto.records()[0].phase,'uncertain');}finally{await f.close();}
 const gone=fixture();try{gone.setRemote(async()=>({questions:[],questionsAsOf:123}));await gone.cycle();gone.time(10_000);await gone.cycle();assert.equal(gone.submissions.length,0);assert.equal(gone.auto.records()[0].phase,'closed');}finally{await gone.close();}
});
test('read failures retry five attempts at one-minute intervals; unknown writes never replay after restart',async()=>{
 const f=fixture();let reads=0;try{f.setRemote(async()=>{reads++;throw Error('connection failed');});await f.cycle();f.time(10_000);for(let i=1;i<=5;i++){await f.cycle();assert.equal(reads,i);f.time(59_999);await f.cycle();assert.equal(reads,i);f.time(1);}assert.equal(f.auto.records()[0].phase,'failed');assert.equal(f.submissions.length,0);}finally{await f.close();}
 const unknown=fixture();try{let attempts=0;unknown.setSubmit(async()=>{attempts++;throw Error('response lost after write');});await unknown.cycle();unknown.time(10_000);await unknown.cycle();assert.equal(attempts,1);assert.equal(unknown.auto.records()[0].phase,'uncertain');await unknown.restart();unknown.time(60_000);await unknown.cycle();assert.equal(attempts,1);}finally{await unknown.close();}
});
test('durable acknowledged receipts are adopted after restart without sending again',async()=>{
 const f=fixture();try{
  const action={id:randomUUID(),type:'answer',sessionId:f.q.sessionId,questionId:f.q.id};f.store.beginAction(action.id,'h',action);f.store.finishAction(action.id,{ok:true,sessionId:f.q.sessionId,queued:true});
  f.store.db.prepare('INSERT INTO studio_auto_answers VALUES(?,?)').run(autoQuestionId(f.q.sessionId,f.q),JSON.stringify({id:autoQuestionId(f.q.sessionId,f.q),runId:'run',taskId:'task',sessionId:f.q.sessionId,questionId:f.q.id,source:f.q.source,at:0,dueAt:0,phase:'sending',attempts:1,actionId:action.id}));
  await f.restart();await f.cycle();assert.equal(f.auto.records()[0].phase,'queued');assert.equal(f.submissions.length,0);
 }finally{await f.close();}
});
test('a real relay automatically discovers and answers without any browser request, retaining producer gates',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'auto-answer-http-')),bridgeToken='bridge-'+randomUUID(),app=createRelay({dataDir:dir,phoneToken:'phone-'+randomUUID(),bridgeToken});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const address=app.server.address() as any,ws=new WebSocket('ws://127.0.0.1:'+address.port+'/bridge',{headers:{Authorization:'Bearer '+bridgeToken}});let replies=0;
 const q=card();try{
  await once(ws,'open');ws.send(JSON.stringify({type:'hello',host:{id:'h',name:'Headless test worker',projects:[]}}));await once(ws,'message');
  app.store.session({id:q.sessionId,hostId:'h',projectId:'work',nativeId:'one',provider:'codex',title:'one',cwd:dir,status:'waiting',managed:true,updatedAt:Date.now()});
  const r:any={id:'run',projectId:'team',title:'自动推进',brief:'按已确认方案制作',status:'executing',paused:false,createdAt:Date.now(),updatedAt:Date.now(),revision:1,log:[],workspace:{status:'ready',value:{project:{id:'work',path:dir},sourcePath:dir,branch:'test'}},workflow:{kind:'general',selection:{version:1,stages:['implementation'],approvals:{final:true}}},planner:{id:'studio-plan',role:'director',status:'done',dependencies:[]},tasks:[{id:'task',title:'实现',role:'engineering',brief:'实现',acceptance:'实际检查',dependencies:[],status:'running',sessionId:q.sessionId,startedAt:Date.now(),actionId:randomUUID()}]};
  app.store.db.prepare('INSERT INTO studio_projects VALUES(?,?)').run('team',JSON.stringify({id:'team',hostId:'h',projectId:'work',name:'test',roles:[],concurrency:1}));app.store.db.prepare('INSERT INTO studio_runs VALUES(?,?)').run('run',JSON.stringify(r));
  ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.type!=='action')return;const a=m.action;
   if(a.type==='history')ws.send(JSON.stringify({type:'result',id:a.id,result:{messages:[],cursor:null,source:'fixture',questions:replies?[]:[q],questionsAsOf:Date.now()}}));
   else if(a.type==='answer'){replies++;assert.equal(a.sessionId,q.sessionId);assert.equal(a.questionId,q.id);ws.send(JSON.stringify({type:'result',id:a.id,result:{ok:true,sessionId:q.sessionId}}));}
  });
  const deadline=Date.now()+20_000;while(!app.store.sessionEvents(q.sessionId).some(e=>e.type==='question.resolved'&&e.data.automatic)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
  assert.equal(replies,1);const answer=app.store.sessionEvents(q.sessionId).find(e=>e.type==='question.resolved'&&e.data.automatic)!;assert.equal(answer.data.status,'answered');assert.match(answer.data.decisionReason,/既定方案/);assert.equal(app.studio.runs()[0].workflow!.selection!.approvals.final,true);
 }finally{ws.terminate();await app.close();rmSync(dir,{recursive:true,force:true});}
});
