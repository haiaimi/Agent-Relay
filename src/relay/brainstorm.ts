import {normalizeProductionFlow} from './studio-flow.js';
import {randomUUID,createHash} from 'node:crypto';
import {validateAction,type Action,type Project,type Message} from '../shared/protocol.js';
import {FileStore,MAX_UPLOAD_BYTES,type FileRef} from '../shared/files.js';
import {MediaStore,imageBytes} from '../shared/media.js';
import type {RelayStore} from './store.js';
import type {Studio} from './studio.js';

export interface BrainstormTopic {id:string;projectId:string;hostId:string;title:string;model?:string;effort?:string;workspace?:Project;sessionId?:string;startActionId?:string;prepareId:string;error?:string;createdAt:number;updatedAt:number}
const text=(v:unknown,max:number,label:string)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw Error(label+'不能为空或过长');return v.trim();};
export class Brainstorms{
  private launching=new Map<string,Promise<any>>();
  private settingsJobs=new Map<string,Promise<any>>();
  constructor(private store:RelayStore,private studio:Studio,private remote:(host:string,action:Action,timeout?:number)=>Promise<any>,private online:(host:string)=>boolean,private changed:()=>void,private files:FileStore,private media:MediaStore){
    store.db.exec('CREATE TABLE IF NOT EXISTS brainstorm_topics(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS brainstorm_launches(topic_id TEXT NOT NULL,proposal_id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(topic_id,proposal_id))');
  }
  private save(t:BrainstormTopic){t.updatedAt=Date.now();this.store.db.prepare('INSERT OR REPLACE INTO brainstorm_topics VALUES(?,?)').run(t.id,JSON.stringify(t));this.changed();}
  list():BrainstormTopic[]{return this.store.db.prepare('SELECT json FROM brainstorm_topics ORDER BY rowid DESC').all().map(r=>{
    const t=JSON.parse(String(r.json)) as BrainstormTopic;
    // Exact project identity recovers lost receipts after relay restarts. Never
    // create another session or resend a message to recover an uncertain send.
    if(!t.workspace){const p=this.store.hosts().find(h=>h.id===t.hostId)?.projects.find(p=>p.id==='brainstorm-'+t.id);if(p){t.workspace=p;t.error=undefined;this.save(t);}}
    if(t.workspace&&!t.sessionId){const sessions=this.store.sessions().filter(s=>s.hostId===t.hostId&&s.projectId===t.workspace!.id&&s.provider==='claude'&&s.managed);if(sessions.length===1){t.sessionId=sessions[0].id;t.error=undefined;this.save(t);}}
    return t;
  });}
  private topic(id:string){const t=this.list().find(t=>t.id===id);if(!t)throw Error('讨论不存在');return t;}
  private team(id:string){const t=this.studio.projects().find(t=>t.id===id);if(!t)throw Error('项目组不存在');return t;}
  private preferences(v:any){
    return validateAction({id:randomUUID(),type:'set-model',sessionId:'preferences',model:v.model===''?undefined:v.model,effort:v.effort??'default'});
  }
  private async checkPreferences(hostId:string,projectId:string|undefined,patch:Action){
    if(!patch.model&&patch.effort==='default')return;
    const {models}=await this.remote(hostId,{id:randomUUID(),type:'models',provider:'claude',projectId});
    const selected=models.find((m:any)=>m.id===patch.model||m.aliases?.includes(patch.model))??(!patch.model?models.find((m:any)=>m.isDefault)??models[0]:undefined);
    if(!selected)throw Error('该模型不在本机 Claude 返回的列表中，请刷新后重选');
    if(patch.effort!=='default'&&!selected.efforts?.includes(patch.effort))throw Error('该模型不支持此思考强度');
  }
  settings(v:any):Promise<any>{
    if(this.settingsJobs.has(v.topicId))throw Error('模型设置正在保存，请稍后重试');
    const job=this.saveSettings(v).finally(()=>this.settingsJobs.delete(v.topicId));this.settingsJobs.set(v.topicId,job);return job;
  }
  private async saveSettings(v:any){
    const t=this.topic(v.topicId),patch=this.preferences(v);
    if(!this.online(t.hostId))throw Error('项目组工作电脑离线');
    if(!t.sessionId&&t.startActionId)throw Error('会话启动结果尚未确认，请先核对讨论记录');
    let result:any={ok:true,model:patch.model,effort:patch.effort};
    if(t.sessionId){
      const action=validateAction({id:v.id,type:'set-model',sessionId:t.sessionId,model:patch.model??'default',effort:patch.effort});
      const prior=this.store.beginAction(action.id,t.hostId,action);
      if(!prior.fresh){if(prior.result?.error)throw Error(prior.result.error);if(!prior.result)throw Error('模型设置结果尚未确认，请核对当前设置');return prior.result;}
      try{result=await this.remote(t.hostId,action);this.store.finishAction(action.id,result);}
      catch(e){this.store.finishAction(action.id,{error:(e as Error).message});throw e;}
    }else await this.checkPreferences(t.hostId,t.workspace?.id,patch);
    // Settings may finish after a session update; never overwrite its binding.
    const latest=this.topic(t.id);latest.model=result.model;latest.effort=result.effort;this.save(latest);return {...result,topic:latest};
  }
  private context(t:BrainstormTopic){
    const p=this.team(t.projectId),host=this.store.hosts().find(h=>h.id===p.hostId),source=host?.projects.find(x=>x.id===p.projectId);
    return JSON.stringify({项目组:p.name,工程:source?.name,源工程目录:(source?.roots??[source?.path])[p.workspaceIndex],规则:'只读参考工程；制作仅在制作人点击发起后，在新分支工作副本执行。场景参考图不替代制作阶段的原画确认。',团队:p.roles.filter(r=>r.enabled).map(r=>({职能:r.role,工具:r.tools,补充:r.instructions})),已有需求:this.studio.runs().filter(r=>r.projectId===p.id).slice(0,12).map(r=>({名称:r.title,目标:r.brief.slice(0,900),状态:r.status,暂停:r.paused,分支:r.workspace?.value?.branch,任务:r.tasks.map(t=>({职能:t.role,名称:t.title,状态:t.status,结论:t.summary?.slice(0,350)})).slice(-15)}))}).slice(0,18000);
  }
  async create(v:any){
    const p=this.team(v.projectId),host=this.store.hosts().find(h=>h.id===p.hostId);if(!this.online(p.hostId))throw Error('项目组工作电脑离线');if(!host?.capabilities?.brainstorm)throw Error('工作电脑的头脑风暴连接程序正在升级，请稍后重试');
    const prefs=this.preferences(v),title=text(v.title,100,'讨论主题');await this.checkPreferences(p.hostId,undefined,prefs);
    const now=Date.now(),t:BrainstormTopic={id:randomUUID(),projectId:p.id,hostId:p.hostId,title,model:prefs.model,effort:prefs.effort,prepareId:randomUUID(),createdAt:now,updatedAt:now};this.save(t);
    try{const result=await this.remote(t.hostId,{id:t.prepareId,type:'prepare-brainstorm',workspaceId:t.id,projectId:p.projectId,workspaceIndex:p.workspaceIndex});if(result?.project?.id!=='brainstorm-'+t.id)throw Error('讨论资料目录未确认');t.workspace=result.project;this.save(t);}
    catch(e){t.error=(e as Error).message;this.save(t);}return t;
  }
  async send(v:any){
    await this.settingsJobs.get(v.topicId);
    const t=this.topic(v.topicId);if(!t.workspace||t.error)throw Error(t.error??'讨论资料目录尚未就绪');if(!this.online(t.hostId))throw Error('项目组工作电脑离线');
    const message=text(v.text,12000,'消息'),scope=t.hostId+'|'+(t.sessionId??'project:'+t.workspace.id);const refs=this.files.refs(scope,v.attachmentIds??[]);
    const action:Action={id:v.id,type:t.sessionId?'send':'start',sessionId:t.sessionId,projectId:t.workspace.id,provider:'claude',...!t.sessionId?{model:t.model,effort:t.effort}:{},permissionMode:t.sessionId?undefined:'request',text:message,brainstormContext:this.context(t),attachmentIds:refs.map(f=>f.id)};
    if(!/^[a-zA-Z0-9_-]{8,100}$/.test(action.id??''))throw Error('无效消息编号');
    const prior=this.store.beginAction(action.id,t.hostId,action);if(!prior.fresh){if(prior.result?.error)throw Error(prior.result.error);if(!prior.result)throw Error('发送结果尚未确认，请查看讨论记录；不会重复发送');return prior.result;}
    if(!t.sessionId&&t.startActionId)throw Error('上一条消息的会话启动结果尚未确认，请先核对讨论记录；不会创建重复会话');
    if(!t.sessionId){t.startActionId=action.id;this.save(t);}
    try{const result=await this.remote(t.hostId,action);if(!result?.sessionId)throw Error('会话投递结果未确认');t.sessionId=result.sessionId;for(const f of refs)this.files.link(scope,t.hostId+'|'+t.sessionId,f.id);this.save(t);this.store.finishAction(action.id,result);return result;}
    catch(e){this.store.finishAction(action.id,{error:(e as Error).message});throw e;}
  }
  private proposals(t:BrainstormTopic){return t.sessionId?this.store.db.prepare("SELECT json FROM events WHERE session_id=? AND json_extract(json,'$.type')='message' AND json_extract(json,'$.data.proposal.id') IS NOT NULL ORDER BY seq").all(t.sessionId).map(r=>{const e=JSON.parse(String(r.json));return {eventId:e.id,at:e.at,...e.data.proposal};}):[];}
  detail(id:string){const t=this.topic(id);return {topic:t,proposals:this.proposals(t),launches:this.store.db.prepare('SELECT json FROM brainstorm_launches WHERE topic_id=?').all(id).map(r=>{const v=JSON.parse(String(r.json));return {runId:v.runId,topicId:v.topicId,proposalId:v.proposalId,at:v.at};})};}
  launch(v:any):Promise<any>{const key=v.topicId+'|'+v.proposalId,old=this.launching.get(key);if(old)return old;const job=this.launchOnce(v).finally(()=>this.launching.delete(key));this.launching.set(key,job);return job;}
  private async launchOnce(v:any){
    const t=this.topic(v.topicId),p=this.team(t.projectId),proposal=this.proposals(t).find(x=>x.id===v.proposalId);if(!proposal)throw Error('制作提案不存在，请先让 Claude 整理方案');
    const old=this.store.db.prepare('SELECT json FROM brainstorm_launches WHERE topic_id=? AND proposal_id=?').get(t.id,proposal.id);if(old)return JSON.parse(String(old.json));
    const flowConfig=normalizeProductionFlow(v.flowConfig);
    if(!this.online(t.hostId))throw Error('项目组工作电脑离线');
    // Freeze the selected proposal and its references; later conversation edits
    // cannot change an already launched production requirement.
    const imageIds=proposal.image_ids??[];if(!Array.isArray(imageIds)||imageIds.length>5||!imageIds.every((id:any)=>/^[a-f0-9]{64}$/.test(id)))throw Error('提案参考图无效');
    const scope=t.hostId+'|project:'+p.projectId,refs:FileRef[]=[];
    for(const id of imageIds){
      let value=this.media.read(t.sessionId!,id);if(!value){const payload=await this.remote(t.hostId,{id:randomUUID(),type:'asset',sessionId:t.sessionId!,assetId:id});imageBytes(payload);if(payload.id!==id)throw Error('参考图编号不匹配');this.media.putPayload(t.sessionId!,payload);value=this.media.read(t.sessionId!,id);}
      if(!value)throw Error('参考图尚未取回');const bytes=value.bytes,name='brainstorm-'+id.slice(0,16)+'.'+(value.mime==='image/jpeg'?'jpg':value.mime.split('/')[1]);
      const file=this.files.put(scope,{id:randomUUID(),name,size:bytes.length,mime:value.mime,sha256:createHash('sha256').update(bytes).digest('hex')},bytes);refs.push(file);
    }
    if(refs.reduce((n,f)=>n+f.size,0)>MAX_UPLOAD_BYTES)throw Error('提案参考图总大小超过 16 MB，请让 Claude 减少图片后重新整理提案');
    // Materialize on the target computer before accepting the production run.
    for(const file of refs){const {bytes}=this.files.read(scope,file.id),result=await this.remote(t.hostId,{id:randomUUID(),type:'upload',upload:{scope,file,data:bytes.toString('base64')}});if(result?.file?.sha256!==file.sha256)throw Error('工作电脑尚未确认提案参考图');}
    const transcript=this.store.sessionEvents(t.sessionId!).filter(e=>e.type==='message'&&['user','assistant'].includes(e.data.role)&&e.at<=proposal.at).map(e=>({at:e.at,role:e.data.role,text:e.data.text}));
    const brief=text(proposal.brief,9000,'提案内容')+'\n\n【来自项目组头脑风暴】\n主题：'+t.title+'\n讨论编号：'+t.id+'\n提案编号：'+proposal.id+'\n讨论参考图随需求附上，仅作为方向参考；制作环节及审批按本需求配置执行，未另行配置时沿用默认场景流程。\n\n最近讨论背景：\n'+transcript.filter(m=>m.text).slice(-8).map(m=>(m.role==='user'?'制作人：':'Claude：')+m.text).join('\n').slice(-2200);
    this.store.db.exec('BEGIN IMMEDIATE');
    try{const run=this.studio.createRun({projectId:t.projectId,title:proposal.title,brief:brief.slice(0,12000),workflow:v.workflow??proposal.workflow,reuseReason:v.reuseReason,flowConfig,recordVideo:v.recordVideo,attachmentIds:refs.map(f=>f.id)});const result={runId:run.id,topicId:t.id,proposalId:proposal.id,at:Date.now(),proposal,transcript,referenceIds:imageIds};this.store.db.prepare('INSERT INTO brainstorm_launches VALUES(?,?,?)').run(t.id,proposal.id,JSON.stringify(result));this.store.db.exec('COMMIT');this.changed();return result;}
    catch(e){this.store.db.exec('ROLLBACK');throw e;}
  }
}
