import {test} from 'node:test';
import assert from 'node:assert/strict';
import {orderedMessages,acceptsStatusEvent} from '../web/timeline.js';

test('historical failures cannot replace authoritative current state and native status',()=>{
  const current={status:'idle',updatedAt:300,managed:true};
  assert.equal(acceptsStatusEvent(current,{at:100},true),false);
  assert.equal(acceptsStatusEvent(current,{at:100}),false);
  assert.equal(acceptsStatusEvent(current,{at:301}),true);
  assert.equal(acceptsStatusEvent({...current,managed:false,statusOrigin:'native'},{at:400}),false);
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
