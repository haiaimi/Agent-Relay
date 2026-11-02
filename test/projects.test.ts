import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readCodexProjects} from '../src/bridge/codex-projects.js';
test('Codex project identities, multiple roots, legacy membership and explicit projectless survive sync',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-projects-'));
  try{
    const db=new DatabaseSync(join(dir,'state_5.sqlite'));
    db.exec(`CREATE TABLE projects(id TEXT,name TEXT,position INTEGER);CREATE TABLE project_roots(project_id TEXT,path TEXT,position INTEGER);CREATE TABLE threads(id TEXT,project_id TEXT);CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT);`);
    db.exec("INSERT INTO projects VALUES('native-one','同名项目',0),('native-two','同名项目',1);INSERT INTO project_roots VALUES('native-one','/same/path',0),('native-one','/second/root',1),('native-two','/same/path',0);INSERT INTO threads VALUES('authoritative','native-two');INSERT INTO thread_spawn_edges VALUES('parent','child'),('parent','explicit-none');");db.close();
    writeFileSync(join(dir,'.codex-global-state.json'),JSON.stringify({'local-projects':{legacy:{id:'legacy',name:'同名项目',rootPaths:['/same/path','/second/root']}},'app-server-project-id-by-legacy-project-id-by-host':{['local:'+dir]:{legacy:'native-one'}},'thread-project-assignments':{parent:{projectKind:'local',projectId:'legacy'},authoritative:{projectKind:'local',projectId:'legacy'}},'projectless-thread-ids':['explicit-none']}));
    const index=readCodexProjects(dir);assert.equal(index.projects.length,2);assert.equal(index.projects[0].roots?.length,2);
    assert.equal(index.assignments.get('parent'),'codex:native-one');assert.equal(index.assignments.get('child'),'codex:native-one');assert.equal(index.assignments.get('authoritative'),'codex:native-two');assert.equal(index.assignments.has('explicit-none'),false);
  }finally{assert.ok(dir.startsWith(join(tmpdir(),'relay-projects-')));rmSync(dir,{recursive:true,force:true});}
});
