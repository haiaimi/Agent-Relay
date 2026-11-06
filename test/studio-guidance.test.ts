import {test} from 'node:test';import assert from 'node:assert/strict';
// @ts-expect-error Pure browser presentation helper.
import {taskGuidance} from '../web/studio-guidance.js';
test('pending questions and producer reviews direct the user to the actual decision instead of restarting work',()=>{
 const t={status:'blocked',sessionId:'s',role:'qa',error:'未完成'};
 assert.equal(taskGuidance(t,{status:'waiting',questionCount:1}).action,'attention');assert.match(taskGuidance(t,{status:'waiting',questionCount:1}).label,/回答/);
 assert.match(taskGuidance({status:'awaiting-review',kind:'visual-review'}).label,/确认原画/);assert.equal(t.status,'blocked');
});
test('quality failures, missing art and interrupted work each get a single accurately named action',()=>{
 const base={status:'blocked',sessionId:'s'};
 let v=taskGuidance({...base,role:'qa',error:'实际画面未达到批准参考'},{status:'idle'});assert.match(v.label,/验收未通过/);assert.equal(v.button,'请 QA 重新实测');assert.doesNotMatch(v.button,/通过|批准/);
 v=taskGuidance({...base,role:'concept',error:'原画阶段必须交付可查看的实际图片'},{status:'idle'});assert.equal(v.button,'请 Agent 补齐原画');
 v=taskGuidance({...base,checkpoint:{reason:'连接中断'}},{status:'interrupted'});assert.equal(v.action,'resume');assert.match(v.next,/断点/);
 v=taskGuidance({...base,blockers:[{category:'environment',details:'Python 依赖缺失'}]},{status:'idle'});assert.equal(v.button,'检查环境并继续');
});
test('unknown receipts, stale state, offline devices and prerequisites do not recommend a duplicate dispatch',()=>{
 const t={status:'blocked',sessionId:'s'};
 assert.equal(taskGuidance({status:'blocked'},null).action,'repair');assert.equal(taskGuidance(t,{status:'history'}).action,'repair');assert.equal(taskGuidance(t,null,{online:false}).action,'refresh');assert.equal(taskGuidance(t,null,{syncError:'读取失败'}).action,'refresh');
 const v=taskGuidance(t,{status:'idle'},{pendingDependencies:[{id:'gate',title:'确认原画'}]});assert.equal(v.action,'dependency');assert.match(v.next,/确认原画/);assert.equal(taskGuidance(t,null,{othersRunning:true}).action,'active');
});
test('queued and running work tells the user to wait without offering a redundant operation',()=>{
 assert.equal(taskGuidance({status:'queued'}).action,'');const v=taskGuidance({status:'running'},{status:'running',activity:{label:'正在生成场景'}});assert.equal(v.action,'');assert.equal(v.next,'正在生成场景');
 assert.equal(taskGuidance({status:'done'}).action,'');
});
test('tool availability is not mistaken for a missing environment, and malformed receipts are not called QA failures',()=>{
 const t={status:'blocked',sessionId:'s',role:'qa'};
 assert.equal(taskGuidance({...t,error:'Blender、Python 与原画实际图片均已验证可用，场景视觉仍未达到批准参考'},{status:'idle'}).button,'请 QA 重新实测');
 assert.equal(taskGuidance({...t,error:'manifest.json 与 audit.json 验证通过，但场景视觉仍未达到批准参考'},{status:'idle'}).button,'请 QA 重新实测');
 assert.equal(taskGuidance({...t,error:'检查范围内未找到 Blender，Python 缺少 xatlas'},{status:'idle'}).button,'检查环境并继续');
 assert.equal(taskGuidance({...t,error:'未收到有效 STUDIO_RESULT'},{status:'idle'}).button,'请 Agent 补齐交付结果');
 assert.equal(taskGuidance({...t,role:'director',error:'职能与所选阶段不匹配'},{status:'idle'}).button,'请统筹修正计划');
});


test('automatic followups remove the routine continue button while keeping explicit approval actions',()=>{
 const t={status:'blocked',sessionId:'s',finishedAt:1,error:'GI 延期，核心流程完成',autoFollowup:{phase:'scheduled',note:'自动交回原 Agent'}};
 const g=taskGuidance(t,{status:'idle'},{automatic:true});assert.equal(g.action,'');assert.equal(g.button,'');assert.match(g.label,/自动补做/);
 assert.equal(taskGuidance({...t,status:'awaiting-review',kind:'producer-review'},{status:'idle'},{automatic:true}).action,'attention');
 assert.equal(taskGuidance(t,{status:'idle'},{automatic:false}).action,'recheck');
});


test('scheduled retries show the actual wait and collaboration never claims the original agent is running',()=>{
 const t:any={status:'blocked',sessionId:'s',finishedAt:1,autoFollowup:{phase:'scheduled',nextAt:Date.now()+900_000,note:'第13轮已安排'}};let g=taskGuidance(t,{status:'idle'},{automatic:true});assert.equal(g.label,'已安排自动续做');assert.match(g.next,/下一次核对/);t.autoFollowup={phase:'collaborating',note:'程序修复后返回本职能'};g=taskGuidance(t,{status:'idle'},{automatic:true});assert.equal(g.label,'程序协作修复中');assert.equal(g.action,'');
});
test('a waiting recovery does not promise another automatic retry or claim approval is needed',()=>{
 const t={status:'blocked',sessionId:'s',finishedAt:1,autoFollowup:{phase:'waiting',note:'外部服务恢复后核对'}};
 const g=taskGuidance(t,{status:'idle'},{automatic:true});assert.equal(g.label,'等待恢复条件');assert.equal(g.action,'recheck');assert.equal(g.button,'核对变化后继续');assert.doesNotMatch(g.next,/批准|自动补做/);
});


test('imported blocked tasks explain explicit local continuation instead of requesting a missing old native session',()=>{
 const t:any={status:'blocked',migrationContext:'Git handoff',error:'Failed validation'};
 const g=taskGuidance(t,undefined,{repositoryImported:true});assert.equal(g.action,'recheck');assert.match(g.button,/此电脑/);
 assert.equal(taskGuidance(t,undefined).action,'repair');
});
