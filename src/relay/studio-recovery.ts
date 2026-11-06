import type {PermissionMode,Provider,RelayEvent} from '../shared/protocol.js';

export interface StudioRecovery {
  retries:number;handoffs:number;checkpointAt:number;nextAt?:number;probeFailures?:number;
  phase:'scheduled'|'checking'|'retrying'|'handoff'|'waiting-input'|'stopped';note?:string;
  handoff?:{sessionId:string;context:string;provider:Provider;agentId?:string;model?:string;effort?:string;permissionMode?:PermissionMode};
}
export const MODEL_RETRY_MS=60_000,MODEL_RETRIES=5;
export function modelConnectionFailure(reason:string){
  if(/denied|approval|permission|unauthori[sz]ed|invalid.api.key|quota|billing|context.{0,20}(?:limit|length)|cancelled|canceled|aborted by|已停止|拒绝|验收/i.test(reason))return false;
  return /(?:connection|network|socket|stream).{0,70}(?:lost|closed|reset|failed|error|disconnect|timeout|timed out)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|stream disconnected|failed to (?:connect|fetch)|(?:model|server).{0,40}(?:capacity|overloaded|unavailable)|(?:HTTP|status|error code)\s*[:=]?\s*(?:429|500|502|503|504)|连接.{0,20}(?:断开|失败|超时)/i.test(reason);
}
export function pendingProducerInput(events:RelayEvent[],questionCount=0,now=Date.now()){
  const questions=new Map<string,{status:string;expiresAt?:number}>(),approvals=new Map<string,number|undefined>();
  for(const e of events){if(e.type==='question'||e.type==='question.resolved')questions.set(e.data.id,{status:e.data.status,expiresAt:e.data.expiresAt});if(e.type==='approval')approvals.set(e.data.approvalId,e.data.expiresAt);if(e.type==='approval.resolved'&&!e.data.unconfirmed)approvals.delete(e.data.approvalId);}
  // Expired cards are no longer actionable. Recovery still verifies the live
  // session and its dispatch receipt before resuming any production work.
  const active=(expiresAt?:number)=>!expiresAt||expiresAt>now;
  return questionCount>0||[...questions.values()].some(q=>['pending','unknown'].includes(q.status)&&active(q.expiresAt))||[...approvals.values()].some(active);
}
export function handoffContext(events:RelayEvent[],output:string){
  const records=events.filter(e=>e.type==='message'||e.type==='error').slice(-30).map(e=>e.type==='error'?'错误：'+e.data.message:String(e.data.role??'')+': '+String(e.data.text??'').slice(-1200)).join('\n');
  return ('上个会话的公开记录（可能截断，先核对磁盘文件；工具命令不代表已经成功）：\n'+records+'\n任务已有进展：\n'+output.slice(-3000)).slice(-8000);
}
