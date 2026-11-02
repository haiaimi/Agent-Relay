import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BridgeStore} from '../src/bridge/store.js';
test('input queue survives restart in order and never replays an uncertain dispatch',()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-input-'));let store=new BridgeStore(root);
  try{
    store.enqueue({id:'queued-1',type:'send',sessionId:'pc:claude:test',text:'first'});store.enqueue({id:'queued-2',type:'send',sessionId:'pc:claude:test',text:'second'});
    store.inputState('queued-1','dispatching');store.close();store=new BridgeStore(root);
    assert.equal(store.claimInput('queued-1','pc:claude:test','steering'),false);
    assert.equal(store.claimInput('queued-2','another-session','steering'),false);
    assert.deepEqual(store.queued().map(a=>a.id),['queued-2']);store.inputState('queued-2','cancelled');assert.equal(store.queued().length,0);
  }finally{store.close();assert.ok(root.startsWith(join(tmpdir(),'relay-input-')));rmSync(root,{recursive:true,force:true});}
});
