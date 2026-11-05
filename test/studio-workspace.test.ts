import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,symlinkSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {prepareStudioWorkspace} from '../src/bridge/studio-workspace.js';
import {BridgeStore} from '../src/bridge/store.js';
const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','core.fsmonitor=false','-c','user.name=Studio QA','-c','user.email=qa@localhost',...args],{cwd,windowsHide:true,timeout:30000,encoding:'utf8',stdio:['ignore','pipe','pipe']});
function fixture(){const root=mkdtempSync(join(tmpdir(),'studio-worktree-')),repo=join(root,'source'),data=join(root,'data');mkdirSync(repo);git(repo,'init','-b','main');writeFileSync(join(repo,'game.txt'),'baseline\n');writeFileSync(join(repo,'.gitignore'),'cache/\n');git(repo,'add','.');git(repo,'commit','-m','Test baseline');const store=new BridgeStore(data);return {root,repo,data,store,project:{id:'game',name:'Game',path:repo},close(){store.close();assert.ok(realpathSync.native(root).startsWith(realpathSync.native(tmpdir())));rmSync(root,{recursive:true,force:true});}};}
test('each demand receives its own branch, preserves staged/unstaged/untracked source and carries changes forward',async()=>{
  const f=fixture();try{
    writeFileSync(join(f.repo,'game.txt'),'staged\n');git(f.repo,'add','game.txt');writeFileSync(join(f.repo,'game.txt'),'staged and unstaged\n');writeFileSync(join(f.repo,'reference.txt'),'untracked reference');mkdirSync(join(f.repo,'cache'));writeFileSync(join(f.repo,'cache','ignored.bin'),'ignored');
    const before=git(f.repo,'status','--porcelain=v1'),index=git(f.repo,'diff','--cached'),head=git(f.repo,'rev-parse','HEAD'),id=randomUUID();
    const a=await prepareStudioWorkspace(f.store,f.data,f.project,0,id),b=await prepareStudioWorkspace(f.store,f.data,f.project,0,randomUUID());
    assert.notEqual(a.branch,b.branch);assert.notEqual(a.project.path,b.project.path);assert.equal(git(a.project.path,'branch','--show-current').trim(),a.branch);assert.equal(a.branch,'codex/studio-'+id);
    assert.equal(readFileSync(join(a.project.path,'game.txt'),'utf8'),'staged and unstaged\n');assert.equal(readFileSync(join(a.project.path,'reference.txt'),'utf8'),'untracked reference');assert.equal(existsSync(join(a.project.path,'cache')),false);
    writeFileSync(join(a.project.path,'game.txt'),'agent changes');assert.equal(readFileSync(join(f.repo,'game.txt'),'utf8'),'staged and unstaged\n');assert.equal(git(f.repo,'status','--porcelain=v1'),before);assert.equal(git(f.repo,'diff','--cached'),index);assert.equal(git(f.repo,'rev-parse','HEAD'),head);assert.equal(git(f.repo,'branch','--show-current').trim(),'main');
    assert.deepEqual(await prepareStudioWorkspace(f.store,f.data,f.project,0,id),a);
    git(a.project.path,'checkout','--detach');await assert.rejects(prepareStudioWorkspace(f.store,f.data,f.project,0,id),/分支已变化/);
  }finally{f.close();}
});
test('a nested game directory stays within the matching isolated repository',async()=>{
  const f=fixture();try{mkdirSync(join(f.repo,'project'));writeFileSync(join(f.repo,'project','project.godot'),'fixture');const result=await prepareStudioWorkspace(f.store,f.data,{...f.project,path:join(f.repo,'project')},0,randomUUID());assert.equal(readFileSync(join(result.project.path,'project.godot'),'utf8'),'fixture');assert.ok(result.project.path.endsWith('project'));}finally{f.close();}
});

test('continuation snapshots the delivered worktree including uncommitted assets without modifying its branch or index',async()=>{
  const f=fixture();try{
    const parent=await prepareStudioWorkspace(f.store,f.data,f.project,0,randomUUID());
    writeFileSync(join(parent.project.path,'game.txt'),'delivered game changes');git(parent.project.path,'add','game.txt');
    writeFileSync(join(parent.project.path,'game.txt'),'delivered staged and unstaged changes');
    mkdirSync(join(parent.project.path,'assets'));writeFileSync(join(parent.project.path,'assets','room.glb'),'delivered untracked asset');
    mkdirSync(join(parent.project.path,'cache'));writeFileSync(join(parent.project.path,'cache','ignored.bin'),'cache');
    const before=git(parent.project.path,'status','--porcelain=v1'),index=git(parent.project.path,'diff','--cached');
    const child=await prepareStudioWorkspace(f.store,f.data,parent.project,0,randomUUID());
    assert.equal(child.sourcePath,parent.project.path);assert.equal(child.sourceBranch,parent.branch);assert.equal(child.head,parent.head);assert.notEqual(child.branch,parent.branch);
    assert.equal(readFileSync(join(child.project.path,'assets','room.glb'),'utf8'),'delivered untracked asset');
    assert.equal(readFileSync(join(child.project.path,'game.txt'),'utf8'),'delivered staged and unstaged changes');assert.equal(existsSync(join(child.project.path,'cache')),false);
    writeFileSync(join(child.project.path,'assets','room.glb'),'next production change');
    assert.equal(readFileSync(join(parent.project.path,'assets','room.glb'),'utf8'),'delivered untracked asset');
    assert.equal(git(parent.project.path,'status','--porcelain=v1'),before);assert.equal(git(parent.project.path,'diff','--cached'),index);assert.equal(git(parent.project.path,'branch','--show-current').trim(),parent.branch);
    assert.equal(readFileSync(join(f.repo,'game.txt'),'utf8'),'baseline\n');
  }finally{f.close();}
});
test('engine submodules get independent dirty snapshots without switching the original engine',async()=>{
  const f=fixture();try{
    const engine=join(f.root,'engine-origin');mkdirSync(engine);git(engine,'init','-b','main');writeFileSync(join(engine,'engine.txt'),'baseline');git(engine,'add','.');git(engine,'commit','-m','Engine fixture');
    git(f.repo,'-c','protocol.file.allow=always','submodule','add',engine,'engine');git(f.repo,'commit','-am','Add test engine');const source=join(f.repo,'engine');writeFileSync(join(source,'engine.txt'),'dirty engine');writeFileSync(join(source,'extra.txt'),'engine reference');const before=git(source,'status','--porcelain=v1');
    const w=await prepareStudioWorkspace(f.store,f.data,f.project,0,randomUUID());assert.equal(w.submodules,1);const isolated=join(w.project.path,'engine');assert.match(git(isolated,'branch','--show-current'),/codex\/studio-.*-sub-/);assert.equal(readFileSync(join(isolated,'engine.txt'),'utf8'),'dirty engine');assert.equal(readFileSync(join(isolated,'extra.txt'),'utf8'),'engine reference');writeFileSync(join(isolated,'engine.txt'),'agent engine');assert.equal(readFileSync(join(source,'engine.txt'),'utf8'),'dirty engine');assert.equal(git(source,'status','--porcelain=v1'),before);assert.equal(git(source,'branch','--show-current').trim(),'main');
  }finally{f.close();}
});
test('non-git and incomplete worktrees fail closed, never falling back to source',async()=>{
  const f=fixture();try{const plain=join(f.root,'plain');mkdirSync(plain);await assert.rejects(prepareStudioWorkspace(f.store,f.data,{...f.project,path:plain},0,randomUUID()),/Git 仓库/);const id=randomUUID(),partial=join(f.data,'studio-workspaces',id);mkdirSync(partial,{recursive:true});writeFileSync(join(partial,'keep.txt'),'keep');await assert.rejects(prepareStudioWorkspace(f.store,f.data,f.project,0,id),/准备未完成/);assert.equal(readFileSync(join(partial,'keep.txt'),'utf8'),'keep');}finally{f.close();}
});
test('capture evidence stays in the source by default and can be explicitly included',async()=>{
  const f=fixture();try{mkdirSync(join(f.repo,'captures'));writeFileSync(join(f.repo,'captures','frame.png'),'test capture');writeFileSync(join(f.repo,'game-script.txt'),'local game source');const skipped=await prepareStudioWorkspace(f.store,f.data,f.project,0,randomUUID());assert.equal(skipped.skippedCaptures,1);assert.equal(existsSync(join(skipped.project.path,'captures','frame.png')),false);assert.equal(readFileSync(join(skipped.project.path,'game-script.txt'),'utf8'),'local game source');const included=await prepareStudioWorkspace(f.store,f.data,f.project,0,randomUUID(),true);assert.equal(included.skippedCaptures,0);assert.equal(readFileSync(join(included.project.path,'captures','frame.png'),'utf8'),'test capture');assert.equal(readFileSync(join(f.repo,'captures','frame.png'),'utf8'),'test capture');}finally{f.close();}
});
