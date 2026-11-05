import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {BridgeStore} from '../src/bridge/store.js';
import {RelayStore} from '../src/relay/store.js';
import {MediaStore} from '../src/shared/media.js';
import {FileStore} from '../src/shared/files.js';
import {validateAction,type Action} from '../src/shared/protocol.js';
import {prepareBrainstorm,readBrainstormProject,codexBrainstormImage} from '../src/bridge/brainstorm.js';
import {Brainstorms} from '../src/relay/brainstorm.js';
import {Studio,STUDIO_ROLES} from '../src/relay/studio.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=','base64');
test('brainstorm workspaces persist project association; project tools are read-only and reject traversal and binary files',()=>{
  const dir=mkdtempSync(join(tmpdir(),'brain-workspace-')),store=new BridgeStore(dir),source=join(dir,'game');mkdirSync(source);writeFileSync(join(source,'README.md'),'Existing game rules');writeFileSync(join(source,'asset.bin'),Buffer.from([0,1,2]));
  try{const id=randomUUID(),p=prepareBrainstorm(store,dir,id,source);assert.notEqual(p.path,source);assert.equal(prepareBrainstorm(store,dir,id,source).id,p.id);assert.equal(readBrainstormProject(source,'README.md').text,'Existing game rules');assert.throws(()=>readBrainstormProject(source,'../bridge.sqlite'),/只能读取/);assert.throws(()=>readBrainstormProject(source,'asset.bin'),/二进制/);assert.throws(()=>prepareBrainstorm(store,dir,'../game',source),/无效/);assert.equal(readFileSync(join(source,'README.md'),'utf8'),'Existing game rules');}
  finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
class FakeCodex extends EventEmitter{closed=false;constructor(private kind='imageGeneration'){super();}async start(){}send(){}close(){this.closed=true;}async call(method:string){if(method==='thread/start')return {thread:{id:'image-thread'}};if(method==='turn/start'){queueMicrotask(()=>{this.emit('notification',{method:'item/completed',params:{threadId:'image-thread',item:{type:this.kind,id:'image-result',status:'completed',result:png.toString('base64')}}});this.emit('notification',{method:'turn/completed',params:{threadId:'image-thread',turn:{status:'completed'}}});});return {turn:{id:'image-turn'}};}return {};}}
test('image delegate publishes only real native generation items, closes process and rejects viewed images and cancellation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'brain-image-')),store=new BridgeStore(dir),media=new MediaStore(dir,store.db),session:any={id:'pc:claude:'+randomUUID(),cwd:dir},messages:any[]=[];
  try{const rpc=new FakeCodex();const refs=await codexBrainstormImage({command:'unused',session,media,prompt:'test',signal:new AbortController().signal,publish:m=>messages.push(m),rpc:rpc as any});assert.equal(refs.length,1);assert.ok(media.read(session.id,refs[0].id!));assert.equal(messages[0].label,'Codex · 参考图');assert.equal(rpc.closed,true);
    const fake=new FakeCodex('imageView');await assert.rejects(codexBrainstormImage({command:'unused',session,media,prompt:'test',signal:new AbortController().signal,publish:()=>{},rpc:fake as any}),/未返回实际生成图片/);assert.equal(fake.closed,true);
    await assert.rejects(codexBrainstormImage({command:'unused',session,media,prompt:'test',signal:AbortSignal.abort(),publish:()=>{},rpc:new FakeCodex() as any}),/已停止/);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'brain-relay-')),store=new RelayStore(dir),files=new FileStore(dir,store.db),media=new MediaStore(dir,store.db),actions:Action[]=[];
  store.host({id:'pc',name:'PC',online:true,lastSeen:Date.now(),capabilities:{brainstorm:true,studioWorkspaces:true},projects:[{id:'game',name:'My Game',path:dir}]});
  const remote=async(_h:string,a:Action)=>{actions.push(a);if(a.type==='models')return {models:[{id:'default',name:'Default',isDefault:true,efforts:['low','high']},{id:'opus',name:'Opus',efforts:['low','high']},{id:'sonnet',name:'Sonnet',efforts:['low','high']}]};if(a.type==='set-model'){const s=store.getSession(a.sessionId!)!,queued=s.status==='running';store.session({...s,...queued?{nextModel:a.model,nextEffort:a.effort}:{model:a.model,effort:a.effort}});return {ok:true,queued,model:a.model,effort:a.effort};}if(a.type==='prepare-brainstorm'){const p={id:'brainstorm-'+a.workspaceId,name:'Brainstorm',path:dir};const h=store.hosts()[0];store.host({...h,projects:[...h.projects,p]});return {project:p};}if(a.type==='prepare-workspace')throw Error('Fixture intentionally stops production before agent execution');if(a.type==='asset')return media.payload(a.sessionId!,a.assetId!);if(a.type==='upload')return {file:a.upload!.file};const nativeId=randomUUID(),id='pc:claude:'+nativeId;store.session({id,nativeId,provider:'claude',hostId:'pc',cwd:dir,projectId:a.projectId,model:a.model,effort:a.effort,managed:true,status:'idle',title:a.text!,updatedAt:Date.now()});return {sessionId:a.sessionId??id};};
  const studio=new Studio(store,remote,()=>true,()=>{},files),team=studio.saveProject({name:'LightGame team',hostId:'pc',projectId:'game',workspaceIndex:0,concurrency:1,permissionMode:'request',reviewPlan:true,roles:STUDIO_ROLES.map(([role])=>({role,enabled:true,provider:'codex',instructions:'',tools:''}))}),brains=new Brainstorms(store,studio,remote,()=>true,()=>{},files,media);
  return {store,studio,team,brains,actions,media,files,remote,async close(){await studio.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('project-scoped discussion defaults to Claude, carries team context and creates no production until explicit proposal launch',async()=>{
  const f=await fixture();try{const t=await f.brains.create({projectId:f.team.id,title:'First level idea'});await f.brains.send({topicId:t.id,id:randomUUID(),text:'Discuss a new level'});const a=f.actions.find(a=>a.type==='start')!;assert.equal(a.provider,'claude');assert.ok(a.projectId?.startsWith('brainstorm-'));assert.match(a.brainstormContext!,/LightGame team/);assert.equal(f.studio.runs().length,0);assert.equal(validateAction(a).brainstormContext,a.brainstormContext);
    const sessionId=f.brains.list()[0].sessionId!,ref=f.media.put(sessionId,png,'reference.png'),proposalId=randomUUID();f.store.event({id:randomUUID(),hostId:'pc',sessionId,type:'message',at:Date.now(),data:{id:'proposal',role:'assistant',text:'Chosen gameplay',proposal:{id:proposalId,title:'First level prototype',brief:'Build a new first level',workflow:'scene-new',image_ids:[ref.id]}}});
    const [r,r2]=await Promise.all([f.brains.launch({topicId:t.id,proposalId}),f.brains.launch({topicId:t.id,proposalId})]);assert.equal(r.runId,r2.runId);assert.equal(f.studio.runs().length,1);const run=f.studio.runs()[0];assert.equal(run.projectId,f.team.id);assert.equal(run.workflow?.kind,'scene');assert.equal(run.attachments?.length,1);assert.match(run.brief,/头脑风暴/);assert.notEqual(run.id,t.id);assert.equal((await f.brains.launch({topicId:t.id,proposalId})).runId,run.id);assert.equal(f.studio.runs().length,1);await assert.rejects(f.brains.launch({topicId:t.id,proposalId:randomUUID()}),/提案不存在/);
  }finally{await f.close();}
});
test('brainstorm launch freezes the selected task flow and disabled approvals without forcing new concept work',async()=>{
  const f=await fixture();try{
    const t=await f.brains.create({projectId:f.team.id,title:'Three level ideas'});await f.brains.send({topicId:t.id,id:randomUUID(),text:'Only level design'});const proposalId=randomUUID(),sessionId=f.brains.list()[0].sessionId!;
    f.store.event({id:randomUUID(),hostId:'pc',sessionId,type:'message',at:Date.now(),data:{id:'proposal-flow',role:'assistant',text:'Levels',proposal:{id:proposalId,title:'Three levels',brief:'Design three levels using existing mechanics',workflow:'scene-new',image_ids:[]}}});
    const flowConfig={template:'design',stages:['requirements'],approvals:{plan:false,design:true,visual:false,scene:false,final:false}};
    const first=await f.brains.launch({topicId:t.id,proposalId,flowConfig});assert.deepEqual(f.studio.runs()[0].workflow?.selection,flowConfig);assert.equal(f.studio.runs()[0].workflow?.kind,'general');
    const again=await f.brains.launch({topicId:t.id,proposalId,flowConfig:{...flowConfig,stages:['concept']}});assert.equal(again.runId,first.runId);assert.deepEqual(f.studio.runs()[0].workflow?.selection,flowConfig);assert.equal(f.studio.runs().length,1);
  }finally{await f.close();}
});

test('lost start receipts never create a second discussion session and can reconcile exact project identity',async()=>{
  const f=await fixture();try{const t=await f.brains.create({projectId:f.team.id,title:'Recover'});let count=0;const brains=new Brainstorms(f.store,f.studio,async()=>{count++;throw Error('connection lost');},()=>true,()=>{},f.files,f.media);await assert.rejects(brains.send({topicId:t.id,id:randomUUID(),text:'One'}),/connection lost/);await assert.rejects(brains.send({topicId:t.id,id:randomUUID(),text:'Two'}),/启动结果尚未确认/);assert.equal(count,1);const nativeId=randomUUID();f.store.session({id:'pc:claude:'+nativeId,nativeId,hostId:'pc',provider:'claude',projectId:t.workspace!.id,cwd:t.workspace!.path,managed:true,status:'idle',updatedAt:Date.now(),title:'Recovered'});assert.equal(brains.list()[0].sessionId,'pc:claude:'+nativeId);
  }finally{await f.close();}
});
test('brainstorm model choices persist per topic, reach first start and update the same live session for the next turn',async()=>{
  const f=await fixture();try{
    const a=await f.brains.create({projectId:f.team.id,title:'A'}),b=await f.brains.create({projectId:f.team.id,title:'B'});
    await f.brains.settings({id:randomUUID(),topicId:a.id,model:'opus',effort:'high'});
    assert.equal(f.brains.list().find(t=>t.id===a.id)?.model,'opus');assert.equal(f.brains.list().find(t=>t.id===b.id)?.model,undefined);
    await f.brains.send({id:randomUUID(),topicId:a.id,text:'First idea'});
    const start=f.actions.find(a=>a.type==='start')!;assert.equal(start.model,'opus');assert.equal(start.effort,'high');
    const id=f.brains.list().find(t=>t.id===a.id)!.sessionId!,s=f.store.getSession(id)!;f.store.session({...s,status:'running'});
    const change={id:randomUUID(),topicId:a.id,model:'sonnet',effort:'low'},result=await f.brains.settings(change);
    assert.equal(result.queued,true);assert.equal(f.store.getSession(id)?.model,'opus');assert.equal(f.store.getSession(id)?.nextModel,'sonnet');
    await f.brains.settings(change);assert.equal(f.actions.filter(a=>a.type==='set-model').length,1);
    await f.brains.send({id:randomUUID(),topicId:a.id,text:'Continue'});const send=f.actions.find(a=>a.type==='send')!;
    assert.equal(send.sessionId,id);assert.equal(send.model,undefined);assert.equal(send.effort,undefined);assert.equal(f.actions.filter(a=>a.type==='start').length,1);
    assert.equal(f.studio.runs().length,0);assert.equal(f.brains.list().find(t=>t.id===a.id)?.sessionId,id);
  }finally{await f.close();}
});
test('brainstorm rejects invalid model settings and unknown start receipts without creating new sessions',async()=>{
  const f=await fixture();try{
    const t=await f.brains.create({projectId:f.team.id,title:'Safe settings'});
    await assert.rejects(f.brains.settings({topicId:t.id,model:'missing',effort:'high'}),/不在本机/);
    await assert.rejects(f.brains.settings({topicId:t.id,model:'opus',effort:'ultra'}),/不支持/);
    await assert.rejects(f.brains.settings({topicId:t.id,model:'opus\ninvalid'}),/Invalid model/);
    await assert.rejects(f.brains.create({projectId:f.team.id,title:'Bad model',model:{id:'opus'}}),/Invalid model/);
    const brains=new Brainstorms(f.store,f.studio,async()=>{throw Error('connection lost');},()=>true,()=>{},f.files,f.media);
    await assert.rejects(brains.send({id:randomUUID(),topicId:t.id,text:'Start'}),/connection lost/);
    await assert.rejects(brains.settings({id:randomUUID(),topicId:t.id,model:'opus'}),/启动结果尚未确认/);
    assert.equal(f.brains.list().find(x=>x.id===t.id)?.model,undefined);
  }finally{await f.close();}
});
test('first brainstorm message waits for an in-flight preference save; uncertain settings do not replay',async()=>{
  const f=await fixture();try{
    const t=await f.brains.create({projectId:f.team.id,title:'Ordering'});let release!:()=>void;const gate=new Promise<void>(r=>release=r);
    const brains=new Brainstorms(f.store,f.studio,async(h,a)=>{if(a.type==='models')await gate;return f.remote(h,a);},()=>true,()=>{},f.files,f.media);
    const saving=brains.settings({id:randomUUID(),topicId:t.id,model:'opus',effort:'high'}),sending=brains.send({id:randomUUID(),topicId:t.id,text:'Start with chosen model'});
    await Promise.resolve();assert.equal(f.actions.some(a=>a.type==='start'),false);release();await Promise.all([saving,sending]);assert.equal(f.actions.find(a=>a.type==='start')?.model,'opus');
    const id=brains.list().find(x=>x.id===t.id)!.sessionId!,actionId=randomUUID();f.store.beginAction(actionId,t.hostId,{id:actionId,type:'set-model',sessionId:id,model:'sonnet',effort:'default'});
    await assert.rejects(brains.settings({id:actionId,topicId:t.id,model:'sonnet'}),/尚未确认/);assert.equal(f.actions.filter(a=>a.type==='set-model').length,0);
  }finally{await f.close();}
});
