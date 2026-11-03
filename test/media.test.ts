import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
import {MediaStore,MAX_IMAGE_BYTES} from '../src/shared/media.js';
import {imageSources,messageImages,imageSafeJson} from '../src/bridge/media.js';
import {NativeHistory,itemMessage,transcriptLine} from '../src/bridge/history.js';
import {createRelay} from '../src/relay/server.js';
import {startBridge} from '../src/bridge/connector.js';
import {directClient} from './helpers/direct-client.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0XcAAAAASUVORK5CYII=','base64');
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test('inline image bytes are removed from tool JSON and message text before truncation without losing local image refs',()=>{
  const payload=png.toString('base64'),raw={id:'image-tool',type:'mcpToolCall',tool:'preview',result:{content:[{type:'text',text:'image follows'},{type:'image',mimeType:'image/png',data:payload}]}};
  const message=itemMessage(raw,0)!;assert.ok(!message.text.includes(payload));assert.match(message.text,/image follows/);assert.match(message.text,/仅通过设备直传/);
  const root=mkdtempSync(join(tmpdir(),'direct-redaction-')),db=new DatabaseSync(':memory:'),media=new MediaStore(root,db);
  try{const converted=messageImages(media,'pc:codex:a',root,message,raw);assert.equal(converted.images?.[0].size,png.length);assert.equal(itemMessage({type:'agentMessage',text:'![图](data:image/png;base64,'+payload+')'},0)!.text.includes(payload),false);assert.equal(imageSafeJson({source:{type:'base64',media_type:'image/png',data:payload}}).includes(payload),false);}finally{db.close();rmSync(root,{recursive:true,force:true});}
});
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

test('tool source/output is not parsed as image markup and expired referenced paths reuse an unambiguous local copy',()=>{
  const code='![假图](unrelated.png)\n<image path="\'+\'">\n## 照片 1.png: missing.png';
  for(const type of ['commandExecution','mcpToolCall','dynamicToolCall','fileChange'])assert.equal(imageSources({type,aggregatedOutput:code,result:{content:[{type:'text',text:code}]},changes:[{diff:code}]}).length,0);
  assert.equal(imageSources({role:'tool',text:code}).length,0);
  assert.equal(imageSources({type:'mcpToolCall',result:{content:[{type:'image',mimeType:'image/png',data:png.toString('base64')}]}}).length,1);
  const root=mkdtempSync(join(tmpdir(),'relay-expired-image-')),db=new DatabaseSync(':memory:'),media=new MediaStore(root,db);
  try{const ref=media.put('pc:codex:a',png,'expired.png');const m=messageImages(media,'pc:codex:a',root,{id:'a',role:'user',text:''},{type:'localImage',path:join(root,'expired.png')});assert.equal(m.images?.[0].id,ref.id);assert.equal(messageImages(media,'pc:codex:b',root,{id:'b',role:'user',text:''},{type:'localImage',path:join(root,'expired.png')}).images?.[0].id,undefined);}finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('generated image results and image-view records survive history conversion, with local image links',()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-generated-images-')),db=new DatabaseSync(':memory:'),media=new MediaStore(root,db),session='pc:codex:generated';
  const path=join(root,'agent-preview.png');writeFileSync(path,png);
  try{
    const generated={type:'imageGeneration',id:'generated-image',status:'completed',savedPath:join(root,'expired.png'),result:png.toString('base64')};
    const viewed={type:'imageView',id:'viewed-image',path};
    for(const raw of [generated,viewed]){
      const message=messageImages(media,session,root,itemMessage(raw,0)!,raw);
      assert.equal(message.role,'assistant');assert.equal(message.images?.[0].id,createHash('sha256').update(png).digest('hex'));
      assert.deepEqual(media.read(session,message.images![0].id!)?.bytes,png);
    }
    assert.equal(imageSources({type:'agentMessage',text:'[效果图](<'+path.replaceAll('\\','/')+'>)'}).length,1);
    assert.equal(imageSources('[external](https://example.com/image.png)').length,0);
    assert.equal(imageSources({type:'commandExecution',command:'echo "![code](unrelated.png)"'}).length,0);
    const log={timestamp:'2026-11-02T00:00:00Z',type:'response_item',payload:{...generated,type:'image_generation_call'}};
    const message=transcriptLine(log,0)!;assert.equal(message.label,'生成的图片');assert.equal(message.timestamp,Date.parse(log.timestamp));
    assert.equal(messageImages(media,session,root,message,log).images?.length,1);
    assert.equal(transcriptLine({type:'event_msg',payload:{type:'item_completed',item:viewed}},1)?.label,'图片预览');
    assert.equal(messageImages(media,'other',root,itemMessage({...generated,result:undefined},0)!,{...generated,result:undefined}).images?.[0].error,'本地图片已不存在或无法读取');
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
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

test('authenticated HTTP images coalesce cold reads, cache generated assets and remain available offline',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-image-e2e-')),codex=join(root,'codex'),workspace=join(root,'workspace'),relayDir=join(root,'relay'),bridgeDir=join(root,'bridge');mkdirSync(codex);mkdirSync(workspace);
  const nativeId=randomUUID(),otherId=randomUUID(),sessionId='pc:codex:'+nativeId,file=join(workspace,'结果图.png');writeFileSync(file,png);
  const state=new DatabaseSync(join(codex,'state_5.sqlite'));state.exec('CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,archived INTEGER,agent_role TEXT,rollout_path TEXT,model TEXT)');
  for(const id of [nativeId,otherId])state.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)').run(id,'image fixture',workspace,123,0,null,join(codex,'rollout.jsonl'),'fixture');state.close();
  const log=new DatabaseSync(join(codex,'thread_history_1.sqlite'));log.exec('CREATE TABLE thread_items(thread_id TEXT,rollout_ordinal INTEGER,item_json TEXT)');log.prepare('INSERT INTO thread_items VALUES(?,?,?)').run(nativeId,0,JSON.stringify({id:'photo',type:'userMessage',content:[{type:'localImage',path:file}]}));
  const phone=randomUUID(),token=randomUUID(),options={dataDir:relayDir,phoneToken:phone,bridgeToken:token};let relay=createRelay(options);relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');let base='http://127.0.0.1:'+(relay.server.address() as {port:number}).port,cookie='';
  const request=(path:string,payload?:unknown)=>fetch(base+path,{method:payload?'POST':'GET',headers:{cookie,Origin:base,'Content-Type':'application/json'},body:payload?JSON.stringify(payload):undefined});
  const login=await request('/api/login',{token:phone});cookie=login.headers.get('set-cookie')!.split(';')[0];
  let bridge:ReturnType<typeof startBridge>|undefined=startBridge({relayUrl:base.replace('http','ws')+'/bridge',hostId:'pc',name:'pc',dataDir:bridgeDir,projects:[{id:'work',name:'work',path:workspace}],codexHome:codex,claudeHome:join(root,'empty'),discoverCodexProjects:false},token);
  const clients:Awaited<ReturnType<typeof directClient>>[]=[];
  const connect=async(id:string)=>{const client=await directClient(async offer=>{const r=await request('/api/direct',{sessionId:id,offer});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;});clients.push(client);return client;};
  const hash=createHash('sha256').update(png).digest('hex'),url='/api/images/'+hash+'?sessionId='+encodeURIComponent(sessionId);
  try{
    await until(()=>!!relay.store.getSession(sessionId));
    const page=await(await request('/api/history?sessionId='+encodeURIComponent(sessionId))).json() as any;
    assert.equal(page.messages[0].images[0].id,hash);
    const runtime=bridge.runtime,handle=runtime.handle.bind(runtime);let assetReads=0;
    runtime.handle=async(action,fromQueue)=>{if(action.type==='asset'){assetReads++;await new Promise(r=>setTimeout(r,30));}return handle(action,fromQueue);};
    const client=await connect(sessionId),other=await connect('pc:codex:'+otherId);
    assert.deepEqual((await client.read('image',hash)).bytes,png);
    const reads=await Promise.all([request(url),request(url),request(url)]);for(const r of reads){assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),png);}assert.equal(assetReads,1);
    const cached=await request(url);assert.equal(cached.headers.get('x-asset-source'),'server-cache');assert.equal(assetReads,1);
    assert.equal((await fetch(base+url)).status,401);
    assert.equal((await fetch(base+'/api/direct',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{}'})).status,401);
    await assert.rejects(other.read('image',hash),/不存在|不属于/);
    assert.equal((await request('/api/actions',{id:randomUUID(),type:'asset',sessionId,assetId:hash})).status,400);
    const second=Buffer.concat([png,Buffer.from('second image')]),secondFile=join(workspace,'new.png');writeFileSync(secondFile,second);log.prepare('INSERT INTO thread_items VALUES(?,?,?)').run(nativeId,1,JSON.stringify({id:'generated',type:'agentMessage',text:'![新图](<'+secondFile.replaceAll('\\','/')+'>)'}));
    const history=await (await request('/api/history?sessionId='+encodeURIComponent(sessionId))).json() as any;const secondRef=history.messages.find((m:any)=>m.id==='generated').images[0];assert.ok(secondRef.id);
    const secondUrl='/api/images/'+secondRef.id+'?sessionId='+encodeURIComponent(sessionId);assert.deepEqual((await client.read('image',secondRef.id)).bytes,second);
    const generated=Buffer.concat([png,Buffer.from('native generated result')]),generatedHash=createHash('sha256').update(generated).digest('hex');
    log.prepare('INSERT INTO thread_items VALUES(?,?,?)').run(nativeId,2,JSON.stringify({id:'generated-native',type:'imageGeneration',status:'completed',savedPath:join(workspace,'missing.png'),result:generated.toString('base64')}));
    log.prepare('INSERT INTO thread_items VALUES(?,?,?)').run(nativeId,3,JSON.stringify({id:'agent-view',type:'imageView',path:secondFile}));
    const updated=await(await request('/api/history?sessionId='+encodeURIComponent(sessionId))).json() as any;
    assert.equal(updated.messages.find((m:any)=>m.id==='generated-native').images[0].id,generatedHash);
    assert.equal(updated.messages.find((m:any)=>m.id==='agent-view').images[0].id,secondRef.id);
    const generatedUrl='/api/images/'+generatedHash+'?sessionId='+encodeURIComponent(sessionId);
    assert.deepEqual((await client.read('image',generatedHash)).bytes,generated);
    assert.deepEqual(Buffer.from(await (await request(generatedUrl)).arrayBuffer()),generated);
    assert.notEqual((await request('/api/images/'+generatedHash+'?sessionId='+encodeURIComponent('pc:codex:'+otherId))).status,200);
    assert.equal(existsSync(join(relayDir,'images',hash)),true);
    assert.equal(existsSync(join(relayDir,'images',generatedHash)),true);
    for(const c of clients)await c.close();
    await bridge.close();bridge=undefined;
    assert.deepEqual(Buffer.from(await (await request(url)).arrayBuffer()),png);
    const offline=await request('/api/direct',{sessionId,offer:{type:'offer',sdp:'invalid'}});assert.notEqual(offline.status,200);
  }finally{for(const c of clients)await c.close();if(bridge)await bridge.close();await relay.close();log.close();assert.ok(root.startsWith(join(tmpdir(),'relay-image-e2e-')));rmSync(root,{recursive:true,force:true});}
});
