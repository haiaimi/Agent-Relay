import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
// @ts-expect-error Browser module is deliberately plain JavaScript.
import {AssetTransfers} from '../web/direct.js';
const bytes=Buffer.from('asset-content'),id=createHash('sha256').update(bytes).digest('hex');
test('asset client uses binary HTTPS endpoints immediately, coalesces reads and verifies content',async()=>{
 const original=globalThis.fetch,calls:string[]=[],client=new AssetTransfers();
 globalThis.fetch=async(input:any)=>{calls.push(String(input));return new Response(bytes,{headers:{'Content-Type':'image/png','X-Asset-Source':'server-cache'}});};
 try{
  const [a,b]=await Promise.all([client.read({hostId:'pc',sessionId:'pc:codex:a'},'image',{id}),client.read({hostId:'pc',sessionId:'pc:codex:a'},'image',{id})]);
  assert.equal(a,b);assert.equal(a.mode,'服务器缓存');assert.equal(calls.length,1);assert.match(calls[0],/^\/api\/images\//);assert.match(calls[0],/sessionId=pc%3Acodex%3Aa/);
  await client.read({hostId:'pc',sessionId:'pc:codex:b'},'image',{id});assert.equal(calls.length,2);
  globalThis.fetch=async()=>new Response('corrupted');await assert.rejects(client.read({hostId:'pc',sessionId:'pc:codex:c'},'image',{id}),/校验/);
 }finally{await client.reset();globalThis.fetch=original;}
});
test('asset uploads send the raw file with a stable ID and do not use WebRTC',async()=>{
 const original=globalThis.fetch,client=new AssetTransfers(),uploadId=randomUUID(),file=new File([bytes],'说明.txt');let calls=0;
 globalThis.fetch=async(input:any,options:any)=>{calls++;const url=new URL(input,'https://relay.example');assert.equal(url.pathname,'/api/uploads');assert.equal(url.searchParams.get('id'),uploadId);assert.equal(url.searchParams.get('projectId'),'work');assert.equal(options.body,file);assert.equal(options.headers['Content-Type'],'application/octet-stream');return Response.json({file:{id:uploadId,name:file.name,size:file.size}});};
 try{assert.equal((await client.upload({hostId:'pc',projectId:'work'},file,uploadId)).id,uploadId);assert.equal(calls,1);}finally{await client.reset();globalThis.fetch=original;}
});
test('preview bytes use their own cache key and cannot replace the original download',async()=>{
 const original=globalThis.fetch,client=new AssetTransfers(),small=Buffer.from('preview-data');let calls=0;
 globalThis.fetch=async(input:any)=>{calls++;const preview=new URL(input,'https://relay.example').searchParams.has('preview'),data=preview?small:bytes;return new Response(data,{headers:{'X-Content-Sha256':createHash('sha256').update(data).digest('hex')}});};
 try{const target={hostId:'pc',sessionId:'pc:codex:a'},thumb=await client.read(target,'image',{id},false,true),full=await client.read(target,'image',{id});assert.equal(await thumb.blob.text(),'preview-data');assert.equal(await full.blob.text(),'asset-content');assert.equal(calls,2);}finally{await client.reset();globalThis.fetch=original;}
});
