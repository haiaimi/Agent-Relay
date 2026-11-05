import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Shared pure browser presentation helper.
import {studioProgress,studioRunActivity,studioSessionSignature} from '../web/studio-sidebar.js';
test('studio sidebar scopes progress to the selected team and carries real role/task identities and producer gates',()=>{
  const role=(id:string,name:string)=>({id,name}),task=(id:string,role:string,status:string,extra={})=>({id,role,title:id+' title',status,...extra});
  const runs=[{id:'a',projectId:'game',title:'First level',status:'executing',planner:task('plan','director','done'),tasks:[task('art','concept','done'),task('review','director','awaiting-review'),task('code','engineering','queued')],delivery:undefined},{id:'b',projectId:'other',title:'Hidden team',status:'review',tasks:[]}];
  const state={roles:[role('director','制作统筹'),role('concept','原画'),role('engineering','程序')],projects:[{id:'game',name:'Game team'},{id:'other',name:'Other team'}],runs};
  const value=studioProgress(state,{sessions:[]},'game');assert.equal(value.runs.length,1);assert.equal(value.activeRun,'a');assert.equal(value.runs[0].done,1);assert.equal(value.runs[0].total,3);assert.equal(value.runs[0].attention,true);assert.equal(value.runs[0].label,'待你处理');
  assert.match(value.runs[0].activity,/制作统筹 · review title/);assert.deepEqual(value.runs[0].tasks.map((t:any)=>t.id),['art','review','code']);assert.equal(value.runs[0].tasks[1].label,'待确认原画');assert.equal(value.runs[0].tasks[2].label,'等待前置');
  assert.equal(runs[0].tasks[1].status,'awaiting-review');assert.equal(value.projects.length,2);
});
test('studio sidebar exposes questions and checkpoints without claiming a blocked task is running; terminal runs remain terminal',()=>{
  const r:any={id:'run',projectId:'p',title:'Prototype',status:'executing',planner:{id:'plan',role:'director',title:'Plan',status:'done'},tasks:[{id:'code',role:'engineering',title:'Gameplay',status:'running',sessionId:'s'},{id:'qa',role:'qa',title:'QA',status:'blocked',checkpoint:{sessionId:'q'}}]};
  const state={roles:[],projects:[{id:'p',name:'P'}],runs:[r]},relay={sessions:[{id:'s',status:'waiting',questionCount:1}]};
  let value=studioProgress(state,relay,'p','run','code');assert.equal(value.runs[0].tasks[0].label,'等待你回答');assert.equal(value.runs[0].tasks[1].label,'上次工作已中断');assert.equal(value.activeTask,'code');
  r.paused=true;value=studioProgress(state,relay,'p');assert.equal(value.runs[0].label,'已暂停');
  r.paused=false;r.status='accepted';value=studioProgress(state,relay,'p');assert.equal(value.runs[0].label,'已验收');assert.equal(value.runs[0].attention,false);assert.equal(value.activeRun,undefined);
  assert.equal(studioProgress(state,relay,'missing').runs.length,0);
});

test('an old skipped detail follows current execution, approval and blockers without mutating the production state',()=>{
 const run:any={status:'executing',paused:false,planner:{id:'plan',status:'done'},tasks:[{id:'art',title:'场景',role:'environment',status:'skipped'},{id:'hud',title:'HUD',role:'ui',status:'running',sessionId:'hud-session'},{id:'qa',title:'最终QA',role:'qa',status:'queued'}]};
 let value=studioRunActivity(run,{sessions:[{id:'hud-session',status:'running'}]});assert.match(value.headline,/当前正在推进：HUD/);assert.deepEqual(value.active,['hud']);assert.equal(value.items[0].id,'hud');assert.equal(run.tasks[0].status,'skipped');
 value=studioRunActivity(run,{sessions:[{id:'hud-session',status:'idle'}]});assert.equal(value.items[0].label,'正在核对执行结果');
 run.tasks[1].status='blocked';value=studioRunActivity(run,{sessions:[]});assert.match(value.headline,/流程等待处理：HUD/);assert.deepEqual(value.blocked,['hud']);assert.deepEqual(value.active,[]);
 run.tasks[1].status='done';run.tasks[2].status='awaiting-review';value=studioRunActivity(run,{sessions:[]});assert.match(value.headline,/等待制作人确认：最终QA/);
 run.status='accepted';value=studioRunActivity(run,{sessions:[]});assert.equal(value.terminal,true);assert.deepEqual(value.items,[]);
});

test('normal running to idle and queued input changes invalidate studio presentation even without a task revision or pending question',()=>{
 const state={runs:[{planner:{sessionId:'p'},tasks:[{sessionId:'t'}],chats:[{sessionId:'chat'}]}]},relay={sessions:[{id:'t',status:'running'},{id:'chat',status:'idle'},{id:'unrelated',status:'running'}]};
 const before=JSON.stringify(studioSessionSignature(state,relay));relay.sessions[0].status='idle';assert.notEqual(JSON.stringify(studioSessionSignature(state,relay)),before);
 const idle=JSON.stringify(studioSessionSignature(state,relay));relay.sessions[2].status='failed';assert.equal(JSON.stringify(studioSessionSignature(state,relay)),idle);
 (relay.sessions[1] as any).pendingCount=1;assert.notEqual(JSON.stringify(studioSessionSignature(state,relay)),idle);
});
