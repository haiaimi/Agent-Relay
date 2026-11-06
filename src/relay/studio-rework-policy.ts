import {createHash} from 'node:crypto';
import type {StudioRun,Task,StudioProject} from './studio.js';

export interface ReworkRecord {phase:string;finishedAt:number;context?:string;failureKey?:string;route?:string}
export const REWORK_LIMIT=5,REWORK_WINDOW_MS=30*60_000;
function result(output?:string){
  try{const blocks=[...(output??'').matchAll(/```STUDIO_RESULT\s*([\s\S]*?)```/g)];return JSON.parse(blocks.at(-1)?.[1]??'{}');}catch{return {};}
}
export function effectiveBlockers(t:Task){
  const raw=result(t.output).blockers;
  return (t.blockers??[]).map(b=>({...b,...(Array.isArray(raw)?raw.find((x:any)=>x?.code===b.code&&x?.category===b.category):{}),...b}));
}
function humanScope(r:StudioRun){return [r.brief,r.feedback&&r.feedback!==r.planner.feedback?r.feedback:'',...(r.guidance??[]).filter(g=>!g.automatic).map(g=>g.text),...(r.directions??[]).filter(g=>['saved','delivered','queued'].includes(g.status)).map(g=>g.text)].filter(Boolean).join('\n');}
export function producerRequiresDesktop(r:StudioRun){
  const scope=humanScope(r);
  const statements=scope.split(/[\n。；;]/).filter(s=>/Computer\s*Use|Finder|访达|人工(?:键盘|试玩)|真人试玩|桌面控制/i.test(s));
  // A later explicit withdrawal takes precedence over an earlier requirement.
  let required=false;
  for(const s of statements){if(/不依赖|不要依赖|无需|不得.{0,15}(?:门槛|门禁|前置)|撤销|不作为门禁|不要求/i.test(s))required=false;else if(!/只有|如果|若|确实明确|制作人明确要求的/.test(s)&&/必须|要求|仅允许|务必|must|require/i.test(s))required=true;}
  return required;
}
export function addedToolGate(r:StudioRun,t:Pick<Task,'brief'|'acceptance'|'blockers'>){
  if(producerRequiresDesktop(r))return false;
  const code=t.blockers?.some(b=>/NATIVE_KEYBOARD|COMPUTER_USE|FINDER_BIND|APP_BIND|DESKTOP_CONTROL/i.test(b.code));
  const clauses=(t.brief+'\n'+t.acceptance+'\n'+(t.blockers??[]).map(b=>b.details+' '+b.remedy).join('\n')).split(/[\n。；;]/);
  return !!code||clauses.some(s=>/Computer\s*Use|Finder|访达|人工键盘|真实键盘|App\s*句柄/i.test(s)&&!/无需|不得|不依赖|不作为|不要|不能.{0,10}(?:门禁|门槛)/.test(s)&&/必须|前置|门禁|门槛|真实键盘验证|must|require/i.test(s));
}
export function failureKey(t:Task){
  return t.blockers?.length?t.blockers.map(b=>b.category+':'+b.code).sort().join('|'):(t.error??t.checkpoint?.reason??'missing-result').replace(/第\s*\d+\s*轮|\b\d+\b/g,'#').trim();
}
export function reworkContext(r:StudioRun,t:Task,p:StudioProject){
  const human=(r.guidance??[]).filter(g=>!g.automatic),directions=(r.directions??[]).filter(g=>['saved','delivered','queued'].includes(g.status));
  const upstream=r.tasks.filter(x=>t.dependencies.includes(x.id)&&!x.remediationFor);
  const boundary=Math.max(0,p.updatedAt??0,t.reworkEpoch??0,...human.map(g=>g.at??0),...directions.map(g=>g.at??0),...upstream.map(x=>x.finishedAt??0));
  const value=[humanScope(r),p.updatedAt,t.reworkEpoch,directions.map(g=>[g.id,g.status]),p.toolchain,upstream.map(x=>[x.id,x.status,x.actionId,x.finishedAt]),r.workspace?.value?.project.id];
  return {key:createHash('sha256').update(JSON.stringify(value)).digest('hex'),boundary};
}
export function canRepairInStage(r:StudioRun,t:Task,p:StudioProject){
  return !t.kind&&!t.remediationFor&&t.role!=='engineering'&&(!!t.stage||!r.workflow?.selection)&&(!r.workflow?.selection||r.workflow.selection.stages.includes(t.stage as any))&&p.roles?.some(a=>a.role==='engineering'&&a.enabled)&&effectiveBlockers(t).some(b=>['quality','upstream','provenance'].includes(b.category));
}
export function reworkDecision(r:StudioRun,t:Task,p:StudioProject,records:ReworkRecord[],now:number){
  const context=reworkContext(r,t,p),key=failureKey(t);
  const history=records.filter(d=>['queued','collaborating'].includes(d.phase)&&(d.context?d.context===context.key:d.finishedAt>=context.boundary));
  const same=history.filter(d=>!d.failureKey||d.failureKey===key);
  const toolGate=addedToolGate(r,t.blockers?.length?{...t,brief:'',acceptance:''}:t);
  let legacySame=0;
  for(const attempt of [...t.attempts??[]].reverse()){
    if(attempt.at<context.boundary)break;
    const previous=result(attempt.output);
    if(previous.outcome!=='blocked'||!Array.isArray(previous.blockers)||previous.blockers.map((b:any)=>b.category+':'+b.code).sort().join('|')!==key)break;
    legacySame++;
  }
  const sameCount=Math.max(same.length,legacySame);
  const scoped=history.some(d=>d.route==='correct-scope');
  if(toolGate&&!scoped)return {route:'correct-scope',context:context.key,key,note:'撤销旧任务自行增加的桌面控制门禁，改走受支持的脚本路线；业务验收与真实失败保留'};
  if(toolGate&&scoped)return {route:'waiting',context:context.key,key,note:'工具门禁已纠正一次，但仍未产生可执行结果；等待具体环境恢复或新的阶段指引，不重复派发'};
  if(effectiveBlockers(t).some(b=>b.requiresExternalStateChange===true||b.retryableWithoutExternalChange===false)){
    const pendingChange=records.some(d=>['scheduled','checking'].includes(d.phase)&&d.context===context.key&&d.route==='retry-after-change');
    const changed=records.some(d=>d.phase==='waiting'&&d.context&&d.context!==context.key)&&!history.length;
    if(pendingChange||changed)return {route:'retry-after-change',context:context.key,key,note:'恢复条件已更新，安排一次原会话核对；仍失败则继续等待'};
    return {route:'waiting',context:context.key,key,note:'此阻断明确需要外部条件变化；等待恢复证据或新的阶段指引，不原地重试'};
  }
  const repaired=r.tasks.find(x=>x.remediationFor?.taskId===t.id&&x.remediationFor.blockerKey===t.blockers?.map(b=>b.category+':'+b.code).sort().join('|')&&x.remediationFor.sourceActionId===t.actionId&&x.status==='done');
  if(repaired)return {route:'retry',context:context.key,key,note:'程序协作已交付，原职能只复验本次修复'};
  const elapsed=history.length?now-Math.min(...history.map(d=>d.finishedAt)):0;
  if(sameCount>=2&&canRepairInStage(r,t,p)&&!history.some(d=>d.phase==='collaborating'&&(!d.failureKey||d.failureKey===key)))return {route:'collaborate',context:context.key,key,note:'同类阻断转阶段内程序修复；原验收等待修复，不依赖后续验收任务先完成'};
  if(sameCount>=2||history.length>=REWORK_LIMIT||elapsed>=REWORK_WINDOW_MS)return {route:'waiting',context:context.key,key,note:'连续补做未解除阻断，自动尝试预算已用尽；等待上游实际修复、工具配置变化或新的阶段指引，不重复生成相同报告'};
  return {route:'retry',context:context.key,key,note:'在原会话补齐未完成项，保留已有成果与真实失败'};
}

export function repairDependencies(tasks:Task[],parent:Task,repairId:string){
  const depends=(id:string,target:string,seen=new Set<string>()):boolean=>{if(id===target)return true;if(seen.has(id))return false;seen.add(id);return tasks.find(t=>t.id===id)?.dependencies.some(d=>depends(d,target,seen))??false;};
  const deps=parent.dependencies.filter(id=>id!==repairId);
  if(deps.some(id=>!tasks.some(t=>t.id===id)||depends(id,parent.id)||depends(id,repairId)))throw Error('修复前置依赖存在循环或缺失，保留审批并停止分发，请核对任务依赖');
  return deps;
}
