import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID,createHash } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { RelayStore } from './store.js';
import { equalSecret, requireSecret, makeCookie, validCookie } from '../shared/security.js';
import { validateAction, type Host, type Session, type RelayEvent, type Action } from '../shared/protocol.js';
import {MediaStore,BRIDGE_FRAME_BYTES} from '../shared/media.js';
import {FileStore,MAX_UPLOAD_BYTES} from '../shared/files.js';

interface Options { dataDir: string; phoneToken: string; bridgeToken: string; publicOrigin?: string }
const staticFiles: Record<string,[string,string]> = {
  '/':['index.html','text/html; charset=utf-8'], '/app.js':['app.js','text/javascript; charset=utf-8'],
  '/message-text.js':['message-text.js','text/javascript; charset=utf-8'],
  '/timeline.js':['timeline.js','text/javascript; charset=utf-8'],
  '/attachments.js':['attachments.js','text/javascript; charset=utf-8'], '/drawer.js':['drawer.js','text/javascript; charset=utf-8'],
  '/style.css':['style.css','text/css; charset=utf-8'], '/chatgpt.css':['chatgpt.css','text/css; charset=utf-8'], '/theme.js':['theme.js','text/javascript; charset=utf-8'], '/glass.css':['glass.css','text/css; charset=utf-8'], '/glass-optics.css':['glass-optics.css','text/css; charset=utf-8'],
  '/glass-gpu.js':['glass-gpu.js','text/javascript; charset=utf-8'], '/glass-renderer.js':['glass-renderer.js','text/javascript; charset=utf-8'], '/glass-init.js':['glass-init.js','text/javascript; charset=utf-8'],
  '/vendor/markdown-it.umd.min.js':['vendor/markdown-it.umd.min.js','text/javascript; charset=utf-8'], '/vendor/purify.min.js':['vendor/purify.min.js','text/javascript; charset=utf-8'], '/vendor/highlight.min.js':['vendor/highlight.min.js','text/javascript; charset=utf-8'],
  '/wallpaper.jpg':['wallpaper.jpg','image/jpeg'], '/wallpaper-fallback.webp':['wallpaper-fallback.webp','image/webp'],
  '/manifest.webmanifest':['manifest.webmanifest','application/manifest+json'],
  '/icon.svg':['icon.svg','image/svg+xml'], '/apple-touch-icon.png':['apple-touch-icon.png','image/png'],
  '/icon-192.png':['icon-192.png','image/png'], '/icon-512.png':['icon-512.png','image/png']
};
const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); };
async function body(req: IncomingMessage): Promise<any> {
  let text='';
  for await (const chunk of req) { text+=chunk; if(Buffer.byteLength(text)>64_000) throw new Error('Request too large'); }
  return JSON.parse(text || '{}');
}
export function createRelay(options: Options) {
  requireSecret(options.phoneToken,'PHONE_TOKEN'); requireSecret(options.bridgeToken,'BRIDGE_TOKEN');
  if (equalSecret(options.phoneToken, options.bridgeToken)) throw new Error('Use separate phone and bridge secrets');
  const origin = options.publicOrigin && new URL(options.publicOrigin).origin;
  const secure = origin?.startsWith('https://');
  const store = new RelayStore(options.dataDir);
  const media=new MediaStore(options.dataDir,store.db);
  const files=new FileStore(options.dataDir,store.db);
  const mediaRequests=new Map<string,Promise<void>>();
  const bridges = new Map<string,WebSocket>();
  const viewers = new Set<ServerResponse>();
  const pending = new Map<string,{resolve:(value:any)=>void; reject:(err:Error)=>void; host:string; timer:NodeJS.Timeout}>();
  const attempts = new Map<string,{count:number; until:number}>();
  const auth = (req:IncomingMessage) => validCookie((req.headers.cookie ?? '').split(';').map(x=>x.trim()).find(x=>x.startsWith('relay_session='))?.slice(14) ?? '', options.phoneToken);
  function emit(type: string, data: any, seq?: number) {
    const message = `${seq ? `id: ${seq}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for(const res of viewers) { if(res.writableLength>1024*1024) res.destroy(); else res.write(message); }
  }
  function remote(host: string, action: Action): Promise<any> {
    const socket=bridges.get(host);
    if(!socket || socket.readyState!==WebSocket.OPEN) return Promise.reject(new Error('本地电脑离线，请上线后重试'));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(action.id);reject(new Error('电脑响应超时；操作不会自动重发，请检查会话状态'));},90_000);
      pending.set(action.id,{resolve,reject,host,timer});
      socket.send(JSON.stringify({type:'action',action}));
    });
  }
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url=new URL(req.url ?? '/', 'http://localhost');
      if(req.method==='GET' && url.pathname==='/healthz') return json(res,200,{ok:true});
      if(req.method==='GET' && staticFiles[url.pathname]) {
        const [file,mime]=staticFiles[url.pathname]; const content=await readFile(fileURLToPath(new URL(`../../web/${file}`,import.meta.url)));
        res.writeHead(200,{'Content-Type':mime}); return res.end(content);
      }
      if(req.method==='POST') {
        const expected=origin ?? `http://${req.headers.host}`;
        if(req.headers.origin!==expected || req.headers['sec-fetch-site']==='cross-site') return json(res,403,{error:'Origin rejected'});
        if(url.pathname!=='/api/uploads'&&!String(req.headers['content-type']).startsWith('application/json')) return json(res,415,{error:'JSON required'});
      }
      if(req.method==='POST' && url.pathname==='/api/login') {
        const ip=req.socket.remoteAddress ?? 'unknown'; const now=Date.now();
        if(attempts.size>10000) for(const [key,v] of attempts) if(v.until<now) attempts.delete(key);
        const entry=attempts.get(ip);
        if(entry && entry.until>now && entry.count>=5) return json(res,429,{error:'尝试次数过多，请十分钟后重试'});
        const value=await body(req);
        if(typeof value.token!=='string' || !equalSecret(value.token,options.phoneToken)) {
          attempts.set(ip,{count:entry && entry.until>now ? entry.count+1 : 1,until:now+600_000});
          return json(res,401,{error:'访问密钥不正确'});
        }
        attempts.delete(ip);
        res.setHeader('Set-Cookie',`relay_session=${makeCookie(options.phoneToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure ? '; Secure' : ''}`);
        return json(res,200,{ok:true});
      }
      if(!auth(req)) return json(res,401,{error:'请先登录'});
      if(req.method==='POST'&&url.pathname==='/api/uploads'){
        if(req.headers['content-type']!=='application/octet-stream')return json(res,415,{error:'请上传原始文件'});
        const hostId=url.searchParams.get('hostId')??'',sessionId=url.searchParams.get('sessionId'),projectId=url.searchParams.get('projectId'),name=url.searchParams.get('name')??'';
        const host=store.hosts().find(h=>h.id===hostId),session=sessionId?store.getSession(sessionId):undefined;
        if(!host||(sessionId?session?.hostId!==hostId:!host.projects.some(p=>p.id===projectId)))return json(res,404,{error:'请选择有效会话或项目'});
        if(!bridges.has(hostId))return json(res,409,{error:'电脑离线，请上线后上传'});
        const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>MAX_UPLOAD_BYTES)throw new Error('附件不能超过 16 MB');chunks.push(Buffer.from(chunk));}
        const bytes=Buffer.concat(chunks),scope=hostId+'|'+(sessionId??'project:'+projectId),file={id:randomUUID(),name,size,mime:'application/octet-stream',sha256:createHash('sha256').update(bytes).digest('hex')};
        const saved=files.put(scope,file,bytes);
        await remote(hostId,{id:randomUUID(),type:'upload',upload:{scope,file:saved,data:bytes.toString('base64')}});
        return json(res,200,{file:saved});
      }
      if(req.method==='GET'&&url.pathname.startsWith('/api/files/')){
        const sessionId=url.searchParams.get('sessionId')??'',session=store.getSession(sessionId);if(!session)return json(res,404,{error:'会话不存在'});
        const {file,bytes}=files.read(session.hostId+'|'+sessionId,url.pathname.slice('/api/files/'.length));
        res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
        res.writeHead(200,{'Content-Type':file.mime,'Content-Length':bytes.length,'Content-Disposition':(file.mime.startsWith('image/')?'inline':'attachment')+"; filename*=UTF-8''"+encodeURIComponent(file.name)});return res.end(bytes);
      }
      if(req.method==='POST' && url.pathname==='/api/logout') {
        res.setHeader('Set-Cookie',`relay_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`); return json(res,200,{ok:true});
      }
      if(req.method==='GET' && url.pathname==='/api/state') return json(res,200,{hosts:store.hosts().map(h=>({...h,online:bridges.has(h.id)})),sessions:store.sessions()});
      if(req.method==='GET'&&url.pathname.startsWith('/api/images/')){
        const id=url.pathname.slice('/api/images/'.length),sessionId=url.searchParams.get('sessionId')??'',session=store.getSession(sessionId);
        if(!session||!(/^[a-f0-9]{64}$/).test(id))return json(res,404,{error:'图片不存在'});
        let image=media.read(sessionId,id);
        if(!image){
          if(!bridges.has(session.hostId))return json(res,404,{error:'图片尚未同步，需本地电脑上线后读取'});
          const key=sessionId+':'+id;let wait=mediaRequests.get(key);
          if(!wait){wait=remote(session.hostId,{id:randomUUID(),type:'asset',sessionId,assetId:id}).then(payload=>{if(payload?.id!==id)throw new Error('Image ID mismatch');media.putPayload(sessionId,payload);}).finally(()=>{mediaRequests.delete(key);});mediaRequests.set(key,wait);}
          await wait;image=media.read(sessionId,id);
        }
        if(!image)return json(res,404,{error:'图片已不存在或无法读取'});
        res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
        res.writeHead(200,{'Content-Type':image.mime,'Content-Length':image.bytes.length,'Cache-Control':'private, max-age=3600','Content-Disposition':"inline; filename*=UTF-8''"+encodeURIComponent(image.name)});return res.end(image.bytes);
      }
      if(req.method==='GET'&&url.pathname==='/api/models'){
        const hostId=url.searchParams.get('hostId')??'',provider=url.searchParams.get('provider');
        if(!store.hosts().some(h=>h.id===hostId)||!['codex','claude'].includes(provider??''))return json(res,400,{error:'请选择设备和 Agent'});
        return json(res,200,await remote(hostId,{id:randomUUID(),type:'models',provider:provider as 'codex'|'claude'}));
      }
      if(req.method==='GET'&&url.pathname==='/api/commands'){
        const id=url.searchParams.get('sessionId')??'',s=store.getSession(id);if(!s)return json(res,404,{error:'会话不存在'});
        return json(res,200,await remote(s.hostId,{id:randomUUID(),type:'commands',sessionId:id}));
      }
      if(req.method==='GET' && url.pathname==='/api/events') {
        res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'}); res.write('retry: 1500\n\n');
        const after=Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? store.latestSeq());
        if(!Number.isSafeInteger(after) || after<0) return res.end();
        const backlog=store.events(after,1001);
        if(backlog.length>1000) res.write(`event: reset\ndata: {}\n\n`);
        else for(const row of backlog) res.write(`id: ${row.seq}\nevent: event\ndata: ${JSON.stringify(row.event)}\n\n`);
        viewers.add(res);
        const timer=setInterval(()=>{if(!auth(req)) return res.end(); res.write(': heartbeat\n\n');},20_000);
        req.on('close',()=>{clearInterval(timer);viewers.delete(res);}); return;
      }
      if(req.method==='GET' && url.pathname==='/api/history') {
        const id=url.searchParams.get('sessionId') ?? ''; const s=store.getSession(id);
        if(!s) return json(res,404,{error:'会话不存在'});
        const cursor=url.searchParams.has('cursor') ? Number(url.searchParams.get('cursor')) : undefined;
        if(cursor!==undefined && (!Number.isSafeInteger(cursor)||cursor<0)) return json(res,400,{error:'Invalid cursor'});
        let page; let cached=false;
        try { page=await remote(s.hostId,{id:randomUUID(),type:'history',sessionId:id,cursor}); store.cache(id,cursor,page); }
        catch(err) { page=store.cached(id,cursor); if(!page) throw err; cached=true; }
        return json(res,200,{...page,cached,session:store.getSession(id),events:cursor===undefined ? store.sessionEvents(id) : []});
      }
      if(req.method==='POST' && url.pathname==='/api/actions') {
        const value=await body(req); const action=validateAction(value);
        if(action.type==='history'||action.type==='asset'||action.type==='models'||action.type==='commands'||action.type==='upload') return json(res,400,{error:'Use the dedicated endpoint'});
        const host=action.type==='start' ? value.hostId : store.getSession(action.sessionId!)?.hostId;
        if(typeof host!=='string' || !store.hosts().some(h=>h.id===host)) return json(res,404,{error:'电脑或会话不存在'});
        if(!bridges.has(host)) return json(res,409,{error:'本地电脑离线'});
        const scope=host+'|'+(action.type==='start'?'project:'+action.projectId:action.sessionId);
        files.files(scope,action.attachmentIds);
        const prior=store.beginAction(action.id,host,action);
        if(!prior.fresh) return json(res,prior.result ? 200 : 409,prior.result ?? {error:'操作已接受，结果尚未确认；不会重复执行'});
        try { const result=await remote(host,action);if(result.sessionId)for(const id of action.attachmentIds??[])files.link(scope,host+'|'+result.sessionId,id); store.finishAction(action.id,result); return json(res,200,result); }
        catch(err) { const result={error:(err as Error).message}; store.finishAction(action.id,result); return json(res,409,result); }
      }
      json(res,404,{error:'Not found'});
    } catch(err) { if(!res.headersSent) json(res,400,{error:(err as Error).message}); else res.end(); }
  });
  const wss=new WebSocketServer({noServer:true,maxPayload:BRIDGE_FRAME_BYTES,perMessageDeflate:false});
  server.on('upgrade',(req,socket,head)=>{
    if(req.url!=='/bridge' || req.headers.origin || !equalSecret(req.headers.authorization ?? '',`Bearer ${options.bridgeToken}`)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));
  });
  wss.on('connection',(ws:WebSocket)=>{
    let hostId=''; let alive=true;
    const helloTimer=setTimeout(()=>ws.close(1008,'Hello required'),5000);
    ws.on('pong',()=>{alive=true;});
    const heartbeat=setInterval(()=>{if(!alive) return ws.terminate();alive=false;ws.ping();},25_000);
    ws.on('message',raw=>{
      try {
        const msg=JSON.parse(raw.toString());
        if(msg.type==='hello' && !hostId) {
          if(!/^[a-zA-Z0-9_-]{1,60}$/.test(msg.host?.id ?? '') || typeof msg.host.name!=='string' || msg.host.name.length>100 || !Array.isArray(msg.host.projects) || msg.host.projects.length>100) throw new Error('Invalid host');
          if(bridges.has(msg.host.id)) throw new Error('Host already connected');
          hostId=msg.host.id; clearTimeout(helloTimer);bridges.set(hostId,ws);
          const host:Host={id:hostId,name:msg.host.name,hostname:typeof msg.host.hostname==='string'?msg.host.hostname.slice(0,100):undefined,platform:typeof msg.host.platform==='string'?msg.host.platform.slice(0,80):undefined,projects:msg.host.projects,online:true,lastSeen:Date.now()}; store.host(host); emit('state',{});
          ws.send(JSON.stringify({type:'welcome'}));return;
        }
        if(!hostId) throw new Error('Hello required');
        if(msg.type==='asset.cache'){
          if(typeof msg.jobId!=='string'||store.getSession(msg.sessionId)?.hostId!==hostId)throw new Error('Invalid image owner');
          try{media.putPayload(msg.sessionId,msg.asset);ws.send(JSON.stringify({type:'asset.ack',jobId:msg.jobId}));}catch{ws.send(JSON.stringify({type:'asset.ack',jobId:msg.jobId,error:'Image cache rejected or storage unavailable'}));}
        }else if(msg.type==='history.cache'){
          if(typeof msg.jobId!=='string'||typeof msg.sessionId!=='string'||store.getSession(msg.sessionId)?.hostId!==hostId||!Array.isArray(msg.page?.messages)||msg.page.messages.length>50)throw new Error('Invalid history cache');
          store.cache(msg.sessionId,msg.cursor,msg.page);ws.send(JSON.stringify({type:'history.ack',jobId:msg.jobId}));
        }else if(msg.type==='sync'){
          const prior=store.hosts().find(h=>h.id===hostId)!;const s=msg.sync;
          if(!s||!['syncing','complete','partial'].includes(s.state)||![s.done,s.total,s.pages,s.errors].every(Number.isSafeInteger))throw new Error('Invalid sync state');
          store.host({...prior,sync:s,lastSeen:Date.now()});
          if(s.state!=='syncing'||s.done%20===0)emit('state',{});
        }else if(msg.type==='projects'){
          if(!Array.isArray(msg.projects)||msg.projects.length>500||msg.projects.some((p:any)=>typeof p.id!=='string'||typeof p.name!=='string'||typeof p.path!=='string'||(p.roots!==undefined&&(!Array.isArray(p.roots)||p.roots.length>100||p.roots.some((r:unknown)=>typeof r!=='string')))))throw new Error('Invalid projects');
          const prior=store.hosts().find(h=>h.id===hostId)!;store.host({...prior,projects:msg.projects,lastSeen:Date.now()});emit('state',{});
        }else if(msg.type==='sessions') {
          if(!Array.isArray(msg.sessions) || msg.sessions.length>2000) throw new Error('Invalid session batch');
          for(const session of msg.sessions as Session[]) {
            if(session.hostId!==hostId || session.id!==`${hostId}:${session.provider}:${session.nativeId}` || !['codex','claude'].includes(session.provider) || typeof session.updatedAt!=='number') throw new Error('Invalid session owner');
            store.session(session);
          }
          emit('state',{});
        } else if(msg.type==='event') {
          const e=msg.event as RelayEvent;
          if(e.hostId!==hostId || !e.sessionId?.startsWith(hostId+':') || !store.getSession(e.sessionId) || typeof e.id!=='string') throw new Error('Invalid event owner');
          const seq=store.event(e);if(seq) emit('event',e,seq);
          ws.send(JSON.stringify({type:'ack',id:e.id}));
        } else if(msg.type==='result') {
          const wait=pending.get(msg.id);
          if(wait?.host===hostId) {clearTimeout(wait.timer);pending.delete(msg.id);msg.error ? wait.reject(new Error(msg.error)) : wait.resolve(msg.result);}
        }
      } catch(err) { ws.close(1008,(err as Error).message.slice(0,120)); }
    });
    ws.on('close',()=>{
      clearTimeout(helloTimer);clearInterval(heartbeat);
      if(bridges.get(hostId)===ws) {bridges.delete(hostId);emit('state',{});}
      for(const [id,p] of pending) if(p.host===hostId) {clearTimeout(p.timer);p.reject(new Error('电脑连接中断；操作不会自动重发'));pending.delete(id);}
    });
    ws.on('error',()=>{});
  });
  return {server,store, async close(){for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Relay stopping'));}pending.clear();for(const res of viewers)res.end();for(const ws of wss.clients)ws.terminate();wss.close();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}};
}
