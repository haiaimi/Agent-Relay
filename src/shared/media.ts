import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';

export const MAX_IMAGE_BYTES=16*1024*1024;
export const BRIDGE_FRAME_BYTES=24*1024*1024;
export interface ImageRef {id?:string;name:string;mime?:string;size?:number;error?:string}
export interface ImagePayload {id:string;name:string;mime:string;data:string}
export function imageMime(bytes:Buffer):string|undefined{
  if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.length>=10&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)))return 'image/gif';
  if(bytes.length>=16&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
}
export function imageBytes(payload:ImagePayload):Buffer{
  if(!payload||!/^[a-f0-9]{64}$/.test(payload.id??'')||typeof payload.data!=='string'||payload.data.length>Math.ceil(MAX_IMAGE_BYTES/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(payload.data))throw new Error('Invalid image payload');
  const bytes=Buffer.from(payload.data,'base64');
  if(bytes.length>MAX_IMAGE_BYTES||!imageMime(bytes)||imageMime(bytes)!==payload.mime||createHash('sha256').update(bytes).digest('hex')!==payload.id)throw new Error('Invalid image content or hash');
  return bytes;
}
export class MediaStore {
  private root:string;
  constructor(dir:string,private db:DatabaseSync){
    this.root=join(dir,'images');mkdirSync(this.root,{recursive:true,mode:0o700});
    db.exec('CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,mime TEXT NOT NULL,size INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS media_refs(session_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(session_id,id))');
  }
  put(sessionId:string,bytes:Buffer,name:string):ImageRef{
    if(bytes.length>MAX_IMAGE_BYTES)throw new Error('图片超过单张 16 MB 上限');
    const mime=imageMime(bytes);if(!mime)throw new Error('仅支持 PNG、JPEG、GIF、WebP 图片');
    const id=createHash('sha256').update(bytes).digest('hex'),file=join(this.root,id);
    if(!existsSync(file)){const temp=join(this.root,randomUUID()+'.tmp');writeFileSync(temp,bytes,{mode:0o600});renameSync(temp,file);}
    name=String(name||'图片').replace(/[\x00-\x1f]/g,'').slice(0,180);
    this.db.prepare('INSERT OR IGNORE INTO media VALUES(?,?,?)').run(id,mime,bytes.length);
    this.db.prepare('INSERT OR IGNORE INTO media_refs(session_id,id,name) VALUES(?,?,?)').run(sessionId,id,name);
    return {id,name,mime,size:bytes.length};
  }
  putPayload(sessionId:string,payload:ImagePayload):ImageRef{return this.put(sessionId,imageBytes(payload),payload.name);}
  read(sessionId:string,id:string):{bytes:Buffer;mime:string;name:string}|undefined{
    if(!/^[a-f0-9]{64}$/.test(id))return;
    const row=this.db.prepare('SELECT m.mime,r.name FROM media m JOIN media_refs r ON r.id=m.id WHERE r.session_id=? AND m.id=?').get(sessionId,id);if(!row)return;
    try{const bytes=readFileSync(join(this.root,id));if(bytes.length>MAX_IMAGE_BYTES||createHash('sha256').update(bytes).digest('hex')!==id)return;return {bytes,mime:String(row.mime),name:String(row.name)};}catch{return;}
  }
  payload(sessionId:string,id:string):ImagePayload{
    const data=this.read(sessionId,id);if(!data)throw new Error('图片尚未缓存或不属于此会话');return {id,name:data.name,mime:data.mime,data:data.bytes.toString('base64')};
  }
  pending(sessionId:string):string[]{return this.db.prepare('SELECT id FROM media_refs WHERE session_id=? AND acked=0').all(sessionId).map(r=>String(r.id));}
  referenceByName(sessionId:string,name:string):ImageRef|undefined{
    const rows=this.db.prepare('SELECT m.id,m.mime,m.size,r.name FROM media m JOIN media_refs r ON r.id=m.id WHERE r.session_id=? AND r.name=? LIMIT 2').all(sessionId,name);
    if(rows.length!==1)return;const row=rows[0];if(!this.read(sessionId,String(row.id)))return;
    return {id:String(row.id),name:String(row.name),mime:String(row.mime),size:Number(row.size)};
  }
  pendingSessions():string[]{return this.db.prepare('SELECT DISTINCT session_id FROM media_refs WHERE acked=0').all().map(r=>String(r.session_id));}
  link(sessionId:string,ref:ImageRef){if(ref.id)this.db.prepare('INSERT OR IGNORE INTO media_refs(session_id,id,name) VALUES(?,?,?)').run(sessionId,ref.id,ref.name);}
  ack(sessionId:string,id:string){this.db.prepare('UPDATE media_refs SET acked=1 WHERE session_id=? AND id=?').run(sessionId,id);}
}
