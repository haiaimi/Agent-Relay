import {readFileSync,statSync,realpathSync} from 'node:fs';
import {resolve,isAbsolute,basename} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {MAX_IMAGE_BYTES,MediaStore,type ImageRef} from '../shared/media.js';
import type {Message} from '../shared/protocol.js';

const MarkdownIt=createRequire(import.meta.url)('markdown-it');
const parser=new MarkdownIt({html:false});
const imported=new WeakMap<MediaStore,Map<string,ImageRef>>();
type Source={path?:string;data?:string;name?:string};
export function imageSources(raw:unknown):Source[]{
  const found:Source[]=[];
  const text=(value:string)=>{
    if(value.includes('](')||value.includes('![')){
      const visit=(tokens:any[])=>{for(const t of tokens){if(t.type==='image')found.push({path:t.attrGet('src'),name:t.content||'图片'});else if(t.type==='link_open'){const href=t.attrGet('href')??'';if(!/^[a-z][a-z0-9+.-]*:/i.test(href.replace(/^[a-z]:[\\/]/i,''))&&/\.(?:png|jpe?g|gif|webp)$/i.test(href))found.push({path:href});}if(t.children)visit(t.children);}};
      visit(parser.parse(value,{}));
    }
    for(const match of value.matchAll(/^\s*(?:## .+?\.(?:png|jpe?g|gif|webp):|\-\s*\[Image[^\]]*\]:)\s*(.+)$/gim))found.push({path:match[1].trim()});
    for(const match of value.matchAll(/<image\b[^>]*\bpath="([^"]+)"/gi))found.push({path:match[1]});
  };
  const walk=(value:any,depth=0,scanText=true)=>{
    if(depth>10||found.length>=40||value==null)return;
    if(typeof value==='string'){if(scanText&&!value.startsWith('data:')&&value.length<1_000_000)text(value);return;}
    if(Array.isArray(value)){for(const child of value)walk(child,depth+1,scanText);return;}
    if(typeof value!=='object')return;
    const type=String(value.type??'');
    // Tool logs and source patches may quote image markup as code. Only typed
    // image blocks from those records are assets; conversational text may link images.
    if(value.role==='tool'||['commandExecution','mcpToolCall','dynamicToolCall','fileChange','tool_result','tool_use'].includes(type))scanText=false;
    if(['imageGeneration','image_generation_call'].includes(type)){
      // The native history contains the actual result, even if savedPath expires.
      const result=value.result;
      if(typeof result==='string'&&result.startsWith('data:image/'))found.push({data:result,name:'生成的图片'});
      else if(typeof result==='string'&&/^(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR)/.test(result))found.push({data:`data:image/${result.startsWith('/9j/')?'jpeg':result.startsWith('R0lGOD')?'gif':result.startsWith('UklGR')?'webp':'png'};base64,${result}`,name:'生成的图片'});
      else if(typeof value.savedPath==='string')found.push({path:value.savedPath});
      else if(typeof value.path==='string')found.push({path:value.path});
    }
    if(['localImage','local_image','image','input_image','image_url','imageView','image_view'].includes(type)){
      if(typeof value.path==='string')found.push({path:value.path});
      const url=value.url??value.image_url?.url??value.image_url;
      if(typeof url==='string')found.push(url.startsWith('data:')?{data:url}:{path:url});
      if(value.source?.type==='base64'&&typeof value.source.data==='string')found.push({data:`data:${value.source.media_type};base64,${value.source.data}`});
      else if(value.source?.type==='url'&&typeof value.source.url==='string')found.push({path:value.source.url});
      if(typeof value.data==='string'&&typeof value.mimeType==='string')found.push({data:`data:${value.mimeType};base64,${value.data}`});
    }
    // Traverse content/results, not opaque base64 strings or raw generated tool code.
    for(const [key,child] of Object.entries(value))if(!['data','image_url','url','path','savedPath','source','input','arguments','command','revisedPrompt'].includes(key)&&!(key==='result'&&['imageGeneration','image_generation_call'].includes(type)))walk(child,depth+1,scanText);
  };
  walk(raw);return found.slice(0,40);
}

export function imageSafeText(text:string):string{return text.replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi,'[图片内容仅通过设备直传]');}
export function imageSafeJson(value:unknown):string{
  return JSON.stringify(value,(_key,item)=>{
    if(['b64_json','image_base64','imageData','image_data'].includes(_key))return '[图片内容仅通过设备直传]';
    if(typeof item==='string')return imageSafeText(item);
    if(item&&typeof item==='object'&&!Array.isArray(item)&&(['image','input_image','output_image'].includes(item.type)||String(item.mimeType??item.mime??item.media_type??'').startsWith('image/'))){
      return Object.fromEntries(Object.entries(item).map(([key,v])=>[key,['data','b64_json','image_base64'].includes(key)?'[图片内容仅通过设备直传]':v]));
    }
    return item;
  });
}
export function messageImages(store:MediaStore,sessionId:string,cwd:string,message:Message,raw:unknown):Message{
  message={...message,text:imageSafeText(message.text)};
  const sources=imageSources(raw);if(!sources.length)return {...message,images:[]};
  let memo=imported.get(store);if(!memo){memo=new Map();imported.set(store,memo);}
  const images:ImageRef[]=[],seen=new Set<string>();
  for(const source of sources){
    let name=source.name||'图片';
    try{
      let bytes:Buffer,key='';
      if(source.data){
        key=createHash('sha256').update(source.data).digest('hex');const prior=memo.get(key);if(prior){store.link(sessionId,prior);if(!seen.has(prior.id!)){images.push(prior);seen.add(prior.id!);}continue;}
        const match=/^data:image\/(?:png|jpe?g|gif|webp);base64,([A-Za-z0-9+/\s]*={0,2})$/i.exec(source.data);
        if(!match)throw new Error('内嵌图片格式不支持');
        if(match[1].length>Math.ceil(MAX_IMAGE_BYTES/3)*4+1024)throw new Error('图片超过单张 16 MB 上限');bytes=Buffer.from(match[1],'base64');
      }else{
        let path=source.path??'';try{path=decodeURIComponent(path);}catch{/* Keep literal percent characters in valid local names. */}
        if(/^data:/i.test(path)){const next=messageImages(store,sessionId,cwd,{...message,images:undefined},[{type:'image',url:path}]);for(const ref of next.images??[])if(!ref.id||!seen.has(ref.id)){images.push(ref);if(ref.id)seen.add(ref.id);}continue;}
        if(/^https?:/i.test(path))throw new Error('远程图片未自动下载，请使用原文链接查看');
        if(/^\/[A-Za-z]:[\\/]/.test(path))path=path.slice(1);
        if(/^\\\\\?\\[A-Za-z]:\\/.test(path))path=path.slice(4);
        if(/^[a-z][a-z0-9+.-]*:/i.test(path)&&!(/^[a-z]:[\\/]/i).test(path)||/^(?:\\\\|\/\/)/.test(path)||path.includes('\0'))throw new Error('仅支持本地图片文件');
        path=isAbsolute(path)?path:resolve(cwd,path);name=basename(path)||name;
        try{statSync(path);}catch(error){const cached=store.referenceByName(sessionId,name);if(cached){if(!seen.has(cached.id!)){images.push(cached);seen.add(cached.id!);}continue;}throw error;}
        path=realpathSync.native(path);if(/^(?:\\\\|\/\/)/.test(path)&&!/^\\\\\?\\[A-Za-z]:\\/.test(path))throw new Error('网络共享图片不自动读取');
        const stat=statSync(path);if(!stat.isFile())throw new Error('图片不是普通文件');if(stat.size>MAX_IMAGE_BYTES)throw new Error('图片超过单张 16 MB 上限');
        key=path+':'+stat.mtimeMs+':'+stat.size;const prior=memo.get(key);if(prior){store.link(sessionId,prior);if(!seen.has(prior.id!)){images.push(prior);seen.add(prior.id!);}continue;}bytes=readFileSync(path);
      }
      const ref=store.put(sessionId,bytes,name);memo.set(key,ref);if(memo.size>2000)memo.delete(memo.keys().next().value!);if(!seen.has(ref.id!)){images.push(ref);seen.add(ref.id!);}
    }catch(e){const error=(e as NodeJS.ErrnoException).code?'本地图片已不存在或无法读取':(e as Error).message;images.push({name,error});}
  }
  return {...message,images:images.slice(0,20)};
}
