import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileStore} from '../src/shared/files.js';
import {createHash} from 'node:crypto';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {Studio,STUDIO_ROLES,parseStudioPlan} from '../src/relay/studio.js';
import {RelayStore} from '../src/relay/store.js';
import {createRelay} from '../src/relay/server.js';
import {MAX_TEXT,validateAction,type Action,type Session} from '../src/shared/protocol.js';

const workspace=(runId:string,path:string)=>({runId,branch:'codex/studio-'+runId,project:{id:'studio-'+runId,name:'Demand workspace',path,roots:[path]},sourcePath:path,sourceBranch:'main',head:'abc',trackedSnapshot:false,untrackedFiles:0,createdAt:Date.now()});
const roles=()=>STUDIO_ROLES.map(([role])=>({role,enabled:true,provider:role==='director'?'claude' as const:'codex' as const,instructions:'',tools:''}));
const plan=(tasks:any[])=>'```STUDIO_PLAN\n'+JSON.stringify({tasks})+'\n```';
const task=(id:string,dependencies:string[]=[],role='engineering')=>({id,title:id,role,brief:'实现 '+id,acceptance:'实际检查 '+id,dependencies});
const result=(outcome='done',summary='已完成')=>'```STUDIO_RESULT\n'+JSON.stringify({outcome,summary,artifacts:[{path:'game/test.tscn',description:'可运行入口'}],checks:['执行实际检查：通过']})+'\n```';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const skipRequest=(run:any,t:any,reason='保留角度问题，先交给独立 QA 检查')=>({op:'skip-task',runId:run.id,taskId:t.id,feedback:reason,expectedActionId:t.actionId??null,expectedFinishedAt:t.finishedAt??null});
const selectedFlow=(stages:string[],approvals={})=>({template:'custom',stages,approvals:{plan:false,design:false,visual:false,scene:false,final:false,...approvals}});
async function fixture(prepareFailure=false,inspectVisual:()=>Promise<{sha256:string}>=async()=>({sha256:'a'.repeat(64)})){
  const dir=mkdtempSync(join(tmpdir(),'relay-studio-')),store=new RelayStore(dir),actions:Action[]=[],files=new FileStore(dir,store.db);let online=true;
  store.host({id:'workstation',name:'工作电脑',capabilities:{studioWorkspaces:true},online:true,lastSeen:Date.now(),projects:[{id:'game',name:'Game',path:dir}],agents:[{id:'codex',provider:'codex',name:'Codex'},{id:'claude',provider:'claude',name:'Claude'}]});
  const studio=new Studio(store,async(_host,action)=>{if(action.type==='prepare-workspace'){if(prepareFailure)throw Error('Git preparation failed');return {workspace:workspace(action.workspaceId!,dir)};}actions.push(action);if(action.type==='upload')return {file:action.upload!.file};if(action.type==='send'){const s=store.getSession(action.sessionId!)!;store.session({...s,status:'running'});return {ok:true,sessionId:action.sessionId,queued:s.status==='running'};}if(action.type==='stop')return {ok:true};const nativeId=randomUUID(),session:Session={id:'workstation:'+action.provider+':'+nativeId,hostId:'workstation',provider:action.provider!,nativeId,title:'工作室任务',cwd:dir,projectId:action.projectId??store.getSession(action.sessionId!)?.projectId,updatedAt:Date.now(),status:'running',managed:true};store.session(session);return {sessionId:session.id};},()=>online,()=>{},files,inspectVisual);
  const project=studio.saveProject({name:'测试团队',hostId:'workstation',projectId:'game',workspaceIndex:0,roles:roles(),permissionMode:'request',concurrency:1,reviewPlan:true});
  const run=()=>studio.runs()[0];
  const settle=async()=>{await studio.tick();await turn();await studio.tick();await turn();};
  const finish=(t:any,output:string,status:Session['status']='idle')=>{const s=store.getSession(t.sessionId)!;assert.ok(s);store.event({id:randomUUID(),hostId:s.hostId,sessionId:s.id,type:'message',data:{id:randomUUID(),role:'assistant',text:output},at:Date.now()});store.session({...s,status,updatedAt:Date.now()});};
  return {dir,store,studio,project,actions,files,run,finish,settle,setOnline:(v:boolean)=>{online=v;},async close(){await studio.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('producer skip releases the next QA with failure evidence, remains durable and is not acceptance',async()=>{
  const f=await fixture();try{
    f.studio.saveProject({...f.project,reviewPlan:false});f.studio.createRun({workflow:'general',projectId:f.project.id,title:'独立验收',brief:'检查跳过后的行为'});await f.settle();f.finish(f.run().planner,plan([task('prior'),task('integration',['prior'])]));await f.settle();f.finish(f.run().tasks[0],result());await f.settle();
    const failure='```STUDIO_RESULT\n'+JSON.stringify({outcome:'blocked',summary:'四个镜角端点失败',checks:['角度端点：FAIL'],artifacts:[{path:'report.md',description:'原实测报告'}],blockers:[{category:'quality',code:'GPU_ZERO',details:'受体自身误遮挡',remedy:'按原角度回归'}]})+'\n```';
    f.finish(f.run().tasks[1],failure);await f.settle();let r=f.run(),blocked=r.tasks[1];assert.equal(r.tasks[2].status,'queued');const prior=JSON.stringify(r.tasks[0]),sid=blocked.sessionId,request=skipRequest(r,blocked);
    await assert.rejects(f.studio.command({...request,feedback:' '}),/跳过原因/);await assert.rejects(f.studio.command({...request,expectedFinishedAt:0}),/已变化/);
    await f.studio.command(request);await f.settle();r=f.run();assert.equal(r.tasks[1].status,'skipped');assert.equal(r.tasks[1].sessionId,sid);assert.equal(r.tasks[1].output,failure);assert.equal(r.tasks[1].blockers?.[0].code,'GPU_ZERO');assert.equal(r.tasks[1].checks?.[0],'角度端点：FAIL');assert.equal(JSON.stringify(r.tasks[0]),prior);assert.equal(r.tasks[2].status,'running');assert.equal(r.tasks[2].role,'qa');assert.equal(r.workspace?.value?.branch,'codex/studio-'+r.id);
    const action=f.actions.at(-1)!;assert.match(action.text!,/制作人跳过记录/);assert.match(action.text!,/GPU_ZERO/);assert.match(action.text!,/四个镜角端点失败/);assert.match(action.text!,/不得伪造通过/);assert.equal(action.projectId,'studio-'+r.id);
    const count=f.actions.length;await f.studio.command(request);await f.settle();assert.equal(f.actions.length,count);const group=f.studio.group(r.id).messages;assert.ok(group.some(m=>m.role==='producer'&&m.text.includes(request.feedback)));assert.ok(group.some(m=>m.kind==='handoff'&&m.text.includes('制作人已跳过')));
    f.finish(r.tasks[2],result('blocked','QA 复核仍失败'));await f.settle();assert.equal(f.run().delivery,undefined);assert.equal(f.run().status,'executing');await assert.rejects(f.studio.command(skipRequest(f.run(),f.run().tasks[2])),/最终 QA/);
    await f.studio.command({op:'retry',runId:r.id,taskId:r.tasks[2].id,feedback:'环境修复后独立复测'});await f.settle();f.finish(f.run().tasks[2],result());await f.settle();assert.match(f.actions.at(-1)!.text!,/交付报告必须单独列出跳过原因/);f.finish(f.run().delivery,result());await f.settle();await assert.rejects(f.studio.command({op:'accept',runId:r.id}),/明确确认/);
    await f.studio.close();const restarted=new Studio(f.store,async()=>{throw Error('unexpected dispatch');},()=>false,()=>{},f.files);try{assert.equal(restarted.runs()[0].tasks[1].skip?.reason,request.feedback);await restarted.command({op:'accept',runId:r.id,acknowledgeSkipped:true});assert.equal(restarted.runs()[0].tasks[1].status,'skipped');assert.equal(restarted.runs()[0].status,'accepted');}finally{await restarted.close();}
  }finally{await f.close();}
});

test('skip rejects running, unconfirmed, visual and planning tasks; rework clears the waiver',async()=>{
  const f=await fixture();try{
    f.studio.saveProject({...f.project,reviewPlan:false});f.studio.createRun({workflow:'general',projectId:f.project.id,title:'跳过边界',brief:'校验状态'});await f.settle();await assert.rejects(f.studio.command(skipRequest(f.run(),f.run().planner)),/只能跳过制作任务/);f.finish(f.run().planner,plan([task('a'),task('b',['a'])]));await f.settle();await assert.rejects(f.studio.command(skipRequest(f.run(),f.run().tasks[0])),/已阻断/);
    f.finish(f.run().tasks[0],result('blocked','实际失败'));await f.settle();let r=f.run();const t=r.tasks[0];f.store.db.prepare('UPDATE actions SET result=NULL WHERE id=?').run(t.actionId!);await assert.rejects(f.studio.command(skipRequest(r,t)),/尚未确认/);f.store.finishAction(t.actionId!,{sessionId:t.sessionId});
    f.store.session({...f.store.getSession(t.sessionId!)!,status:'running'});await assert.rejects(f.studio.command(skipRequest(r,t)),/尚未确认/);f.store.session({...f.store.getSession(t.sessionId!)!,status:'idle'});
    await f.studio.command({runId:r.id,op:'pause'});await f.studio.command(skipRequest(f.run(),t));await f.settle();assert.equal(f.run().paused,false);assert.equal(f.run().tasks[1].status,'running');f.finish(f.run().tasks[1],result());await f.settle();f.finish(f.run().tasks[2],result());await f.settle();f.finish(f.run().delivery,result());await f.settle();await f.studio.command({runId:r.id,taskId:t.id,op:'retry',feedback:'现在修复之前跳过的问题'});await f.settle();r=f.run();assert.equal(r.tasks[0].skip,undefined);assert.equal(r.tasks[0].status,'running');assert.equal(r.tasks[1].status,'queued');assert.equal(r.tasks[2].status,'queued');assert.equal(r.delivery,undefined);assert.ok(f.studio.group(r.id).messages.some(m=>m.text.includes('制作人跳过并继续')));
    r.tasks[1].kind='visual-review';r.tasks[1].status='blocked';f.store.db.prepare('UPDATE studio_runs SET json=? WHERE id=?').run(JSON.stringify(r),r.id);await assert.rejects(f.studio.command(skipRequest(r,r.tasks[1])),/视觉确认/);
  }finally{await f.close();}
});

test('selected level flow runs without art/assets or hidden visual gates and routes only selected approvals',async()=>{
  const f=await fixture();try{
    const flowConfig=selectedFlow(['requirements','implementation','assembly','integration','validation'],{design:true,scene:true,final:true});
    f.studio.createRun({projectId:f.project.id,title:'做三个关卡',brief:'复用已有玩法与资产',flowConfig});await f.settle();assert.match(f.actions[0].text!,/禁止补入未选原画/);
    f.finish(f.run().planner,plan([{...task('design',[],'level'),stage:'requirements'},{...task('code',['design']),stage:'implementation'},{...task('level',['code'],'environment'),stage:'assembly'},{...task('integrate',['level']),stage:'integration'}]));await f.settle();let r=f.run();assert.equal(r.status,'executing');assert.equal(r.tasks.some(t=>['concept','assets','asset-spec'].includes(t.stage??'')),false);assert.equal(r.tasks.some(t=>t.kind==='visual-review'),false);
    f.finish(r.tasks.find(t=>t.id==='design'),result());await f.settle();r=f.run();const gate=r.tasks.find(t=>t.reviewType==='design')!;assert.equal(gate.status,'awaiting-review');assert.equal(r.tasks.find(t=>t.id==='code')!.status,'queued');await assert.rejects(f.studio.command({op:'approve-step',runId:r.id,taskId:gate.id,reviewId:'stale'}),/已变化/);
    await f.studio.command({op:'reject-step',runId:r.id,taskId:gate.id,reviewId:gate.reviewId,feedback:'第二关增加一条支路'});await f.settle();r=f.run();assert.equal(r.tasks.find(t=>t.id==='design')!.status,'running');assert.equal(r.tasks.find(t=>t.reviewType==='design')!.reviewId,undefined);f.finish(r.tasks.find(t=>t.id==='design'),result());await f.settle();r=f.run();const gate2=r.tasks.find(t=>t.reviewType==='design')!;await f.studio.command({op:'approve-step',runId:r.id,taskId:gate2.id,reviewId:gate2.reviewId});await f.settle();assert.equal(f.run().tasks.find(t=>t.id==='code')!.status,'running');
    for(const id of ['code','level','integrate']){f.finish(f.run().tasks.find(t=>t.id===id),result());await f.settle();}
    r=f.run();const scene=r.tasks.find(t=>t.reviewType==='scene')!;assert.equal(scene.status,'awaiting-review');assert.equal(r.tasks.find(t=>t.stage==='validation')!.status,'queued');await f.studio.command({op:'approve-step',runId:r.id,taskId:scene.id,reviewId:scene.reviewId});await f.settle();f.finish(f.run().tasks.find(t=>t.stage==='validation'),result());await f.settle();f.finish(f.run().delivery,result());await f.settle();assert.equal(f.run().status,'review');await f.studio.command({op:'accept',runId:r.id});assert.equal(f.run().status,'accepted');assert.equal(f.run().autoAccepted,undefined);
  }finally{await f.close();}
});

test('per-demand plan and final approvals override team defaults; omitted QA is never injected or claimed passed',async()=>{
  const f=await fixture();try{
    f.studio.createRun({projectId:f.project.id,title:'仅设计几个关卡',brief:'输出设计',flowConfig:selectedFlow(['requirements'])});await f.settle();f.finish(f.run().planner,plan([{...task('LD',[],'level'),stage:'requirements'}]));await f.settle();assert.equal(f.run().status,'executing');assert.equal(f.run().tasks.length,1);f.finish(f.run().tasks[0],result());await f.settle();assert.doesNotMatch(f.run().log.at(-2)!.text,/QA 通过/);f.finish(f.run().delivery,result());await f.settle();assert.equal(f.run().status,'accepted');assert.equal(f.run().autoAccepted,true);
    f.studio.saveProject({...f.project,reviewPlan:false});f.studio.createRun({projectId:f.project.id,title:'程序修复',brief:'修复',flowConfig:selectedFlow(['implementation'],{plan:true,final:true})});await f.settle();f.finish(f.run().planner,plan([{...task('fix'),stage:'implementation'}]));await f.settle();assert.equal(f.run().status,'plan-review');
  }finally{await f.close();}
});

test('selected approvals persist across restart without auto approval or new agent launches',async()=>{
  const f=await fixture();try{
    const flowConfig=selectedFlow(['requirements'],{design:true});f.studio.createRun({projectId:f.project.id,title:'LD 设计审批',brief:'设计两个关卡',flowConfig});await f.settle();f.finish(f.run().planner,plan([{...task('LD',[],'level'),stage:'requirements'}]));await f.settle();f.finish(f.run().tasks[0],result());await f.settle();const before=f.run(),gate=before.tasks.find(t=>t.kind==='producer-review')!;assert.equal(gate.status,'awaiting-review');await f.studio.close();
    let launches=0;const recovered=new Studio(f.store,async()=>{launches++;return {};},()=>false,()=>{},f.files);try{await recovered.tick();const current=recovered.runs()[0];assert.deepEqual(current.workflow?.selection,flowConfig);assert.equal(current.tasks.find(t=>t.id===gate.id)?.reviewId,gate.reviewId);assert.equal(launches,0);await recovered.command({op:'approve-step',runId:current.id,taskId:gate.id,reviewId:gate.reviewId});assert.equal(recovered.runs()[0].tasks.find(t=>t.id===gate.id)?.status,'done');}finally{await recovered.close();}
  }finally{await f.close();}
});

test('producer flow selection rejects invalid gates, disabled required roles and unselected planner stages before dispatch',async()=>{
  const f=await fixture();try{
    assert.throws(()=>f.studio.createRun({projectId:f.project.id,title:'x',brief:'x',flowConfig:selectedFlow([])}),/至少选择/);
    assert.throws(()=>f.studio.createRun({projectId:f.project.id,title:'x',brief:'x',flowConfig:selectedFlow(['implementation'],{visual:true})}),/原画审批/);
    f.studio.saveProject({...f.project,roles:roles().map(r=>({...r,enabled:r.role!=='concept'}))});
    assert.throws(()=>f.studio.createRun({projectId:f.project.id,title:'x',brief:'x',flowConfig:selectedFlow(['concept'])}),/启用职能/);
    const workflow:any={version:2,kind:'scene',assetMode:'new',selection:selectedFlow(['requirements','implementation'])};
    assert.throws(()=>parseStudioPlan(plan([{...task('unexpected-art',[],'concept'),stage:'concept'}]),roles(),workflow),/未选择的环节/);
  }finally{await f.close();}
});

test('requested showcase runs before QA; completed deliveries can add a video without replaying earlier work',async()=>{
 const f=await fixture();try{
  f.studio.saveProject({...f.project,reviewPlan:false});f.studio.createRun({projectId:f.project.id,title:'展示验证',brief:'展示真实成果',workflow:'general',recordVideo:true});await f.settle();f.finish(f.run().planner,plan([task('work')]));await f.settle();let r=f.run();const capture=r.tasks.find(t=>t.showcase)!;assert.ok(capture);assert.ok(r.tasks.find(t=>t.role==='qa')!.dependencies.includes(capture.id));
  f.finish(r.tasks[0],result());await f.settle();assert.equal(f.run().tasks.find(t=>t.showcase)!.status,'running');f.finish(f.run().tasks.find(t=>t.showcase),result());await f.settle();assert.equal(f.run().tasks.find(t=>t.showcase)!.status,'blocked');assert.match(f.run().tasks.find(t=>t.showcase)!.error!,/视频/);
  await f.studio.command({runId:r.id,taskId:capture.id,op:'retry',feedback:'补齐实际视频'});await f.settle();const video='```STUDIO_RESULT\n'+JSON.stringify({outcome:'done',summary:'录制完成',artifacts:[{path:'project/showcase.mp4',description:'真实成果展示'}],checks:['视频播放验证']})+'\n```';f.finish(f.run().tasks.find(t=>t.showcase),video);await f.settle();f.finish(f.run().tasks.find(t=>t.role==='qa'),result());await f.settle();f.finish(f.run().delivery,result());await f.settle();await f.studio.command({op:'accept',runId:r.id});
  assert.equal((await f.studio.command({op:'record-showcase',runId:r.id})).status,'accepted');
  f.studio.createRun({projectId:f.project.id,title:'已有交付补录',brief:'只补视频',workflow:'general'});await f.settle();f.finish(f.run().planner,plan([task('existing')]));await f.settle();f.finish(f.run().tasks[0],result());await f.settle();f.finish(f.run().tasks[1],result());await f.settle();f.finish(f.run().delivery,result());await f.settle();r=f.run();await f.studio.command({op:'accept',runId:r.id});const original=JSON.stringify(f.run().tasks),oldDelivery=f.run().delivery!.sessionId;
  await f.studio.command({op:'record-showcase',runId:r.id});await f.settle();r=f.run();assert.equal(JSON.stringify(r.tasks.filter(t=>!t.showcase)),original);assert.equal(r.tasks.at(-1)!.status,'running');f.finish(r.tasks.at(-1),video);await f.settle();assert.equal(f.run().delivery?.attempts?.[0].sessionId,oldDelivery);
 }finally{await f.close();}
});

test('an invalid selected-stage plan is corrected in the same planner session without expanding scope or approvals',async()=>{
  const f=await fixture();try{
    const flowConfig=selectedFlow(['requirements','concept','assets'],{visual:true});
    f.studio.createRun({projectId:f.project.id,title:'四版场景方向',brief:'先设计几版简洁有质感的场景',flowConfig});await f.settle();
    const initial=f.run(),sid=initial.planner.sessionId,branch=initial.workspace?.value?.branch;
    assert.match(f.actions[0].text!,/assets 只能使用 model/);assert.match(f.actions[0].text!,/制作人未选 QA/);assert.doesNotMatch(f.actions[0].text!,/系统会追加最终独立 QA 任务/);
    assert.doesNotMatch(f.actions[0].text!.match(/可用职能：([^。]*)/)![1],/environment|techart|qa/);
    const bad=plan([{...task('layout',[],'level'),stage:'requirements'},{...task('art',['layout'],'concept'),stage:'concept'},{...task('kit',['art'],'model'),stage:'assets'},{...task('room',['kit'],'environment'),stage:'assets'},{...task('gi',['room'],'techart'),stage:'assets'}]);
    f.finish(initial.planner,bad);await f.settle();let current=f.run();
    assert.equal(current.planner.status,'running');assert.equal(current.planner.sessionId,sid);assert.equal(current.planner.planRepairs,1);assert.equal(current.tasks.length,0);assert.equal(current.planner.attempts?.[0].output,bad);
    assert.equal(f.actions.at(-1)!.type,'send');assert.equal(f.actions.at(-1)!.sessionId,sid);assert.match(f.actions.at(-1)!.text!,/room（environment/);assert.match(f.actions.at(-1)!.text!,/gi（techart/);assert.equal(f.actions.length,2);
    const corrected=plan([{...task('layout',[],'level'),stage:'requirements'},{...task('art',['layout'],'concept'),stage:'concept'},{...task('kit',['art'],'model'),stage:'assets'}]);
    f.finish(current.planner,corrected);await f.settle();current=f.run();
    assert.equal(current.planner.status,'done');assert.equal(current.planner.sessionId,sid);assert.equal(current.workspace?.value?.branch,branch);assert.deepEqual(current.workflow?.selection,flowConfig);
    assert.equal(current.tasks.find(t=>t.id==='layout')!.status,'running');assert.equal(current.tasks.find(t=>t.id==='kit')!.status,'queued');assert.ok(current.tasks.find(t=>t.kind==='visual-review'));assert.ok(current.tasks.every(t=>!['assembly','integration','validation'].includes(t.stage!)));assert.doesNotMatch(current.planner.summary!,/含.*QA/);
  }finally{await f.close();}
});

test('scope correction is bounded and an unconfirmed planner receipt is never automatically resent',async()=>{
  const f=await fixture();try{
    f.studio.createRun({projectId:f.project.id,title:'设计范围',brief:'只做设计',flowConfig:selectedFlow(['requirements'])});await f.settle();
    const invalid=plan([{...task('outside',[],'environment'),stage:'assembly'}]);
    for(let i=0;i<3;i++){f.finish(f.run().planner,invalid);await f.settle();}
    let r=f.run();assert.equal(r.planner.status,'blocked');assert.equal(r.planner.planRepairs,2);assert.equal(f.actions.length,3);assert.equal(r.tasks.length,0);assert.match(r.planner.error!,/未选择/);
    await f.studio.command({op:'recheck-task',runId:r.id,taskId:'studio-plan',feedback:'只修正计划，不扩大范围'});await f.settle();assert.equal(f.actions.at(-1)!.sessionId,r.planner.sessionId);assert.match(f.actions.at(-1)!.text!,/计划校验修正/);
    r=f.run();r.planner.planRepairs=0;f.store.db.prepare('UPDATE studio_runs SET json=? WHERE id=?').run(JSON.stringify(r),r.id);
    f.store.db.prepare('UPDATE actions SET result=NULL WHERE id=?').run(r.planner.actionId!);const n=f.actions.length;
    f.finish(r.planner,invalid);await f.settle();assert.equal(f.run().planner.status,'blocked');assert.equal(f.actions.length,n);
  }finally{await f.close();}
});

test('studio plans reject unknown roles, missing dependencies and cycles; final QA depends on all work',()=>{
  assert.throws(()=>parseStudioPlan(plan([task('a',['b']),task('b',['a'])]),roles()),/循环/);
  assert.throws(()=>parseStudioPlan(plan([task('a',['missing'])]),roles()),/不存在/);
  assert.throws(()=>parseStudioPlan(plan([task('a',[],'unknown')]),roles()),/职能/);
  assert.throws(()=>parseStudioPlan(plan([task('a'),task('a')]),roles()),/ID/);
  assert.throws(()=>parseStudioPlan('完成了，放心吧',roles()),/STUDIO_PLAN/);
  const tasks=parseStudioPlan(plan([task('a'),task('b',['a'])]),roles());assert.equal(tasks.at(-1)!.role,'qa');assert.deepEqual(tasks.at(-1)!.dependencies,['a','b']);
});
test('workspace preparation failure blocks every agent and independent demands target distinct projects',async()=>{
  const failed=await fixture(true);try{failed.studio.createRun({workflow:'general',projectId:failed.project.id,title:'需求',brief:'制作'});await failed.settle();assert.equal(failed.run().workspace?.status,'blocked');assert.equal(failed.actions.length,0);await failed.studio.tick();assert.equal(failed.actions.length,0);}finally{await failed.close();}
  const f=await fixture();try{const a=f.studio.createRun({workflow:'general',projectId:f.project.id,title:'A',brief:'A'});await f.settle();const b=f.studio.createRun({workflow:'general',projectId:f.project.id,title:'B',brief:'B'});await f.settle();assert.notEqual(a.id,b.id);assert.deepEqual(new Set(f.actions.map(a=>a.projectId)),new Set(['studio-'+a.id,'studio-'+b.id]));}finally{await f.close();}
});
test('producer media reaches planner and subsequent roles; downloads are confined to the owning demand',async()=>{
  const f=await fixture();try{const bytes=Buffer.from('video fixture bytes'),file=f.files.put('workstation|project:game',{id:randomUUID(),name:'reference.mp4',size:bytes.length,mime:'application/octet-stream',sha256:createHash('sha256').update(bytes).digest('hex')},bytes);
    f.studio.createRun({workflow:'general',projectId:f.project.id,title:'参考制作',brief:'按视频做原型',attachmentIds:[file.id]});await f.settle();const r=f.run();assert.deepEqual(f.actions[0].attachmentIds,[file.id]);assert.deepEqual(f.studio.file(r.id,file.id).bytes,bytes);assert.equal(f.files.ref('workstation|'+r.planner.sessionId,file.id).name,'reference.mp4');assert.throws(()=>f.studio.file(r.id,randomUUID()),/不属于/);
    f.finish(r.planner,plan([task('a')]));await f.settle();await f.studio.command({runId:r.id,op:'approve-plan'});await f.settle();assert.deepEqual(f.actions.at(-1)!.attachmentIds,[file.id]);assert.match(f.actions.at(-1)!.text!,/reference.mp4/);
  }finally{await f.close();}
});
test('role messages use the current session, retain producer guidance, deduplicate sends and reject cross-role targets',async()=>{
  const f=await fixture();try{f.studio.createRun({workflow:'general',projectId:f.project.id,title:'聊天',brief:'做关卡'});await f.settle();const r=f.run(),id=randomUUID(),v={id,runId:r.id,role:'director',sessionId:r.planner.sessionId,text:'光照要温暖'};
    const receipt=await f.studio.chat(v);assert.equal(receipt.queued,true);assert.equal(f.actions.at(-1)!.type,'send');assert.equal(f.actions.at(-1)!.sessionId,r.planner.sessionId);const calls=f.actions.length;await f.studio.chat(v);assert.equal(f.actions.length,calls);assert.equal(f.run().guidance?.[0].text,v.text);
    await assert.rejects(f.studio.chat({...v,id:randomUUID(),role:'concept'}),/不属于/);
    f.finish(r.planner,plan([task('a')]));await f.settle();await f.studio.command({runId:r.id,op:'approve-plan'});await f.settle();assert.match(f.actions.at(-1)!.text!,/光照要温暖/);
    await assert.rejects(f.studio.chat({...v,id:randomUUID()}),/其他制作任务/);
  }finally{await f.close();}
});

test('team group stores announcements, addresses roles with shared context once, and scopes its attachments and genuine replies',async()=>{
  const f=await fixture();try{
    f.studio.createRun({workflow:'general',projectId:f.project.id,title:'群聊协作',brief:'做原型'});await f.settle();const r=f.run();
    await f.studio.groupChat({id:randomUUID(),runId:r.id,text:'团队约定：先验证入口',roles:[]});const before=f.actions.length;
    const bytes=Buffer.from('group reference'),file=f.files.put('workstation|project:studio-'+r.id,{id:randomUUID(),name:'group.txt',size:bytes.length,mime:'application/octet-stream',sha256:createHash('sha256').update(bytes).digest('hex')},bytes);
    const request={id:randomUUID(),runId:r.id,text:'@制作统筹 @程序 / 集成 请核对交接',roles:['director','engineering'],attachmentIds:[file.id]},sent=await f.studio.groupChat(request);
    assert.equal(f.actions.length,before+2);assert.equal(sent.post.deliveries.every(d=>d.status==='sent'),true);
    assert.equal(f.actions.at(-2)?.type,'send');assert.match(f.actions.at(-1)!.text!,/团队约定：先验证入口/);assert.match(f.actions.at(-1)!.text!,/只读讨论/);
    await f.studio.groupChat(request);assert.equal(f.actions.length,before+2);await assert.rejects(f.studio.groupChat({...request,text:'changed'}),/ID/);
    assert.deepEqual(f.studio.file(r.id,file.id).bytes,bytes);
    const delivered=sent.post.deliveries.find(d=>d.role==='engineering')!;f.store.event({id:randomUUID(),hostId:'workstation',sessionId:delivered.sessionId!,type:'message',at:Date.now(),data:{id:'group-reply',role:'assistant',text:'程序：收到上游任务，准备核对入口。'}});
    const privateChat=await f.studio.chat({id:randomUUID(),runId:r.id,role:'audio',text:'只讨论音频'});f.store.event({id:randomUUID(),hostId:'workstation',sessionId:privateChat.sessionId,type:'message',at:Date.now(),data:{id:'private',role:'assistant',text:'PRIVATE_DISCUSSION'}});
    const messages=f.studio.group(r.id).messages;assert.equal(messages.some(m=>m.role==='engineering'&&m.text.includes('收到上游')),true);assert.doesNotMatch(JSON.stringify(messages),/PRIVATE_DISCUSSION/);
    await assert.rejects(f.studio.groupChat({...request,id:randomUUID(),roles:['unknown']}),/角色/);
  }finally{await f.close();}
});

test('unconfirmed group delivery survives restart and duplicate submission never retries it',async()=>{
  const f=await fixture();try{f.studio.createRun({workflow:'general',projectId:f.project.id,title:'群消息投递',brief:'验证'});await f.settle();const r=f.run();f.setOnline(false);
    const request={id:randomUUID(),runId:r.id,text:'请核对',roles:['director']},count=f.actions.length,first=await f.studio.groupChat(request);assert.equal(first.post.deliveries[0].status,'unconfirmed');assert.match(first.post.deliveries[0].error!,/离线/);
    f.setOnline(true);await f.studio.close();const restarted=new Studio(f.store,async()=>{throw Error('must not resend');},()=>true,()=>{},f.files);try{await restarted.groupChat(request);assert.equal(f.actions.length,count);assert.equal(restarted.group(r.id).messages.some(m=>m.deliveries?.some(d=>d.status==='unconfirmed')),true);}finally{await restarted.close();}
  }finally{await f.close();}
});

test('group handoffs preserve the actual upstream snapshot even after tasks are replanned',async()=>{
  const f=await fixture();try{f.studio.createRun({workflow:'general',projectId:f.project.id,title:'交接',brief:'验证上下游'});await f.settle();f.finish(f.run().planner,plan([task('upstream'),task('downstream',['upstream'],'level')]));await f.settle();await f.studio.command({runId:f.run().id,op:'approve-plan'});await f.settle();f.finish(f.run().tasks[0],result('done','上游实际交付快照'));await f.settle();
    const before=f.studio.group(f.run().id).messages.find(m=>m.kind==='handoff'&&m.taskId==='downstream');assert.match(before!.text,/上游实际交付快照/);assert.equal(before!.artifacts?.[0].path,'game/test.tscn');
    const replanned=f.run();replanned.tasks=[];f.store.db.prepare('UPDATE studio_runs SET json=? WHERE id=?').run(JSON.stringify(replanned),replanned.id);
    const after=f.studio.group(replanned.id).messages.find(m=>m.kind==='handoff'&&m.taskId==='downstream');assert.equal(after!.text,before!.text);assert.equal(after!.taskTitle,'downstream');
  }finally{await f.close();}
});
test('extra role conversations use assigned agents in the isolated workspace, persist and stop with demand cancellation',async()=>{
  const f=await fixture();try{f.studio.createRun({workflow:'general',projectId:f.project.id,title:'角色聊天',brief:'讨论美术方向'});await f.settle();const r=f.run(),result=await f.studio.chat({id:randomUUID(),runId:r.id,role:'concept',text:'讨论一下配色'});assert.equal(f.run().chats?.[0].sessionId,result.sessionId);assert.equal(f.actions.at(-1)!.projectId,'studio-'+r.id);assert.match(f.actions.at(-1)!.text!,/只读讨论/);assert.equal(f.actions.at(-1)!.provider,'codex');await f.studio.command({runId:r.id,op:'cancel'});assert.ok(f.actions.some(a=>a.type==='stop'&&a.sessionId===result.sessionId));}finally{await f.close();}
});
test('guiding a completed task reopens production and invalidates downstream QA',async()=>{
  const f=await fixture();try{f.studio.saveProject({...f.project,reviewPlan:false});f.studio.createRun({workflow:'general',projectId:f.project.id,title:'返工',brief:'制作'});await f.settle();f.finish(f.run().planner,plan([task('a')]));await f.settle();f.finish(f.run().tasks[0],result());await f.settle();f.finish(f.run().tasks[1],result());await f.settle();f.finish(f.run().delivery,result());await f.settle();assert.equal(f.run().status,'review');const r=f.run();await f.studio.chat({id:randomUUID(),runId:r.id,role:'engineering',sessionId:r.tasks[0].sessionId,text:'请把灯改成暖色'});assert.equal(f.run().status,'executing');assert.equal(f.run().tasks[0].status,'running');assert.equal(f.run().tasks[1].status,'queued');assert.equal(f.run().tasks[1].sessionId,undefined);assert.equal(f.run().delivery,undefined);}finally{await f.close();}
});
test('studio routes independent role sessions through plan confirmation, dependencies, QA, delivery and acceptance',async()=>{
  const f=await fixture();try{
    f.studio.createRun({workflow:'general',projectId:f.project.id,title:'第一关',brief:'做一个可运行关卡'});await f.settle();assert.equal(f.actions.length,1);assert.equal(f.actions[0].provider,'claude');
    assert.equal(f.run().workspace?.status,'ready');assert.equal(f.actions[0].projectId,'studio-'+f.run().id);
    assert.throws(()=>f.studio.saveProject({...f.project,name:'修改中'}),/仍有/);
    f.finish(f.run().planner,plan([task('a'),task('b',['a'])]));await f.settle();assert.equal(f.run().status,'plan-review');assert.equal(f.actions.length,1);
    await f.studio.command({runId:f.run().id,op:'approve-plan'});await f.settle();assert.equal(f.run().tasks[0].status,'running');assert.equal(f.run().tasks[1].status,'queued');assert.equal(f.actions[1].provider,'codex');
    f.finish(f.run().tasks[0],result('done','程序交付'));await f.settle();assert.equal(f.run().tasks[1].status,'running');assert.match(f.actions.at(-1)!.text!,/程序交付/);
    f.finish(f.run().tasks[1],result());await f.settle();assert.equal(f.run().tasks.at(-1)!.role,'qa');assert.equal(f.run().tasks.at(-1)!.status,'running');
    f.finish(f.run().tasks.at(-1),result());await f.settle();assert.equal(f.run().status,'delivery');assert.equal(f.run().delivery!.status,'running');assert.equal(f.actions.at(-1)!.provider,'claude');
    f.finish(f.run().delivery,result('done','交付报告'));await f.settle();assert.equal(f.run().status,'review');await f.studio.command({runId:f.run().id,op:'accept'});assert.equal(f.run().status,'accepted');
    assert.throws(()=>f.studio.createRun({workflow:'general',projectId:f.project.id,title:'',brief:'bad'}),/名称/);
  }finally{await f.close();}
});
test('blocked QA stops delivery, rework invalidates downstream and preserves old attempts; pause survives refresh',async()=>{
  const f=await fixture();try{
    f.studio.createRun({workflow:'general',projectId:f.project.id,title:'需求',brief:'制作'});await f.settle();f.finish(f.run().planner,plan([task('a'),task('b',['a'])]));await f.settle();await f.studio.command({runId:f.run().id,op:'approve-plan'});await f.settle();
    await f.studio.command({runId:f.run().id,op:'pause'});f.finish(f.run().tasks[0],result());await f.settle();assert.equal(f.run().tasks[1].status,'queued');assert.equal(f.run().paused,true);
    f.setOnline(false);await f.studio.command({runId:f.run().id,op:'resume'});await f.settle();assert.equal(f.run().tasks[1].status,'queued');f.setOnline(true);await f.settle();f.finish(f.run().tasks[1],result());await f.settle();
    f.finish(f.run().tasks.at(-1),result('blocked','测试失败：入口缺失'));await f.settle();assert.equal(f.run().tasks.at(-1)!.status,'blocked');assert.equal(f.run().delivery,undefined);
    const old=f.run().tasks[0].sessionId;await f.studio.command({runId:f.run().id,op:'retry',taskId:'a',feedback:'修复入口'});await f.settle();assert.notEqual(f.run().tasks[0].sessionId,old);assert.equal(f.run().tasks[0].attempts![0].sessionId,old);assert.equal(f.run().tasks[1].status,'queued');assert.equal(f.run().tasks.at(-1)!.status,'queued');
    await f.studio.command({runId:f.run().id,op:'cancel'});assert.equal(f.run().status,'cancelled');assert.equal(f.actions.at(-1)!.type,'stop');
  }finally{await f.close();}
});
test('malformed output and failed execution cannot masquerade as completion; restart never duplicates uncertain delivery',async()=>{
  const f=await fixture();try{
    f.studio.createRun({workflow:'general',projectId:f.project.id,title:'需求',brief:'制作'});await f.settle();f.finish(f.run().planner,'看起来完成了');await f.settle();assert.equal(f.run().planner.status,'blocked');assert.equal(f.run().tasks.length,0);
    await f.studio.command({runId:f.run().id,op:'retry',taskId:'studio-plan',feedback:'请按格式输出'});await f.settle();f.finish(f.run().planner,'', 'failed');await f.settle();assert.equal(f.run().planner.status,'blocked');
    await f.studio.close();const r=f.run();r.planner.status='starting';r.planner.actionId=randomUUID();r.planner.sessionId=undefined;f.store.db.prepare('UPDATE studio_runs SET json=? WHERE id=?').run(JSON.stringify(r),r.id);
    let calls=0;const recovered=new Studio(f.store,async()=>{calls++;return {};},()=>true,()=>{});await recovered.tick();assert.equal(recovered.runs()[0].planner.status,'blocked');assert.match(recovered.runs()[0].planner.error!,/不会自动重发/);assert.equal(calls,0);await recovered.close();
  }finally{await f.close();}
});
test('parallel studio work respects its limit and dependencies, and QA requires verification evidence',async()=>{
  const f=await fixture();try{
    f.studio.saveProject({...f.project,concurrency:2,reviewPlan:false});
    f.studio.createRun({workflow:'general',projectId:f.project.id,title:'并发制作',brief:'分工明确'});await f.settle();f.finish(f.run().planner,plan([task('a'),task('b'),task('c',['a'])]));await f.settle();
    assert.equal(f.run().tasks.filter(t=>t.status==='running').length,2);assert.equal(f.run().tasks[2].status,'queued');
    f.finish(f.run().tasks[0],result());await f.settle();assert.equal(f.run().tasks[2].status,'running');assert.equal(f.run().tasks.at(-1)!.status,'queued');
    f.finish(f.run().tasks[1],result());f.finish(f.run().tasks[2],result());await f.settle();
    f.finish(f.run().tasks.at(-1),'```STUDIO_RESULT\n'+JSON.stringify({outcome:'done',summary:'没有验证记录',artifacts:[],checks:[]})+'\n```');await f.settle();
    assert.equal(f.run().tasks.at(-1)!.status,'blocked');assert.match(f.run().tasks.at(-1)!.error!,/验证记录/);assert.equal(f.run().delivery,undefined);
  }finally{await f.close();}
});
test('restart attaches confirmed action receipts without opening a duplicate agent session',async()=>{
  const f=await fixture();try{
    f.studio.createRun({workflow:'general',projectId:f.project.id,title:'恢复测试',brief:'不要重复执行'});await f.settle();await f.studio.close();
    const r=f.run(),id=r.planner.sessionId;r.planner.status='starting';r.planner.sessionId=undefined;f.store.db.prepare('UPDATE studio_runs SET json=? WHERE id=?').run(JSON.stringify(r),r.id);
    let calls=0;const recovered=new Studio(f.store,async()=>{calls++;return {};},()=>true,()=>{});await recovered.tick();assert.equal(recovered.runs()[0].planner.sessionId,id);assert.equal(recovered.runs()[0].planner.status,'running');assert.equal(calls,0);await recovered.close();
  }finally{await f.close();}
});
test('upgrading a read-only legacy plan preserves tasks, archives its source session and migrates future work',async()=>{
  const f=await fixture();try{f.studio.createRun({workflow:'general',projectId:f.project.id,title:'旧计划',brief:'保留需求'});await f.settle();f.finish(f.run().planner,plan([task('a')]));await f.settle();await f.studio.close();const r=f.run(),old=r.planner.sessionId;r.workspace=undefined;f.store.db.prepare('UPDATE studio_runs SET json=? WHERE id=?').run(JSON.stringify(r),r.id);
    const actions:Action[]=[];const upgraded=new Studio(f.store,async(_host,a)=>{actions.push(a);return {workspace:workspace(a.workspaceId!,f.dir)};},()=>true,()=>{},f.files);
    await upgraded.tick();await turn();await upgraded.tick();assert.equal(upgraded.runs()[0].status,'plan-review');assert.equal(upgraded.runs()[0].planner.sessionId,undefined);assert.equal(upgraded.runs()[0].planner.attempts?.at(-1)?.sessionId,old);assert.equal(upgraded.runs()[0].workspace?.status,'ready');assert.equal(upgraded.runs()[0].tasks.length,2);assert.deepEqual(actions.map(a=>a.type),['prepare-workspace']);await upgraded.close();
  }finally{await f.close();}
});
test('large briefs and upstream deliveries retain the output protocol within the bridge text limit',async()=>{
  const f=await fixture();try{
    f.studio.saveProject({...f.project,reviewPlan:false,roles:roles().map(r=>({...r,instructions:'责'.repeat(2500),tools:'具'.repeat(2500)}))});
    f.studio.createRun({workflow:'general',projectId:f.project.id,title:'长需求'.repeat(50),brief:'需'.repeat(12000)});await f.settle();await f.studio.groupChat({id:randomUUID(),runId:f.run().id,text:'群聊补充'.repeat(2500),roles:[]});
    f.finish(f.run().planner,plan([{...task('a'),brief:'工'.repeat(4000),acceptance:'验'.repeat(2000)},{...task('b',['a']),brief:'工'.repeat(4000),acceptance:'验'.repeat(2000)}]));await f.settle();
    f.finish(f.run().tasks[0],result('done','交'.repeat(16000)));await f.settle();
    const action=f.actions.at(-1)!;assert.equal(f.run().tasks[1].status,'running');assert.ok(action.text!.length<=MAX_TEXT);assert.match(action.text!,/```STUDIO_RESULT/);assert.doesNotThrow(()=>validateAction(action));
  }finally{await f.close();}
});
test('studio HTTP endpoints retain cookie/origin protection and dispatch to a live bridge',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'studio-http-')),phone='phone-'+randomUUID(),token='bridge-'+randomUUID(),relay=createRelay({dataDir:dir,phoneToken:phone,bridgeToken:token});relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');const base='http://127.0.0.1:'+(relay.server.address() as any).port;let cookie='',ws:WebSocket|undefined;
  const request=async(path:string,payload?:unknown,origin=base)=>{const response=await fetch(base+path,{method:payload?'POST':'GET',headers:{cookie,...payload?{'Content-Type':'application/json',origin}:{}},body:payload?JSON.stringify(payload):undefined});const c=response.headers.get('set-cookie');if(c)cookie=c.split(';')[0];return {status:response.status,value:await response.json() as any};};
  try{
    for(const asset of ['/studio','/studio.js','/studio.css','/studio-projects.js','/studio-review.js','/studio-viewport.js','/studio-avatar.js','/workspace-theme.css','/workspace-nav.css'])assert.equal((await fetch(base+asset)).status,200);
    assert.equal((await request('/api/studio')).status,401);assert.equal((await request('/api/studio/channels?runId=unknown')).status,401);assert.equal((await request('/api/studio/group?runId=unknown')).status,401);await request('/api/login',{token:phone});
    assert.equal((await request('/api/studio/project',{},'https://evil.example')).status,403);assert.equal((await request('/api/studio/group',{},'https://evil.example')).status,403);
    ws=new WebSocket(base.replace('http','ws')+'/bridge',{headers:{Authorization:'Bearer '+token}});await once(ws,'open');
    ws.send(JSON.stringify({type:'hello',host:{id:'desktop',name:'Desktop',capabilities:{studioWorkspaces:true},projects:[{id:'game',name:'Game',path:dir}],agents:[{id:'codex',provider:'codex',name:'Codex'},{id:'claude',provider:'claude',name:'Claude'}]}}));await once(ws,'message');
    const p=await request('/api/studio/project',{name:'游戏团队',hostId:'desktop',projectId:'game',workspaceIndex:0,roles:roles(),permissionMode:'request',concurrency:1,reviewPlan:true});assert.equal(p.status,200);
    let starts=0;ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.type==='action'){if(m.action.type==='prepare-workspace'){ws!.send(JSON.stringify({type:'result',id:m.action.id,result:{workspace:workspace(m.action.workspaceId,dir)}}));return;}starts++;assert.equal(m.action.provider,'claude');ws!.send(JSON.stringify({type:'result',id:m.action.id,result:{sessionId:'desktop:claude:fixture'}}));}});
    const r=await request('/api/studio/run',{projectId:p.value.project.id,title:'新关卡',brief:'交付可运行原型'});assert.equal(r.status,200);for(let i=0;i<30&&!starts;i++){await relay.studio.tick();await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(starts,1);assert.equal((await request('/api/studio')).value.runs.length,1);const channelList=await request('/api/studio/channels?runId='+r.value.run.id);assert.equal(channelList.status,200);assert.equal(channelList.value.channels[0].role,'team');assert.equal(channelList.value.channels.length,14);assert.equal((await request('/api/studio/channels?runId=unknown')).status,400);const groupRequest={id:randomUUID(),runId:r.value.run.id,text:'群消息只记录',roles:[]};assert.equal((await request('/api/studio/group',groupRequest)).status,200);assert.equal((await request('/api/studio/group?runId='+r.value.run.id)).value.messages.some((m:any)=>m.text==='群消息只记录'),true);
  }finally{ws?.terminate();await relay.close();rmSync(dir,{recursive:true,force:true});}
});

const visualResult=(path='art/concept.png')=>'```STUDIO_RESULT\n'+JSON.stringify({outcome:'done',summary:'已完成真实原画文件',artifacts:[{path,description:'本轮场景原画'}],checks:['核对原画文件已存在']})+'\n```';

test('restart preserves a task checkpoint and continues the original session without rerunning completed prerequisites',async()=>{
  const f=await fixture();let recovered:Studio|undefined;try{
    f.studio.saveProject({...f.project,reviewPlan:false});f.studio.createRun({workflow:'general',projectId:f.project.id,title:'续做',brief:'保留工程'});await f.settle();
    f.finish(f.run().planner,plan([task('a'),task('b',['a'])]));await f.settle();f.finish(f.run().tasks[0],result());await f.settle();
    const before=f.run(),id=before.tasks[1].sessionId!;f.finish(before.tasks[1],'已生成已有资源，下一步验证', 'interrupted');await f.studio.close();
    const actions:Action[]=[];recovered=new Studio(f.store,async(_host,a)=>{actions.push(a);assert.equal(a.type,'send');f.store.session({...f.store.getSession(a.sessionId!)!,status:'running'});return {sessionId:a.sessionId};},()=>true,()=>{},f.files);
    await recovered.tick();const saved=recovered.runs()[0];assert.equal(saved.tasks[1].checkpoint?.sessionId,id);assert.match(saved.tasks[1].output!,/已有资源/);assert.equal(saved.tasks[0].status,'done');
    await recovered.command({runId:saved.id,op:'continue-run'});await turn();await recovered.tick();
    assert.equal(actions.length,1);assert.equal(actions[0].sessionId,id);assert.match(actions[0].text!,/不得重跑已完成的前置任务/);assert.match(actions[0].text!,/已有资源/);assert.doesNotThrow(()=>validateAction(actions[0]));
    const resumed=recovered.runs()[0];assert.equal(resumed.workspace!.value!.branch,before.workspace!.value!.branch);assert.equal(resumed.tasks[0].sessionId,before.tasks[0].sessionId);assert.equal(resumed.tasks[0].status,'done');assert.equal(resumed.tasks[1].sessionId,id);assert.equal(resumed.tasks[1].checkpoint,undefined);
    await assert.rejects(recovered.command({runId:saved.id,op:'continue-task',taskId:'b'}),/断点/);assert.equal(actions.length,1);
  }finally{await recovered?.close();await f.close();}
});

test('unknown send receipts and QA failures cannot be resumed as interruption checkpoints',async()=>{
  const f=await fixture();try{
    f.studio.createRun({workflow:'general',projectId:f.project.id,title:'结果未知',brief:'不要重复发送'});await f.settle();const r=f.run(),t=r.planner;
    f.finish(t,'', 'interrupted');f.store.db.prepare('UPDATE actions SET result=NULL WHERE id=?').run(t.actionId!);await f.settle();assert.equal(f.run().planner.checkpoint,undefined);
    await assert.rejects(f.studio.command({runId:r.id,op:'continue-task',taskId:t.id}),/断点/);
    f.store.finishAction(t.actionId!,{sessionId:t.sessionId});f.store.session({...f.store.getSession(t.sessionId!)!,status:'idle'});await f.settle();assert.equal(f.run().planner.checkpoint,undefined);
  }finally{await f.close();}
});

test('an agent process failure retains its original session as a checkpoint; a blocked deliverable does not',async()=>{
  const f=await fixture();try{
    f.studio.saveProject({...f.project,reviewPlan:false});f.studio.createRun({workflow:'general',projectId:f.project.id,title:'进程失败',brief:'继续原任务'});await f.settle();const id=f.run().planner.sessionId;
    f.finish(f.run().planner,'已有部分设计','failed');await f.settle();assert.equal(f.run().planner.checkpoint?.sessionId,id);
    await f.studio.command({runId:f.run().id,op:'continue-task',taskId:'studio-plan'});await f.settle();assert.equal(f.actions.at(-1)!.sessionId,id);
    f.finish(f.run().planner,plan([task('a')]));await f.settle();f.finish(f.run().tasks[0],result('blocked','实际验收失败'));await f.settle();assert.equal(f.run().tasks[0].status,'blocked');assert.equal(f.run().tasks[0].checkpoint,undefined);await assert.rejects(f.studio.command({runId:f.run().id,op:'continue-task',taskId:'a'}),/断点/);
  }finally{await f.close();}
});

test('checkpoint resumption waits for the computer, respects paused work and rejects a session now owned by an active turn',async()=>{
  const f=await fixture();try{
    f.studio.createRun({workflow:'general',projectId:f.project.id,title:'规划断点',brief:'继续拆解'});await f.settle();const r=f.run();f.finish(r.planner,'已检查工程', 'interrupted');await f.studio.command({runId:r.id,op:'pause'});await f.settle();assert.ok(f.run().planner.checkpoint);const count=f.actions.length;
    f.setOnline(false);await assert.rejects(f.studio.command({runId:r.id,op:'continue-run'}),/离线/);assert.equal(f.run().paused,true);assert.equal(f.actions.length,count);
    f.setOnline(true);const s=f.store.getSession(r.planner.sessionId!)!;f.store.session({...s,status:'running'});await assert.rejects(f.studio.command({runId:r.id,op:'continue-task',taskId:r.planner.id}),/断点/);assert.equal(f.actions.length,count);
    f.store.session({...s,status:'interrupted'});await f.studio.command({runId:r.id,op:'continue-task',taskId:r.planner.id});await f.settle();assert.equal(f.actions.at(-1)!.type,'send');assert.equal(f.actions.at(-1)!.sessionId,r.planner.sessionId);assert.equal(f.run().paused,false);
    f.finish(f.run().planner,plan([task('a')]));await f.settle();assert.equal(f.run().status,'plan-review');assert.equal(f.run().planner.status,'done');
  }finally{await f.close();}
});
const gateOf=(f:any)=>f.run().tasks.find((t:any)=>t.kind==='visual-review')!;
const approveVisual=(f:any,hash='a'.repeat(64),reviewId=gateOf(f).reviewId)=>{const r=f.run(),gate=gateOf(f);return f.studio.command({runId:r.id,op:'approve-visual',taskId:gate.id,reviewId,visualHashes:r.tasks.filter((t:any)=>gate.dependencies.includes(t.id)).flatMap((t:any)=>t.artifacts.flatMap((a:any,index:number)=>/\.(png|jpe?g|gif|webp)$/i.test(a.path)?[{taskId:t.id,index,sha256:hash}]:[]))});};
async function sceneAtGate(f:Awaited<ReturnType<typeof fixture>>,concurrency=1){
  f.studio.saveProject({...f.project,reviewPlan:false,concurrency});f.studio.createRun({workflow:'scene-new',projectId:f.project.id,title:'第一关场景',brief:'制作原画、资产及正式场景'});await f.settle();f.finish(f.run().planner,plan([{...task('whitebox',[],'level'),stage:'prototype'}]));await f.settle();
  for(let i=0;i<12&&!f.run().tasks.some(t=>t.status==='awaiting-review');i++){const running=f.run().tasks.filter(t=>t.status==='running');for(const t of running)f.finish(t,t.stage==='concept'?visualResult():result());await f.settle();}
  assert.equal(gateOf(f).status,'awaiting-review');return f.run();
}

test('skipped scene integration releases QA while retaining the exact producer-approved artwork',async()=>{
  const f=await fixture();try{
    await sceneAtGate(f);await assert.rejects(f.studio.command(skipRequest(f.run(),gateOf(f))),/视觉确认/);await approveVisual(f);await f.settle();
    for(let i=0;i<20&&!f.run().tasks.some(t=>t.role==='qa'&&t.status==='running');i++){
      for(const t of f.run().tasks.filter(t=>t.status==='running')){
        if(t.stage==='integration'){
          const gate=JSON.stringify(gateOf(f)),branch=f.run().workspace!.value!.branch;
          f.finish(t,result('blocked','实际渲染问题保留'));await f.settle();await f.studio.command(skipRequest(f.run(),f.run().tasks.find(x=>x.id===t.id)));await f.settle();assert.equal(JSON.stringify(gateOf(f)),gate);assert.equal(f.run().workspace!.value!.branch,branch);
        }else f.finish(t,result());
      }await f.settle();
    }
    assert.equal(f.run().tasks.at(-1)!.status,'running');assert.ok(f.run().tasks.some(t=>t.status==='skipped'));assert.match(f.actions.at(-1)!.text!,/实际渲染问题保留/);
  }finally{await f.close();}
});
test('scene production waits for a producer visual decision even when plan review is disabled, then follows specification/assets/LA/integration/QA',async()=>{
  const f=await fixture();try{await sceneAtGate(f);const gate=gateOf(f),r=f.run();assert.equal(r.status,'executing');assert.ok(gate.reviewId);assert.equal(f.run().tasks.some(t=>['asset-spec','assets','assembly','integration'].includes(t.stage??'')&&t.status!=='queued'),false);const before=f.actions.length;await f.settle();assert.equal(f.actions.length,before);
    await assert.rejects(f.studio.command({runId:r.id,op:'approve-visual',taskId:gate.id,reviewId:gate.reviewId}),/加载/);await assert.rejects(approveVisual(f,'a'.repeat(64),'stale'),/变化/);await assert.rejects(approveVisual(f,'b'.repeat(64)),/变化/);assert.equal(gateOf(f).status,'awaiting-review');
    await assert.rejects(f.studio.command({runId:r.id,op:'bind',taskId:gate.id,sessionId:r.planner.sessionId}),/不支持/);
    await approveVisual(f);await f.settle();assert.equal(gateOf(f).status,'done');assert.equal(gateOf(f).visualSnapshots?.[0].sha256,'a'.repeat(64));
    for(const stage of ['asset-spec','assets','assembly','integration']){const t=f.run().tasks.find(t=>t.stage===stage)!;assert.equal(t.status,'running',stage);f.finish(t,result());await f.settle();}
    const qa=f.run().tasks.at(-1)!;assert.equal(qa.role,'qa');assert.equal(qa.status,'running');f.finish(qa,result());await f.settle();assert.equal(f.run().status,'delivery');
  }finally{await f.close();}
});
test('concept completion requires an actual image reference and visual review survives restart without auto approval',async()=>{
  const f=await fixture();try{
    await sceneAtGate(f);const gate=gateOf(f);await f.studio.command({runId:f.run().id,op:'reject-visual',taskId:gate.id,reviewId:gate.reviewId,feedback:'修改构图'});await f.settle();const concept=f.run().tasks.find(t=>t.stage==='concept')!;assert.equal(concept.status,'running');f.finish(concept,result());await f.settle();assert.equal(f.run().tasks.find(t=>t.id===concept.id)!.status,'blocked');assert.match(f.run().tasks.find(t=>t.id===concept.id)!.error!,/图片/);
    await f.studio.command({runId:f.run().id,op:'retry',taskId:concept.id,feedback:'补齐真实图片'});await f.settle();f.finish(f.run().tasks.find(t=>t.id===concept.id),visualResult());await f.settle();assert.equal(gateOf(f).status,'awaiting-review');await f.studio.close();let calls=0;const recovered=new Studio(f.store,async()=>{calls++;return {};},()=>true,()=>{},f.files,async()=>({sha256:'a'.repeat(64)}));await recovered.tick();assert.equal(recovered.runs()[0].tasks.find(t=>t.kind==='visual-review')!.status,'awaiting-review');assert.equal(calls,0);await recovered.close();
  }finally{await f.close();}
});
test('concept rework invalidates the approved image snapshot and every dependent production/QA result',async()=>{
  const f=await fixture();try{await sceneAtGate(f);const oldReview=gateOf(f).reviewId;await approveVisual(f);await f.settle();const spec=f.run().tasks.find(t=>t.stage==='asset-spec')!;f.finish(spec,result());await f.settle();const model=f.run().tasks.find(t=>t.stage==='assets')!;f.finish(model,'','interrupted');await f.settle();const concept=f.run().tasks.find(t=>t.stage==='concept')!;
    await f.studio.command({runId:f.run().id,op:'retry',taskId:concept.id,feedback:'原画改成冷色'});await f.settle();assert.equal(gateOf(f).status,'queued');assert.equal(gateOf(f).reviewId,undefined);assert.equal(gateOf(f).approvedAt,undefined);assert.equal(gateOf(f).visualSnapshots,undefined);assert.ok(f.run().tasks.filter(t=>['asset-spec','assets','assembly','integration'].includes(t.stage??'')||t.role==='qa').every(t=>t.status==='queued'&&!t.sessionId));
    f.finish(f.run().tasks.find(t=>t.id===concept.id),visualResult('art/concept-v2.png'));await f.settle();assert.notEqual(gateOf(f).reviewId,oldReview);await assert.rejects(approveVisual(f,'a'.repeat(64),oldReview),/变化/);
  }finally{await f.close();}
});
test('visual review waits for gameplay and LD; rejecting art preserves completed design and keeps numeric/program tasks gated',async()=>{
  const f=await fixture();try{await sceneAtGate(f,2);const requirements=f.run().tasks.filter(t=>t.stage==='requirements'),before=requirements.map(t=>({id:t.id,sessionId:t.sessionId})),gate=gateOf(f);assert.ok(requirements.some(t=>t.role==='gameplay'));assert.ok(requirements.some(t=>t.role==='level'));assert.ok(requirements.every(t=>t.status==='done'));await f.studio.command({runId:f.run().id,op:'reject-visual',taskId:gate.id,reviewId:gate.reviewId,feedback:'调整镜头构图'});await f.settle();for(const t of before){const current=f.run().tasks.find(x=>x.id===t.id)!;assert.equal(current.status,'done');assert.equal(current.sessionId,t.sessionId);}assert.equal(gateOf(f).status,'queued');assert.equal(f.run().tasks.find(t=>t.stage==='concept')!.status,'running');assert.equal(f.run().tasks.find(t=>t.stage==='concept')!.feedback,'调整镜头构图');
  }finally{await f.close();}
});
test('legacy scene plan migration inserts missing art stages and preserves the existing review and original tasks',async()=>{
  const f=await fixture();try{f.studio.createRun({projectId:f.project.id,title:'场景',brief:'新建关卡场景',workflow:'general'});await f.settle();f.finish(f.run().planner,plan([task('code')]));await f.settle();await f.studio.close();const r=f.run();r.workflow=undefined;r.tasks=[{...task('whitebox',[],'engineering'),status:'queued'}, {...task('LA',['whitebox'],'environment'),status:'queued'}, {...task('studio-final-qa',['LA'],'qa'),status:'queued'}];f.store.db.prepare('UPDATE studio_runs SET json=? WHERE id=?').run(JSON.stringify(r),r.id);
    let calls=0;const migrated=new Studio(f.store,async()=>{calls++;return {};},()=>true,()=>{},f.files);await migrated.tick();const next=migrated.runs()[0];assert.equal(next.status,'plan-review');assert.equal(next.workflow?.kind,'scene');assert.equal(next.workflow?.error,undefined);assert.ok(next.tasks.some(t=>t.stage==='concept'));assert.ok(next.tasks.some(t=>t.stage==='assets'));assert.ok(next.tasks.some(t=>t.kind==='visual-review'));assert.ok(next.tasks.some(t=>t.id==='LA'));assert.equal(calls,0);await migrated.close();
  }finally{await f.close();}
});
test('a scene image changed after approval blocks the next production launch before an agent starts',async()=>{
  let hash='a'.repeat(64);const f=await fixture(false,async()=>({sha256:hash}));try{await sceneAtGate(f);await f.studio.command({runId:f.run().id,op:'pause'});await approveVisual(f);const calls=f.actions.length;hash='b'.repeat(64);await f.studio.command({runId:f.run().id,op:'resume'});await f.settle();const spec=f.run().tasks.find(t=>t.stage==='asset-spec')!;assert.equal(spec.status,'blocked');assert.match(spec.error!,/原画文件发生变化/);assert.equal(f.actions.length,calls);assert.equal(f.run().tasks.find(t=>t.stage==='assets')!.status,'queued');}finally{await f.close();}
});
test('legacy deliveries without a completed scene gate cannot be accepted under the new scene workflow',async()=>{
  const f=await fixture();try{await sceneAtGate(f);const r=f.run();r.status='review';r.paused=true;r.workflow!.error='旧场景计划已经开始执行，请重新拆解';f.store.db.prepare('UPDATE studio_runs SET json=? WHERE id=?').run(JSON.stringify(r),r.id);await assert.rejects(f.studio.command({runId:r.id,op:'accept'}),/重新拆解/);r.workflow!.error=undefined;f.store.db.prepare('UPDATE studio_runs SET json=? WHERE id=?').run(JSON.stringify(r),r.id);await assert.rejects(f.studio.command({runId:r.id,op:'accept'}),/视觉确认/);assert.equal(f.run().status,'review');}finally{await f.close();}
});


test('upgrading an active legacy program task checkpoints its existing session and resumes it only after visual approval',async()=>{
  const f=await fixture();try{
    await sceneAtGate(f);await f.studio.command({runId:f.run().id,op:'pause'});let r=f.run();r.workflow!.version=1;r.workflow!.upgradeRestorePaused=false;r.workflow!.error='旧流程待更新';const concept=r.tasks.find(t=>t.stage==='concept')!,gate=r.tasks.find(t=>t.kind==='visual-review')!,code=r.tasks.find(t=>t.role==='engineering')!,numbers={...task('numbers',r.tasks.filter(t=>t.stage==='requirements').map(t=>t.id),'balance'),stage:'prototype' as const,status:'queued' as const};r.tasks.push(numbers);concept.status='queued';concept.sessionId=undefined;concept.output=undefined;concept.artifacts=undefined;gate.status='queued';gate.reviewId=undefined;
    const nativeId=randomUUID(),sessionId='workstation:codex:'+nativeId;code.stage='prototype';code.status='running';code.sessionId=sessionId;code.dependencies=[numbers.id];r.tasks.find(t=>t.stage==='assembly')!.dependencies.push(code.id);f.store.session({id:sessionId,nativeId,hostId:'workstation',provider:'codex',projectId:r.workspace!.value!.project.id,cwd:f.dir,managed:true,status:'running',updatedAt:Date.now(),title:code.title});const extra=Buffer.from('new producer reference after the first program turn'),file=f.files.put('workstation|project:game',{id:randomUUID(),name:'new-reference.txt',size:extra.length,mime:'application/octet-stream',sha256:createHash('sha256').update(extra).digest('hex')},extra);f.files.link('workstation|project:game','workstation|project:'+r.workspace!.value!.project.id,file.id);r.attachments=[file];f.store.db.prepare('UPDATE studio_runs SET json=? WHERE id=?').run(JSON.stringify(r),r.id);f.actions.length=0;
    await f.studio.command({runId:r.id,op:'upgrade-scene-flow'});r=f.run();assert.equal(r.workflow!.version,2);assert.equal(r.paused,false);assert.equal(f.actions.filter(a=>a.type==='stop'&&a.sessionId===sessionId).length,1);assert.equal(r.tasks.find(t=>t.id===code.id)!.resumeSessionId,sessionId);assert.equal(r.tasks.find(t=>t.id===code.id)!.status,'queued');await f.studio.command({runId:r.id,op:'upgrade-scene-flow'});assert.equal(f.actions.filter(a=>a.type==='stop').length,1);
    await f.settle();assert.equal(f.run().tasks.find(t=>t.id===numbers.id)!.status,'queued');assert.equal(f.run().tasks.find(t=>t.id===code.id)!.status,'queued');f.finish(f.run().tasks.find(t=>t.stage==='concept'),visualResult());await f.settle();const firstReview=gateOf(f).reviewId;await f.studio.command({runId:r.id,op:'reject-visual',taskId:gate.id,reviewId:firstReview,feedback:'光线方向改为从左侧进入'});await f.settle();const revised=f.run().tasks.find(t=>t.stage==='concept')!;assert.equal(revised.feedback,'光线方向改为从左侧进入');assert.equal(f.run().tasks.find(t=>t.id===code.id)!.resumeSessionId,sessionId);f.finish(revised,visualResult('art/revised.png'));await f.settle();assert.notEqual(gateOf(f).reviewId,firstReview);await assert.rejects(approveVisual(f,'a'.repeat(64),firstReview),/变化/);await approveVisual(f);await f.settle();
    for(let i=0;i<10&&!f.actions.some(a=>a.type==='send'&&a.sessionId===sessionId);i++){for(const t of f.run().tasks.filter(t=>t.status==='running'))f.finish(t,result());await f.settle();}
    const resumes=f.actions.filter(a=>a.type==='send'&&a.sessionId===sessionId);assert.equal(resumes.length,1);assert.ok(f.actions.some(a=>a.type==='upload'&&a.upload?.scope==='workstation|'+sessionId&&a.upload.file.id===file.id));assert.deepEqual(resumes[0].attachmentIds,[file.id]);assert.match(resumes[0].text!,/从原代码续做/);assert.doesNotThrow(()=>validateAction(resumes[0]));assert.equal(f.run().tasks.find(t=>t.id===code.id)!.sessionId,sessionId);
  }finally{await f.close();}
});


test('a legacy program session interrupted while the computer was offline is checkpointed without another stop',async()=>{
  const f=await fixture();try{await sceneAtGate(f);await f.studio.command({runId:f.run().id,op:'pause'});const r=f.run(),code=r.tasks.find(t=>t.role==='engineering')!,nativeId=randomUUID(),sessionId='workstation:codex:'+nativeId;r.workflow!.version=1;r.workflow!.upgradeRestorePaused=false;r.tasks.find(t=>t.kind==='visual-review')!.status='queued';r.tasks.find(t=>t.stage==='concept')!.status='queued';code.stage='prototype';code.dependencies=r.tasks.filter(t=>t.stage==='requirements').map(t=>t.id);code.status='blocked';code.sessionId=sessionId;code.error='Agent 执行已停止';f.store.session({id:sessionId,nativeId,hostId:'workstation',provider:'codex',projectId:r.workspace!.value!.project.id,cwd:f.dir,status:'interrupted',managed:true,title:code.title,updatedAt:Date.now()});f.store.db.prepare('UPDATE studio_runs SET json=? WHERE id=?').run(JSON.stringify(r),r.id);f.actions.length=0;await f.studio.command({runId:r.id,op:'upgrade-scene-flow'});const updated=f.run().tasks.find(t=>t.id===code.id)!;assert.equal(updated.status,'queued');assert.equal(updated.resumeSessionId,sessionId);assert.equal(f.actions.filter(a=>a.type==='stop').length,0);
  }finally{await f.close();}
});

test('a blocked deliverable rechecks the same session with shared tools and preserves completed upstream work',async()=>{
  const f=await fixture();try{
    f.studio.createRun({projectId:f.project.id,title:'工具复核',brief:'复核制作环境',workflow:'general'});await f.settle();f.finish(f.run().planner,plan([task('design'),task('assets',['design'])]));await f.settle();await f.studio.command({runId:f.run().id,op:'approve-plan'});await f.settle();f.finish(f.run().tasks[0],result());await f.settle();
    const current=f.run().tasks.find(t=>t.id==='assets')!,session=current.sessionId,upstream=f.run().tasks[0].sessionId;
    f.finish(current,'```STUDIO_RESULT\n'+JSON.stringify({outcome:'blocked',summary:'工具不在 PATH',artifacts:[],checks:['检查默认目录'],blockers:[{category:'environment',code:'DCC_PATH',details:'默认目录无 Blender',remedy:'配置便携 DCC 路径后复核'}]})+'\n```');await f.settle();assert.equal(f.run().tasks[1].blockers?.[0].code,'DCC_PATH');
    const actionId=f.run().tasks[1].actionId!,receipt=f.store.db.prepare('SELECT result FROM actions WHERE id=?').get(actionId)!.result;f.store.db.prepare('UPDATE actions SET result=NULL WHERE id=?').run(actionId);
    await assert.rejects(f.studio.command({runId:f.run().id,op:'recheck-task',taskId:'assets'}),/投递结果未确认/);assert.equal(f.run().tasks[1].status,'blocked');f.store.db.prepare('UPDATE actions SET result=? WHERE id=?').run(receipt,actionId);
    f.studio.saveToolchain({projectId:f.project.id,toolchain:{blender:'E:/Portable Blender/blender.exe',pythonPaths:['E:/project-deps'],discoveryScript:'E:/relay/scripts/discover-studio-tools.mjs'}});
    await f.studio.command({runId:f.run().id,op:'recheck-task',taskId:'assets'});await f.settle();
    assert.equal(f.run().tasks[1].sessionId,session);assert.equal(f.run().tasks[0].status,'done');assert.equal(f.run().tasks[0].sessionId,upstream);
    const sends=f.actions.filter(a=>a.type==='send'&&a.sessionId===session);assert.equal(sends.length,1);assert.match(sends[0].text!,/Portable Blender/);assert.match(sends[0].text!,/不拿过期资产规格快照误判/);assert.match(sends[0].text!,/只补做未完成步骤/);
    await assert.rejects(f.studio.command({runId:f.run().id,op:'recheck-task',taskId:'assets'}));assert.equal(f.actions.filter(a=>a.type==='send'&&a.sessionId===session).length,1);
    f.finish(f.run().tasks[1],result());await f.settle();assert.equal(f.run().tasks[1].status,'done');assert.deepEqual(f.run().tasks[1].blockers,[]);
  }finally{await f.close();}
});
