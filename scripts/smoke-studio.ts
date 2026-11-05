// Explicit live smoke: four short Claude/Codex turns in a new isolated workspace.
// Uses existing CLI logins; no production team, engine, or game files are changed.
import {createRelay} from '../src/relay/server.js';
import {STUDIO_ROLES} from '../src/relay/studio.js';
import {startBridge} from '../src/bridge/connector.js';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';

const root=resolve('.data/studio-live-'+Date.now()),workspace=join(root,'workspace');mkdirSync(workspace,{recursive:true});
execFileSync('git',['init','-b','main'],{cwd:workspace,windowsHide:true});writeFileSync(join(workspace,'README.md'),'Isolated orchestration test fixture.\n');execFileSync('git',['add','README.md'],{cwd:workspace,windowsHide:true});execFileSync('git',['-c','user.name=Studio QA','-c','user.email=studio-qa@localhost','commit','-m','Test fixture baseline'],{cwd:workspace,windowsHide:true});
const phone=randomBytes(32).toString('hex'),token=randomBytes(32).toString('hex');
const relay=createRelay({dataDir:join(root,'relay'),phoneToken:phone,bridgeToken:token});relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
const base='http://127.0.0.1:'+(relay.server.address() as any).port;
const bridge=startBridge({relayUrl:base.replace('http','ws')+'/bridge',hostId:'studio-live',name:'工作室真实联调（隔离）',dataDir:join(root,'bridge'),projects:[{id:'smoke',name:'隔离联调',path:workspace}],discoverCodexProjects:false,syncHistory:false},token);
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
let runId='',last='';
try{
  for(let i=0;i<100&&!relay.store.hosts().length;i++)await pause(100);
  const p=relay.studio.saveProject({name:'真实 Claude / Codex 联调',hostId:'studio-live',projectId:'smoke',workspaceIndex:0,permissionMode:'request',concurrency:1,reviewPlan:false,roles:STUDIO_ROLES.map(([role])=>({role,enabled:['director','engineering','qa'].includes(role),provider:role==='director'?'claude':'codex',instructions:'这是编排协议联调，禁止调用工具、禁止读取或写入文件。不要做游戏或外部验证。只验证输入文本、上游交付以及结构化输出。保持回复简短。',tools:''}))});
  const run=relay.studio.createRun({workflow:'general',projectId:p.id,title:'编排协议真实联调',brief:'这是隔离的通信协议联调，不制作游戏。只需一个 engineering 任务，不要添加其他制作任务。此任务不调用工具，仅按 STUDIO_RESULT 格式返回 outcome done、summary 含 STUDIO_LIVE_WORK_OK、artifacts 空数组、checks 记录已核对输入协议。最终 QA 只核对上游摘要是否包含 STUDIO_LIVE_WORK_OK，记录本次核对；不得声称进行了游戏测试。统筹最终汇总须注明这只是通信协议联调。所有人不要调用任何工具、不要读取或写入任何文件。'});runId=run.id;
  for(let i=0;i<480;i++){
    await relay.studio.tick();const r=relay.studio.runs().find(r=>r.id===runId)!;const tasks=[r.planner,...r.tasks,...r.delivery?[r.delivery]:[]];
    const status=r.status+' | '+tasks.map(t=>t.role+':'+t.status).join(', ');if(status!==last){console.log(status);last=status;}
    if(tasks.some(t=>t.status==='blocked'))throw Error(tasks.find(t=>t.status==='blocked')!.error);
    if(r.status==='review'){
      if(!r.tasks.some(t=>t.summary?.includes('STUDIO_LIVE_WORK_OK')))throw Error('Real task marker missing');
      const sessions=tasks.map(t=>relay.store.getSession(t.sessionId!)!);if(!sessions.some(s=>s.provider==='claude')||!sessions.some(s=>s.provider==='codex'))throw Error('Mixed agent routing missing');
      await relay.studio.command({runId,op:'accept'});
      const proof={ok:true,scope:'Real Claude/Codex orchestration protocol only; no engine/game acceptance',root,run:relay.studio.runs().find(r=>r.id===runId),sessions:sessions.map(s=>({id:s.id,provider:s.provider,status:s.status}))};
      writeFileSync(join(root,'proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify({ok:true,root,turns:sessions.length,providers:[...new Set(sessions.map(s=>s.provider))]}));break;
    }
    if(i===479)throw Error('Live studio workflow timed out');await pause(500);
  }
}catch(e){
  const r=relay.studio.runs().find(r=>r.id===runId);writeFileSync(join(root,'failure.json'),JSON.stringify({error:(e as Error).message,run:r,events:r?[r.planner,...r.tasks,...r.delivery?[r.delivery]:[]].map(t=>({taskId:t.id,events:t.sessionId?relay.store.sessionEvents(t.sessionId):[]})):[]},null,2));
  if(r&&!['accepted','cancelled'].includes(r.status))await relay.studio.command({runId,op:'cancel'});throw e;
}finally{await bridge.close();await relay.close();}
