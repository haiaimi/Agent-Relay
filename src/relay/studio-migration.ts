import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {MigrationCache,validateManifest,type MigrationManifest} from '../shared/studio-migration.js';
import type {Action,Session} from '../shared/protocol.js';
import type {RelayStore} from './store.js';
import type {StudioRun,StudioProject,Task} from './studio.js';
import type {StudioWorkspace} from '../bridge/studio-workspace.js';
import type {FileStore,FileRef} from '../shared/files.js';
import {handoffContext} from './studio-recovery.js';

export interface StudioMigrationState {
  id:string;phase:'freezing'|'exporting'|'uploading'|'restoring'|'complete'|'failed';sourceHostId:string;sourceProjectId:string;sourcePath:string;targetHostId:string;targetPath:string;startedAt:number;finishedAt?:number;error?:string;done?:number;total?:number;manifest?:MigrationManifest;activeTaskIds:string[];artifactSessionId?:string;
}
interface MigrationDependencies {
  store:RelayStore;files?:FileStore;remote:(host:string,action:Action,timeout?:number)=>Promise<any>;online:(host:string)=>boolean;
  run:(id:string)=>StudioRun;project:(id:string)=>StudioProject;binding:(r:StudioRun)=>StudioProject;tasks:(r:StudioRun)=>Task[];
  save:(r:StudioRun,note?:string)=>void;settle:(r:StudioRun)=>void;changed:()=>void;
}
export const migrationPending=(r:StudioRun)=>!!r.migration&&r.migration.phase!=='complete';
export class StudioMigrations {
  private jobs=new Map<string,Promise<void>>();
  private references(r:StudioRun){const refs=new Map<string,FileRef>();for(const f of [...r.attachments??[],...(r.guidance??[]).flatMap(g=>g.files),...this.d.store.db.prepare('SELECT json FROM studio_group_posts WHERE run_id=?').all(r.id).flatMap(row=>(JSON.parse(String(row.json)).files??[]) as FileRef[])])refs.set(f.id,f);return refs;}
  private async cacheReferences(r:StudioRun,m:StudioMigrationState){
    const d=this.d;for(const f of this.references(r).values()){
      if(!d.files)throw Error('迁移附件服务不可用');const scopes=d.store.db.prepare('SELECT scope FROM upload_files WHERE id=?').all(f.id).map(row=>String(row.scope));let bytes:Buffer|undefined;
      for(const scope of scopes.filter(scope=>scope==='studio:'+r.id||scope.startsWith(m.sourceHostId+'|')))try{bytes=d.files.read(scope,f.id).bytes;break;}catch{}
      if(!bytes){const sid=scopes.filter(scope=>scope.startsWith(m.sourceHostId+'|')).map(scope=>scope.slice(m.sourceHostId.length+1)).find(id=>d.store.getSession(id)?.hostId===m.sourceHostId);if(!sid)throw Error('迁移参考附件未缓存，请在旧电脑联网时补齐：'+f.name);const payload=await d.remote(m.sourceHostId,{id:randomUUID(),type:'file',sessionId:sid,fileId:f.id});d.files.import(payload);bytes=d.files.read(payload.scope,f.id).bytes;}
      d.files.put('studio:'+r.id,f,bytes);
    }
  }
  constructor(private d:MigrationDependencies){
    for(const row of d.store.db.prepare('SELECT json FROM studio_runs').all()){
      const r=JSON.parse(String(row.json)) as StudioRun;if(r.migration&&migrationPending(r)&&r.migration.phase!=='failed'){r.migration.phase='failed';r.migration.error='服务重启，迁移断点已保存，请重试接力';r.paused=true;d.save(r);}
    }
  }
  start(v:any){
    const d=this.d,r=d.run(v.runId),p=d.binding(r),old=r.migration;
    if(this.jobs.has(r.id))return r;
    if(typeof v.hostId!=='string'||typeof v.path!=='string'||!v.path.trim()||v.path.length>2000||/[\x00\r\n]/.test(v.path))throw Error('请选择新电脑并填写 game 仓库绝对路径');
    if(old&&old.phase==='complete'&&old.targetHostId===v.hostId&&old.targetPath===v.path.trim())return r;
    const target=d.store.hosts().find(h=>h.id===v.hostId);if(!target||!d.online(target.id))throw Error('新电脑尚未上线');
    if(!target.capabilities?.studioMigration)throw Error('请先升级新电脑连接程序以支持迁移接力');
    if(v.hostId===p.hostId&&!migrationPending(r))throw Error('请选择另一台工作电脑');
    if(r.status==='cancelled'||r.workspace?.status!=='ready'||!r.workspace.value)throw Error('请先准备好需求的独立工作副本');
    if(d.store.db.prepare('SELECT json FROM studio_runs').all().some(row=>{const x=JSON.parse(String(row.json)) as StudioRun;return x.id!==r.id&&x.continuation?.parentRunId===r.id&&['queued','preparing'].includes(x.workspace?.status??'');}))throw Error('正在复制上游交付，请完成后再迁移');
    for(const a of p.roles.filter(a=>a.enabled))if(target.agents&&!target.agents.some(b=>b.provider===a.provider&&(a.provider!=='api'||b.id===a.agentId)&&b.configured!==false&&(b.provider!=='api'||b.tools)))throw Error('新电脑尚未配置团队需要的 '+a.provider+' Agent');
    if(old&&migrationPending(r)&&(old.targetHostId!==v.hostId||old.targetPath!==v.path.trim())){old.targetHostId=v.hostId;old.targetPath=v.path.trim();}
    if(!old||old.phase==='complete'){
      if(!d.online(p.hostId))throw Error('旧电脑尚未保存迁移快照，请先让旧电脑上线');
      if(!d.store.hosts().find(h=>h.id===p.hostId)?.capabilities?.studioMigration)throw Error('请先升级旧电脑连接程序以支持迁移快照');
      for(const t of d.tasks(r))if(t.actionId){const receipt=d.store.db.prepare('SELECT result FROM actions WHERE id=?').get(t.actionId);if(receipt&&!receipt.result)throw Error('仍有任务投递结果未确认，请先核对执行记录再迁移');}
      if((r.chats??[]).some(c=>!c.sessionId&&!c.resolved))throw Error('仍有职能会话启动结果未确认，请先核对后迁移');
      r.migration={id:randomUUID(),phase:'freezing',sourceHostId:p.hostId,sourceProjectId:r.workspace.value.project.id,sourcePath:r.workspace.value.project.path,targetHostId:v.hostId,targetPath:v.path.trim(),startedAt:Date.now(),activeTaskIds:d.tasks(r).filter(t=>['starting','running'].includes(t.status)||!!t.checkpoint).map(t=>t.id)};
    }
    r.paused=true;r.migration!.error=undefined;r.migration!.phase=r.migration!.manifest?'uploading':'freezing';d.save(r,'已开始跨电脑接力，暂停原电脑后续任务');
    const job=this.execute(r.id).catch(e=>{const latest=d.run(r.id);if(latest.migration?.phase!=='complete'){latest.paused=true;latest.migration!.phase='failed';latest.migration!.error=(e as Error).message;d.save(latest,'接力已暂停，迁移文件和原记录保留，可重试：'+(e as Error).message);}}).finally(()=>this.jobs.delete(r.id));this.jobs.set(r.id,job);return d.run(r.id);
  }
  private async execute(runId:string){
    const d=this.d,initial=d.run(runId),m=initial.migration!,cache=new MigrationCache(d.store.dir,m.id);
    const update=(phase:StudioMigrationState['phase'],done?:number,total?:number)=>{const r=d.run(runId);Object.assign(r.migration!,{phase,done,total});d.save(r);};
    // Validate the explicit new-machine path before interrupting the old writer.
    const host=d.store.hosts().find(h=>h.id===m.targetHostId),key=(path:string)=>{const normalized=path.replaceAll('\\','/').replace(/\/$/,'');return /win/i.test(host?.platform??'')?normalized.toLowerCase():normalized;};
    const known=host?.projects.find(p=>key(p.path)===key(m.targetPath));
    const registration=known?{project:known}:await d.remote(m.targetHostId,{id:randomUUID(),type:'create-project',projectName:'接力 · '+initial.title.slice(0,70),projectPath:m.targetPath});
    const project=registration.project;if(!project?.id||typeof project.path!=='string')throw Error('新电脑未确认仓库路径');
    await d.remote(m.targetHostId,{id:randomUUID(),type:'studio-migration',projectId:project.id,workspaceId:runId,migration:{id:m.id,op:'probe'}});
    if(!m.manifest){
      await d.remote(m.sourceHostId,{id:randomUUID(),type:'studio-migration',workspaceId:runId,projectId:m.sourceProjectId,migration:{id:m.id,op:'freeze'}},60_000);
      const r=d.run(runId);d.settle(r);d.save(r,'旧电脑已停止执行并冻结副本，正在保存制作现场');update('exporting');
      const paths=d.tasks(r).flatMap(t=>(t.artifacts??[]).map(a=>a.path));
      const result=await d.remote(m.sourceHostId,{id:randomUUID(),type:'studio-migration',workspaceId:runId,projectId:m.sourceProjectId,migration:{id:m.id,op:'export',paths:[...new Set(paths)].slice(0,1000)}},30*60_000);
      validateManifest(result?.manifest);if(result.manifest.id!==m.id||result.manifest.runId!==runId)throw Error('迁移快照与需求不匹配');cache.save(result.manifest);
      const manifest:MigrationManifest=result.manifest,total=manifest.repositories.reduce((n,r)=>n+r.size,0);let done=manifest.repositories.reduce((n,_,i)=>n+cache.size(i),0);update('exporting',done,total);
      for(const [i,repo] of manifest.repositories.entries())while(cache.size(i)<repo.size){const offset=cache.size(i),chunk=await d.remote(m.sourceHostId,{id:randomUUID(),type:'studio-migration',migration:{id:m.id,op:'read',file:i,offset}});if(chunk.offset!==offset)throw Error('迁移下载偏移不匹配');const next=cache.write(i,offset,chunk.data);done+=next-offset;update('exporting',done,total);}
      await cache.verify();const latest=d.run(runId);await this.cacheReferences(latest,m);latest.migration!.manifest=manifest;d.save(latest,'完整迁移快照已保存到服务器，后续恢复不依赖旧电脑在线');m.manifest=manifest;
    }
    const manifest=m.manifest!;
    await cache.verify();update('uploading',0,manifest.repositories.reduce((n,r)=>n+r.size,0));
    const status=await d.remote(m.targetHostId,{id:randomUUID(),type:'studio-migration',migration:{id:m.id,op:'status',manifest}});
    let done=0;
    for(const [i,repo] of manifest.repositories.entries()){
      const saved=status.offsets?.[i];if(!Number.isSafeInteger(saved)||saved<0||saved>repo.size)throw Error('新电脑迁移断点无效');done+=saved;
      for(let offset=saved;offset<repo.size;){const chunk=cache.read(i,offset),result=await d.remote(m.targetHostId,{id:randomUUID(),type:'studio-migration',migration:{id:m.id,op:'write',file:i,offset,data:chunk.data}});const expected=offset+Buffer.from(chunk.data,'base64').length;if(result.offset!==expected)throw Error('新电脑未确认迁移分段');done+=expected-offset;offset=expected;update('uploading',done,manifest.repositories.reduce((n,r)=>n+r.size,0));}
    }
    update('restoring');const restored=await d.remote(m.targetHostId,{id:randomUUID(),type:'studio-migration',projectId:project.id,workspaceId:runId,migration:{id:m.id,op:'import'}},30*60_000);
    const w=restored.workspace as StudioWorkspace,s=restored.session as Session;if(w?.migrationId!==m.id||w.runId!==runId||w.project?.id!=='studio-'+runId||!s?.id||s.hostId!==m.targetHostId||s.projectId!==w.project.id)throw Error('新电脑未确认独立接力副本');
    d.store.session(s);
    const r=d.run(runId),refs=this.references(r);
    for(const f of refs.values()){
      if(!d.files)throw Error('迁移附件服务不可用');const bytes=d.files.read('studio:'+r.id,f.id).bytes;
      const scope=m.targetHostId+'|project:'+w.project.id,payload={scope,file:f,data:bytes.toString('base64')},uploaded=await d.remote(m.targetHostId,{id:randomUUID(),type:'upload',projectId:w.project.id,upload:payload});if(uploaded.file?.sha256!==f.sha256)throw Error('新电脑参考附件校验失败：'+f.name);d.files.import(payload);d.files.link(scope,m.targetHostId+'|project:'+project.id,f.id);d.files.link(scope,'studio:'+r.id,f.id);
    }
    const portable=(path:string)=>{const a=path.replaceAll('\\','/'),root=m.sourcePath.replaceAll('\\','/').replace(/\/$/,'');return a===root?w.project.path:a.startsWith(root+'/')?w.project.path.replaceAll('\\','/')+a.slice(root.length):path;};
    const histories=d.tasks(r).map(t=>({id:t.id,sessionId:t.sessionId,events:t.sessionId?d.store.sessionEvents(t.sessionId):[],output:t.output}));writeFileSync(join(cache.root,'handoff.json'),JSON.stringify({runId:r.id,tasks:histories,chats:r.chats,guidance:r.guidance}),{mode:0o600});
    for(const t of d.tasks(r)){
      const sourceSession=t.sessionId;if(sourceSession){t.migrationContext=handoffContext(d.store.sessionEvents(sourceSession),t.output??t.summary??'');t.artifactSessionId=s.id;}
      for(const a of t.artifacts??[])a.path=portable(a.path);for(const a of t.visualSnapshots??[])a.path=portable(a.path);
      if(!t.kind&&!['done','skipped'].includes(t.status)){
        if(sourceSession)t.attempts=[...(t.attempts??[]),{sessionId:sourceSession,output:t.output,at:Date.now()}];
        t.sessionId=undefined;t.resumeSessionId=undefined;t.checkpoint=undefined;t.recovery=undefined;t.preflightRetry=undefined;t.actionId=undefined;
        if(m.activeTaskIds.includes(t.id)){t.status='queued';t.error=undefined;t.finishedAt=undefined;}
      }
    }
    // The server project is stable. Devices are repository bindings, and each
    // demand has its own execution device so other demands keep their owners.
    const p=d.project(r.projectId),source=d.binding(d.run(runId)),previous={hostId:p.hostId,projectId:p.projectId,workspaceIndex:p.workspaceIndex,toolchain:p.toolchain},device={hostId:m.targetHostId,projectId:project.id,workspaceIndex:0,path:project.path,toolchain:p.devices?.find(x=>x.hostId===m.targetHostId&&x.projectId===project.id)?.toolchain};
    const devices=[...(p.devices??[{hostId:p.hostId,projectId:p.projectId,workspaceIndex:p.workspaceIndex,toolchain:p.toolchain}])];
    for(const binding of [{hostId:source.hostId,projectId:source.projectId,workspaceIndex:source.workspaceIndex,toolchain:source.toolchain},device])if(!devices.some(x=>x.hostId===binding.hostId&&x.projectId===binding.projectId))devices.push(binding);
    p.devices=devices;Object.assign(p,device);p.updatedAt=Date.now();r.device=device;r.workspace={status:'ready',value:w};r.paused=false;r.migration={...r.migration!,phase:'complete',artifactSessionId:s.id,finishedAt:Date.now(),error:undefined};
    d.store.db.exec('BEGIN IMMEDIATE');try{
      for(const row of d.store.db.prepare('SELECT json FROM studio_runs').all()){const other=JSON.parse(String(row.json)) as StudioRun;if(other.id!==r.id&&other.projectId===p.id&&!other.device){other.device=previous;d.save(other);}}
      d.store.db.prepare('UPDATE studio_projects SET json=? WHERE id=?').run(JSON.stringify(p),p.id);d.save(r,'已在同一项目切换到新电脑独立副本，保留完成记录和审批，从未完成步骤接力');d.store.db.exec('COMMIT');
    }catch(e){d.store.db.exec('ROLLBACK');throw e;}
    try{cache.dropBundles();}catch{d.save(r,'接力已完成，服务器临时快照包清理失败；请管理员核对缓存目录，原文件与新副本均保留');}d.changed();
  }
  async close(){await Promise.allSettled(this.jobs.values());}
}
