// Explicit live test: creates two new local agent sessions and uses existing CLI logins.
// Nothing leaves this computer except the agents' normal model requests.
import {createRelay} from '../src/relay/server.js';
import {startBridge} from '../src/bridge/connector.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
const root=resolve('.data/live-smoke-'+Date.now());mkdirSync(join(root,'workspace'),{recursive:true});
const token=randomBytes(32).toString('hex'),phone=randomBytes(32).toString('hex');
const relay=createRelay({dataDir:join(root,'relay'),bridgeToken:token,phoneToken:phone});relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
const base=`http://127.0.0.1:${(relay.server.address() as {port:number}).port}`;
const bridge=startBridge({relayUrl:base.replace('http','ws')+'/bridge',hostId:'live-smoke',name:'本机真实 Agent 测试',dataDir:join(root,'bridge'),projects:[{id:'smoke',name:'隔离测试目录',path:join(root,'workspace')}]},token);
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const results=[];
try{
  for(let i=0;i<100&&!relay.store.hosts().length;i++)await pause(100);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({token:phone})});const cookie=login.headers.get('set-cookie')!.split(';')[0];
  for(const provider of ['codex','claude']){
    const response=await fetch(base+'/api/actions',{method:'POST',headers:{'Content-Type':'application/json',Origin:base,cookie},body:JSON.stringify({id:randomUUID(),type:'start',hostId:'live-smoke',projectId:'smoke',provider,text:'这是本地中转功能连通性测试。不要调用任何工具，不要读取或修改文件，只回复 AGENT_RELAY_SMOKE_OK。'})});
    const value=await response.json() as any;
    if(!response.ok){results.push({provider,ok:false,error:value.error});continue;}
    const id=value.sessionId;let status='running';
    for(let i=0;i<1200;i++){status=relay.store.getSession(id)?.status??'running';if(!['running','waiting'].includes(status))break;await pause(100);}
    const events=relay.store.sessionEvents(id);const answer=events.filter(e=>e.type==='message'&&e.data.role==='assistant').map(e=>e.data.text).join('\n');
    const errors=events.filter(e=>e.type==='error').map(e=>e.data.message);
    results.push({provider,status,ok:status==='idle'&&answer.includes('AGENT_RELAY_SMOKE_OK'),answer:answer.slice(0,500),errors});
    console.log(`${provider}: ${status}`);
    if(['running','waiting'].includes(status))await bridge.runtime.handle({id:randomUUID(),type:'stop',sessionId:id});
  }
  console.log(JSON.stringify({results,evidenceDirectory:root},null,2));
  if(results.some(r=>!r.ok))process.exitCode=1;
}finally{await bridge.close();await relay.close();}
