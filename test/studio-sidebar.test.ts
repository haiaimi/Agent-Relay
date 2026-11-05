import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Shared pure browser presentation helper.
import {studioProgress} from '../web/studio-sidebar.js';
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
  let value=studioProgress(state,relay,'p','run','code');assert.equal(value.runs[0].tasks[0].label,'等待你回答');assert.equal(value.runs[0].tasks[1].label,'待续做');assert.equal(value.activeTask,'code');
  r.paused=true;value=studioProgress(state,relay,'p');assert.equal(value.runs[0].label,'已暂停');
  r.paused=false;r.status='accepted';value=studioProgress(state,relay,'p');assert.equal(value.runs[0].label,'已验收');assert.equal(value.runs[0].attention,false);assert.equal(value.activeRun,undefined);
  assert.equal(studioProgress(state,relay,'missing').runs.length,0);
});
