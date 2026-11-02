import {connect,type Socket} from 'node:net';
import {randomUUID} from 'node:crypto';
import {SteerDeliveryError} from './claude-steer.js';

const MAX_FRAME=2*1024*1024;
const uuid=/^[a-f0-9]{8}-[a-f0-9-]{27}$/i;
// Each IPC method has its own version; the native router checks it during
// client discovery, before forwarding. A wrong version looks like no owner.
const methodVersions:Record<string,number>={initialize:0,'thread-owner-discovery':1,'thread-follower-steer-turn':1,'thread-follower-start-turn':2};
// Installed desktop's local follower protocol. Never expose
// arbitrary pipe paths, owner IDs or IPC methods through the phone API.
export class CodexDesktop {
  private socket?:Socket;
  private connecting?:Promise<void>;
  private clientId='initializing-client';
  private buffer=Buffer.alloc(0);
  private closed=false;
  private pending=new Map<string,{resolve:(r:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout;mutation:boolean;operation:string}>();
  private owners=new Map<string,{at:number;owner?:string;loading?:Promise<string|undefined>}>();
  constructor(private readonly pipePath=process.platform==='win32'?'\\\\.\\pipe\\codex-ipc':undefined){}
  available(threadId:string):boolean {
    const cached=this.owners.get(threadId);
    if(!cached||Date.now()-cached.at>15000)void this.owner(threadId).catch(()=>{});
    return !!cached?.owner&&Date.now()-cached.at<30000;
  }
  async owner(threadId:string):Promise<string|undefined>{
    if(!uuid.test(threadId)||this.closed||!this.pipePath)return undefined;
    const old=this.owners.get(threadId);if(old?.loading)return old.loading;
    const entry:{at:number;owner?:string;loading?:Promise<string|undefined>}={at:Date.now(),owner:old?.owner};this.owners.set(threadId,entry);
    entry.loading=(async()=>{
      try{
        await this.start();
        const reply=await this.request('thread-owner-discovery',{hostId:'local',conversationId:threadId});
        entry.owner=reply.result?.supportsUntrustedAppInput===true&&uuid.test(reply.handledByClientId??'')?reply.handledByClientId:undefined;
      }catch{entry.owner=undefined;}finally{entry.at=Date.now();entry.loading=undefined;}
      return entry.owner;
    })();return entry.loading;
  }
  async steer(threadId:string,id:string,text:string,input?:any[]):Promise<{turnId:string}>{
    if(text.trimStart().startsWith('/'))throw new Error('引导仅支持普通文字');
    const owner=await this.owner(threadId);
    if(!owner)throw new Error('未找到支持引导的本地 Codex 窗口；消息仍保留在队列中');
    const reply=await this.request('thread-follower-steer-turn',{
      conversationId:threadId,input:input??[{type:'text',text,text_elements:[]}],
      restoreMessage:{id,text,context:{},images:[],localImages:[],attachments:[],responsesapiClientMetadata:{}},
      attachments:[],clientUserMessageId:id
    },owner,true);
    // The IPC handler strips its internal {method, result} envelope.
    const result=reply.result?.result;
    if(typeof result?.turnId!=='string')throw new SteerDeliveryError('Codex 引导结果未确认，请查看本地会话，勿重复点击',true);
    return result;
  }
  async startTurn(threadId:string,id:string,text:string,input:any[],settings:{model?:string;effort?:string}={}):Promise<{turnId:string}>{
    const owner=await this.owner(threadId);
    if(!owner)throw new Error('未找到本地 Codex 窗口；消息尚未投递');
    const reply=await this.request('thread-follower-start-turn',{
      conversationId:threadId,
      turnStart:{request:{threadId,input,clientUserMessageId:id,...settings},context:{inheritThreadSettings:true,restoreMessage:{id,text,context:{},images:[],localImages:[],attachments:[],responsesapiClientMetadata:{}}}}
    },owner,true);
    const result=reply.result?.result;
    if(typeof result?.turn?.id!=='string')throw new SteerDeliveryError('Codex 续聊结果未确认，请查看本地会话，勿重复发送',true);
    return {turnId:result.turn.id};
  }
  private async start(){
    if(this.closed||!this.pipePath)throw new Error('本地 Codex 桌面连接不可用');
    if(this.connecting)return this.connecting;
    this.connecting=new Promise<void>((resolve,reject)=>{
      const socket=connect(this.pipePath!);this.socket=socket;
      socket.on('data',chunk=>this.read(chunk));
      socket.on('error',()=>{reject(new Error('无法连接本地 Codex'));this.disconnect(socket);});
      socket.on('close',()=>this.disconnect(socket));
      socket.once('connect',()=>{void this.request('initialize',{clientType:'agent-relay'}).then(r=>{
        if(!uuid.test(r.result?.clientId??''))throw new Error('不支持的 Codex 桌面协议');
        this.clientId=r.result.clientId;resolve();
      }).catch(e=>{reject(e);socket.destroy();});});
    });return this.connecting;
  }
  private request(method:string,params:unknown,targetClientId?:string,mutation=false):Promise<any>{
    const socket=this.socket;
    if(!socket?.writable)return Promise.reject(new Error('本地 Codex 连接已断开'));
    const version=methodVersions[method],operation=method==='thread-follower-start-turn'?'续聊':'引导';
    if(version===undefined)return Promise.reject(new Error('不支持的本地 Codex 方法'));
    const requestId=randomUUID();
    const payload=Buffer.from(JSON.stringify({type:'request',requestId,sourceClientId:this.clientId,version,method,params,targetClientId,timeoutMs:mutation?15000:4000}));
    if(payload.length>MAX_FRAME)return Promise.reject(new Error('引导内容过长'));
    const frame=Buffer.alloc(4+payload.length);frame.writeUInt32LE(payload.length);payload.copy(frame,4);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(requestId);reject(new SteerDeliveryError(mutation?`Codex ${operation}投递结果未知，请查看会话，勿重复点击`:'Codex 桌面连接超时',mutation));},mutation?16000:5000);
      this.pending.set(requestId,{resolve,reject,timer,mutation,operation});socket.write(frame);
    });
  }
  private read(chunk:Buffer){
    this.buffer=Buffer.concat([this.buffer,chunk]);
    while(this.buffer.length>=4){
      const length=this.buffer.readUInt32LE();if(!length||length>MAX_FRAME){this.socket?.destroy();return;}
      if(this.buffer.length<length+4)return;
      const payload=this.buffer.subarray(4,length+4);this.buffer=this.buffer.subarray(length+4);
      let r:any;try{r=JSON.parse(payload.toString());}catch{this.socket?.destroy();return;}
      if(r.type==='client-discovery-request'){
        const data=Buffer.from(JSON.stringify({type:'client-discovery-response',requestId:r.requestId,response:{canHandle:false}}));
        const frame=Buffer.alloc(4+data.length);frame.writeUInt32LE(data.length);data.copy(frame,4);this.socket?.write(frame);continue;
      }
      if(r.type!=='response')continue;
      const p=this.pending.get(r.requestId);if(!p)continue;clearTimeout(p.timer);this.pending.delete(r.requestId);
      if(r.resultType==='success')p.resolve(r);
      else p.reject(new SteerDeliveryError(p.mutation?`本地 Codex 未接受${p.operation}：`+String(r.error??'未知错误'):'Codex 会话不可用',p.mutation&&/timeout|connection|disconnected|outcome.unknown/i.test(String(r.error))));
    }
  }
  private disconnect(socket:Socket){
    if(this.socket!==socket)return;this.socket=undefined;this.connecting=undefined;this.clientId='initializing-client';this.buffer=Buffer.alloc(0);this.owners.clear();
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new SteerDeliveryError('本地 Codex 连接已断开，请先查看会话状态',p.mutation));}this.pending.clear();socket.destroy();
  }
  close(){this.closed=true;const socket=this.socket;if(socket)this.disconnect(socket);}
}
