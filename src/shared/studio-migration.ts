import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync,openSync,closeSync,readSync,writeSync,statSync,createReadStream,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';

export const MIGRATION_CHUNK=256*1024;
export interface MigrationRepository {path:string;base:string;head:string;ref:string;size:number;sha256:string}
export interface MigrationManifest {version:1;id:string;runId:string;projectRelative:string;repositories:MigrationRepository[]}
export interface MigrationRequest {id:string;op:'probe'|'freeze'|'export'|'read'|'write'|'status'|'import';file?:number;offset?:number;data?:string;manifest?:MigrationManifest;paths?:string[]}
export function migrationPath(path:unknown,empty=false):path is string {
  return typeof path==='string'&&path.length<2000&&(empty&&path===''||!!path&&!/[\\:\x00-\x1f]/.test(path)&&path.split('/').every(p=>p!==''&&p!=='.'&&p!=='..'&&p.toLowerCase()!=='.git'));
}
export function validateManifest(m:any):asserts m is MigrationManifest {
  if(m?.version!==1||!/^[-a-f0-9]{36}$/i.test(m.id??'')||!/^[-a-f0-9]{36}$/i.test(m.runId??'')||!migrationPath(m.projectRelative,true)||!Array.isArray(m.repositories)||!m.repositories.length||m.repositories.length>100||m.repositories[0].path!=='')throw Error('无效迁移清单');
  const paths=new Set<string>();
  for(const r of m.repositories){if(!migrationPath(r.path,true)||paths.has(r.path)||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(r.base)||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(r.head)||!/^refs\/relay-migrations\/[a-f0-9-]{36}\/\d+$/.test(r.ref)||!Number.isSafeInteger(r.size)||r.size<1||r.size>128*1024**3||!/^[a-f0-9]{64}$/.test(r.sha256))throw Error('无效迁移仓库清单');paths.add(r.path);}
}
export async function migrationHash(path:string){const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex');}

// The same bounded, sequential transfer format is used on the relay and bridge.
// Repeated chunks must match; neither retries nor an interrupted writer truncate data.
export class MigrationCache {
  readonly root:string;
  constructor(dir:string,id:string){if(!/^[a-f0-9-]{36}$/i.test(id))throw Error('无效迁移 ID');this.root=resolve(dir,'studio-migrations',id);mkdirSync(this.root,{recursive:true,mode:0o700});}
  file(index:number){if(!Number.isInteger(index)||index<0||index>=100)throw Error('无效迁移文件');return join(this.root,index+'.bundle');}
  manifest():MigrationManifest|undefined {const path=join(this.root,'manifest.json');if(!existsSync(path))return;const m=JSON.parse(readFileSync(path,'utf8'));validateManifest(m);return m;}
  save(m:MigrationManifest){validateManifest(m);if(m.id!==this.root.split(/[\\/]/).at(-1))throw Error('迁移 ID 不匹配');const old=this.manifest();if(old){if(JSON.stringify(old)!==JSON.stringify(m))throw Error('迁移清单已变化');return;}const path=join(this.root,'manifest.json'),temp=path+'.'+randomUUID();writeFileSync(temp,JSON.stringify(m),{mode:0o600,flag:'wx'});renameSync(temp,path);}
  size(index:number){const path=this.file(index);return existsSync(path)?statSync(path).size:0;}
  read(index:number,offset:number){const m=this.manifest(),r=m?.repositories[index];if(!r||!Number.isSafeInteger(offset)||offset<0||offset>r.size)throw Error('无效迁移分段');const bytes=Buffer.alloc(Math.min(MIGRATION_CHUNK,r.size-offset)),fd=openSync(this.file(index),'r');try{if(readSync(fd,bytes,0,bytes.length,offset)!==bytes.length)throw Error('迁移文件尚未完整保存');}finally{closeSync(fd);}return {offset,data:bytes.toString('base64')};}
  write(index:number,offset:number,data:string){const r=this.manifest()?.repositories[index];if(!r||!Number.isSafeInteger(offset)||offset<0||typeof data!=='string'||!data.length||data.length>Math.ceil(MIGRATION_CHUNK/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))throw Error('无效迁移分段');const bytes=Buffer.from(data,'base64'),size=this.size(index);if(!bytes.length||bytes.length>MIGRATION_CHUNK||bytes.toString('base64')!==data||offset+bytes.length>r.size||offset>size)throw Error('迁移分段越界');
    if(offset<size){const fd=openSync(this.file(index),'r');try{const old=Buffer.alloc(bytes.length);if(offset+bytes.length>size||readSync(fd,old,0,old.length,offset)!==old.length||!old.equals(bytes))throw Error('迁移重试内容不一致');}finally{closeSync(fd);}return size;}
    const fd=openSync(this.file(index),size?'r+':'wx',0o600);try{let n=0;while(n<bytes.length)n+=writeSync(fd,bytes,n,bytes.length-n,offset+n);}finally{closeSync(fd);}return offset+bytes.length;
  }
  dropBundles(){const m=this.manifest();if(!m)return;for(const [i] of m.repositories.entries())if(existsSync(this.file(i)))unlinkSync(this.file(i));}
  async verify(){const m=this.manifest();if(!m)throw Error('迁移清单尚未保存');for(const [i,r] of m.repositories.entries())if(this.size(i)!==r.size||await migrationHash(this.file(i))!==r.sha256)throw Error('迁移文件校验失败：'+(r.path||'game'));return m;}
}
