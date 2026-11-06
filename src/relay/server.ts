import {StudioRepositories} from './studio-repository.js';
import {studioSnapshot} from './studio-snapshot.js';
import {StudioMainline} from './studio-mainline.js';
import {StudioPlaytests} from './studio-playtests.js';
import {QuestionState} from './question-state.js';
import {streamStudioVideo} from './studio-video.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID,createHash } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { RelayStore } from './store.js';
import { equalSecret, requireSecret, makeCookie, validCookie } from '../shared/security.js';
import { validateAction, type Host, type Session, type RelayEvent, type Action } from '../shared/protocol.js';
import {BRIDGE_FRAME_BYTES,MediaStore,imageBytes} from '../shared/media.js';
import {FileStore,MAX_UPLOAD_BYTES,uploadId} from '../shared/files.js';
import {validDirectSdp} from '../shared/direct.js';
import {turnCredentials,type TurnConfig} from './turn.js';
import {serveVideo} from './video.js';
import {ImagePreviews} from './previews.js';
import {StudioPreviews} from './studio-previews.js';
import {Brainstorms} from './brainstorm.js';
import {Studio} from './studio.js';
import {questionReplyId} from '../shared/async-answers.js';
import {QuestionAnswers} from './question-answers.js';
import {StudioAttention} from './studio-attention.js';
import {StudioAutoAnswers} from './studio-auto-answers.js';
import {StudioFollowups} from './studio-followups.js';
import {RelayRepairs} from './repairs.js';

interface Options { dataDir: string; phoneToken: string; bridgeToken: string; publicOrigin?: string;turn?:TurnConfig }
function publicAgents(value:any){if(value===undefined)return undefined;if(!Array.isArray(value)||value.length>32)throw Error('Invalid agent catalog');return value.map(a=>{if(!/^[a-zA-Z0-9_-]{1,60}$/.test(a.id)||!['codex','claude','api'].includes(a.provider)||typeof a.name!=='string'||a.name.length>80)throw Error('Invalid agent');return {id:a.id,provider:a.provider,name:a.name,configured:a.configured!==false,tools:a.tools===true,revision:typeof a.revision==='string'?a.revision.slice(0,64):undefined};});}
const staticFiles: Record<string,[string,string]> = {
  '/studio-delivery-media.js':['studio-delivery-media.js','text/javascript; charset=utf-8'],
  '/conversation-cache.js':['conversation-cache.js','text/javascript; charset=utf-8'],
  '/studio-sidebar.js':['studio-sidebar.js','text/javascript; charset=utf-8'],
  '/studio-playtests.js':['studio-playtests.js','text/javascript; charset=utf-8'],
  '/studio-mainline.js':['studio-mainline.js','text/javascript; charset=utf-8'],
  '/studio-startup.js':['studio-startup.js','text/javascript; charset=utf-8'],
  '/studio-stage-guide.js':['studio-stage-guide.js','text/javascript; charset=utf-8'],
  '/studio-attention.js':['studio-attention.js','text/javascript; charset=utf-8'],
  '/studio-api.js':['studio-api.js','text/javascript; charset=utf-8'],
  '/studio-repository.js':['studio-repository.js','text/javascript; charset=utf-8'],
  '/studio-migration.js':['studio-migration.js','text/javascript; charset=utf-8'],
  '/studio-repairs.js':['studio-repairs.js','text/javascript; charset=utf-8'],
  '/studio-task-focus.js':['studio-task-focus.js','text/javascript; charset=utf-8'],
  '/studio-guidance.js':['studio-guidance.js','text/javascript; charset=utf-8'],
  '/workspace-shell.js':['workspace-shell.js','text/javascript; charset=utf-8'],
  '/workspace-shell.css':['workspace-shell.css','text/css; charset=utf-8'],
  '/studio':['index.html','text/html; charset=utf-8'],
  '/studio-brainstorm.js':['studio-brainstorm.js','text/javascript; charset=utf-8'],
  '/refresh.js':['refresh.js','text/javascript; charset=utf-8'],
  '/diagrams.js':['diagrams.js','text/javascript; charset=utf-8'],
  '/studio-review.js':['studio-review.js','text/javascript; charset=utf-8'],
  '/studio-viewport.js':['studio-viewport.js','text/javascript; charset=utf-8'],
  '/studio-avatar.js':['studio-avatar.js','text/javascript; charset=utf-8'],
  '/workspace-theme.css':['workspace-theme.css','text/css; charset=utf-8'],
  '/workspace-nav.css':['workspace-nav.css','text/css; charset=utf-8'],
  '/studio-scene.js':['studio-scene.js','text/javascript; charset=utf-8'],
  '/studio-chat.js':['studio-chat.js','text/javascript; charset=utf-8'],
  '/studio-media.js':['studio-media.js','text/javascript; charset=utf-8'],
  '/studio.js':['studio.js','text/javascript; charset=utf-8'],
  '/studio-projects.js':['studio-projects.js','text/javascript; charset=utf-8'],
  '/studio.css':['studio.css','text/css; charset=utf-8'],
  '/agent-ui.js':['agent-ui.js','text/javascript; charset=utf-8'],
  '/i18n.js':['i18n.js','text/javascript; charset=utf-8'],
  '/':['index.html','text/html; charset=utf-8'], '/app.js':['app.js','text/javascript; charset=utf-8'],
  '/message-text.js':['message-text.js','text/javascript; charset=utf-8'],
  '/session-settings.js':['session-settings.js','text/javascript; charset=utf-8'],
    '/composer.js':['composer.js','text/javascript; charset=utf-8'],
  '/timeline.js':['timeline.js','text/javascript; charset=utf-8'],
  '/operations.js':['operations.js','text/javascript; charset=utf-8'],
  '/video.js':['video.js','text/javascript; charset=utf-8'],
  '/direct.js':['direct.js','text/javascript; charset=utf-8'],
  '/questions.js':['questions.js','text/javascript; charset=utf-8'],
  '/attachments.js':['attachments.js','text/javascript; charset=utf-8'], '/drawer.js':['drawer.js','text/javascript; charset=utf-8'],
  '/style.css':['style.css','text/css; charset=utf-8'], '/chatgpt.css':['chatgpt.css','text/css; charset=utf-8'], '/theme.js':['theme.js','text/javascript; charset=utf-8'], '/glass.css':['glass.css','text/css; charset=utf-8'], '/glass-optics.css':['glass-optics.css','text/css; charset=utf-8'],
  '/glass-gpu.js':['glass-gpu.js','text/javascript; charset=utf-8'], '/glass-renderer.js':['glass-renderer.js','text/javascript; charset=utf-8'], '/glass-init.js':['glass-init.js','text/javascript; charset=utf-8'],
  '/vendor/mermaid.tiny.js':['vendor/mermaid.tiny.js','text/javascript; charset=utf-8'],
  '/vendor/markdown-it.umd.min.js':['vendor/markdown-it.umd.min.js','text/javascript; charset=utf-8'], '/vendor/purify.min.js':['vendor/purify.min.js','text/javascript; charset=utf-8'], '/vendor/highlight.min.js':['vendor/highlight.min.js','text/javascript; charset=utf-8'],
  '/wallpaper.jpg':['wallpaper.jpg','image/jpeg'], '/wallpaper-fallback.webp':['wallpaper-fallback.webp','image/webp'],
  '/manifest.webmanifest':['manifest.webmanifest','application/manifest+json'],
  '/icon.svg':['icon.svg','image/svg+xml'], '/apple-touch-icon.png':['apple-touch-icon.png','image/png'],
  '/icon-192.png':['icon-192.png','image/png'], '/icon-512.png':['icon-512.png','image/png']
};
const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); };
async function body(req: IncomingMessage,limit=64_000): Promise<any> {
  let text='';
  for await (const chunk of req) { text+=chunk; if(Buffer.byteLength(text)>limit) throw new Error('Request too large'); }
  return JSON.parse(text || '{}');
}
export function createRelay(options: Options) {
  const uiRevision=createHash('sha256').update(['studio-repository.js','studio-migration.js','studio-mainline.js','studio-startup.js','studio-playtests.js','studio-stage-guide.js','studio.js','studio-sidebar.js','studio-scene.js','studio-guidance.js','studio-task-focus.js','studio-repairs.js','studio-attention.js','studio.css','studio.html','workspace-shell.js','app.js'].map(file=>readFileSync(fileURLToPath(new URL(`../../web/${file}`,import.meta.url)))).reduce((all,part)=>Buffer.concat([all,part]),Buffer.alloc(0))).digest('hex');
  if(options.turn)turnCredentials(options.turn);
  requireSecret(options.phoneToken,'PHONE_TOKEN'); requireSecret(options.bridgeToken,'BRIDGE_TOKEN');
  if (equalSecret(options.phoneToken, options.bridgeToken)) throw new Error('Use separate phone and bridge secrets');
  const origin = options.publicOrigin && new URL(options.publicOrigin).origin;
  const secure = origin?.startsWith('https://');
  const store = new RelayStore(options.dataDir);
  const files=new FileStore(options.dataDir,store.db);
  const questionState=new QuestionState(store);
  const media=new MediaStore(options.dataDir,store.db);
  const previews=new ImagePreviews(options.dataDir);
  const studioPreviews=new StudioPreviews(store.db,media);
  const assetRequests=new Map<string,Promise<void>>(),assetActive=new Set<Promise<void>>();
  // Coalesce duplicate cold reads and bound concurrent large frames on the bridge.
  function assetRequest(key:string,load:()=>Promise<void>){
    const prior=assetRequests.get(key);if(prior)return prior;
    if(assetRequests.size>=64)throw new Error('资源请求较多，请稍后重试');
    const job=(async()=>{
      while(assetActive.size>=3)await Promise.race(assetActive).catch(()=>{});
      const active=load();assetActive.add(active);try{await active;}finally{assetActive.delete(active);}
    })().finally(()=>assetRequests.delete(key));assetRequests.set(key,job);return job;
  }
  const negotiations=new Map<string,number>();
  const bridges = new Map<string,WebSocket>();
  const viewers = new Set<ServerResponse>();
  const brainstormBridges=new Map<string,WebSocket>();
  const launcherBridges=new Map<string,WebSocket>();
  const pending = new Map<string,{socket:WebSocket;resolve:(value:any)=>void; reject:(err:Error)=>void; host:string; timer:NodeJS.Timeout}>();
  const attempts = new Map<string,{count:number; until:number}>();
  const auth = (req:IncomingMessage) => validCookie((req.headers.cookie ?? '').split(';').map(x=>x.trim()).find(x=>x.startsWith('relay_session='))?.slice(14) ?? '', options.phoneToken);
  function emit(type: string, data: any, seq?: number) {
    const message = `${seq ? `id: ${seq}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for(const res of viewers) { if(res.writableLength>1024*1024) res.destroy(); else res.write(message); }
  }
  function remote(host: string, action: Action,timeoutMs=90_000): Promise<any> {
    try{validateAction(action);}catch(e){return Promise.reject(new Error('设备指令未发送：'+(e as Error).message));}
    const questionRevision=action.sessionId?questionState.revision(action.sessionId):0;
    const projectId=action.projectId??(action.sessionId?store.getSession(action.sessionId)?.projectId:undefined),uploadScope=action.upload?.scope.slice(host.length+1)??'';
    const brain=action.type==='prepare-brainstorm'||projectId?.startsWith('brainstorm-')||uploadScope.startsWith('project:brainstorm-')||store.getSession(uploadScope)?.projectId?.startsWith('brainstorm-');
    const socket=action.type==='studio-launch'?launcherBridges.get(host):brain?(brainstormBridges.get(host)??bridges.get(host)):bridges.get(host);
    if(!socket || socket.readyState!==WebSocket.OPEN) return Promise.reject(new Error('本地电脑离线，请上线后重试'));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(action.id);reject(new Error('电脑响应超时；操作不会自动重发，请检查会话状态'));},timeoutMs);
      pending.set(action.id,{resolve,reject,host,timer,socket});
      socket.send(JSON.stringify({type:'action',action}));
    }).then(result=>action.type==='history'?questionState.snapshot(action.sessionId!,result,questionRevision):result);
  }
  const inspectVisual=async(hostId:string,sessionId:string,path:string)=>{
    if(!store.hosts().find(h=>h.id===hostId)?.capabilities?.studioArtifacts)throw Error('请升级工作电脑连接程序以读取本轮原画');
    const knownHash=studioPreviews.knownHash(sessionId,path);
    let payload=await remote(hostId,{id:randomUUID(),type:'studio-artifact',sessionId,artifactPath:path,...knownHash?{artifactHash:knownHash}:{}});
    if(payload?.unchanged===true){if(!knownHash||payload.id!==knownHash)throw Error('原画版本核对不匹配');payload=media.payload(sessionId,knownHash);}
    const bytes=imageBytes(payload);await previews.image(bytes,payload.mime);media.putPayload(sessionId,payload);return {payload,sha256:payload.id};
  };
  const studio=new Studio(store,remote,host=>bridges.get(host)?.readyState===WebSocket.OPEN,()=>emit('studio',{}),files,inspectVisual);
  const repositories=new StudioRepositories(store,studio,remote,()=>emit('studio',{}));
  const questionAnswers=new QuestionAnswers(store,studio,remote,event=>{const session=questionState.refresh(event.sessionId!);if(session)emit('sessions',{sessions:[session]});emit('event',event,store.latestSeq());});
  const repairs=new RelayRepairs(store,studio,remote,host=>bridges.get(host)?.readyState===WebSocket.OPEN,()=>emit('studio',{}),options.publicOrigin,uiRevision);
  const attention=new StudioAttention(store,studio,remote,event=>emit('event',event,store.latestSeq()),host=>bridges.has(host),id=>repairs.sessionsFor(id));
  // Human and automatic replies share the same durable delivery journal.
  async function submitAnswer(host:string,action:Action,automatic=false,reason=''){
    const prior=store.beginAction(action.id,host,action);
    if(!prior.fresh){if(prior.result)return prior.result;throw Error('操作已接受，结果尚未确认；不会重复执行');}
    const card=questionAnswers.card(action),startedAt=Date.now();
    try{
      if(automatic&&card?.status!=='pending')throw Error('问题已回答或关闭');
      let result:any;try{result=await remote(host,action);}catch(error){result=await questionAnswers.fallback(host,action,error,automatic);}
      if(automatic&&result?.queued&&card?.source.startsWith('async:')){
        // Reuse the queued answer through the established active-turn steering
        // route. Unknown steering retains the queue and is never sent twice.
        const steer:Action={id:randomUUID(),type:'steer',sessionId:action.sessionId,queuedId:result.replyActionId??questionReplyId(action.sessionId!,card.source)};
        store.beginAction(steer.id,host,steer);
        try{const receipt=await remote(host,steer);store.finishAction(steer.id,receipt);if(receipt.steered===true)result={...result,queued:false};}
        catch(error){store.finishAction(steer.id,{error:(error as Error).message,uncertain:true});}
      }
      if(automatic)result={...result,automatic:true,decisionReason:reason};
      questionAnswers.confirmed(host,action,card,result,startedAt);store.finishAction(action.id,result);return result;
    }catch(error){store.finishAction(action.id,{error:(error as Error).message});throw error;}
  }
  const autoAnswers=new StudioAutoAnswers(store,studio,attention,remote,(host,action,reason)=>submitAnswer(host,action,true,reason),host=>bridges.get(host)?.readyState===WebSocket.OPEN,()=>emit('studio',{}));
  const followups=new StudioFollowups(store,studio,remote,host=>bridges.get(host)?.readyState===WebSocket.OPEN);
  const mainline=new StudioMainline(store,studio,remote,host=>bridges.get(host)?.readyState===WebSocket.OPEN,()=>emit('studio',{}));
  const playtests=new StudioPlaytests(store,studio,remote,host=>launcherBridges.get(host)?.readyState===WebSocket.OPEN,()=>emit('studio',{}));
  const brains=new Brainstorms(store,studio,remote,host=>bridges.get(host)?.readyState===WebSocket.OPEN,()=>emit('studio',{}),files,media);
  const sendStudioSnapshot=studioSnapshot();
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url=new URL(req.url ?? '/', 'http://localhost');
      if(req.method==='GET' && url.pathname==='/healthz') return json(res,200,{ok:true});
      if(req.method==='GET' && staticFiles[url.pathname]) {
        const embedded=url.pathname==='/studio'&&url.searchParams.get('embedded')==='1';
        if(embedded){res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Content-Security-Policy',String(res.getHeader('Content-Security-Policy')).replace("frame-ancestors 'none'","frame-ancestors 'self'"));}
        const [mapped,mime]=staticFiles[url.pathname],file=embedded?'studio.html':mapped; const content=await readFile(fileURLToPath(new URL(`../../web/${file}`,import.meta.url)));
        res.writeHead(200,{'Content-Type':mime}); return res.end(file==='studio.html'?content.toString().replace('<head>','<head><meta name="relay-ui-version" content="'+uiRevision+'">'):content);
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
      if(req.method==='GET'&&url.pathname==='/api/studio'){
        const state=studio.state(),text=JSON.stringify({...state,features:{...state.features,repairVersion:uiRevision},brainstorms:brains.list()});return await sendStudioSnapshot(req,res,text);
      }
      if(req.method==='GET'&&url.pathname==='/api/studio/attention')return json(res,200,attention.read(url.searchParams.get('runId')??'',url.searchParams.get('refresh')==='1'));
      if(req.method==='GET'&&url.pathname==='/api/studio/repairs')return json(res,200,repairs.state(url.searchParams.get('runId')??'',url.searchParams.get('taskId')||undefined));
      if(req.method==='POST'&&url.pathname==='/api/studio/repairs')return json(res,202,repairs.create(await body(req,16000)));
      if(req.method==='POST'&&url.pathname==='/api/studio/repairs/bind')return json(res,200,{repair:repairs.bind(await body(req))});
      if(req.method==='POST'&&url.pathname==='/api/studio/repairs/resolve')return json(res,200,{repair:repairs.resolve(await body(req))});
      if(req.method==='GET'&&url.pathname==='/api/studio/channels')return json(res,200,studio.channels(url.searchParams.get('runId')??''));
      if(req.method==='GET'&&url.pathname==='/api/studio/skip-state')return json(res,200,studio.skipState(url.searchParams.get('runId')??'',url.searchParams.get('taskId')??''));
      if(req.method==='POST'&&url.pathname==='/api/studio/chat/settings')return json(res,200,await studio.chatSettings(await body(req)));
      if(req.method==='POST'&&url.pathname==='/api/studio/brainstorm')return json(res,200,{topic:await brains.create(await body(req))});
      if(req.method==='GET'&&url.pathname==='/api/studio/brainstorm')return json(res,200,brains.detail(url.searchParams.get('topicId')??''));
      if(req.method==='POST'&&url.pathname==='/api/studio/brainstorm/send')return json(res,200,await brains.send(await body(req)));
      if(req.method==='POST'&&url.pathname==='/api/studio/brainstorm/settings')return json(res,200,await brains.settings(await body(req)));
      if(req.method==='POST'&&url.pathname==='/api/studio/brainstorm/launch')return json(res,200,await brains.launch(await body(req)));
      if(req.method==='POST'&&url.pathname==='/api/studio/project')return json(res,200,{project:studio.saveProject(await body(req,256_000))});
      if(req.method==='POST'&&url.pathname==='/api/studio/toolchain')return json(res,200,{project:studio.saveToolchain(await body(req))});
      if(req.method==='POST'&&url.pathname==='/api/studio/run')return json(res,200,{run:studio.createRun(await body(req))});
      if(req.method==='GET'&&url.pathname==='/api/studio/mainline')return json(res,200,{jobs:mainline.list(url.searchParams.get('runId')??'')});
      if(req.method==='POST'&&url.pathname==='/api/studio/mainline')return json(res,200,{job:await (async()=>{const v=await body(req);return v.op==='recover'?mainline.recover(v):mainline.start(v);})()});
      if(req.method==='GET'&&url.pathname==='/api/studio/playtests')return json(res,200,playtests.list(url.searchParams.get('runId')??''));
      if(req.method==='POST'&&url.pathname==='/api/studio/playtests/start')return json(res,200,{launch:await playtests.start(await body(req))});
      if(req.method==='GET'&&url.pathname==='/api/studio/playtests/status')return json(res,200,{launch:await playtests.status(url.searchParams.get('runId')??'',url.searchParams.get('id')??'')});
      if(req.method==='POST'&&url.pathname==='/api/studio/migrate')return json(res,202,{run:studio.migrate(await body(req))});
      if(req.method==='POST'&&url.pathname==='/api/studio/command')return json(res,200,{run:await studio.command(await body(req))});
      if(req.method==='POST'&&url.pathname==='/api/studio/project/repository')return json(res,200,{project:studio.saveRepository(await body(req))});
      if(req.method==='POST'&&url.pathname==='/api/studio/repository')return json(res,202,repositories.start(await body(req,256000)));
      if(req.method==='GET'&&url.pathname==='/api/studio/repository/job')return json(res,200,repositories.job(url.searchParams.get('id')??''));
      if(req.method==='GET'&&url.pathname==='/api/studio/repository/history')return json(res,200,{conversations:repositories.conversations(url.searchParams.get('runId')??''),media:repositories.media(url.searchParams.get('runId')??'')});
      if(['GET','HEAD'].includes(req.method??'')&&url.pathname==='/api/studio/repository/file'){const target=repositories.mediaTarget(url.searchParams.get('runId')??'',Number(url.searchParams.get('index')));if(!target.fileId)throw Error('No reference file');const payload=await remote(target.hostId,{id:randomUUID(),type:'file',sessionId:target.sessionId,fileId:target.fileId}),bytes=Buffer.from(payload.data??'','base64');if(payload.file?.sha256!==target.sha256||createHash('sha256').update(bytes).digest('hex')!==target.sha256)throw Error('Reference file checksum mismatch');if(payload.file.mime.startsWith('video/')){serveVideo(req,res,bytes,payload.file.mime,target.sha256!,'workstation-stream');return;}res.writeHead(200,{'Content-Type':payload.file.mime,'Content-Length':bytes.length,'Cache-Control':'private, no-store','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(payload.file.name)});res.end(bytes);return;}
      if(req.method==='GET'&&url.pathname==='/api/studio/repository/image'){const target=repositories.mediaTarget(url.searchParams.get('runId')??'',Number(url.searchParams.get('index'))),payload=await remote(target.hostId,{id:randomUUID(),type:'studio-artifact',sessionId:target.sessionId,artifactPath:target.path}),bytes=imageBytes(payload);res.writeHead(200,{'Content-Type':payload.mime,'Content-Length':bytes.length,'Cache-Control':'private, no-store'});res.end(bytes);return;}
      if(['GET','HEAD'].includes(req.method??'')&&url.pathname==='/api/studio/repository/video'){try{await streamStudioVideo(req,res,repositories.mediaTarget(url.searchParams.get('runId')??'',Number(url.searchParams.get('index'))),remote);}catch(error){if(res.headersSent)res.destroy();else throw error;}return;}
      if(['GET','HEAD'].includes(req.method??'')&&url.pathname==='/api/studio/video'){const target=studio.visualArtifact(url.searchParams.get('runId')??'',url.searchParams.get('taskId')??'',Number(url.searchParams.get('index')??'-1'),'video');try{await streamStudioVideo(req,res,target,remote);}catch(error){if(res.headersSent)res.destroy();else throw error;}return;}
      if(req.method==='GET'&&url.pathname==='/api/studio/artifact'){
        const target=studio.visualArtifact(url.searchParams.get('runId')??'',url.searchParams.get('taskId')??'',Number(url.searchParams.get('index')??'-1'));
        const run=studio.runs().find(r=>r.id===url.searchParams.get('runId'))!,task=[run.planner,...run.tasks,...run.delivery?[run.delivery]:[]].find(t=>t.id===url.searchParams.get('taskId'))!,isPreview=url.searchParams.get('preview')==='1';
        const key=JSON.stringify([run.id,task.id,task.actionId,task.finishedAt,run.tasks.find(t=>t.kind==='visual-review')?.reviewId,target.sessionId,target.path]);
        const image=await studioPreviews.get(key,target.sessionId,async()=>{
          let value:{payload:any;sha256:string}|undefined;
          await assetRequest('studio-preview:'+key,async()=>{value=await inspectVisual(target.hostId,target.sessionId,target.path);});
          // Coalescing is owned by StudioPreviews; the limiter shares the
          // existing bridge budget with other large media reads.
          const payload=value!.payload;return {bytes:imageBytes(payload),mime:payload.mime,name:payload.name,sha256:payload.id};
        },!isPreview||url.searchParams.get('refresh')==='1');
        const preview=isPreview?await previews.image(image.bytes,image.mime):{bytes:image.bytes,mime:image.mime,hash:image.sha256};
        res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");res.writeHead(200,{'Content-Type':preview.mime,'Content-Length':preview.bytes.length,'X-Asset-Source':image.source,'X-Content-Sha256':preview.hash,'X-Visual-Sha256':image.sha256,'Content-Disposition':"inline; filename*=UTF-8''"+encodeURIComponent(image.name)});return res.end(preview.bytes);
      }
      if(req.method==='POST'&&url.pathname==='/api/studio/guidance')return json(res,200,await studio.guideTask(await body(req)));
      if(req.method==='POST'&&url.pathname==='/api/studio/chat')return json(res,200,await studio.chat(await body(req)));
      if(req.method==='GET'&&url.pathname==='/api/studio/group')return json(res,200,studio.group(url.searchParams.get('runId')??'',url.searchParams.get('before')??undefined));
      if(req.method==='POST'&&url.pathname==='/api/studio/group')return json(res,200,await studio.groupChat(await body(req)));
      if(req.method==='GET'&&url.pathname.startsWith('/api/studio/files/')){
        const result=studio.file(url.searchParams.get('runId')??'',url.pathname.slice('/api/studio/files/'.length));
        res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");res.writeHead(200,{'Content-Type':result.file.mime,'Content-Length':result.bytes.length,'X-Content-Sha256':result.file.sha256,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(result.file.name)});return res.end(result.bytes);
      }
      if(req.method==='POST'&&url.pathname==='/api/uploads'){
        if(req.headers['content-type']!=='application/octet-stream')return json(res,415,{error:'请上传原始文件'});
        const hostId=url.searchParams.get('hostId')??'',sessionId=url.searchParams.get('sessionId'),projectId=url.searchParams.get('projectId'),name=url.searchParams.get('name')??'',id=url.searchParams.get('id')??randomUUID();
        if(Boolean(sessionId)===Boolean(projectId)||!uploadId.test(id))return json(res,400,{error:'无效附件或目标'});
        const host=store.hosts().find(h=>h.id===hostId),session=sessionId?store.getSession(sessionId):undefined;
        if(!host||(sessionId?session?.hostId!==hostId:!host.projects.some(p=>p.id===projectId)))return json(res,404,{error:'请选择有效会话或项目'});
        if(!bridges.has(hostId))return json(res,409,{error:'电脑离线，请上线后上传'});
        const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>MAX_UPLOAD_BYTES)throw new Error('附件不能超过 16 MB');chunks.push(Buffer.from(chunk));}
        const bytes=Buffer.concat(chunks),scope=hostId+'|'+(sessionId??'project:'+projectId),file={id,name,size,mime:'application/octet-stream',sha256:createHash('sha256').update(bytes).digest('hex')};
        const saved=files.put(scope,file,bytes);
        await assetRequest('upload:'+scope+':'+id,async()=>{const result=await remote(hostId,{id:randomUUID(),type:'upload',upload:{scope,file:saved,data:bytes.toString('base64')}});if(result?.file?.sha256!==saved.sha256)throw new Error('电脑未确认收到附件');});
        return json(res,200,{file:saved});
      }
      if(req.method==='GET'&&url.pathname.startsWith('/api/files/')){
        const sessionId=url.searchParams.get('sessionId')??'',session=store.getSession(sessionId),id=url.pathname.slice('/api/files/'.length);
        if(!session||!uploadId.test(id))return json(res,404,{error:'附件不存在'});
        const scope=session.hostId+'|'+sessionId;files.ref(scope,id);let result;let source='server-cache';
        try{result=files.read(scope,id);}catch{
          source='workstation';await assetRequest('file:'+scope+':'+id,async()=>{const payload=await remote(session.hostId,{id:randomUUID(),type:'file',sessionId,fileId:id});if(payload?.scope!==scope||payload?.file?.id!==id)throw new Error('附件范围不匹配');files.import(payload);});result=files.read(scope,id);
        }
        if(result.file.mime.startsWith('video/')){serveVideo(req,res,result.bytes,result.file.mime,result.file.sha256,source);return;}
        const content=url.searchParams.get('preview')==='1'&&result.file.mime.startsWith('image/')?await previews.image(result.bytes,result.file.mime):{bytes:result.bytes,mime:result.file.mime,hash:result.file.sha256};
        res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
        res.writeHead(200,{'Content-Type':content.mime,'Content-Length':content.bytes.length,'X-Asset-Source':source,'X-Content-Sha256':content.hash,'Content-Disposition':(content.mime.startsWith('image/')?'inline':'attachment')+"; filename*=UTF-8''"+encodeURIComponent(result.file.name)});return res.end(content.bytes);
      }
      if(req.method==='POST' && url.pathname==='/api/logout') {
        res.setHeader('Set-Cookie',`relay_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`); return json(res,200,{ok:true});
      }
      if(req.method==='GET' && url.pathname==='/api/state') return json(res,200,{hosts:store.hosts().map(h=>({...h,online:bridges.has(h.id)})),sessions:store.sessions().map(s=>questionState.project(s))});
      if(req.method==='GET'&&url.pathname.startsWith('/api/images/')){
        const id=url.pathname.slice('/api/images/'.length),sessionId=url.searchParams.get('sessionId')??'',session=store.getSession(sessionId);
        if(!session||!(/^[a-f0-9]{64}$/).test(id))return json(res,404,{error:'图片不存在'});
        let image=media.read(sessionId,id),source='server-cache';
        if(!image){
          if(!bridges.has(session.hostId))return json(res,404,{error:'图片尚未缓存，需工作电脑上线后读取'});
          source='workstation';await assetRequest('image:'+sessionId+':'+id,async()=>{const payload=await remote(session.hostId,{id:randomUUID(),type:'asset',sessionId,assetId:id});if(payload?.id!==id)throw new Error('图片编号不匹配');media.putPayload(sessionId,payload);});image=media.read(sessionId,id);
        }
        if(!image)return json(res,404,{error:'图片已不存在或无法读取'});
        if(image.mime.startsWith('video/')){serveVideo(req,res,image.bytes,image.mime,id,source);return;}
        const content=url.searchParams.get('preview')==='1'?await previews.image(image.bytes,image.mime):{bytes:image.bytes,mime:image.mime,hash:id};
        res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
        res.writeHead(200,{'Content-Type':content.mime,'Content-Length':content.bytes.length,'X-Asset-Source':source,'X-Content-Sha256':content.hash,'Content-Disposition':"inline; filename*=UTF-8''"+encodeURIComponent(image.name)});return res.end(content.bytes);
      }
      if(req.method==='GET'&&url.pathname==='/api/direct-config'){
        const sessionId=url.searchParams.get('sessionId'),projectId=url.searchParams.get('projectId');
        if(Boolean(sessionId)===Boolean(projectId))return json(res,400,{error:'请选择会话或项目'});
        const hostId=sessionId?store.getSession(sessionId)?.hostId:url.searchParams.get('hostId');
        const host=store.hosts().find(h=>h.id===hostId);
        if(!host||!sessionId&&!host.projects.some(p=>p.id===projectId))return json(res,404,{error:'电脑、项目或会话不存在'});
        if(!bridges.has(host.id))return json(res,409,{error:'工作电脑离线'});
        return json(res,200,options.turn?turnCredentials(options.turn):{iceServers:[],expiresAt:0});
      }
      if(req.method==='POST'&&url.pathname==='/api/direct'){
        const value=await body(req),action=validateAction({id:randomUUID(),type:'direct',sessionId:value.sessionId,projectId:value.projectId,offer:value.offer,relay:value.relay});
        if(action.relay){if(!options.turn)return json(res,409,{error:'服务器尚未启用加密中转'});action.iceServers=turnCredentials(options.turn).iceServers;}
        const hostId=action.sessionId?store.getSession(action.sessionId)?.hostId:value.hostId;
        const host=store.hosts().find(h=>h.id===hostId);
        if(!host||!action.sessionId&&!host.projects.some(p=>p.id===action.projectId))return json(res,404,{error:'电脑、项目或会话不存在'});
        const count=negotiations.get(host.id)??0;if(count>=8)return json(res,429,{error:'正在建立其他直连，请稍后重试'});
        negotiations.set(host.id,count+1);
        try{const answer=await remote(host.id,action);if(!validDirectSdp(answer,'answer',action.relay))throw new Error('电脑未返回有效直连协商');return json(res,200,answer);}
        finally{const remaining=(negotiations.get(host.id)??1)-1;if(remaining)negotiations.set(host.id,remaining);else negotiations.delete(host.id);}
      }
      if(req.method==='GET'&&url.pathname==='/api/models'){
        const hostId=url.searchParams.get('hostId')??'',provider=url.searchParams.get('provider');
        if(!store.hosts().some(h=>h.id===hostId)||!['codex','claude','api'].includes(provider??''))return json(res,400,{error:'请选择设备和 Agent'});
        return json(res,200,await remote(hostId,{id:randomUUID(),type:'models',provider:provider as 'codex'|'claude'|'api',agentId:url.searchParams.get('agentId')??undefined}));
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
        const live=cursor===undefined&&url.searchParams.get('live')==='1';
        let page; let cached=false;
        try { page=await remote(s.hostId,{id:randomUUID(),type:'history',sessionId:id,cursor,...live?{live:true}:{}},live?8000:90_000); store.cache(id,cursor,page); }
        catch(err) { page=store.cached(id,cursor); if(!page) throw err; cached=true; }
        const result={...page,cached,session:store.getSession(id),events:cursor===undefined ? store.sessionEvents(id) : []};
        const etag='"'+createHash('sha256').update(JSON.stringify({...result,questionsAsOf:undefined})).digest('hex')+'"';
        res.setHeader('ETag',etag);res.setHeader('Cache-Control','private, no-cache');
        if(req.headers['if-none-match']===etag){res.writeHead(304);return res.end();}
        return json(res,200,result);
      }
      if(req.method==='POST' && url.pathname==='/api/actions') {
        const value=await body(req); const action=validateAction(value);
        if(action.type==='studio-migration'||action.type==='studio-launch'||action.type==='history'||action.type==='asset'||action.type==='file'||action.type==='models'||action.type==='commands'||action.type==='upload'||action.type==='direct'||action.type==='prepare-workspace'||action.type==='prepare-brainstorm'||action.type==='studio-artifact'||action.type==='studio-video'||action.type==='studio-repository') return json(res,400,{error:'Use the dedicated endpoint'});
        const host=['start','create-project'].includes(action.type) ? value.hostId : store.getSession(action.sessionId!)?.hostId;
        if(typeof host!=='string' || !store.hosts().some(h=>h.id===host)) return json(res,404,{error:'电脑或会话不存在'});
        if(!bridges.has(host)) return json(res,409,{error:'本地电脑离线'});
        const scope=host+'|'+(action.type==='start'?'project:'+action.projectId:action.sessionId);
        files.refs(scope,action.attachmentIds);
        if(action.type==='answer'){try{const result=await submitAnswer(host,action);return json(res,result?.error?409:200,result);}catch(error){return json(res,409,{error:(error as Error).message});}}
        const prior=store.beginAction(action.id,host,action);
        if(!prior.fresh) return json(res,prior.result ? 200 : 409,prior.result ?? {error:'操作已接受，结果尚未确认；不会重复执行'});
        try { const card=questionAnswers.card(action),startedAt=Date.now();let result:any;try{result=await remote(host,action);}catch(error){result=await questionAnswers.fallback(host,action,error);}if(result.sessionId)for(const id of action.attachmentIds??[])files.link(scope,host+'|'+result.sessionId,id);questionAnswers.confirmed(host,action,card,result,startedAt);store.finishAction(action.id,result);return json(res,200,result); }
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
    let hostId='';let service=false;let launcher=false;let alive=true;
    const helloTimer=setTimeout(()=>ws.close(1008,'Hello required'),5000);
    ws.on('pong',()=>{alive=true;});
    const heartbeat=setInterval(()=>{if(!alive) return ws.terminate();alive=false;ws.ping();},25_000);
    ws.on('message',raw=>{
      try {
        const msg=JSON.parse(raw.toString());
        if(msg.type==='hello' && !hostId) {
          if(!/^[a-zA-Z0-9_-]{1,60}$/.test(msg.host?.id ?? '') || typeof msg.host.name!=='string' || msg.host.name.length>100 || !Array.isArray(msg.host.projects) || msg.host.projects.length>100) throw new Error('Invalid host');
          service=msg.host.service==='brainstorm';launcher=msg.host.service==='launcher';if(msg.host.service!==undefined&&!service&&!launcher)throw Error('Invalid bridge service');
          const connections=launcher?launcherBridges:service?brainstormBridges:bridges;if(connections.has(msg.host.id))throw Error('Host already connected');
          if((service||launcher)&&!store.hosts().some(h=>h.id===msg.host.id))throw Error('Connect the main computer bridge first');
          hostId=msg.host.id;clearTimeout(helloTimer);connections.set(hostId,ws);
          if(launcher){const prior=store.hosts().find(h=>h.id===hostId)!;store.host({...prior,capabilities:{...prior.capabilities,studioLaunch:true}});emit('state',{});ws.send(JSON.stringify({type:'welcome'}));return;}
          const host:Host={id:hostId,name:msg.host.name,hostname:typeof msg.host.hostname==='string'?msg.host.hostname.slice(0,100):undefined,platform:typeof msg.host.platform==='string'?msg.host.platform.slice(0,80):undefined,projects:msg.host.projects,online:true,lastSeen:Date.now(),agents:publicAgents(msg.host.agents),capabilities:{createProject:msg.host.capabilities?.createProject===true,permissions:msg.host.capabilities?.permissions===true,studioWorkspaces:msg.host.capabilities?.studioWorkspaces===true,studioLaunch:launcherBridges.has(hostId),studioMigration:msg.host.capabilities?.studioMigration===true,studioRepository:msg.host.capabilities?.studioRepository===true,studioRepositoryConnect:msg.host.capabilities?.studioRepositoryConnect===true,studioArtifacts:msg.host.capabilities?.studioArtifacts===true,brainstorm:msg.host.capabilities?.brainstorm===true}};const prior=store.hosts().find(h=>h.id===hostId);store.host(service?{...prior!,capabilities:{...prior!.capabilities,brainstorm:true}}:{...host,projects:[...host.projects,...(prior?.projects??[]).filter(p=>p.id.startsWith('brainstorm-')&&!host.projects.some(x=>x.id===p.id))],capabilities:{...host.capabilities,brainstorm:host.capabilities?.brainstorm||brainstormBridges.has(hostId)}});emit('state',{});
          ws.send(JSON.stringify({type:'welcome'}));return;
        }
        if(!hostId) throw new Error('Hello required');
        if(launcher&&msg.type!=='result')throw Error('Launch service cannot publish sessions, projects or history');
        if(msg.type==='asset.cache'){
          ws.send(JSON.stringify({type:'asset.ack',jobId:msg.jobId,error:'图片内容仅通过设备直传'}));
        }else if(msg.type==='file.ref'){
          const scope=msg.scope as string,owner=typeof scope==='string'&&scope.startsWith(hostId+'|')?scope.slice(hostId.length+1):'';
          if(!owner||!(owner.startsWith('project:')?store.hosts().find(h=>h.id===hostId)?.projects.some(p=>p.id===owner.slice(8)):store.getSession(owner)?.hostId===hostId))throw new Error('Invalid file scope');
          try{const f=msg.file;files.register(scope,{id:f.id,name:f.name,size:f.size,mime:f.mime,sha256:f.sha256});ws.send(JSON.stringify({type:'file.ack',jobId:msg.jobId}));}
          catch{ws.send(JSON.stringify({type:'file.ack',jobId:msg.jobId,error:'附件索引无效'}));}
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
          const prior=store.hosts().find(h=>h.id===hostId)!;const incoming=service?msg.projects.filter((p:any)=>p.id.startsWith('brainstorm-')):msg.projects,retained=prior.projects.filter(p=>service?!p.id.startsWith('brainstorm-'):p.id.startsWith('brainstorm-'));store.host({...prior,projects:[...incoming,...retained.filter(p=>!incoming.some((x:any)=>x.id===p.id))],agents:service?prior.agents:publicAgents(msg.agents),lastSeen:Date.now()});emit('state',{});
        }else if(msg.type==='sessions') {
          if(!Array.isArray(msg.sessions) || msg.sessions.length>2000) throw new Error('Invalid session batch');
          const accepted:Session[]=[];for(const session of msg.sessions as Session[]) {
            if(session.hostId!==hostId || session.id!==`${hostId}:${session.provider}:${session.nativeId}` || !['codex','claude','api'].includes(session.provider) || typeof session.updatedAt!=='number') throw new Error('Invalid session owner');
            if(service&&(!session.managed||!session.projectId?.startsWith('brainstorm-')))throw Error('Invalid brainstorming session');
            const prior=store.getSession(session.id);if(!service&&brainstormBridges.has(hostId)&&prior?.managed&&prior.projectId?.startsWith('brainstorm-'))continue;
            const projected=questionState.project(session);store.session(projected);accepted.push(projected);
          }
          emit('sessions',{sessions:accepted});emit('state',{incremental:true});
        } else if(msg.type==='event') {
          const e=msg.event as RelayEvent;
          if(e.hostId!==hostId || !e.sessionId?.startsWith(hostId+':') || !store.getSession(e.sessionId) || typeof e.id!=='string') throw new Error('Invalid event owner');
          questionState.observe(e);const seq=store.event(e);if(seq) emit('event',e,seq);
          ws.send(JSON.stringify({type:'ack',id:e.id}));
        } else if(msg.type==='result') {
          const wait=pending.get(msg.id);
          if(wait?.host===hostId&&wait.socket===ws) {clearTimeout(wait.timer);pending.delete(msg.id);msg.error ? wait.reject(new Error(msg.error)) : wait.resolve(msg.result);}
        }
      } catch(err) { ws.close(1008,(err as Error).message.slice(0,120)); }
    });
    ws.on('close',()=>{
      clearTimeout(helloTimer);clearInterval(heartbeat);
      const connections=launcher?launcherBridges:service?brainstormBridges:bridges;if(connections.get(hostId)===ws){connections.delete(hostId);if(launcher){const prior=store.hosts().find(h=>h.id===hostId);if(prior)store.host({...prior,capabilities:{...prior.capabilities,studioLaunch:false}});}if(service){const prior=store.hosts().find(h=>h.id===hostId);if(prior)store.host({...prior,capabilities:{...prior.capabilities,brainstorm:false}});}emit('state',{});}
      for(const [id,p] of pending) if(p.socket===ws) {clearTimeout(p.timer);p.reject(new Error('电脑连接中断；操作不会自动重发'));pending.delete(id);}
    });
    ws.on('error',()=>{});
  });
  return {server,store,studio,brains,repairs, async close(){for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Relay stopping'));}pending.clear();await autoAnswers.close();await followups.close();await repositories.close();await studio.close();await repairs.close();await attention.close();for(const res of viewers)res.end();for(const ws of wss.clients)ws.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}};
}
