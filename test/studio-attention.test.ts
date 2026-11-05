import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {RelayStore} from '../src/relay/store.js';
import {StudioAttention} from '../src/relay/studio-attention.js';
import {createRelay} from '../src/relay/server.js';
// @ts-expect-error Browser module has no side effects.
import {createStudioApi} from '../web/studio-api.js';

function fixture(remote:()=>Promise<any>=async()=>({questions:[],questionsAsOf:Date.now()})){
 const dir=mkdtempSync(join(tmpdir(),'relay-attention-')),store=new RelayStore(dir);let online=true;
 for(const [id,hostId,projectId]of [['h:a','h','workspace'],['h:b','h','workspace'],['h:old','h','workspace'],['other:x','other','workspace'],['h:wrong','h','other-workspace']])store.session({id,hostId,projectId,nativeId:id,provider:'codex',title:id,cwd:dir,status:'waiting',managed:true,updatedAt:Date.now()});
 const run:any={id:'run',projectId:'team',planner:{id:'planner',role:'director',status:'done',sessionId:'h:a'},tasks:[{id:'assets',title:'资产制作',role:'model',status:'running',sessionId:'h:b',attempts:[{sessionId:'h:old'}]},{id:'foreign',sessionId:'other:x'},{id:'wrong',sessionId:'h:wrong'}],workspace:{value:{project:{id:'workspace'}}},chats:[]};
 const attention=new StudioAttention(store,{runs:()=>[run],projects:()=>[{id:'team',hostId:'h'}]} as any,remote,()=>{},()=>online);
 const event=(sessionId:string,type:string,data:any)=>store.event({id:randomUUID(),sessionId,hostId:sessionId.split(':')[0],type:type as any,data,at:Date.now()});
 const card=(sessionId:string,id:string,status='pending')=>({id,sessionId,status,questions:[{id:'choice',header:'方向',question:'选哪一个？',options:[],allowOther:true}],createdAt:Date.now()});
 return {attention,store,run,event,card,setOnline:(value:boolean)=>online=value,async close(){await attention.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('attention isolates current workspace sessions and folds resolutions without returning unrelated history',async()=>{
 const f=fixture();try{
  f.setOnline(false);for(const sid of ['h:a','h:b','h:old','other:x','h:wrong'])f.event(sid,'question',f.card(sid,'q-'+sid));
  f.event('h:a','question.resolved',f.card('h:a','q-h:a','answered'));
  f.event('h:b','approval',{approvalId:'allow',details:'python export.py',expiresAt:Date.now()+10000});f.event('h:b','approval',{approvalId:'gone',expiresAt:Date.now()+10000});f.event('h:b','approval.resolved',{approvalId:'gone',allow:false});f.event('h:b','approval',{approvalId:'expired',expiresAt:1});
  f.event('h:b','message',{text:'Private history does not belong in the summary'});
  const result=f.attention.read('run');assert.deepEqual(result.entries.map(e=>e.sessionId),['h:a','h:b']);assert.equal(result.entries[0].questions.length,0);assert.equal(result.entries[1].questions.length,1);assert.equal(result.entries[1].online,false);assert.equal(result.entries[1].taskId,'assets');assert.deepEqual(result.entries[1].approvals.map(a=>a.approvalId),['allow']);assert.doesNotMatch(JSON.stringify(result),/Private history|h:old|other:x|h:wrong/);
  f.event('h:b','approval.resolved',{approvalId:'allow',unconfirmed:true});assert.equal(f.attention.read('run').entries[1].approvals[0].status,'unknown');
  assert.throws(()=>f.attention.read('missing'),/不存在/);
 }finally{await f.close();}
});
test('native discovery is nonblocking and coalesced; stale pending snapshots cannot resurrect answered questions',async()=>{
 let release:(value:any)=>void=()=>{},calls=0;const f=fixture(()=>{calls++;return new Promise(resolve=>release=resolve);});try{
  f.run.tasks=[];const card=f.card('h:a','q');f.event('h:a','question',card);
  assert.equal(f.attention.read('run').refreshing,true);f.attention.read('run');assert.equal(calls,1);
  f.event('h:a','question.resolved',{...card,status:'answered'});release({questions:[card,f.card('h:a','new'),f.card('other:x','invalid')],questionsAsOf:Date.now()});await f.attention.close();
  const pending=f.attention.read('run').entries[0].questions;assert.deepEqual(pending.map(q=>q.id),['new']);assert.equal(calls,1);
 }finally{await f.close();}
});
test('attention uses the live socket state, backs off failed discovery, and permits explicit read refresh',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;throw Error('signal timed out');});try{
  f.run.tasks=[];f.attention.read('run');await f.attention.close();assert.equal(calls,1);assert.equal(f.attention.read('run').entries[0].syncFailures,1);assert.equal(calls,1);
  f.setOnline(false);assert.equal(f.attention.read('run',true).entries[0].online,false);assert.equal(calls,1);f.setOnline(true);f.attention.read('run',true);await f.attention.close();assert.equal(calls,2);
 }finally{await f.close();}
});
test('browser API reuses conditional GET data and does not retry ambiguous writes',async()=>{
 const calls:any[]=[];let step=0;
 const api=createStudioApi({fetcher:async(url:string,options:any)=>{calls.push([url,options]);step++;if(step===1)return new Response('{"runs":[]}',{headers:{ETag:'"v1"'}});if(step===2)return new Response(null,{status:304});throw new DOMException('signal timed out','TimeoutError');}});
 const first=await api('studio');assert.equal(await api('studio'),first);assert.equal(calls[1][1].headers['If-None-Match'],'"v1"');
 await assert.rejects(api('actions',{id:'same',type:'answer'}),(e:any)=>e.uncertain===true&&!/signal timed out/.test(e.message));assert.equal(calls.length,3);
 await assert.rejects(api('studio'),(e:any)=>e.transport===true&&!e.uncertain);
 const raw=createStudioApi({fetcher:async()=>new Response('{"error":"signal timed out"}',{status:500})});await assert.rejects(raw('studio'),/状态读取暂时超时/);await assert.rejects(raw('actions',{id:'id'}),/结果暂未确认/);
});
test('studio conditional GET and attention remain authenticated, and import routes are available',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-attention-http-')),token='attention-phone-test-token-12345678',app=createRelay({dataDir:dir,phoneToken:token,bridgeToken:'attention-bridge-test-token-12345678'});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base='http://127.0.0.1:'+(app.server.address() as any).port;
 try{
  assert.equal((await fetch(base+'/api/studio/attention?runId=none')).status,401);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({token})}),cookie=login.headers.get('set-cookie')!.split(';')[0];
  const initial=await fetch(base+'/api/studio',{headers:{Cookie:cookie}}),etag=initial.headers.get('etag')!;assert.ok(etag);const repeated=await fetch(base+'/api/studio',{headers:{Cookie:cookie,'If-None-Match':etag}});assert.equal(repeated.status,304);assert.equal(await repeated.text(),'');assert.equal((await fetch(base+'/api/studio',{headers:{'If-None-Match':etag}})).status,401);
  for(const header of ['W/'+etag,'"different", W/'+etag,'*'])assert.equal((await fetch(base+'/api/studio',{headers:{Cookie:cookie,'If-None-Match':header}})).status,304);
  assert.equal((await fetch(base+'/api/studio',{headers:{Cookie:cookie,'If-None-Match':'"different"'}})).status,200);
  for(const file of ['studio-api.js','studio-attention.js'])assert.equal((await fetch(base+'/'+file)).status,200);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
