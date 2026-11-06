import {compileProductionFlow,requireProductionRoles,productionFlowInstructions,type ProductionFlow} from './studio-flow.js';
import type {Task} from './studio.js';

export type SceneStage='requirements'|'prototype'|'balance'|'implementation'|'functional-test'|'concept'|'asset-spec'|'assets'|'assembly'|'integration'|'validation'|'visual-review'|'design-review'|'scene-review';
export interface SceneWorkflow {selection?:ProductionFlow;version:1|2;kind:'general'|'scene';assetMode:'new'|'reuse';explicitGeneral?:boolean;reuseReason?:string;error?:string;upgradeRestorePaused?:boolean}
export const VISUAL_GATE='studio-visual-review';
export const sceneStages=new Set<string>(['requirements','prototype','balance','implementation','functional-test','concept','asset-spec','assets','assembly','integration','validation']);
export const visualPath=(path:string)=>/\.(png|jpe?g|webp|gif)$/i.test(path);
const sceneHint=/(场景|关卡|原画|场景美术|地图制作|scene|level design|environment art)/i;
const sceneRole=(role:string)=>['concept','model','environment'].includes(role);
const SCENE_ACCEPTANCE='场景交付须列出本需求实际运行入口、场景资源/生成脚本、实际加载的场景及实机截图，并逐项对照已确认原画说明布局、材质、构图与光照的实现和差异。复用资产不等于直接沿用旧关卡；只改标题、HUD、高光或后期不能冒充新场景搭建完成。';
export function sceneAcceptance(task:Task,workflow?:SceneWorkflow){return workflow?.kind==='scene'&&['assembly','integration','validation'].includes(task.stage??'')?SCENE_ACCEPTANCE:'';}

export function sceneWorkflow(choice:unknown,title:string,brief:string,reuseReason?:unknown):SceneWorkflow{
  if(choice!==undefined&&!['auto','general','scene-new','scene-reuse'].includes(String(choice)))throw Error('请选择有效制作流程');
  const reuse=choice==='scene-reuse';
  if(reuse&&(typeof reuseReason!=='string'||!reuseReason.trim()||reuseReason.length>2000))throw Error('请说明沿用的视觉方案、已有资产位置和复用范围');
  return {version:2,kind:choice==='general'?'general':choice==='scene-new'||reuse||sceneHint.test(title+'\n'+brief)?'scene':'general',assetMode:reuse?'reuse':'new',explicitGeneral:choice==='general',reuseReason:reuse?String(reuseReason).trim():undefined};
}
export function requireSceneRoles(workflow:SceneWorkflow,roles:{role:string;enabled:boolean}[]){
  if(workflow.selection)return requireProductionRoles(workflow.selection,roles);
  if(workflow.kind!=='scene')return;const enabled=new Set(roles.filter(r=>r.enabled).map(r=>r.role));
  const required=['concept','environment','engineering',...workflow.assetMode==='new'?['model']:[]],missing=required.filter(id=>!enabled.has(id));
  if(!['gameplay','level','systems'].some(id=>enabled.has(id)))missing.push('gameplay / level / systems');
  if(missing.length)throw Error('场景流程需要启用这些职能：'+missing.map(id=>({concept:'原画 / 视觉设计',environment:'场景美术 / LA',engineering:'程序 / 集成',model:'模型 / 材质','gameplay / level / systems':'玩法、关卡或系统策划至少一项'}[id]||id)).join('、'));
}
export function validateTaskGraph(tasks:Task[]){
  const byId=new Map(tasks.map(t=>[t.id,t])),visited=new Set<string>(),visiting=new Set<string>();
  if(byId.size!==tasks.length)throw Error('计划存在重复任务 ID');
  function visit(id:string){if(visited.has(id))return;if(visiting.has(id))throw Error('场景阶段依赖存在循环，请调整制作计划：'+id);const t=byId.get(id);if(!t)throw Error('计划引用了不存在的依赖：'+id);visiting.add(id);t.dependencies.forEach(visit);visiting.delete(id);visited.add(id);}
  tasks.forEach(t=>visit(t.id));
}
function ancestors(tasks:Task[],ids:string[]){const found=new Set<string>();function add(id:string){if(found.has(id))return;found.add(id);tasks.find(t=>t.id===id)?.dependencies.forEach(add);}ids.forEach(add);return found;}

/** Compile a scene production contract, including a human gate, rather than trusting role order in a prompt. */
export function compileScenePlan(input:Task[],workflow:SceneWorkflow,roles:{role:string;enabled:boolean}[]):Task[]{
  if(workflow.selection)return compileProductionFlow(input,workflow.selection,roles);
  if(workflow.kind==='general'&&input.some(t=>sceneRole(t.role)||t.stage&&['concept','asset-spec','assets','assembly'].includes(t.stage))){
    if(workflow.explicitGeneral)throw Error('通用任务计划包含场景或资产生产，请改用场景制作流程');workflow.kind='scene';
  }
  if(workflow.kind!=='scene')return input;
  requireSceneRoles(workflow,roles);validateTaskGraph(input);
  if(input.some(t=>t.id===VISUAL_GATE||t.kind==='visual-review'))throw Error('视觉确认节点由系统创建，不能由 Agent 代替制作人确认');
  const tasks=input.map(t=>({...t,dependencies:[...t.dependencies]})),beforeAssembly=ancestors(tasks,tasks.filter(t=>t.role==='environment').map(t=>t.id));
  for(const t of tasks){
    if(t.stage==='prototype'&&['gameplay','level','systems','balance','engineering','qa'].includes(t.role))t.stage=t.role==='engineering'?'implementation':t.role==='balance'?'balance':t.role==='qa'?'validation':'requirements';
    t.stage??=t.role==='concept'?'concept':t.role==='model'?'assets':t.role==='environment'?'assembly':t.role==='gameplay'?'requirements':['level','systems'].includes(t.role)?'requirements':t.role==='balance'?'balance':t.role==='qa'?'validation':t.role==='engineering'&&beforeAssembly.has(t.id)?'implementation':'integration';
    const allowed:Record<string,string[]>={requirements:['gameplay','level','systems'],prototype:['level'],balance:['balance'],implementation:['engineering'],'functional-test':['engineering'],concept:['concept'],'asset-spec':['concept','model','techart'],assets:['model'],assembly:['environment'],integration:['engineering','techart','ui','audio'],validation:['qa']};
    if(!allowed[t.stage]?.includes(t.role))throw Error('职能与场景阶段不匹配：'+t.title+' / '+t.stage);
  }
  if(workflow.assetMode==='reuse'&&tasks.some(t=>t.stage==='assets'))throw Error('复用流程不能包含新资产生产；需要新资产时请选择新场景 / 新资产流程');
  const enabled=new Set(roles.filter(r=>r.enabled).map(r=>r.role));
  function add(stage:SceneStage,role:string,title:string,brief:string,acceptance:string){
    let id='studio-scene-'+stage;for(let n=2;tasks.some(t=>t.id===id);n++)id='studio-scene-'+stage+'-'+n;
    const task:Task={id,role,title,brief,acceptance,stage,dependencies:[],status:'queued'};tasks.push(task);return task;
  }
  const stage=(id:SceneStage)=>tasks.filter(t=>t.stage===id);
  if(enabled.has('gameplay')&&!tasks.some(t=>t.role==='gameplay'&&t.stage==='requirements'))add('requirements','gameplay','玩法与体验设计','只读梳理核心循环、交互规则、失败条件、教学目标与验收标准，交付设计文档；玩法代码由程序在原画确认后一次实现。','设计规则明确并落盘，不额外开发一套玩法原型。');
  if(enabled.has('level')&&!tasks.some(t=>t.role==='level'&&t.stage==='requirements'))add('requirements','level','LD 空间、节奏与引导设计','依据玩法文档和现有工程只读设计关卡空间、路线、谜题、节奏、引导与交互锚点，形成给原画和程序的布局说明；不单独实现玩法代码。','关卡设计和布局说明落盘，可供制作人对照原画检查。');
  if(!stage('requirements').length)add('requirements',['gameplay','level','systems'].find(id=>enabled.has(id))!,'场景体验与关卡需求','明确场景用途、玩法目标、空间约束、镜头、关键交互与验收范围，形成供原画与 LD 使用的需求文件。','需求文件落盘，空间与玩法目标可检查。');
  if(!stage('concept').length)add('concept','concept',workflow.assetMode==='reuse'?'核对已有视觉方案与资产':'场景原画与视觉方案',workflow.assetMode==='reuse'?'只读核对制作人指定的既有视觉与资产，提交真实图片预览、资源位置、可复用范围和缺口；不得自行认定新资产已经获批。':'先检查可用绘图 / 生成工具，制作场景原画：构图、风格、关键物件、材质方向与光照。提供实际 PNG / JPEG / WebP / GIF 工程内文件供制作人查看；附件可作参考，不得冒充新产出。缺少工具或无法产出时返回 blocked，不能以文字说明替代原画。','实际视觉图片与说明已保存到工作副本，等待制作人确认；没有可查看图片不能完成。');
  tasks.push({id:VISUAL_GATE,title:'制作人确认场景原画与视觉方向',role:'director',kind:'visual-review',stage:'visual-review',brief:'查看本轮原画 / 既有视觉预览，制作人明确确认后开放资产规格与生产。',acceptance:'仅由制作人在界面确认；原画返工后原确认失效。',dependencies:[],status:'queued'});
  if(!stage('asset-spec').length)add('asset-spec','concept','资产清单与制作规格','依据已确认视觉，列出资产清单、尺寸、数量、模型 / UV / 材质 / 纹理要求、预算、命名和导入规范；复用模式须逐项列出已有文件及验证结果。此阶段不生产正式资产。','清单与规格文件落盘，与已确认视觉对应；新制、复用和缺口标注明确。');
  if(workflow.assetMode==='new'&&!stage('assets').length)add('assets','model','模型、UV 与材质资产生产','依据已确认原画和资产规格逐项区分新制、复用及修复。新制或改动几何/UV/材质时检查所需 DCC/导出/导入能力；新制为0时交付复用与验收报告，不为了满足阶段名称重做资产。仅将本次实际操作必需的工具缺失列为阻断；冷加载与真实质量缺口仍须核对和补验；UV2/receiver 只在实际启用对应接收路径时验收，无 receiver 的 Voxel 不设此门禁。','资产文件存在，规格与视觉对应，提供导入 / 使用检查。');
  if(!stage('assembly').length)add('assembly','environment','LA 正式场景搭建','使用已验收资产与 LD 布局搭建正式场景，完成构图、空间可读性和资源摆放。','实际场景可加载，布局和视觉与制作人确认结果一致。');
  if(!stage('integration').length)add('integration','engineering','布光、效果与程序集成','在正式场景中整合光照、效果、玩法、界面及音频接入，检查运行入口和实际环境。','场景可运行，交互、光照效果与验收目标对应，附实际验证记录。');
  const ids=(id:SceneStage)=>stage(id).map(t=>t.id),need=(t:Task,dependencies:string[])=>{t.dependencies=[...new Set([...t.dependencies,...dependencies.filter(id=>id!==t.id)])];};
  for(const t of tasks){
    if(t.role==='level'&&t.stage==='requirements')need(t,tasks.filter(x=>x.role==='gameplay'&&x.stage==='requirements').map(x=>x.id));
    if(t.stage==='concept')need(t,ids('requirements'));
    if(t.stage==='balance')need(t,[...ids('requirements'),VISUAL_GATE]);
    if(t.stage==='implementation')need(t,[...ids('requirements'),...ids('balance'),VISUAL_GATE]);
    if(t.kind==='visual-review')need(t,ids('concept'));
    if(t.stage==='asset-spec')need(t,[VISUAL_GATE]);
    if(t.stage==='assets')need(t,ids('asset-spec'));
    if(t.stage==='assembly')need(t,[...ids(workflow.assetMode==='new'?'assets':'asset-spec'),...ids('implementation'),...ids('requirements'),VISUAL_GATE]);
    if(t.stage==='integration')need(t,[...ids('assembly'),...ids('implementation'),...ids('balance'),VISUAL_GATE]);
    if(t.stage==='validation')need(t,ids('integration'));
  }
  validateTaskGraph(tasks);
  for(const t of tasks){const requirement=sceneAcceptance(t,workflow);if(requirement&&!t.acceptance.includes(requirement))t.acceptance+='\n'+requirement;}
  const order:Record<string,number>={requirements:0,concept:1,prototype:0,'visual-review':2,balance:3,'asset-spec':3,assets:4,implementation:4,assembly:5,integration:6,validation:7},remaining=[...tasks],sorted:Task[]=[],done=new Set<string>();
  while(remaining.length){const ready=remaining.filter(t=>t.dependencies.every(id=>done.has(id))).sort((a,b)=>(order[a.stage!]??8)-(order[b.stage!]??8));if(!ready.length)throw Error('场景任务无法按依赖排序');const next=ready[0];sorted.push(next);done.add(next.id);remaining.splice(remaining.indexOf(next),1);}workflow.version=2;return sorted;
}
export function visualReferences(tasks:Task[],gate:Task){
  const references=tasks.filter(t=>gate.dependencies.includes(t.id)).flatMap(t=>(t.artifacts??[]).flatMap((a,index)=>visualPath(a.path)?[{taskId:t.id,index,path:a.path,description:a.description,sessionId:t.artifactSessionId??t.sessionId}]:[]));
  if(!references.length)throw Error('原画没有可查看的图片交付物，请先补齐实际图片');
  if(references.length>12)throw Error('本轮视觉确认最多 12 张图片，请统筹整理必要原画');return references;
}
export function sceneTaskInstructions(task:Task,workflow?:SceneWorkflow){
  if(task.stage==='functional-test')return '\n当前是独立功能白模验证：复用真实角色、控制、相机和交互，不重做一套玩法。白模仅用于实际操控与功能测试，不制作正式场景，不追加原画或 GI 观感验收；正式游戏入口另行准确登记，不拿白模冒充正式关卡。\n';
  if(workflow?.selection)return '\n'+productionFlowInstructions(workflow.selection)+'\n当前阶段：'+(task.stage??'统筹规划')+'。只在本需求独立副本执行，保留已有实现和无关修改；测试实际加载内容与当前需求对应，不能以旧场景代替新关卡。\n';
  if(workflow?.kind!=='scene')return '';
  const restrictions:Partial<Record<SceneStage,string>>={requirements:'玩法策划与 LD 只读设计并形成文档、布局和验收规则，不另做一套玩法实现；功能代码交给程序在视觉确认后实现。',prototype:'仅补充 LD 设计文档与布局示意，不实现另一套玩法代码。',balance:'制作人已确认视觉；依据玩法与 LD 设计形成可复算的数值配置。',implementation:'制作人已确认视觉；程序在当前工程一次完成玩法实现，复用已有系统和已产生的代码，禁止另建第二套玩法原型或重复实现。',concept:'只制作 / 核对原画与视觉文件，不生产正式模型或搭建正式场景。图片必须实际存在于工作副本并列入 artifacts，最多 12 张。','asset-spec':'视觉已由制作人确认；只编写资产规格，不提前生产正式资产。',assets:'依据制作人确认的原画和资产清单生产，不擅自修改已确认视觉方向。',assembly:'使用已确认原画和已完成资产搭建正式场景。',integration:'在正式场景基础上复用已完成的玩法实现，只做接入、布光、效果和实际验证，不重新开发第二套玩法。'};
  return `\n场景生产阶段：${task.stage??'统筹'}。${task.stage?restrictions[task.stage]??'按阶段依赖完成实际验证。':''}\n源工程保护仅约束源目录与他人已有修改，不禁止在本需求独立工作副本实现所需场景。不得因为旧场景已有烘焙、担心重烘成本或文件未提交，就擅自追加“静态几何零改动”“整关沿用旧场景”等范围收缩。需要改变几何、UV、材质或灯光时，在本副本走资产更新、实际路径必要的预处理/烘焙和验收；真实工具/质量问题报告 blocked，不以旧场景顶替交付。\n${workflow.assetMode==='reuse'?'制作人指定复用范围：'+workflow.reuseReason+'；不得把缺失资产当作已存在，复用道具不自动等于复用整个场景。':'本轮为新场景制作；允许复用合适的已有资产和玩法代码，但必须落地已确认的场景设计。'}\n${sceneAcceptance(task,workflow)}\n测试先验证本需求入口和实际加载内容，旧默认场景仅作为另外记录的回归对照；新建入口或修改关卡标题不能证明场景已更换。视觉实现有缺口时阻断并交给场景负责人处理，不得仅以玩法通关宣布场景验收通过。\n视觉方向需要改动时报告 blocked，等待制作人要求原画返工；不得代替制作人批准视觉方向。\n`;
}

// Preserve IDs, task outcomes, files and the producer's image approval when
// upgrading the old graph. Only the dependency contract changes.
export function upgradeScenePlan(input:Task[],workflow:SceneWorkflow,roles:{role:string;enabled:boolean}[]){
  const gate=input.find(t=>t.kind==='visual-review'),qa=input.find(t=>t.id.startsWith('studio-final-qa'));
  const compiled=compileScenePlan(input.filter(t=>t!==gate&&t!==qa).map(t=>({...t,dependencies:t.dependencies.filter(id=>id!==VISUAL_GATE)})),workflow,roles);
  if(gate){const index=compiled.findIndex(t=>t.kind==='visual-review');compiled[index]={...gate,dependencies:compiled[index].dependencies,stage:'visual-review'};}
  if(qa)compiled.push({...qa,stage:'validation',dependencies:compiled.map(t=>t.id)});
  validateTaskGraph(compiled);return compiled;
}
