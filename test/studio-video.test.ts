import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readdirSync,appendFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';import {once} from 'node:events';import {createServer} from 'node:http';
import {studioVideo,VIDEO_CHUNK} from '../src/bridge/studio-video.js';import {streamStudioVideo} from '../src/relay/studio-video.js';import {validateAction} from '../src/shared/protocol.js';
// A container-signature fixture tests transport only, not playback acceptance.
test('workstation video ranges stay bounded, support seeking and do not create relay files',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-video-')),local=join(dir,'local'),relay=join(dir,'relay');mkdirSync(local);mkdirSync(relay);const bytes=Buffer.alloc(800000,7);bytes.writeUInt32BE(24,0);bytes.write('ftypisom',4);writeFileSync(join(local,'showcase.mp4'),bytes);
 const session:any={projectId:'studio-'+randomUUID(),cwd:local},target={hostId:'pc',sessionId:'pc:codex:fixture',path:'showcase.mp4'};let maxChunk=0,reads=0,active=0,peak=0;
 const server=createServer((req,res)=>void streamStudioVideo(req,res,target,async(_host,a)=>{const part=studioVideo(session,a.artifactPath!,local,a.videoOffset,a.videoLength,a.videoVersion);if('data'in part){active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,a.videoOffset===123?20:5));active--;maxChunk=Math.max(maxChunk,Buffer.from(part.data!,'base64').length);reads++;}return part;}).catch(()=>{if(!res.headersSent)res.writeHead(400);res.end();}));server.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+(server.address() as any).port;
 try{
  const response=await fetch(url,{headers:{Range:'bytes=123-700123'}});assert.equal(response.status,206);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('x-accel-buffering'),'no');assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(123,700124));assert.ok(maxChunk<=VIDEO_CHUNK);assert.ok(reads>=3);assert.ok(peak>1&&peak<=4,'bounded concurrent chunks with ordered response');assert.deepEqual(readdirSync(relay),[]);
  const suffix=await fetch(url,{headers:{Range:'bytes=-20'}});assert.deepEqual(Buffer.from(await suffix.arrayBuffer()),bytes.subarray(-20));assert.equal((await fetch(url,{headers:{Range:'bytes=900000-'}})).status,416);
  const before=reads,head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(reads,before);
  assert.throws(()=>studioVideo(session,'../outside.mp4',local),/超出/);const info=studioVideo(session,'showcase.mp4',local);appendFileSync(join(local,'showcase.mp4'),'changed');assert.throws(()=>studioVideo(session,'showcase.mp4',local,0,100,info.version),/变化/);
  assert.throws(()=>validateAction({id:randomUUID(),type:'studio-video',sessionId:target.sessionId,artifactPath:'showcase.mp4',videoOffset:0,videoLength:VIDEO_CHUNK+1,videoVersion:info.version}),/分段/);
 }finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});
test('closing a video response stops prefetch and later failures are observed',async()=>{
 let reads=0;const size=256*1024*20,version='a'.repeat(64);
 const res:any={destroyed:false,writeHead(){},write(){this.destroyed=true;return true;},end(){}};
 await streamStudioVideo({headers:{}} as any,res,{hostId:'pc',sessionId:'fixture',path:'clip.mp4'},async(_host,a)=>{
  if(a.videoOffset===undefined)return {size,mime:'video/mp4',version,name:'clip.mp4'};
  reads++;if(a.videoOffset>0){await new Promise(r=>setTimeout(r,5));throw Error('disconnected');}
  return {version,offset:0,data:Buffer.alloc(a.videoLength!).toString('base64')};
 });
 await new Promise(r=>setTimeout(r,15));assert.equal(reads,4);
});
