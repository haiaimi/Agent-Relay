import {readFileSync,mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {WebSocket} from 'ws';
import {assertRelayUrl,requireSecret} from '../shared/security.js';
import {validateAction} from '../shared/protocol.js';
import {StudioLauncher} from './studio-launcher.js';

const config=JSON.parse(readFileSync(resolve(process.argv[2]??'bridge.config.json'),'utf8'));
const data=resolve(config.dataDir??'.data/bridge'),token=process.env.BRIDGE_TOKEN??'';requireSecret(token,'BRIDGE_TOKEN');const url=assertRelayUrl(config.relayUrl);
mkdirSync(data,{recursive:true});const lock=join(data,'launcher.lock');
try{writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});}catch{let alive=false;try{process.kill(Number(readFileSync(lock,'utf8')),0);alive=true;}catch{}if(alive)throw Error('Launcher service is already running');unlinkSync(lock);writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});}
const launcher=new StudioLauncher(data,config.hostId);let socket:WebSocket,stopped=false,reconnect:NodeJS.Timeout|undefined;
function connect(){
 socket=new WebSocket(url,{headers:{Authorization:'Bearer '+token},handshakeTimeout:10000,maxPayload:1024*1024,perMessageDeflate:false});
 socket.on('open',()=>socket.send(JSON.stringify({type:'hello',host:{id:config.hostId,name:config.name,projects:[],service:'launcher'}})));
 socket.on('message',raw=>{const ws=socket;void (async()=>{
  const message=JSON.parse(raw.toString());if(message.type==='welcome'){console.log('Local launch service connected');return;}if(message.type!=='action')return;
  try{const action=validateAction(message.action);if(action.type!=='studio-launch')throw Error('Launch service only executes registered preview launch operations');const result=await launcher.handle(action);if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'result',id:action.id,result}));}
  catch(e){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'result',id:message.action?.id,error:(e as Error).message}));}
 })().catch(()=>{});});
 socket.on('error',e=>console.error('Launch service connection:',e.message));socket.on('close',()=>{if(!stopped)reconnect=setTimeout(connect,60_000);});
}
connect();
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopped=true;if(reconnect)clearTimeout(reconnect);socket?.close();unlinkSync(lock);process.exit(0);});
