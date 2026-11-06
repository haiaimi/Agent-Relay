import {repositoryAddress} from './repository-url.js';
import {createHash} from 'node:crypto';

export const repositoryId=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const archivePath=(id:string)=>`.relay/requirements/${id}.json`;
export const archiveHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface PublicConversation {sessionId:string;messages:{id:string;role:'user'|'assistant';text:string;at?:number}[];coverage:'relay-cached-public-messages'}
export interface RequirementArchive {
  contextPolicy?:{messageLimit:12;completeHistory:false};
  version:1;projectId:string;runId:string;branch:string;projectRelative:string;
  project:Record<string,any>;run:Record<string,any>;conversations:PublicConversation[];
  media:{hostId:string;sessionId?:string;path:string;description?:string;fileId?:string;sha256?:string}[];
}
export interface RequirementIndex {version:1;projectId:string;requirements:{id:string;title:string;branch:string;status:string;revision:number;updatedAt:number;commit?:string;sha256?:string}[]}
export interface RepositoryRequest {
  op:'connect'|'save'|'scan'|'inspect'|'publish'|'restore';path?:string;repositoryUrl?:string;name?:string;runId?:string;archive?:RequirementArchive;
  token?:string;choice?:'local'|'remote';paths?:string[];ref?:string;
}
export function validRepositoryPath(path:unknown):path is string{return typeof path==='string'&&path.length<1500&&!!path&&!/[\\:\x00-\x1f]/.test(path)&&path.split('/').every(p=>p&&p!=='.'&&p!=='..'&&p.toLowerCase()!=='.git');}
export function validateArchive(a:any):asserts a is RequirementArchive {
  if(a?.version!==1||!repositoryId.test(a.projectId??'')||!repositoryId.test(a.runId??'')||a.run?.id!==a.runId||a.run?.projectId!==a.projectId||a.project?.id!==a.projectId||a.branch!=='codex/studio-'+a.runId||a.projectRelative!==''&&!validRepositoryPath(a.projectRelative)||typeof a.project?.name!=='string'||!Array.isArray(a.project.roles)||typeof a.run.title!=='string'||typeof a.run.brief!=='string'||!Number.isSafeInteger(a.run.revision)||a.run.revision<0||!Number.isFinite(a.run.createdAt)||!Number.isFinite(a.run.updatedAt)||!Array.isArray(a.run.log)||!Array.isArray(a.run.tasks)||a.run.tasks.length>150||!a.run.planner||!Array.isArray(a.conversations)||!Array.isArray(a.media)||Buffer.byteLength(JSON.stringify(a))>12*1024*1024)throw Error('无效需求存档或存档超过 12 MB');
  if(a.project.repositoryUrl!==undefined)repositoryAddress(a.project.repositoryUrl);
  const tasks=[a.run.planner,...a.run.tasks,...a.run.delivery?[a.run.delivery]:[]],ids=new Set<string>();
  for(const t of tasks){if(!/^[a-zA-Z0-9_-]{1,100}$/.test(t.id??'')||ids.has(t.id)||typeof t.title!=='string'||typeof t.role!=='string'||!['queued','starting','running','done','blocked','skipped','cancelled','awaiting-review'].includes(t.status)||!Array.isArray(t.dependencies)||t.dependencies.some((d:any)=>typeof d!=='string'))throw Error('无效存档任务');ids.add(t.id);}
  const visited=new Set<string>(),active=new Set<string>();const visit=(id:string)=>{if(visited.has(id))return;if(active.has(id))throw Error('存档任务依赖循环');const t=tasks.find((t:any)=>t.id===id);if(!t)throw Error('存档任务依赖缺失');active.add(id);t.dependencies.forEach(visit);active.delete(id);visited.add(id);};tasks.forEach((t:any)=>visit(t.id));
  for(const c of a.conversations)if(typeof c.sessionId!=='string'||c.coverage!=='relay-cached-public-messages'||!Array.isArray(c.messages)||c.messages.some((m:any)=>!['user','assistant'].includes(m.role)||typeof m.id!=='string'||typeof m.text!=='string'))throw Error('无效公开会话存档');
  for(const m of a.media)if(typeof m.hostId!=='string'||typeof m.path!=='string'||m.path.length>2000||/[\x00\r\n]/.test(m.path)||m.sessionId!==undefined&&typeof m.sessionId!=='string'||m.fileId!==undefined&&(!repositoryId.test(m.fileId)||!/^[a-f0-9]{64}$/.test(m.sha256??'')))throw Error('无效本机媒体引用');
  if(a.contextPolicy!==undefined&&(a.contextPolicy.messageLimit!==12||a.contextPolicy.completeHistory!==false))throw Error('不支持完整历史归档模式');
}
export function validateRepositoryRequest(v:any):asserts v is RepositoryRequest {
  if(!v||!['connect','save','scan','inspect','publish','restore'].includes(v.op)||!['scan','connect'].includes(v.op)&&!repositoryId.test(v.runId??''))throw Error('无效需求同步操作');
  if(v.op==='connect'){if(!repositoryAddress(v.repositoryUrl)||typeof v.path!=='string'||!v.path.trim()||v.path.length>2000||/[\x00\r\n]/.test(v.path)||typeof v.name!=='string'||!v.name.trim()||v.name.length>100)throw Error('请填写仓库地址、项目名称和目标电脑的工程绝对路径');}
  if(v.archive!==undefined){validateArchive(v.archive);if(v.archive.runId!==v.runId||v.op!=='save')throw Error('无效需求存档绑定');}
  if(v.op==='save'&&!v.archive)throw Error('缺少需求存档');
  if(['publish','restore'].includes(v.op)&&!/^[a-f0-9]{64}$/.test(v.token??''))throw Error('请先检查同步差异');
  if(v.op==='publish'&&v.choice!=='local'||v.op==='restore'&&v.choice!=='remote')throw Error('请选择采用本地或远程版本');
  if(v.paths!==undefined&&(!Array.isArray(v.paths)||v.paths.length>10000||v.paths.some((p:any)=>!validRepositoryPath(p))))throw Error('无效提交文件清单');
}
