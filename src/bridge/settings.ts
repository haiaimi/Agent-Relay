import {openSync,readSync,closeSync,statSync} from 'node:fs';
import type {Session,Provider} from '../shared/protocol.js';

export type SessionSettings=Pick<Session,'model'|'effort'|'permissionMode'|'permissionLabel'|'settingsSource'>;
const value=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<200?v:undefined;
export function codexSettings(s:any):SessionSettings{
  const approval=s?.approvalPolicy,sandbox=s?.sandboxPolicy??s?.sandbox;
  const type=typeof sandbox==='string'?sandbox:sandbox?.type;
  const full=['dangerFullAccess','danger-full-access'].includes(type),workspace=['workspaceWrite','workspace-write'].includes(type),readonly=['readOnly','read-only'].includes(type);
  const mode=full&&approval==='never'?'full':workspace&&approval==='on-request'?(s.approvalsReviewer==='auto_review'?'auto':s.approvalsReviewer==null||s.approvalsReviewer==='user'?'request':undefined):undefined;
  const label=mode?{full:'完整权限',auto:'帮我批准',request:'请求批准'}[mode]:type?[readonly?'只读':full?'全磁盘访问':workspace?'工作区写入':String(type),approval==='never'?'不请求批准':approval==='on-request'?'请求批准':value(approval)].filter(Boolean).join(' · '):undefined;
  const effort=s?.effort??s?.reasoningEffort;
  return {...value(s?.model)&&{model:s.model},...value(effort)?{effort}:s?.effort===null||s?.reasoningEffort===null?{effort:'default'}:{},...label&&{permissionMode:mode,permissionLabel:label}};
}
export function claudeSettings(s:any):SessionSettings{
  const mode=s?.permissionMode,labels:Record<string,string>={default:'请求批准',acceptEdits:'自动允许编辑',bypassPermissions:'完整权限',plan:'计划模式（只读）',dontAsk:'不请求批准',auto:'帮我批准'};
  return {...value(s?.model)&&s.model!=='<synthetic>'&&{model:s.model},...value(s?.effort)&&{effort:s.effort},...labels[mode]&&{permissionLabel:labels[mode],permissionMode:mode==='bypassPermissions'?'full':mode==='auto'?'auto':mode==='default'?'request':undefined}};
}
export class TranscriptSettings{
  private cache=new Map<string,{size:number;mtime:number;settings:SessionSettings}>();
  read(provider:Provider,path:string):SessionSettings{
    if(!path.endsWith('.jsonl'))return {};
    try{
      const stat=statSync(path),old=this.cache.get(path);if(old?.size===stat.size&&old.mtime===stat.mtimeMs)return old.settings;
      const start=Math.max(0,stat.size-4*1024*1024),buffer=Buffer.alloc(stat.size-start),fd=openSync(path,'r');let n:number;
      try{n=readSync(fd,buffer,0,buffer.length,start);}finally{closeSync(fd);}
      const tail=buffer.subarray(0,n).toString('utf8'),text=start?tail.slice(tail.indexOf('\n')+1):tail;let settings:SessionSettings={};
      for(const raw of text.split('\n'))try{
        const r=JSON.parse(raw);
        if(provider==='codex'&&r.type==='turn_context')settings={...settings,...codexSettings({...r.payload,effort:r.payload.effort??r.payload.reasoning_effort,approvalPolicy:r.payload.approval_policy,sandboxPolicy:r.payload.sandbox_policy,approvalsReviewer:r.payload.approvals_reviewer})};
        if(provider==='claude'&&!r.isSidechain)settings={...settings,...claudeSettings({model:r.type==='assistant'?r.message?.model:r.type==='system'?r.model:undefined,permissionMode:r.permissionMode,effort:r.effort})};
      }catch{/* Incomplete records cannot override known settings. */}
      if(Object.keys(settings).length)settings.settingsSource='transcript';
      this.cache.set(path,{size:stat.size,mtime:stat.mtimeMs,settings});if(this.cache.size>100)this.cache.delete(this.cache.keys().next().value!);return settings;
    }catch{return {};}
  }
}
