import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,lstat,realpath,unlink,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,relative,isAbsolute,join,dirname} from 'node:path';
import {archiveHash,archivePath,validateArchive,validRepositoryPath,type RequirementArchive,type RequirementIndex,type RepositoryRequest} from '../shared/studio-repository.js';
import type {Project} from '../shared/protocol.js';
import type {BridgeStore} from './store.js';
import type {StudioWorkspace} from './studio-workspace.js';

const queues=new Map<string,Promise<any>>();
async function exclusive<T>(root:string,work:()=>Promise<T>):Promise<T>{const prior=queues.get(root)??Promise.resolve(),job=prior.catch(()=>{}).then(work);queues.set(root,job);try{return await job;}finally{if(queues.get(root)===job)queues.delete(root);}}
export async function repositoryGit(cwd:string,args:string[],input?:string,env:Record<string,string>={}):Promise<string>{
  return new Promise((yes,no)=>{const child=spawn('git',['-c','core.fsmonitor=false',...args],{cwd,windowsHide:true,shell:false,env:{...process.env,GIT_TERMINAL_PROMPT:'0',...env},stdio:'pipe'}),out:Buffer[]=[];let err='',size=0,ended=false;
    const done=(e?:Error)=>{if(ended)return;ended=true;clearTimeout(timer);e?no(e):yes(Buffer.concat(out).toString('utf8'));},timer=setTimeout(()=>{child.kill();done(Error('仓库操作超时；已保留原文件，请重新检查同步状态'));},90_000);
    child.on('error',done);child.stdout.on('data',b=>{size+=b.length;if(size>32*1024*1024){child.kill();done(Error('仓库读取超过 32 MB 限制'));}else out.push(b);});child.stderr.on('data',b=>err=(err+b).slice(-3000));child.on('close',code=>done(code===0?undefined:Error(err.trim()||'Git 操作失败')));child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
const inside=(root:string,path:string)=>{const p=relative(root,path);return p===''||!p.startsWith('..')&&!isAbsolute(p);};
async function jsonFile(root:string,path:string,value:unknown){
  if(!validRepositoryPath(path))throw Error('无效存档路径');const target=resolve(root,path);let parent=root;
  for(const part of path.split('/').slice(0,-1)){parent=join(parent,part);await mkdir(parent,{recursive:true});if(!inside(await realpath(root),await realpath(parent)))throw Error('存档目录链接超出仓库');}
  if(existsSync(target)&&(await lstat(target)).isSymbolicLink())throw Error('存档不能写入符号链接');
  const tmp=target+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await rename(tmp,target);
}
async function localJson(root:string,path:string){try{if(!inside(await realpath(root),await realpath(join(root,path))))throw Error('存档链接超出仓库');return JSON.parse(await readFile(join(root,path),'utf8'));}catch(e){if((e as any).code==='ENOENT')return undefined;throw e;}}
async function gitJson(root:string,ref:string,path:string){let raw;try{raw=await repositoryGit(root,['show',`${ref}:${path}`]);}catch{return undefined;}return JSON.parse(raw);}
async function refHash(root:string,ref:string){try{return (await repositoryGit(root,['rev-parse','--verify',ref+'^{commit}'])).trim();}catch{return '';}}
async function rootFor(p:Project){return (await repositoryGit(p.path,['rev-parse','--show-toplevel'])).trim();}
async function common(root:string){return resolve(root,(await repositoryGit(root,['rev-parse','--git-common-dir'])).trim());}
async function defaultBranch(root:string){try{const b=(await repositoryGit(root,['symbolic-ref','refs/remotes/origin/HEAD'])).trim();if(/^refs\/remotes\/origin\/.+/.test(b))return b.slice('refs/remotes/origin/'.length);}catch{}for(const b of ['main','master'])if(await refHash(root,'refs/remotes/origin/'+b)||await refHash(root,'refs/heads/'+b))return b;throw Error('找不到主干，请先设置 origin 的默认分支');}
async function fetchRepository(root:string){for(let attempt=0;attempt<5;attempt++)try{await repositoryGit(root,['fetch','--no-tags','origin','+refs/heads/*:refs/remotes/origin/*']);return;}catch(e){if(attempt===4||!/timed? out|connection|could not resolve|unable to access|network|远程主机/i.test((e as Error).message))throw e;await new Promise(r=>setTimeout(r,60000));}}
function excluded(path:string){return /(^|\/)(captures?|screenshots?|recordings?|frames?|cache|node_modules|\.godot|\.git|\.data|\.runtime|dist|build|tmp|temp)(\/|$)/i.test(path)||/\.(mp4|mov|mkv|webm|avi|log|tmp|bak|exe|dll|dylib|so|zip|7z|tar|gz)$/i.test(path)||/(^|\/)(\.env(?:\..*)?|id_rsa|id_ed25519|credentials[^/]*|.*\.(pem|key))$/i.test(path)||path.startsWith('.relay/')||path.startsWith('.studio/')&&!/\.(md|json|txt|csv|ya?ml)$/i.test(path);}
export function repositoryFilePolicy(path:string){return validRepositoryPath(path)&&!excluded(path);}

export class StudioRepository {
  constructor(private store:BridgeStore,private dataDir:string){}
  private workspace(id:string){this.store.db.exec('CREATE TABLE IF NOT EXISTS studio_workspaces(id TEXT PRIMARY KEY,json TEXT NOT NULL)');const row=this.store.db.prepare('SELECT json FROM studio_workspaces WHERE id=?').get(id);if(!row)throw Error('本机没有此需求的独立工作副本');return JSON.parse(String(row.json)) as StudioWorkspace;}
  async handle(project:Project,v:RepositoryRequest){const root=await rootFor(project),key=await common(root);return exclusive(key,async()=>{
    if(v.op==='scan')return this.scan(root);
    if(v.op==='restore')return this.restore(root,project,v);
    this.store.db.exec('CREATE TABLE IF NOT EXISTS studio_workspaces(id TEXT PRIMARY KEY,json TEXT NOT NULL)');
    if(v.op==='inspect'&&!this.store.db.prepare('SELECT id FROM studio_workspaces WHERE id=?').get(v.runId!)){await fetchRepository(root);const head=await refHash(root,'refs/remotes/origin/codex/studio-'+v.runId),remote=head?await gitJson(root,head,archivePath(v.runId!)):undefined;validateArchive(remote);return {token:archiveHash({head,hash:archiveHash(remote)}),remote,remoteHead:head,branch:remote.branch,files:[],omitted:[],state:'remote-only'};}
    const w=this.workspace(v.runId!),repo=await rootFor(w.project);if(await common(repo)!==key)throw Error('需求不属于当前游戏仓库');
    if(v.op==='save')return this.save(root,repo,w,v.archive!);
    const view=await this.inspect(root,repo,w,true);
    if(v.op==='inspect')return view;
    if(view.token!==v.token)throw Error('本地或远程版本已变化，请重新检查差异');
    return this.publish(root,repo,w,v,view);
  });}
  private async save(root:string,repo:string,w:StudioWorkspace,a:RequirementArchive){
    const stateRoot=await common(root),old=await localJson(root,'.relay/project.json')??await localJson(stateRoot,'relay/project.json');if(old&&old.id!==a.projectId)throw Error('仓库已绑定其他项目，请使用该仓库已有的项目身份');
    a=structuredClone(a);a.projectRelative=relative(repo,w.project.path).replaceAll('\\','/');
    const portable=(path:string)=>{const normalized=path.replaceAll('\\','/'),base=w.project.path.replaceAll('\\','/').replace(/\/$/,'');return normalized.startsWith(base+'/')?normalized.slice(base.length+1):path;};
    for(const t of [a.run.planner,...a.run.tasks,...a.run.delivery?[a.run.delivery]:[]]){for(const artifact of t.artifacts??[])artifact.path=portable(artifact.path);for(const snapshot of t.visualSnapshots??[])snapshot.path=portable(snapshot.path);}
    validateArchive(a);
    // Mainline files are committed through a temporary tree, never written as
    // untracked files into a protected checkout where they could block git pull.
    await jsonFile(stateRoot,'relay/project.json',{version:1,id:a.projectId,name:a.project.name});
    await jsonFile(repo,'.relay/project.json',{version:1,id:a.projectId,name:a.project.name});
    const previous=await localJson(repo,archivePath(a.runId)) as RequirementArchive|undefined;
    if(previous){validateArchive(previous);const bySession=new Map(previous.conversations.map(c=>[c.sessionId,c]));for(const c of a.conversations){const old=bySession.get(c.sessionId),messages=new Map([...(old?.messages??[]),...c.messages].map(m=>[m.id,m]));bySession.set(c.sessionId,{...c,messages:[...messages.values()]});}a.conversations=[...bySession.values()];validateArchive(a);}
    await jsonFile(repo,archivePath(a.runId),a);
    const index=await localJson(stateRoot,'relay/requirements.json') as RequirementIndex|undefined;
    await jsonFile(stateRoot,'relay/requirements.json',this.index(a,index));return {saved:true,hash:archiveHash(a)};
  }
  private index(a:RequirementArchive,old?:RequirementIndex):RequirementIndex{if(old&&(old.version!==1||old.projectId!==a.projectId||!Array.isArray(old.requirements)))throw Error('项目需求索引身份不匹配');return {version:1,projectId:a.projectId,requirements:[...(old?.requirements??[]).filter(r=>r.id!==a.runId),{id:a.runId,title:String(a.run.title),branch:a.branch,status:String(a.run.status),revision:Number(a.run.revision),updatedAt:Number(a.run.updatedAt)}].sort((x,y)=>x.id.localeCompare(y.id))};}
  private async inspect(root:string,repo:string,w:StudioWorkspace,fetch:boolean){
    if(fetch)await fetchRepository(root);const archive=await localJson(repo,archivePath(w.runId));validateArchive(archive);
    const remoteHead=await refHash(root,'refs/remotes/origin/'+archive.branch),main=await defaultBranch(root),mainHead=await refHash(root,'refs/remotes/origin/'+main)||await refHash(root,'refs/heads/'+main);
    const remote=remoteHead?await gitJson(root,remoteHead,archivePath(w.runId)):undefined;if(remote)validateArchive(remote);
    const diff=(await repositoryGit(repo,['diff',remoteHead||'HEAD','--name-only','-z','--no-ext-diff','--ignore-submodules=all'])).split('\0').filter(Boolean),untracked=(await repositoryGit(repo,['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
    const documents:string[]=[];const walk=async(folder:string,depth=0)=>{if(depth>12||documents.length>10000)throw Error('需求文本资料过多，请先整理后同步');if(!existsSync(folder))return;for(const entry of await readdir(folder,{withFileTypes:true})){const file=join(folder,entry.name);if(entry.isSymbolicLink())throw Error('需求资料不能包含符号链接');if(entry.isDirectory())await walk(file,depth+1);else if(/\.(md|json|txt|csv|ya?ml)$/i.test(entry.name))documents.push(relative(repo,file).replaceAll('\\','/'));}};
    await walk(join(w.project.path,'.studio',w.runId));
    const formal=[archive.run.planner,...archive.run.tasks,...archive.run.delivery?[archive.run.delivery]:[]].flatMap(t=>(t.artifacts??[]).map((a:any)=>relative(repo,resolve(w.project.path,a.path)).replaceAll('\\','/'))).filter(p=>repositoryFilePolicy(p)&&existsSync(join(repo,p)));
    const candidates=[...new Set([...diff,...untracked,...documents,...formal])].sort(),files:{path:string;bytes:number;deleted:boolean;hash:string}[]=[],omitted:string[]=[],blobs=new Map<string,string>();
    if(remoteHead)for(const entry of (await repositoryGit(repo,['ls-tree','-r','-z',remoteHead])).split('\0')){const tab=entry.indexOf('\t');if(tab>=0)blobs.set(entry.slice(tab+1),entry.slice(0,tab).split(' ')[2]);}
    for(const path of candidates){if(!repositoryFilePolicy(path)){omitted.push(path);continue;}const file=resolve(repo,path);if(!existsSync(file)){files.push({path,bytes:0,deleted:true,hash:'deleted'});continue;}
      const st=await lstat(file);if(!st.isFile()||!inside(await realpath(repo),await realpath(file)))throw Error('提交文件包含符号链接或子模块，请先单独同步：'+path);
      if(st.size>25*1024*1024){omitted.push(path+'（超过 25 MB，请配置 LFS 后单独同步）');continue;}
      const bytes=await readFile(file),blob=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');if(blobs.get(path)===blob)continue;
      files.push({path,bytes:st.size,deleted:false,hash:createHash('sha256').update(bytes).digest('hex')});
    }
    const head=await refHash(repo,'HEAD'),localHash=archiveHash(archive),remoteHash=remote?archiveHash(remote):null;
    const token=archiveHash({head,remoteHead,mainHead,localHash,files});
    return {token,head,remoteHead,main,mainHead,localHash,remoteHash,branch:archive.branch,archive,remote,files,omitted,state:!remote?'local-only':localHash===remoteHash?'synced':Number(remote.run.updatedAt)>Number(archive.run.updatedAt)?'remote-newer':'different'};
  }
  private async commit(root:string,base:string,files:string[],virtual:Record<string,unknown>,parents:string[],message:string){
    const index=join(this.dataDir,'repository-index-'+randomUUID()),env={GIT_INDEX_FILE:index};try{
      await repositoryGit(root,['read-tree',base],undefined,env);
      if(files.length)await repositoryGit(root,['--literal-pathspecs','add','-f','-A','--pathspec-from-file=-','--pathspec-file-nul'],files.join('\0')+'\0',env);
      for(const [path,value] of Object.entries(virtual)){const hash=(await repositoryGit(root,['hash-object','-w','--stdin'],JSON.stringify(value,null,2)+'\n')).trim();await repositoryGit(root,['update-index','--add','--cacheinfo',`100644,${hash},${path}`],undefined,env);}
      const tree=(await repositoryGit(root,['write-tree'],undefined,env)).trim();return (await repositoryGit(root,['-c','user.name=Agent Relay','-c','user.email=relay@localhost','commit-tree',tree,...[...new Set(parents)].filter(Boolean).flatMap(p=>['-p',p]),'-m',message])).trim();
    }finally{await unlink(index).catch(()=>{});}
  }
  private async publish(root:string,repo:string,w:StudioWorkspace,v:RepositoryRequest,view:Awaited<ReturnType<StudioRepository['inspect']>>){
    const paths=v.paths??view.files.map(f=>f.path);if(paths.some(p=>!view.files.some(f=>f.path===p)))throw Error('文件不在本轮可提交清单中，请重新检查');
    // Snapshot commits are separate from the working branch and its index. User staging is untouched.
    const demand=await this.commit(repo,view.remoteHead||view.head,paths,{'.relay/project.json':{version:1,id:view.archive.projectId,name:view.archive.project.name},[archivePath(w.runId)]:view.archive},[view.remoteHead,view.head],`Studio: ${view.archive.run.title}`);
    const previous=await gitJson(root,view.mainHead,'.relay/requirements.json'),index=this.index(view.archive,previous);Object.assign(index.requirements.find(r=>r.id===w.runId)!,{commit:demand,sha256:archiveHash(view.archive)});const main=await this.commit(root,view.mainHead,[],{'.relay/project.json':{version:1,id:view.archive.projectId,name:view.archive.project.name},'.relay/requirements.json':index},[view.mainHead],'Studio: sync requirement index');
    const receipt=randomUUID(),journal=join(this.dataDir,'repository-sync',receipt+'.json');await mkdir(dirname(journal),{recursive:true});await writeFile(journal,JSON.stringify({runId:w.runId,demand,main,branch:view.branch,mainBranch:view.main,at:Date.now()}),{mode:0o600});
    await repositoryGit(root,['update-ref','refs/relay-sync/'+receipt+'/demand',demand]);await repositoryGit(root,['update-ref','refs/relay-sync/'+receipt+'/index',main]);
    // Re-check working files before publishing the prepared tree.
    const check=await this.inspect(root,repo,w,false);if(check.token!==view.token)throw Error('制作文件正在变化，请暂停制作后重新同步');
    try{await repositoryGit(root,['push','--atomic','origin',`${demand}:refs/heads/${view.branch}`,`${main}:refs/heads/${view.main}`]);}
    catch(e){const refs=await repositoryGit(root,['ls-remote','--heads','origin',view.branch,view.main]).catch(()=> '');if(!refs.includes(demand+'\trefs/heads/'+view.branch)||!refs.includes(main+'\trefs/heads/'+view.main))throw Error('同步未确认，原文件和快照已保留。请重新检查远程版本；不会自动重复推送：'+(e as Error).message);}
    await repositoryGit(root,['update-ref','refs/remotes/origin/'+view.branch,demand]);await repositoryGit(root,['update-ref','refs/remotes/origin/'+view.main,main]);
    await jsonFile(await common(root),'relay/requirements.json',index);return {synced:true,commit:demand,indexCommit:main,branch:view.branch,main:view.main,omitted:view.omitted,localBranchUnchanged:true};
  }
  private async scan(root:string){
    let identity=await localJson(root,'.relay/project.json')??await localJson(await common(root),'relay/project.json')??await gitJson(root,'HEAD','.relay/project.json');if(!identity){const main=await defaultBranch(root).catch(()=>null);if(main)identity=await gitJson(root,'refs/remotes/origin/'+main,'.relay/project.json');}if(!identity)return {requirements:[]};
    const refs=(await repositoryGit(root,['for-each-ref','--format=%(refname)','refs/remotes/origin/codex','refs/heads/codex'])).trim().split('\n').filter(Boolean),catalog=new Map<string,any>();
    for(const ref of refs){const id=ref.match(/\/codex\/studio-([a-f0-9-]{36})$/)?.[1];if(!id)continue;const a=await gitJson(root,ref,archivePath(id));if(!a)continue;validateArchive(a);if(a.projectId!==identity.id)continue;const entry={id,title:a.run.title,status:a.run.status,revision:a.run.revision,updatedAt:a.run.updatedAt,branch:a.branch,ref,hash:archiveHash(a),done:a.run.tasks.filter((t:any)=>t.status==='done').length,total:a.run.tasks.length};const old=catalog.get(id);if(!old||ref.startsWith('refs/remotes/')||entry.updatedAt>old.updatedAt&&!old.ref.startsWith('refs/remotes/'))catalog.set(id,entry);}
    return {projectId:identity.id,requirements:[...catalog.values()]};
  }
  private async restore(root:string,project:Project,v:RepositoryRequest){
    await fetchRepository(root);const ref='refs/remotes/origin/codex/studio-'+v.runId,head=await refHash(root,ref);if(!head)throw Error('远程尚未同步该需求');
    const archive=await gitJson(root,head,archivePath(v.runId!));validateArchive(archive);
    const identity=await localJson(root,'.relay/project.json');if(identity&&identity.id!==archive.projectId)throw Error('仓库项目身份不匹配');
    const oldRow=this.store.db.prepare('SELECT json FROM studio_workspaces WHERE id=?').get(v.runId!),old=oldRow?JSON.parse(String(oldRow.json)) as StudioWorkspace:undefined;
    let expected=archiveHash({head,hash:archiveHash(archive)});
    if(old){const repo=await rootFor(old.project);if(await common(root)!==await common(repo))throw Error('本机已有同 ID 的另一仓库需求');const view=await this.inspect(root,repo,old,false);expected=view.token;}
    if(expected!==v.token)throw Error('版本已变化，请重新检查差异');
    const suffix=head.slice(0,12)+'-'+randomUUID().slice(0,8),target=resolve(this.dataDir,'studio-workspaces',v.runId+'-git-'+suffix),branch='codex/studio-'+v.runId+'-git-'+suffix;
    await mkdir(dirname(target),{recursive:true});await repositoryGit(root,['worktree','add','-b',branch,target,head]);
    const cwd=resolve(target,archive.projectRelative);if(!existsSync(cwd)||!inside(await realpath(target),await realpath(cwd)))throw Error('远程存档游戏目录不存在');
    const p:Project={id:'studio-'+v.runId,name:project.name+' · '+v.runId!.slice(0,8),path:cwd,roots:[cwd],source:'configured'},workspace:StudioWorkspace={runId:v.runId!,project:p,branch,sourcePath:project.path,sourceBranch:await defaultBranch(root),head,trackedSnapshot:false,untrackedFiles:0,createdAt:Date.now()};
    this.store.saveProject(p);this.store.db.prepare('INSERT OR REPLACE INTO studio_workspaces VALUES(?,?)').run(v.runId!,JSON.stringify(workspace));
    return {archive,workspace,backupPath:old?.project.path};
  }
}
