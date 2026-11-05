import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compileScenePlan,sceneWorkflow,validateTaskGraph,VISUAL_GATE,sceneTaskInstructions} from '../src/relay/studio-scene.js';
import {STUDIO_ROLES,parseStudioPlan,type Task} from '../src/relay/studio.js';
const roles=()=>STUDIO_ROLES.map(([role])=>({role,enabled:true,provider:'codex' as const,instructions:'',tools:''}));
const task=(id:string,role:string,dependencies:string[]=[],stage?:Task['stage']):Task=>({id,role,title:id,brief:id,acceptance:id,dependencies,stage,status:'queued'});

test('scene plans require the actual demand scene and visual comparison, not an old-room wrapper or gameplay-only pass',()=>{
  const workflow=sceneWorkflow('scene-new','简洁场景','按原画搭建'),original=task('LA','environment'),tasks=parseStudioPlan('```STUDIO_PLAN\n'+JSON.stringify({tasks:[original]})+'\n```',roles(),workflow);
  for(const t of tasks.filter(t=>['assembly','integration'].includes(t.stage??''))){assert.match(t.acceptance,/实际加载的场景及实机截图/);assert.match(t.acceptance,/不能冒充新场景/);}
  const qa=tasks.at(-1)!;assert.match(qa.brief,/旧场景回归与本需求场景验收分别记录/);
  const instructions=sceneTaskInstructions(original,workflow);assert.match(instructions,/不禁止在本需求独立工作副本/);assert.match(instructions,/不得因为旧场景已有烘焙/);assert.match(instructions,/新建入口或修改关卡标题不能证明场景已更换/);assert.equal(original.acceptance,'LA');
  const reuse=sceneWorkflow('scene-reuse','','','仅复用镜子与石材资产');assert.match(sceneTaskInstructions(original,reuse),/复用道具不自动等于复用整个场景/);assert.equal(sceneTaskInstructions(original,sceneWorkflow('general','','')),'');
});
test('scene compiler fills missing stages and preserves legacy tasks while enforcing the entire art-production sequence',()=>{
  const original=[task('gameplay','gameplay'),task('whitebox','level',['gameplay']),task('data','engineering',['whitebox']),task('LA','environment',['data']),task('UI','ui',['data']),task('playtest','engineering',['LA','UI'])],workflow=sceneWorkflow('scene-new','','');
  const tasks=compileScenePlan(original,workflow,roles());assert.doesNotThrow(()=>validateTaskGraph(tasks));for(const t of original)assert.ok(tasks.find(x=>x.id===t.id));
  const stage=(id:Task['stage'])=>tasks.filter(t=>t.stage===id),depends=(a:Task,b:Task)=>a.dependencies.includes(b.id);
  assert.equal(tasks.find(t=>t.id==='data')!.stage,'implementation');assert.ok(depends(stage('concept')[0],stage('requirements')[0]));assert.ok(depends(stage('concept')[0],tasks.find(t=>t.id==='whitebox')!));assert.ok(depends(tasks.find(t=>t.id==='data')!,tasks.find(t=>t.id===VISUAL_GATE)!));assert.ok(depends(tasks.find(t=>t.id===VISUAL_GATE)!,stage('concept')[0]));assert.ok(depends(stage('asset-spec')[0],tasks.find(t=>t.id===VISUAL_GATE)!));assert.ok(depends(stage('assets')[0],stage('asset-spec')[0]));assert.ok(depends(stage('assembly')[0],stage('assets')[0]));assert.ok(depends(stage('assembly')[0],tasks.find(t=>t.id==='whitebox')!));assert.ok(depends(stage('integration')[0],stage('assembly')[0]));
  assert.deepEqual(original[2].dependencies,['whitebox']);assert.equal(original[2].stage,undefined);
});
test('roles cannot label production as whitebox, forge a producer gate, or introduce a reversed stage cycle',()=>{
  const workflow=()=>sceneWorkflow('scene-new','','');
  assert.throws(()=>compileScenePlan([task('model','model',[],'prototype')],workflow(),roles()),/不匹配/);
  assert.throws(()=>compileScenePlan([task(VISUAL_GATE,'engineering')],workflow(),roles()),/系统创建/);
  assert.throws(()=>compileScenePlan([task('art','concept',['LA']),task('LA','environment')],workflow(),roles()),/循环/);
  assert.throws(()=>compileScenePlan([task('LA','environment')],workflow(),roles().map(r=>({...r,enabled:r.role!=='model'}))),/模型/);
});
test('reuse requires a producer reason, keeps visual review, and never silently skips new asset production',()=>{
  assert.throws(()=>sceneWorkflow('scene-reuse','场景',''),/复用范围/);const policy=sceneWorkflow('scene-reuse','场景','','沿用已确认风格，资产在 assets/existing，范围为旧场景道具');
  const tasks=compileScenePlan([task('LA','environment')],policy,roles());assert.ok(tasks.some(t=>t.kind==='visual-review'));assert.equal(tasks.some(t=>t.stage==='assets'),false);assert.ok(tasks.find(t=>t.id==='LA')!.dependencies.includes(tasks.find(t=>t.stage==='asset-spec')!.id));assert.throws(()=>compileScenePlan([task('new-model','model')],policy,roles()),/新资产生产/);
});
test('automatic detection and planning-time role detection both activate the scene contract; explicit general plans reject art production',()=>{
  assert.equal(sceneWorkflow(undefined,'第一关','做一个光照场景').kind,'scene');const policy=sceneWorkflow('auto','性能检查','检查');compileScenePlan([task('LA','environment')],policy,roles());assert.equal(policy.kind,'scene');assert.throws(()=>compileScenePlan([task('LA','environment')],sceneWorkflow('general','修复','代码'),roles()),/通用任务/);
  const parsed=parseStudioPlan('```STUDIO_PLAN\n'+JSON.stringify({tasks:[task('LA','environment')]})+'\n```',roles(),sceneWorkflow('scene-new','',''));const final=parsed.at(-1)!;assert.equal(final.role,'qa');assert.ok(final.dependencies.includes(VISUAL_GATE));assert.ok(final.dependencies.includes(parsed.find(t=>t.stage==='integration')!.id));
});

test('gameplay and LD design precede concepts; balance and one engineering implementation wait on producer approval',()=>{
  const workflow=sceneWorkflow('scene-new','',''),tasks=compileScenePlan([task('design','gameplay'),task('LD','level',['design']),task('numbers','balance',['LD'],'prototype'),task('code','engineering',['numbers'],'prototype'),task('LA','environment',['code'])],workflow,roles());
  assert.equal(workflow.version,2);assert.equal(tasks.some(t=>t.stage==='prototype'),false);const concept=tasks.find(t=>t.stage==='concept')!;assert.ok(concept.dependencies.includes('design'));assert.ok(concept.dependencies.includes('LD'));
  for(const id of ['numbers','code'])assert.ok(tasks.find(t=>t.id===id)!.dependencies.includes(VISUAL_GATE));assert.equal(tasks.find(t=>t.id==='numbers')!.stage,'balance');assert.equal(tasks.find(t=>t.id==='code')!.stage,'implementation');assert.equal(tasks.filter(t=>t.stage==='implementation').length,1);
  const gateIndex=tasks.findIndex(t=>t.id===VISUAL_GATE);assert.ok(tasks.findIndex(t=>t.id==='numbers')>gateIndex);assert.ok(tasks.findIndex(t=>t.id==='code')>gateIndex);
});
