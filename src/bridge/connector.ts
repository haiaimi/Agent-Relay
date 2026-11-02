import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import {hostname,platform,arch} from 'node:os';
import { assertRelayUrl, requireSecret } from '../shared/security.js';
import { validateAction, type Session, type RelayEvent } from '../shared/protocol.js';
import { AgentRuntime, type BridgeConfig } from './runtime.js';
import { BridgeStore } from './store.js';
import {BRIDGE_FRAME_BYTES} from '../shared/media.js';

export function startBridge(config:BridgeConfig,token:string){
  requireSecret(token,'BRIDGE_TOKEN');const url=assertRelayUrl(config.relayUrl);
  if(!/^[a-zA-Z0-9_-]{1,60}$/.test(config.hostId)||!config.name||!Array.isArray(config.projects))throw new Error('Invalid bridge identity or projects');
  const store=new BridgeStore(config.dataDir);
  let socket:WebSocket|undefined;let ready=false;let stopped=false;let retries=0;
  let reconnect:NodeJS.Timeout|undefined;let syncing=false;
  const inflight=new Set<string>();const fingerprints=new Map<string,string>();
  let projectFingerprint='';
  let backfilling=false;
  const cacheWaits=new Map<string,{resolve:()=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  const send=(message:unknown)=>{if(ready&&socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message));};
  function publish(sessions:Session[]){
    if(!ready)return;
    const changed=sessions.filter(s=>{const text=JSON.stringify(s);if(fingerprints.get(s.id)===text)return false;fingerprints.set(s.id,text);return true;});
    for(let i=0;i<changed.length;i+=500)send({type:'sessions',sessions:changed.slice(i,i+500)});
  }
  function drain(){
    if(!ready||socket!.bufferedAmount>1024*1024)return;
    for(const event of store.outbox())if(!inflight.has(event.id)) {send({type:'event',event});inflight.add(event.id);}
  }
  const runtime=new AgentRuntime(config,store,publish,(_event:RelayEvent)=>drain());
  const imageSyncs=new Map<string,Promise<void>>();let imageSyncing=false;
  function syncImages(sessionId:string):Promise<void>{
    const prior=imageSyncs.get(sessionId);if(prior)return prior;
    const job=uploadImages(sessionId).finally(()=>imageSyncs.delete(sessionId));imageSyncs.set(sessionId,job);return job;
  }
  async function uploadImages(sessionId:string){
    for(const id of runtime.media.pending(sessionId)){
      if(!ready||stopped)return;
      const jobId=randomUUID(),asset=runtime.media.payload(sessionId,id);
      await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{cacheWaits.delete(jobId);reject(new Error('Image cache acknowledgement timed out'));},60000);cacheWaits.set(jobId,{resolve,reject,timer});send({type:'asset.cache',jobId,sessionId,asset});});
      runtime.media.ack(sessionId,id);
    }
  }
  async function syncPendingImages(){if(imageSyncing||!ready||stopped)return;imageSyncing=true;try{for(const sessionId of runtime.media.pendingSessions())await syncImages(sessionId);}catch(err){console.error('Image sync pending:',(err as Error).message);}finally{imageSyncing=false;}}
  async function backfill(){
    if(backfilling||!ready||stopped||config.syncHistory===false)return;backfilling=true;
    try{
      const sessions=runtime.list();publish(sessions);let done=0,pages=0,errors=0;
      for(const session of sessions){
        if(!ready||stopped)break;
        if(store.synced(session.id)>=session.updatedAt){done++;continue;}
        try{
          let cursor:number|undefined;const visited=new Set<number>();
          do{
            const page=await runtime.history.page(session.id,cursor);const jobId=randomUUID();
            await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{cacheWaits.delete(jobId);reject(new Error('History cache acknowledgement timed out'));},30000);cacheWaits.set(jobId,{resolve,reject,timer});send({type:'history.cache',jobId,sessionId:session.id,cursor,page});});pages++;
            await syncImages(session.id);
            const next=page.cursor;if(next===null)break;if(visited.has(next))throw new Error('History cursor did not advance');visited.add(next);cursor=next;
          }while(ready&&!stopped);
          if(ready&&!stopped)store.markSynced(session.id,session.updatedAt);
        }catch(err){errors++;console.error('History sync skipped a session:',(err as Error).message);}
        done++;send({type:'sync',sync:{state:'syncing',done,total:sessions.length,pages,errors}});
      }
      send({type:'sync',sync:{state:errors?'partial':'complete',done,total:sessions.length,pages,errors}});
    }catch(err){console.error('History backfill failed:',(err as Error).message);}finally{backfilling=false;}
  }
  async function sync(){
    if(syncing||stopped)return;syncing=true;
    try{publish(runtime.list());void syncPendingImages();void runtime.drainInputs().catch(err=>console.error('Queued input failed:',(err as Error).message));const projects=runtime.projects(),fingerprint=JSON.stringify(projects);if(ready&&projectFingerprint!==fingerprint){projectFingerprint=fingerprint;send({type:'projects',projects});}}catch(err){console.error('History inventory failed:',(err as Error).message);}finally{syncing=false;}
  }
  async function action(value:unknown){
    let id='';
    try{
      const command=validateAction(value);id=command.id;
      if(command.sessionId&&!command.sessionId.startsWith(config.hostId+':'))throw new Error('Session belongs to another computer');
      if(command.type==='history'||command.type==='asset'||command.type==='models'||command.type==='commands'||command.type==='upload'){
        await sync();const result=await runtime.handle(command);send({type:'result',id,result});return;
      }
      const previous=store.begin(id,command);
      if(!previous.fresh){const result=previous.result;send(result?.error?{type:'result',id,error:result.error}:{type:'result',id,result});return;}
      try{const result=await runtime.handle(command);store.finish(id,result);send({type:'result',id,result});}
      catch(err){store.finish(id,{error:(err as Error).message});throw err;}
    }catch(err){send({type:'result',id,error:(err as Error).message});}
  }
  function connect(){
    if(stopped)return;
    socket=new WebSocket(url,{headers:{Authorization:`Bearer ${token}`},maxPayload:BRIDGE_FRAME_BYTES,handshakeTimeout:10000,perMessageDeflate:false});
    let lastActivity=Date.now();
    const watchdog=setInterval(()=>{if(Date.now()-lastActivity>70_000)socket?.terminate();},15_000);
    socket.on('ping',()=>{lastActivity=Date.now();});
    socket.on('open',()=>socket!.send(JSON.stringify({type:'hello',host:{id:config.hostId,name:config.name,hostname:hostname(),platform:`${platform()} ${arch()}`,projects:config.projects}})));
    socket.on('message',raw=>{
      lastActivity=Date.now();
      try{
        const message=JSON.parse(raw.toString());
        if(message.type==='welcome') {ready=true;retries=0;fingerprints.clear();inflight.clear();projectFingerprint='';void sync();drain();void backfill();console.log('Connected to relay; agent execution stays on this computer.');}
        else if(message.type==='ack'){store.ack(message.id);inflight.delete(message.id);drain();}
        else if(message.type==='history.ack'){const p=cacheWaits.get(message.jobId);if(p){clearTimeout(p.timer);cacheWaits.delete(message.jobId);p.resolve();}}
        else if(message.type==='asset.ack'){const p=cacheWaits.get(message.jobId);if(p){clearTimeout(p.timer);cacheWaits.delete(message.jobId);message.error?p.reject(new Error(message.error)):p.resolve();}}
        else if(message.type==='action')void action(message.action);
      }catch(err){console.error('Relay message rejected:',(err as Error).message);socket?.close(1008,'Invalid message');}
    });
    socket.on('error',err=>console.error('Relay connection error:',err.message.replaceAll(token,'[redacted]')));
    socket.on('close',()=>{clearInterval(watchdog);ready=false;inflight.clear();for(const p of cacheWaits.values()){clearTimeout(p.timer);p.reject(new Error('Disconnected during history sync'));}cacheWaits.clear();if(!stopped){const delay=Math.min(30000,1000*2**Math.min(retries++,5))+Math.random()*500;reconnect=setTimeout(connect,delay);}});
  }
  const interval=setInterval(()=>{void sync();drain();void backfill();},Math.max(5,config.syncIntervalSeconds??15)*1000);
  connect();
  return {runtime,store,async close(){stopped=true;clearInterval(interval);if(reconnect)clearTimeout(reconnect);ready=false;socket?.terminate();await runtime.close();store.close();}};
}
