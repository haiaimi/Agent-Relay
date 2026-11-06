import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {archiveHash,validateArchive,repositoryId,type RequirementArchive,type RepositoryRequest,type PublicConversation} from '../shared/studio-repository.js';
import {STUDIO_ROLES,type Studio,type StudioRun,type StudioProject,type Task} from './studio.js';
import type {RelayStore} from './store.js';
import type {Action} from '../shared/protocol.js';
import {assertMainlineIdle} from './studio-mainline.js';

export interface RepositoryStatus {savedAt?:number;hash?:string;error?:string;attempts?:number;retryAt?:number;syncedAt?:number;commit?:string;indexCommit?:string;branch?:string;imported?:boolean;backupPath?:string;importHash?:string}
declare module './studio.js' {interface StudioRun {repository?:RepositoryStatus;repositoryBusy?:boolean;repositoryReadOnly?:boolean}}
const tasks=(r:StudioRun)=>[r.planner,...r.tasks,...r.delivery?[r.delivery]:[]];
export class StudioRepositories {
  private timer:NodeJS.Timeout;private running=false;private stopped=false;private seen=new Map<string,string>();private failures=new Map<string,{count:number;at:number}>();private jobs=new Map<string,Promise<any>>();private scanned=new Map<string,number>();
  constructor(private store:RelayStore,private studio:Studio,private remote:(h:string,a:Action,t?:number)=>Promise<any>,private changed:()=>void){
    store.db.exec('CREATE TABLE IF NOT EXISTS studio_repository_catalog(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS studio_repository_archives(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS studio_repository_jobs(id TEXT PRIMARY KEY,request TEXT NOT NULL,json TEXT NOT NULL)');
    for(const row of store.db.prepare('SELECT id,json FROM studio_repository_jobs').all()){const job=JSON.parse(String(row.json));if(job.phase==='running'){job.phase='failed';job.error='服务重启中断了同步核对，请重新检查远程记录；不会自动重复提交。';store.db.prepare('UPDATE studio_repository_jobs SET json=? WHERE id=?').run(JSON.stringify(job),row.id!);}}
    // No interrupted mutation is resent. The next user action re-reads both Git refs.
    for(const r of studio.runs())if(r.repositoryBusy){r.repositoryBusy=false;r.paused=true;r.repository={...r.repository,error:'上次同步中断，请检查本地与远程差异后再选择；没有自动重复推送。'};this.persist(r);}
    this.timer=setInterval(()=>void this.tick(),5000);this.timer.unref();
  }
  private persist(r:StudioRun){this.store.db.prepare('INSERT OR REPLACE INTO studio_runs VALUES(?,?)').run(r.id,JSON.stringify(r));this.changed();}
  private binding(r:StudioRun){return this.studio.projectForRun(r);}
  private supported(hostId:string){return this.store.hosts().find(h=>h.id===hostId&&h.online&&h.capabilities?.studioRepository);}
  private async call(hostId:string,projectId:string,repository:RepositoryRequest,workspaceIndex=0){if(!this.supported(hostId))throw Error('工作电脑需运行支持“仓库需求协议”的新版 Relay 连接程序');return this.remote(hostId,{id:randomUUID(),type:'studio-repository',projectId,workspaceIndex,repository},900_000);}
  archive(r:StudioRun):RequirementArchive {
    const p=this.binding(r),sessionIds=new Set([...tasks(r).flatMap(t=>[t.sessionId,...(t.attempts??[]).map(a=>a.sessionId)]),...(r.chats??[]).map(c=>c.sessionId)].filter((s):s is string=>!!s)),conversations:PublicConversation[]=[];
    for(const sessionId of sessionIds){const messages=new Map<string,PublicConversation['messages'][number]>();
      const add=(m:any,at?:number)=>{if(!m||!['user','assistant'].includes(m.role)||typeof m.text!=='string'||/thinking|reasoning|思考/i.test(m.label??''))return;messages.set(String(m.id),{id:String(m.id),role:m.role,text:m.text,at:m.timestamp??at});};
      for(const row of this.store.db.prepare('SELECT json FROM history WHERE session_id=?').all(sessionId))for(const m of JSON.parse(String(row.json)).messages??[])add(m);
      for(const row of this.store.db.prepare('SELECT json FROM events WHERE session_id=? ORDER BY seq').all(sessionId)){const e=JSON.parse(String(row.json));if(e.type==='message')add(e.data,e.at);}
      conversations.push({sessionId,messages:[...messages.values()].sort((a,b)=>(a.at??0)-(b.at??0)),coverage:'relay-cached-public-messages'});
    }
    const prior=this.store.db.prepare('SELECT json FROM studio_repository_archives WHERE id=?').get(r.id);
    if(prior){const old=JSON.parse(String(prior.json)) as RequirementArchive;for(const c of old.conversations)if(!sessionIds.has(c.sessionId))conversations.push(c);}
    const run=structuredClone(r) as any;delete run.workspace;delete run.device;delete run.migration;delete run.repository;delete run.repositoryBusy;delete run.repositoryReadOnly;
    const group=this.store.db.prepare('SELECT json FROM studio_group_posts WHERE run_id=? ORDER BY at').all(r.id).map(row=>{const g=JSON.parse(String(row.json));return {id:g.id,at:g.at,text:g.text,roles:g.roles,files:(g.files??[]).map((f:any)=>({name:f.name,sha256:f.sha256})),deliveries:[]};});run.publicGroup=group;
    const project={id:p.id,name:p.name,roles:p.roles.map(a=>({...a,tools:''})),concurrency:p.concurrency,reviewPlan:p.reviewPlan,createdAt:p.createdAt,updatedAt:p.updatedAt};
    const historical=prior?(JSON.parse(String(prior.json)) as RequirementArchive).media:[];
    const refs=[...(r.attachments??[]),...(r.feedbackFileHistory??[]),...(r.guidance??[]).flatMap(g=>g.files)],sessionId=r.planner.sessionId;
    const media=[...historical,...tasks(r).flatMap(t=>(t.artifacts??[]).filter(a=>!!t.sessionId).map(a=>({hostId:p.hostId,sessionId:t.sessionId,path:a.path,description:a.description}))),...sessionId?refs.map(f=>({hostId:p.hostId,sessionId,path:f.name,description:'制作人参考：'+f.name,fileId:f.id,sha256:f.sha256})):[]];
    const a:RequirementArchive={version:1,projectId:p.id,runId:r.id,branch:'codex/studio-'+r.id,projectRelative:'',project,run,conversations,media:[...new Map(media.map(m=>[JSON.stringify([m.hostId,m.sessionId,m.path]),m])).values()]};validateArchive(a);return a;
  }
  private async save(r:StudioRun){if(r.repositoryReadOnly||r.workspace?.status!=='ready')return;const a=this.archive(r),hash=archiveHash(a);if(this.seen.get(r.id)===hash)return;const p=this.binding(r);await this.call(p.hostId,p.projectId,{op:'save',runId:r.id,archive:a},p.workspaceIndex);this.seen.set(r.id,hash);const latest=this.studio.runs().find(x=>x.id===r.id);if(latest){latest.repository={...latest.repository,savedAt:Date.now(),error:undefined,attempts:0};this.persist(latest);}this.failures.delete(r.id);}
  async tick(){if(this.stopped||this.running)return;this.running=true;try{
    for(const r of this.studio.runs()){if(this.stopped)break;const f=this.failures.get(r.id);if(this.jobs.has(r.id)||!this.supported(this.binding(r).hostId)||f&&(f.count>=5||Date.now()-f.at<60000))continue;
      try{await this.save(r);}catch(e){const count=(f?.count??0)+1;this.failures.set(r.id,{count,at:Date.now()});const latest=this.studio.runs().find(x=>x.id===r.id);if(latest){latest.repository={...latest.repository,error:(e as Error).message,attempts:count,retryAt:count<5?Date.now()+60000:undefined};this.persist(latest);}}
    }
    for(const h of this.store.hosts().filter(h=>h.online&&h.capabilities?.studioRepository))for(const p of h.projects.filter(p=>!p.id.startsWith('studio-')&&!p.id.startsWith('brainstorm-')))for(const [workspaceIndex] of (p.roots??[p.path]).entries()){const key=h.id+'|'+p.id+'|'+workspaceIndex;if(Date.now()-(this.scanned.get(key)??0)<60000)continue;this.scanned.set(key,Date.now());try{await this.discover(h.id,p.id,workspaceIndex);}catch{/* Per-project catalog errors are surfaced by the manual refresh. Non-Git project roots are allowed. */}}
  }finally{this.running=false;}}
  async discover(hostId:string,projectId:string,workspaceIndex=0){const found=await this.call(hostId,projectId,{op:'scan'},workspaceIndex);for(const entry of found.requirements??[]){const id=hostId+'|'+projectId+'|'+workspaceIndex+'|'+entry.id;this.store.db.prepare('INSERT OR REPLACE INTO studio_repository_catalog VALUES(?,?)').run(id,JSON.stringify({...entry,hostId,projectId,workspaceIndex}));
      const existing=this.studio.runs().find(r=>r.id===entry.id);if(existing&&(!existing.repositoryReadOnly||existing.repository?.importHash===entry.hash))continue;
      const value=await this.call(hostId,projectId,{op:'inspect',runId:entry.id},workspaceIndex);if(!value.remote)continue;this.import(value.remote,hostId,projectId,undefined,undefined,undefined,workspaceIndex);
    }this.changed();return found;}
  private safeRun(a:RequirementArchive):StudioRun {
    validateArchive(a);const r=structuredClone(a.run) as StudioRun;r.projectId=a.projectId;r.paused=true;r.repositoryBusy=false;r.repositoryReadOnly=true;r.chats=[];r.guidance=(r.guidance??[]).map(g=>({...g,sessionId:'',files:[]}));r.attachments=[];r.feedbackFiles=[];r.feedbackFileHistory=[];r.directions=[];r.device=undefined;r.workspace={status:'blocked',error:'已从 Git 读取需求和进度。选择“在此电脑继续”后准备独立工作副本；未自动执行旧任务。'};r.migration=undefined;r.repository={imported:true};
    if(!['planning','plan-review','executing','delivery','review','accepted','cancelled'].includes(r.status))throw Error('无效需求状态');
    for(const t of tasks(r)){
      const original=t.sessionId,history=a.conversations.find(c=>c.sessionId===original);t.migrationContext=['Git 需求协议 v1 恢复；公开历史可能仅含 Relay 已缓存内容。',...(history?.messages??[]).slice(-20).map(m=>m.role+': '+m.text),t.output??t.summary??''].join('\n').slice(-7000);
      t.sessionId=undefined;t.artifactSessionId=undefined;t.resumeSessionId=undefined;t.actionId=undefined;t.flowStopId=undefined;t.checkpoint=undefined;t.recovery=undefined;t.preflightRetry=undefined;t.autoFollowup=undefined;t.attempts=[];t.feedbackFiles=[];
      if(['running','starting'].includes(t.status)){t.status='queued';t.error='上次执行未完成；已暂停，核对本机文件后手动继续。';}
    }
    return r;
  }
  private import(a:RequirementArchive,hostId:string,projectId:string,workspace?:any,session?:any,backupPath?:string,workspaceIndex=0){
    validateArchive(a);let p=this.studio.projects().find(p=>p.id===a.projectId);
    if(!p){const roles=STUDIO_ROLES.map(([role])=>{const source=Array.isArray(a.project.roles)?a.project.roles.find((r:any)=>r.role===role):undefined;return {role,enabled:source?.enabled!==false,provider:['codex','claude','api'].includes(source?.provider)?source.provider:'codex',model:typeof source?.model==='string'?source.model:undefined,effort:typeof source?.effort==='string'?source.effort:undefined,instructions:String(source?.instructions??'').slice(0,8000),tools:''};});p={id:a.projectId,name:String(a.project.name??'Git 项目'),hostId,projectId,workspaceIndex,roles,permissionMode:'request',concurrency:1,reviewPlan:true,createdAt:Date.now(),updatedAt:Date.now()};this.store.db.prepare('INSERT OR REPLACE INTO studio_projects VALUES(?,?)').run(p.id,JSON.stringify(p));}
    const r=this.safeRun(a);r.repository!.importHash=archiveHash(a);r.device={hostId,projectId,workspaceIndex};if(workspace){r.workspace={status:'ready',value:workspace};r.repositoryReadOnly=false;r.repository={imported:true,backupPath,savedAt:Date.now()};if(session){this.store.session(session);for(const t of tasks(r))t.artifactSessionId=session.id;}}
    this.store.db.exec('BEGIN IMMEDIATE');try{this.persist(r);this.store.db.prepare('INSERT OR REPLACE INTO studio_repository_archives VALUES(?,?)').run(r.id,JSON.stringify(a));for(const g of (a.run.publicGroup??[])){if(typeof g.id!=='string'||typeof g.text!=='string')continue;const value={...g,runId:r.id,files:[],deliveries:[]};this.store.db.prepare('INSERT OR IGNORE INTO studio_group_posts VALUES(?,?,?,?)').run(g.id,r.id,Number(g.at)||0,JSON.stringify(value));}this.store.db.exec('COMMIT');}catch(e){this.store.db.exec('ROLLBACK');throw e;}
    return r;
  }
  catalog(projectId?:string){return this.store.db.prepare('SELECT json FROM studio_repository_catalog').all().map(row=>JSON.parse(String(row.json))).filter(e=>!projectId||e.projectId===projectId);}
  job(id:string){const row=this.store.db.prepare('SELECT json FROM studio_repository_jobs WHERE id=?').get(id);if(!row)throw Error('同步记录不存在');return JSON.parse(String(row.json));}
  start(v:any){
    if(!repositoryId.test(v.id??''))throw Error('无效同步请求 ID');const request=JSON.stringify(v),old=this.store.db.prepare('SELECT request,json FROM studio_repository_jobs WHERE id=?').get(v.id);
    if(old){if(old.request!==request)throw Error('同步请求 ID 已用于其他操作');return JSON.parse(String(old.json));}
    const job:any={id:v.id,runId:v.runId,phase:'running',startedAt:Date.now()};this.store.db.prepare('INSERT INTO studio_repository_jobs VALUES(?,?,?)').run(v.id,request,JSON.stringify(job));
    const work=Promise.resolve().then(()=>this.command(v)).then(result=>{job.phase='done';job.result=result;},e=>{job.phase='failed';job.error=(e as Error).message;}).finally(()=>{job.finishedAt=Date.now();this.store.db.prepare('UPDATE studio_repository_jobs SET json=? WHERE id=?').run(JSON.stringify(job),job.id);this.changed();this.background.delete(work);});this.background.add(work);return job;
  }
  private background=new Set<Promise<any>>();
  conversations(runId:string){const r=this.studio.runs().find(r=>r.id===runId);if(!r)throw Error('需求不存在');return this.archive(r).conversations;}
  media(runId:string){const row=this.store.db.prepare('SELECT json FROM studio_repository_archives WHERE id=?').get(runId);return row?(JSON.parse(String(row.json)) as RequirementArchive).media:[];}
  mediaTarget(runId:string,index:number){const row=this.store.db.prepare('SELECT json FROM studio_repository_archives WHERE id=?').get(runId),a=row?JSON.parse(String(row.json)) as RequirementArchive:undefined,target=Number.isInteger(index)&&index>=0?a?.media[index]:undefined;if(!target?.sessionId||this.store.getSession(target.sessionId)?.hostId!==target.hostId)throw Error('原机器媒体未连接或历史会话不可用；媒体没有存入 Git');return {...target,sessionId:target.sessionId};}
  async command(v:any){
    if(v.op==='scan'){if(typeof v.hostId!=='string'||typeof v.projectId!=='string')throw Error('请选择工作电脑和项目');if(v.workspaceIndex!==undefined&&(!Number.isInteger(v.workspaceIndex)||v.workspaceIndex<0))throw Error('Invalid workspace index');return this.discover(v.hostId,v.projectId,v.workspaceIndex??0);}
    const r=this.studio.runs().find(r=>r.id===v.runId);if(!r||!repositoryId.test(v.runId??''))throw Error('需求不存在');if(this.jobs.has(r.id))throw Error('此需求正在同步，请等待最新结果');assertMainlineIdle(this.store,r.id);
    const job=this.execute(r,v).finally(()=>this.jobs.delete(r.id));this.jobs.set(r.id,job);return job;
  }
  private async execute(r:StudioRun,v:any){
    const p=this.binding(r),hostId=v.hostId??p.hostId,projectId=v.projectId??p.projectId,workspaceIndex=v.workspaceIndex??(hostId===p.hostId&&projectId===p.projectId?p.workspaceIndex:0);if(!Number.isInteger(workspaceIndex)||workspaceIndex<0)throw Error('Invalid workspace index');
    const host=this.supported(hostId);if(!host?.projects.some(p=>p.id===projectId&&!p.id.startsWith('studio-')))throw Error('请选择允许的游戏源仓库');
    if(v.op==='inspect'){
      if(!r.repositoryReadOnly&&hostId===p.hostId&&projectId===p.projectId)await this.save(r);
      const view=await this.call(hostId,projectId,{op:'inspect',runId:r.id},workspaceIndex);const {archive,remote,...safe}=view;return {...safe,local:archive?{revision:archive.run.revision,updatedAt:archive.run.updatedAt,done:archive.run.tasks.filter((t:any)=>t.status==='done').length,total:archive.run.tasks.length}:undefined,remote:remote?{revision:remote.run.revision,updatedAt:remote.run.updatedAt,done:remote.run.tasks.filter((t:any)=>t.status==='done').length,total:remote.run.tasks.length}:undefined};
    }
    if(!['publish','restore'].includes(v.op))throw Error('无效同步操作');
    if(tasks(r).some(t=>['running','starting'].includes(t.status))||(r.chats??[]).some(c=>c.sessionId&&['running','waiting'].includes(this.store.getSession(c.sessionId)?.status??'')))throw Error('当前需求仍有执行任务，请先停止并确认结束，之后再同步进度');
    if(v.op==='publish'&&(hostId!==p.hostId||projectId!==p.projectId||r.repositoryReadOnly))throw Error('请从当前需求所在电脑同步本地制作结果');
    r.paused=true;r.repositoryBusy=true;this.persist(r);
    const backup=join(this.store.dir,'repository-backups',r.id+'-'+randomUUID()+'.json');mkdirSync(join(this.store.dir,'repository-backups'),{recursive:true});writeFileSync(backup,JSON.stringify(r),{mode:0o600});
    try{
      const result=await this.call(hostId,projectId,{op:v.op,runId:r.id,token:v.token,choice:v.op==='publish'?'local':'remote',paths:v.paths},workspaceIndex);
      if(v.op==='restore'){const imported=this.import(result.archive,hostId,projectId,result.workspace,result.session,result.backupPath,workspaceIndex);return {run:imported,backup:result.backupPath,restored:true};}
      const latest=this.studio.runs().find(x=>x.id===r.id)!;latest.repository={...latest.repository,syncedAt:Date.now(),commit:result.commit,indexCommit:result.indexCommit,branch:result.branch,error:undefined};this.persist(latest);return result;
    }catch(e){const latest=this.studio.runs().find(x=>x.id===r.id)!;latest.repository={...latest.repository,error:(e as Error).message};this.persist(latest);throw e;}
    finally{const latest=this.studio.runs().find(x=>x.id===r.id);if(latest){latest.repositoryBusy=false;this.persist(latest);}}
  }
  async close(){this.stopped=true;clearInterval(this.timer);await Promise.allSettled([...this.jobs.values(),...this.background]);while(this.running)await new Promise(r=>setTimeout(r,25));}
}
