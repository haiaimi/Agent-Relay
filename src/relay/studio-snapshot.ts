import {createHash} from 'node:crypto';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import type {IncomingMessage,ServerResponse} from 'node:http';
const compress=promisify(gzip);
export function studioSnapshot(){
 let cached:{etag:string;body:Promise<Buffer>}|undefined;
 return async(req:IncomingMessage,res:ServerResponse,text:string)=>{
  const etag='"'+createHash('sha256').update(text).digest('hex')+'"';res.setHeader('ETag',etag);res.setHeader('Vary','Accept-Encoding');
  if(req.headers['if-none-match']?.split(',').some(v=>v.trim()==='*'||v.trim().replace(/^W\//,'')===etag)){res.writeHead(304);res.end();return;}
  const accepts=(req.headers['accept-encoding']??'').split(',').some(part=>{const [name,...params]=part.trim().toLowerCase().split(';');const q=params.find(p=>p.trim().startsWith('q='))?.trim().slice(2);return name==='gzip'&&(q===undefined||Number(q)>0);});
  let body:Buffer;
  if(accepts&&Buffer.byteLength(text)>1024){if(cached?.etag!==etag)cached={etag,body:compress(text)};body=await cached.body;res.setHeader('Content-Encoding','gzip');}else body=Buffer.from(text);
  if(res.destroyed)return;res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Length':body.length});res.end(body);
 };
}
