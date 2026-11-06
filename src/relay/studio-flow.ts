import {functionalTestTask} from './studio-playtest-task.js';
import type {Task} from './studio.js';
import type {SceneStage} from './studio-scene.js';

export const productionStages=['requirements','concept','asset-spec','assets','balance','implementation','functional-test','assembly','integration','validation'] as const;
export interface ProductionFlow {template:'full-scene'|'levels'|'design'|'code'|'custom';stages:typeof productionStages[number][];approvals:{plan:boolean;design:boolean;visual:boolean;scene:boolean;final:boolean}}
const roleMap:Record<string,string[]>={requirements:['gameplay','level','systems'],concept:['concept'],'asset-spec':['concept','model','techart'],assets:['model'],balance:['balance'],implementation:['engineering'],'functional-test':['engineering'],assembly:['environment'],integration:['engineering','techart','ui','audio'],validation:['qa']};
const labels:Record<string,string>={requirements:'玩法与 LD 设计',concept:'原画与视觉方案','asset-spec':'资产清单与规格',assets:'资产生产',balance:'数值设计',implementation:'程序实现','functional-test':'功能白模与操作验证',assembly:'关卡 / 场景搭建',integration:'整合与实测',validation:'QA 验证'};
export class ProductionPlanError extends Error {}
export function productionRoleIds(flow:ProductionFlow){return [...new Set(flow.stages.flatMap(s=>roleMap[s]))];}
export function normalizeProductionFlow(value:unknown):ProductionFlow|undefined{
  if(value===undefined)return undefined;
  const v=value as ProductionFlow;
  if(!v||typeof v!=='object'||!['full-scene','levels','design','code','custom'].includes(v.template)||!Array.isArray(v.stages)||!v.stages.length||v.stages.length>productionStages.length||new Set(v.stages).size!==v.stages.length||v.stages.some(s=>!productionStages.includes(s)))throw Error('请选择有效的制作环节，至少选择一项');
  if(!v.approvals||['plan','design','visual','scene','final'].some(k=>typeof (v.approvals as any)[k]!=='boolean'))throw Error('请明确选择制作人审批节点');
  if(v.approvals.design&&!v.stages.includes('requirements'))throw Error('关卡 / 玩法设计审批需要选择设计环节');
  if(v.approvals.visual&&!v.stages.includes('concept'))throw Error('原画审批需要选择原画环节');
  if(v.approvals.scene&&!v.stages.some(s=>['assembly','integration'].includes(s)))throw Error('实机场景审批需要选择搭建或整合环节');
  if(v.stages.length===1&&v.stages[0]==='validation'&&v.approvals.scene)throw Error('仅 QA 流程没有场景制作审批节点');
  return {template:v.template,stages:productionStages.filter(s=>v.stages.includes(s)),approvals:{plan:v.approvals.plan,design:v.approvals.design,visual:v.approvals.visual,scene:v.approvals.scene,final:v.approvals.final}};
}
export function requireProductionRoles(flow:ProductionFlow,roles:{role:string;enabled:boolean}[]){
  for(const stage of flow.stages)if(!roles.some(r=>r.enabled&&roleMap[stage].includes(r.role)))throw Error('所选环节需要启用职能：'+labels[stage]+'（'+roleMap[stage].join(' / ')+')');
}
export function compileProductionFlow(input:Task[],flow:ProductionFlow,roles:{role:string;enabled:boolean}[]):Task[]{
  requireProductionRoles(flow,roles);
  if(input.some(t=>t.kind||t.id.startsWith('studio-review-')||t.id==='studio-visual-review'))throw Error('审批节点由系统按制作人配置创建');
  const infer=(t:Task):SceneStage=>t.stage??(t.role==='concept'?'concept':t.role==='model'?'assets':t.role==='environment'?'assembly':['gameplay','level','systems'].includes(t.role)?'requirements':t.role==='balance'?'balance':t.role==='qa'?'validation':t.role==='engineering'?(flow.stages.includes('implementation')?'implementation':'integration'):'integration');
  const tasks:Task[]=input.map(t=>({...t,dependencies:[...t.dependencies],stage:infer(t)}));
  for(const t of tasks)if(t.stage==='functional-test'){t.brief+='\n'+functionalTestTask().brief;t.acceptance+='\n'+functionalTestTask().acceptance;}
  const problems:string[]=[];
  for(const t of tasks){if(!flow.stages.includes(t.stage as any))problems.push('计划包含未选择的环节：'+t.title+' / '+(labels[t.stage!]??t.stage));else if(!roleMap[t.stage!]?.includes(t.role))problems.push('职能与所选阶段不匹配：'+t.title+'（'+t.role+' / '+t.stage+'；本阶段允许 '+roleMap[t.stage!]?.join('、')+'）');}
  if(problems.length)throw new ProductionPlanError(problems.join('\n')+'。请按本需求所选流程修正；不能把未选工作改标为其他阶段以绕过范围。');
  for(const stage of flow.stages)if(!tasks.some(t=>t.stage===stage)){
    const preferred=stage==='requirements'&&flow.template==='levels'?['level','gameplay','systems']:roleMap[stage],role=preferred.find(id=>roles.some(r=>r.role===id&&r.enabled))!;
    tasks.push(stage==='functional-test'?functionalTestTask():{id:'studio-flow-'+stage,title:labels[stage],stage,role,brief:stage==='requirements'?'按制作人要求设计本批关卡的布局、数量、节奏、交互目标及验收标准；复用已有玩法，不自行扩大到新玩法或新资产。':stage==='assembly'?'在本需求副本中实际搭建所述关卡/场景，按选定范围复用已有资产和玩法，交付可进入的关卡和实际截图。':stage==='validation'?'独立验证本需求交付、实际运行入口及所有验收标准，失败如实 blocked。':'只完成所选的'+labels[stage]+'工作，复用已有工程，未选环节不另行生产。',acceptance:'交付实际文件与本阶段可核查的验证结果，按需求范围检查，不以旧默认场景冒充本批关卡。',dependencies:[],status:'queued'});
  }
  const ids=new Set(tasks.map(t=>t.id));if(ids.size!==tasks.length)throw Error('流程任务 ID 冲突，请调整计划');
  let previous:Task[]=[];const ordered:Task[]=[];
  const gate=(kind:'design'|'visual'|'scene',upstream:Task[])=>{
    const t:Task={id:kind==='visual'?'studio-visual-review':'studio-review-'+kind,title:kind==='design'?'制作人确认关卡 / 玩法设计':kind==='visual'?'制作人确认场景原画与视觉方向':'制作人确认实机场景 / 关卡',role:'director',kind:kind==='visual'?'visual-review':'producer-review',reviewType:kind==='visual'?undefined:kind,stage:kind==='visual'?'visual-review':kind==='design'?'design-review':'scene-review',brief:'仅在制作人配置的节点等待批准；不由 Agent 代批。',acceptance:'制作人查看本轮上游实际交付后确认，驳回时按意见返工。',dependencies:upstream.map(t=>t.id),status:'queued'};tasks.push(t);ordered.push(t);previous=[t];return t;
  };
  for(const stage of flow.stages){
    if(stage==='validation'&&flow.approvals.scene)gate('scene',ordered.filter(t=>t.stage!=='validation'&&!t.kind));
    const group=tasks.filter(t=>t.stage===stage&&!t.kind);
    for(const t of group){t.dependencies=[...new Set([...t.dependencies,...previous.map(p=>p.id)])];if(stage==='validation')t.dependencies=[...new Set([...t.dependencies,...ordered.map(t=>t.id)])];}
    // Keep the planner's same-stage order; a topological pass below validates it.
    ordered.push(...group);previous=group;
    if(stage==='requirements'&&flow.approvals.design)gate('design',group);
    if(stage==='concept'&&flow.approvals.visual)gate('visual',group);
  }
  if(flow.approvals.scene&&!flow.stages.includes('validation'))gate('scene',ordered.filter(t=>!t.kind));
  const result:Task[]=[],remaining=[...ordered],done=new Set<string>();
  while(remaining.length){const next=remaining.find(t=>t.dependencies.every(id=>done.has(id)));if(!next)throw Error('所选流程存在缺失依赖、反向依赖或循环，请重新拆解');result.push(next);done.add(next.id);remaining.splice(remaining.indexOf(next),1);}
  return result;
}
export function productionFlowInstructions(flow:ProductionFlow){return `制作人已明确选择本需求流程，优先于默认整套场景流程：${flow.stages.map(s=>s+'（'+labels[s]+'）').join(' → ')}。只安排这些阶段，禁止补入未选原画、资产生产、QA 或其他制作环节。角色与阶段必须匹配：${flow.stages.map(s=>s+' 只能使用 '+roleMap[s].join('/')).join('；')}。未选 assembly 时不安排房间组装、关卡搭建或引擎场景实拍；未选 integration 时不安排整关 GI 烘焙或集成校验。assets 仅做模型/材质资产及资产自身的导入检查，不能把场景美术或技术美术的其他阶段工作标为 assets。原画可用白模渲染作视觉方案，但不借此增加正式场景生产。${flow.stages.includes('functional-test')?'功能验证使用独立可操作白模，复用现有角色和控制逻辑，交付 functional 与 game 两类实际启动脚本和 launchers；不借此追加美术/GI 生产。':''}${flow.template==='levels'?'本需求只制作所述几个关卡，沿用项目现有玩法与适用资产，不另做一套玩法或默认生成新原画。':''}审批配置：${JSON.stringify(flow.approvals)}。只有值为 true 的节点等待制作人；关闭审批不代表验证已经通过，也不改变工具执行权限。系统自动插入所选审批节点，不要输出人工审批任务。每个制作任务明确 stage；需要未选环节时报告范围缺口，不擅自新增。`;
}
