import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Action} from '../shared/protocol.js';
import {randomUUID} from 'node:crypto';

type Target={hostId:string;sessionId:string;path:string};
export async function streamStudioVideo(req:IncomingMessage,res:ServerResponse,target:Target,remote:(host:string,action:Action)=>Promise<any>){
  const action={type:'studio-video' as const,sessionId:target.sessionId,artifactPath:target.path};
  const info=await remote(target.hostId,{id:randomUUID(),...action});
  if(!Number.isSafeInteger(info.size)||info.size<1||!/^video\//.test(info.mime)||!/^[a-f0-9]{64}$/.test(info.version))throw Error('工作电脑未返回有效视频信息');
  let start=0,end=info.size-1;const range=req.headers.range,match=range&&/^bytes=(\d*)-(\d*)$/.exec(range);
  if(range){if(!match||!(match[1]||match[2]))start=info.size;else if(!match[1]){const n=Number(match[2]);start=n>0?Math.max(0,info.size-n):info.size;}else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}}
  const headers={'Content-Type':info.mime,'Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-Accel-Buffering':'no','X-Asset-Source':'workstation-stream','ETag':'"'+info.version+'"','Content-Disposition':"inline; filename*=UTF-8''"+encodeURIComponent(info.name)};
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start> end||start>=info.size){res.writeHead(416,{...headers,'Content-Range':'bytes */'+info.size,'Content-Length':0});res.end();return;}
  res.writeHead(range?206:200,{...headers,'Content-Length':end-start+1,...range?{'Content-Range':`bytes ${start}-${end}/${info.size}`}:{}});
  if(req.method==='HEAD'){res.end();return;}
  // Keep at most 1 MiB in flight; ordered writes support seeking without a
  // full-file server cache or paying one network round trip for every chunk.
  let next=start;const pending:Promise<{bytes:Buffer;error?:never}|{error:unknown;bytes?:never}>[]=[];
  const fill=()=>{while(next<=end&&pending.length<4&&!res.destroyed){const offset=next,length=Math.min(256*1024,end-offset+1);next+=length;pending.push((async()=>{try{const part=await remote(target.hostId,{id:randomUUID(),...action,videoOffset:offset,videoLength:length,videoVersion:info.version});const bytes=Buffer.from(part.data??'','base64');if(part.version!==info.version||part.offset!==offset||bytes.length!==length)throw Error('视频分段不完整或文件已变化');return {bytes};}catch(error){return {error};}})());}};
  fill();while(pending.length&&!res.destroyed){
    const part=await pending.shift()!;if(res.destroyed)return;if('error'in part)throw part.error;
    if(!res.write(part.bytes!))await new Promise<void>(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});
    fill();
  }
  if(!res.destroyed)res.end();
}
