import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {imageMime} from './media.js';
export const MAX_UPLOAD_BYTES=16*1024*1024;
export const MAX_ATTACHMENTS=5;
export interface FileRef {id:string;name:string;size:number;mime:string;sha256:string}
export interface FilePayload {scope:string;file:FileRef;data:string}
export const uploadId=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export class FileStore {
  private root:string;
  constructor(dir:string,private db:DatabaseSync){
    this.root=resolve(dir,'uploads');mkdirSync(this.root,{recursive:true,mode:0o700});
    db.exec('CREATE TABLE IF NOT EXISTS upload_files(id TEXT NOT NULL,scope TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(id,scope))');
  }
  put(scope:string,file:FileRef,bytes:Buffer):FileRef {
    if(!scope||scope.length>400||!uploadId.test(file?.id??'')||!bytes.length||bytes.length>MAX_UPLOAD_BYTES||file.size!==bytes.length||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('附件校验失败或超过 16 MB');
    const ref:FileRef={id:file.id,name:file.name,size:bytes.length,mime:imageMime(bytes)??'application/octet-stream',sha256:file.sha256};
    this.validate(scope,ref);
    const dir=join(this.root,ref.id);mkdirSync(dir,{recursive:true,mode:0o700});
    const path=join(dir,ref.name);if(!existsSync(path)){const temp=join(dir,randomUUID()+'.part');writeFileSync(temp,bytes,{mode:0o600,flag:'wx'});renameSync(temp,path);}
    this.db.prepare('INSERT OR IGNORE INTO upload_files VALUES(?,?,?)').run(ref.id,scope,JSON.stringify(ref));return ref;
  }
  private validate(scope:string,file:FileRef){
    if(!scope||scope.length>400||!uploadId.test(file?.id??'')||!Number.isSafeInteger(file.size)||file.size<1||file.size>MAX_UPLOAD_BYTES||!/^[a-f0-9]{64}$/.test(file.sha256)||!['image/png','image/jpeg','image/gif','image/webp','application/octet-stream'].includes(file.mime))throw new Error('无效附件索引');
    if(typeof file.name!=='string'||!file.name||file.name.length>180||/[\\/\x00-\x1f]/.test(file.name)||file.name==='.'||file.name==='..'||/[. ]$/.test(file.name)||/[:<>"|?*]/.test(file.name)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(file.name))throw new Error('文件名不受支持');
    const old=this.db.prepare('SELECT json FROM upload_files WHERE id=? LIMIT 1').get(file.id);
    if(old&&JSON.stringify(JSON.parse(String(old.json)))!==JSON.stringify(file))throw new Error('附件 ID 冲突');
  }
  register(scope:string,file:FileRef){this.validate(scope,file);const ref={id:file.id,name:file.name,size:file.size,mime:file.mime,sha256:file.sha256};this.db.prepare('INSERT OR IGNORE INTO upload_files VALUES(?,?,?)').run(ref.id,scope,JSON.stringify(ref));return ref;}
  refs(scope:string,ids:string[]=[]){const refs=ids.map(id=>this.ref(scope,id));if(refs.length>MAX_ATTACHMENTS||refs.reduce((n,f)=>n+f.size,0)>MAX_UPLOAD_BYTES)throw new Error('最多 5 个附件，总大小不能超过 16 MB');return refs;}
  import(payload:FilePayload){
    if(typeof payload?.data!=='string'||payload.data.length>Math.ceil(MAX_UPLOAD_BYTES/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(payload.data))throw new Error('无效附件');
    return this.put(payload.scope,payload.file,Buffer.from(payload.data,'base64'));
  }
  ref(scope:string,id:string):FileRef {
    if(!uploadId.test(id))throw new Error('无效附件 ID');const row=this.db.prepare('SELECT json FROM upload_files WHERE id=? AND scope=?').get(id,scope);
    if(!row)throw new Error('附件不属于此会话或项目');return JSON.parse(String(row.json));
  }
  read(scope:string,id:string){const file=this.ref(scope,id),path=join(this.root,file.id,file.name),bytes=readFileSync(path);if(bytes.length!==file.size||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('附件已损坏');return {file,path,bytes};}
  link(from:string,to:string,id:string){const file=this.ref(from,id);this.db.prepare('INSERT OR IGNORE INTO upload_files VALUES(?,?,?)').run(id,to,JSON.stringify(file));}
  files(scope:string,ids:string[]=[]){const files=ids.map(id=>this.read(scope,id));if(files.length>MAX_ATTACHMENTS||files.reduce((n,f)=>n+f.file.size,0)>MAX_UPLOAD_BYTES)throw new Error('最多 5 个附件，总大小不能超过 16 MB');return files;}
}
