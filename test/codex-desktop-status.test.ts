import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {CodexDesktop,desktopThreadStatus} from '../src/bridge/codex-desktop.js';

test('native runtime status takes precedence over retained turns, and approvals take precedence over active status',()=>{
 assert.equal(desktopThreadStatus({threadRuntimeStatus:{type:'active'},turns:[{status:'completed'}]}),'running');
 assert.equal(desktopThreadStatus({threadRuntimeStatus:{type:'idle'},turns:[{status:'inProgress'}]}),'idle');
 assert.equal(desktopThreadStatus({threadRuntimeStatus:{type:'active'},requests:[{}]}),'waiting');
 assert.equal(desktopThreadStatus({turns:[{status:'completed'},{status:'inProgress'}]}),'running');
 assert.equal(desktopThreadStatus({turns:[{status:'interrupted'}]}),'interrupted');
 assert.equal(desktopThreadStatus({threadRuntimeStatus:{type:'notLoaded'}}),undefined);
});

test('native stream tracks status patches without storing conversation contents, and drops stale or foreign owner state',()=>{
 const d=new CodexDesktop(''),internal=d as any,thread=randomUUID(),owner=randomUUID();
 internal.socket={writable:true,write(){},destroy(){}};internal.owners.set(thread,{owner,at:Date.now()});internal.following.set(thread,{owner,at:Date.now(),requests:[]});
 const send=(change:any,sourceClientId=owner)=>internal.broadcastReceived({method:'thread-stream-state-changed',sourceClientId,params:{hostId:'local',conversationId:thread,change}});
 try{
  send({type:'snapshot',revision:1,conversationState:{threadRuntimeStatus:{type:'active'},turns:[{status:'inProgress',items:['private contents']}],requests:[]}});
  assert.equal(d.status(thread)?.status,'running');assert.equal(JSON.stringify(internal.following.get(thread).state).includes('private contents'),false);
  send({type:'patches',baseRevision:1,revision:2,patches:[{op:'replace',path:['threadRuntimeStatus','type'],value:'idle'}]});assert.equal(d.status(thread)?.status,'idle');
  send({type:'patches',baseRevision:2,revision:3,patches:[{op:'replace',path:['requests'],value:[{method:'item/commandExecution/requestApproval'}]}]});assert.equal(d.status(thread)?.status,'waiting');
  send({type:'snapshot',revision:4,conversationState:{turns:[{status:'completed'}],requests:[]}});assert.equal(d.status(thread)?.status,'idle');
  send({type:'patches',baseRevision:4,revision:5,patches:[{op:'add',path:['turns',1],value:{status:'inProgress',items:['hidden']}},{op:'replace',path:['turns',1,'status'],value:'interrupted'}]});assert.equal(d.status(thread)?.status,'interrupted');
  send({type:'snapshot',revision:6,conversationState:{threadRuntimeStatus:{type:'active'}}},randomUUID());assert.equal(d.status(thread)?.status,'interrupted');
  send({type:'patches',baseRevision:0,revision:7,patches:[]});assert.equal(d.status(thread),undefined);
  send({type:'snapshot',revision:8,conversationState:{threadRuntimeStatus:{type:'active'}}});internal.owners.get(thread).at=Date.now()-30001;assert.equal(d.status(thread),undefined);
 }finally{d.close();}
});
