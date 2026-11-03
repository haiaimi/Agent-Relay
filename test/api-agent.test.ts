import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {AgentRegistry} from '../src/bridge/agents.js';
import {ApiAgentRun,executeApiTool} from '../src/bridge/api-agent.js';
import {AgentRuntime} from '../src/bridge/runtime.js';
import {BridgeStore} from '../src/bridge/store.js';
import {validateAction} from '../src/shared/protocol.js';

const model={id:'test-model',name:'Test model',isDefault:true,efforts:['low','high']};
function config(baseUrl:string){return {id:'test',name:'Test API',baseUrl,apiKey:'local-only-test-key',enabled:true,protocol:'chat' as const,models:[model],tools:true,reasoning:'standard' as const};}
async function mock(handler:(body:any)=>any){const requests:any[]=[];const server=createServer(async(req,res)=>{let text='';for await(const b of req)text+=b;const body=text?JSON.parse(text):{};requests.push({url:req.url,body,auth:req.headers.authorization});res.setHeader('Content-Type','text/event-stream');const values=handler(body);for(const value of values)res.write('data: '+JSON.stringify(value)+'\n\n');res.end('data: [DONE]\n\n');});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return {url:'http://127.0.0.1:'+(server.address() as any).port,requests,close:()=>new Promise<void>(r=>server.close(()=>r()))};}
const chunk=(delta:any,finish_reason:string|null=null)=>({choices:[{delta,finish_reason}]});
test('agent registry keeps keys local, preserves masked secrets, validates endpoints and defaults',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-registry-')),registry=new AgentRegistry(dir);
  registry.save({native:{codex:false,claude:true},agents:[config('https://example.com/v1')]});
  assert.equal(registry.public().agents[0].keyConfigured,true);assert.ok(!JSON.stringify(registry.public()).includes('local-only-test-key'));assert.ok(!JSON.stringify(registry.catalog()).includes('apiKey'));assert.equal(registry.catalog().some(a=>a.id==='codex'),false);
  registry.save(registry.public());assert.equal(registry.get('test').apiKey,'local-only-test-key');assert.throws(()=>registry.enabled('codex'),/disabled/);
  assert.throws(()=>registry.save({...registry.public(),agents:[{...config('http://example.com/v1')}]}),/HTTPS/);
  assert.throws(()=>registry.save({...registry.public(),agents:[{...config('https://key:secret@example.com/v1')}]}),/HTTPS/);
  registry.save({...registry.public(),agents:[{...registry.public().agents[0],clearKey:true}]});assert.throws(()=>registry.get('test'),/API key/);
  assert.throws(()=>validateAction({id:randomUUID(),type:'start',provider:'api',projectId:'p',text:'hi'}),/API agent/);
});
test('chat API tools require approval, preserve reasoning for subsequent requests, and obey project boundaries',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-api-')),calls:any[]=[],project=join(dir,'project');mkdirSync(project);writeFileSync(join(project,'input.txt'),'read me');
  let round=0;const server=await mock(()=>++round===1?[chunk({reasoning_content:'private-reasoning',tool_calls:[{index:0,id:'call-1',function:{name:'write_file',arguments:JSON.stringify({path:'result.txt',content:'ok'})}}]}),chunk({},'tool_calls')]:[chunk({content:'Done'}),chunk({},'stop')]);
  try{const run=new ApiAgentRun(dir,randomUUID());await run.run(config(server.url),model.id,'high',project,'Please write','request',{delta:(_id,text)=>calls.push(text),message:m=>calls.push(m),activity:()=>{},approve:async()=>false,ask:async()=>({})});
    assert.equal(existsSync(join(project,'result.txt')),false);assert.match(server.requests[1].body.messages.at(-1).content,/denied/);assert.equal(server.requests[1].body.messages[2].reasoning_content,'private-reasoning');assert.ok(!JSON.stringify(calls).includes('private-reasoning'));assert.equal(server.requests[0].body.reasoning_effort,'high');
    await assert.rejects(executeApiTool(project,'read_file',{path:'../outside'},new AbortController().signal));
    await assert.rejects(executeApiTool(project,'write_file',{path:'../outside.txt',content:'bad'},new AbortController().signal));
    assert.equal(await executeApiTool(project,'read_file',{path:'input.txt'},new AbortController().signal),'read me');
  }finally{await server.close();}
});
test('Responses API replays opaque reasoning and tool output, without exposing reasoning to the relay',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-responses-')),sent:any[]=[];let round=0;
  const server=await mock(()=>++round===1?[{type:'response.completed',response:{status:'completed',output:[{type:'reasoning',id:'r1',encrypted_content:'opaque'}, {type:'function_call',call_id:'c1',name:'list_files',arguments:'{"path":"."}'}]}}]:[{type:'response.output_text.delta',delta:'Ready'},{type:'response.completed',response:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Ready'}]}]}}]);
  try{const agent={...config(server.url),protocol:'responses' as const};await new ApiAgentRun(dir,randomUUID()).run(agent,model.id,'low',dir,'Inspect','request',{delta:()=>{},message:m=>sent.push(m),activity:()=>{},approve:async()=>{throw Error('read should not ask')},ask:async()=>({})});
    assert.equal(server.requests[0].url,'/responses');assert.equal(server.requests[0].body.store,false);assert.ok(server.requests[1].body.input.some((m:any)=>m.encrypted_content==='opaque'));assert.ok(server.requests[1].body.input.some((m:any)=>m.type==='function_call_output'));assert.ok(!JSON.stringify(sent).includes('opaque'));
  }finally{await server.close();}
});
test('runtime API sessions stream, complete, persist local history after relay acknowledgement, and support follow-ups',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-runtime-api-')),store=new BridgeStore(dir),registry=new AgentRegistry(dir),events:any[]=[];
  const server=await mock(()=>[chunk({content:'Hello API'}),chunk({},'stop')]);registry.save({native:{codex:false,claude:false},agents:[config(server.url)]});
  const runtime=new AgentRuntime({hostId:'test-host',name:'Test',relayUrl:'ws://127.0.0.1',dataDir:dir,projects:[{id:'p',name:'P',path:dir}],codexHome:join(dir,'no-codex'),claudeHome:join(dir,'no-claude'),discoverCodexProjects:false},store,()=>{},e=>events.push(e));
  try{const result=await runtime.handle({id:randomUUID(),type:'start',provider:'api',agentId:'test',projectId:'p',text:'Hello',model:model.id});
    const wait=async()=>{for(let i=0;i<100&&runtime.list().find(s=>s.id===result.sessionId)?.status==='running';i++)await new Promise(r=>setTimeout(r,10));};await wait();
    assert.equal(runtime.list().find(s=>s.id===result.sessionId)?.status,'idle');for(const e of store.outbox())store.ack(e.id);
    const page=await runtime.handle({id:randomUUID(),type:'history',sessionId:result.sessionId});assert.ok(page.messages.some((m:any)=>m.text==='Hello API'));assert.ok(page.messages.some((m:any)=>m.text==='Hello'));
    await runtime.handle({id:randomUUID(),type:'send',sessionId:result.sessionId,text:'Again'});await wait();assert.equal(server.requests.length,2);assert.equal(server.requests[1].body.messages.filter((m:any)=>m.role==='user').length,2);assert.ok(!JSON.stringify(events).includes('local-only-test-key'));
  }finally{await runtime.close();store.close();await server.close();}
});
test('stopping an API task while approval is pending cannot execute the write',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-api-stop-'));let reached!:()=>void;const pending=new Promise<void>(r=>reached=r);
  const server=await mock(()=>[chunk({tool_calls:[{index:0,id:'blocked',function:{name:'write_file',arguments:'{"path":"blocked.txt","content":"must not write"}'}}]}),chunk({},'tool_calls')]);
  try{const run=new ApiAgentRun(dir,randomUUID());const job=run.run(config(server.url),model.id,undefined,dir,'Write','request',{delta:()=>{},message:()=>{},activity:()=>{},ask:async()=>({}),approve:async(_name,_args,signal)=>{reached();return await new Promise<boolean>(resolve=>signal.addEventListener('abort',()=>resolve(false),{once:true}));}});await pending;run.stop();await assert.rejects(job,/stopped/);assert.equal(existsSync(join(dir,'blocked.txt')),false);}finally{await server.close();}
});
test('truncated or filtered model replies are not reported as successfully completed',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-api-incomplete-'));const server=await mock(()=>[chunk({content:'partial'},'length')]);
  try{await assert.rejects(new ApiAgentRun(dir,randomUUID()).run(config(server.url),model.id,undefined,dir,'Hello','request',{delta:()=>{},message:()=>{},activity:()=>{},approve:async()=>false,ask:async()=>({})}),/incomplete/);}finally{await server.close();}
});
