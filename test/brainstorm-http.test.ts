import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {createRelay} from '../src/relay/server.js';
import {STUDIO_ROLES} from '../src/relay/studio.js';
const pause=()=>new Promise(r=>setTimeout(r,20));
test('supplementary brainstorming worker shares a computer without replacing active production; HTTP routing, ownership and module routes hold',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'brain-http-')),phone='p'.repeat(32),token='b'.repeat(32),app=createRelay({dataDir:dir,phoneToken:phone,bridgeToken:token});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base='http://127.0.0.1:'+(app.server.address() as any).port;
  const connect=async(service=false)=>{const ws=new WebSocket(base.replace('http:','ws:')+'/bridge',{headers:{Authorization:'Bearer '+token}});await once(ws,'open');const ready=once(ws,'message');ws.send(JSON.stringify({type:'hello',host:{id:'pc',name:service?'helper':'Production PC',service:service?'brainstorm':undefined,projects:[{id:'game',name:'Game',path:dir}],capabilities:{studioWorkspaces:true,brainstorm:service}}}));await ready;return ws;};
  let main:WebSocket|undefined,helper:WebSocket|undefined;
  try{
    main=await connect();const active={id:'pc:codex:production',hostId:'pc',nativeId:'production',provider:'codex',status:'running',managed:true,projectId:'game',cwd:dir,title:'Active production',updatedAt:Date.now()};main.send(JSON.stringify({type:'sessions',sessions:[active]}));await pause();helper=await connect(true);assert.equal(main.readyState,WebSocket.OPEN);
    const received:string[]=[],brainProjects:any[]=[];let brainSession:any;
    helper.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.type!=='action')return;const a=m.action;received.push(a.type);let result:any={ok:true};if(a.type==='prepare-brainstorm'){const p={id:'brainstorm-'+a.workspaceId,name:'Discussion',path:dir};brainProjects.push(p);helper!.send(JSON.stringify({type:'projects',projects:brainProjects}));result={project:p};}if(a.type==='start'){const nativeId=randomUUID();brainSession={...active,id:'pc:claude:'+nativeId,nativeId,provider:'claude',projectId:a.projectId,title:'Brainstorm'};helper!.send(JSON.stringify({type:'sessions',sessions:[brainSession]}));result={sessionId:brainSession.id};}if(a.type==='set-model')result={ok:true,queued:true,model:a.model,effort:a.effort};if(a.type==='history')result={messages:[{id:'answer',role:'assistant',text:'Brainstorm answer'}],cursor:null,source:'helper'};helper!.send(JSON.stringify({type:'result',id:a.id,result}));});
    const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({token:phone})}),cookie=login.headers.get('set-cookie')!.split(';')[0];
    const post=async(path:string,payload:any)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:base,Cookie:cookie},body:JSON.stringify(payload)});const v=await r.json() as any;assert.equal(r.status,200,JSON.stringify(v));return v;};
    const team=app.studio.saveProject({name:'Game team',hostId:'pc',projectId:'game',workspaceIndex:0,concurrency:1,permissionMode:'request',reviewPlan:true,roles:STUDIO_ROLES.map(([role])=>({role,enabled:true,provider:'claude',instructions:'',tools:''}))});
    const created=await post('/api/studio/brainstorm',{projectId:team.id,title:'Design ideas'});await post('/api/studio/brainstorm/send',{topicId:created.topic.id,id:randomUUID(),text:'Discuss gameplay'});assert.deepEqual(received,['prepare-brainstorm','start']);const changed=await post('/api/studio/brainstorm/settings',{id:randomUUID(),topicId:created.topic.id,model:'opus',effort:'high'});assert.equal(changed.model,'opus');assert.equal(changed.queued,true);assert.equal(changed.topic.sessionId,brainSession.id);assert.deepEqual(received,['prepare-brainstorm','start','set-model']);
    main.send(JSON.stringify({type:'sessions',sessions:[{...brainSession,managed:false,status:'idle'}]}));main.send(JSON.stringify({type:'projects',projects:[{id:'game',name:'Game',path:dir}]}));await pause();
    const state=await (await fetch(base+'/api/state',{headers:{Cookie:cookie}})).json() as any;assert.equal(state.hosts.length,1);assert.equal(state.hosts[0].name,'Production PC');assert.ok(state.hosts[0].projects.some((p:any)=>p.id===created.topic.workspace.id));assert.equal(state.sessions.find((s:any)=>s.id===brainSession.id).managed,true);assert.equal(state.sessions.find((s:any)=>s.id===active.id).status,'running');
    const page=await(await fetch(base+'/api/history?sessionId='+encodeURIComponent(brainSession.id),{headers:{Cookie:cookie}})).json() as any;assert.equal(page.messages[0].text,'Brainstorm answer');
    for(const path of ['/studio-brainstorm.js','/operations.js','/session-settings.js','/diagrams.js','/vendor/mermaid.tiny.js'])assert.equal((await fetch(base+path)).status,200);
    assert.equal((await fetch(base+'/api/studio/brainstorm?topicId='+created.topic.id)).status,401);assert.equal((await fetch(base+'/api/studio/brainstorm/settings',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:'{}'})).status,401);
    assert.equal((await fetch(base+'/api/studio/brainstorm',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://foreign.example',Cookie:cookie},body:'{}'})).status,403);
    helper.close();await once(helper,'close');await pause();assert.equal(main.readyState,WebSocket.OPEN);assert.equal(app.store.getSession(active.id)?.status,'running');
  }finally{main?.terminate();helper?.terminate();await app.close();rmSync(dir,{recursive:true,force:true});}
});
