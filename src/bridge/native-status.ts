import {execFileSync,execFile} from 'node:child_process';
import {readFileSync,readdirSync,existsSync,statSync,openSync,readSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Session} from '../shared/protocol.js';

export function codexTailStatus(text:string):Session['status']|undefined {
  let state:Session['status']|undefined;
  for(const line of text.split('\n')){try{const entry=JSON.parse(line),p=entry.payload;
    if(entry.type==='event_msg'){
      if(p?.type==='task_started')state='running';
      if(p?.type==='task_complete')state='idle';
      if(p?.type==='turn_aborted'||p?.type==='task_aborted')state='interrupted';
    }
    if(entry.type==='response_item'){
      if(p?.type==='reasoning'||/^(custom_tool_call|function_call|web_search_call)$/.test(p?.type??'')||(p?.type==='message'&&p.role==='assistant'&&p.phase==='commentary'))state='running';
      if(p?.type==='message'&&p.role==='assistant'&&['final','final_answer'].includes(p.phase))state='idle';
    }
  }catch{/* A bounded tail may start or end within a record. */}}
  return state;
}

export function claudeStatuses(home:string):Map<string,Session['status']>{
  const out=new Map<string,Session['status']>(),dir=join(home,'sessions');if(!existsSync(dir))return out;
  for(const name of readdirSync(dir).filter(n=>n.endsWith('.json'))){
    try{const item=JSON.parse(readFileSync(join(dir,name),'utf8'));if(!Number.isSafeInteger(item.pid)||typeof item.sessionId!=='string')continue;process.kill(item.pid,0);
      const state=String(item.status??'');out.set(item.sessionId,/waiting|permission|approval/.test(state)?'waiting':/busy|working|running|thinking/.test(state)?'running':'idle');
    }catch{/* Expired process registrations are not active sessions. */}
  }return out;
}
function recentCodex(paths:Map<string,string>,sessions:Session[]){
  // Windows may defer a writer's file mtime until its handle closes; prefer the live index too.
  return sessions.filter(s=>s.provider==='codex').filter(s=>{const path=paths.get(s.id);try{return !!path&&path.endsWith('.jsonl')&&Date.now()-Math.max(s.updatedAt,statSync(path).mtimeMs)<3600_000;}catch{return false;}}).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,30);
}
const probeArgs=()=>['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('../../scripts/probe-codex-locks.ps1',import.meta.url))];
const probeInput=(home:string,recent:Session[])=>JSON.stringify(recent.map(s=>({id:s.nativeId,path:join(home,'thread-writer-locks',s.nativeId+'.lock')})));
function statusesWithLocks(paths:Map<string,string>,recent:Session[],locks:Record<string,boolean>){
  const out=new Map<string,Session['status']>();
  for(const session of recent){
    const path=paths.get(session.id)!;let state:Session['status']|undefined;
    try{
      const size=statSync(path).size,start=Math.max(0,size-2*1024*1024),fd=openSync(path,'r'),buffer=Buffer.alloc(size-start);try{readSync(fd,buffer,0,buffer.length,start);}finally{closeSync(fd);}
      const lines=buffer.toString('utf8').split('\n');if(start)lines.shift();
      state=codexTailStatus(lines.join('\n'));
      if(locks[session.nativeId]===true&&state==='running')out.set(session.nativeId,'running');
      else if(state==='idle'||state==='interrupted')out.set(session.nativeId,state);
    }catch{/* Missing or changing files remain history, not asserted running. */}
  }return out;
}
export function codexStatuses(home:string,paths:Map<string,string>,sessions:Session[]):Map<string,Session['status']>{
  if(process.platform!=='win32')return new Map();const recent=recentCodex(paths,sessions);if(!recent.length)return new Map();
  try{return statusesWithLocks(paths,recent,JSON.parse(execFileSync('powershell.exe',probeArgs(),{input:probeInput(home,recent),encoding:'utf8',windowsHide:true,timeout:8000})));}catch{return new Map();}
}
export async function codexStatusesAsync(home:string,paths:Map<string,string>,sessions:Session[]):Promise<Map<string,Session['status']>>{
  if(process.platform!=='win32')return new Map();const recent=recentCodex(paths,sessions);if(!recent.length)return new Map();
  const locks=await new Promise<Record<string,boolean>|undefined>(resolve=>{
    const child=execFile('powershell.exe',probeArgs(),{encoding:'utf8',windowsHide:true,timeout:8000},(error,stdout)=>{try{resolve(error?undefined:JSON.parse(stdout));}catch{resolve(undefined);}});
    child.stdin?.on('error',()=>{});child.stdin?.end(probeInput(home,recent));
  });
  return locks?statusesWithLocks(paths,recent,locks):new Map();
}
