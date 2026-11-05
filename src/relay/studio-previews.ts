import type {DatabaseSync} from 'node:sqlite';
import type {MediaStore} from '../shared/media.js';

type PreviewSource={bytes:Buffer;mime:string;name:string;sha256:string};
// Review versions pin what was shown. Approval still reads the workstation
// independently and rejects files changed since that preview.
export class StudioPreviews {
  private pending=new Map<string,Promise<PreviewSource>>();
  constructor(private db:DatabaseSync,private media:MediaStore){
    db.exec('CREATE TABLE IF NOT EXISTS studio_preview_refs(key TEXT PRIMARY KEY,session_id TEXT NOT NULL,sha256 TEXT NOT NULL)');
  }
  knownHash(sessionId:string,path:string):string|undefined{
    const row=this.db.prepare("SELECT sha256 FROM studio_preview_refs WHERE session_id=? AND json_extract(key,'$[6]')=? ORDER BY rowid DESC LIMIT 1").get(sessionId,path);
    return row&&this.media.read(sessionId,String(row.sha256))?String(row.sha256):undefined;
  }
  async get(key:string,sessionId:string,load:()=>Promise<PreviewSource>,fresh=false):Promise<PreviewSource&{source:string}>{
    const pendingKey=JSON.stringify([sessionId,key]);
    if(!fresh){
      const row=this.db.prepare('SELECT sha256 FROM studio_preview_refs WHERE key=? AND session_id=?').get(key,sessionId);
      const cached=row&&this.media.read(sessionId,String(row.sha256));
      if(cached)return {...cached,sha256:String(row!.sha256),source:'server-review-cache'};
    }
    const pending=this.pending.get(pendingKey);
    if(pending){
      if(fresh){await pending.catch(()=>{});return this.get(key,sessionId,load,true);}
      return {...await pending,source:'workstation'};
    }
    const job=Promise.resolve().then(load).then(value=>{
      // Only authenticated media already verified and scoped to this session
      // may become a persistent review reference.
      if(!this.media.read(sessionId,value.sha256))throw Error('原画预览尚未安全缓存');
      this.db.prepare('INSERT OR REPLACE INTO studio_preview_refs VALUES(?,?,?)').run(key,sessionId,value.sha256);
      return value;
    }).finally(()=>this.pending.delete(pendingKey));
    this.pending.set(pendingKey,job);return {...await job,source:'workstation'};
  }
}
