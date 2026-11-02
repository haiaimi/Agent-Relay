import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, createReadStream, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { createZstdDecompress } from 'node:zlib';
import { sessionKey, type Session, type Message, type HistoryPage } from '../shared/protocol.js';
import {readCodexProjects,type CodexProjects} from './codex-projects.js';
import {codexStatuses,claudeStatuses} from './native-status.js';
import {imageSources,messageImages} from './media.js';
import type {MediaStore} from '../shared/media.js';

export function itemMessage(item: any, ordinal: number): Message | null {
  if (!item || typeof item !== 'object') return null;
  const id=String((item.type==='userMessage' ? item.clientId : undefined) ?? item.id ?? `native-${ordinal}`);
  if(item.type==='userMessage') return {id,role:'user',text:(item.content ?? []).filter((x:any)=>x.type==='text'||x.type==='input_text').map((x:any)=>x.text).join('\n')};
  if(item.type==='agentMessage') return {id,role:'assistant',text:String(item.text ?? '')};
  if(item.type==='imageView') return {id,role:'assistant',label:'图片预览',text:''};
  if(item.type==='imageGeneration') return {id,role:'assistant',label:'生成的图片',text:item.status==='failed'?String(item.failure?.message??item.failure??'图片生成失败'):['inProgress','in_progress','generating','queued'].includes(item.status)?'图片生成中…':''};
  if(item.type==='commandExecution') return {id,role:'tool',label:`命令 · ${item.status ?? ''}`,text:`${item.command ?? ''}\n${item.aggregatedOutput ?? ''}`.slice(0,24000)};
  if(item.type==='mcpToolCall' || item.type==='dynamicToolCall') return {id,role:'tool',label:String(item.tool ?? '工具'),text:JSON.stringify({arguments:item.arguments,result:item.result,error:item.error}).slice(0,24000)};
  if(item.type==='fileChange') return {id,role:'tool',label:'文件改动',text:JSON.stringify(item.changes ?? []).slice(0,24000)};
  return null;
}
function textContent(value: any): string {
  if(typeof value==='string') return value;
  if(!Array.isArray(value)) return '';
  return value.map(x=> x.type==='text'||x.type==='input_text'||x.type==='output_text' ? x.text : x.type==='tool_use' ? `[${x.name}] ${JSON.stringify(x.input).slice(0,8000)}` : x.type==='tool_result' ? textContent(x.content) : '').filter(Boolean).join('\n');
}
export function transcriptLine(line: any, ordinal: number): Message | null {
  const payload=line.type==='response_item' ? line.payload : null;
  if(payload&&['image_generation_call','imageGeneration','imageView','image_view'].includes(payload.type))return {...itemMessage({...payload,type:payload.type==='image_view'?'imageView':payload.type==='image_generation_call'?'imageGeneration':payload.type},ordinal)!,timestamp:Date.parse(line.timestamp)||undefined};
  if(line.type==='event_msg'&&line.payload?.type==='item_completed'&&['imageView','imageGeneration'].includes(line.payload.item?.type))return {...itemMessage(line.payload.item,ordinal)!,timestamp:Date.parse(line.timestamp)||undefined};
  if(payload?.type==='message' && ['user','assistant'].includes(payload.role)) {
    const text=textContent(payload.content); if(!text&&!imageSources(payload.content).length) return null;
    return {id:`log-${ordinal}`,role:payload.role,text:text.slice(0,32000),timestamp:Date.parse(line.timestamp)||undefined};
  }
  if(['user','assistant'].includes(line.type) && line.message && !line.isMeta) {
    const blocks=Array.isArray(line.message.content)?line.message.content:[];
    const text=typeof line.message.content==='string'?line.message.content:blocks.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n');
    if(text||blocks.some((b:any)=>['image','input_image','local_image','localImage'].includes(b.type)))return {id:line.type==='assistant'?`claude-text:${line.uuid??line.message.id??ordinal}`:line.uuid??`log-${ordinal}`,role:line.type,text:text.slice(0,16000),timestamp:Date.parse(line.timestamp)||undefined};
    const calls=blocks.filter((b:any)=>b.type==='tool_use'),results=blocks.filter((b:any)=>b.type==='tool_result');
    if(calls.length)return {id:`claude-tool:${calls[0].id??line.uuid??ordinal}`,role:'tool',label:calls.map((b:any)=>b.name).join(' · '),text:calls.map((b:any)=>JSON.stringify(b.input)).join('\n').slice(0,16000)};
    if(results.length)return {id:`claude-result:${results[0].tool_use_id??line.uuid??ordinal}`,role:'tool',label:'工具结果',text:results.map((b:any)=>textContent(b.content)).join('\n').slice(0,16000)};
    return null;
  }
  return null;
}
function walk(dir: string): string[] {
  if(!existsSync(dir)) return [];
  return readdirSync(dir,{withFileTypes:true}).flatMap(e=> e.isSymbolicLink() ? [] : e.isDirectory() ? walk(join(dir,e.name)) : [join(dir,e.name)]);
}
export function codexSessionNames(home:string):Map<string,string> {
  const names=new Map<string,string>(),path=join(home,'session_index.jsonl');
  if(!existsSync(path))return names;
  try{for(const raw of readFileSync(path,'utf8').split('\n')){
    try{const row=JSON.parse(raw);if(typeof row.id==='string'&&typeof row.thread_name==='string'&&row.thread_name.trim())names.set(row.id,row.thread_name.trim());}catch{/* An in-progress final line is not yet a title. */}
  }}catch{/* The native thread table remains usable while the index is changing. */}
  return names;
}
export class NativeHistory {
  projectIndex:CodexProjects={projects:[],assignments:new Map(),projectless:new Set(),parents:new Map()};
  private sessions=new Map<string,Session>();
  private paths=new Map<string,string>();
  private claudeMemo=new Map<string,{mtime:number;session:Session}>();
  private statusAt=0;
  private statuses=new Map<string,Session['status']>();
  constructor(readonly hostId:string, readonly codexHome=process.env.CODEX_HOME ?? join(homedir(),'.codex'), readonly claudeHome=process.env.CLAUDE_CONFIG_DIR ?? join(homedir(),'.claude'),readonly media?:MediaStore) {}
  list(refreshStatus=false): Session[] {
    this.projectIndex=readCodexProjects(this.codexHome);
    const names=codexSessionNames(this.codexHome);
    const next=new Map<string,Session>(); const paths=new Map<string,string>();
    const dbPath=join(this.codexHome,'state_5.sqlite');
    if(existsSync(dbPath)) {
      const db=new DatabaseSync(dbPath,{readOnly:true});
      try {
        const columns=db.prepare('PRAGMA table_info(threads)').all().map(r=>String(r.name));const effortColumn=columns.includes('reasoning_effort')?'reasoning_effort':'NULL AS reasoning_effort';
        const rows=db.prepare('SELECT id,title,cwd,updated_at,archived,agent_role,rollout_path,model,'+effortColumn+' FROM threads').all();
        for(const row of rows) {
          const id=sessionKey(this.hostId,'codex',String(row.id));
          const projectId=this.projectIndex.assignments.get(String(row.id));const project=this.projectIndex.projects.find(p=>p.id===projectId);
          next.set(id,{id,hostId:this.hostId,provider:'codex',nativeId:String(row.id),title:names.get(String(row.id))??String(row.title||'Codex 会话'),cwd:String(row.cwd),updatedAt:Number(row.updated_at)*1000,archived:!!row.archived,role:row.agent_role ? String(row.agent_role) : undefined,status:'history',model:row.model?String(row.model):undefined,effort:row.reasoning_effort?String(row.reasoning_effort):undefined,projectId:project?.id,projectName:project?.name,projectSource:project?'codex':undefined});
          paths.set(id,String(row.rollout_path));
        }
      } finally {db.close();}
    }
    for(const file of walk(join(this.claudeHome,'projects')).filter(f=>f.endsWith('.jsonl') && !/[\\/]subagents[\\/]/.test(f))) {
      const mtime=statSync(file).mtimeMs; let memo=this.claudeMemo.get(file);
      if(!memo || memo.mtime!==mtime) {
        const fd=openSync(file,'r');const buffer=Buffer.alloc(128*1024);let n=0;
        try {n=readSync(fd,buffer,0,buffer.length,0);} finally {closeSync(fd);}
        let cwd='', title='', nativeId=basename(file,'.jsonl');
        for(const raw of buffer.subarray(0,n).toString('utf8').split('\n')) {
          try { const line=JSON.parse(raw);cwd ||= line.cwd ?? '';nativeId=line.sessionId ?? nativeId;
            if(line.type==='user' && !line.isMeta && !title) title=textContent(line.message?.content).replace(/\s+/g,' ').slice(0,120);
            if(line.type==='custom-title') title=String(line.customTitle ?? title);
          } catch { /* The last line in the bounded glance may be incomplete. */ }
        }
        // A first image-bearing Claude record may exceed the bounded index glance.
        // Recover complete JSON string fields before its opaque base64 payload.
        if(!cwd){const head=buffer.subarray(0,n).toString('utf8'),field=(name:string)=>{const match=new RegExp('"'+name+'"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")').exec(head);try{return match?JSON.parse(match[1]):'';}catch{return '';}};cwd=field('cwd');nativeId=field('sessionId')||nativeId;title=field('text').replace(/\s+/g,' ').slice(0,120)||title;}
        const id=sessionKey(this.hostId,'claude',nativeId);
        memo={mtime,session:{id,hostId:this.hostId,provider:'claude',nativeId,title:title||'Claude 会话',cwd,updatedAt:mtime,status:'history'}};
        this.claudeMemo.set(file,memo);
      }
      next.set(memo.session.id,memo.session);paths.set(memo.session.id,file);
    }
    if(refreshStatus||Date.now()-this.statusAt>15000){this.statusAt=Date.now();this.statuses=codexStatuses(this.codexHome,paths,[...next.values()]);}
    const liveStatuses=new Map([...this.statuses,...claudeStatuses(this.claudeHome)]);
    for(const session of next.values()){const status=liveStatuses.get(session.nativeId);if(status){session.status=status;session.statusOrigin='native';}}
    this.sessions=next;this.paths=paths;
    return [...next.values()].sort((a,b)=>b.updatedAt-a.updatedAt);
  }
  get(id:string):Session|undefined{return this.sessions.get(id);}
  claudeLiveStatus(nativeId:string):Session['status']|undefined{return claudeStatuses(this.claudeHome).get(nativeId);}
  claudeIsRunning(nativeId:string):boolean {
    const dir=join(this.claudeHome,'sessions');if(!existsSync(dir))return false;
    for(const file of readdirSync(dir).filter(x=>x.endsWith('.json'))) {
      try {const info=JSON.parse(readFileSync(join(dir,file),'utf8'));if(info.sessionId===nativeId && Number.isSafeInteger(info.pid)){process.kill(info.pid,0);return true;}} catch { /* A process may have exited between discovery and inspection. */ }
    }
    return false;
  }
  async page(id:string,cursor?:number):Promise<HistoryPage> {
    const session=this.sessions.get(id);if(!session)throw new Error('Session not found on this computer');
    const historyDB=join(this.codexHome,'thread_history_1.sqlite');
    if(session.provider==='codex' && existsSync(historyDB)) {
      const db=new DatabaseSync(historyDB,{readOnly:true});
      try {
        const hasTimestamp=db.prepare('PRAGMA table_info(thread_items)').all().some(c=>c.name==='created_at_ms');
        const rows=db.prepare('SELECT rollout_ordinal,item_json,'+(hasTimestamp?'created_at_ms':'NULL AS created_at_ms')+' FROM thread_items WHERE thread_id=? AND rollout_ordinal<? ORDER BY rollout_ordinal DESC LIMIT 51').all(session.nativeId,cursor ?? Number.MAX_SAFE_INTEGER);
        if(rows.length) {
          const more=rows.length>50; const visible=rows.slice(0,50).reverse();
          return {source:'Codex 本地历史数据库',cursor:more ? Number(visible[0].rollout_ordinal) : null,messages:visible.map(row=>{const raw=JSON.parse(String(row.item_json)),m=itemMessage(raw,Number(row.rollout_ordinal));if(m&&Number(row.created_at_ms)>0)m.timestamp=Number(row.created_at_ms);return m&&this.media?messageImages(this.media,id,session.cwd,m,raw):m;}).filter((x):x is Message=>x!==null).map(m=>({...m,text:m.text.slice(0,16000)+(m.text.length>16000?'\n[长消息显示已截断]':'')}))};
        }
      } finally {db.close();}
    }
    let path=this.paths.get(id)!;if(!existsSync(path) && existsSync(path+'.zst'))path+='.zst';
    if(!existsSync(path))throw new Error('Local transcript file is unavailable');
    const source=createReadStream(path);const input=path.endsWith('.zst') ? source.pipe(createZstdDecompress()) : source;
    source.on('error',e=>input.destroy(e));
    const lines=createInterface({input,crlfDelay:Infinity});
    const found:{ordinal:number;message:Message}[]=[]; let ordinal=0;
    try {
      for await(const raw of lines) {
        const index=ordinal++;if(cursor!==undefined && index>=cursor)break;
        if(raw.length>24*1024*1024)continue;
        try {const data=JSON.parse(raw),m=transcriptLine(data,index);if(m){found.push({ordinal:index,message:this.media?messageImages(this.media,id,session.cwd,m,data):m});if(found.length>51)found.shift();}}catch{/* Skip incomplete native writes and unknown record types. */}
      }
    } finally {lines.close();input.destroy();source.destroy();}
    const more=found.length>50;const visible=found.slice(-50);
    return {source:path.endsWith('.zst')?'本地压缩日志':'本地会话日志',cursor:more ? visible[0].ordinal : null,messages:visible.map(x=>x.message)};
  }
}
