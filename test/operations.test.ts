import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Browser module is deliberately plain JavaScript.
import {SettingsWrites,SendReceipts} from '../web/operations.js';
const deferred=()=>{let resolve!:(value:any)=>void,reject!:(error:any)=>void;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('rapid settings changes stay editable, serialize writes and keep the latest full selection',async()=>{
 const calls:any[]=[],gates:any[]=[],accepted:any[]=[];
 const writes=new SettingsWrites((id:any,patch:any)=>{calls.push([id,patch]);const d=deferred();gates.push(d);return d.promise;},()=>{},(...args:any[])=>accepted.push(args));
 const job=writes.set('a',{model:'one',effort:'default'});await Promise.resolve();
 writes.set('a',{model:'two',effort:'default'});writes.set('a',{effort:'high'});
 assert.deepEqual(writes.pending('a'),{model:'two',effort:'high'});assert.equal(calls.length,1);
 gates[0].resolve({queued:true});await new Promise(r=>setImmediate(r));
 assert.deepEqual(calls[1],['a',{model:'two',effort:'high'}]);
 let complete=false;const barrier=writes.wait('a').then(()=>{complete=true;});assert.equal(complete,false);
 gates[1].resolve({queued:true});await job;await barrier;assert.equal(writes.pending('a'),undefined);assert.equal(accepted.length,2);
});
test('settings failure rejects dependent sends and does not retry the write automatically',async()=>{
 let calls=0;const failed:any[]=[];const writes=new SettingsWrites(async()=>{calls++;throw Error('offline');},()=>{},()=>{},(...args:any[])=>failed.push(args));
 const job=writes.set('a',{model:'x'});await assert.rejects(writes.wait('a'),/offline/);await assert.rejects(job,/offline/);
 assert.equal(calls,1);assert.equal(failed.length,1);assert.equal(writes.pending('a'),undefined);
});
test('send receipts preserve drafts per session and reconcile by action identity, never by matching text',()=>{
 const receipts=new SendReceipts(),a=receipts.begin('a','same'),b=receipts.begin('a','same'),c=receipts.begin('b','other');
 assert.notEqual(a.id,b.id);assert.equal(receipts.messages('a',[]).length,2);
 receipts.observe({id:a.id});assert.deepEqual(receipts.messages('a',[]).map((m:any)=>m.id),[b.id]);
 receipts.update(b.id,{delivery:'unknown'});assert.equal(receipts.messages('a',[])[0].delivery,'unknown');
 receipts.observe({id:'native',replaces:[b.id]});assert.equal(receipts.messages('a',[]).length,0);assert.equal(receipts.messages('b',[])[0].id,c.id);
});
