import {test} from 'node:test';import assert from 'node:assert/strict';
// @ts-expect-error Shared browser helper has no imports or side effects.
import {taskFocusKind,revealTaskSection} from '../web/studio-task-focus.js';

test('a blocked QA detail reveals its actual reason while pending input targets the confirmation card',()=>{
 const task={id:'qa',role:'qa',status:'blocked',error:'视觉未达到批准参考'};
 assert.equal(taskFocusKind(task,{status:'idle'}),'blocker');assert.equal(taskFocusKind(task,{status:'waiting'}),'attention');assert.equal(taskFocusKind(task,{status:'idle',questionCount:1}),'attention');
 assert.equal(taskFocusKind({status:'awaiting-review',kind:'producer-review'}),'attention');assert.equal(taskFocusKind({status:'running'},{status:'running'}),'execution');assert.equal(taskFocusKind({status:'done'}),'delivery');assert.equal(task.status,'blocked');
});
test('revealing the same section focuses visibly and scrolls only the detail body without moving the page',()=>{
 const scrolls:any[]=[],focus:any[]=[],classes=new Set(),container:any={scrollTop:120,scrollHeight:1500,clientHeight:500,getBoundingClientRect:()=>({top:80}),scrollTo:(v:any)=>scrolls.push(v)};
 const details:any={tagName:'DETAILS',open:false,parentElement:container},section:any={hidden:false,parentElement:details,offsetWidth:200,getBoundingClientRect:()=>({top:500}),focus:(v:any)=>focus.push(v),classList:{add:(s:any)=>classes.add(s),remove:(s:any)=>classes.delete(s)}};
 for(let i=0;i<2;i++)assert.equal(revealTaskSection(section,container),true);
 assert.equal(details.open,true);assert.equal(section.tabIndex,-1);assert.deepEqual(focus,[{preventScroll:true},{preventScroll:true}]);assert.deepEqual(scrolls,[{top:528,behavior:'smooth'},{top:528,behavior:'smooth'}]);assert.ok(classes.has('task-revealed'));
});
test('detail scrolling respects reduced motion, clamps to its bounds and handles absent targets',()=>{
 const scrolls:any[]=[],container:any={scrollTop:0,scrollHeight:600,clientHeight:500,getBoundingClientRect:()=>({top:0}),scrollTo:(v:any)=>scrolls.push(v)},section:any={hidden:false,offsetWidth:100,parentElement:container,getBoundingClientRect:()=>({top:900}),focus(){},classList:{add(){},remove(){}}};
 assert.equal(revealTaskSection(section,container,true),true);assert.deepEqual(scrolls,[{top:100,behavior:'auto'}]);assert.equal(revealTaskSection(null,container),false);assert.equal(revealTaskSection(section,null),false);section.hidden=true;assert.equal(revealTaskSection(section,container),false);assert.equal(scrolls.length,1);
});
