import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {MAX_TEXT,validateAction} from '../src/shared/protocol.js';
import {RelayStore} from '../src/relay/store.js';import {StudioMainline,assertMainlineIdle} from '../src/relay/studio-mainline.js';
test('mainline dispatch requires acceptance, preserves target and journals uncertain requests without duplicates',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-mainline-')),store=new RelayStore(dir);let count=0,uncertain=false;
 const project:any={id:'p',hostId:'pc',permissionMode:'full',roles:[{role:'engineering',enabled:true,provider:'codex',model:'gpt-6.1-terra',effort:'medium'}]};
 const r:any={largeHistoricalOutput:'x'.repeat(MAX_TEXT*12),id:randomUUID(),projectId:'p',title:'3C',status:'review',tasks:[],workspace:{status:'ready',value:{project:{id:'studio-'+randomUUID(),path:join(dir,'worktree')},sourcePath:dir,branch:'codex/task'}}};
 const studio:any={runs:()=>[r],projects:()=>[project]};const svc=new StudioMainline(store,studio,async(_host,a)=>{count++;assert.ok(a.text!.length<MAX_TEXT);assert.doesNotThrow(()=>validateAction(a));assert.doesNotMatch(a.text!,/largeHistoricalOutput/);assert.equal(a.projectId,r.workspace.value.project.id);assert.equal(a.provider,'codex');assert.match(a.text!,/禁止 stash\/reset\/clean\/force/);assert.match(a.text!,/不推送远程/);if(uncertain)throw Error('timeout');return {sessionId:'pc:codex:merge'};},()=>true,()=>{});
 const v={id:randomUUID(),runId:r.id,targetBranch:'main'};
 try{
  await assert.rejects(svc.start(v),/最终验收/);assert.equal(count,0);r.status='accepted';
  await assert.rejects(svc.start({...v,targetBranch:'main;rm'}),/目标分支/);
  const j=await svc.start(v);assert.equal(j!.phase,'running');assert.throws(()=>assertMainlineIdle(store,r.id),/正在合入/);await svc.start(v);assert.equal(count,1);
  await assert.rejects(svc.start({...v,targetBranch:'master'}),/其他合入/);
  await assert.rejects(svc.start({...v,id:randomUUID()}),/已有合入/);
  store.session({id:'pc:codex:merge',hostId:'pc',provider:'codex',nativeId:'merge',projectId:r.workspace.value.project.id,cwd:r.workspace.value.project.path,title:'merge',status:'idle',managed:true,updatedAt:Date.now()});
  const report={outcome:'merged',targetBranch:'main',targetCommit:'a'.repeat(40),sourceCommit:'b'.repeat(40),summary:'actual local merge',checks:['git merge-base --is-ancestor exit 0']};
  store.event({id:randomUUID(),hostId:'pc',sessionId:'pc:codex:merge',type:'message',data:{id:randomUUID(),role:'assistant',text:'```STUDIO_MERGE_RESULT\n'+JSON.stringify(report)+'\n```'},at:Date.now()});
  assert.equal(svc.list(r.id)[0].phase,'reported');assert.doesNotThrow(()=>assertMainlineIdle(store,r.id));uncertain=true;const retry={...v,id:randomUUID()};assert.equal((await svc.start(retry))!.phase,'uncertain');await svc.start(retry);assert.equal(count,2);await assert.rejects(svc.recover({id:retry.id,runId:r.id}),/可能已执行/);const legacy=JSON.parse(String(store.db.prepare('SELECT json FROM studio_mainline_jobs WHERE id=?').get(retry.id)!.json));legacy.action.text='x'.repeat(MAX_TEXT+1);store.db.prepare('UPDATE studio_mainline_jobs SET json=? WHERE id=?').run(JSON.stringify(legacy),retry.id);uncertain=false;const recovered=await svc.recover({id:retry.id,runId:r.id});assert.equal(recovered!.phase,'running');assert.equal(count,3);await svc.recover({id:retry.id,runId:r.id});assert.equal(count,3);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
