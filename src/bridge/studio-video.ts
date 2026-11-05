import {openSync,closeSync,readSync,fstatSync,realpathSync,lstatSync} from 'node:fs';
import {resolve,relative,isAbsolute,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {videoMime} from '../shared/video.js';
import type {Session} from '../shared/protocol.js';

export const VIDEO_CHUNK=256*1024;
// Bytes stay on this workstation. The relay may ask only for bounded ranges of
// a declared delivery inside the registered demand workspace.
export function studioVideo(session:Session,path:string,workspaceRoot:string,offset?:number,length?:number,expected?:string){
  if(!/^studio-[a-f0-9-]{36}$/i.test(session.projectId??''))throw Error('视频只能从本需求工作副本读取');
  const root=realpathSync.native(workspaceRoot),inside=(p:string)=>{const r=relative(root,p);return r!==''&&!r.startsWith('..')&&!isAbsolute(r);},target=resolve(root,path),cwd=realpathSync.native(session.cwd);
  if(relative(root,cwd)!==''&&!inside(cwd)||!inside(target)||!lstatSync(target).isFile()||!inside(realpathSync.native(target)))throw Error('视频路径超出本需求工作副本');
  const fd=openSync(target,'r');try{
    const stat=fstatSync(fd,{bigint:true}),version=createHash('sha256').update([stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':')).digest('hex'),size=Number(stat.size),head=Buffer.alloc(64);readSync(fd,head,0,64,0);
    const mime=videoMime(head);if(!mime||!Number.isSafeInteger(size)||size<1)throw Error('交付文件不是可播放视频');
    if(expected&&expected!==version)throw Error('视频文件已变化，请重新打开');
    const info={size,mime,version,name:basename(target)};
    if(offset===undefined)return info;
    if(!Number.isSafeInteger(offset)||offset<0||offset>=size||!Number.isSafeInteger(length)||length!<1||length!>VIDEO_CHUNK||!expected)throw Error('无效视频分段');
    const bytes=Buffer.alloc(Math.min(length!,size-offset)),n=readSync(fd,bytes,0,bytes.length,offset);
    if(n!==bytes.length)throw Error('视频分段读取中断');return {...info,offset,data:bytes.toString('base64')};
  }finally{closeSync(fd);}
}
