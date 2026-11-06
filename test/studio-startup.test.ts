import {test} from 'node:test';import assert from 'node:assert/strict';
// @ts-expect-error Browser module.
import {createStudioStartup} from '../web/studio-startup.js';
test('studio releases the shell before data arrives and recovers a failed first read',async()=>{
 const seen:string[]=[],timers:{fn:()=>void;ms:number}[]=[];let attempts=0;
 const startup=createStudioStartup({load:async()=>{attempts++;seen.push('read');if(attempts===1)throw Object.assign(Error('timeout'),{transport:true});},show:()=>seen.push('show'),ready:()=>seen.push('ready'),success:()=>seen.push('success'),error:()=>seen.push('error'),schedule:(fn:()=>void,ms:number)=>{timers.push({fn,ms});return 1;},cancel(){}});
 const first=startup.start();assert.deepEqual(seen,['show','ready']);await first;assert.deepEqual(seen,['show','ready','read','error']);assert.equal(timers[0].ms,60000);timers.shift()!.fn();await new Promise(r=>setImmediate(r));assert.equal(attempts,2);assert.equal(seen.at(-1),'success');
});
test('studio initial transport recovery stops after five reads and manual retry starts a fresh attempt',async()=>{
 const timers:Function[]=[],errors:any[]=[];let reads=0;
 const startup=createStudioStartup({load:async()=>{reads++;throw Object.assign(Error('offline'),{transport:true});},show(){},ready(){},success(){},error:(_e:any,n:number,retry:boolean)=>errors.push([n,retry]),schedule:(fn:Function)=>{timers.push(fn);return fn;},cancel:(fn:Function)=>{const i=timers.indexOf(fn);if(i>=0)timers.splice(i,1);}});
 await startup.start();while(timers.length){timers.shift()!();await new Promise(r=>setImmediate(r));}assert.equal(reads,5);assert.deepEqual(errors.at(-1),[5,false]);await startup.start();assert.equal(reads,6);assert.deepEqual(errors.at(-1),[1,true]);startup.stop();assert.equal(timers.length,0);
});
test('unauthorized startup does not retry or reveal a stale authenticated result',async()=>{
 let release:()=>void=()=>{},success=false,retries=0;
 const startup=createStudioStartup({load:()=>new Promise<void>(r=>{release=r;}),show(){},ready(){},success:()=>success=true,error(){},schedule:()=>retries++,cancel(){}});
 const job=startup.start();await Promise.resolve();startup.stop();release();await job;assert.equal(success,false);assert.equal(retries,0);
});
