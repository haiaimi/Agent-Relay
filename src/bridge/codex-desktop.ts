import {connect,type Socket} from 'node:net';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {lstatSync,realpathSync} from 'node:fs';
import {SteerDeliveryError} from './claude-steer.js';
import type {PermissionMode} from '../shared/protocol.js';
import {codexPermissions} from './permissions.js';
import {codexSettings,type SessionSettings} from './settings.js';

const MAX_FRAME=32*1024*1024;
const uuid=/^[a-f0-9]{8}-[a-f0-9-]{27}$/i;
export function codexIpcPath(home=process.env.CODEX_HOME??join(homedir(),'.codex')){
  if(process.platform==='win32')return '\\\\.\\pipe\\codex-ipc';
  const dir=join(home,'ipc'),primary=join(dir,'ipc.sock'),uid=process.getuid?.();
  const owned=(path:string)=>{try{const s=lstatSync(path);return s.isSocket()&&s.uid===uid;}catch{return false;}};
  const legacy=join(tmpdir(),'codex-ipc',uid?`ipc-${uid}.sock`:'ipc.sock');
  if(owned(primary))return primary;if(owned(legacy))return legacy;
  if(Buffer.byteLength(primary)>(process.platform==='linux'?107:103)&&uid!==undefined)try{return join('/tmp',`codex-ipc-${uid}`,createHash('sha256').update(realpathSync(dir)).digest('hex'),'ipc.sock');}catch{}
  return primary;
}
// Each IPC method has its own version; the native router checks it during
// client discovery, before forwarding. A wrong version looks like no owner.
const methodVersions:Record<string,number>={initialize:0,'thread-owner-discovery':1,'thread-follower-steer-turn':1,'thread-follower-start-turn':2,'thread-follower-submit-user-input':1,'thread-follower-interrupt-turn':3,'thread-follower-update-thread-settings':2,'thread-follower-read-model-settings':1,'thread-follower-command-approval-decision':1,'thread-follower-file-approval-decision':1};
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
  private following=new Map<string,{owner:string;at:number;requests:any[];revision?:number;settings?:any}>();
  private settingsReads=new Map<string,Promise<SessionSettings|undefined>>();
  onRequests?:(threadId:string,requests:any[])=>void;
  onSettings?:(threadId:string,settings:SessionSettings)=>void;
  constructor(private readonly pipePath=codexIpcPath()){}
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
  async startTurn(threadId:string,id:string,text:string,input:any[],settings:{model?:string;effort?:string|null}={}):Promise<{turnId:string}>{
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
  async watch(threadId:string){
    const old=this.following.get(threadId);if(old&&Date.now()-old.at<30000)return;
    const owner=await this.owner(threadId);if(!owner)return;
    this.following.set(threadId,{owner,at:Date.now(),requests:old?.owner===owner?old.requests:[],revision:old?.owner===owner?old.revision:undefined,settings:old?.owner===owner?old.settings:undefined});
    this.broadcast('thread-stream-following-changed',{hostId:'local',conversationId:threadId,following:true},[owner]);
  }
  readSettings(threadId:string):Promise<SessionSettings|undefined>{
    const prior=this.settingsReads.get(threadId);if(prior)return prior;
    const read=(async()=>{
      const owner=await this.owner(threadId);if(!owner)return undefined;
      await this.watch(threadId);
      const reply=await this.request('thread-follower-read-model-settings',{conversationId:threadId},owner);
      const settings=(reply.result?.result??reply.result)?.settings;
      if(!settings||typeof settings.model!=='string')throw new Error('本机会话设置尚未就绪');
      // Reading the owner's metadata never starts or resumes another writer.
      for(let i=0;i<20&&this.following.get(threadId)?.revision===undefined;i++)await new Promise(r=>setTimeout(r,25));
      const current=this.following.get(threadId)?.settings??{};
      const latest=current.latestThreadSettings;
      // The model-settings response can report null while the owner snapshot
      // has an explicit collaboration/turn setting. Null must not erase it.
      const effort=latest?.effort??latest?.collaborationMode?.settings?.reasoning_effort??settings.reasoningEffort;
      return {...codexSettings({...current.currentPermissions,...latest}),...codexSettings({...settings,reasoningEffort:effort}),settingsSource:'desktop' as const};
    })().finally(()=>this.settingsReads.delete(threadId));this.settingsReads.set(threadId,read);return read;
  }
  async interrupt(threadId:string):Promise<{ok:true;interruptedTurnId:string|null;goalPauseError?:string}>{
    const owner=await this.owner(threadId);
    if(!owner)throw new Error('未找到可停止的本地 Codex 窗口，请在电脑上停止任务');
    // The desktop accepts v3 when expectedTurnId is omitted: stop the current
    // turn through its existing owner, without opening another transcript writer.
    const reply=await this.request('thread-follower-interrupt-turn',{conversationId:threadId,mode:'user-stop'},owner,true);
    const result=reply.result?.result??reply.result;
    if(result?.ok!==true||!(result.interruptedTurnId===null||typeof result.interruptedTurnId==='string'))throw new SteerDeliveryError('Codex 停止结果未确认，请查看本地会话，勿重复点击',true);
    return result;
  }
  async setPermissions(threadId:string,mode:PermissionMode,cwd:string){
    const owner=await this.owner(threadId);if(!owner)throw new Error('本地 Codex 窗口不可用，请在电脑上选择权限');
    const {approvalPolicy,approvalsReviewer,sandboxPolicy}=codexPermissions(mode,cwd);
    const reply=await this.request('thread-follower-update-thread-settings',{conversationId:threadId,threadSettings:{approvalPolicy,approvalsReviewer,sandboxPolicy}},owner,true);
    if((reply.result?.result??reply.result)?.applied!==true)throw new SteerDeliveryError('本地 Codex 未确认权限更新，请查看电脑窗口',true);
  }
  async setModel(threadId:string,model:string|undefined,effort:string|undefined){
    const owner=await this.owner(threadId);if(!owner)throw new Error('本地 Codex 窗口不可用，请在电脑上选择模型');
    const reply=await this.request('thread-follower-update-thread-settings',{conversationId:threadId,threadSettings:{...model&&{model},...effort!==undefined&&{effort:effort==='default'?null:effort}}},owner,true);
    if((reply.result?.result??reply.result)?.applied!==true)throw new SteerDeliveryError('本地 Codex 未确认模型更新，请查看电脑窗口',true);
  }
  async decideApproval(threadId:string,requestId:string|number,allow:boolean,remember:boolean){
    const owner=await this.owner(threadId);if(!owner)throw new Error('本地 Codex 窗口不可用');
    const request=this.following.get(threadId)?.requests.find(r=>r.id===requestId);
    const method=request?.method==='item/commandExecution/requestApproval'?'thread-follower-command-approval-decision':request?.method==='item/fileChange/requestApproval'?'thread-follower-file-approval-decision':undefined;
    if(!method)throw new Error('确认已在本机关闭，请刷新');
    const reply=await this.request(method,{conversationId:threadId,requestId,decision:allow?(remember?'acceptForSession':'accept'):'decline'},owner,true);
    if((reply.result?.result??reply.result)?.ok!==true)throw new SteerDeliveryError('批准结果未确认，请查看本机，勿重复提交',true);
  }
  async answer(threadId:string,requestId:string|number,answers:Record<string,string[]>){
    const owner=await this.owner(threadId);if(!owner)throw new Error('本地 Codex 窗口不可用，请刷新');
    if(this.following.get(threadId)?.owner!==owner){this.following.delete(threadId);await this.watch(threadId);throw new Error('本地窗口已切换，正在刷新问题，请稍后再试');}
    const pending=this.following.get(threadId)?.requests.find(r=>r.id===requestId&&r.method==='item/tool/requestUserInput');if(!pending)throw new Error('问题已在本机关闭，请刷新');
    const response={answers:Object.fromEntries(Object.entries(answers).map(([id,values])=>[id,{answers:values}]))};
    const reply=await this.request('thread-follower-submit-user-input',{conversationId:threadId,requestId,response},owner,true);
    if(reply.result?.ok!==true)throw new SteerDeliveryError('问题回答结果未确认，请查看本机，勿重复提交',true);
  }
  private broadcast(method:string,params:unknown,targetClientIds?:string[]){
    const payload=Buffer.from(JSON.stringify({type:'broadcast',method,params,targetClientIds,sourceClientId:this.clientId,version:1}));const frame=Buffer.alloc(4+payload.length);frame.writeUInt32LE(payload.length);payload.copy(frame,4);this.socket?.write(frame);
  }
  private broadcastReceived(message:any){
    const p=message.params,follow=p&&this.following.get(p.conversationId);if(!follow||p.hostId!=='local')return;
    if(message.method==='thread-stream-following-status-requested'){this.broadcast('thread-stream-following-changed',{hostId:'local',conversationId:p.conversationId,following:true},[message.sourceClientId]);return;}
    if(message.method!=='thread-stream-state-changed'||message.sourceClientId!==follow.owner)return;
    const change=p.change;
    if(change?.type==='snapshot'){follow.requests=Array.isArray(change.conversationState?.requests)?change.conversationState.requests.slice(0,100):[];follow.revision=change.revision;follow.settings={currentPermissions:change.conversationState?.currentPermissions,latestThreadSettings:change.conversationState?.latestThreadSettings};}
    else if(change?.type==='patches'){
      if(change.baseRevision!==follow.revision){follow.requests=[];this.broadcast('thread-stream-following-changed',{hostId:'local',conversationId:p.conversationId,following:true},[follow.owner]);return;}
      for(const patch of change.patches??[]){const path=patch.path;if(!Array.isArray(path)||!['requests','currentPermissions','latestThreadSettings'].includes(path[0])||path.length>12||path.some((v:unknown)=>['__proto__','constructor','prototype'].includes(String(v))))continue;
        if(path[0]!=='requests'){
          follow.settings??={};let target=follow.settings;for(const key of path.slice(0,-1)){if(!target[key]||typeof target[key]!=='object')target[key]={};target=target[key];}
          const key=path.at(-1);if(patch.op==='remove')delete target[key];else target[key]=patch.value;continue;
        }
        if(path.length===1){follow.requests=Array.isArray(patch.value)?patch.value.slice(0,100):[];continue;}
        let target:any=follow.requests;for(const key of path.slice(1,-1)){target=target?.[key];if(!target)break;}if(!target)continue;const key=path.at(-1);
        if(patch.op==='remove'){if(Array.isArray(target))target.splice(Number(key),1);else delete target[key];}else if(Array.isArray(target)&&patch.op==='add')target.splice(Number(key),0,patch.value);else target[key]=patch.value;
      }
      follow.revision=change.revision;
    }else return;
    const settings=codexSettings({...follow.settings?.currentPermissions,...follow.settings?.latestThreadSettings});
    if(Object.keys(settings).length)this.onSettings?.(p.conversationId,{...settings,settingsSource:'desktop'});
    this.onRequests?.(p.conversationId,follow.requests.filter((r:any)=>['item/tool/requestUserInput','item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(r?.method)));
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
    const version=methodVersions[method],operation=method==='thread-follower-start-turn'?'续聊':method==='thread-follower-submit-user-input'?'回答':method==='thread-follower-interrupt-turn'?'停止':method==='thread-follower-update-thread-settings'?'更新权限':method.endsWith('approval-decision')?'批准':'引导';
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
      if(r.type==='broadcast'){this.broadcastReceived(r);continue;}
      if(r.type!=='response')continue;
      const p=this.pending.get(r.requestId);if(!p)continue;clearTimeout(p.timer);this.pending.delete(r.requestId);
      if(r.resultType==='success')p.resolve(r);
      else p.reject(new SteerDeliveryError(p.mutation?`本地 Codex 未接受${p.operation}：`+String(r.error??'未知错误'):'Codex 会话不可用',p.mutation&&/timeout|connection|disconnected|outcome.unknown/i.test(String(r.error))));
    }
  }
  private disconnect(socket:Socket){
    if(this.socket!==socket)return;this.socket=undefined;this.connecting=undefined;this.clientId='initializing-client';this.buffer=Buffer.alloc(0);this.owners.clear();
    for(const id of this.following.keys())this.onRequests?.(id,[]);this.following.clear();
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new SteerDeliveryError('本地 Codex 连接已断开，请先查看会话状态',p.mutation));}this.pending.clear();socket.destroy();
  }
  close(){this.closed=true;const socket=this.socket;if(socket)this.disconnect(socket);}
}
