import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute} from 'node:path';
import {MediaStore,MAX_IMAGE_BYTES,imageMime} from '../shared/media.js';
import type {Session} from '../shared/protocol.js';

export function studioArtifact(media:MediaStore,session:Session,path:string,workspaceRoot=session.cwd,knownHash?:string){
  // Native ownership may change after a turn completes. Read access belongs to the
  // registered demand workspace, independently of which process owns the agent.
  if(!/^studio-[a-f0-9-]{36}$/i.test(session.projectId??''))throw Error('原画只能从本需求工作副本读取');
  if(typeof path!=='string'||!path.trim()||path.length>2000||/[\x00\r\n]/.test(path))throw Error('无效原画路径');
  const root=realpathSync.native(workspaceRoot),target=resolve(root,path),inside=(value:string)=>{const rel=relative(root,value);return rel!==''&&!rel.startsWith('..')&&!isAbsolute(rel);};
  const cwd=realpathSync.native(session.cwd);if(relative(root,cwd)!==''&&!inside(cwd))throw Error('原画会话不属于本需求工作副本');
  if(!inside(target)||!lstatSync(target).isFile()||!inside(realpathSync.native(target)))throw Error('原画路径超出本需求工作副本或不是普通文件');
  const size=lstatSync(target).size;if(size<1||size>MAX_IMAGE_BYTES)throw Error('单张原画应为 1 字节至 16 MB');
  const bytes=readFileSync(target);if(bytes.length>MAX_IMAGE_BYTES||!imageMime(bytes))throw Error('仅支持实际 PNG / JPEG / GIF / WebP 原画图片');
  const hash=createHash('sha256').update(bytes).digest('hex');
  if(knownHash===hash)return {id:hash,name:path.split(/[\\/]/).at(-1)||'原画',mime:imageMime(bytes)!,data:'',unchanged:true};
  const ref=media.put(session.id,bytes,path.split(/[\\/]/).at(-1)||'原画');return media.payload(session.id,ref.id!);
}
