import sharp from 'sharp';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';

export class ImagePreviews {
  private root:string;
  private pending=new Map<string,Promise<Buffer>>();
  private tail:Promise<unknown>=Promise.resolve();
  constructor(dir:string){this.root=join(dir,'previews');mkdirSync(this.root,{recursive:true,mode:0o700});}
  async image(bytes:Buffer,mime:string){
    if(bytes.length<96*1024)return {bytes,mime,hash:createHash('sha256').update(bytes).digest('hex')};
    const key=createHash('sha256').update(bytes).digest('hex')+'-960-v1',path=join(this.root,key+'.webp');
    let preview:Buffer|undefined;try{preview=readFileSync(path);}catch{}
    if(!preview){
      let job=this.pending.get(key);
      if(!job){
        job=this.tail.catch(()=>{}).then(async()=>{
          const result=await sharp(bytes,{limitInputPixels:20_000_000,animated:false}).rotate().resize({width:960,height:960,fit:'inside',withoutEnlargement:true}).webp({quality:78,effort:3}).toBuffer();
          const temp=join(this.root,randomUUID()+'.part');writeFileSync(temp,result,{mode:0o600});renameSync(temp,path);return result;
        }).finally(()=>this.pending.delete(key));this.pending.set(key,job);this.tail=job;
      }
      try{preview=await job;}catch{return {bytes,mime,hash:createHash('sha256').update(bytes).digest('hex')};}
    }
    if(preview.length>=bytes.length)return {bytes,mime,hash:createHash('sha256').update(bytes).digest('hex')};
    return {bytes:preview,mime:'image/webp',hash:createHash('sha256').update(preview).digest('hex')};
  }
}
