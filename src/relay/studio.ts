import {withShowcase,videoPath} from './studio-showcase.js';
import {normalizeProductionFlow,productionFlowInstructions,productionRoleIds,ProductionPlanError} from './studio-flow.js';
import {validateToolchain,validateBlockers,toolchainInstructions,type StudioToolchain,type StudioBlocker} from './studio-tools.js';
import {randomUUID} from 'node:crypto';
import {MAX_TEXT,type Action,type Host,type Provider,type PermissionMode} from '../shared/protocol.js';
import type {RelayStore} from './store.js';
import {FileStore,type FileRef,uploadId,MAX_UPLOAD_BYTES} from '../shared/files.js';
import type {StudioWorkspace} from '../bridge/studio-workspace.js';
import {groupEntries,groupPage,type GroupPost} from './studio-group.js';
import {studioChannels} from './studio-channels.js';
import {upgradeScenePlan,compileScenePlan,sceneWorkflow,requireSceneRoles,sceneTaskInstructions,sceneStages,visualReferences,visualPath,type SceneStage,type SceneWorkflow} from './studio-scene.js';

export const STUDIO_ROLES = [
  ['director','制作统筹','拆解制作人需求，安排依赖、交付标准和集成验收。'],
  ['gameplay','玩法策划','核心循环、交互规则、体验与验收设计；实现交给程序。'],
  ['level','关卡策划 / LD','关卡节奏、空间布局、谜题与引导。'],
  ['balance','数值策划','成长、经济、难度曲线与可复算数值。'],
  ['systems','系统策划','系统规则、状态流转、存档与边界条件。'],
  ['concept','原画 / 视觉设计','风格、角色、场景概念与制作规格。'],
  ['model','模型 / 材质','模型、UV、材质与导入规格。'],
  ['environment','场景美术 / LA','场景搭建、构图、灯光与资源整合。'],
  ['techart','技术美术','着色器、特效、DCC 与引擎资源管线。'],
  ['ui','UI / UX','界面流程、交互反馈与可用性。'],
  ['audio','音频','音效、音乐、触发规则与混音。'],
  ['engineering','程序 / 集成','功能实现、工具、构建与可运行交付。'],
  ['qa','QA','独立执行验收、回归与缺陷报告，区分实测和推断。'],
] as const;
type TaskState='queued'|'starting'|'running'|'done'|'blocked'|'skipped'|'cancelled'|'awaiting-review';
interface TaskSkip {at:number;reason:string;previousStatus:'blocked';summary?:string;error?:string;blockers?:StudioBlocker[]}
// A producer waiver releases dependencies; it never changes the recorded verification result.
const released=(t:Task)=>t.status==='done'||t.status==='skipped'&&!!t.skip;
export interface Task {skip?:TaskSkip;planRepairs?:number;showcase?:boolean}
export interface Task {blockers?:StudioBlocker[];checkpoint?:{at:number;sessionId:string;reason:string}}
interface Assignment {role:string;enabled:boolean;provider:Provider;agentId?:string;model?:string;effort?:string;instructions:string;tools:string}
export interface StudioProject {toolchain?:StudioToolchain;includeCaptures?:boolean;id:string;name:string;hostId:string;projectId:string;workspaceIndex:number;roles:Assignment[];permissionMode:PermissionMode;concurrency:number;reviewPlan:boolean;createdAt:number;updatedAt:number}
interface Artifact {path:string;description:string}
export interface Task {resumeSessionId?:string;flowStopId?:string;id:string;title:string;role:string;brief:string;acceptance:string;dependencies:string[];status:TaskState;stage?:SceneStage;kind?:'visual-review'|'producer-review';reviewType?:'design'|'scene';reviewId?:string;approvedAt?:number;visualSnapshots?:{taskId:string;path:string;sha256:string}[];actionId?:string;sessionId?:string;startedAt?:number;finishedAt?:number;output?:string;summary?:string;artifacts?:Artifact[];checks?:string[];error?:string;feedback?:string;attempts?:{sessionId?:string;output?:string;at:number}[]}
interface RoleChat {role:string;actionId:string;sessionId?:string;error?:string;startedAt:number;resolved?:boolean;afterDelivery?:boolean;sourceSessionId?:string}
export interface StudioRun {recordVideo?:boolean;autoAccepted?:boolean;id:string;projectId:string;title:string;brief:string;status:'planning'|'plan-review'|'executing'|'delivery'|'review'|'accepted'|'cancelled';paused:boolean;tasks:Task[];planner:Task;delivery?:Task;workflow?:SceneWorkflow;createdAt:number;updatedAt:number;revision:number;feedback?:string;log:{id?:string;at:number;text:string;taskId?:string;taskTitle?:string;sessionId?:string;role?:string;skip?:TaskSkip;handoff?:{id:string;role:string;title:string;summary?:string;artifacts?:Artifact[]}[]}[];attachments?:FileRef[];workspace?:{status:'queued'|'preparing'|'ready'|'blocked';actionId?:string;value?:StudioWorkspace;error?:string};chats?:RoleChat[];guidance?:{id:string;role:string;text:string;files:FileRef[];at:number;sessionId:string}[]}
const roleIds=new Set<string>(STUDIO_ROLES.map(r=>r[0]));
const text=(v:unknown,max:number,label:string,optional=false)=>{if(typeof v!=='string'||v.length>max||(!optional&&!v.trim()))throw Error('请填写有效的'+label);return v.trim();};
function structured(output:string,kind:'plan'|'result'):any{
  const tag=kind==='plan'?'STUDIO_PLAN':'STUDIO_RESULT';
  const pattern=new RegExp('```'+tag+'\\s*([\\s\\S]*?)```','g');const blocks=[...output.matchAll(pattern)];
  if(blocks.length)return JSON.parse(blocks.at(-1)![1]);
  const clean=output.trim().replace(/^```(?:json)?\s*/,'').replace(/```\s*$/,'').trim();
  try{return JSON.parse(clean);}catch{throw Error(`未收到有效的 ${tag} 交付，请查看执行记录后修复 / 重试`);}
}
export function parseStudioPlan(output:string,roles:Assignment[],workflow?:SceneWorkflow):Task[]{
  const plan=structured(output,'plan');if(!Array.isArray(plan.tasks)||!plan.tasks.length||plan.tasks.length>40)throw Error('计划应包含 1–40 个任务');
  const ids=new Set<string>(),enabled=new Set(roles.filter(r=>r.enabled).map(r=>r.role));
  let tasks:Task[]=plan.tasks.map((v:any)=>{
    if(!/^[a-zA-Z0-9_-]{1,50}$/.test(v.id)||['studio-plan','studio-delivery','studio-showcase'].includes(v.id)||ids.has(v.id)||!enabled.has(v.role)||v.role==='director')throw Error('计划中的任务 ID 或职能无效');ids.add(v.id);
    if(!Array.isArray(v.dependencies)||v.dependencies.length>40||!v.dependencies.every((d:unknown)=>typeof d==='string'))throw Error('任务依赖无效');
    if(v.kind!==undefined||v.stage!==undefined&&!sceneStages.has(v.stage))throw Error('无效制作阶段；视觉确认由系统创建');
    return {id:v.id,title:text(v.title,160,'任务名称'),role:v.role,brief:text(v.brief,4000,'任务说明'),acceptance:text(v.acceptance,2000,'验收标准'),stage:v.stage,dependencies:[...new Set<string>(v.dependencies)],status:'queued'};
  });
  const visited=new Set<string>(),visiting=new Set<string>();
  function visit(id:string){if(visited.has(id))return;if(visiting.has(id))throw Error('计划存在循环依赖');const task=tasks.find(t=>t.id===id);if(!task)throw Error('计划引用了不存在的依赖');visiting.add(id);task.dependencies.forEach(visit);visiting.delete(id);visited.add(id);}
  tasks.forEach(t=>visit(t.id));
  if(workflow)tasks=compileScenePlan(tasks,workflow,roles);
  if(workflow?.selection)return tasks;
  // A final independent QA pass always follows every production task.
  if(!enabled.has('qa'))throw Error('请启用 QA 职能');
  const qaId=ids.has('studio-final-qa')?'studio-final-qa-'+randomUUID().slice(0,8):'studio-final-qa';
  tasks.push({id:qaId,title:'最终集成验收',role:'qa',stage:workflow?.kind==='scene'?'validation':undefined,brief:'独立检查所有交付物，执行适合此需求的实际验证。发现问题返回 blocked 并给出可复现步骤；缺少工具或环境也必须明确报告。'+(workflow?.kind==='scene'?'先确认本需求实际入口加载的是已确认设计对应的场景；对照原画逐项检查实机布局、材质、构图和光照。旧场景回归与本需求场景验收分别记录，不能仅凭玩法通过认定场景完成。':''),acceptance:'逐项对照制作人需求和所有任务验收标准；提供执行命令 / 操作、结果和遗留问题。只有实际通过才能 done。',dependencies:tasks.map(t=>t.id),status:'queued'});
  return tasks;
}
export class Studio {
  private flowUpgrades=new Map<string,Promise<StudioRun>>();
  private ticking=false;private closed=false;private launches=new Set<Promise<unknown>>();
  private timer:NodeJS.Timeout;
  constructor(private store:RelayStore,private remote:(host:string,action:Action,timeout?:number)=>Promise<any>,private online:(host:string)=>boolean,private changed:()=>void,private files?:FileStore,private inspectVisual?:(host:string,sessionId:string,path:string)=>Promise<{sha256:string}>){
    store.db.exec('CREATE TABLE IF NOT EXISTS studio_projects(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS studio_runs(id TEXT PRIMARY KEY,json TEXT NOT NULL);');
    store.db.exec('CREATE TABLE IF NOT EXISTS studio_group_posts(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,at INTEGER NOT NULL,json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS studio_group_run ON studio_group_posts(run_id,at); CREATE TABLE IF NOT EXISTS studio_group_records(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,at INTEGER NOT NULL,json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS studio_group_record_run ON studio_group_records(run_id,at);');
    for(const run of this.runs()){
      if(!run.workflow){
        run.workflow=sceneWorkflow(undefined,run.title,run.brief);
        if(run.tasks.some(t=>['concept','model','environment'].includes(t.role)))run.workflow.kind='scene';
        if(run.workflow.kind==='scene'&&!['accepted','cancelled'].includes(run.status)){
          try{requireSceneRoles(run.workflow,this.project(run.projectId).roles);
            if(run.tasks.length){
              if(run.tasks.some(t=>t.status!=='queued'||t.sessionId))throw Error('旧场景计划已经开始执行，已暂停后续分发；请核对并对统筹重新拆解，原执行记录保留');
              const qa=run.tasks.find(t=>t.id.startsWith('studio-final-qa'));run.tasks=compileScenePlan(run.tasks.filter(t=>t!==qa),run.workflow,this.project(run.projectId).roles);if(qa){qa.stage='validation';qa.dependencies=run.tasks.map(t=>t.id);run.tasks.push(qa);}run.planner.summary='已按场景生产流程补齐任务与视觉确认节点';
            }
          }catch(e){run.workflow.error=(e as Error).message;run.paused=true;}
        }
        this.saveRun(run,run.workflow.kind==='scene'?'已检查场景生产顺序：原画 → 制作人确认 → 资产规格与生产 → LA → 集成 → QA':'已登记通用制作流程');
      }
      if(run.workflow?.kind==='scene'&&run.workflow.version!==2&&run.tasks.length&&!['accepted','cancelled'].includes(run.status)){
        run.workflow.upgradeRestorePaused??=run.paused;run.paused=true;run.workflow.error='场景流程已更新：玩法与 LD 设计后先看原画；请应用新版流程，保留已有结果并暂存提前运行的程序任务。';this.saveRun(run,'等待更新场景依赖顺序，暂停后续分发');
      }
      if(!run.workspace){
        if(run.status==='plan-review'&&run.planner.status==='done'&&run.tasks.every(t=>t.status==='queued'&&!t.sessionId)){
          // The old planner was read-only. Preserve its approved-plan candidate and archive its source session.
          if(run.planner.sessionId){run.planner.attempts=[...(run.planner.attempts??[]),{sessionId:run.planner.sessionId,output:run.planner.output,at:Date.now()}];run.planner.sessionId=undefined;}
          run.workspace={status:'queued'};this.saveRun(run,'现有只读计划已保留；制作任务改用独立分支，原统筹会话归入历史');
        }else{run.workspace={status:'blocked',error:'旧需求未建立隔离分支，已暂停后续分发；请新建需求使用独立分支。'};run.paused=true;this.saveRun(run);}
      }
      if(run.workspace.status==='preparing'){const result=this.receipt(run.workspace.actionId);run.workspace=result?.workspace?{status:'ready',value:result.workspace}:{status:'blocked',error:'工作副本准备结果未确认。检查后可点击重新核对；不会在原工程启动。'};this.saveRun(run);}
      if(run.workspace.status==='ready'&&run.workspace.value){const p=this.project(run.projectId);for(const f of run.attachments??[])this.files?.link(p.hostId+'|project:'+p.projectId,p.hostId+'|project:'+run.workspace.value.project.id,f.id);}
      for(const chat of run.chats??[])if(!chat.sessionId&&!chat.error&&!chat.resolved){const result=this.receipt(chat.actionId);if(result?.sessionId)chat.sessionId=result.sessionId;else chat.error='会话启动结果未确认，请先核对会话工作台，系统不会重复发送。';this.saveRun(run);}
    }
    for(const run of this.runs())for(const task of this.allTasks(run))if(task.status==='starting'){
      const row=task.actionId?store.db.prepare('SELECT result FROM actions WHERE id=?').get(task.actionId):undefined;const result=row?.result?JSON.parse(String(row.result)):undefined;
      if(result?.sessionId){task.sessionId=result.sessionId;task.status='running';}
      else{task.status='blocked';task.error='服务重启时投递结果尚未确认。请先查看会话，核对后绑定或重试，系统不会自动重发。';}
      this.saveRun(run,'恢复未完成的任务状态',task);
    }
    this.timer=setInterval(()=>void this.tick(),2000);this.timer.unref();
  }
  projects():StudioProject[]{return this.store.db.prepare('SELECT json FROM studio_projects ORDER BY rowid DESC').all().map(r=>JSON.parse(String(r.json)));}
  runs():StudioRun[]{return this.store.db.prepare('SELECT json FROM studio_runs ORDER BY rowid DESC').all().map(r=>JSON.parse(String(r.json)));}
  state(){return {roles:STUDIO_ROLES.map(([id,name,description])=>({id,name,description})),projects:this.projects(),runs:this.runs()};}
  private project(id:string){const p=this.projects().find(p=>p.id===id);if(!p)throw Error('团队项目不存在');return p;}
  private run(id:string){const r=this.runs().find(r=>r.id===id);if(!r)throw Error('制作需求不存在');return r;}
  private receipt(id?:string){const row=id?this.store.db.prepare('SELECT result FROM actions WHERE id=?').get(id):undefined;return row?.result?JSON.parse(String(row.result)):undefined;}
  private canCheckpoint(r:StudioRun,t:Task){
    if(t.kind||!t.sessionId||!['running','blocked'].includes(t.status)||r.workspace?.status!=='ready')return false;
    const s=this.store.getSession(t.sessionId),p=this.project(r.projectId);
    if(!s||s.hostId!==p.hostId||s.projectId!==this.execution(r).id||!['interrupted','failed'].includes(s.status)||s.pendingCount)return false;
    const row=t.actionId?this.store.db.prepare('SELECT result FROM actions WHERE id=?').get(t.actionId):undefined;
    // A confirmed old session is insufficient when the latest send itself has an unknown outcome.
    if(row&&!row.result)return false;
    return true;
  }
  private checkpoint(r:StudioRun,t:Task){
    if(!this.canCheckpoint(r,t)||t.checkpoint)return false;
    t.output=this.taskOutput(t)||t.output;t.status='blocked';
    const failure=this.store.sessionEvents(t.sessionId!).filter(e=>e.at>=(t.startedAt??0)&&e.type==='error').at(-1)?.data.message;
    t.checkpoint={at:Date.now(),sessionId:t.sessionId!,reason:typeof failure==='string'?failure.slice(-1000):'执行中断，原会话、工程文件与已完成的前置任务均已保留'};
    t.error='执行中断或失败，已保存断点；可在原会话继续，无需重新拆解或重跑已完成任务';
    return true;
  }
  private continueTask(r:StudioRun,t:Task){
    if(!t.checkpoint||!this.canCheckpoint(r,t)||t.checkpoint.sessionId!==t.sessionId)throw Error('当前断点尚不能恢复，请先核对会话状态与投递结果');
    if(!this.dependenciesReady(r,t))throw Error('请先完成前置任务及制作人审批，再从断点继续');
    t.resumeSessionId=t.sessionId;t.status='queued';t.actionId=undefined;t.error=undefined;t.finishedAt=undefined;
  }
  private taskOutput(t:Task){
    if(!t.sessionId)return '';
    const messages=new Map<string,string>();
    for(const e of this.store.sessionEvents(t.sessionId).filter(e=>e.at>=(t.startedAt??0))){
      if(e.type==='message'&&e.data.role==='assistant')messages.set(e.data.id,String(e.data.text??''));
      if(e.type==='delta')messages.set(e.data.messageId,(messages.get(e.data.messageId)??'')+String(e.data.text??''));
    }
    return [...messages.values()].join('\n').slice(-60000);
  }
  private execution(r:StudioRun){if(r.workspace?.status!=='ready'||!r.workspace.value)throw Error('需求的独立分支尚未准备完成');return r.workspace.value.project;}
  private inputRefs(r:StudioRun){const refs=[...this.groupPosts(r.id).slice().reverse().flatMap(p=>p.files),...(r.guidance??[]).slice().reverse().flatMap(g=>g.files),...(r.attachments??[])],selected:FileRef[]=[];let size=0;for(const f of refs)if(!selected.some(x=>x.id===f.id)&&selected.length<5&&size+f.size<=MAX_UPLOAD_BYTES){selected.push(f);size+=f.size;}return selected;}
  private linkAttachments(r:StudioRun,sessionId:string){const p=this.project(r.projectId);for(const file of this.inputRefs(r))this.files?.link(p.hostId+'|project:'+this.execution(r).id,p.hostId+'|'+sessionId,file.id);}
  private async resumeAttachments(r:StudioRun,sessionId:string){
    if(!this.files)return;const p=this.project(r.projectId),scope=p.hostId+'|project:'+this.execution(r).id,target=p.hostId+'|'+sessionId;
    for(const file of this.inputRefs(r)){
      let bytes:Buffer;try{bytes=this.files.read(scope,file.id).bytes;}catch{
        const scopes=this.store.db.prepare('SELECT scope FROM upload_files WHERE id=?').all(file.id).map(x=>String(x.scope)),source=scopes.map(s=>s.slice(p.hostId.length+1)).find(id=>this.store.getSession(id)?.hostId===p.hostId);
        if(!source)throw Error('续做参考附件尚未缓存，请重新附加该文件：'+file.name);const payload=await this.remote(p.hostId,{id:randomUUID(),type:'file',sessionId:source,fileId:file.id});this.files.import(payload);bytes=this.files.read(scope,file.id).bytes;
      }
      const result=await this.remote(p.hostId,{id:randomUUID(),type:'upload',upload:{scope:target,file,data:bytes.toString('base64')}});if(result?.file?.sha256!==file.sha256)throw Error('原会话尚未收到续做参考附件：'+file.name);this.files.link(scope,target,file.id);
    }
  }
  file(runId:string,id:string){const r=this.run(runId);if(!(r.attachments??[]).some(f=>f.id===id)&&!this.groupPosts(r.id).some(p=>p.files.some(f=>f.id===id)))throw Error('附件不属于此需求');if(!this.files)throw Error('附件服务未启用');return this.files.read('studio:'+r.id,id);}
  visualArtifact(runId:string,taskId:string,index:number,kind='image'){
    const r=this.run(runId),p=this.project(r.projectId),t=this.allTasks(r).find(t=>t.id===taskId),artifact=Number.isInteger(index)&&index>=0?t?.artifacts?.[index]:undefined,s=t?.sessionId?this.store.getSession(t.sessionId):undefined;
    if(!artifact||!(kind==='video'?/\.(mp4|webm|mov|m4v)$/i.test(artifact.path):visualPath(artifact.path))||!t?.sessionId||!s||s.hostId!==p.hostId||s.projectId!==this.execution(r).id)throw Error('原画不属于此需求的工作副本');
    return {hostId:p.hostId,sessionId:t.sessionId,path:artifact.path};
  }
  private resetTask(t:Task,feedback?:string){
    t.checkpoint=undefined;t.blockers=undefined;t.skip=undefined;
    t.attempts=[...(t.attempts??[]),{sessionId:t.sessionId,output:t.output,at:Date.now()}];
    Object.assign(t,{status:'queued',actionId:undefined,sessionId:undefined,output:undefined,summary:undefined,artifacts:undefined,checks:undefined,error:undefined,finishedAt:undefined,reviewId:undefined,approvedAt:undefined,visualSnapshots:undefined,feedback});
  }
  private dependentTasks(r:StudioRun,ids:string[]){const affected=new Set(ids);let growing=true;while(growing){growing=false;for(const t of r.tasks)if(!affected.has(t.id)&&t.dependencies.some(id=>affected.has(id))){affected.add(t.id);growing=true;}}return affected;}
  private dependenciesReady(r:StudioRun,t:Task){if(r.workflow?.selection)return !r.workflow.error&&t.dependencies.every(id=>r.tasks.some(x=>x.id===id&&released(x)));return (!(r.workflow?.kind==='scene'&&(t.kind==='visual-review'||t.stage==='concept'))||r.tasks.filter(x=>x.stage==='requirements').every(released))&&t.dependencies.every(id=>r.tasks.some(x=>x.id===id&&released(x)))&&(!r.workflow?.error)&&(!(r.workflow?.kind==='scene'&&['balance','implementation','asset-spec','assets','assembly','integration','validation'].includes(t.stage??''))||r.tasks.some(g=>g.kind==='visual-review'&&g.status==='done'&&g.approvedAt&&g.visualSnapshots?.length));}
  private allTasks(r:StudioRun){return [r.planner,...r.tasks,...r.delivery?[r.delivery]:[]];}
  private saveRun(r:StudioRun,note?:string,task?:Task){
    r.updatedAt=Date.now();r.revision++;
    if(note){const entry={id:randomUUID(),at:r.updatedAt,text:note,...task?{taskId:task.id,taskTitle:task.title,sessionId:task.sessionId,role:task.role,...note.startsWith('制作人跳过并继续：')?{skip:task.skip}:{}}:{},...task&&note==='已启动：'+task.title?{handoff:r.tasks.filter(t=>task.dependencies.includes(t.id)).map(t=>({id:t.id,role:t.role,title:t.title,summary:t.status==='skipped'?'【制作人已跳过，原阻断保留】'+t.skip?.reason+'\n'+(t.summary??''):t.summary,artifacts:t.artifacts}))}:{}};
      r.log.push(entry);r.log=r.log.slice(-200);this.store.db.prepare('INSERT INTO studio_group_records VALUES(?,?,?,?)').run(entry.id,r.id,entry.at,JSON.stringify(entry));}
    this.store.db.prepare('INSERT OR REPLACE INTO studio_runs VALUES(?,?)').run(r.id,JSON.stringify(r));this.changed();
  }
  saveToolchain(v:any){
    const p=this.project(v.projectId);p.toolchain=validateToolchain(v.toolchain);p.updatedAt=Date.now();
    this.store.db.prepare('INSERT OR REPLACE INTO studio_projects VALUES(?,?)').run(p.id,JSON.stringify(p));
    for(const r of this.runs().filter(r=>r.projectId===p.id&&!['accepted','cancelled'].includes(r.status)))this.saveRun(r,'团队工具环境已更新；后续制作与原会话复核使用最新路径，当前任务不重复投递');
    this.changed();return p;
  }
  saveProject(v:any){
    const host=this.store.hosts().find(h=>h.id===v.hostId),project=host?.projects.find(p=>p.id===v.projectId);
    if(!host||!project)throw Error('请选择工作电脑和允许的工程');
    if(!Number.isInteger(v.workspaceIndex)||v.workspaceIndex<0||!(project.roots??[project.path])[v.workspaceIndex])throw Error('请选择有效工作目录');
    if(!Array.isArray(v.roles)||v.roles.length!==STUDIO_ROLES.length||new Set(v.roles.map((r:any)=>r.role)).size!==STUDIO_ROLES.length)throw Error('团队职能配置不完整');
    const roles:Assignment[]=v.roles.map((r:any)=>{
      if(!roleIds.has(r.role)||typeof r.enabled!=='boolean'||!['codex','claude','api'].includes(r.provider))throw Error('无效职能或 Agent');
      const choice={...r,agentId:r.agentId||undefined,model:r.model||undefined,effort:r.effort||undefined};
      validateAssignment(choice,host);
      return {role:r.role,enabled:r.enabled,provider:r.provider,agentId:choice.agentId,model:choice.model,effort:choice.effort,instructions:text(r.instructions??'',2500,'职能补充说明',true),tools:text(r.tools??'',2500,'工具说明',true)};
    });
    if(!roles.find(r=>r.role==='director')?.enabled||!roles.find(r=>r.role==='qa')?.enabled)throw Error('制作统筹和 QA 必须启用');
    if(!['request','auto','full'].includes(v.permissionMode)||!Number.isInteger(v.concurrency)||v.concurrency<1||v.concurrency>4||typeof v.reviewPlan!=='boolean')throw Error('无效执行设置');
    const old=v.id?this.project(v.id):undefined,now=Date.now();
    const p:StudioProject={id:old?.id??randomUUID(),name:text(v.name,100,'团队名称'),hostId:host.id,projectId:project.id,workspaceIndex:v.workspaceIndex,roles,permissionMode:v.permissionMode,concurrency:v.concurrency,reviewPlan:v.reviewPlan,includeCaptures:v.includeCaptures===true,toolchain:validateToolchain(v.toolchain===undefined?old?.toolchain:v.toolchain),createdAt:old?.createdAt??now,updatedAt:now};
    if(old&&this.runs().some(r=>r.projectId===old.id&&!['accepted','cancelled'].includes(r.status)))throw Error('该团队仍有制作需求，请完成或取消后再修改配置');
    this.store.db.prepare('INSERT OR REPLACE INTO studio_projects VALUES(?,?)').run(p.id,JSON.stringify(p));this.changed();return p;
  }
  createRun(v:any){
    const p=this.project(v.projectId);if(!this.online(p.hostId))throw Error('工作电脑离线，请上线后发起');
    if(!this.store.hosts().find(h=>h.id===p.hostId)?.capabilities?.studioWorkspaces)throw Error('请先升级工作电脑连接程序，以支持每个需求独立分支');
    if(v.attachmentIds!==undefined&&(!Array.isArray(v.attachmentIds)||!v.attachmentIds.every((id:unknown)=>typeof id==='string'&&uploadId.test(id))))throw Error('无效需求附件');
    if(v.attachmentIds?.length&&!this.files)throw Error('附件服务未启用');
    const title=text(v.title,160,'需求名称'),brief=text(v.brief,12000,'制作需求'),workflow=sceneWorkflow(v.workflow,title,brief,v.reuseReason);workflow.selection=normalizeProductionFlow(v.flowConfig);if(workflow.selection){workflow.kind=workflow.selection.stages.some(s=>['concept','asset-spec','assets','assembly'].includes(s))?'scene':'general';workflow.explicitGeneral=false;}requireSceneRoles(workflow,p.roles);
    if(v.recordVideo!==undefined&&typeof v.recordVideo!=='boolean')throw Error('无效展示视频选项');
    const now=Date.now(),r:StudioRun={recordVideo:v.recordVideo===true,id:randomUUID(),projectId:p.id,title,brief,workflow,status:'planning',paused:false,tasks:[],planner:{id:'studio-plan',title:'需求拆解与制作计划',role:'director',brief:'拆解制作人需求',acceptance:'任务依赖与验收标准完整',dependencies:[],status:'queued'},createdAt:now,updatedAt:now,revision:0,log:[]};
    r.workspace={status:'queued'};r.chats=[];r.guidance=[];r.attachments=this.files?.refs(p.hostId+'|project:'+p.projectId,v.attachmentIds??[])??[];
    for(const file of r.attachments)this.files?.link(p.hostId+'|project:'+p.projectId,'studio:'+r.id,file.id);
    this.saveRun(r,'制作人提出需求，先准备独立分支与工作副本');void this.tick();return r;
  }
  async command(v:any){
    const r=this.run(v.runId),p=this.project(r.projectId),task=this.allTasks(r).find(t=>t.id===v.taskId);
    if(v.op==='record-showcase'){if(r.status==='cancelled'||r.workspace?.status!=='ready'||!this.online(p.hostId))throw Error('请确认需求工作副本可用且工作电脑在线');if(r.tasks.some(t=>t.showcase))return r;if(this.chatBusy(r)||!r.tasks.length||!r.tasks.every(released)||this.allTasks(r).some(t=>['starting','running'].includes(t.status)))throw Error('请先完成制作、审批和当前执行');r.tasks=withShowcase(r.tasks,true);r.recordVideo=true;r.autoAccepted=undefined;r.status='executing';r.paused=false;this.saveRun(r,'制作人补录成果展示视频，保留原分支、已完成任务和审批',r.tasks.find(t=>t.showcase));void this.tick();return this.run(r.id);}
    if(r.status==='cancelled'||r.status==='accepted'&&!['bind-chat','resolve-chat'].includes(v.op))throw Error('需求已结束');
    if(v.op==='approve-step'||v.op==='reject-step'){
      if(task?.kind!=='producer-review'||task.status!=='awaiting-review'||task.reviewId!==v.reviewId||!this.dependenciesReady(r,task))throw Error('本轮审批内容已变化，请重新查看');
      if(v.op==='approve-step'){task.status='done';task.approvedAt=Date.now();task.finishedAt=task.approvedAt;task.summary='制作人已确认本轮交付，开放后续环节';this.saveRun(r,'制作人批准：'+task.title,task);}
      else{const feedback=text(v.feedback,3000,'修改意见'),affected=this.dependentTasks(r,task.dependencies);if(this.chatBusy(r)||this.allTasks(r).some(t=>['starting','running'].includes(t.status)))throw Error('请等待当前执行结束再退回修改');for(const t of r.tasks)if(affected.has(t.id))this.resetTask(t,task.dependencies.includes(t.id)?feedback:'制作人打回上游，重新验证本轮交付');r.delivery=undefined;r.status='executing';r.feedback=feedback;this.saveRun(r,'制作人打回：'+task.title,task);}
      void this.tick();return this.run(r.id);
    }
    if(v.op==='skip-task'){
      if(!task||!r.tasks.includes(task)||task.kind||task.role==='qa')throw Error('只能跳过制作任务；制作人视觉确认和最终 QA 需要单独完成');
      const reason=text(v.feedback,3000,'跳过原因');
      // A repeated confirmed request must not release or dispatch another task.
      if(task.status==='skipped'&&task.skip?.reason===reason)return r;
      if(task.status!=='blocked')throw Error('只能跳过已阻断的制作任务');
      if(v.expectedActionId!==(task.actionId??null)||v.expectedFinishedAt!==(task.finishedAt??null))throw Error('任务执行记录已变化，请重新查看后决定是否跳过');
      const s=task.sessionId?this.store.getSession(task.sessionId):undefined,receipt=task.actionId?this.store.db.prepare('SELECT result FROM actions WHERE id=?').get(task.actionId):undefined;
      if(task.actionId&&!receipt?.result||task.sessionId&&(!s||!['idle','failed','interrupted'].includes(s.status)||s.pendingCount)||this.chatBusy(r)||this.allTasks(r).some(t=>['starting','running'].includes(t.status)))throw Error('当前执行或投递结果尚未确认，请先核对并停止执行，再跳过');
      if(!this.dependenciesReady(r,task))throw Error('前置任务或本轮视觉确认尚未完成');
      task.skip={at:Date.now(),reason,previousStatus:'blocked',summary:task.summary,error:task.error,blockers:task.blockers};task.status='skipped';task.checkpoint=undefined;
      r.paused=false;this.saveRun(r,'制作人跳过并继续：'+task.title+'\n原因：'+reason+'\n原阻断与验证结果保留，交给后续 QA 核查。',task);void this.tick();return this.run(r.id);
    }
    if(v.op==='upgrade-scene-flow'){const pending=this.flowUpgrades.get(r.id);if(pending)return pending;const job=this.upgradeScene(r,p).finally(()=>this.flowUpgrades.delete(r.id));this.flowUpgrades.set(r.id,job);return job;}
    if(v.op==='recheck-task'){
      if(!task||task.kind||task.status!=='blocked'||!task.sessionId)throw Error('请选择已阻断且已绑定会话的职能任务');
      if(!this.online(p.hostId)||!this.dependenciesReady(r,task))throw Error('请先完成前置任务、制作人审批并确认电脑在线');
      const session=this.store.getSession(task.sessionId),receipt=task.actionId?this.store.db.prepare('SELECT result FROM actions WHERE id=?').get(task.actionId):undefined;
      if(!session||session.hostId!==p.hostId||session.projectId!==this.execution(r).id||!['idle','failed','interrupted'].includes(session.status)||session.pendingCount||receipt&&!receipt.result)throw Error('会话仍忙或投递结果未确认，不能重复发送复核');
      if(this.chatBusy(r)||this.allTasks(r).some(t=>['starting','running'].includes(t.status)))throw Error('请等待当前任务和角色对话结束后复核');
      task.attempts=[...(task.attempts??[]),{sessionId:task.sessionId,output:task.output,at:Date.now()}];
      task.resumeSessionId=task.sessionId;task.status='queued';task.actionId=undefined;task.error=undefined;task.finishedAt=undefined;
      task.feedback=(task===r.planner?'计划校验修正：沿用原会话的工程分析，只修正任务拆解。严格遵守制作人所选阶段、职能对应和审批设置；删除未选阶段的任务并修正依赖，不能把场景组装或集成校验改标为资产生产来绕过范围。重新输出完整 STUDIO_PLAN，不执行制作、不修改工程。':'技术阻断复核：先读取团队最新工具配置和原检查报告，在同一工作副本与原会话只补做未完成步骤。区分不适用项与硬阻断；核对最新上游程序交付，不以旧规格快照覆盖合法更新。未解决的质量或构建来源门禁仍保持 blocked。')+(v.feedback?text(v.feedback,2000,'复核说明'):'');
      r.paused=false;this.saveRun(r,task===r.planner?'在原统筹会话修正计划，保留工程分析与原流程选择':'在原会话复核技术阻断，保留已有前置成果与视觉批准',task);void this.tick();return this.run(r.id);
    }
    else if(v.op==='continue-task'||v.op==='continue-run'){
      if(!this.online(p.hostId))throw Error('工作电脑离线，断点已保留，请上线后继续');
      if(r.workflow?.error)throw Error(r.workflow.error);
      const pending=v.op==='continue-task'?(task?[task]:[]):this.allTasks(r).filter(t=>t.checkpoint&&this.canCheckpoint(r,t)&&this.dependenciesReady(r,t));
      if(!pending.length)throw Error('没有可继续的执行断点');
      for(const t of pending)this.continueTask(r,t);
      r.paused=false;this.saveRun(r,'从断点继续：'+pending.map(t=>t.title).join('、'),task);void this.tick();return this.run(r.id);
    }
    if(v.op==='retry-workspace'&&r.workspace?.status==='blocked'&&!this.allTasks(r).some(t=>t.sessionId)){r.workspace={status:'queued'};this.saveRun(r,'重新核对 / 准备需求工作副本');}
    else if(v.op==='pause'){if(r.workflow?.version===1)r.workflow.upgradeRestorePaused=true;r.paused=true;this.saveRun(r,'暂停后续分发，当前执行继续');}
    else if(v.op==='resume'){if(r.workflow?.version===1)r.workflow.upgradeRestorePaused=false;r.paused=false;this.saveRun(r,'继续分发');}
    else if(v.op==='approve-plan'&&r.status==='plan-review'){if(r.workflow?.error)throw Error(r.workflow.error);r.status='executing';this.saveRun(r,'制作人确认计划；场景视觉确认仍单独等待制作人操作');}
    else if(v.op==='approve-visual'&&task?.kind==='visual-review'){
      if(task.status!=='awaiting-review'||typeof v.reviewId!=='string'||v.reviewId!==task.reviewId||!this.dependenciesReady(r,task))throw Error('本轮原画已变化或尚未完成，请重新查看确认');
      if(!this.inspectVisual)throw Error('原画预览服务尚未启用，请升级工作电脑连接程序');
      const references=visualReferences(r.tasks,task),snapshots=[];
      if(!Array.isArray(v.visualHashes)||v.visualHashes.length!==references.length||new Set(v.visualHashes.map((h:any)=>h?.taskId+':'+h?.index)).size!==references.length)throw Error('请先加载并查看本轮全部原画后确认');
      for(const ref of references){const shown=v.visualHashes.find((h:any)=>h?.taskId===ref.taskId&&h?.index===ref.index);if(!shown||!/^[a-f0-9]{64}$/.test(shown.sha256??''))throw Error('本轮原画预览校验缺失，请重新加载');const target=this.visualArtifact(r.id,ref.taskId,ref.index),result=await this.inspectVisual(target.hostId,target.sessionId,target.path);if(result.sha256!==shown.sha256)throw Error('原画文件在预览后发生变化，请重新加载查看后再确认');snapshots.push({taskId:ref.taskId,path:ref.path,sha256:result.sha256});}
      const latest=this.run(r.id),gate=latest.tasks.find(t=>t.id===task.id);
      if(['accepted','cancelled'].includes(latest.status)||!gate||gate.status!=='awaiting-review'||gate.reviewId!==v.reviewId||!this.dependenciesReady(latest,gate)||JSON.stringify(visualReferences(latest.tasks,gate))!==JSON.stringify(references))throw Error('确认期间原画已变化，请重新查看本轮原画');
      gate.status='done';gate.approvedAt=Date.now();gate.finishedAt=gate.approvedAt;gate.visualSnapshots=snapshots;gate.artifacts=references.map(ref=>({path:ref.path,description:ref.description||'制作人确认的本轮视觉原稿'}));gate.checks=snapshots.map(s=>s.path+' · 已确认图片 SHA-256 '+s.sha256);gate.summary='制作人已确认本轮视觉方向，开放资产规格及后续生产';this.saveRun(latest,'制作人确认本轮场景原画与视觉方向',gate);
    }
    else if(v.op==='reject-visual'&&task?.kind==='visual-review'){
      if(task.status!=='awaiting-review'||v.reviewId!==task.reviewId)throw Error('本轮原画已变化，请重新查看');const feedback=text(v.feedback,3000,'原画修改意见'),affected=this.dependentTasks(r,task.dependencies);
      if(r.tasks.some(t=>affected.has(t.id)&&['starting','running'].includes(t.status)))throw Error('相关任务仍在执行，请先停止后调整原画');
      for(const t of r.tasks)if(affected.has(t.id))this.resetTask(t,task.dependencies.includes(t.id)?feedback:'原画返工，旧视觉确认失效，需重新验收上游交付');r.delivery=undefined;r.status='executing';r.feedback=feedback;this.saveRun(r,'制作人要求修改原画；视觉确认与下游结果已失效',task);
    }
    else if(v.op==='accept'&&r.status==='review'){if(r.workflow?.error)throw Error(r.workflow.error);if(r.workflow?.kind==='scene'&&(!r.workflow.selection||r.workflow.selection.approvals.visual)&&!r.tasks.some(t=>t.kind==='visual-review'&&t.status==='done'&&t.approvedAt&&t.visualSnapshots?.length))throw Error('本轮视觉确认尚未完成，不能验收');if(!r.tasks.every(released)||!r.tasks.filter(t=>t.role==='qa').every(t=>t.status==='done'))throw Error('制作任务与最终 QA 尚未完成，不能验收');const skipped=r.tasks.filter(t=>t.status==='skipped');if(skipped.length&&v.acknowledgeSkipped!==true)throw Error('存在制作人跳过记录，请查看遗留问题并明确确认后验收');if(this.chatBusy(r))throw Error('请等待角色对话结束或先停止，再验收');r.status='accepted';this.saveRun(r,skipped.length?'制作人确认跳过记录与遗留问题后验收：'+skipped.map(t=>t.id).join('、'):'制作人验收通过');}
    else if(v.op==='bind-chat'){
      const c=r.chats?.find(c=>c.actionId===v.actionId&&!c.sessionId),s=this.store.getSession(v.sessionId);if(!c||c.resolved||!s||s.hostId!==p.hostId||s.projectId!==this.execution(r).id||s.updatedAt<c.startedAt||this.runs().some(x=>[...this.allTasks(x).map(t=>t.sessionId),...(x.chats??[]).map(c=>c.sessionId)].includes(s.id)))throw Error('请选择该需求中尚未绑定的正确会话');c.sessionId=s.id;c.error=undefined;this.saveRun(r,'人工核对并绑定角色会话');
    }
    else if(v.op==='resolve-chat'){const c=r.chats?.find(c=>c.actionId===v.actionId&&!c.sessionId&&c.error);if(!c||v.confirmedNotStarted!==true)throw Error('请先人工确认该会话没有启动');c.resolved=true;this.saveRun(r,'制作人核对角色会话未启动，解除分发等待');}
    else if(v.op==='cancel'){
      r.status='cancelled';r.paused=true;for(const t of this.allTasks(r))if(['queued','awaiting-review'].includes(t.status))t.status='cancelled';this.saveRun(r,'制作人取消需求，向运行中的任务发送停止');
      const stopping=[...this.allTasks(r).filter(t=>t.sessionId&&t.status==='running'),...(r.chats??[]).filter(c=>c.sessionId&&['running','waiting'].includes(this.store.getSession(c.sessionId)?.status??'')).map(c=>({id:c.actionId,sessionId:c.sessionId}))];
      const results=await Promise.allSettled(stopping.map(t=>this.remote(p.hostId,{id:randomUUID(),type:'stop',sessionId:t.sessionId})));
      const latest=this.run(r.id);for(const [i,result] of results.entries()){const t=this.allTasks(latest).find(t=>t.id===stopping[i].id);if(t){t.status=result.status==='fulfilled'?'cancelled':'blocked';if(result.status==='rejected')t.error='停止未确认：'+String(result.reason?.message??result.reason);}}
      const failures=results.filter(x=>x.status==='rejected');this.saveRun(latest,failures.length?`${failures.length} 个任务未确认停止，请在执行记录中检查`:'已确认停止运行中的任务');
    }
    else if(v.op==='bind'&&task?.status==='blocked'){
      if(task.kind||!this.dependenciesReady(r,task))throw Error('请先完成任务前置环节与制作人视觉确认');
      const s=this.store.getSession(v.sessionId);if(!s||s.hostId!==p.hostId||s.projectId!==this.execution(r).id||s.updatedAt<(task.startedAt??r.createdAt))throw Error('请选择该需求工作副本中本次启动后的会话');
      if(this.runs().some(x=>this.allTasks(x).some(t=>t.sessionId===s.id)))throw Error('该会话已绑定任务');
      task.sessionId=s.id;task.status='running';task.error=undefined;this.saveRun(r,'人工核对并绑定任务会话',task);
    }
    else if(v.op==='retry'&&task&&['blocked','done','skipped'].includes(task.status)){
      if(task.kind)throw Error('请对审批上游制作任务提出返工，视觉确认不能绑定或重试为 Agent 任务');
      const feedback=text(v.feedback,3000,'返工 / 重试说明');
      if(this.chatBusy(r)||this.allTasks(r).some(t=>['starting','running'].includes(t.status)))throw Error('请等待当前任务和角色对话结束，或先停止，再发起返工');
      const affected=this.dependentTasks(r,[task.id]);
      if(task===r.planner){r.tasks=[];r.delivery=undefined;r.status='planning';if(r.workflow)r.workflow.error=undefined;}
      else if(task===r.delivery){r.status='delivery';}
      else{r.delivery=undefined;r.status='executing';}
      for(const t of this.allTasks(r))if(affected.has(t.id)){
        this.resetTask(t,t.id===task.id?feedback:'上游任务返工，请重新验证 / 生成交付。');
      }
      r.feedback=feedback;this.saveRun(r,`返工：${task.title}`,task);
    }else throw Error('当前状态不支持此操作');
    void this.tick();return this.run(r.id);
  }
  private chatBusy(r:StudioRun){return (r.chats??[]).some(c=>!c.resolved&&(!c.sessionId||['running','waiting'].includes(this.store.getSession(c.sessionId)?.status??'')||this.store.getSession(c.sessionId)?.pendingCount));}
  private groupPosts(runId:string):GroupPost[]{return this.store.db.prepare('SELECT json FROM studio_group_posts WHERE run_id=? ORDER BY at').all(runId).map(row=>JSON.parse(String(row.json)));}
  channels(runId:string){const r=this.run(runId);return studioChannels(r,this.project(r.projectId),this.store,this.groupPosts(r.id));}
  group(runId:string,before?:string){const r=this.run(runId);return groupPage(groupEntries(r,this.groupPosts(r.id),this.store,id=>STUDIO_ROLES.find(x=>x[0]===id)?.[1]??id,[...r.log.filter(l=>!l.id),...this.store.db.prepare('SELECT json FROM studio_group_records WHERE run_id=? ORDER BY at').all(r.id).map(row=>JSON.parse(String(row.json)))]),before);}
  async groupChat(v:any){const job=this.groupAction(v);this.launches.add(job);try{return await job;}finally{this.launches.delete(job);}}
  private async groupAction(v:any){
    const r=this.run(v.runId),p=this.project(r.projectId),execution=this.execution(r);
    if(r.status==='cancelled')throw Error('此需求已取消');
    if(typeof v.id!=='string'||!uploadId.test(v.id)||!Array.isArray(v.roles)||v.roles.length>13||new Set(v.roles).size!==v.roles.length||v.roles.some((role:string)=>!p.roles.some(a=>a.role===role&&a.enabled)))throw Error('请选择该团队中已启用的接收角色');
    const body=text(v.text??'',12000,'群消息',true);if(!body&&!v.attachmentIds?.length)throw Error('请输入群消息或添加附件');
    if(v.attachmentIds!==undefined&&(!Array.isArray(v.attachmentIds)||!v.attachmentIds.every((id:unknown)=>typeof id==='string'&&uploadId.test(id))))throw Error('无效群消息附件');
    const scope=p.hostId+'|project:'+execution.id,refs=this.files?.refs(scope,v.attachmentIds??[])??[];if(v.attachmentIds?.length&&!this.files)throw Error('附件服务未启用');
    const old=this.store.db.prepare('SELECT json FROM studio_group_posts WHERE id=?').get(v.id);
    if(old){const post:GroupPost=JSON.parse(String(old.json));if(post.runId!==r.id||post.text!==body||JSON.stringify(post.roles)!==JSON.stringify(v.roles)||JSON.stringify(post.files.map(f=>f.id))!==JSON.stringify(refs.map(f=>f.id)))throw Error('群消息 ID 已用于其他内容');return {post};}
    const post:GroupPost={id:v.id,runId:r.id,at:Date.now(),text:body,roles:v.roles,files:refs,deliveries:v.roles.map((role:string)=>({role,actionId:randomUUID(),status:'pending'}))};
    for(const file of refs)this.files?.link(scope,'studio:'+r.id,file.id);
    const save=()=>{this.store.db.prepare('INSERT OR REPLACE INTO studio_group_posts VALUES(?,?,?,?)').run(post.id,post.runId,post.at,JSON.stringify(post));this.changed();};save();
    // A persisted pending/unconfirmed delivery is never retried automatically.
    for(const delivery of post.deliveries){
      try{
        const latest=this.run(r.id);if(latest.status==='cancelled')throw Error('需求已取消，尚未投递');
        const active=this.allTasks(latest).find(t=>t.role===delivery.role&&['starting','running'].includes(t.status)),discussion=(latest.chats??[]).filter(c=>c.role===delivery.role&&c.sessionId&&(latest.status!=='accepted'||c.afterDelivery)).at(-1),sessionId=active?.sessionId??discussion?.sessionId;
        if(active&&!active.sessionId)throw Error('该职能任务正在启动，消息已留在群里；请核对会话后继续引导');
        if(sessionId)for(const file of refs)this.files?.link(scope,p.hostId+'|'+sessionId,file.id);
        const shared=this.group(r.id).messages.slice(-16).map(m=>`${m.role}${m.taskId?' ['+m.taskId+']':''}: ${m.text.slice(0,1000)}`).join('\n').slice(-7000);
        const result=await this.chatAction({id:delivery.actionId,runId:r.id,role:delivery.role,sessionId,text:body,attachmentIds:refs.map(f=>f.id)},'这是制作人通过团队群聊发来的消息。请在当前职责范围内回应，明确正在处理的任务、上游交付、需要其他职能配合的事项。不要假装其他角色已经发言或完成工作。\n共享群聊上下文：\n'+shared+'\n\n制作人本条消息：\n');
        delivery.status='sent';delivery.sessionId=result.sessionId;
      }catch(e){delivery.status='unconfirmed';delivery.error=(e as Error).message;}save();
    }
    return {post};
  }
  async chat(v:any){const job=this.chatAction(v);this.launches.add(job);try{return await job;}finally{this.launches.delete(job);}}
  private async chatAction(v:any,groupContext=''){
    const r=this.run(v.runId),p=this.project(r.projectId),execution=this.execution(r),a=p.roles.find(a=>a.role===v.role&&a.enabled);
    if(!a||r.status==='cancelled')throw Error('此需求或职能已停止接收消息');
    if(!this.online(p.hostId))throw Error('工作电脑离线');
    if(typeof v.id!=='string'||!uploadId.test(v.id))throw Error('无效消息 ID');
    const body=text(v.text??'',12000,'消息',true);if(!body&&!v.attachmentIds?.length)throw Error('请输入消息或添加附件');
    if(v.attachmentIds!==undefined&&(!Array.isArray(v.attachmentIds)||!v.attachmentIds.every((id:unknown)=>typeof id==='string'&&uploadId.test(id))))throw Error('无效消息附件');
    const sessions=[...this.allTasks(r).filter(t=>t.role===v.role).flatMap(t=>t.sessionId?[t.sessionId]:[]),...(r.chats??[]).filter(c=>c.role===v.role).flatMap(c=>c.sessionId?[c.sessionId]:[])];
    if(v.sessionId&&!sessions.includes(v.sessionId))throw Error('会话不属于该需求的职能');
    if(!v.sessionId&&this.allTasks(r).some(t=>t.role===v.role&&['starting','running'].includes(t.status)))throw Error('职能任务正在启动或执行，请刷新后选择当前会话发送');
    if(!v.sessionId&&(r.chats??[]).some(c=>c.role===v.role&&!c.sessionId&&!c.resolved&&c.actionId!==v.id))throw Error('该角色的会话启动结果未确认，请先核对执行记录');
    const scope=p.hostId+'|'+(v.sessionId??'project:'+execution.id),refs=this.files?.refs(scope,v.attachmentIds??[])??[];
    if(v.attachmentIds?.length&&!this.files)throw Error('附件服务未启用');
    validateAssignment(a,this.store.hosts().find(h=>h.id===p.hostId)!);
    const afterDelivery=r.status==='accepted',sourceTask=this.allTasks(r).find(t=>t.sessionId===v.sessionId&&v.sessionId);
    // Completed production remains an immutable reference. A follow-up gets its
    // own discussion writer instead of reopening the accepted task or its QA.
    const targetSessionId=afterDelivery&&v.sessionId&&!(r.chats??[]).some(c=>c.sessionId===v.sessionId&&c.afterDelivery)?undefined:v.sessionId;
    if(!targetSessionId&&(r.chats??[]).some(c=>c.role===v.role&&!c.sessionId&&!c.resolved&&c.actionId!==v.id))throw Error('该角色的会话启动结果未确认，请先核对执行记录');
    const task=afterDelivery?undefined:sourceTask;
    if(task&&!['starting','running'].includes(task.status)&&this.allTasks(r).some(t=>t!==task&&['starting','running'].includes(t.status)))throw Error('其他制作任务正在进行。请向当前执行的任务引导，或待本轮结束后对该职能补充，系统将重新验证后续任务');
    if(task&&!this.dependenciesReady(r,task))throw Error('该任务的前置环节或本轮视觉确认尚未完成，不能通过聊天提前执行');
    const sharedTools=p.toolchain?'\n团队共享工具环境（工作电脑上的路径，纯讨论不运行无关 DCC）：'+JSON.stringify(p.toolchain)+'\n':'';
    const playtestGuidance=`\n本机试玩与启动约定：当前需求 worktree 绝对路径：${execution.path}；独立分支：${r.workspace!.value!.branch}。用户问路径或怎么启动时，直接返回该 worktree、实际项目目录、已核实的场景入口/启动脚本/EXE，以及可复制的 Windows PowerShell 启动命令（含工作目录与必要参数），不能只说去找交付文档。用户明确要求“启动这个场景”“运行游戏”“打开试玩”时，可以直接调用本机工具启动已经存在的本需求场景或程序；这属于已授权的本机预览，不是修改制作成果。先读取交付说明、脚本和必要配置，核对实际新场景、指定引擎版本及路径；禁止切换源工程或把旧入口、其他需求、旧场景当成本次成果。若本次只有原画/模型或缺少可运行入口，如实说明并给出已有资产的预览方式，不编造启动命令、不自动补做场景。运行前核对相同 worktree/入口是否已有进程，避免重复启动；启动结果未知时先查 PID 和日志，不重复拉起。Windows 游戏窗口应可见，命令和日志不要遮挡用户。启动后报告真实命令、worktree、场景、PID、日志路径和实际就绪/失败证据；仅有进程不代表加载成功。允许必要的缓存和日志写在本需求工作副本，不改源码、正式资产、已确认配置或批准记录，不重新宣称 QA 通过；改动需要另行制作。\n`;
    const deliveryContext=afterDelivery?'\n这是已交付需求的后续讨论与本机试玩。回答制作人的追问，不修改工程源文件、已完成任务或验收记录，不重新输出制作结果或重新执行生产。明确要求的本机启动按下述试玩约定执行，不因“只读讨论”拒绝运行现有成果。需要改动时建议发起新制作需求。区分素材预览、真实游戏入口与目标设备实测，不将旧场景或展示视频当成新关卡已可玩。\n所选流程与实际交付：'+JSON.stringify({workflow:r.workflow?.selection,sourceTask:sourceTask?{id:sourceTask.id,title:sourceTask.title,summary:sourceTask.summary}:undefined,delivery:r.delivery?.summary,tasks:r.tasks.map(t=>({id:t.id,title:t.title,stage:t.stage,summary:t.summary?.slice(0,500),artifacts:t.artifacts?.slice(0,5)}))}).slice(0,6000):'';
    const instruction=(task?'\n这是制作人对本任务的补充。按补充继续制作，完成后重新输出原要求的 '+(task===r.planner?'STUDIO_PLAN':'STUDIO_RESULT')+' 结构化代码块；验收必须基于补充后的实际结果。':'')+sharedTools+deliveryContext+playtestGuidance;
    groupContext=groupContext.slice(0,Math.max(0,MAX_TEXT-body.length-r.brief.length-a.instructions.length-a.tools.length-sharedTools.length-deliveryContext.length-playtestGuidance.length-1500));
    const action:Action=targetSessionId?{id:v.id,type:'send',sessionId:targetSessionId,text:groupContext+(body||'请查看附件。')+instruction,attachmentIds:refs.map(f=>f.id)}:{id:v.id,type:'start',projectId:execution.id,workspaceIndex:0,provider:a.provider,agentId:a.agentId,model:a.model,effort:a.effort,permissionMode:afterDelivery?'request':p.permissionMode,text:`你是游戏团队的${STUDIO_ROLES.find(x=>x[0]===v.role)![1]}，与制作人直接对话。需求：${r.title}\n${r.brief}\n独立分支：${r.workspace!.value!.branch}\n工作目录：${execution.path}\n职责：${a.instructions}\n工具：${a.tools}${sharedTools}${deliveryContext}${playtestGuidance}\n默认只读讨论，不修改工程源文件；用户明确要求的本机启动可以按上述约定执行。制作人要求改动时，请说明${afterDelivery?'需要发起新的制作需求':'需要在对应制作任务会话中提出'}，以便后续 QA 重新验证。保护已有修改，遵循工程约定，不切换源工程或主干，不提交、推送或发布。视频或其他文件使用本机工具读取，无法读取须说明。\n制作人：${groupContext}${body||'请查看附件。'}`,attachmentIds:refs.map(f=>f.id)};
    const prior=this.store.beginAction(action.id,p.hostId,action);if(!prior.fresh){if(prior.result)return prior.result;throw Error('消息已接受，结果未确认；请核对聊天记录，不会重复发送');}
    if(task&&!['starting','running'].includes(task.status)){
      const affected=this.dependentTasks(r,[task.id]);
      for(const t of this.allTasks(r))if(affected.has(t.id)&&t!==task)this.resetTask(t,'上游收到制作人补充，重新验证；视觉确认需重新进行');
      task.status='running';task.skip=undefined;task.startedAt=Date.now();task.error=undefined;
      if(task===r.planner){r.tasks=[];r.delivery=undefined;r.status='planning';}else if(task===r.delivery)r.status='delivery';else{r.delivery=undefined;r.status='executing';}this.saveRun(r,'制作人补充已完成任务，重新验证后续交付',task);
    }
    if(!targetSessionId){for(const file of refs)this.files?.link(scope,p.hostId+'|project:'+execution.id,file.id);r.chats??=[];r.chats.push({role:v.role,actionId:v.id,startedAt:Date.now(),...afterDelivery?{afterDelivery:true,sourceSessionId:v.sessionId}:{}});this.saveRun(r,(afterDelivery?'开启交付后讨论：':'开启角色对话：')+STUDIO_ROLES.find(x=>x[0]===v.role)![1]);}
    try{
      if(!targetSessionId&&v.sessionId)for(const file of refs){
        // The browser uploaded against the selected old session. Register those
        // same user files in the workstation's new-discussion project scope too.
        const payload=this.files!.read(scope,file.id),uploaded=await this.remote(p.hostId,{id:randomUUID(),type:'upload',projectId:execution.id,upload:{scope:p.hostId+'|project:'+execution.id,file:payload.file,data:payload.bytes.toString('base64')}});
        if(uploaded.file?.id!==file.id||uploaded.file?.sha256!==file.sha256)throw Error('附件转入交付后讨论未确认，请核对后再继续');
      }
      const result=await this.remote(p.hostId,action);this.store.finishAction(action.id,result);const latest=this.run(r.id),sessionId=targetSessionId??result.sessionId;
      if(typeof sessionId!=='string')throw Error('Agent 未返回会话 ID，请核对执行记录');
      for(const f of refs)this.files?.link(scope,p.hostId+'|project:'+execution.id,f.id);
      if(!targetSessionId){const c=latest.chats!.find(c=>c.actionId===v.id)!;c.sessionId=sessionId;for(const f of refs)this.files?.link(scope,p.hostId+'|'+sessionId,f.id);}
      latest.guidance??=[];latest.guidance.push({id:v.id,role:v.role,text:body,files:refs,at:Date.now(),sessionId});latest.guidance=latest.guidance.slice(-100);this.saveRun(latest,'制作人补充：'+STUDIO_ROLES.find(x=>x[0]===v.role)![1]);
      if(latest.status==='cancelled')await this.remote(p.hostId,{id:randomUUID(),type:'stop',sessionId});
      return {...result,sessionId};
    }catch(e){const latest=this.run(r.id),c=latest.chats?.find(c=>c.actionId===v.id);if(c){c.error=(e as Error).message;this.saveRun(latest,'角色会话启动未确认');}throw e;}
  }
  private async upgradeScene(r:StudioRun,p:StudioProject){
    if(r.workflow?.kind!=='scene')throw Error('此需求不是场景制作流程');if(r.workflow.version===2)return r;if(!this.online(p.hostId))throw Error('工作电脑离线，尚未更新');
    const workflow={...r.workflow,error:undefined},tasks=upgradeScenePlan(r.tasks,workflow,p.roles),gate=tasks.find(t=>t.kind==='visual-review');
    const stopping=gate?.status==='done'?[]:tasks.filter(t=>(['starting','running'].includes(t.status)||t.status==='blocked'&&t.sessionId&&this.store.getSession(t.sessionId)?.status==='interrupted')&&['balance','implementation','asset-spec','assets','assembly','integration','validation'].includes(t.stage??''));
    if(stopping.some(t=>!t.sessionId))throw Error('任务正在启动，结果尚未确认，请待会话出现后再更新流程');
    r.paused=true;this.saveRun(r,'开始更新场景流程，保留工作副本与全部已产出文件');
    try{
      for(const t of stopping){
        const live=this.store.getSession(t.sessionId!);if(live?.status==='idle'){this.complete(r,r.tasks.find(x=>x.id===t.id)!);const done=r.tasks.find(x=>x.id===t.id)!;if(done.status==='done'){Object.assign(t,done,{stage:t.stage,dependencies:t.dependencies});continue;}}
        if(!live||['running','waiting','history'].includes(live.status)){
          const old=r.tasks.find(x=>x.id===t.id)!;let result:any;if(old.flowStopId){result=this.receipt(old.flowStopId);if(!result?.ok)throw Error('上次暂存停止结果未确认，请先核对原会话；不会重复发送停止');}
          else{old.flowStopId=randomUUID();this.saveRun(r,'暂存原画确认前提前运行的任务，保留原会话',old);const action:Action={id:old.flowStopId,type:'stop',sessionId:old.sessionId};this.store.beginAction(action.id,p.hostId,action);try{result=await this.remote(p.hostId,action);this.store.finishAction(action.id,result);}catch(e){this.store.finishAction(action.id,{error:(e as Error).message});throw e;}}
          if(!result?.ok)throw Error('工作电脑未确认暂存任务');
        }
        t.resumeSessionId=t.sessionId;t.status='queued';t.actionId=undefined;t.error=undefined;t.finishedAt=undefined;t.feedback='制作流程调整：等待制作人确认原画后，继续原会话与同一份工程实现；保留此前修改，不另做一套。';
      }
      if(gate?.status!=='done')for(const t of tasks)if(['balance','implementation'].includes(t.stage??'')&&t.status==='done'){
        t.resumeSessionId=t.sessionId;t.status='queued';t.actionId=undefined;t.finishedAt=undefined;t.feedback='已有成果保留。待制作人确认原画后，在原会话复核并按视觉方向调整；复用原实现和配置，不另做一套。';
      }
      const latest=this.run(r.id);if(latest.status==='cancelled')throw Error('需求已取消');const restorePaused=latest.workflow?.upgradeRestorePaused??workflow.upgradeRestorePaused??false;latest.tasks=tasks;latest.workflow=workflow;latest.workflow.version=2;latest.workflow.error=undefined;latest.paused=restorePaused;delete latest.workflow.upgradeRestorePaused;
      this.saveRun(latest,'已更新：玩法与 LD 设计 → 原画 → 制作人确认 → 数值与程序制作；已有成果保留，暂存任务在原会话续做');return latest;
    }catch(e){const latest=this.run(r.id);latest.paused=true;if(latest.workflow)latest.workflow.error='更新场景流程未完成：'+(e as Error).message;this.saveRun(latest,latest.workflow?.error);throw e;}
  }
  private prepare(r:StudioRun,p:StudioProject){
    r.workspace={status:'preparing',actionId:randomUUID()};this.saveRun(r,'准备独立 Git 分支与工作副本');
    const action:Action={id:r.workspace.actionId!,type:'prepare-workspace',includeCaptures:p.includeCaptures===true,workspaceId:r.id,projectId:p.projectId,workspaceIndex:p.workspaceIndex,attachmentIds:(r.attachments??[]).map(f=>f.id)};
    const job=(async()=>{try{
      this.store.beginAction(action.id,p.hostId,action);const result=await this.remote(p.hostId,action,1800000);this.store.finishAction(action.id,result);
      if(result?.workspace?.runId!==r.id||result.workspace.branch!=='codex/studio-'+r.id||result.workspace.project?.id!=='studio-'+r.id)throw Error('工作电脑未确认隔离工作副本');
      const latest=this.run(r.id);latest.workspace={status:'ready',value:result.workspace};for(const f of latest.attachments??[])this.files?.link(p.hostId+'|project:'+p.projectId,p.hostId+'|project:'+result.workspace.project.id,f.id);this.saveRun(latest,'独立分支已就绪：'+result.workspace.branch);
    }catch(e){const latest=this.run(r.id);latest.workspace={status:'blocked',error:(e as Error).message};this.saveRun(latest,'工作副本准备失败，已停止分发');}})();this.launches.add(job);void job.finally(()=>this.launches.delete(job));
  }
  private prompt(r:StudioRun,t:Task,p:StudioProject){
    const a=p.roles.find(a=>a.role===t.role)!,role=STUDIO_ROLES.find(x=>x[0]===t.role)!;
    const contextNotes=`独立需求分支：${r.workspace!.value!.branch}\n当前工作副本：${this.execution(r).path}。源工程 ${r.workspace!.value!.sourcePath} 只用于识别，不在源目录执行或修改文件。任务说明中若提到源工程绝对路径，必须映射到当前工作副本；引擎子模块也使用副本内的 engine 目录。禁止切换或修改源工程 / 主干。\n制作人参考附件：${(r.attachments??[]).map(f=>f.name).join('、')||'无'}。图片随输入提供；视频和其他文件通过输入附带的本机路径读取，视频可用已有工具抽帧；工具不可用时明确报告，不能声称已经观看。\n团队群聊补充：\n${this.groupPosts(r.id).slice(-8).map(m=>'制作人 @'+m.roles.join(',')+': '+m.text+' [附件 '+m.files.map(f=>f.name).join(',')+']').join('\n').slice(-2500)}\n后续制作人补充：\n${(r.guidance??[]).slice(-12).map(g=>g.role+': '+g.text+' [附件 '+g.files.map(f=>f.name).join(',')+']').join('\n').slice(r.workflow?.kind==='scene'?-3000:-5000)}\n`;
    const resumeNote=t.resumeSessionId?['继续同一个任务、同一份工程与已有实现，从原代码续做，不另起一套玩法。先检查原会话记录、已有文件与验证结果，从未完成的步骤继续；不得重跑已完成的前置任务，也不得跳过制作人审批。','断点前的公开执行记录（可能不完整，须核对工程）：',(t.output??'').slice(-5000),''].join('\n'):'';
    const common=`${resumeNote}${contextNotes}${toolchainInstructions(p.toolchain,this.execution(r).path,r.workspace!.value!.sourcePath)}${sceneTaskInstructions(t,r.workflow)}【${role[1]}】${r.title} / ${t.title}\n你是游戏团队的${role[1]}。制作人需求：\n${r.title}\n${t.resumeSessionId?'制作人原始需求沿用本会话开头的完整说明；结合以下最新补充与已有工程续做。':r.brief}\n\n职能职责：${role[2]}\n补充说明：${a.instructions||'无'}\n本机工具 / 引擎 / DCC：${a.tools||'自行检查工程和已有工具；工具缺失必须报告，不得虚构生成或验收结果。'}\n工具在工作电脑后台执行。遵循工程约定，保护已有修改，不提交、推送或发布，除非制作人明确要求。所有职能共享当前工程；并发时只修改分配给自己的文件，发现冲突立即报告 blocked。将可持久化交付物保存到工程内，文档优先 .studio/${r.id}/${t.id}/，实际游戏资源遵循工程目录。\n${r.feedback?'制作人本轮返工意见（按本任务相关项执行，优先于旧任务说明中的冲突限制）：'+r.feedback+'\n':''}${t.feedback?'返工要求：'+t.feedback+'\n':''}`;
    const scenePlan=r.workflow?.selection?productionFlowInstructions(r.workflow.selection):r.workflow?.kind==='scene'?`场景生产流程为强制约束：玩法与 LD 设计 requirements → 原画 concept → 制作人确认（系统节点）→ 资产规格 asset-spec → ${r.workflow.assetMode==='new'?'资产生产 assets → ':''}LA 正式搭建 assembly → 布光效果与程序集成 integration → QA。玩法策划与 LD 必须先完成 requirements 设计文档和布局，原画依赖这两项；不安排独立玩法原型制作。制作人确认后再做数值 balance 和程序 implementation；玩法实现统一交给程序，复用现有代码，只做一套。最终 integration 只接入和验证已有实现，不重复开发。每个任务明确 stage。角色匹配：requirements 玩法/LD/系统；balance 数值；implementation 程序；concept 原画；asset-spec 原画/模型/技术美术；assets 模型；assembly 场景美术；integration 程序/技术美术/UI/音频。原画至少交付一张实际存在的 PNG/JPEG/WebP/GIF 工程内图片供制作人查看；工具缺失必须 blocked，禁止用文字假装产图。不要输出人工确认任务，系统自动插入；系统会补齐缺失的必要制作阶段并校验依赖。${r.workflow.assetMode==='reuse'?'制作人指定复用范围：'+r.workflow.reuseReason+'，只核对已有视觉、编资产清单和搭建，不安排新资产生产。':'这次需要新场景 / 新资产，不能自行以复用为由跳过原画、确认与资产生产。'}\n`:'通用任务仅做代码、配置或讨论；涉及正式场景或美术资产生产时需要场景流程。\n';
    const exampleStage=r.workflow?.selection?.stages[0]??'requirements',exampleRole=r.workflow?.selection?productionRoleIds({...r.workflow.selection,stages:[r.workflow.selection.stages[0]]}).find(id=>p.roles.some(a=>a.enabled&&a.role===id)):'gameplay';
    if(t.id==='studio-plan')return `${common}${scenePlan}\n你现在只做只读分析和任务规划，不改动工程。${r.recordVideo?'系统会在制作末尾安排成果展示视频，不要重复输出录制任务。':''}可用职能：${p.roles.filter(a=>a.enabled&&a.role!=='director'&&(!r.workflow?.selection||productionRoleIds(r.workflow.selection).includes(a.role))).map(a=>a.role+' ('+STUDIO_ROLES.find(r=>r[0]===a.role)![1]+')').join(', ')}。按需求选择必要职能，不要为了凑人数安排无关工作。把文件责任写入 brief；同文件写入必须有依赖。${r.workflow?.selection?(r.workflow.selection.stages.includes('validation')?'QA 只安排在选定的 validation 阶段，不重复追加。':'制作人未选 QA，不安排或追加 QA 任务。'):'系统会追加最终独立 QA 任务。'}最后只输出一个 JSON 代码块：\n\`\`\`STUDIO_PLAN\n${JSON.stringify({tasks:[{id:"task-1",title:"任务名",role:exampleRole,stage:exampleStage,brief:"具体工作与文件责任",acceptance:"可检查的验收标准",dependencies:[]}]})}\n\`\`\``;
    const upstream=t===r.delivery?r.tasks:r.tasks.filter(x=>t.dependencies.includes(x.id));
    const taskIntro=`\n任务：${t.title}\n${t.brief}\n验收标准：${t.acceptance}\n上游交付：\n`;
    const waivers=r.tasks.filter(x=>x.status==='skipped').map(x=>({id:x.id,title:x.title,...x.skip}));
    const waiverNote=waivers.length?'\n制作人跳过记录（仅允许继续流程，不代表验收通过）：\n'+JSON.stringify(waivers).slice(0,6000)+'\n记录较长时请从各上游任务交付文件补齐原证据。继续执行本任务可完成的检查，不要重复返工已跳过的上游；逐项核对原阻断，区分仍存在、已解决和未验证。QA 按本次真实实测判定，仍失败则 blocked，不得伪造通过；交付报告必须单独列出跳过原因、原失败证据及遗留风险。\n':'';
    const suffix=`${waiverNote}\n${t===r.delivery?'只读整合最终交付报告，包含入口、成果、实际验证和已知限制，不再改工程。':''}\n上游上下文有长度限制；如有截断，请从工程中的交付文件补充核对，不能据此假设验证通过。\n最后输出 JSON 代码块，summary 可详细说明。outcome 只有实际完成才能 done；失败、缺少工具或 QA 不通过均为 blocked。artifacts 只列实际存在的工程文件路径，checks 只列实际执行及其结果。outcome=blocked 时同时给出 blockers（category、code、details、remedy），标清真实阻断证据和恢复方法。\n\`\`\`STUDIO_RESULT\n{"outcome":"done","summary":"交付摘要","artifacts":[{"path":"工程内文件路径","description":"用途"}],"checks":["实际验证与结果"]}\n\`\`\``;
    const prefix=common.slice(0,Math.max(0,MAX_TEXT-suffix.length-taskIntro.length))+taskIntro;
    const currentWork=r.tasks.filter(x=>x.status==='done'&&!upstream.includes(x)&&x.id!==t.id).sort((a,b)=>Number(['implementation','integration'].includes(b.stage??''))-Number(['implementation','integration'].includes(a.stage??''))||(b.finishedAt??0)-(a.finishedAt??0)).map(x=>({id:x.id,title:x.title,stage:x.stage,finishedAt:x.finishedAt,summary:x.summary?.slice(0,200),artifacts:x.artifacts?.slice(0,4)}));
    const context='当前工作副本其他已完成任务（用于核对最新上游合法改动，不扩大本任务文件权限）：\n'+JSON.stringify(currentWork).slice(0,3000)+'\n直接依赖交付：\n'+upstream.map(x=>JSON.stringify({id:x.id,title:x.title,status:x.status,skip:x.skip,blockers:x.blockers,summary:x.summary,artifacts:x.artifacts,checks:x.checks})).join('\n');
    return prefix+context.slice(0,Math.max(0,Math.min(11000,MAX_TEXT-prefix.length-suffix.length)))+suffix;
  }
  private launch(r:StudioRun,t:Task,p:StudioProject){
    if(t.kind||!this.dependenciesReady(r,t))return;
    const a=p.roles.find(a=>a.role===t.role)!;
    try{const host=this.store.hosts().find(h=>h.id===p.hostId);if(!host)throw Error('工作电脑不存在');validateAssignment(a,host);}catch(e){t.status='blocked';t.error=(e as Error).message;this.saveRun(r,t.error,t);return;}
    t.status='starting';t.actionId=randomUUID();t.startedAt=Date.now();this.saveRun(r,'分发：'+t.title,t);
    const action:Action={id:t.actionId,type:t.resumeSessionId?'send':'start',sessionId:t.resumeSessionId,projectId:this.execution(r).id,workspaceIndex:0,attachmentIds:this.inputRefs(r).map(f=>f.id),provider:a.provider,agentId:a.agentId,model:a.model,effort:a.effort,permissionMode:t.resumeSessionId?undefined:p.permissionMode,text:this.prompt(r,t,p)};
    const job=(async()=>{
      try{
        if(r.workflow?.kind==='scene'&&(!r.workflow.selection||r.workflow.selection.approvals.visual)&&['balance','implementation','asset-spec','assets','assembly','integration','validation'].includes(t.stage??'')){
          const gate=r.tasks.find(g=>g.kind==='visual-review')!;
          if(!this.inspectVisual)throw Error('无法核对本轮已确认原画，请升级工作电脑连接程序');
          for(const snapshot of gate.visualSnapshots??[]){const concept=r.tasks.find(c=>c.id===snapshot.taskId)!;const current=await this.inspectVisual(p.hostId,concept.sessionId!,snapshot.path);if(current.sha256!==snapshot.sha256)throw Error('已确认原画文件发生变化，请对原画任务返工并重新确认，尚未启动本任务');}
          const latest=this.run(r.id),current=this.allTasks(latest).find(x=>x.id===t.id);if(latest.paused||latest.status==='cancelled'||current?.actionId!==action.id||!this.dependenciesReady(latest,current)){if(current?.actionId===action.id){current.status=latest.status==='cancelled'?'cancelled':'queued';current.actionId=undefined;this.saveRun(latest,'原画核对期间分发状态变化，尚未启动任务',current);}return;}
        }
        if(t.resumeSessionId)await this.resumeAttachments(r,t.resumeSessionId);
        this.store.beginAction(action.id,p.hostId,action);const result=await this.remote(p.hostId,action);this.store.finishAction(action.id,result);
        if(typeof result?.sessionId!=='string')throw Error('Agent 未返回会话 ID；请核对执行记录后重试');
        const latest=this.run(r.id),current=this.allTasks(latest).find(x=>x.id===t.id);if(!current||current.actionId!==action.id)return;
        this.linkAttachments(latest,result.sessionId);current.sessionId=result.sessionId;current.resumeSessionId=undefined;current.checkpoint=undefined;current.status='running';this.saveRun(latest,'已启动：'+t.title,current);
        if(latest.status==='cancelled'){await this.remote(p.hostId,{id:randomUUID(),type:'stop',sessionId:result.sessionId});const cancelled=this.run(r.id),stopped=this.allTasks(cancelled).find(x=>x.id===t.id);if(stopped){stopped.status='cancelled';this.saveRun(cancelled,'已停止取消期间启动的任务',stopped);}}
      }catch(e){const latest=this.run(r.id),current=this.allTasks(latest).find(x=>x.id===t.id);if(current&&current.actionId===action.id){current.status='blocked';current.error=(e as Error).message;this.saveRun(latest,'任务分发未确认：'+t.title,current);}}
    })();this.launches.add(job);void job.finally(()=>this.launches.delete(job));
  }
  private complete(r:StudioRun,t:Task){
    const s=t.sessionId&&this.store.getSession(t.sessionId);if(!s||s.pendingCount||['running','waiting','history'].includes(s.status))return;
    if(['interrupted','failed'].includes(s.status)&&this.checkpoint(r,t))return;
    if(s.status!=='idle'){t.status='blocked';t.error='Agent '+(s.status==='failed'?'执行失败':'执行已停止')+'，请查看记录';return;}
    const output=this.taskOutput(t);t.output=output;t.finishedAt=Date.now();
    try{
      if(t===r.planner){r.tasks=parseStudioPlan(output,this.project(r.projectId).roles,r.workflow);if(r.recordVideo)r.tasks=withShowcase(r.tasks);if(r.workflow)r.workflow.error=undefined;t.summary='已拆解 '+r.tasks.length+' 个任务'+(r.tasks.some(x=>x.role==='qa')?'（含 QA）':'（未安排 QA）');r.status=(r.workflow?.selection?.approvals.plan??this.project(r.projectId).reviewPlan)?'plan-review':'executing';}
      else{const value=structured(output,'result');if(!['done','blocked'].includes(value.outcome))throw Error('交付 outcome 必须为 done 或 blocked');
        t.summary=text(value.summary,16000,'交付摘要');t.blockers=validateBlockers(value.blockers);if(value.outcome==='done'&&t.blockers.length)throw Error('仍有硬阻断，不能声明完成');
        if(!Array.isArray(value.artifacts)||value.artifacts.length>80||!Array.isArray(value.checks)||value.checks.length>80)throw Error('交付物或验证记录格式无效');
        t.artifacts=value.artifacts.map((v:any)=>({path:text(v.path,2000,'交付路径'),description:text(v.description,2000,'交付说明',true)}));t.checks=value.checks.map((c:unknown)=>text(c,2000,'验证记录'));
        if(value.outcome==='blocked')throw Error(t.summary);
        if(t.stage==='concept'&&!t.showcase&&!t.artifacts?.some(a=>visualPath(a.path)))throw Error('原画阶段必须交付可查看的实际图片，文字说明不能替代原画');
        if(t.showcase&&(!t.artifacts?.some(a=>videoPath(a.path))||!t.checks?.length))throw Error('展示任务必须交付视频文件和实际播放验证');
        if(t.role==='qa'&&!t.checks?.length)throw Error('QA 未提供实际验证记录，不能进入交付');
        if(t===r.delivery){if(r.workflow?.selection&&!r.workflow.selection.approvals.final){r.status='accepted';r.autoAccepted=true;}else r.status='review';}
      }t.status='done';t.error=undefined;
    }catch(e){
      t.status='blocked';t.error=(e as Error).message;
      // A completed, acknowledged planner turn may correct its invalid scope.
      // This never retries an uncertain dispatch or runs an invalid production plan.
      const p=this.project(r.projectId),receipt=t.actionId?this.store.db.prepare('SELECT result FROM actions WHERE id=?').get(t.actionId):undefined;
      if(t===r.planner&&e instanceof ProductionPlanError&&(t.planRepairs??0)<2&&!r.paused&&s.hostId===p.hostId&&s.projectId===this.execution(r).id&&receipt?.result&&!JSON.parse(String(receipt.result)).error&&!this.chatBusy(r)){
        t.planRepairs=(t.planRepairs??0)+1;
        t.attempts=[...(t.attempts??[]),{sessionId:t.sessionId,output:t.output,at:Date.now()}];
        t.feedback='计划范围校验未通过（第 '+t.planRepairs+'/2 次修正）：'+t.error+'\n沿用已完成的工程分析，只修正完整 STUDIO_PLAN；删掉未选阶段的任务并修正依赖。不要重新读取全部参考，不执行制作、不修改工程，不改变制作人流程或审批设置。';
        t.resumeSessionId=t.sessionId;t.status='queued';t.actionId=undefined;t.finishedAt=undefined;t.error=undefined;
        this.saveRun(r,'已退回统筹原会话修正计划范围（'+t.planRepairs+'/2）：'+(e as Error).message,t);
      }
    }
  }
  async tick(){
    if(this.closed||this.ticking)return;this.ticking=true;
    try{
      const active=this.runs().filter(r=>!['accepted','cancelled'].includes(r.status));
      // A workspace has one writing lane by default, including across team configurations.
      const busy=new Map<string,number>();
      for(const r of active){const p=this.project(r.projectId),key=r.id;busy.set(key,this.allTasks(r).filter(t=>['starting','running'].includes(t.status)).length+(r.chats??[]).filter(c=>!c.sessionId&&!c.error||c.sessionId&&['running','waiting'].includes(this.store.getSession(c.sessionId)?.status??'')).length);}
      for(const r of active){
        const p=this.project(r.projectId);if(!this.online(p.hostId)||this.flowUpgrades.has(r.id))continue;const key=r.id;
        if(r.workspace?.status!=='ready'){if(r.workspace?.status==='queued'&&!r.paused)this.prepare(r,p);continue;}
        for(const t of this.allTasks(r))if(t.status==='blocked'&&this.checkpoint(r,t))this.saveRun(r,'已保留执行断点：'+t.title,t);
        for(const t of this.allTasks(r))if(t.status==='running'){this.complete(r,t);if(t.status!=='running'){busy.set(key,Math.max(0,(busy.get(key)??1)-1));this.saveRun(r,(t.status==='done'?'完成：':'待处理：')+t.title,t);}}
        if(r.paused||r.workflow?.error)continue;
        if((r.chats??[]).some(c=>!c.sessionId&&!c.resolved))continue;
        if(r.status==='executing'&&r.tasks.length&&r.tasks.every(released)){r.status='delivery';const priorDelivery=r.delivery;r.delivery={attempts:priorDelivery?[...(priorDelivery.attempts??[]),{sessionId:priorDelivery.sessionId,output:priorDelivery.output,at:Date.now()}]:undefined,id:'studio-delivery',title:'汇总制作人交付包',role:'director',brief:'汇总所有实际交付物及验证结果，给制作人可直接使用的入口和验收步骤。',acceptance:'列出成果、启动 / 查看方法、验证结果及已知限制。',dependencies:[],status:'queued'};this.saveRun(r,r.tasks.some(t=>t.status==='skipped')?'QA 已结束，整理交付并披露制作人跳过记录':r.workflow?.selection&&!r.workflow.selection.stages.includes('validation')?'已选制作任务完成，整理交付（未安排 QA）':'QA 通过，整理最终交付');}
        const candidates=r.status==='planning'?[r.planner]:r.status==='executing'?r.tasks:r.status==='delivery'&&r.delivery?[r.delivery]:[];
        for(const t of candidates){if(!t.kind&&(busy.get(key)??0)>=p.concurrency)continue;if(t.status!=='queued'||!this.dependenciesReady(r,t))continue;
          if(t.kind==='producer-review'){t.status='awaiting-review';t.reviewId=randomUUID();this.saveRun(r,'等待制作人审批：'+t.title,t);continue;}
          if(t.kind==='visual-review'){try{visualReferences(r.tasks,t);t.status='awaiting-review';t.reviewId=randomUUID();this.saveRun(r,'原画完成，等待制作人确认本轮视觉方向',t);}catch(e){t.status='blocked';t.error=(e as Error).message;this.saveRun(r,t.error,t);}continue;}
          this.launch(r,t,p);if((t as Task).status==='starting')busy.set(key,(busy.get(key)??0)+1);
        }
      }
    }finally{this.ticking=false;}
  }
  async close(){this.closed=true;clearInterval(this.timer);await Promise.allSettled([...this.launches]);}
}
function validateAssignment(a:Assignment,host:Host){
  if(a.agentId!==undefined&&!/^[a-zA-Z0-9_-]{1,60}$/.test(a.agentId))throw Error('无效 Agent ID');
  if(a.model!==undefined&&(typeof a.model!=='string'||a.model.length>150||/[\r\n\x00]/.test(a.model)))throw Error('无效模型');
  if(a.effort!==undefined&&!['default','none','minimal','low','medium','high','xhigh','max','ultra'].includes(a.effort))throw Error('无效思考强度');
  if(!a.enabled)return;
  const agent=host.agents?.find(x=>x.provider===a.provider&&(a.provider!=='api'||x.id===a.agentId));
  if(host.agents&&(!agent||agent.configured===false))throw Error(`该电脑未配置 ${a.provider} Agent`);
  if(a.provider==='api'&&(!agent||!a.agentId||!agent.tools))throw Error('团队执行需要已启用工具的 API Agent');
}
