import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';

test('preview uses isolated sample state and handles queue, answers and completion without network actions',async()=>{
  let network=0;const timers=new Map<number,()=>void>();let timerId=0;
  const page:any={RELAY_DEMO_ASSETS:Object.fromEntries(['coast','chart','light'].map(key=>[key,{id:key.repeat(64).slice(0,64),name:key+'.webp',url:'./assets/'+key+'.webp'}])),fetch:()=>{network++;throw Error('unexpected network')},EventSource:class{}};
  const context={window:page,location:{href:'https://demo.invalid/preview/',origin:'https://demo.invalid'},document:{addEventListener:()=>{}},structuredClone,URL,Response,Blob,EventTarget,MessageEvent,Event,crypto:webcrypto,setInterval:()=>0,setTimeout:(fn:()=>void)=>{timers.set(++timerId,fn);return timerId},clearTimeout:(id:number)=>timers.delete(id)};
  const source=readFileSync(new URL('../preview/client.js',import.meta.url),'utf8');runInNewContext(source,context);
  const api=async(path:string,body?:object)=>{const response=await page.fetch('/preview/api/'+path,body?{body:JSON.stringify(body)}:{});assert.equal(response.status,200);return response.json()};
  const initial=await api('state');assert.equal(initial.sessions.length,9);assert.equal(initial.hosts.length,2);
  assert.ok(initial.sessions.some((s:any)=>s.status==='running'));assert.ok(initial.sessions.some((s:any)=>s.status==='idle'));
  const history=await api('history?sessionId=demo:lighting');assert.ok(history.messages.some((m:any)=>m.images?.length));
  const permissionBefore=initial.sessions.find((s:any)=>s.id==='demo:lighting').permissionMode;
  const permissionChanged=await api('actions',{type:'set-permissions',sessionId:'demo:lighting',permissionMode:'full'});assert.equal(permissionChanged.queued,true);
  const preset=(await api('state')).sessions.find((s:any)=>s.id==='demo:lighting');assert.equal(preset.permissionMode,permissionBefore);assert.equal(preset.nextPermissionMode,'full');
  const queued=await api('actions',{type:'send',sessionId:'demo:lighting',text:'请补充细节'});assert.equal(queued.queued,true);
  const running=(await api('state')).sessions.find((s:any)=>s.id==='demo:lighting');assert.equal(running.pendingCount,1);
  await api('actions',{type:'steer',sessionId:running.id,queuedId:running.pendingIds[0]});
  for(const [id,fn] of [...timers]){timers.delete(id);fn();}
  assert.equal((await api('state')).sessions.find((s:any)=>s.id===running.id).status,'idle');
  await api('actions',{type:'send',sessionId:running.id,text:'开始下一轮'});
  const next=(await api('state')).sessions.find((s:any)=>s.id===running.id);assert.equal(next.permissionMode,'full');assert.equal(next.nextPermissionMode,undefined);
  await api('actions',{type:'answer',sessionId:'demo:question',questionId:'aaaaaaaa-1111-4111-8111-111111111111',answers:{style:['温暖海岸']}});
  const answered=await api('history?sessionId=demo:question');assert.equal(answered.questions.length,0);assert.equal(answered.events[0].data.status,'answered');
  await api('actions',{type:'stop',sessionId:'demo:question'});for(const fn of timers.values())fn();
  assert.equal((await api('state')).sessions.find((s:any)=>s.id==='demo:question').status,'interrupted');
  const missing=await page.fetch('/preview/api/nonexistent');assert.equal(missing.status,404);assert.equal(network,0);
  runInNewContext(source,context);assert.equal((await api('state')).sessions.find((s:any)=>s.id==='demo:lighting').status,'running');
});
