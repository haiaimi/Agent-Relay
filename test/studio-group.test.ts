import {test} from 'node:test';
import assert from 'node:assert/strict';
import {groupPage,groupEntries,type GroupEntry} from '../src/relay/studio-group.js';
test('group pagination retains tied timestamps without dropping or duplicating messages',()=>{
  const entries:GroupEntry[]=Array.from({length:250},(_,i)=>({id:'message-'+String(i).padStart(3,'0'),at:100,role:'level',kind:'reply',text:String(i)}));
  const latest=groupPage(entries),older=groupPage(entries,latest.cursor!),oldest=groupPage(entries,older.cursor!);
  const ids=[...oldest.messages,...older.messages,...latest.messages].map(m=>m.id);assert.equal(new Set(ids).size,250);assert.equal(ids.length,250);assert.equal(oldest.cursor,null);assert.throws(()=>groupPage(entries,'invalid'),/位置/);
});
test('group review presents native plan mirrors once as readable tasks and deduplicates simultaneous transcript copies',()=>{
  const plan='```STUDIO_PLAN\n'+JSON.stringify({tasks:[{id:'ld-1',role:'level',title:'第一关布局',dependencies:[],brief:'internal protocol details'}]})+'\n```';
  const run:any={planner:{id:'studio-plan',role:'director',title:'计划',sessionId:'planner'},tasks:[],log:[]};
  const events=[['a',1,'正在检查'],['b',1,'正在检查'],['c',2,plan],['d',3,plan]].map(([id,at,text])=>({id,type:'message',at,data:{id,role:'assistant',text}}));
  const rows=groupEntries(run,[],{sessionEvents:()=>events} as any,id=>id==='level'?'关卡策划':id);
  assert.equal(rows.length,2);assert.match(rows[1].text,/ld-1 · 关卡策划 · 第一关布局/);assert.doesNotMatch(rows[1].text,/internal protocol details|STUDIO_PLAN|\{"tasks"/);
});
