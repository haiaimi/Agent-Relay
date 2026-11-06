import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFile,mkdir,lstat,realpath} from 'node:fs/promises';
import {mkdirSync,existsSync,realpathSync,statSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import type {Project} from '../shared/protocol.js';
import type {BridgeStore} from './store.js';

export interface StudioWorkspace {migrationId?:string;runId:string;project:Project;branch:string;sourcePath:string;sourceBranch:string;head:string;trackedSnapshot:boolean;untrackedFiles:number;createdAt:number;submodules?:number;skippedCaptures?:number}
function git(cwd:string,args:string[],input?:Buffer):Promise<Buffer>{
  return new Promise((resolveResult,reject)=>{
    const child=spawn('git',['-c','core.quotePath=false','-c','core.fsmonitor=false',...args],{cwd,windowsHide:true,shell:false,stdio:'pipe'});let size=0,errors='',finished=false;const chunks:Buffer[]=[];
    const fail=(error:Error)=>{if(finished)return;finished=true;clearTimeout(timer);reject(error);};
    const timer=setTimeout(()=>{child.kill();fail(Error('Git 工作副本准备超时，已保留现场，请检查后重试'));},240000);
    child.on('error',fail);child.stdout.on('data',b=>{size+=b.length;if(size>128*1024*1024){child.kill();fail(Error('源工程未提交改动过大，无法自动复制，请先整理后重试'));}else chunks.push(b);});child.stderr.on('data',b=>{errors=(errors+b.toString()).slice(-6000);});
    child.on('close',code=>{if(finished)return;finished=true;clearTimeout(timer);code===0?resolveResult(Buffer.concat(chunks)):reject(Error(errors.trim()||'Git 操作失败'));});child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
function within(root:string,path:string){const rel=relative(root,path);return rel===''||!rel.startsWith('..')&&!isAbsolute(rel);}
async function snapshot(repo:string,target:string,branch:string,includeCaptures:boolean,depth=0):Promise<{trackedSnapshot:boolean;untrackedFiles:number;submodules:number;skippedCaptures:number}>{
  if(depth>8)throw Error('子模块嵌套超过 8 层，已停止准备');
  const head=(await git(repo,['rev-parse','HEAD'])).toString().trim();
  const patch=await git(repo,['diff','HEAD','--binary','--no-ext-diff','--no-textconv','--ignore-submodules=all']);
  const allUntracked=(await git(repo,['ls-files','--others','--exclude-standard','-z'])).toString('utf8').split('\0').filter(Boolean),untracked=allUntracked.filter(path=>includeCaptures||!/^captures\//.test(path));
  const modules=(await git(repo,['ls-files','--stage','-z'])).toString('utf8').split('\0').filter(line=>line.startsWith('160000 ')).map(line=>line.slice(line.indexOf('\t')+1));
  for(const file of untracked){const path=resolve(repo,file);if(!within(repo,path)||!within(repo,await realpath(path))||!(await lstat(path)).isFile())throw Error('未跟踪文件包含链接或非普通文件，请先整理后重试：'+file);}
  await git(repo,['worktree','add','-b',branch,target,head]);
  if(patch.length)await git(target,['apply','--binary','--whitespace=nowarn','-'],patch);
  for(const file of untracked){const from=resolve(repo,file),to=resolve(target,file);if(!within(target,to))throw Error('无效未跟踪路径');await mkdir(dirname(to),{recursive:true});if(!within(target,await realpath(dirname(to)))||!within(repo,await realpath(from))||!(await lstat(from)).isFile())throw Error('副本文件夹链接超出工程或源文件已变化');await copyFile(from,to);}
  let trackedSnapshot=patch.length>0,untrackedFiles=untracked.length,submodules=modules.length,skippedCaptures=allUntracked.length-untracked.length;
  for(const file of modules){
    const path=resolve(repo,file),destination=resolve(target,file);if(!within(repo,path)||!within(target,destination))throw Error('无效子模块路径');
    const source=realpathSync.native(path),root=realpathSync.native((await git(source,['rev-parse','--show-toplevel'])).toString().trim());
    if(root!==source)throw Error('子模块尚未初始化，请先在本机准备后重试：'+file);
    if(!within(realpathSync.native(target),realpathSync.native(dirname(destination))))throw Error('子模块目标超出工作副本');
    const child=await snapshot(source,destination,branch+'-sub-'+createHash('sha256').update(file).digest('hex').slice(0,8),includeCaptures,depth+1);trackedSnapshot||=child.trackedSnapshot;untrackedFiles+=child.untrackedFiles;submodules+=child.submodules;skippedCaptures+=child.skippedCaptures;
  }
  return {trackedSnapshot,untrackedFiles,submodules,skippedCaptures};
}
export async function prepareStudioWorkspace(store:BridgeStore,dataDir:string,project:Project,index:number,runId:string,includeCaptures=false):Promise<StudioWorkspace>{
  if(!/^[a-f0-9-]{36}$/i.test(runId))throw Error('无效需求 ID');
  store.db.exec('CREATE TABLE IF NOT EXISTS studio_workspaces(id TEXT PRIMARY KEY,json TEXT NOT NULL)');
  const old=store.db.prepare('SELECT json FROM studio_workspaces WHERE id=?').get(runId);
  if(old){const value=JSON.parse(String(old.json)) as StudioWorkspace;const source=realpathSync.native((project.roots??[project.path])[index]);if(value.sourcePath!==source)throw Error('工作副本与需求源目录不匹配');const branch=(await git(value.project.path,['branch','--show-current'])).toString().trim();if(branch!==value.branch)throw Error('需求工作副本的分支已变化，请先核对');return value;}
  const requested=(project.roots??[project.path])[index];if(!requested)throw Error('工程工作目录不存在');const source=realpathSync.native(requested);
  let repo:string;try{repo=(await git(source,['rev-parse','--show-toplevel'])).toString().trim();await git(source,['rev-parse','--verify','HEAD']);}catch{throw Error('工程需要是已有提交的 Git 仓库。请先初始化并提交基线；系统不会在原目录或主干执行。');}
  repo=realpathSync.native(repo);if(!within(repo,source))throw Error('工程目录不属于 Git 仓库');
  const head=(await git(repo,['rev-parse','HEAD'])).toString().trim(),sourceBranch=(await git(repo,['branch','--show-current'])).toString().trim()||'(detached HEAD)';
  const parent=resolve(dataDir,'studio-workspaces');mkdirSync(parent,{recursive:true});const actualParent=realpathSync.native(parent),worktree=resolve(actualParent,runId);if(!within(actualParent,worktree))throw Error('无效工作副本目录');
  if(existsSync(worktree))throw Error('需求工作副本已存在但准备未完成，已保留文件，请先检查该副本后重试：'+worktree);
  const branch='codex/studio-'+runId;
  const copied=await snapshot(repo,worktree,branch,includeCaptures);
  const cwd=resolve(worktree,relative(repo,source));if(!existsSync(cwd)||!statSync(cwd).isDirectory())throw Error('副本内缺少游戏工程目录');
  const execution:Project={id:'studio-'+runId,name:project.name+' · '+runId.slice(0,8),path:cwd,roots:[cwd],source:'configured'};
  const value:StudioWorkspace={runId,project:execution,branch,sourcePath:source,sourceBranch,head,...copied,createdAt:Date.now()};
  store.saveProject(execution);store.db.prepare('INSERT INTO studio_workspaces VALUES(?,?)').run(runId,JSON.stringify(value));return value;
}
