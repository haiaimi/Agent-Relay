import {test} from 'node:test';
import assert from 'node:assert/strict';
import {orderedMessages,acceptsStatusEvent,HistoryPager,reconcileChildren,timelineWithQuestions} from '../web/timeline.js';
test('question cards remain at the original turn after answering and newer messages arrive',()=>{
  const messages=[{id:'before',timestamp:100},{id:'later',timestamp:300}],card={id:'q',createdAt:200,status:'pending',source:'async:call'};
  const ids=(rows:any[])=>rows.map(m=>m.id);
  assert.deepEqual(ids(timelineWithQuestions(messages,[card])),['before','question:q','later']);
  const answered={...card,status:'answered'};
  assert.deepEqual(ids(timelineWithQuestions([...messages,{id:'newest',timestamp:500}],[answered])),['before','question:q','later','newest']);
  // An older settled question is absent from the newest history window; loading
  // its original range restores it instead of pinning it under current replies.
  assert.deepEqual(ids(timelineWithQuestions([{id:'latest',timestamp:500}],[answered])),['latest']);
  assert.deepEqual(ids(timelineWithQuestions([{id:'older',timestamp:100},{id:'latest',timestamp:500}],[answered])),['older','question:q','latest']);
});
test('question anchors override late observation times and unavailable settled anchors never jump to the bottom',()=>{
  const messages=[{id:'claude-tool:call-42',role:'tool'},{id:'next',role:'assistant'}];
  const card={id:'q',createdAt:900,status:'answered',source:'claude:call-42'};
  assert.deepEqual(timelineWithQuestions(messages,[card]).map((m:any)=>m.id),['claude-tool:call-42','question:q','next']);
  const captured={...card,source:'codex:turn:10',anchorId:'next'};
  assert.deepEqual(timelineWithQuestions(messages,[captured]).map((m:any)=>m.id),['claude-tool:call-42','next','question:q']);
  assert.deepEqual(timelineWithQuestions(messages,[{...card,anchorId:'next'}]).map((m:any)=>m.id),['claude-tool:call-42','next','question:q']);
  assert.equal(timelineWithQuestions([{id:'unrelated',timestamp:1000}],[captured]).length,1);
  assert.equal(timelineWithQuestions([],[{...captured,status:'pending'}])[0].role,'question');
});
test('unchanged history leaves existing nodes connected and prepending only inserts the new rows',()=>{
  const edits:string[]=[],a:any={id:'decoded-image'},b:any={id:'open-tool'},older:any={id:'older'};
  const parent:any={children:[a,b],get firstChild(){return this.children[0]??null;},insertBefore(child:any,before:any){edits.push('insert:'+child.id);const old=this.children.indexOf(child);if(old>=0)this.children.splice(old,1);this.children.splice(before?this.children.indexOf(before):this.children.length,0,child);},removeChild(child:any){edits.push('remove:'+child.id);this.children.splice(this.children.indexOf(child),1);}};
  for(const item of [a,b,older])Object.defineProperty(item,'nextSibling',{get(){return parent.children[parent.children.indexOf(item)+1]??null;}});
  assert.equal(reconcileChildren(parent,[a,b]),false);assert.deepEqual(edits,[]);
  assert.equal(reconcileChildren(parent,[older,a,b]),true);assert.deepEqual(edits,['insert:older']);assert.equal(parent.children[1],a);assert.equal(parent.children[2],b);
  edits.length=0;assert.equal(reconcileChildren(parent,[older,a,b]),false);assert.deepEqual(edits,[]);
  assert.equal(reconcileChildren(parent,[older,b]),true);assert.deepEqual(parent.children,[older,b]);
});

test('historical failures cannot replace authoritative current state and native status',()=>{
  const current={status:'idle',updatedAt:300,managed:true};
  assert.equal(acceptsStatusEvent(current,{at:100},true),false);
  assert.equal(acceptsStatusEvent(current,{at:100}),false);
  assert.equal(acceptsStatusEvent(current,{at:301}),true);
  assert.equal(acceptsStatusEvent({...current,managed:false,statusOrigin:'native'},{at:400}),false);
});

test('history paging excludes concurrent polls and keeps the oldest cursor during refreshes',()=>{
  const pager=new HistoryPager();pager.reset('one');
  assert.equal(pager.begin(true),null);
  const initial=pager.begin()!;assert.equal(pager.complete(initial,100),true);
  const older=pager.begin(true)!;assert.equal(older.cursor,100);
  assert.equal(pager.begin(),null);assert.equal(pager.begin(true),null);
  assert.equal(pager.complete(older,50),true);
  const poll=pager.begin()!;assert.equal(pager.complete(poll,120),true);assert.equal(pager.cursor,50);
  assert.equal(pager.complete(pager.begin(true)!,null),true);
  pager.complete(pager.begin()!,130);assert.equal(pager.cursor,null);assert.equal(pager.begin(true),null);
});

test('failed history pages can retry the same cursor and late replies cannot affect a different selection',()=>{
  const pager=new HistoryPager();pager.reset('one');pager.complete(pager.begin()!,100);
  const failed=pager.begin(true)!;pager.release(failed);assert.equal(pager.cursor,100);
  const retry=pager.begin(true)!;assert.equal(retry.cursor,100);
  assert.throws(()=>pager.complete(retry,100),/未前进/);pager.release(retry);assert.equal(pager.cursor,100);
  const late=pager.begin(true)!;pager.reset('two');const active=pager.begin()!;
  assert.equal(pager.complete(late,50),false);assert.equal(pager.current(active),true);
  pager.reset('one');assert.equal(pager.complete(late,50),false);
});

test('old relay errors and queued messages stay before newer native replies after every refresh',()=>{
  const messages=new Map([
    ['latest',{id:'latest',timestamp:300,text:'最新回复'}],
    ['failed',{id:'failed',timestamp:100,text:'之前的写入冲突'}],
    ['queued',{id:'queued',timestamp:200,text:'后续提问'}]
  ]);
  assert.deepEqual(orderedMessages(messages.values()).map(m=>m.id),['failed','queued','latest']);
  messages.set('latest',{id:'latest',timestamp:300,text:'最新完整回复'});
  messages.set('older',{id:'older',timestamp:50,text:'加载更早记录'});
  assert.deepEqual(orderedMessages(messages.values()).map(m=>m.id),['older','failed','queued','latest']);
});
