import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore Browser module shared with the review UI.
import {reviewMessages,roleSessions,roleRecords,mentionedRoles,groupMessages} from '../web/studio-review.js';
// @ts-ignore Browser-native SVG generator.
import {avatarData} from '../web/studio-avatar.js';

test('production review retains native tools and public steps without replaying deltas over canonical replies',()=>{
  const event=(id:string,type:string,data:any,at:number)=>({id,type,data,at});
  const page={messages:[{id:'reply',role:'assistant',text:'完整生产回复',timestamp:30},{id:'tool',role:'tool',label:'运行验收',text:'command\nPASS',timestamp:20}],events:[
    event('a','activity',{label:'执行命令',detail:'运行关卡验证',reasoning:'HIDDEN_REASONING'},10),
    event('a2','activity',{label:'执行命令',detail:'运行关卡验证'},11),
    event('b','message',{id:'reply',role:'assistant',text:'完整'},30),
    event('c','delta',{messageId:'reply',text:'生产回复'},31),
    event('d','status',{status:'idle'},40),
  ]};
  const list=reviewMessages([page,page]);
  assert.equal(list.filter((m:any)=>m.role==='tool').length,1);
  assert.equal(list.find((m:any)=>m.id==='tool').text,'command\nPASS');
  assert.equal(list.find((m:any)=>m.id==='reply').text,'完整生产回复');
  assert.equal(list.filter((m:any)=>m.role==='activity').length,1);
  assert.doesNotMatch(JSON.stringify(list),/HIDDEN_REASONING/);
  assert.deepEqual(list.map((m:any)=>m.timestamp),[10,20,30,40]);
});

test('live steps merge across history pages, replacements remove provisional rows, and streamed replies stay ordered',()=>{
  const list=reviewMessages([{messages:[{id:'provisional',role:'assistant',text:'old',timestamp:1}],events:[]},{messages:[],events:[
    {id:'e1',type:'message',at:2,data:{id:'final',role:'assistant',text:'new',replaces:['provisional']}},
    {id:'e2',type:'delta',at:3,data:{messageId:'final',text:' reply'}},
    {id:'e3',type:'error',at:4,data:{message:'构建失败'}},
  ]}]);
  assert.equal(list.some((m:any)=>m.id==='provisional'),false);
  assert.equal(list[0].text,'new reply');assert.equal(list[1].error,true);
});

test('role review identifies task IDs and old attempts without attributing current results to archived or free conversations',()=>{
  const task={id:'ld-2',role:'level',title:'关卡布置',status:'done',sessionId:'current',attempts:[{sessionId:'old'}],summary:'本轮交付',checks:['PASS'],finishedAt:5};
  const run={createdAt:1,planner:{id:'plan',role:'director'},tasks:[task,{id:'other',role:'engineering'}],chats:[{role:'level',sessionId:'discussion'}],log:[{at:2,text:'分发：关卡布置'},{at:3,text:'上游返工',taskId:'other'},{at:4,text:'制作人重新核对',taskId:'ld-2'}]};
  const choices=roleSessions(run,'level');assert.equal(choices.length,3);assert.equal(choices[0].archived,true);assert.match(choices[1].label,/ld-2/);
  const records=roleRecords(run,'level','current');assert.equal(records.length,3);assert.equal(records[0].task.id,'ld-2');assert.equal(records.at(-1).task.checks[0],'PASS');
  assert.deepEqual(roleRecords(run,'level','old'),[]);assert.deepEqual(roleRecords(run,'level','discussion'),[]);
  assert.equal(roleRecords(run,'level','').length,3);
});

test('random role portraits are stable across devices and distinct per persisted team and role',()=>{
  assert.equal(avatarData('team-uuid','level'),avatarData('team-uuid','level'));
  assert.notEqual(avatarData('team-uuid','level'),avatarData('team-uuid','concept'));
  assert.notEqual(avatarData('team-uuid','level'),avatarData('another-team','level'));
  assert.match(decodeURIComponent(avatarData('team','qa')),/<svg/);
  assert.doesNotMatch(avatarData('<script>','<script>'),/<script>/);
});

test('group mentions address only named enabled roles and group messages retain each author and task',()=>{
  const roles=[{role:'level',enabled:true},{role:'concept',enabled:true},{role:'qa',enabled:false}],names=(id:string)=>({level:'关卡策划 / LD',concept:'原画 / 视觉设计',qa:'QA'}[id]);
  assert.deepEqual(mentionedRoles('@关卡策划 请与 @concept 核对构图',roles,names,'director'),['level','concept']);
  assert.deepEqual(mentionedRoles('@QA 请验收',roles,names,''),[]);
  const m=groupMessages([{messages:[{id:'a',role:'level',kind:'reply',at:3,text:'已交付',taskId:'ld-1',taskTitle:'白盒',sessionId:'session'}]}],names)[0];
  assert.equal(m.actor,'level');assert.equal(m.task.id,'ld-1');assert.equal(m.sourceSessionId,'session');
});
