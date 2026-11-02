import type {ImageRef} from './media.js';
import {uploadId,MAX_ATTACHMENTS,type FileRef,type FilePayload} from './files.js';
export type Provider = 'codex' | 'claude';
export type Status = 'history' | 'running' | 'idle' | 'waiting' | 'failed' | 'interrupted';
export interface Project { id: string; name: string; path: string; roots?: string[]; source?: 'codex'|'configured'; nativeProjectId?:string }
export interface Session {
  id: string; hostId: string; provider: Provider; nativeId: string;
  title: string; cwd: string; updatedAt: number; status: Status;
  archived?: boolean; managed?: boolean; canSteer?:boolean; role?: string; model?: string; effort?:string;nextModel?:string;nextEffort?:string; projectId?:string; projectName?:string; projectSource?:string;statusOrigin?:'relay'|'native';pendingCount?:number;pendingIds?:string[];
}
export interface Message {
  id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string;
  timestamp?: number; label?: string;images?:ImageRef[];files?:FileRef[];
}
export interface HistoryPage { messages: Message[]; cursor: number | null; source: string }
export interface RelayEvent {
  id: string; hostId: string; sessionId: string; type: 'message' | 'delta' | 'status' | 'approval' | 'approval.resolved' | 'error';
  data: Record<string, any>; at: number;
}
export interface Action {
  id: string; type: 'start' | 'send' | 'steer' | 'cancel-input' | 'stop' | 'approve' | 'history' | 'asset' | 'models' | 'commands' | 'set-model' | 'upload';
  sessionId?: string; provider?: Provider; projectId?: string;
  text?: string; assetId?:string;queuedId?:string; approvalId?: string; allow?: boolean; cursor?: number; model?: string;effort?:string; workspaceIndex?:number;attachmentIds?:string[];upload?:FilePayload;
}
export interface Host { id: string; name: string; hostname?: string; platform?: string; projects: Project[]; online: boolean; lastSeen: number; sync?:{done:number;total:number;pages:number;state:string;errors:number} }
export interface AgentModel { id: string; name: string; description?: string; isDefault?: boolean;efforts?:string[];defaultEffort?:string;aliases?:string[] }
export interface AgentCommand {name:string;description:string;argumentHint?:string;source?:'relay'|'claude'}
export const sessionKey = (host: string, provider: Provider, nativeId: string) => `${host}:${provider}:${nativeId}`;
export const MAX_TEXT = 32_000;
export function validateAction(value: any): Action {
  if (!value || typeof value !== 'object' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value.id ?? '')) throw new Error('Invalid action ID');
  if (!['start', 'send', 'steer', 'cancel-input', 'stop', 'approve', 'history', 'asset', 'models', 'commands', 'set-model','upload'].includes(value.type)) throw new Error('Unknown action');
  if(value.attachmentIds!==undefined&&(!['start','send'].includes(value.type)||!Array.isArray(value.attachmentIds)||value.attachmentIds.length>MAX_ATTACHMENTS||new Set(value.attachmentIds).size!==value.attachmentIds.length||!value.attachmentIds.every((id:unknown)=>typeof id==='string'&&uploadId.test(id))))throw new Error('无效附件列表');
  if(value.type==='upload'&&(!value.upload||typeof value.upload.scope!=='string'||value.upload.scope.length>400||!value.upload.file||!uploadId.test(value.upload.file.id??'')||typeof value.upload.data!=='string'))throw new Error('无效附件上传');
  if(value.type==='asset'&&!(/^[a-f0-9]{64}$/).test(value.assetId??''))throw new Error('Invalid image ID');
  if (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || value.sessionId.length > 250)) throw new Error('Invalid session');
  if (['start', 'send'].includes(value.type) && (typeof value.text !== 'string' || (!value.text.trim()&&!value.attachmentIds?.length) || value.text.length > MAX_TEXT)) throw new Error('请输入消息或选择附件');
  if(['steer','cancel-input'].includes(value.type)&&!(/^[a-zA-Z0-9_-]{8,100}$/).test(value.queuedId??''))throw new Error('Queued message required');
  if (value.type === 'start' && (!['codex', 'claude'].includes(value.provider) || typeof value.projectId !== 'string' || value.projectId.length > 100)) throw new Error('Choose an agent and configured project');
  if (!['start','models','upload'].includes(value.type) && !value.sessionId) throw new Error('Session required');
  if(value.type==='models'&&!['codex','claude'].includes(value.provider))throw new Error('Invalid provider');
  if(value.model!==undefined&&(typeof value.model!=='string'||!value.model.length||value.model.length>150||/[\r\n\x00]/.test(value.model)))throw new Error('Invalid model');
  if(value.effort!==undefined&&(typeof value.effort!=='string'||!['default','none','minimal','low','medium','high','xhigh','max','ultra'].includes(value.effort)))throw new Error('Invalid reasoning effort');
  if(value.type==='set-model'&&!value.model&&!value.effort)throw new Error('Model or effort required');
  if(value.workspaceIndex!==undefined&&(!Number.isInteger(value.workspaceIndex)||value.workspaceIndex<0||value.workspaceIndex>100))throw new Error('Invalid workspace');
  if (value.type === 'approve' && (typeof value.approvalId !== 'string' || value.approvalId.length > 200 || typeof value.allow !== 'boolean')) throw new Error('Invalid approval');
  if (value.cursor !== undefined && (!Number.isSafeInteger(value.cursor) || value.cursor < 0)) throw new Error('Invalid history cursor');
  return Object.fromEntries(Object.entries(value).filter(([k]) => ['id','type','sessionId','provider','projectId','text','assetId','queuedId','approvalId','allow','cursor','model','effort','workspaceIndex','attachmentIds','upload'].includes(k))) as unknown as Action;
}
