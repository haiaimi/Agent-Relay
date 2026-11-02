import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {codexUsageText,claudeUsageText} from '../src/bridge/usage.js';
import {BridgeStore} from '../src/bridge/store.js';
import {AgentRuntime} from '../src/bridge/runtime.js';

test('usage windows use actual durations and missing values never become zero consumption',()=>{
  const codex=codexUsageText({rateLimitsByLimitId:{codex:{primary:{usedPercent:31,windowDurationMins:10080,resetsAt:null}}},rateLimits:{primary:{usedPercent:0,windowDurationMins:300}}});
  assert.match(codex,/7 天：已用 31% · 剩余 69%/);assert.doesNotMatch(codex,/5 小时/);assert.match(codex,/重置：未知/);
  assert.match(codexUsageText({rateLimits:{primary:{usedPercent:null}}}),/已用 未知 · 剩余 未知/);
  const claude=claudeUsageText({subscription_type:'max',rate_limits_available:true,rate_limits:{five_hour:{utilization:100,resets_at:'2026-11-02T06:50:00Z'},seven_day:{utilization:null,resets_at:null}},session:{total_cost_usd:0}} as any);
  assert.match(claude,/5 小时：已用 100% · 剩余 0%/);assert.match(claude,/14:50:00/);assert.match(claude,/7 天：已用 未知 · 剩余 未知/);assert.doesNotMatch(claude,/成本/);
  assert.match(claudeUsageText({rate_limits_available:false,rate_limits:null} as any),/未返回套餐额度/);
});

test('Claude usage uses a metadata-only probe for an external session without resuming or queueing',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-usage-')),store=new BridgeStore(root),sessionId='test:claude:'+randomUUID(),events:any[]=[],options:any[]=[];let closed=false;
  store.save({id:sessionId,hostId:'test',provider:'claude',nativeId:sessionId.split(':').at(-1)!,cwd:root,title:'owned fixture',updatedAt:Date.now(),status:'idle',managed:false});
  store.enqueue({id:randomUUID(),type:'send',sessionId,text:'preserve queue'});
  const factory=(input:any)=>{options.push(input.options);return {async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts:any){assert.equal(opts.skipBehaviors,true);return {rate_limits_available:true,rate_limits:{five_hour:{utilization:42,resets_at:null}}};},close(){closed=true;}};};
  const runtime=new AgentRuntime({relayUrl:'ws://127.0.0.1:8787/bridge',hostId:'test',name:'test',dataDir:root,projects:[{id:'work',name:'work',path:root}]},store,()=>{},e=>events.push(e),factory as any);
  try{
    const result=await runtime.handle({id:randomUUID(),type:'send',sessionId,text:'/usage'});assert.equal(result.command,true);assert.equal(options.length,1);assert.equal(options[0].persistSession,false);assert.equal(options[0].resume,undefined);assert.equal(options[0].sessionId,undefined);assert.deepEqual(options[0].tools,[]);assert.equal(closed,true);
    assert.equal(store.queued().length,1);assert.equal(store.sessions()[0].status,'idle');assert.ok(events.some(e=>e.type==='message'&&e.data.text.includes('剩余 58%')));
    await assert.rejects(runtime.handle({id:randomUUID(),type:'send',sessionId,text:'/usage extra'}));assert.equal(options.length,1);
  }finally{await runtime.close();store.close();assert.ok(root.startsWith(join(tmpdir(),'relay-usage-')));rmSync(root,{recursive:true,force:true});}
});
