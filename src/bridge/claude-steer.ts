import {readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {connect} from 'node:net';

interface Peer {sessionId:string;cwd:string;socket:string;token:string}
export class SteerDeliveryError extends Error {constructor(message:string,readonly uncertain:boolean){super(message);}}

// This is Claude Code's local, versioned peer protocol, not a relay credential.
// Tokens and pipe addresses never leave this module or the local computer.
function peers(home:string):Peer[]{
  if(process.platform!=='win32')return [];
  const dir=join(home,'sessions');let files:string[];try{files=readdirSync(dir);}catch{return [];}
  const found:Peer[]=[];
  for(const name of files.filter(n=>/^\d+\.json$/.test(n))){
    try{
      const r=JSON.parse(readFileSync(join(dir,name),'utf8'));
      if(!Number.isSafeInteger(r.pid)||r.pid<=0||name!==`${r.pid}.json`||r.peerProtocol!==1||typeof r.sessionId!=='string'||typeof r.cwd!=='string')continue;
      if(typeof r.messagingSocketPath!=='string'||!/^\\\\\.\\pipe\\(?:LOCAL\\)?cc-msg-[a-f0-9]{32}$/i.test(r.messagingSocketPath))continue;
      process.kill(r.pid,0);
      const keys=files.filter(n=>new RegExp(`^${r.pid}\\.[a-f0-9]{64}\\.key$`,'i').test(n));
      const valid=keys.map(n=>{try{return JSON.parse(readFileSync(join(dir,n),'utf8'));}catch{return null;}}).filter(k=>k&&typeof k.peerToken==='string'&&k.peerToken.length>=16&&k.procStartFt!=null&&r.procStart!=null&&String(k.procStartFt)===String(r.procStart)&&typeof r.pidDomain==='string'&&k.pidDomain===r.pidDomain);
      if(valid.length===1)found.push({sessionId:r.sessionId,cwd:r.cwd,socket:r.messagingSocketPath,token:valid[0].peerToken});
    }catch{/* Expired registrations, unsupported protocols and mismatched keys are unavailable. */}
  }
  return found;
}

function target(home:string,sessionId:string,cwd:string):Peer|undefined{
  const matches=peers(home).filter(p=>p.sessionId===sessionId&&resolve(p.cwd).toLowerCase()===resolve(cwd).toLowerCase());
  return matches.length===1?matches[0]:undefined;
}

export function claudeSteerSessions(home:string):Set<string>{
  const list=peers(home),counts=new Map<string,number>();for(const p of list)counts.set(p.sessionId,(counts.get(p.sessionId)??0)+1);
  return new Set(list.filter(p=>counts.get(p.sessionId)===1).map(p=>p.sessionId));
}

export async function steerClaude(home:string,sessionId:string,cwd:string,id:string,text:string,content?:any[]):Promise<void>{
  if(text.trimStart().startsWith('/'))throw new Error('引导请填写普通文字；/ 命令请使用发送按钮');
  const peer=target(home,sessionId,cwd);if(!peer)throw new Error('未找到唯一且受支持的本地 Claude 会话，请刷新；消息未加入排队');
  const frames=JSON.stringify({type:'auth',token:peer.token})+'\n'+JSON.stringify({type:'user',session_id:sessionId,uuid:id,msg_id:id,priority:'now',from:'Agent Relay phone',message:{role:'user',content:content??text}})+'\n';
  await new Promise<void>((done,fail)=>{
    let written=false;const socket=connect(peer.socket);
    socket.setTimeout(5000,()=>socket.destroy(new Error('timeout')));
    socket.once('error',()=>fail(new SteerDeliveryError(written?'本地引导投递结果未知，请先查看会话，勿重复点击':'无法连接本地 Claude；消息仍保留在队列中',written)));
    socket.once('connect',()=>{written=true;socket.end(frames);});
    socket.once('close',hadError=>{if(!hadError)done();});
  });
}
