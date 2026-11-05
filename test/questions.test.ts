import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {createServer} from 'node:net';import {once} from 'node:events';
import {CodexDesktop} from '../src/bridge/codex-desktop.js';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {randomUUID} from 'node:crypto';import {spawn} from 'node:child_process';
import {QuestionBroker} from '../src/bridge/questions.js';
import {normalizeQuestions} from '../src/shared/questions.js';
import {AgentRuntime} from '../src/bridge/runtime.js';import {BridgeStore} from '../src/bridge/store.js';
import {startQuestionHook} from '../src/bridge/question-hook-server.js';
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>boolean){for(let i=0;i<150;i++){if(fn())return;await pause(20);}throw Error('Question did not become available');}
function fixture(){const root=mkdtempSync(join(tmpdir(),'relay-questions-')),work=join(root,'work'),data=join(root,'bridge');mkdirSync(work);const store=new BridgeStore(data),events:any[]=[];const runtime=new AgentRuntime({relayUrl:'ws://127.0.0.1/bridge',hostId:'test',name:'test',dataDir:data,projects:[{id:'work',name:'work',path:work}],codexHome:join(root,'none'),claudeHome:join(root,'empty'),codexCommand:process.execPath,codexArgs:[fileURLToPath(new URL('./fixtures/codex.mjs',import.meta.url))]},store,()=>{},e=>events.push(e));return {root,work,data,store,events,runtime,async close(){await runtime.close();store.close();rmSync(root,{recursive:true,force:true});}};}

test('answers are explicit, scoped, consumed once, and cancellation never chooses an option',async()=>{
  const events:any[]=[],broker=new QuestionBroker(c=>events.push(c)),questions=normalizeQuestions([{id:'pick',question:'选择方案',options:[{label:'A'}],isOther:false}],'codex');
  const result=broker.ask('one','test',questions),card=events[0];await assert.rejects(broker.answer('other',card.id,{pick:['A']}),/不属于/);await assert.rejects(broker.answer('one',card.id,{}),/所有/);await assert.rejects(broker.answer('one',card.id,{pick:['B']}),/选项/);assert.equal(events.length,1);
  await broker.answer('one',card.id,{pick:['A']});assert.deepEqual(await result,{pick:['A']});await assert.rejects(broker.answer('one',card.id,{pick:['A']}),/已回答/);
  const again=broker.attach('one','test',questions,async()=>{throw new Error('must not replay');});assert.equal(again.status,'answered');assert.equal(broker.list('one').length,0);
  const controller=new AbortController(),pending=broker.ask('one','cancel',questions,controller.signal);controller.abort();assert.equal(await pending,undefined);assert.equal(events.at(-1).status,'cancelled');broker.close();
});

test('managed resume reconciles an async card answered through the relay without clearing native questions',async()=>{
 const f=fixture();try{
  const nativeId=randomUUID(),sid='test:codex:'+nativeId,session={id:sid,hostId:'test',nativeId,provider:'codex',managed:true,cwd:f.work,projectId:'work',title:'Resumed task',status:'running',updatedAt:Date.now()};
  (f.runtime as any).managed.set(sid,session);f.store.save(session as any);
  const questions=normalizeQuestions([{title:'选哪个？',options:['A','B']}],'async');
  f.runtime.questions.attach(sid,'async:old',questions,async()=>{});f.runtime.questions.attach(sid,'codex:turn:request',questions,async()=>{});
  (f.runtime.history as any).asyncQuestions=()=>[];
  const current=f.runtime.list().find(s=>s.id===sid)!;assert.equal(current.questionCount,1);assert.equal(f.runtime.questions.list(sid)[0].source,'codex:turn:request');assert.equal(current.status,'running');
 }finally{await f.close();}
});

test('managed Codex waits for the web answer and receives the exact request response without queueing',async()=>{
  const f=fixture();try{
    const {sessionId}=await f.runtime.handle({id:randomUUID(),type:'start',provider:'codex',projectId:'work',text:'question'});await until(()=>f.runtime.questions.list(sessionId).length===1);
    const card=f.runtime.questions.list(sessionId)[0];assert.equal(f.runtime.list().find(s=>s.id===sessionId)?.status,'waiting');
    await f.runtime.handle({id:randomUUID(),type:'answer',sessionId,questionId:card.id,answers:{choice:['方案 B'],details:['保留用户文件']}});
    await until(()=>f.events.some(e=>e.data.text?.startsWith('QUESTION_ANSWERED:')));assert.deepEqual(JSON.parse(f.events.find(e=>e.data.text?.startsWith('QUESTION_ANSWERED:')).data.text.split('QUESTION_ANSWERED:')[1]),{choice:{answers:['方案 B']},details:{answers:['保留用户文件']}});assert.equal(f.store.queued().length,0);await until(()=>f.runtime.list().find(s=>s.id===sessionId)?.status==='idle');
  }finally{await f.close();}
});

test('Claude AskUserQuestion returns original questions and selected labels through updatedInput',async()=>{
  const f=fixture();let received:any;
  (f.runtime as any).claudeQuery=({options}:any)=>{const gen=(async function*(){received=await options.canUseTool('AskUserQuestion',{questions:[{question:'选择模块',header:'模块',multiSelect:true,options:[{label:'A'},{label:'B'}]}]},{signal:new AbortController().signal,toolUseID:'claude-ask'});yield {type:'result',is_error:false};})();return Object.assign(gen,{close(){}});};
  try{const {sessionId}=await f.runtime.handle({id:randomUUID(),type:'start',provider:'claude',projectId:'work',text:'ask'});await until(()=>f.runtime.questions.list(sessionId).length===1);const card=f.runtime.questions.list(sessionId)[0];await f.runtime.handle({id:randomUUID(),type:'answer',sessionId,questionId:card.id,answers:{q0:['A','B']}});await until(()=>!!received);assert.equal(received.behavior,'allow');assert.equal(received.updatedInput.answers['选择模块'],'A, B');assert.equal(received.updatedInput.questions[0].question,'选择模块');assert.equal(f.events.some(e=>e.type==='approval'),false);}finally{await f.close();}
});

test('native Claude hook authenticates locally, waits for a real answer and only handles AskUserQuestion',async()=>{
  const f=fixture(),hook=startQuestionHook(f.runtime,f.data),sessionId=randomUUID();let child:ReturnType<typeof spawn>|undefined;
  try{await until(()=>existsSync(join(f.data,'question-hook.json')));const descriptor=JSON.parse(readFileSync(join(f.data,'question-hook.json'),'utf8'));const rejected=await fetch('http://127.0.0.1:'+descriptor.port+'/ask',{method:'POST',headers:{Authorization:'Bearer wrong'},body:'{}'});assert.equal(rejected.status,403);
    child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/claude-question-hook.mjs',import.meta.url)),join(f.data,'question-hook.json')],{stdio:'pipe',windowsHide:true});let output='';child.stdout!.on('data',c=>output+=c);const ended=new Promise(resolve=>child!.on('close',resolve));
    child.stdin!.end(JSON.stringify({session_id:sessionId,cwd:f.work,hook_event_name:'PreToolUse',tool_name:'AskUserQuestion',tool_use_id:'native-tool',tool_input:{questions:[{question:'原生问题？',header:'问题',options:[{label:'继续'}],multiSelect:false}]}}));
    const key='test:claude:'+sessionId;await until(()=>f.runtime.questions.list(key).length===1);const card=f.runtime.questions.list(key)[0];assert.equal(output,'');await f.runtime.handle({id:randomUUID(),type:'answer',sessionId:key,questionId:card.id,answers:{q0:['继续']}});await ended;
    const reply=JSON.parse(output).hookSpecificOutput;assert.equal(reply.hookEventName,'PreToolUse');assert.equal(reply.updatedInput.answers['原生问题？'],'继续');assert.equal(reply.permissionDecision,'allow');
  }finally{child?.kill();hook.close();await f.close();}
});

test('native Codex follower observes the actual owner prompt and answers it without starting another writer',async()=>{
  const root=mkdtempSync(join(tmpdir(),'native-question-ipc-')),path=process.platform==='win32'?'\\\\.\\pipe\\relay-question-'+randomUUID():join(root,'socket'),owner=randomUUID(),thread=randomUUID(),frames:any[]=[];let socket:any;
  const send=(value:any)=>{const data=Buffer.from(JSON.stringify(value)),frame=Buffer.alloc(data.length+4);frame.writeUInt32LE(data.length);data.copy(frame,4);socket.write(frame);};
  const server=createServer(s=>{socket=s;let buffer=Buffer.alloc(0);s.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4&&buffer.length>=buffer.readUInt32LE()+4){const size=buffer.readUInt32LE(),message=JSON.parse(buffer.subarray(4,size+4).toString());buffer=buffer.subarray(size+4);frames.push(message);
    if(message.type==='broadcast'){if(message.params.following)send({type:'broadcast',method:'thread-stream-state-changed',sourceClientId:owner,version:11,params:{hostId:'local',conversationId:thread,change:{type:'snapshot',revision:1,conversationState:{requests:[{id:42,method:'item/tool/requestUserInput',params:{questions:[{id:'which',question:'选哪个？',options:[{label:'A'}]}]}}]}}}});continue;}
    const result=message.method==='initialize'?{clientId:randomUUID()}:message.method==='thread-owner-discovery'?{supportsUntrustedAppInput:true}:{ok:true};send({type:'response',requestId:message.requestId,resultType:'success',handledByClientId:owner,result});
  }});});server.listen(path);await once(server,'listening');const desktop=new CodexDesktop(path);let observed:any[]=[];desktop.onRequests=(_id,requests)=>{observed=requests;};
  try{await desktop.watch(thread);await until(()=>observed.length===1);await desktop.answer(thread,42,{which:['A']});const response=frames.find(f=>f.method==='thread-follower-submit-user-input');assert.equal(response.version,1);assert.equal(response.targetClientId,owner);assert.deepEqual(response.params.response,{answers:{which:{answers:['A']}}});assert.equal(frames.some(f=>['thread/start','thread/resume','turn/start'].includes(f.method)),false);
    send({type:'broadcast',method:'thread-stream-state-changed',sourceClientId:owner,version:11,params:{hostId:'local',conversationId:thread,change:{type:'patches',baseRevision:1,revision:2,patches:[{op:'remove',path:['requests',0]}]}}});await until(()=>observed.length===0);await assert.rejects(desktop.answer(thread,42,{which:['A']}),/关闭/);
  }finally{desktop.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}
});

test('native asynchronous question replies preserve Codex item IDs and use the active turn instead of the queue',async()=>{
  const f=fixture(),nativeId=randomUUID(),s={id:'test:codex:'+nativeId,hostId:'test',provider:'codex' as const,nativeId,cwd:f.work,status:'running' as const,title:'native async',updatedAt:Date.now(),statusOrigin:'native' as const};let delivered='';
  const q={sourceId:'call_native_question',questions:normalizeQuestions([{title:'该怎么处理？',options:['保留','修改']}],'async')};
  f.runtime.history.get=()=>s;f.runtime.history.list=()=>[s];f.runtime.history.page=async()=>({messages:[],cursor:null,source:'fixture'});f.runtime.history.asyncQuestions=()=>delivered?[]:[q];f.runtime.codexDesktop.watch=async()=>{};f.runtime.codexDesktop.available=()=>true;f.runtime.codexDesktop.steer=async(_id,_client,text)=>{delivered=text;return {turnId:'same-turn'};};
  try{const page=await f.runtime.handle({id:randomUUID(),type:'history',sessionId:s.id}),card=page.questions[0];await f.runtime.handle({id:randomUUID(),type:'answer',sessionId:s.id,questionId:card.id,answers:{q0:['保留']}});assert.match(delivered,/send_user_message_question_reply/);const reply=JSON.parse(delivered.split('\n')[1])[0];assert.deepEqual(JSON.parse(reply.questionItemId),['request_user_input_async','call_native_question',0]);assert.equal(reply.answer,'保留');assert.equal(f.store.queued().length,0);}finally{await f.close();}
});

test('idle asynchronous question answers resume the original native thread with no desktop owner',async()=>{
 const f=fixture(),nativeId=randomUUID(),s={id:'test:codex:'+nativeId,hostId:'test',provider:'codex' as const,nativeId,cwd:f.work,status:'idle' as const,title:'headless question',updatedAt:Date.now(),statusOrigin:'native' as const};
 f.runtime.history.get=()=>s;f.runtime.history.list=()=>[s];f.runtime.history.page=async()=>({messages:[],cursor:null,source:'fixture'});f.runtime.history.refreshSessionStatus=async()=>{};f.runtime.history.asyncQuestions=()=>[{sourceId:'call_headless',questions:normalizeQuestions([{title:'继续哪种方案？',options:['A']}],'async')}];f.runtime.codexDesktop.owner=async()=>undefined;f.runtime.codexDesktop.watch=async()=>{};
 try{const page=await f.runtime.handle({id:randomUUID(),type:'history',sessionId:s.id}),card=page.questions[0],result=await f.runtime.handle({id:randomUUID(),type:'answer',sessionId:s.id,questionId:card.id,answers:{q0:['A']}});assert.equal(result.ok,true);assert.equal(result.sessionId,s.id);assert.equal(result.queued,false);await until(()=>f.events.some(e=>e.type==='message'&&e.data.text==='本地测试完成'));assert.equal(f.runtime.questions.list(s.id).length,0);assert.equal(f.events.filter(e=>e.type==='message'&&e.data.role==='user').length,1);assert.equal(f.runtime.get(s.id).nativeId,nativeId);}finally{await f.close();}
});

test('active async question answers queue without starting another writer when the desktop owner is absent',async()=>{
 const f=fixture(),nativeId=randomUUID(),s={id:'test:codex:'+nativeId,hostId:'test',provider:'codex' as const,nativeId,cwd:f.work,status:'running' as const,title:'active native',updatedAt:Date.now(),statusOrigin:'native' as const};
 f.runtime.history.get=()=>s;f.runtime.history.list=()=>[s];f.runtime.history.page=async()=>({messages:[],cursor:null,source:'fixture'});f.runtime.history.refreshSessionStatus=async()=>{};f.runtime.history.asyncQuestions=()=>[{sourceId:'call_active',questions:normalizeQuestions([{title:'继续？',options:['A']}],'async')}];f.runtime.codexDesktop.watch=async()=>{};f.runtime.codexDesktop.steer=async()=>{throw Error('未找到支持引导的本地 Codex 窗口；消息仍保留在队列中');};
 let starts=0;f.runtime.codex.start=async()=>{starts++;throw Error('must not start');};
 try{const page=await f.runtime.handle({id:randomUUID(),type:'history',sessionId:s.id}),card=page.questions[0],result=await f.runtime.handle({id:randomUUID(),type:'answer',sessionId:s.id,questionId:card.id,answers:{q0:['A']}});assert.equal(result.queued,true);assert.equal(f.store.queued().length,1);assert.equal(starts,0);assert.equal(f.runtime.questions.list(s.id).length,0);assert.equal(f.events.findLast(e=>e.type==='question.resolved')?.data.delivery,'queued');}finally{await f.close();}
});


test('managed Codex history discovers asynchronous questions without a desktop follower or a second writer',async()=>{
 const f=fixture(),nativeId=randomUUID(),s={id:'test:codex:'+nativeId,hostId:'test',provider:'codex' as const,nativeId,cwd:f.work,status:'running' as const,title:'managed async',updatedAt:Date.now(),managed:true};let watches=0;
 f.runtime.history.get=()=>s;f.runtime.history.list=()=>[s];f.runtime.history.page=async()=>({messages:[],cursor:null,source:'fixture'});f.runtime.history.asyncQuestions=()=>[{sourceId:'call_managed',questions:normalizeQuestions([{title:'怎么继续？',options:['沿用现有方案']}],'async')}];f.runtime.codexDesktop.watch=async()=>{watches++;};
 try{const page=await f.runtime.handle({id:randomUUID(),type:'history',sessionId:s.id,live:true});assert.equal(page.questions.length,1);assert.equal(page.questions[0].source,'async:call_managed');assert.equal(watches,0);assert.equal(f.store.queued().length,0);}finally{await f.close();}
});
