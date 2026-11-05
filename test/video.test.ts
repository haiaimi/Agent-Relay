import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {once} from 'node:events';
import {videoMime} from '../src/shared/video.js';import {FileStore} from '../src/shared/files.js';import {MediaStore,imageBytes} from '../src/shared/media.js';import {imageSources,messageImages,imageSafeJson} from '../src/bridge/media.js';import {createRelay} from '../src/relay/server.js';
const mp4=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.from([0,0,0,0]),Buffer.from('isommp42'),Buffer.from('video-content')]);

test('showcase links and typed video references never enter persistent transcript media caches',()=>{
 const root=mkdtempSync(join(tmpdir(),'relay-showcase-no-cache-')),db=new DatabaseSync(':memory:'),media=new MediaStore(root,db),run=randomUUID(),dir=join(root,'.studio',run,'studio-showcase');mkdirSync(dir,{recursive:true});
 try{const path=join(dir,'recording.mp4'),renamed=join(dir,'renamed.png');writeFileSync(path,mp4);writeFileSync(renamed,mp4);
  for(const raw of ['[Video](.studio/'+run+'/studio-showcase/recording.mp4)',{type:'video',path},{type:'video',path:renamed}])assert.deepEqual(messageImages(media,'pc:codex:showcase',root,{id:randomUUID(),role:'assistant',text:'showcase'},raw).images,[]);
  assert.equal(db.prepare('select count(*) n from media').get()!.n,0);assert.equal(db.prepare('select count(*) n from media_refs').get()!.n,0);
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
test('video containers are sniffed from bytes and scoped attachments never trust filename or supplied MIME',()=>{
 assert.equal(videoMime(mp4),'video/mp4');assert.equal(videoMime(Buffer.from('<html>fake.mp4</html>')),undefined);
 const mov=Buffer.from(mp4);mov.write('qt  ',8,'ascii');assert.equal(videoMime(mov),'video/quicktime');
 assert.equal(videoMime(Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3]),Buffer.from('doctype:webm')])), 'video/webm');
 const root=mkdtempSync(join(tmpdir(),'relay-video-')),db=new DatabaseSync(':memory:');
 try{const store=new FileStore(root,db),file={id:randomUUID(),name:'recording.mp4',size:mp4.length,mime:'image/jpeg',sha256:createHash('sha256').update(mp4).digest('hex')},ref=store.put('a',file,mp4);assert.equal(ref.mime,'video/mp4');assert.throws(()=>store.read('b',ref.id),/不属于/);assert.equal(store.put('a',{...file,id:randomUUID(),name:'fake.mp4',size:4,sha256:createHash('sha256').update('html').digest('hex')},Buffer.from('html')).mime,'application/octet-stream');}
 finally{db.close();rmSync(root,{recursive:true,force:true});}
});
test('agent video links and typed videos sync via media refs, skip quoted tool code, retain cache and enforce hashes',()=>{
 const root=mkdtempSync(join(tmpdir(),'relay-video-links-')),db=new DatabaseSync(':memory:'),store=new MediaStore(root,db),path=join(root,'motion.mp4');writeFileSync(path,mp4);
 try{
  const text='[录屏](motion.mp4)',result=messageImages(store,'session',root,{id:'v',role:'assistant',text},text),ref=result.images![0];assert.equal(ref.mime,'video/mp4');assert.equal(imageSources({type:'video',path}).length,1);assert.equal(imageSources({role:'tool',text:'[not an asset](motion.mp4)'}).length,0);
  assert.equal(store.read('other',ref.id!),undefined);assert.deepEqual(imageBytes(store.payload('session',ref.id!)),mp4);assert.throws(()=>imageBytes({...store.payload('session',ref.id!),mime:'image/png'}));
  const inline='data:video/mp4;base64,'+mp4.toString('base64');assert.ok(!imageSafeJson({type:'video',url:inline}).includes(mp4.toString('base64')));
  rmSync(path);assert.equal(messageImages(store,'session',root,{id:'v',role:'assistant',text},text).images![0].id,ref.id);
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
test('authenticated uploaded and agent videos support seeking ranges, invalid-range handling and session isolation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'relay-video-http-')),relay=createRelay({dataDir:root,phoneToken:'video-test-phone-0123456789abcdef0123456789abcdef',bridgeToken:'video-test-bridge-0123456789abcdef0123456789abcdef'});relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');const base='http://127.0.0.1:'+(relay.server.address() as any).port,sessionId='pc:codex:video';
 try{
  relay.store.session({id:sessionId,hostId:'pc',provider:'codex',nativeId:'video',title:'Video',cwd:root,updatedAt:1,status:'idle'});
  const images=new MediaStore(root,relay.store.db),ref=images.put(sessionId,mp4,'motion.mp4'),files=new FileStore(root,relay.store.db),file=files.put('pc|'+sessionId,{id:randomUUID(),name:'motion.mp4',size:mp4.length,mime:'video/mp4',sha256:ref.id!},mp4);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({token:'video-test-phone-0123456789abcdef0123456789abcdef'})}),cookie=login.headers.get('set-cookie')!.split(';')[0];
  for(const endpoint of ['/api/images/'+ref.id,'/api/files/'+file.id]){
   const url=base+endpoint+'?sessionId='+encodeURIComponent(sessionId);assert.equal((await fetch(url)).status,401);
   const full=await fetch(url,{headers:{cookie}});assert.equal(full.status,200);assert.equal(full.headers.get('content-type'),'video/mp4');assert.deepEqual(Buffer.from(await full.arrayBuffer()),mp4);
   for(const [range,start,end] of [['bytes=4-11',4,11],['bytes=12-',12,mp4.length-1],['bytes=-5',mp4.length-5,mp4.length-1]] as const){const response=await fetch(url,{headers:{cookie,Range:range}});assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),`bytes ${start}-${end}/${mp4.length}`);assert.deepEqual(Buffer.from(await response.arrayBuffer()),mp4.subarray(start,end+1));}
   for(const range of ['bytes=99999-','bytes=10-2','bytes=0-1,3-4','bytes=-0'])assert.equal((await fetch(url,{headers:{cookie,Range:range}})).status,416);
   assert.equal((await fetch(base+endpoint+'?sessionId=other',{headers:{cookie}})).status,404);
  }
 }finally{await relay.close();rmSync(root,{recursive:true,force:true});}
});
