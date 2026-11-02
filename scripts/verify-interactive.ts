import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const base=process.argv[2]??process.env.PUBLIC_ORIGIN;
if(!base)throw new Error('Pass the relay URL as the first argument or set PUBLIC_ORIGIN. This test creates a real Claude session.');
let cookie='';
async function api(path:string,body?:unknown){const r=await fetch(base+'/api/'+path,{method:body?'POST':'GET',signal:AbortSignal.timeout(45000),headers:{...(body?{'Content-Type':'application/json',Origin:base}:{}),...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined});const result=await r.json() as any;if(!r.ok)throw new Error(result.error??String(r.status));const c=r.headers.get('set-cookie');if(c)cookie=c.split(';')[0];return result;}
const action=(a:any)=>api('actions',{id:randomUUID(),...a});
const pause=()=>new Promise(r=>setTimeout(r,1000));
await api('login',{token:process.env.PHONE_TOKEN});const state=await api('state'),host=state.hosts.find((h:any)=>h.online);assert.ok(host);
const project=host.projects.find((p:any)=>p.source==='configured');
const started=await action({type:'start',hostId:host.id,provider:'claude',projectId:project.id,model:'haiku',effort:'low',text:'这是网页交互验证。上下文标记 RELAY_CONTEXT_42。先回复 MAIN_BEGIN，再用 Bash 执行 node -e "setTimeout(()=>console.log(\'MAIN_DONE\'),8000)"。除此之外不要读写文件或调用其他工具，执行完成后回复 MAIN_DONE。'});
const id=started.sessionId;console.log(JSON.stringify({started:id}));
async function snapshot(){return api('history?sessionId='+encodeURIComponent(id));}
let first:any;for(let i=0;i<90;i++){first=await snapshot();if(first.events.some((e:any)=>e.type==='message'&&e.data.role==='assistant'&&e.data.text.includes('MAIN_BEGIN')))break;await pause();}
assert.ok(first.events.some((e:any)=>e.type==='message'&&e.data.role==='assistant'&&e.data.text.includes('MAIN_BEGIN')));
const queued=await action({type:'send',sessionId:id,text:'不要调用任何工具，只回复 QUEUED_INPUT_OK。'});assert.equal(queued.queued,true);
const btw=await action({type:'send',sessionId:id,text:'/btw 用户最初消息中的上下文标记是什么？只返回这个标记。'});assert.equal(btw.sideQuestion,true);
const commands=await api('commands?sessionId='+encodeURIComponent(id));assert.ok(commands.commands.some((c:any)=>c.name==='btw'));assert.ok(commands.commands.some((c:any)=>c.name==='compact'));
const approved=new Set();let done:any;
for(let i=0;i<180;i++){
  done=await snapshot();for(const e of done.events)if(e.type==='approval'&&!approved.has(e.data.approvalId)){approved.add(e.data.approvalId);assert.ok(JSON.stringify(e.data.details).includes('setTimeout'));await action({type:'approve',sessionId:id,approvalId:e.data.approvalId,allow:true});}
  const out=done.events.filter((e:any)=>e.type==='message'&&e.data.role==='assistant').map((e:any)=>e.data);
  if(out.some((m:any)=>m.text.includes('QUEUED_INPUT_OK'))&&out.some((m:any)=>m.label==='CLAUDE · 旁问'&&m.text.includes('RELAY_CONTEXT_42')))break;
  const error=done.events.find((e:any)=>e.type==='error');if(error)throw new Error(error.data.message);await pause();
}
const out=done.events.filter((e:any)=>e.type==='message'&&e.data.role==='assistant').map((e:any)=>e.data);
assert.ok(out.some((m:any)=>m.text.includes('QUEUED_INPUT_OK')));assert.ok(out.some((m:any)=>m.label==='CLAUDE · 旁问'&&m.text.includes('RELAY_CONTEXT_42')));assert.ok(out.some((m:any)=>m.text.includes('MAIN_BEGIN')));
const evidence={at:new Date().toISOString(),sessionId:id,queued:queued.queued,sideQuestion:btw.sideQuestion,commandCount:commands.commands.length,assistantMessages:out.map((m:any)=>({id:m.id,label:m.label,text:m.text})),ok:true};
writeFileSync('.data/interactive-verification.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
