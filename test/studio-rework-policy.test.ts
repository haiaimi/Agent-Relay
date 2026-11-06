import {test} from 'node:test';
import assert from 'node:assert/strict';
import {addedToolGate,producerRequiresDesktop,reworkDecision,reworkContext,repairDependencies,REWORK_WINDOW_MS} from '../src/relay/studio-rework-policy.js';
import {validateBlockers} from '../src/relay/studio-tools.js';
const blocker={category:'quality' as const,code:'RGB',details:'still failing',remedy:'repair shader'};
function fixture(){
 const task:any={id:'qa',role:'qa',stage:'validation',brief:'实际验证移动与胜利',acceptance:'实际业务通过',actionId:'turn',status:'blocked',dependencies:['up'],blockers:[blocker]};
 const run:any={brief:'实现功能并实际验证',planner:{},tasks:[{id:'up',dependencies:[],status:'done',actionId:'up-turn',finishedAt:10},task],guidance:[],workflow:{selection:{stages:['validation']}}};
 const project:any={roles:[{role:'engineering',enabled:true}],toolchain:{}};
 const context=reworkContext(run,task,project).key;
 const history=[{phase:'queued',finishedAt:20,context,failureKey:'quality:RGB'},{phase:'queued',finishedAt:30,context,failureKey:'quality:RGB'}];
 return {run,task,project,history};
}
test('external recovery flags survive validation and legacy raw results stop re-dispatch',()=>{
 const f=fixture();const b={...blocker,category:'environment' as const,requiresExternalStateChange:true,retryableWithoutExternalChange:false,ownerTaskId:'environment-owner'};
 assert.deepEqual(validateBlockers([b]),[b]);assert.throws(()=>validateBlockers([{...b,requiresExternalStateChange:'true'}]),/布尔/);
 f.task.blockers=[{category:b.category,code:b.code,details:b.details,remedy:b.remedy}];
 f.task.output='```STUDIO_RESULT\n'+JSON.stringify({outcome:'blocked',blockers:[b]})+'\n```';
 assert.equal(reworkDecision(f.run,f.task,f.project,[],100).route,'waiting');
});
test('only producer-authorized desktop requirements survive; script scope correction is attempted once',()=>{
 const f=fixture();f.task.brief='必须通过 Computer Use 取得 App 句柄';f.task.blockers=[{...blocker,code:'NATIVE_KEYBOARD_UNVERIFIED'}];
 assert.equal(addedToolGate(f.run,f.task),true);
 let d=reworkDecision(f.run,f.task,f.project,[],100);assert.equal(d.route,'correct-scope');
 assert.equal(reworkDecision(f.run,f.task,f.project,[{phase:'queued',finishedAt:30,context:d.context,failureKey:d.key,route:d.route}],100).route,'waiting');
 f.run.brief='必须使用真实人工键盘进行试玩';assert.equal(producerRequiresDesktop(f.run),true);assert.equal(addedToolGate(f.run,f.task),false);
 f.run.guidance=[{at:40,text:'撤销人工键盘门禁，不要依赖 Computer Use；只有制作人明确要求且环境允许时才使用 Computer Use'}];
 assert.equal(producerRequiresDesktop(f.run),false);
 f.task.brief='不得把 Computer Use 或真实键盘作为门禁';f.task.blockers=[];assert.equal(addedToolGate(f.run,f.task),false);
});
test('QA hands internal defects to a scoped repair, but a failed repair cannot recursively create more owners',()=>{
 const f=fixture();assert.equal(reworkDecision(f.run,f.task,f.project,f.history,100).route,'collaborate');
 f.task.role='engineering';assert.equal(reworkDecision(f.run,f.task,f.project,f.history,100).route,'waiting');
 f.task.role='qa';f.task.remediationFor={taskId:'original'};assert.equal(reworkDecision(f.run,f.task,f.project,f.history,100).route,'waiting');
});
test('polite producer requests remain authoritative and newer cross-channel instructions override older ones',()=>{
 const f=fixture();f.run.brief='请进行一次真人试玩';assert.equal(producerRequiresDesktop(f.run),true);
 f.run.directions=[{at:20,status:'delivered',text:'需要用 Computer Use 验证'}];
 f.run.guidance=[{at:30,text:'撤销 Computer Use 门禁，走脚本路线'}];assert.equal(producerRequiresDesktop(f.run),false);
 f.run.directions.push({at:40,status:'delivered',text:'这次请用 Computer Use 做真人试玩'});assert.equal(producerRequiresDesktop(f.run),true);
});
test('renaming reports cannot reset budgets; human scope and actual upstream completion can',()=>{
 const f=fixture();f.task.role='engineering';
 f.task.summary='第184轮仍未执行新检查';assert.equal(reworkDecision(f.run,f.task,f.project,f.history,100).route,'waiting');
 f.task.summary='改写了摘要';assert.equal(reworkDecision(f.run,f.task,f.project,f.history,100).route,'waiting');
 f.run.guidance=[{id:'new',at:101,text:'依赖已修复，请复验实际结果'}];assert.equal(reworkDecision(f.run,f.task,f.project,f.history,110).route,'retry');
 f.run.guidance=[];f.run.tasks[0].actionId='new-real-fix';f.run.tasks[0].finishedAt=102;assert.equal(reworkDecision(f.run,f.task,f.project,f.history,110).route,'retry');
});
test('alternating failures and elapsed time are bounded independently of repeated blocker IDs',()=>{
 const f=fixture();f.task.role='engineering';const context=reworkContext(f.run,f.task,f.project).key;
 const history=Array.from({length:5},(_,i)=>({phase:'queued',finishedAt:20+i,context,failureKey:'different-'+i}));
 assert.equal(reworkDecision(f.run,f.task,f.project,history,100).route,'waiting');
 assert.equal(reworkDecision(f.run,f.task,f.project,history.slice(0,1),20+REWORK_WINDOW_MS).route,'waiting');
});
test('repair inherits prerequisite approvals, excludes itself and cannot depend on its own verifier',()=>{
 const f=fixture();f.run.tasks.unshift({id:'gate',kind:'producer-review',status:'done',dependencies:[]});f.task.dependencies=['gate','up','fix'];
 const repair:any={id:'fix',dependencies:['gate','up'],status:'queued'};f.run.tasks.push(repair);
 assert.deepEqual(repairDependencies(f.run.tasks,f.task,'fix'),['gate','up']);
 f.run.tasks[0].dependencies=['qa'];assert.throws(()=>repairDependencies(f.run.tasks,f.task,'fix'),/循环/);
});
test('a successful repair permits one original verification, not another repair loop on the same result',()=>{
 const f=fixture();const repair:any={id:'fix',status:'done',finishedAt:60,remediationFor:{taskId:'qa',blockerKey:'quality:RGB',sourceActionId:'turn'},dependencies:['up']};f.run.tasks.push(repair);f.task.dependencies.push('fix');
 const history=[...f.history,{phase:'collaborating',finishedAt:35,context:f.history[0].context,failureKey:'quality:RGB'}];
 assert.equal(reworkDecision(f.run,f.task,f.project,history,100).route,'retry');
 f.task.actionId='verification-turn';assert.equal(reworkDecision(f.run,f.task,f.project,history,110).route,'waiting');
});
