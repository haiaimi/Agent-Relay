import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RelayStore} from '../src/relay/store.js';
import {StudioFollowups,deferredChecks} from '../src/relay/studio-followups.js';

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'studio-followup-')),store=new RelayStore(dir);let now=100_000,online=true,reads=0;
 const actionId=randomUUID(),run:any={id:'run',projectId:'team',brief:'制作机器人',title:'机器人',status:'executing',paused:false,workspace:{status:'ready',value:{project:{id:'work'}}},workflow:{selection:{approvals:{final:true}}},planner:{id:'plan',status:'done',dependencies:[]},tasks:[{id:'upstream',status:'done',dependencies:[],summary:'已有模型'},{id:'repair',title:'集成验证',role:'engineering',status:'blocked',sessionId:'h:one',actionId,finishedAt:50_000,error:'GI 已延期，角色流程通过',dependencies:['upstream'],output:'真实失败证据'},{id:'video',status:'queued',dependencies:['repair']}],guidance:[{id:'human',text:'优先完成角色和 3C，GI 相关的可以先放一放'}]};
 store.session({id:'h:one',hostId:'h',projectId:'work',nativeId:'one',provider:'codex',title:'original',cwd:dir,status:'idle',updatedAt:now});store.beginAction(actionId,'h',{id:actionId,type:'send',sessionId:'h:one'});store.finishAction(actionId,{ok:true,sessionId:'h:one'});
 const commands:any[]=[],notes:any[]=[],studio:any={runs:()=>[run],projects:()=>[{id:'team',hostId:'h'}],noteAutomaticFollowup:(_r:string,id:string,state:any)=>{run.tasks.find((t:any)=>t.id===id).autoFollowup=state;notes.push(state);},command:async(a:any)=>{commands.push(a);const t=run.tasks.find((t:any)=>t.id===a.taskId);assert.equal(t.actionId,a.expectedActionId);assert.equal(t.finishedAt??null,a.expectedFinishedAt);t.status='queued';t.resumeSessionId=t.sessionId;t.actionId=undefined;t.finishedAt=undefined;}};
 let remote=async()=>{reads++;return {questions:[],questionsAsOf:now};};
 const create=()=>new StudioFollowups(store,studio,async()=>remote(),()=>online,()=>now,false);let followups=create();
 return {run,store,commands,notes,get followups(){return followups;},get reads(){return reads;},time:(n:number)=>now+=n,setRemote:(v:any)=>remote=v,setOnline:(v:boolean)=>online=v,async tick(){await followups.tick();await new Promise(r=>setTimeout(r,20));},async restart(){await followups.close();followups=create();},async close(){await followups.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('completed blocked results automatically recheck the original task, preserving predecessors and final approval',async()=>{
 const f=fixture();try{const previous=JSON.stringify(f.run.tasks[0]);await f.tick();assert.equal(f.commands.length,0);f.time(3000);await f.tick();assert.equal(f.commands.length,1);assert.equal(f.commands[0].op,'recheck-task');assert.equal(f.commands[0].automatic,true);assert.match(f.commands[0].feedback,/不是|不需要制作人/);assert.match(f.commands[0].feedback,/deferred/);assert.equal(f.run.tasks[1].resumeSessionId,'h:one');assert.equal(f.run.tasks[2].status,'queued');assert.equal(f.run.workflow.selection.approvals.final,true);assert.equal(JSON.stringify(f.run.tasks[0]),previous);await f.restart();await f.tick();assert.equal(f.commands.length,1);}finally{await f.close();}
});
test('approvals, pause, disabled autonomy, dependencies, active writers and unknown receipts never auto-dispatch',async()=>{
 const changes=[(f:any)=>f.run.tasks[1].kind='producer-review',(f:any)=>f.run.paused=true,(f:any)=>f.run.autoAnswerQuestions=false,(f:any)=>f.run.status='accepted',(f:any)=>f.run.tasks[0].status='queued',(f:any)=>f.store.finishAction(f.run.tasks[1].actionId,{error:'unknown write'}),(f:any)=>f.store.db.prepare('UPDATE actions SET result=NULL').run(),(f:any)=>f.store.session({...f.store.getSession('h:one'),status:'running'}),(f:any)=>f.run.tasks[0].status='running',(f:any)=>f.run.workspace.value.project.id='foreign'];
 for(const change of changes){const f=fixture();try{change(f);await f.tick();f.time(10_000);await f.tick();assert.equal(f.commands.length,0);assert.equal(f.reads,0);}finally{await f.close();}}
});
test('fresh questions, a new producer pause and a changed task attempt veto a scheduled recheck',async()=>{
 for(const change of [(f:any)=>f.run.paused=true,(f:any)=>f.run.tasks[1].actionId=randomUUID(),(f:any)=>{}]){
  const f=fixture();try{await f.tick();f.setRemote(async()=>{change(f);return {questions:[{status:'pending'}],questionsAsOf:200_000};});f.time(3000);await f.tick();assert.equal(f.commands.length,0);}finally{await f.close();}
 }
});
test('connection checks use five one-minute attempts then back off without a duplicate production write',async()=>{
 const f=fixture();let reads=0;try{f.setRemote(async()=>{reads++;throw Error('connection reset');});await f.tick();f.time(3000);for(let n=1;n<=5;n++){await f.tick();assert.equal(reads,n);f.time(59_999);await f.tick();assert.equal(reads,n);f.time(1);}assert.equal(f.commands.length,0);assert.equal(f.notes.at(-1).phase,'unavailable');f.time(840_000);await f.tick();assert.equal(reads,6);}finally{await f.close();}
});
test('deferred checks require an actual explicit producer scope quote, and preserve the failed measurement',()=>{
 const r:any={brief:'制作机器人',guidance:[{id:'one',text:'优先完成角色表现和3c动画表现吧，gi相关的可以先放一放'}]};
 const d={code:'EMISSION_AB_NOISE',details:'A/B 超过噪声阈值，尚未通过，随 GI 专项延期',basis:r.guidance[0].text};assert.deepEqual(deferredChecks([d],r),[d]);
 assert.throws(()=>deferredChecks([{...d,basis:'制作人要求延期所有验收'}],r),/实际存在/);assert.throws(()=>deferredChecks([{...d,basis:r.brief}],r),/自行豁免/);assert.throws(()=>deferredChecks([d,d],r),/不能重复/);
 r.guidance[0].automatic=true;assert.throws(()=>deferredChecks([d],r),/实际存在/);
});


test('runtime failures resume automatically, while an explicit stop and model reconnect recovery keep their ownership',async()=>{
 const f=fixture();try{f.run.tasks[1].finishedAt=undefined;f.run.tasks[1].checkpoint={at:75_000,reason:'导出脚本抛出异常，已保存断点'};f.store.session({...f.store.getSession('h:one')!,status:'failed'});await f.tick();f.time(3000);await f.tick();assert.equal(f.commands.length,1);assert.equal(f.commands[0].expectedCheckpointAt,75_000);}finally{await f.close();}
 const stopped=fixture();try{const a={id:randomUUID(),type:'stop',sessionId:'h:one'};stopped.store.beginAction(a.id,'h',a);stopped.store.finishAction(a.id,{ok:true});await stopped.tick();stopped.time(3000);await stopped.tick();assert.equal(stopped.commands.length,0);}finally{await stopped.close();}
 const model=fixture();try{model.run.tasks[1].checkpoint={at:70_000,reason:'Selected model is at capacity'};await model.tick();model.time(3000);await model.tick();assert.equal(model.commands.length,0);}finally{await model.close();}
});
