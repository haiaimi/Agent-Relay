import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RelayEvent, Session, Action } from '../shared/protocol.js';
export class BridgeStore {
  db:DatabaseSync;
  constructor(dir:string) {
    mkdirSync(dir,{recursive:true,mode:0o700});this.db=new DatabaseSync(join(dir,'bridge.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,request TEXT NOT NULL,result TEXT);
      CREATE TABLE IF NOT EXISTS history_synced(id TEXT PRIMARY KEY,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS input_queue(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,session_id TEXT NOT NULL,json TEXT NOT NULL,state TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS bridge_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    if(this.db.prepare("SELECT value FROM bridge_meta WHERE key='history-format'").get()?.value!=='3'){
      this.db.exec("DELETE FROM history_synced; INSERT OR REPLACE INTO bridge_meta VALUES('history-format','3')");
    }
  }
  sessions():Session[]{return this.db.prepare('SELECT json FROM sessions').all().map(r=>JSON.parse(String(r.json)));}
  save(s:Session){this.db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?)').run(s.id,JSON.stringify(s));}
  event(e:RelayEvent){this.db.prepare('INSERT OR IGNORE INTO outbox(id,json) VALUES(?,?)').run(e.id,JSON.stringify(e));}
  outbox(){return this.db.prepare('SELECT json FROM outbox ORDER BY seq LIMIT 500').all().map(r=>JSON.parse(String(r.json)) as RelayEvent);}
  ack(id:string){this.db.prepare('DELETE FROM outbox WHERE id=?').run(id);}
  begin(id:string,request:unknown):{fresh:boolean;result?:any}{
    const encoded=JSON.stringify(request);const old=this.db.prepare('SELECT request,result FROM commands WHERE id=?').get(id);
    if(old){if(old.request!==encoded)throw new Error('Command ID collision');return {fresh:false,result:old.result ? JSON.parse(String(old.result)) : {error:'Operation already accepted; outcome unknown after interruption'}};}
    this.db.prepare('INSERT INTO commands VALUES(?,?,NULL)').run(id,encoded);return {fresh:true};
  }
  finish(id:string,result:unknown){this.db.prepare('UPDATE commands SET result=? WHERE id=?').run(JSON.stringify(result),id);}
  synced(id:string):number{return Number(this.db.prepare('SELECT updated_at FROM history_synced WHERE id=?').get(id)?.updated_at??0);}
  markSynced(id:string,at:number){this.db.prepare('INSERT OR REPLACE INTO history_synced VALUES(?,?)').run(id,at);}
  enqueue(action:Action){this.db.prepare("INSERT INTO input_queue(id,session_id,json,state) VALUES(?,?,?,'queued')").run(action.id,action.sessionId!,JSON.stringify(action));}
  queued():Action[]{return this.db.prepare("SELECT json FROM input_queue WHERE state='queued' ORDER BY seq").all().map(r=>JSON.parse(String(r.json)));}
  inputState(id:string,state:string){this.db.prepare('UPDATE input_queue SET state=? WHERE id=?').run(state,id);}
  claimInput(id:string,sessionId:string,state:string):boolean{return this.db.prepare("UPDATE input_queue SET state=? WHERE id=? AND session_id=? AND state='queued'").run(state,id,sessionId).changes===1;}
  close(){this.db.close();}
}
