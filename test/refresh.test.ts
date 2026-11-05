import {test} from 'node:test';
import assert from 'node:assert/strict';
import {coalescedRefresh} from '../web/refresh.js';
test('live polls share a read; a post-write refresh completes after one extra read even during event bursts',async()=>{
  const gates:Array<()=>void>=[],seen:boolean[]=[];const refresh=coalescedRefresh(async force=>{seen.push(force);await new Promise<void>(r=>gates.push(r));});
  const first=refresh();assert.equal(refresh(),first);const write=refresh(true);assert.equal(write,first);for(let i=0;i<50;i++)assert.equal(refresh(),first);gates.shift()!();await new Promise(r=>setImmediate(r));assert.deepEqual(seen,[false,true]);for(let i=0;i<50;i++)assert.equal(refresh(),first);gates.shift()!();await write;assert.equal(gates.length,0);
  const next=refresh();assert.notEqual(next,first);gates.shift()!();await next;
});
test('failed reads release the shared refresh so subsequent retries can recover',async()=>{let fail=true;const refresh=coalescedRefresh(async()=>{if(fail)throw Error('offline');});await assert.rejects(refresh(),/offline/);fail=false;await refresh(true);});
