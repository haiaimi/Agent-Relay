import {spawn} from 'node:child_process';
import {mkdirSync,existsSync,realpathSync,lstatSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {resolve,join,relative,isAbsolute,dirname} from 'node:path';
import {MigrationCache,migrationHash,migrationPath,type MigrationManifest} from '../shared/studio-migration.js';
import type {BridgeStore} from './store.js';
import type {Project} from '../shared/protocol.js';
import type {StudioWorkspace} from './studio-workspace.js';

function inside(root:string,path:string){const r=relative(root,path);return r===''||!r.startsWith('..')&&!isAbsolute(r);}
async function git(cwd:string,args:string[],env:NodeJS.ProcessEnv={},input?:string){
  return new Promise<string>((done,fail)=>{
    const p=spawn('git',['-c','core.fsmonitor=false','-c','core.hooksPath='+join(cwd,'.relay-no-hooks'),'-c','gc.auto=0','-c','filter.lfs.process=','-c','filter.lfs.clean=','-c','filter.lfs.smudge=','-c','filter.lfs.required=false',...args],{cwd,env:{...process.env,...env},windowsHide:true,stdio:'pipe'});let out='',err='';const timer=setTimeout(()=>{p.kill();fail(Error('迁移 Git 操作超时，现场已保留'));},30*60_000);
    p.stdout.on('data',b=>{out+=b;if(out.length>128*1024*1024){p.kill();fail(Error('迁移仓库索引过大'));}});p.stderr.on('data',b=>err=(err+b).slice(-6000));p.on('error',e=>{clearTimeout(timer);fail(e);});p.on('close',code=>{clearTimeout(timer);code===0?done(out):fail(Error(err.trim()||'迁移 Git 操作失败'));});p.stdin.on('error',()=>{});p.stdin.end(input);
  });
}
export function migrationWorkspace(store:BridgeStore,runId:string){
  const row=store.db.prepare('SELECT json FROM studio_workspaces WHERE id=?').get(runId);if(!row)throw Error('原需求工作副本未登记');return JSON.parse(String(row.json)) as StudioWorkspace;
}
export async function probeMigrationProject(project:Project){const path=realpathSync.native(project.path);const root=(await git(path,['rev-parse','--show-toplevel'])).trim();await git(root,['rev-parse','--verify','HEAD']);return {ok:true};}
export async function exportMigration(store:BridgeStore,dataDir:string,runId:string,id:string,artifacts:string[]=[]){
  const cache=new MigrationCache(dataDir,id),old=cache.manifest();if(old){if(old.runId!==runId)throw Error('迁移需求不匹配');await cache.verify();return old;}
  const workspace=migrationWorkspace(store,runId),source=realpathSync.native(workspace.project.path),root=realpathSync.native((await git(source,['rev-parse','--show-toplevel'])).trim());
  if((await git(root,['branch','--show-current'])).trim()!==workspace.branch)throw Error('源工作副本分支已变化，请核对后迁移');
  const extra=artifacts.map(path=>resolve(source,path)).filter(path=>inside(root,path));
  const manifest:MigrationManifest={version:1,id,runId,projectRelative:relative(root,source).replaceAll('\\','/'),repositories:[]};
  async function snapshot(repo:string,path:string,depth=0):Promise<string>{
    if(depth>8||manifest.repositories.length>=100)throw Error('迁移子仓库数量或嵌套过多');
    const index=manifest.repositories.length,base=(await git(repo,['rev-parse','HEAD'])).trim(),ref='refs/relay-migrations/'+id+'/'+index;
    const item={path,base,head:'',ref,size:0,sha256:''};manifest.repositories.push(item);
    const env={GIT_INDEX_FILE:join(cache.root,index+'.index'),GIT_AUTHOR_NAME:'Studio Migration',GIT_AUTHOR_EMAIL:'studio@localhost',GIT_COMMITTER_NAME:'Studio Migration',GIT_COMMITTER_EMAIL:'studio@localhost'};
    await git(repo,['read-tree','HEAD'],env);
    const files=(await git(repo,['ls-files','--cached','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
    for(const file of files){const full=resolve(repo,file);if(!inside(repo,full)||existsSync(full)&&(!inside(repo,realpathSync.native(full))||lstatSync(full).isSymbolicLink()))throw Error('迁移不支持指向工程外的链接：'+file);if(existsSync(full)&&lstatSync(full).isFile()&&statSync(full).size<1024&&/^version https:\/\/git-lfs.github.com\/spec\/v1\r?\n/.test(readFileSync(full,'utf8')))throw Error('LFS 文件尚未下载，请先恢复实际资源：'+file);}
    await git(repo,['add','-A','--','.'],env);
    // Force materialized LFS bytes into the private checkpoint, without changing
    // the user's index, commits, branch or remote.
    await git(repo,['add','--renormalize','-u','--','.'],env);
    // Production notes and their adjacent assets are often deliberately ignored
    // by the game repository. Keep those files, while leaving rebuild caches out.
    const ignored=(await git(repo,['ls-files','--others','--ignored','--exclude-standard','-z'])).split('\0').filter(file=>file.startsWith('.studio/')&&!/(^|\/)(node_modules|\.godot|__pycache__|\.venv|venv|cache)(\/|$)/.test(file));
    for(const file of ignored){const full=resolve(repo,file);if(!inside(repo,realpathSync.native(full))||!lstatSync(full).isFile())throw Error('制作资料含外部链接或非普通文件：'+file);await git(repo,['add','-f','--',file],env);}
    for(const full of extra)if(inside(repo,full)&&existsSync(full)&&lstatSync(full).isFile()){
      if(!inside(repo,realpathSync.native(full)))throw Error('交付物链接超出工程');
      const rel=relative(repo,full).replaceAll('\\','/');
      // Nested-repository files are captured by that repository below.
      const owner=realpathSync.native((await git(dirname(full),['rev-parse','--show-toplevel'])).trim());if(owner===repo)await git(repo,['add','-f','--',rel],env);
    }
    const entries=(await git(repo,['ls-files','--stage','-z'],env)).split('\0').filter(Boolean);
    for(const entry of entries){if(entry.startsWith('120000 '))throw Error('迁移需先将符号链接替换为工程内文件：'+entry.slice(entry.indexOf('\t')+1));if(!entry.startsWith('160000 '))continue;
      const child=entry.slice(entry.indexOf('\t')+1);if(!migrationPath(child))throw Error('无效子仓库路径');const full=resolve(repo,child);if(!existsSync(full)||!inside(repo,realpathSync.native(full)))throw Error('子仓库尚未初始化：'+child);const actual=realpathSync.native(full);if(realpathSync.native((await git(actual,['rev-parse','--show-toplevel'])).trim())!==actual)throw Error('子仓库尚未初始化：'+child);
      const head=await snapshot(actual,path?path+'/'+child:child,depth+1);await git(repo,['update-index','--add','--cacheinfo','160000',head,child],env);
    }
    const tree=(await git(repo,['write-tree'],env)).trim();item.head=(await git(repo,['commit-tree',tree,'-p',base],env,'Studio device handoff checkpoint\n')).trim();
    await git(repo,['update-ref',ref,item.head]);await git(repo,['bundle','create',cache.file(index),ref]);item.size=statSync(cache.file(index)).size;item.sha256=await migrationHash(cache.file(index));
    try{await git(repo,['diff','--quiet','--no-ext-diff','--ignore-submodules=all'],env);}catch{throw Error('保存期间工作副本仍在变化，请结束本机工具后重试迁移');}return item.head;
  }
  await snapshot(root,'');cache.save(manifest);return manifest;
}

export async function importMigration(store:BridgeStore,dataDir:string,project:Project,runId:string,id:string):Promise<StudioWorkspace>{
  store.db.exec('CREATE TABLE IF NOT EXISTS studio_workspaces(id TEXT PRIMARY KEY,json TEXT NOT NULL)');
  const cache=new MigrationCache(dataDir,id),manifest=await cache.verify();if(manifest.runId!==runId)throw Error('迁移需求不匹配');
  const source=realpathSync.native(project.path),repo=realpathSync.native((await git(source,['rev-parse','--show-toplevel'])).trim());
  const old=store.db.prepare('SELECT json FROM studio_workspaces WHERE id=?').get(runId);
  if(old){const w=JSON.parse(String(old.json)) as StudioWorkspace;if(w.migrationId===id){if(w.sourcePath!==source||!existsSync(w.project.path)||(await git(w.project.path,['branch','--show-current'])).trim()!==w.branch)throw Error('迁移副本绑定已变化');return w;}}
  // Local-only task commits travel in the bundle. Verify common history in a
  // private bare repository when the target has not seen that source HEAD yet.
  // An unrelated repository is rejected without changing its refs or files.
  try{await git(repo,['cat-file','-e',manifest.repositories[0].base+'^{commit}']);}catch{
    const check=join(cache.root,'identity');if(!existsSync(check)){mkdirSync(check,{recursive:true});await git(check,['init','--bare']);}
    const root=manifest.repositories[0];await git(check,['fetch','--no-tags',cache.file(0),root.ref+':'+root.ref]);await git(check,['-c','protocol.file.allow=always','fetch','--no-tags',repo,'HEAD:refs/relay-target-head']);
    try{await git(check,['merge-base',root.head,'refs/relay-target-head']);}catch{throw Error('目标仓库与任务基线不匹配，请指定具有相同历史的 game 仓库');}
  }
  if(relative(repo,source).replaceAll('\\','/')!==manifest.projectRelative)throw Error('请选择与原任务相同层级的游戏工程目录');
  const target=resolve(dataDir,'studio-workspaces',runId+'-migration-'+id),branch='codex/studio-'+runId+'-migration-'+id.slice(0,8),progressFile=join(cache.root,'import.json');
  const prior=existsSync(progressFile)?JSON.parse(readFileSync(progressFile,'utf8')):undefined;
  if(prior&&(prior.source!==source||prior.target!==target))throw Error('此迁移已绑定其他目标路径');
  const progress:{source:string;target:string;completed:number[]}=prior??{source,target,completed:[]};writeFileSync(progressFile,JSON.stringify(progress),{mode:0o600});
  for(const [i,r] of manifest.repositories.entries()){
    if(i&&(!migrationPath(r.path)||!manifest.repositories.slice(0,i).some(p=>p.path===''||r.path.startsWith(p.path+'/'))))throw Error('子仓库路径无效');
    const destination=i?resolve(target,r.path):target;
    if(!inside(target,destination))throw Error('目标副本超出范围');
    let owner=repo;if(i){owner=join(cache.root,'repositories',String(i));if(!existsSync(owner)){mkdirSync(owner,{recursive:true});await git(owner,['init','--bare']);}}
    const childBranch=i?branch+'-sub-'+i:branch;
    // Recover the narrow crash window after worktree add but before recording
    // its completion. Adopt only this exact repository, branch and checkpoint.
    if(!progress.completed.includes(i)&&existsSync(join(destination,'.git'))){
      const common=realpathSync.native(resolve(destination,(await git(destination,['rev-parse','--git-common-dir'])).trim())),expected=realpathSync.native(resolve(owner,(await git(owner,['rev-parse','--git-common-dir'])).trim()));
      if(common!==expected||(await git(destination,['branch','--show-current'])).trim()!==childBranch||(await git(destination,['rev-parse','HEAD'])).trim()!==r.head)throw Error('迁移目标已存在其他工作副本，已保留现场');
      progress.completed.push(i);writeFileSync(progressFile,JSON.stringify(progress),{mode:0o600});
    }
    if(progress.completed.includes(i)){
      if(!existsSync(destination)||realpathSync.native((await git(destination,['rev-parse','--show-toplevel'])).trim())!==realpathSync.native(destination)||(await git(destination,['rev-parse','HEAD'])).trim()!==r.head||(await git(destination,['branch','--show-current'])).trim()!==childBranch)throw Error('已恢复副本发生变化，请核对现场');continue;
    }
    await git(owner,['bundle','verify',cache.file(i)]);await git(owner,['fetch','--no-tags',cache.file(i),r.ref+':'+r.ref]);
    mkdirSync(dirname(destination),{recursive:true});if(!inside(realpathSync.native(target===destination?dirname(target):target),realpathSync.native(dirname(destination))))throw Error('迁移目标目录含外部链接');
    if(existsSync(destination)&&(!lstatSync(destination).isDirectory()||existsSync(join(destination,'.git'))))throw Error('迁移目标已存在，保留现场，请核对后重试');
    // worktree add refuses nonempty directories and existing branches. Never force.
    await git(owner,['worktree','add','-b',childBranch,destination,r.head]);progress.completed.push(i);writeFileSync(progressFile,JSON.stringify(progress),{mode:0o600});
  }
  const cwd=resolve(target,manifest.projectRelative);if(!inside(realpathSync.native(target),realpathSync.native(cwd)))throw Error('迁移游戏目录超出副本');
  const execution:Project={id:'studio-'+runId,name:project.name+' · '+runId.slice(0,8),path:cwd,roots:[cwd],source:'configured'};
  const value:StudioWorkspace={runId,project:execution,branch,sourcePath:source,sourceBranch:(await git(repo,['branch','--show-current'])).trim(),head:manifest.repositories[0].head,trackedSnapshot:true,untrackedFiles:0,createdAt:Date.now(),submodules:manifest.repositories.length-1,migrationId:id};
  store.saveProject(execution);store.db.prepare('INSERT OR REPLACE INTO studio_workspaces VALUES(?,?)').run(runId,JSON.stringify(value));return value;
}
