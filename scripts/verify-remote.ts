import {randomUUID} from 'node:crypto';
import {writeFileSync,mkdirSync} from 'node:fs';
const base=process.argv[2]??process.env.PUBLIC_ORIGIN;
if(!base)throw new Error('Pass the relay URL as the first argument or set PUBLIC_ORIGIN. This test creates real agent sessions.');
let cookie='';
async function api(path:string,body?:unknown){const r=await fetch(base+'/api/'+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json',Origin:base}:{}),...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined});const data=await r.json() as any;if(!r.ok)throw new Error(data.error??`HTTP ${r.status}`);const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return data;}
const action=(body:any)=>api('actions',{id:randomUUID(),...body});
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
await api('login',{token:process.env.PHONE_TOKEN});
const state=await api('state'),host=state.hosts.find((h:any)=>h.online);
if(!host)throw new Error('No local bridge connected');
console.log(JSON.stringify({device:host.hostname,projects:host.projects.length,sessions:state.sessions.length,sync:host.sync,statuses:state.sessions.reduce((a:any,s:any)=>(a[s.status]=(a[s.status]??0)+1,a),{})}));
const results=[];
for(const provider of ['codex','claude']){
  const list=(await api(`models?hostId=${host.id}&provider=${provider}`)).models;
  console.log(provider+' catalog: '+list.length);
  const project=host.projects.find((p:any)=>p.source==='configured')??host.projects[0];
  if(!project)throw new Error('No allowed project available on this bridge');
  const model=provider==='codex'?list.find((m:any)=>m.isDefault)??list[0]:list.find((m:any)=>m.id==='sonnet')??list[0];
  const next=provider==='codex'?list.find((m:any)=>m.id==='gpt-6-luna')??model:list.find((m:any)=>m.id==='haiku')??model;
  const effort=model.efforts?.includes('low')?'low':undefined,nextEffort=next.efforts?.includes('low')?'low':'default';
  const started=await action({type:'start',hostId:host.id,provider,projectId:project.id,model:model.id,effort,text:'这是远程部署连通性测试。不要调用工具，不要读写文件，只回复 REMOTE_RELAY_OK。'});
  const id=started.sessionId;
  const queued=await action({type:'set-model',sessionId:id,model:next.id,effort:nextEffort});
  async function wait(){for(let i=0;i<120;i++){const s=(await api('state')).sessions.find((s:any)=>s.id===id);if(s&&['idle','failed','interrupted'].includes(s.status))return s;await pause(1000);}throw new Error('Agent turn did not finish');}
  const first=await wait();if(first.status!=='idle')throw new Error(provider+' failed');
  await action({type:'send',sessionId:id,text:'继续同一会话。不要调用工具，只回复 REMOTE_MODEL_SWITCH_OK。'});
  const completed=await wait();const history=await api('history?sessionId='+encodeURIComponent(id));
  const texts=[...history.messages.map((m:any)=>m.text),...history.events.filter((e:any)=>e.type==='message').map((e:any)=>e.data.text)].join('\n');
  const ok=completed.status==='idle'&&texts.includes('REMOTE_RELAY_OK')&&texts.includes('REMOTE_MODEL_SWITCH_OK');
  const evidence={provider,sessionId:id,projectId:completed.projectId,initialModel:model.id,nextModel:next.id,effectiveModel:completed.model,effort:completed.effort,queued:queued.queued===true,ok};results.push(evidence);console.log(JSON.stringify(evidence));
  if(!ok)process.exitCode=1;
}
mkdirSync('.data',{recursive:true});writeFileSync('.data/deployment-verification.json',JSON.stringify({base,device:host.hostname,results,at:new Date().toISOString()},null,2));
