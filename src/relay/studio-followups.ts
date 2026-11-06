import {createHash,randomUUID} from 'node:crypto';
import {pendingProducerInput,modelConnectionFailure} from './studio-recovery.js';
import type {Studio,StudioRun,Task,StudioProject} from './studio.js';
import type {RelayStore} from './store.js';
import type {Action} from '../shared/protocol.js';

export interface TaskFollowup {phase:'scheduled'|'checking'|'queued'|'unavailable'|'collaborating';round:number;nextAt?:number;note:string}
interface Followup extends TaskFollowup {id:string;runId:string;taskId:string;sessionId:string;actionId:string;finishedAt:number;probes:number;loop?:{key:string;count:number};collaborationTaskId?:string}
export function blockerSignature(t:Pick<Task,'blockers'>){return t.blockers?.length?t.blockers.map(b=>b.category+':'+b.code).sort().join('|'):'';}
export function repeatedFailure(t:Task){
  const key=blockerSignature(t);if(!key)return;
  let count=1;
  for(const attempt of [...t.attempts??[]].reverse()){
    const matches=[...(attempt.output??'').matchAll(/```STUDIO_RESULT\s*([\s\S]*?)```/g)];
    try{const v=JSON.parse(matches.at(-1)?.[1]??'');if(v.outcome!=='blocked'||blockerSignature(v)!==key)break;count++;}catch{break;}
  }
  return count>=3?{key,count}:undefined;
}
export interface DeferredCheck {code:string;details:string;basis:string}
export function productionFeedback(run:Pick<StudioRun,'feedback'|'planner'>){
  return run.feedback&&run.feedback!==run.planner?.feedback?run.feedback:undefined;
}
export function deferredChecks(value:unknown,run:StudioRun):DeferredCheck[]{
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>12)throw Error('延期检查记录格式无效');
  const authority=[run.brief,productionFeedback(run),...(run.guidance??[]).filter(g=>!g.automatic&&!g.text.includes('<send_user_message_question_reply>')).map(g=>g.text),...(run.directions??[]).map(g=>g.text)].filter((s):s is string=>typeof s==='string');
  const rows=value.map(d=>{
    if(!d||typeof d.code!=='string'||!/^[A-Z0-9_-]{1,60}$/.test(d.code)||typeof d.details!=='string'||!d.details.trim()||d.details.length>2000||typeof d.basis!=='string'||d.basis.trim().length<4||d.basis.length>1000||!/延期|暂缓|先放|暂不|不(?:纳入|做|验收)|不(?:需要|要求).{0,20}(?:检查|验收|GI|光照|专项|验证|测试)|跳过|不在.{0,20}范围|后续再|下一轮|下次|defer|not.required|out.of.scope/i.test(d.basis)||!authority.some(s=>s.includes(d.basis)))throw Error('延期检查须引用本需求中实际存在的制作人范围说明，不能自行豁免必需验收');
    return {code:d.code,details:d.details.trim(),basis:d.basis};
  });
  if(new Set(rows.map(d=>d.code)).size!==rows.length)throw Error('延期检查代码不能重复');return rows;
}
export const followupInstructions=`
自动补做与验收范围：技术检查失败、交付格式缺失或需要补做，不是新增制作人审批。自行定位并修复当前职责内的问题，不以“请制作人点击继续/允许返工”结束；只在已勾选的审批节点等待。保留真实失败证据，不能把失败改成通过。
按最新制作人范围执行：明确延期的 GI/其他专项不再作为本轮必做门禁。完成仍在本轮范围内的制作与验证，延期项写入 deferred 数组，字段 code、details、basis（逐字引用本需求中制作人的原始范围/延期指引）；同时在 checks、summary 说明尚未通过及延期，不丢弃原失败记录。延期不等于通过。不可自行延期仍必需的检查，也不可扩大本轮未选流程。本轮必需项实际完成后 outcome=done；必需项仍失败时 outcome=blocked 并给出具体可修复原因，系统会交回原会话继续处理。
`;

// Autonomous rework reuses Studio's existing checked recheck/dispatch path.
// It does not skip tasks, approve gates, change permissions, or resend unknown writes.
export class StudioFollowups {
  private timer?:NodeJS.Timeout;private closed=false;private ticking=false;private jobs=new Set<Promise<void>>();private busy=new Set<string>();
  constructor(private store:RelayStore,private studio:Studio,private remote:(host:string,a:Action,timeout?:number)=>Promise<any>,private online:(host:string)=>boolean,private now=()=>Date.now(),start=true){
    store.db.exec('CREATE TABLE IF NOT EXISTS studio_followups(id TEXT PRIMARY KEY,json TEXT NOT NULL)');
    if(start){this.timer=setInterval(()=>void this.tick(),3000);this.timer.unref();}
  }
  private tasks(r:StudioRun){return [r.planner,...r.tasks,...r.delivery?[r.delivery]:[]];}
  private project(r:StudioRun):StudioProject|undefined{return (this.studio as Studio&{projectForRun?:(r:StudioRun)=>StudioProject}).projectForRun?.(r)??this.studio.projects().find(p=>p.id===r.projectId);}
  private eligible(r:StudioRun,t:Task){
    const p=this.project(r),s=t.sessionId?this.store.getSession(t.sessionId):undefined;
    const migration=(r as StudioRun&{migration?:{phase:string}}).migration;
    if(!p||!s||r.autoAnswerQuestions===false||r.paused||r.workflow?.error||migration&&migration.phase!=='complete'||!['planning','executing','delivery'].includes(r.status)||r.workspace?.status!=='ready'||t.kind||t.status!=='blocked'||!(t.finishedAt||t.checkpoint?.at)||!t.actionId||t.checkpoint&&modelConnectionFailure(t.checkpoint.reason)||!this.online(p.hostId))return false;
    if(s.hostId!==p.hostId||s.projectId!==r.workspace.value?.project.id||!(t.checkpoint?['idle','failed','interrupted'].includes(s.status):s.status==='idle')||s.pendingCount||pendingProducerInput(this.store.sessionEvents(s.id),s.questionCount))return false;
    if(!t.dependencies.every(id=>r.tasks.some(x=>x.id===id&&(x.status==='done'||x.status==='skipped'&&x.skip))))return false;
    if(this.tasks(r).some(x=>['starting','running'].includes(x.status))||(r.chats??[]).some(c=>!c.resolved&&(!c.sessionId&&!c.error||c.sessionId&&['running','waiting'].includes(this.store.getSession(c.sessionId)?.status??''))))return false;
    // A deliberate user stop is not an automatic failure. Preserve it until
    // the producer explicitly resumes; a later acknowledged task action resets this boundary.
    if(this.store.db.prepare("SELECT 1 FROM actions WHERE host_id=? AND rowid>(SELECT rowid FROM actions WHERE id=?) AND json_extract(request,'$.type')='stop' AND json_extract(request,'$.sessionId')=? AND coalesce(json_extract(request,'$.queueOnly'),0)=0 LIMIT 1").get(p.hostId,t.actionId,s.id))return false;
    const receipt=this.store.db.prepare('SELECT host_id,request,result FROM actions WHERE id=?').get(t.actionId);if(!receipt?.result||receipt.host_id!==p.hostId)return false;
    try{const a=JSON.parse(String(receipt.request)),v=JSON.parse(String(receipt.result));return ['start','send','answer'].includes(a.type)&&(!a.sessionId||a.sessionId===s.id)&&!v.error&&(v.ok===true||v.sessionId===s.id);}catch{return false;}
  }
  private save(d:Followup,visible=true){
    this.store.db.prepare('INSERT OR REPLACE INTO studio_followups VALUES(?,?)').run(d.id,JSON.stringify(d));
    if(visible)this.studio.noteAutomaticFollowup(d.runId,d.taskId,{phase:d.phase,round:d.round,nextAt:d.nextAt,note:d.note});
  }
  async tick(){
    if(this.closed||this.ticking)return;this.ticking=true;
    try{for(const run of this.studio.runs())for(const task of this.tasks(run)){
      if(!this.eligible(run,task)||this.busy.has(run.id))continue;
      const id=createHash('sha256').update(JSON.stringify([run.id,task.id,task.sessionId,task.actionId,task.finishedAt??task.checkpoint?.at])).digest('hex');
      const old=this.store.db.prepare('SELECT json FROM studio_followups WHERE id=?').get(id);
      let d:Followup;
      if(old)d=JSON.parse(String(old.json));else{
        const rounds=this.store.db.prepare("SELECT count(*) n FROM studio_followups WHERE json_extract(json,'$.runId')=? AND json_extract(json,'$.taskId')=? AND json_extract(json,'$.phase')='queued'").get(run.id,task.id)!;
        const round=Number(rounds.n)+1,delay=round===1?3000:Math.min(900_000,60_000*2**Math.min(round-2,4));
        d={id,runId:run.id,taskId:task.id,sessionId:task.sessionId!,actionId:task.actionId!,finishedAt:(task.finishedAt??task.checkpoint!.at),phase:'scheduled',round,probes:0,nextAt:this.now()+delay,note:'未完成项将自动交回原 Agent；保留前置成果及所选审批'};this.save(d);
      }
      const loop=repeatedFailure(task);
      if(loop&&!d.loop){d.loop=loop;d.nextAt=this.now()+3000;d.note='连续 '+loop.count+' 轮同类阻断，自动调整修复分工与方案，不再只重复原检查';this.save(d);}
      if(d.phase==='queued'||(d.nextAt??0)>this.now())continue;
      if(d.phase==='unavailable')d.probes=0;d.phase='checking';d.probes++;this.save(d);this.busy.add(run.id);
      const job=this.resume(d);this.jobs.add(job);void job.catch(()=>{}).finally(()=>{this.jobs.delete(job);this.busy.delete(run.id);});
    }}catch{/* Never turn a state read failure into another production dispatch. */}finally{this.ticking=false;}
  }
  private async resume(d:Followup){
    try{
      const before=this.studio.runs().find(r=>r.id===d.runId),project=before&&this.project(before);if(!project)return;
      const page=await this.remote(project.hostId,{id:randomUUID(),type:'history',sessionId:d.sessionId,live:true},8000);
      if(page.cached||!Array.isArray(page.questions)||!Number.isFinite(page.questionsAsOf))throw Error('原会话实时状态尚未确认');
      const run=this.studio.runs().find(r=>r.id===d.runId),task=run&&this.tasks(run).find(t=>t.id===d.taskId);
      if(this.closed||!run||!task||!this.eligible(run,task)||task.actionId!==d.actionId||(task.finishedAt??task.checkpoint?.at)!==d.finishedAt||task.sessionId!==d.sessionId||page.questions.some((q:any)=>['pending','unknown'].includes(q.status))){d.phase='scheduled';d.nextAt=this.now()+60_000;d.note='等待原会话、前置步骤或已有问题处理完成；不重复投递';this.save(d);return;}
      const loop=repeatedFailure(task),partner=run.tasks.find(t=>t.remediationFor?.taskId===task.id&&t.remediationFor.blockerKey===loop?.key);
      const sameRepair=partner?.remediationFor?.sourceActionId===d.actionId;
      const canCollaborate=loop&&!task.remediationFor&&task.role!=='engineering'&&['implementation','integration'].includes(task.stage??'')&&(!run.workflow?.selection||run.workflow.selection.stages.includes(task.stage as any))&&project.roles.some(a=>a.role==='engineering'&&a.enabled);
      if(canCollaborate&&!(sameRepair&&(partner?.status==='done'||partner?.status==='skipped'&&partner.skip))){
        await this.studio.command({op:'collaborate-task',runId:run.id,taskId:task.id,automatic:true,blockerKey:loop!.key,expectedActionId:d.actionId,expectedFinishedAt:task.finishedAt??null,expectedCheckpointAt:task.checkpoint?.at??null});
        d.collaborationTaskId=this.studio.runs().find(r=>r.id===run.id)?.tasks.find(t=>t.remediationFor?.taskId===task.id&&t.remediationFor.blockerKey===loop!.key)?.id;
        d.phase='collaborating';d.nextAt=undefined;d.note='同类阻断已转程序协作修复；修复后返回原职能验证，后续审批保持不变';this.save(d);return;
      }
      const correction=loop?'连续 '+loop.count+' 轮同类失败，必须改变解决策略：先核对原验收是否被误扩展、已验证事实和失败候选，形成一个有依据的修复假设、最小产品改动及明确成功/失败判据；禁止仅重复诊断并把同一建议留给依赖自己的下游。'+(partner?.status==='done'?'程序协作修复已完成，先读取 '+partner.id+' 的实际改动与样张，只验证相关变化并收口。':''):'';
      const feedback=(task===run.planner?'只修正原 STUDIO_PLAN 的格式、阶段和依赖，不执行制作。':'在原工作副本补齐未完成部分，不能重跑已完成前置制作。')+'这是第 '+d.round+' 轮自动补做，不需要制作人另点继续。依据最新指引核对本轮范围；明确延期项引用原指引写 deferred，保留失败证据，不作为当前门禁，不声称通过。本轮仍必需的失败自行定位修复。'+correction+'\n上轮未完成原因：'+(task.error??task.summary??'交付未完成').slice(-900);
      await this.studio.command({op:'recheck-task',runId:run.id,taskId:task.id,automatic:true,expectedActionId:d.actionId,expectedFinishedAt:task.finishedAt??null,expectedCheckpointAt:task.checkpoint?.at??null,feedback:feedback.slice(0,2000)});
      d.phase='queued';d.nextAt=undefined;d.note='已自动交回原 Agent 补做，沿用原会话和工作副本；真实失败记录保留';this.save(d);
    }catch(error){
      const message=(error as Error).message;d.phase=d.probes>=5?'unavailable':'scheduled';d.nextAt=this.now()+(d.probes>=5?900_000:60_000);
      d.note=(d.probes>=5?'原会话连续五次未能确认，十五分钟后自动核对；未重复投递':'原会话核对失败，一分钟后自动核对')+'：'+message;this.save(d);
    }
  }
  async close(){this.closed=true;if(this.timer)clearInterval(this.timer);await Promise.allSettled(this.jobs);}
}
