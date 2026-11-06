import type {Studio} from './studio.js';
import type {RelayStore} from './store.js';
import type {Action} from '../shared/protocol.js';
type Job={id:string;runId:string;branch:string;hostId:string;sourcePath:string;at:number;action:Action;phase:'sending'|'uncertain'|'running'|'reported'|'blocked';sessionId?:string;error?:string;report?:any};
export function assertMainlineIdle(store:RelayStore,runId:string){
 if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='studio_mainline_jobs'").get())return;
 if(store.db.prepare("SELECT 1 FROM studio_mainline_jobs WHERE run_id=? AND json_extract(json,'$.phase') IN ('sending','uncertain','running') LIMIT 1").get(runId))throw Error('本需求正在合入或投递未确认，请先核对主干合入记录，再修改或复制工作副本');
}
export class StudioMainline {
 constructor(private store:RelayStore,private studio:Studio,private remote:(host:string,a:Action)=>Promise<any>,private online:(host:string)=>boolean,private changed:()=>void){store.db.exec('CREATE TABLE IF NOT EXISTS studio_mainline_jobs(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,json TEXT NOT NULL)');}
 private get(id:string){const row=this.store.db.prepare('SELECT json FROM studio_mainline_jobs WHERE id=?').get(id);return row?JSON.parse(String(row.json)) as Job:undefined;}
 private save(j:Job){this.store.db.prepare('INSERT OR REPLACE INTO studio_mainline_jobs VALUES(?,?,?)').run(j.id,j.runId,JSON.stringify(j));this.changed();}
 private run(id:string){const r=this.studio.runs().find(r=>r.id===id);if(!r)throw Error('需求不存在');return r;}
 list(runId:string){this.run(runId);return this.store.db.prepare('SELECT json FROM studio_mainline_jobs WHERE run_id=? ORDER BY rowid DESC LIMIT 10').all(runId).map(row=>{
  const j=JSON.parse(String(row.json)) as Job;if(j.phase==='running'&&j.sessionId){const s=this.store.getSession(j.sessionId);if(s&&!['running','waiting'].includes(s.status)){
   const messages=new Map<string,string>();for(const e of this.store.sessionEvents(j.sessionId)){if(e.type==='message'&&e.data.role==='assistant')messages.set(e.data.id,String(e.data.text??''));if(e.type==='delta')messages.set(e.data.messageId,(messages.get(e.data.messageId)??'')+String(e.data.text??''));}
   const blocks=[...messages.values()].join('\n').matchAll(/```STUDIO_MERGE_RESULT\s*([\s\S]*?)```/g);let report:any;for(const b of blocks){try{report=JSON.parse(b[1]);}catch{}}
   if(report&&['merged','blocked'].includes(report.outcome)&&typeof report.summary==='string'&&report.summary.length<=6000&&report.targetBranch===j.branch){j.report={...report,checks:Array.isArray(report.checks)?report.checks.slice(0,40):[]};j.phase=report.outcome==='merged'&&/^[a-f0-9]{40,64}$/.test(report.targetCommit??'')&&/^[a-f0-9]{40,64}$/.test(report.sourceCommit??'')&&j.report.checks.length>0?'reported':'blocked';}else{j.phase='blocked';j.error='合入任务已停止，未收到有效合入报告，请核对完整记录。';}this.save(j);
  }}return {id:j.id,runId:j.runId,branch:j.branch,phase:j.phase,sessionId:j.sessionId,error:j.error,report:j.report,at:j.at};});}
 async start(v:any){
  if(typeof v.id!=='string'||!/^[a-f0-9-]{36}$/i.test(v.id)||typeof v.targetBranch!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(v.targetBranch)||/\.\.|\/\/|@\{|\.lock(?:\/|$)|[/.]$/.test(v.targetBranch))throw Error('请输入有效目标分支');
  const old=this.get(v.id);if(old){if(old.runId!==v.runId||old.branch!==v.targetBranch)throw Error('请求 ID 已用于其他合入');return this.list(v.runId).find(j=>j.id===v.id);}
  const r=this.run(v.runId),p=(this.studio as Studio&{projectForRun?:(r:any)=>any}).projectForRun?.(r)??this.studio.projects().find(p=>p.id===r.projectId);
  if(r.status!=='accepted'||r.workspace?.status!=='ready')throw Error('请先完成最终验收，再发起主干合入');
  if((r as any).migration&&!['complete','failed','cancelled'].includes((r as any).migration.phase))throw Error('请先完成工作副本迁移');
  if(!p||!this.online(p.hostId))throw Error('工作电脑离线');const a=p.roles.find((a:any)=>a.role==='engineering'&&a.enabled);if(!a)throw Error('请启用程序职能');
  const active=this.list(r.id).find(j=>['sending','uncertain','running'].includes(j.phase));if(active)throw Error('已有合入任务或投递结果未确认，请查看原记录');
  const workspace=r.workspace.value!;if(!workspace.sourcePath||workspace.sourcePath===workspace.project.path)throw Error('缺少独立源工程路径');
  if((r.chats??[]).some(c=>!c.resolved&&(!c.sessionId||['running','waiting'].includes(this.store.getSession(c.sessionId)?.status??''))))throw Error('职能对话仍在工作或投递未确认，请先核对');
  const other=this.store.db.prepare('SELECT json FROM studio_mainline_jobs').all().map(row=>JSON.parse(String(row.json)) as Job).find(j=>j.hostId===p.hostId&&j.sourcePath===workspace.sourcePath&&['sending','uncertain','running'].includes(j.phase));if(other)throw Error('同一源工程已有合入任务，请先核对其执行记录');
  const action:Action={id:v.id,type:'start',projectId:workspace.project.id,workspaceIndex:0,provider:a.provider,agentId:a.agentId,model:a.model,effort:a.effort,permissionMode:p.permissionMode,text:mergeInstructions(r,workspace,v.targetBranch)};
  const j:Job={id:v.id,runId:r.id,branch:v.targetBranch,hostId:p.hostId,sourcePath:workspace.sourcePath,at:Date.now(),action,phase:'sending'};this.save(j);
  if(!this.store.beginAction(j.id,j.hostId,action).fresh){j.phase='uncertain';j.error='投递记录已存在，请核对原任务，不自动重发';this.save(j);return j;}
  try{const result=await this.remote(j.hostId,action);this.store.finishAction(j.id,result);if(typeof result.sessionId!=='string'||!result.sessionId.startsWith(j.hostId+':'))throw Error('合入会话回执未确认');j.sessionId=result.sessionId;j.phase='running';this.save(j);return j;}
  catch(e){j.phase='uncertain';j.error=(e as Error).message;this.save(j);return j;}
 }
}
export function mergeInstructions(r:{id:string;title:string},w:{project:{path:string};sourcePath:string;branch:string},branch:string){return `这是制作人主动点击“合入主干”授权的独立整合任务，原需求已验收。不得把验收操作本身当作已合入。
需求：${JSON.stringify(r)}
已验收工作副本：${JSON.stringify(w.project.path)}
成果分支：${JSON.stringify(w.branch)}
源工程：${JSON.stringify(w.sourcePath)}
制作人选定目标分支：${JSON.stringify(branch)}
先只读核对 worktree、Git common-dir、分支和 HEAD、所有 worktree 的状态、未完成 merge/rebase、子模块与并行写入者；确认它们属于同一个仓库。目标分支必须已经存在，不得猜测其他分支代替，不得切换或清理源工程。
列出本需求交付清单、跟踪/未跟踪差异和待提交文件；只整理并提交可归属于本需求的代码、场景、正式资产及文档。不能 git add -A/-f 批量吞入其他工作；排除凭据、.env、构建/导入缓存、大体积录帧、临时进程/锁和私有目录。游戏需要的正式资产必须完整。新文件、子模块、继承的未提交改动若归属不明确，报告 blocked 并列出待核对路径。不得误称所有 dirty 都是本需求成果。
提交前复核 diff 和资产依赖，只提交本需求文件。此按钮明确授权本需求所需的本地 Git 提交及合入选定目标；不授权推送、发布、删除历史或修改其他需求。
合入前检查目标分支所有已检出 worktree，存在其他未提交改动/并行写入/未完成整合则停止并报告，禁止 stash/reset/clean/force。先在新建的独立整合 worktree（目标 HEAD 的副本）试合并并做适合变更的验证，出现冲突就保留整合副本和冲突记录，原目标不变。确认验证通过后再次核对目标 HEAD 未变化，再正常合入目标。禁止强推、绕过冲突或悄悄修正其他人的变更。
成功后实际执行 git merge-base --is-ancestor <成果提交> <目标分支>，核对目标 HEAD、Git 状态、子模块、可玩入口和工作副本中的启动脚本（不能遗留指向旧 worktree 的绝对路径）。合入不能虚构缺失的 QA，也不能把延期项写成通过。保留原需求副本、提交前后的 SHA、整合日志和失败证据。
最后输出 fenced STUDIO_MERGE_RESULT JSON：{outcome:"merged"或"blocked",targetBranch:${JSON.stringify(branch)},sourceCommit:"实际成果SHA",targetCommit:"实际目标SHA",summary:"实际结果或具体阻断",checks:["实际命令与结果"],integrationWorktree:"实际路径"}。没有实际合入及祖先验证，不得报告 merged；不推送远程。`;
}
