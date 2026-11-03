import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {AgentRegistry} from '../src/bridge/agents.js';
import {createRelay} from '../src/relay/server.js';
import {startBridge} from '../src/bridge/connector.js';

test('authenticated relay advertises configured API agents and routes models and real turns to the workstation',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-api-e2e-'));let requests=0;
  const model=createServer(async(req,res)=>{for await(const _ of req){}requests++;res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{delta:{content:'Workstation API reply'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');});await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));
  const registry=new AgentRegistry(join(root,'bridge'));registry.save({native:{codex:false,claude:false},agents:[{id:'grok-test',name:'Grok test',protocol:'chat',enabled:true,baseUrl:'http://127.0.0.1:'+(model.address() as any).port,apiKey:'never-send-this-key-to-the-relay',models:[{id:'test-model',name:'Test model'}],tools:false}]});
  const relay=createRelay({dataDir:join(root,'relay'),phoneToken:'p'.repeat(40),bridgeToken:'b'.repeat(40)});await new Promise<void>(r=>relay.server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+(relay.server.address() as any).port;
  const bridge=startBridge({relayUrl:origin.replace('http','ws')+'/bridge',hostId:'api-pc',name:'API PC',dataDir:join(root,'bridge'),projects:[{id:'p',name:'P',path:root}],discoverCodexProjects:false,codexHome:join(root,'empty-codex'),claudeHome:join(root,'empty-claude')},'b'.repeat(40));
  try{const login=await fetch(origin+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token:'p'.repeat(40)})});const cookie=login.headers.get('set-cookie')!.split(';')[0];
    const get=async(path:string)=>{const response=await fetch(origin+path,{headers:{Cookie:cookie}});assert.equal(response.status,200);return response.json() as any};
    let state:any;for(let i=0;i<100;i++){state=await get('/api/state');if(state.hosts.length)break;await new Promise(r=>setTimeout(r,10));}
    assert.equal(state.hosts[0].agents[0].id,'grok-test');assert.ok(!JSON.stringify(state).includes('never-send-this-key-to-the-relay'));
    const models=await get('/api/models?hostId=api-pc&provider=api&agentId=grok-test');assert.equal(models.models[0].id,'test-model');
    const response=await fetch(origin+'/api/actions',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({id:randomUUID(),type:'start',hostId:'api-pc',projectId:'p',provider:'api',agentId:'grok-test',text:'Hello API',model:'test-model'})});assert.equal(response.status,200);const result:any=await response.json();
    let history:any;for(let i=0;i<100;i++){history=await get('/api/history?sessionId='+encodeURIComponent(result.sessionId));if(history.messages.some((m:any)=>m.text==='Workstation API reply'))break;await new Promise(r=>setTimeout(r,10));}
    assert.equal(requests,1);assert.ok(history.messages.some((m:any)=>m.text==='Workstation API reply'));assert.ok(!JSON.stringify(history).includes('never-send-this-key-to-the-relay'));
  }finally{await bridge.close();await relay.close();await new Promise<void>(r=>model.close(()=>r()));}
});
