import {validateRepositoryRequest,type RepositoryRequest} from './studio-repository.js';
import {launchTargets,type LaunchRequest} from './playtests.js';
import type {ImageRef} from './media.js';
import {uploadId,MAX_ATTACHMENTS,type FileRef,type FilePayload} from './files.js';
import {validDirectSdp,validTurnServers,type DirectOffer,type DirectIceServer} from './direct.js';
import type {QuestionCard} from './questions.js';
import {validateManifest,MIGRATION_CHUNK,type MigrationRequest} from './studio-migration.js';
export type Provider = 'codex' | 'claude' | 'api';
export interface AgentInfo {id:string;provider:Provider;name:string;configured?:boolean;tools?:boolean;revision?:string}
export type PermissionMode = 'request' | 'auto' | 'full';
export type Status = 'history' | 'running' | 'idle' | 'waiting' | 'failed' | 'interrupted';
export interface Activity {kind:'thinking'|'tool'|'reply'|'plan'|'waiting';label:string;detail?:string;at?:number}
export interface Project { repositoryUrl?:string;id: string; name: string; path: string; roots?: string[]; source?: 'codex'|'configured'; nativeProjectId?:string }
export interface Session {
  agentId?:string;agentName?:string;
  id: string; hostId: string; provider: Provider; nativeId: string;
  title: string; cwd: string; updatedAt: number; status: Status;
  archived?: boolean; managed?: boolean; canSteer?:boolean; role?: string; model?: string; effort?:string;nextModel?:string;nextEffort?:string; projectId?:string; projectName?:string; projectSource?:string;statusOrigin?:'relay'|'native';pendingCount?:number;pendingIds?:string[];
  questionCount?:number;canStop?:boolean;activity?:Activity;permissionMode?:PermissionMode;nextPermissionMode?:PermissionMode;canSetPermissions?:boolean;approvedTools?:string[];
  permissionLabel?:string;settingsSource?:'desktop'|'transcript'|'agent';settingsError?:string;
}
export interface Message {
  id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string;
  timestamp?: number; label?: string;images?:ImageRef[];files?:FileRef[];
}
export interface HistoryPage { messages: Message[]; cursor: number | null; source: string;questions?:QuestionCard[];questionsAsOf?:number }
export interface RelayEvent {
  id: string; hostId: string; sessionId: string; type: 'message' | 'delta' | 'status' | 'activity' | 'approval' | 'approval.resolved' | 'question' | 'question.resolved' | 'error';
  data: Record<string, any>; at: number;
}
export interface Action {
  repository?:RepositoryRequest;
  launch?:LaunchRequest;
  migration?:MigrationRequest;
  brainstormContext?:string;agentId?:string;workspaceId?:string;includeCaptures?:boolean;artifactPath?:string;artifactHash?:string;videoOffset?:number;videoLength?:number;videoVersion?:string;
  id: string; type: 'start' | 'send' | 'steer' | 'cancel-input' | 'stop' | 'approve' | 'answer' | 'history' | 'asset' | 'file' | 'models' | 'commands' | 'set-model' | 'upload' | 'direct' | 'create-project' | 'set-permissions' | 'prepare-workspace' | 'prepare-brainstorm' | 'studio-artifact' | 'studio-video' | 'studio-migration' | 'studio-launch' | 'studio-repository';
  sessionId?: string; provider?: Provider; projectId?: string;
  live?:boolean;
  text?: string; assetId?:string;queuedId?:string; approvalId?: string; allow?: boolean; cursor?: number; model?: string;effort?:string; workspaceIndex?:number;attachmentIds?:string[];upload?:FilePayload;
  offer?:DirectOffer;
  fileId?:string;
  relay?:boolean;iceServers?:DirectIceServer[];
  questionId?:string;answers?:Record<string,string[]>;queueOnly?:boolean;
  permissionMode?:PermissionMode;approvalScope?:'once'|'session';projectName?:string;projectPath?:string;createFolder?:boolean;
}
export interface Host { agents?:AgentInfo[]; id: string; name: string; hostname?: string; platform?: string; projects: Project[]; online: boolean; lastSeen: number;capabilities?:{createProject?:boolean;permissions?:boolean;studioWorkspaces?:boolean;studioArtifacts?:boolean;studioLaunch?:boolean;studioMigration?:boolean;studioRepository?:boolean;studioRepositoryConnect?:boolean;brainstorm?:boolean}; sync?:{done:number;total:number;pages:number;state:string;errors:number} }
export interface AgentModel { id: string; name: string; description?: string; isDefault?: boolean;efforts?:string[];defaultEffort?:string;aliases?:string[] }
export interface AgentCommand {name:string;description:string;argumentHint?:string;source?:'relay'|'claude'}
export const sessionKey = (host: string, provider: Provider, nativeId: string) => `${host}:${provider}:${nativeId}`;
export const MAX_TEXT = 32_000;
export function validateAction(value: any): Action {
  if (!value || typeof value !== 'object' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value.id ?? '')) throw new Error('Invalid action ID');
  if (!['start', 'send', 'steer', 'cancel-input', 'stop', 'approve', 'answer', 'history', 'asset', 'file', 'models', 'commands', 'set-model','upload','direct','create-project','set-permissions','prepare-workspace','prepare-brainstorm','studio-artifact','studio-video','studio-migration','studio-launch','studio-repository'].includes(value.type)) throw new Error('Unknown action');
  if(value.repository!==undefined&&value.type!=='studio-repository')throw Error('无效仓库同步参数');
  if(value.type==='studio-repository'){validateRepositoryRequest(value.repository);if(value.repository.op!=='connect'&&(typeof value.projectId!=='string'||!value.projectId||value.projectId.length>100))throw Error('请选择本机仓库');}
  if(value.launch!==undefined&&value.type!=='studio-launch')throw Error('启动参数只能用于启动操作');
  if(value.type==='studio-launch'){const l=value.launch;if(!l||!['inspect','start','status'].includes(l.op)||!uploadId.test(value.workspaceId??''))throw Error('无效本机启动请求');launchTargets([l.target]);if(l.op==='start'&&!/^[a-f0-9]{64}$/.test(l.hash??''))throw Error('启动脚本版本未核对');if(l.op==='status'&&!uploadId.test(l.requestId??''))throw Error('无效启动回执 ID');}
  if(value.migration!==undefined&&value.type!=='studio-migration')throw Error('迁移参数只能用于迁移操作');
  if(value.type==='studio-migration'){
    const m=value.migration;
    if(!m||!uploadId.test(m.id??'')||!['probe','freeze','export','read','write','status','import'].includes(m.op))throw Error('无效迁移操作');
    if(['probe','freeze','export','import'].includes(m.op)&&(!uploadId.test(value.workspaceId??'')||typeof value.projectId!=='string'||!value.projectId||value.projectId.length>100))throw Error('无效迁移工作副本');
    if(['read','write'].includes(m.op)&&(!Number.isInteger(m.file)||m.file<0||m.file>=100||!Number.isSafeInteger(m.offset)||m.offset<0))throw Error('无效迁移分段');
    if(m.data!==undefined&&(m.op!=='write'||typeof m.data!=='string'||m.data.length>Math.ceil(MIGRATION_CHUNK/3)*4))throw Error('无效迁移数据');
    if(m.manifest!==undefined){validateManifest(m.manifest);if(m.manifest.id!==m.id)throw Error('迁移清单 ID 不匹配');}
    if(m.paths!==undefined&&(m.op!=='export'||!Array.isArray(m.paths)||m.paths.length>1000||m.paths.some((p:unknown)=>typeof p!=='string'||p.length>2000||/[\x00\r\n]/.test(p))))throw Error('无效迁移成果清单');
  }
  if(value.permissionMode!==undefined&&(!['start','set-permissions'].includes(value.type)||!['request','auto','full'].includes(value.permissionMode)))throw new Error('无效权限模式');
  if(value.type==='set-permissions'&&!value.permissionMode)throw new Error('请选择权限模式');
  if(value.approvalScope!==undefined&&(value.type!=='approve'||!['once','session'].includes(value.approvalScope)||value.approvalScope==='session'&&value.allow!==true))throw new Error('无效批准范围');
  if(value.type==='create-project'&&(typeof value.projectName!=='string'||!value.projectName.trim()||value.projectName.length>100||/[\r\n\x00]/.test(value.projectName)||typeof value.projectPath!=='string'||!value.projectPath.trim()||value.projectPath.length>2000||/[\r\n\x00]/.test(value.projectPath)||value.createFolder!==undefined&&typeof value.createFolder!=='boolean'))throw new Error('请输入项目名称和工作电脑上的文件夹绝对路径');
  if(value.brainstormContext!==undefined&&(!['start','send'].includes(value.type)||typeof value.brainstormContext!=='string'||value.brainstormContext.length>18000))throw Error('无效项目组上下文');
  if(value.type==='prepare-brainstorm'&&(!uploadId.test(value.workspaceId??'')||typeof value.projectId!=='string'||!value.projectId||value.projectId.length>100))throw Error('无效讨论 ID');
  if(value.workspaceId!==undefined&&!['prepare-workspace','prepare-brainstorm','studio-migration','studio-launch','studio-repository'].includes(value.type))throw Error('无效工作目录请求');
  if(value.includeCaptures!==undefined&&(value.type!=='prepare-workspace'||typeof value.includeCaptures!=='boolean'))throw Error('无效截图复制设置');
  if(value.type==='prepare-workspace'&&(!/^[a-f0-9-]{36}$/i.test(value.workspaceId??'')||typeof value.projectId!=='string'||!value.projectId||value.projectId.length>100))throw new Error('无效需求工作副本');
  if([value.videoOffset,value.videoLength,value.videoVersion].some(x=>x!==undefined)&&(value.type!=='studio-video'||!Number.isSafeInteger(value.videoOffset)||value.videoOffset<0||!Number.isSafeInteger(value.videoLength)||value.videoLength<1||value.videoLength>262144||!/^[a-f0-9]{64}$/.test(value.videoVersion??'')))throw Error('无效视频分段');
  if(value.artifactHash!==undefined&&(value.type!=='studio-artifact'||!/^[a-f0-9]{64}$/.test(value.artifactHash)))throw Error('无效原画版本');
  if(value.artifactPath!==undefined&&!['studio-artifact','studio-video'].includes(value.type))throw Error('原画路径只能用于原画读取请求');
  if(['studio-artifact','studio-video'].includes(value.type)&&(typeof value.artifactPath!=='string'||!value.artifactPath.trim()||value.artifactPath.length>2000||/[\x00\r\n]/.test(value.artifactPath)))throw Error('无效原画请求');
  if(value.type==='file'&&!uploadId.test(value.fileId??''))throw new Error('无效附件 ID');
  if(value.queueOnly!==undefined&&(value.type!=='stop'||typeof value.queueOnly!=='boolean'))throw new Error('无效停止方式');
  if(value.live!==undefined&&(value.type!=='history'||typeof value.live!=='boolean'||value.cursor!==undefined))throw new Error('Invalid live history request');
  if(value.type==='answer'&&(!/^[a-f0-9-]{36}$/i.test(value.questionId??'')||!value.answers||typeof value.answers!=='object'||Array.isArray(value.answers)||JSON.stringify(value.answers).length>30000))throw new Error('无效问题回答');
  if(value.type==='direct'&&(!validDirectSdp(value.offer,'offer',value.relay===true)||Boolean(value.sessionId)===Boolean(value.projectId)||value.relay!==undefined&&typeof value.relay!=='boolean'||value.iceServers!==undefined&&(!value.relay||!validTurnServers(value.iceServers))))throw new Error('无效直连协商或目标');
  if(value.attachmentIds!==undefined&&(!['start','send','prepare-workspace'].includes(value.type)||!Array.isArray(value.attachmentIds)||value.attachmentIds.length>MAX_ATTACHMENTS||new Set(value.attachmentIds).size!==value.attachmentIds.length||!value.attachmentIds.every((id:unknown)=>typeof id==='string'&&uploadId.test(id))))throw new Error('无效附件列表');
  if(value.type==='upload'&&(!value.upload||typeof value.upload.scope!=='string'||value.upload.scope.length>400||!value.upload.file||!uploadId.test(value.upload.file.id??'')||typeof value.upload.data!=='string'))throw new Error('无效附件上传');
  if(value.type==='asset'&&!(/^[a-f0-9]{64}$/).test(value.assetId??''))throw new Error('Invalid image ID');
  if (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || value.sessionId.length > 250)) throw new Error('Invalid session');
  if (['start', 'send'].includes(value.type) && (typeof value.text !== 'string' || (!value.text.trim()&&!value.attachmentIds?.length) || value.text.length > MAX_TEXT)) throw new Error('请输入消息或选择附件');
  if(['steer','cancel-input'].includes(value.type)&&!(/^[a-zA-Z0-9_-]{8,100}$/).test(value.queuedId??''))throw new Error('Queued message required');
  if (value.type === 'start' && (!['codex', 'claude', 'api'].includes(value.provider) || typeof value.projectId !== 'string' || value.projectId.length > 100)) throw new Error('Choose an agent and configured project');
  if (!['start','models','upload','direct','create-project','prepare-workspace','prepare-brainstorm','studio-migration','studio-repository'].includes(value.type) && !value.sessionId) throw new Error('Session required');
  if(value.agentId!==undefined&&!/^[a-zA-Z0-9_-]{1,60}$/.test(value.agentId))throw new Error('Invalid agent ID');
  if(['start','models'].includes(value.type)&&value.provider==='api'&&!value.agentId)throw new Error('Select an API agent');
  if(value.type==='models'&&!['codex','claude','api'].includes(value.provider))throw new Error('Invalid provider');
  if(value.model!==undefined&&(typeof value.model!=='string'||!value.model.length||value.model.length>150||/[\r\n\x00]/.test(value.model)))throw new Error('Invalid model');
  if(value.effort!==undefined&&(typeof value.effort!=='string'||!['default','none','minimal','low','medium','high','xhigh','max','ultra'].includes(value.effort)))throw new Error('Invalid reasoning effort');
  if(value.type==='set-model'&&!value.model&&!value.effort)throw new Error('Model or effort required');
  if(value.workspaceIndex!==undefined&&(!Number.isInteger(value.workspaceIndex)||value.workspaceIndex<0||value.workspaceIndex>100))throw new Error('Invalid workspace');
  if (value.type === 'approve' && (typeof value.approvalId !== 'string' || value.approvalId.length > 200 || typeof value.allow !== 'boolean')) throw new Error('Invalid approval');
  if (value.cursor !== undefined && (!Number.isSafeInteger(value.cursor) || value.cursor < 0)) throw new Error('Invalid history cursor');
  return Object.fromEntries(Object.entries(value).filter(([k]) => ['repository','launch','migration','videoOffset','videoLength','videoVersion','brainstormContext','artifactHash','artifactPath','includeCaptures','workspaceId','live','agentId','id','type','sessionId','provider','projectId','text','assetId','fileId','queuedId','approvalId','allow','cursor','model','effort','workspaceIndex','attachmentIds','upload','offer','relay','iceServers','questionId','answers','queueOnly','permissionMode','approvalScope','projectName','projectPath','createFolder'].includes(k))) as unknown as Action;
}
