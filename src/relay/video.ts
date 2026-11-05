import type {IncomingMessage,ServerResponse} from 'node:http';
// Call only after session authorization and content integrity checks.
export function serveVideo(req:IncomingMessage,res:ServerResponse,bytes:Buffer,mime:string,hash:string,source='server-cache'){
  const headers:Record<string,string|number>={'Content-Type':mime,'Accept-Ranges':'bytes','X-Content-Sha256':hash,'X-Asset-Source':source,'Content-Disposition':'inline'};
  const range=req.headers.range;
  if(!range){res.writeHead(200,{...headers,'Content-Length':bytes.length});res.end(bytes);return;}
  const match=/^bytes=(\d*)-(\d*)$/.exec(range);
  let start=0,end=bytes.length-1;
  if(match&&(match[1]||match[2])){
    if(!match[1]){const suffix=Number(match[2]);start=Math.max(0,bytes.length-suffix);if(suffix<1)start=bytes.length;}
    else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
  }else start=bytes.length;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=bytes.length||end<start){res.writeHead(416,{...headers,'Content-Range':`bytes */${bytes.length}`,'Content-Length':0});res.end();return;}
  res.writeHead(206,{...headers,'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':end-start+1});res.end(bytes.subarray(start,end+1));
}
