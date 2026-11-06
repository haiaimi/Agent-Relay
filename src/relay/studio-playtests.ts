import {randomUUID} from 'node:crypto';
import type {Studio,StudioRun} from './studio.js';
import type {RelayStore} from './store.js';
import type {Action} from '../shared/protocol.js';
import {launchTargets,type LaunchTarget} from '../shared/playtests.js';
interface Request {id:string;runId:string;targetId:string;target:LaunchTarget;sessionId:string;hostId:string;phase:'inspecting'|'sending'|'finished'|'uncertain';result?:any;error?:string;action?:Action;at:number}
export class StudioPlaytests {
 private jobs=new Set<string>();
 constructor(private store:RelayStore,private studio:Studio,private remote:(host:string,a:Action,timeout?:number)=>Promise<any>,private available:(host:string)=>boolean,private changed:()=>void){store.db.exec('CREATE TABLE IF NOT EXISTS studio_playtest_requests(id TEXT PRIMARY KEY,json TEXT NOT NULL)');}
 private run(id:string){const r=this.studio.runs().find(r=>r.id===id);if(!r)throw Error('制作需求不存在');return r;}
 private targets(r:StudioRun){return r.tasks.filter(t=>t.status==='done'&&t.sessionId).flatMap(t=>launchTargets(t.launchers).map(target=>({id:t.id+':'+target.id,taskId:t.id,sessionId:t.sessionId!,target:{...target,revision:String(t.finishedAt??0)}})));}
 private project(r:StudioRun){const p=(this.studio as Studio&{projectForRun?:(r:StudioRun)=>any}).projectForRun?.(r)??this.studio.projects().find(p=>p.id===r.projectId);if(!p)throw Error('项目组不存在');return p;}
 private saved(id:string){const row=this.store.db.prepare('SELECT json FROM studio_playtest_requests WHERE id=?').get(id);return row?JSON.parse(String(row.json)) as Request:undefined;}
 private save(j:Request){this.store.db.prepare('INSERT OR REPLACE INTO studio_playtest_requests VALUES(?,?)').run(j.id,JSON.stringify(j));this.changed();}
 list(runId:string){const r=this.run(runId),p=this.project(r);return {runId,hostId:p.hostId,device:this.store.hosts().find(h=>h.id===p.hostId)?.name??p.hostId,worktree:r.workspace?.value?.project.path,available:this.available(p.hostId),targets:this.targets(r).map(({sessionId,...t})=>t),requests:this.store.db.prepare("SELECT json FROM studio_playtest_requests WHERE json_extract(json,'$.runId')=? ORDER BY rowid DESC LIMIT 20").all(runId).map(row=>{const j=JSON.parse(String(row.json)) as Request;return {id:j.id,targetId:j.targetId,phase:j.phase,result:j.result,error:j.error,at:j.at,currentTarget:JSON.stringify(this.targets(r).find(t=>t.id===j.targetId)?.target)===JSON.stringify(j.target)};})};}
 async start(v:any){
  if(typeof v.id!=='string'||!/^[a-f0-9-]{36}$/i.test(v.id)||typeof v.targetId!=='string')throw Error('无效启动请求');
  const prior=this.saved(v.id);if(prior){if(prior.runId!==v.runId||prior.targetId!==v.targetId)throw Error('启动 ID 已用于其他入口');return {id:prior.id,phase:prior.phase,result:prior.result,error:prior.error};}
  const r=this.run(v.runId),p=this.project(r),selected=this.targets(r).find(t=>t.id===v.targetId);
  if(!selected||r.workspace?.status!=='ready'||r.status==='cancelled')throw Error('该入口尚未实际交付或需求已取消');
  if(!this.available(p.hostId))throw Error('工作电脑的本机启动服务尚未连接');
  if([r.planner,...r.tasks,...r.delivery?[r.delivery]:[]].some(t=>['starting','running'].includes(t.status))||(r.chats??[]).some(c=>!c.resolved&&c.sessionId&&['running','waiting'].includes(this.store.getSession(c.sessionId)?.status??'')))throw Error('工作副本仍在制作，待当前任务结束后可启动试玩');
  const session=this.store.getSession(selected.sessionId);if(!session||session.hostId!==p.hostId||session.projectId!==r.workspace.value?.project.id)throw Error('入口所属会话与当前工作副本不匹配');
  const j:Request={id:v.id,runId:r.id,targetId:selected.id,target:selected.target,hostId:p.hostId,sessionId:selected.sessionId,phase:'inspecting',at:Date.now()};this.save(j);this.jobs.add(j.id);
  try{
   const inspected=await this.remote(j.hostId,{id:randomUUID(),type:'studio-launch',workspaceId:r.id,sessionId:j.sessionId,launch:{op:'inspect',target:j.target}},15000);
   if(!/^[a-f0-9]{64}$/.test(inspected?.hash??'')||inspected.worktree!==r.workspace.value!.project.path)throw Error('工作电脑未确认正确副本与启动脚本版本');
   const latest=this.run(r.id);if(JSON.stringify(this.targets(latest).find(t=>t.id===j.targetId)?.target)!==JSON.stringify(j.target)||[latest.planner,...latest.tasks,...latest.delivery?[latest.delivery]:[]].some(t=>['starting','running'].includes(t.status)))throw Error('制作记录或启动入口已变化，请刷新后再启动');
   const action:Action={id:j.id,type:'studio-launch',workspaceId:r.id,sessionId:j.sessionId,launch:{op:'start',target:j.target,hash:inspected.hash}};j.action=action;j.phase='sending';this.save(j);
   const old=this.store.beginAction(action.id,j.hostId,action);if(!old.fresh)throw Error('启动投递已有记录，请核对状态，不重复执行');
   const result=await this.remote(j.hostId,action,20000);this.store.finishAction(action.id,result);j.result=result;j.phase='finished';this.save(j);return {id:j.id,phase:j.phase,result};
  }catch(e){j.error=(e as Error).message;j.phase=j.action?'uncertain':'finished';this.save(j);return {id:j.id,phase:j.phase,error:j.error};}finally{this.jobs.delete(j.id);}
 }
 async status(runId:string,id:string){
  this.run(runId);const j=this.saved(id);if(!j||j.runId!==runId)throw Error('启动记录不属于该需求');if(this.jobs.has(id))return {id,phase:j.phase,result:j.result};
  if(!j.action&&j.phase==='inspecting'){j.phase='finished';j.error='启动前核对已中断，尚未投递启动请求，可重新启动';this.save(j);}
  if(!j.action||!this.available(j.hostId))return {id,phase:j.phase,result:j.result,error:j.error};
  const result=await this.remote(j.hostId,{id:randomUUID(),type:'studio-launch',workspaceId:j.runId,sessionId:j.sessionId,launch:{op:'status',target:j.target,requestId:j.result?.id??id}},10000);
  if(result.status==='not-found'){j.phase='uncertain';j.error='本机未找到已确认的启动回执，不会自动重发';}else{j.result=result;j.phase='finished';j.error=undefined;if(j.action)this.store.finishAction(j.action.id,result);}this.save(j);return {id,phase:j.phase,result:j.result,error:j.error};
 }
}
