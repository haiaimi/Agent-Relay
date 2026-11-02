import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
import {MediaStore,MAX_IMAGE_BYTES} from '../src/shared/media.js';
import {imageSources,messageImages} from '../src/bridge/media.js';
import {NativeHistory} from '../src/bridge/history.js';
import {createRelay} from '../src/relay/server.js';
import {startBridge} from '../src/bridge/connector.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0XcAAAAASUVORK5CYII=','base64');
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>boolean){for(let i=0;i<160;i++){if(fn())return;await pause(40);}throw new Error('Media state did not synchronize');}

test('only referenced raster images become scoped content IDs; malformed, network and oversized sources fail clearly',()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-media-')),db=new DatabaseSync(':memory:'),media=new MediaStore(root,db);writeFileSync(join(root,'照片 1.png'),png);writeFileSync(join(root,'secret.txt'),'private');
  try{
    const raw={type:'userMessage',content:[{type:'text',text:'![结果](<照片 1.png>)'},{type:'localImage',path:join(root,'照片 1.png')},{type:'image',url:'data:image/png;base64,'+png.toString('base64')}]};
    const m=messageImages(media,'pc:codex:one',root,{id:'m',role:'user',text:'picture'},raw);assert.equal(m.images?.length,1);const ref=m.images![0];assert.equal(ref.id,createHash('sha256').update(png).digest('hex'));assert.deepEqual(media.read('pc:codex:one',ref.id!)?.bytes,png);assert.equal(media.read('pc:codex:other',ref.id!),undefined);
    assert.equal(imageSources('see secret.txt').length,0);assert.equal(messageImages(media,'pc:codex:one',root,{id:'m2',role:'assistant',text:''},{type:'localImage',path:join(root,'secret.txt')}).images![0].id,undefined);
    assert.match(messageImages(media,'one',root,{id:'m',role:'user',text:''},{type:'image',url:'http://127.0.0.1/private.png'}).images![0].error!,/远程图片/);
    assert.match(messageImages(media,'one',root,{id:'m',role:'user',text:''},{type:'localImage',path:'\\\\server\\share\\private.png'}).images![0].error!,/本地图片/);
    const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');assert.throws(()=>media.put('one',svg,'attack.svg'));assert.throws(()=>media.put('one',Buffer.alloc(MAX_IMAGE_BYTES+1),'huge.png'));
    assert.throws(()=>media.putPayload('one',{id:ref.id!,mime:'image/png',name:'bad',data:Buffer.concat([png,Buffer.from('tamper')]).toString('base64')}));
    assert.throws(()=>media.payload('other',ref.id!));
  }finally{db.close();assert.ok(root.startsWith(join(tmpdir(),'relay-media-')));rmSync(root,{recursive:true,force:true});}
});

test('Claude image-only and large inline records survive normalization and Codex local images remain referenced',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-image-history-')),codex=join(root,'codex'),claude=join(root,'claude');mkdirSync(codex);mkdirSync(join(claude,'projects','fixture'),{recursive:true});
  const db=new DatabaseSync(':memory:'),media=new MediaStore(root,db);
  try{
    const large=Buffer.concat([png,Buffer.alloc(4*1024*1024)]);
    writeFileSync(join(claude,'projects','fixture','photo.jsonl'),JSON.stringify({type:'user',uuid:'only-image',cwd:root,sessionId:'photo',message:{role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/png',data:large.toString('base64')}}]}})+'\n');
    const reader=new NativeHistory('pc',codex,claude,media);assert.equal(reader.list()[0].cwd,root);const page=await reader.page('pc:claude:photo');assert.equal(page.messages.length,1);assert.equal(page.messages[0].text,'');assert.equal(page.messages[0].images?.[0].size,large.length);assert.equal(page.messages[0].images?.[0].mime,'image/png');
  }finally{db.close();assert.ok(root.startsWith(join(tmpdir(),'relay-image-history-')));rmSync(root,{recursive:true,force:true});}
});

test('image sync, authenticated retrieval, on-demand fetch, session isolation and offline persistence through the real relay',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-image-e2e-')),codex=join(root,'codex'),workspace=join(root,'workspace'),relayDir=join(root,'relay'),bridgeDir=join(root,'bridge');mkdirSync(codex);mkdirSync(workspace);
  const nativeId=randomUUID(),otherId=randomUUID(),sessionId='pc:codex:'+nativeId,file=join(workspace,'结果图.png');writeFileSync(file,png);
  const state=new DatabaseSync(join(codex,'state_5.sqlite'));state.exec('CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,archived INTEGER,agent_role TEXT,rollout_path TEXT,model TEXT)');
  for(const id of [nativeId,otherId])state.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)').run(id,'image fixture',workspace,123,0,null,join(codex,'rollout.jsonl'),'fixture');state.close();
  const log=new DatabaseSync(join(codex,'thread_history_1.sqlite'));log.exec('CREATE TABLE thread_items(thread_id TEXT,rollout_ordinal INTEGER,item_json TEXT)');log.prepare('INSERT INTO thread_items VALUES(?,?,?)').run(nativeId,0,JSON.stringify({id:'photo',type:'userMessage',content:[{type:'localImage',path:file}]}));
  const phone=randomUUID(),token=randomUUID(),options={dataDir:relayDir,phoneToken:phone,bridgeToken:token};let relay=createRelay(options);relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');let base='http://127.0.0.1:'+(relay.server.address() as {port:number}).port,cookie='';
  const request=(path:string,payload?:unknown)=>fetch(base+path,{method:payload?'POST':'GET',headers:{cookie,Origin:base,'Content-Type':'application/json'},body:payload?JSON.stringify(payload):undefined});
  const login=await request('/api/login',{token:phone});cookie=login.headers.get('set-cookie')!.split(';')[0];
  let bridge:ReturnType<typeof startBridge>|undefined=startBridge({relayUrl:base.replace('http','ws')+'/bridge',hostId:'pc',name:'pc',dataDir:bridgeDir,projects:[{id:'work',name:'work',path:workspace}],codexHome:codex,claudeHome:join(root,'empty'),discoverCodexProjects:false},token);
  const hash=createHash('sha256').update(png).digest('hex'),url='/api/images/'+hash+'?sessionId='+encodeURIComponent(sessionId);
  try{
    await until(()=>!!relay.store.db.prepare('SELECT id FROM media_refs WHERE session_id=? AND id=?').get(sessionId,hash));await until(()=>bridge!.runtime.media.pending(sessionId).length===0);
    const response=await request(url);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);assert.match(response.headers.get('cache-control')!,/private/);assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.equal((await fetch(base+url)).status,401);assert.notEqual((await request('/api/images/'+hash+'?sessionId='+encodeURIComponent('pc:codex:'+otherId))).status,200);
    assert.equal((await request('/api/actions',{id:randomUUID(),type:'asset',sessionId,assetId:hash})).status,400);
    const second=Buffer.concat([png,Buffer.from('second image')]),secondFile=join(workspace,'new.png');writeFileSync(secondFile,second);log.prepare('INSERT INTO thread_items VALUES(?,?,?)').run(nativeId,1,JSON.stringify({id:'generated',type:'agentMessage',text:'![新图](<'+secondFile.replaceAll('\\','/')+'>)'}));
    const history=await (await request('/api/history?sessionId='+encodeURIComponent(sessionId))).json() as any;const secondRef=history.messages.find((m:any)=>m.id==='generated').images[0];assert.ok(secondRef.id);
    const secondUrl='/api/images/'+secondRef.id+'?sessionId='+encodeURIComponent(sessionId);assert.equal((await request(secondUrl)).status,200);
    await bridge.close();bridge=undefined;assert.equal((await request(url)).status,200);assert.equal((await request(secondUrl)).status,200);
    await relay.close();relay=createRelay(options);relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');base='http://127.0.0.1:'+(relay.server.address() as {port:number}).port;assert.equal((await request(url)).status,200);
  }finally{if(bridge)await bridge.close();await relay.close();log.close();assert.ok(root.startsWith(join(tmpdir(),'relay-image-e2e-')));rmSync(root,{recursive:true,force:true});}
});
