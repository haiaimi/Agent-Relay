import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
const root=resolve(import.meta.dirname,'../.data/preview-site'),port=Number(process.env.PREVIEW_PORT||18804);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.webmanifest':'application/manifest+json'};
const server=createServer(async(req,res)=>{const url=new URL(req.url,'http://localhost');if(url.pathname==='/preview'){res.writeHead(302,{Location:'/preview/'});return res.end();}if(req.method!=='GET'||!url.pathname.startsWith('/preview/')){res.writeHead(404);return res.end();}const file=resolve(root,decodeURIComponent(url.pathname.slice(9))||'index.html');if(!file.startsWith(root+sep)){res.writeHead(404);return res.end();}try{const bytes=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(bytes);}catch{res.writeHead(404);res.end();}});
server.listen(port,'127.0.0.1',()=>console.log(`Preview http://127.0.0.1:${port}/preview/`));process.on('SIGINT',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
