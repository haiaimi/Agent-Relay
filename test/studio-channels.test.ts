import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RelayStore} from '../src/relay/store.js';
import {studioChannels,channelPreview} from '../src/relay/studio-channels.js';
import type {StudioProject,StudioRun} from '../src/relay/studio.js';
import type {Session} from '../src/shared/protocol.js';

test('channel summaries use scoped cached replies and live messages, include private chats and real task progress',()=>{
  const dir=mkdtempSync(join(tmpdir(),'studio-channels-')),store=new RelayStore(dir);
  try{
    const project={hostId:'pc',roles:[{role:'director',enabled:true},{role:'concept',enabled:true},{role:'engineering',enabled:true},{role:'qa',enabled:false}]} as StudioProject;
    const run={id:'run',title:'第一关',createdAt:1,planner:{id:'plan',role:'director',status:'done',summary:'旧计划',finishedAt:2},tasks:[{id:'art',role:'concept',title:'场景原画',status:'done',sessionId:'art',summary:'旧原画摘要',finishedAt:3},{id:'approval',role:'director',status:'awaiting-review',kind:'visual-review',title:'确认原画'},{id:'code',role:'engineering',status:'queued',title:'玩法实现'}],chats:[{role:'concept',sessionId:'private'}],guidance:[],log:[]} as unknown as StudioRun;
    const session=(id:string,hostId='pc')=>store.session({id,hostId,provider:'claude',nativeId:id,cwd:dir,title:id,status:'idle',updatedAt:10} as Session);
    session('art');session('private');session('unrelated');store.cache('art',undefined,{messages:[{id:'cached',role:'assistant',text:'本轮原画已生成',timestamp:5}],cursor:null,source:'native'});
    store.event({id:'new',hostId:'pc',sessionId:'private',type:'message',at:8,data:{id:'private-reply',role:'assistant',text:'根据你的建议改为暖色光'}});
    store.event({id:'secret',hostId:'pc',sessionId:'unrelated',type:'message',at:99,data:{id:'other',role:'assistant',text:'UNRELATED_PRIVATE_CONTENT'}});
    const value=studioChannels(run,project,store,[]);const art=value.channels.find(c=>c.role==='concept')!;
    assert.equal(art.preview,'根据你的建议改为暖色光');assert.equal(art.sessionId,'private');assert.equal(art.done,1);assert.equal(art.total,1);assert.equal(art.state,'done');
    assert.equal(value.channels.find(c=>c.role==='director')!.state,'waiting');assert.match(value.channels.find(c=>c.role==='director')!.progress,/确认原画/);
    assert.equal(value.channels.find(c=>c.role==='engineering')!.taskId,'code');assert.equal(value.channels.find(c=>c.role==='qa'),undefined);assert.doesNotMatch(JSON.stringify(value),/UNRELATED_PRIVATE_CONTENT/);
    store.event({id:'producer',hostId:'pc',sessionId:'private',type:'message',at:10,data:{id:'user-latest',role:'user',text:'把门放在右侧'}});
    assert.equal(studioChannels(run,project,store,[]).channels.find(c=>c.role==='concept')!.author,'user');
    const group=studioChannels(run,project,store,[{id:'post',runId:'run',at:11,text:'大家先等视觉确认',roles:[],files:[],deliveries:[]}]).channels[0];assert.equal(group.preview,'大家先等视觉确认');assert.equal(group.author,'user');assert.equal(group.previewRole,'producer');assert.equal(group.state,'waiting');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('channel preview extracts deliverable summaries, bounds text, and does not display source markup',()=>{
  assert.equal(channelPreview('```STUDIO_RESULT\n{"summary":"原画已完成","checks":["PASS"]}\n```'),'原画已完成');
  assert.equal(channelPreview('```STUDIO_PLAN\n{"tasks":[{},{}]}\n```'),'已提交制作计划 · 2 个任务');
  assert.equal(channelPreview('**参考图** ![图](file.png)\n[说明](https://example.com)'),'参考图 [图片] 说明');
  assert.equal(channelPreview('长'.repeat(1000)).length,160);assert.doesNotThrow(()=>channelPreview('```STUDIO_RESULT\n{"summary":{}}\n```'));
});
