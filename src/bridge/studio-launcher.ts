import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {readFileSync,existsSync,lstatSync,realpathSync,mkdirSync,openSync,closeSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,dirname,extname} from 'node:path';
import type {Action} from '../shared/protocol.js';
import {launchTargets,type LaunchTarget} from '../shared/playtests.js';

const inside=(root:string,path:string)=>{const p=relative(root,path);return p===''||!p.startsWith('..')&&!isAbsolute(p);};
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
interface Job {id:string;request:string;key:string;root:string;target:LaunchTarget;hash:string;status:'starting'|'started'|'ready'|'exited'|'failed'|'unknown';pid?:number;gamePid?:number;at:number;logPath:string;receiptPath:string;error?:string;exitCode?:number|null;scene?:string}
export class StudioLauncher {
 private db:DatabaseSync;private closed=false;private children=new Map<string,ChildProcess>();
 constructor(private dataDir:string,private hostId:string,private options:{platform?:string;spawn?:typeof spawn;verifyBranch?:(root:string,branch:string)=>void}={}){
  mkdirSync(dataDir,{recursive:true});this.db=new DatabaseSync(join(dataDir,'launcher.sqlite'));this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS launches(id TEXT PRIMARY KEY,json TEXT NOT NULL);');
 }
 private save(j:Job){this.db.prepare('INSERT OR REPLACE INTO launches VALUES(?,?)').run(j.id,JSON.stringify(j));}
 private job(id:string){const r=this.db.prepare('SELECT json FROM launches WHERE id=?').get(id);return r?JSON.parse(String(r.json)) as Job:undefined;}
 private scope(action:Action){
  const db=new DatabaseSync(join(this.dataDir,'bridge.sqlite'),{readOnly:true});
  try{
   const row=db.prepare('SELECT json FROM studio_workspaces WHERE id=?').get(action.workspaceId!);if(!row)throw Error('工作电脑未登记本需求工作副本');
   const w=JSON.parse(String(row.json)),s=db.prepare('SELECT json FROM sessions WHERE id=?').get(action.sessionId!);
   if(w.runId!==action.workspaceId||!s||JSON.parse(String(s.json)).projectId!==w.project.id||!action.sessionId?.startsWith(this.hostId+':'))throw Error('启动会话与需求工作副本不匹配');
   const root=realpathSync.native(w.project.path);if(root===realpathSync.native(w.sourcePath))throw Error('不能从源工程启动需求预览');
   if(this.options.verifyBranch)this.options.verifyBranch(root,w.branch);else if(execFileSync('git',['-C',root,'branch','--show-current'],{encoding:'utf8',windowsHide:true,timeout:5000}).trim()!==w.branch)throw Error('工作副本分支已变化，请核对交付入口');
   return root;
  }finally{db.close();}
 }
 private paths(root:string,target:LaunchTarget){
  const script=resolve(root,target.script),cwd=resolve(root,target.cwd);if(!inside(root,script)||!inside(root,cwd)||!lstatSync(script).isFile()||!inside(root,realpathSync.native(script))||!inside(root,realpathSync.native(cwd))||!lstatSync(cwd).isDirectory())throw Error('启动脚本或工作目录越出本需求副本');
  if(lstatSync(script).size>1024*1024)throw Error('启动脚本过大，请使用独立启动脚本');
  return {script,cwd,hash:createHash('sha256').update(readFileSync(script)).digest('hex')};
 }
 private state(j:Job):Job{
  if(['failed','exited'].includes(j.status))return j;
  if(existsSync(j.receiptPath))try{
   const receipt=JSON.parse(readFileSync(j.receiptPath,'utf8').replace(/^\uFEFF/,''));
   if(!Number.isSafeInteger(receipt.pid)||receipt.pid<1||realpathSync.native(receipt.workspace)!==j.root||receipt.scene!==j.target.scene)throw Error('启动脚本返回的工作副本或实际场景不匹配');
   j.gamePid=receipt.pid;j.scene=receipt.scene;j.error=undefined;
   if(receipt.ready===true&&alive(receipt.pid))j.status='ready';
  }catch(e){j.error=(e as Error).message;}
  if(j.gamePid?!alive(j.gamePid):j.pid&&!alive(j.pid)){j.status='exited';}
  else if(!this.children.has(j.id)&&j.status!=='ready'&&j.pid&&alive(j.pid)){j.status='unknown';j.error='上次启动进程仍存在，未重复启动；游戏就绪需核对启动回执';}
  this.save(j);return j;
 }
 private result(j:Job,reused=false){return {ok:!['failed','unknown'].includes(j.status),id:j.id,status:j.status,pid:j.gamePid??j.pid,scriptPid:j.pid,scene:j.scene,expectedScene:j.target.scene,worktree:j.root,script:j.target.script,logPath:j.logPath,error:j.error,exitCode:j.exitCode,reused};}
 async handle(action:Action){
  const l=action.launch!;const target=launchTargets([l.target])[0],root=this.scope(action),paths=this.paths(root,target);
  if(l.op==='inspect')return {ok:true,hash:paths.hash,worktree:root,script:target.script};
  if(l.op==='status'){const j=this.job(l.requestId!);if(!j)return {ok:false,status:'not-found'};if(j.root!==root||JSON.stringify(j.target)!==JSON.stringify(target))throw Error('启动回执不属于该入口');return this.result(this.state(j));}
  const old=this.job(action.id);if(old){if(old.request!==JSON.stringify(action))throw Error('启动 ID 已用于不同请求');return this.result(this.state(old),true);}
  if(paths.hash!==l.hash)throw Error('启动脚本已变化，请刷新并重新核对入口');
  const platform=this.options.platform??process.platform,extension=extname(paths.script).toLowerCase();
  if(platform==='win32'?!['.ps1','.bat','.cmd'].includes(extension):extension!=='.sh')throw Error('该启动脚本不适用于当前工作电脑系统');
  const key=root+'|'+target.kind+'|'+paths.script;
  for(const row of this.db.prepare('SELECT json FROM launches ORDER BY rowid DESC').all()){
   const j=JSON.parse(String(row.json)) as Job;if(j.key!==key)continue;
   const current=this.state(j);if(!['exited','failed'].includes(current.status)){if(j.hash!==paths.hash||JSON.stringify(j.target)!==JSON.stringify(target)){current.status='unknown';current.error='入口版本已变化，旧启动进程仍存在；请先核对旧游戏，未重复启动';}return this.result(current,true);}break;
  }
  const directory=join(root,'.studio',action.workspaceId!,'launches',action.id);let parent=directory;while(!existsSync(parent))parent=dirname(parent);if(!inside(root,realpathSync.native(parent)))throw Error('启动日志目录越出工作副本');mkdirSync(directory,{recursive:true});if(!inside(root,realpathSync.native(directory)))throw Error('启动目录无效');
  const j:Job={id:action.id,request:JSON.stringify(action),key,root,target,hash:paths.hash,status:'starting',at:Date.now(),logPath:join(directory,'launcher.log'),receiptPath:join(directory,'game.json')};this.save(j);
  const fd=openSync(j.logPath,'a');
  try{
   let command:string,args:string[];
   const modernShell=join(process.env.ProgramFiles??'C:/Program Files','PowerShell/7/pwsh.exe'),windowsShell=existsSync(modernShell)?modernShell:join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
   if(platform!=='win32'){command='/bin/sh';args=[paths.script];}
   else if(extension==='.ps1'){command=windowsShell;args=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',paths.script];}
   else{
    // The encoded command contains only a literal, already-registered path.
    // PowerShell handles cmd/bat paths without interpolating browser shell text.
    command=windowsShell;const literal="'"+paths.script.replaceAll("'","''")+"'";
    args=['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from('& '+literal+'; exit $LASTEXITCODE','utf16le').toString('base64')];
   }
   const environment={...process.env};for(const key of ['BRIDGE_TOKEN','PHONE_TOKEN','RELAY_BRIDGE_TOKEN','RELAY_PHONE_TOKEN','OPENAI_API_KEY','ANTHROPIC_API_KEY','CODEX_API_KEY'])delete environment[key];
   const child=(this.options.spawn??spawn)(command,args,{cwd:paths.cwd,detached:platform!=='win32',windowsHide:true,shell:false,env:{...environment,AGENT_RELAY_LAUNCH_RECEIPT:j.receiptPath,AGENT_RELAY_WORKSPACE:root},stdio:['ignore',fd,fd]});this.children.set(j.id,child);
   await new Promise<void>((resolveSpawn,reject)=>{child.once('spawn',()=>resolveSpawn());child.once('error',reject);});
   j.pid=child.pid;j.status='started';this.save(j);child.unref();
   child.once('exit',code=>{if(this.closed)return;const latest=this.job(j.id)!;latest.status=code===0?'exited':'failed';latest.exitCode=code;if(code!==0)latest.error='启动脚本退出异常，请查看本机日志';this.save(latest);this.children.delete(j.id);});
   return this.result(j);
  }catch(e){j.status='failed';j.error=(e as Error).message;this.save(j);this.children.delete(j.id);return this.result(j);}finally{closeSync(fd);}
 }
 close(){this.closed=true;this.db.close();}
}
