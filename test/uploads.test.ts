import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {FileStore,MAX_UPLOAD_BYTES} from '../src/shared/files.js';
import {BridgeStore} from '../src/bridge/store.js';
import {createRelay} from '../src/relay/server.js';
import {startBridge} from '../src/bridge/connector.js';
import {directClient} from './helpers/direct-client.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=','base64');
const meta=(name:string,bytes:Buffer)=>({id:randomUUID(),name,size:bytes.length,mime:'image/jpeg',sha256:createHash('sha256').update(bytes).digest('hex')});
async function until(fn:()=>boolean){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,20));}throw new Error('Timed out');}
test('attachment storage enforces scope, names, hash, ID collisions and total size',()=>{
 const root=mkdtempSync(join(tmpdir(),'relay-file-unit-')),db=new BridgeStore(root),files=new FileStore(root,db.db);try{
   const ref=files.put('a',meta('image.png',png),png);assert.equal(ref.mime,'image/png');assert.deepEqual(files.read('a',ref.id).bytes,png);
   assert.throws(()=>files.read('b',ref.id),/不属于/);assert.throws(()=>files.put('a',meta('../bad.txt',png),png),/文件名/);assert.throws(()=>files.put('a',meta('CON.txt',png),png),/文件名/);
   assert.throws(()=>files.put('a',{...ref,sha256:'0'.repeat(64)},png),/校验/);assert.throws(()=>files.put('a',{...ref,name:'other.png'},png),/冲突/);
   assert.throws(()=>files.put('a',meta('large.bin',png),Buffer.alloc(MAX_UPLOAD_BYTES+1)),/16 MB/);
   files.link('a','b',ref.id);assert.equal(files.ref('b',ref.id).id,ref.id);
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
test('phone uploads raw HTTP files through relay, resumes agents and downloads scoped cached files offline',async()=>{
 const root=mkdtempSync(join(tmpdir(),'relay-file-e2e-')),work=join(root,'work');mkdirSync(work);
 const phone=randomUUID(),token=randomUUID(),relay=createRelay({dataDir:join(root,'relay'),phoneToken:phone,bridgeToken:token});relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');const base='http://127.0.0.1:'+(relay.server.address() as any).port;
 const bridge=startBridge({relayUrl:base.replace('http','ws')+'/bridge',hostId:'test',name:'test',dataDir:join(root,'bridge'),projects:[{id:'work',name:'work',path:work}],codexHome:join(root,'empty'),claudeHome:join(root,'empty'),syncHistory:false,codexCommand:process.execPath,codexArgs:[fileURLToPath(new URL('./fixtures/codex.mjs',import.meta.url))]},token);
 let cookie='',claudeInput:any,bridgeClosed=false;
 const request=async(path:string,body?:any,bytes?:Buffer,authenticated=true)=>{const r=await fetch(base+path,{method:body!==undefined||bytes?'POST':'GET',headers:{Origin:base,...(authenticated?{cookie}:{}),...(bytes?{'Content-Type':'application/octet-stream'}:body!==undefined?{'Content-Type':'application/json'}:{})},body:bytes??(body!==undefined?JSON.stringify(body):undefined)});return r;};
 const json=async(path:string,body?:any)=>{const r=await request(path,body),v=await r.json();if(!r.ok)throw new Error(JSON.stringify(v));return v as any;};
 const action=(value:any)=>json('/api/actions',{id:randomUUID(),...value});
 const peers=new Map<string,Awaited<ReturnType<typeof directClient>>>();
 const peer=async(sessionId?:string)=>{const key=sessionId??'project:work';if(!peers.has(key))peers.set(key,await directClient(offer=>json('/api/direct',{hostId:'test',...(sessionId?{sessionId}:{projectId:'work'}),offer})));return peers.get(key)!;};
 const upload=async(name:string,bytes:Buffer,sessionId?:string)=>{const query=new URLSearchParams({hostId:'test',name,id:randomUUID(),...(sessionId?{sessionId}:{projectId:'work'})});const response=await request('/api/uploads?'+query,undefined,bytes);assert.equal(response.status,200);return (await response.json() as any).file;};

 try{
  await until(()=>relay.store.hosts().length===1);
  const login=await request('/api/login',{token:phone});cookie=login.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await request('/api/uploads?hostId=test&projectId=work&name=a.png',undefined,png,false)).status,401);
  const image=await upload('image.png',png),notes=await upload('notes.txt',Buffer.from('ATTACHMENT_TEXT_OK'));
  const result=await action({type:'start',hostId:'test',provider:'codex',projectId:'work',text:'verify-attachments',attachmentIds:[image.id,notes.id]});
  await until(()=>relay.store.sessionEvents(result.sessionId).some(e=>e.data.text==='ATTACHMENT_INPUT_OK'));
  await until(()=>relay.store.getSession(result.sessionId)?.status==='idle');
  await action({type:'send',sessionId:result.sessionId,text:'wait'});
  const queuedId=randomUUID();await json('/api/actions',{id:queuedId,type:'send',sessionId:result.sessionId,text:'verify-steer-attachments',attachmentIds:[image.id,notes.id]});
  assert.equal((await action({type:'steer',sessionId:result.sessionId,queuedId})).mode,'active-turn');
  await until(()=>relay.store.sessionEvents(result.sessionId).some(e=>e.data.text==='ATTACHMENT_STEER_OK'));
  const path='/api/files/'+notes.id+'?sessionId='+encodeURIComponent(result.sessionId);assert.equal((await (await peer(result.sessionId)).read('file',notes.id)).bytes.toString(),'ATTACHMENT_TEXT_OK');assert.equal(await (await request(path)).text(),'ATTACHMENT_TEXT_OK');assert.equal((await request(path,undefined,undefined,false)).status,401);
  // Existing direct-uploaded attachments have only an index on the server; fetch on first HTTP read.
  const legacy=await (await peer(result.sessionId)).upload('legacy.txt',Buffer.from('legacy-content'));
  assert.throws(()=>new FileStore(join(root,'relay'),relay.store.db).read('test|'+result.sessionId,legacy.id));
  assert.equal(await (await request('/api/files/'+legacy.id+'?sessionId='+encodeURIComponent(result.sessionId))).text(),'legacy-content');
  const own=await upload('private.txt',Buffer.from('private'),result.sessionId);
  const second=await action({type:'start',hostId:'test',provider:'codex',projectId:'work',text:'normal'});
  await assert.rejects((await peer(second.sessionId)).read('file',own.id),/不属于/);
  assert.notEqual((await request('/api/files/'+own.id+'?sessionId='+encodeURIComponent(second.sessionId))).status,200);
  assert.equal((await request('/api/actions',{id:randomUUID(),type:'send',sessionId:second.sessionId,text:'wrong scope',attachmentIds:[own.id]})).status,400);
  (bridge.runtime as any).claudeQuery=({prompt}:any)=>{const gen=(async function*(){for await(const input of prompt){claudeInput=input;yield {type:'result',is_error:false};break;}})();return Object.assign(gen,{close(){}});};
  await action({type:'start',hostId:'test',provider:'claude',projectId:'work',text:'Read attachments',attachmentIds:[image.id,notes.id]});await until(()=>!!claudeInput);
  assert.equal(claudeInput.message.content[1].type,'image');assert.equal(claudeInput.message.content[1].source.data,png.toString('base64'));assert.match(claudeInput.message.content[0].text,/notes\.txt:/);
  const user=relay.store.sessionEvents(result.sessionId).find(e=>e.data.files?.length);assert.equal(user?.data.files.length,2);
  const repeatId=randomUUID(),repeat='/api/uploads?hostId=test&projectId=work&name=repeat.png&id='+repeatId;
  assert.equal((await request(repeat,undefined,png)).status,200);assert.equal((await request(repeat,undefined,png)).status,200);
  assert.equal(relay.store.db.prepare("SELECT count(*) n FROM actions WHERE request LIKE '%\"type\":\"upload\"%'").get()!.n,0);
  assert.deepEqual(new FileStore(join(root,'relay'),relay.store.db).read('test|'+result.sessionId,image.id).bytes,png);
  for(const c of peers.values())await c.close();await bridge.close();bridgeClosed=true;assert.equal((await request('/api/files/'+image.id+'?sessionId='+encodeURIComponent(result.sessionId))).status,200);
 }finally{for(const c of peers.values())await c.close();if(!bridgeClosed)await bridge.close();await relay.close();rmSync(root,{recursive:true,force:true});}
});
