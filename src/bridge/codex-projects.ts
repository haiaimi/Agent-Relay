import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Project} from '../shared/protocol.js';

export interface CodexProjects {projects:Project[];assignments:Map<string,string>;projectless:Set<string>;parents:Map<string,string>}
// Keep native identity. Names or cwd are never used to guess membership.
export function readCodexProjects(home:string):CodexProjects{
  const projects=new Map<string,Project>(),assignments=new Map<string,string>(),projectless=new Set<string>(),parents=new Map<string,string>();
  const state=join(home,'state_5.sqlite');
  if(existsSync(state)){
    const db=new DatabaseSync(state,{readOnly:true});
    try{
      const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>String(r.name)));
      if(tables.has('projects')&&tables.has('project_roots')){
        for(const p of db.prepare('SELECT id,name FROM projects ORDER BY position').all()){
          const roots=db.prepare('SELECT path FROM project_roots WHERE project_id=? ORDER BY position').all(p.id).map(r=>String(r.path));
          const id='codex:'+p.id;projects.set(id,{id,name:String(p.name),path:roots[0]??'',roots,source:'codex',nativeProjectId:String(p.id)});
        }
      }
      const cols=new Set(db.prepare('PRAGMA table_info(threads)').all().map(r=>String(r.name)));
      if(cols.has('project_id'))for(const r of db.prepare('SELECT id,project_id FROM threads WHERE project_id IS NOT NULL').all())assignments.set(String(r.id),'codex:'+r.project_id);
      if(tables.has('thread_spawn_edges'))for(const r of db.prepare('SELECT parent_thread_id,child_thread_id FROM thread_spawn_edges').all())parents.set(String(r.child_thread_id),String(r.parent_thread_id));
    }finally{db.close();}
  }
  // The desktop catalog may carry membership before the app-server state does.
  for(const name of ['codex.db','codex-dev.db']){
    const path=join(home,'sqlite',name);if(!existsSync(path))continue;const db=new DatabaseSync(path,{readOnly:true});
    try{
      const cols=db.prepare('PRAGMA table_info(local_thread_catalog)').all().map(r=>String(r.name));
      if(cols.includes('project_id'))for(const r of db.prepare("SELECT thread_id,project_id FROM local_thread_catalog WHERE host_id='local' AND project_id IS NOT NULL").all())if(!assignments.has(String(r.thread_id)))assignments.set(String(r.thread_id),'codex:'+r.project_id);
    }finally{db.close();}
  }
  const globalPath=join(home,'.codex-global-state.json');
  if(existsSync(globalPath)){
    // Desktop writes atomically; malformed snapshots are surfaced rather than guessed.
    const global=JSON.parse(readFileSync(globalPath,'utf8'));
    const maps=global['app-server-project-id-by-legacy-project-id-by-host']??{};
    const mapping:Record<string,string>={};
    for(const [host,value] of Object.entries(maps))if(host==='local'||host===`local:${home}`||host.toLowerCase()===`local:${home}`.toLowerCase())Object.assign(mapping,value);
    for(const p of Object.values(global['local-projects']??{}) as any[]){
      if(typeof p.id!=='string'||typeof p.name!=='string'||!Array.isArray(p.rootPaths))continue;
      const native=mapping[p.id]??p.id,id='codex:'+native;
      if(!projects.has(id)){const roots=p.rootPaths.filter((v:unknown)=>typeof v==='string');projects.set(id,{id,name:p.name,path:roots[0]??'',roots,source:'codex',nativeProjectId:native});}
    }
    for(const [thread,value] of Object.entries(global['thread-project-assignments']??{}) as [string,any][]){
      if(value?.projectKind==='local'&&typeof value.projectId==='string'&&!assignments.has(thread))assignments.set(thread,'codex:'+(mapping[value.projectId]??value.projectId));
    }
    for(const thread of global['projectless-thread-ids']??[])if(typeof thread==='string'&&!assignments.has(thread))projectless.add(thread);
  }
  // A subagent inherits its parent's project only when it has no explicit assignment.
  function projectOf(id:string,seen=new Set<string>()):string|undefined{
    if(projectless.has(id)||seen.has(id))return;seen.add(id);
    const explicit=assignments.get(id);if(explicit)return explicit;
    const parent=parents.get(id);const inherited=parent&&projectOf(parent,seen);if(inherited)assignments.set(id,inherited);return inherited||undefined;
  }
  for(const child of parents.keys())projectOf(child);
  return {projects:[...projects.values()],assignments,projectless,parents};
}
