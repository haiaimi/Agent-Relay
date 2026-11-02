import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { CodexRpc } from './codex.js';
import {CodexDesktop} from './codex-desktop.js';
import { NativeHistory, itemMessage } from './history.js';
import { BridgeStore } from './store.js';
import {claudeSteerSessions,steerClaude,SteerDeliveryError} from './claude-steer.js';
import {codexUsageText,claudeUsageText} from './usage.js';
import {MediaStore} from '../shared/media.js';
import {FileStore} from '../shared/files.js';
import {messageImages,imageSources} from './media.js';
import { assertProjectPath } from '../shared/security.js';
import { sessionKey, type Session, type Action, type Project, type RelayEvent, type Provider, type AgentModel, type AgentCommand } from '../shared/protocol.js';

const codexWriterConflict=(error:unknown)=>/already has an active writer/i.test((error as Error)?.message??'');

export interface BridgeConfig {
  relayUrl:string;hostId:string;name:string;dataDir:string;projects:Project[];
  codexCommand?:string;codexArgs?:string[];claudeCommand?:string;syncIntervalSeconds?:number;
  codexHome?:string;claudeHome?:string;discoverCodexProjects?:boolean;syncHistory?:boolean;
}
export class AgentRuntime {
  private managed=new Map<string,Session>();
  private turns=new Map<string,string>();
  private loaded=new Set<string>();
  private claude=new Map<string,{query:Query;controller:AbortController}>();
  private claudeRuns=new Map<string,Promise<void>>();
  private steering=new Set<string>();
  private approvals=new Map<string,{sessionId:string;resolve:(allow:boolean)=>void;timer:NodeJS.Timeout}>();
  private deltaBuffer=new Map<string,{sessionId:string;messageId:string;text:string}>();
  private flushTimer:NodeJS.Timeout;
  private closed=false;
  private busy=new Set<string>();
  private cancelled=new Set<string>();
  private catalogs=new Map<Provider,{at:number;models:AgentModel[]}>();
  private commandCatalogs=new Map<string,{at:number;commands:AgentCommand[]}>();
  private draining=false;
  private sideQueries=new Set<Query>();
  private usageQueries=new Set<Query>();
  readonly history:NativeHistory;
  readonly media:MediaStore;
  readonly files:FileStore;
  readonly codex:CodexRpc;
  constructor(readonly config:BridgeConfig,readonly store:BridgeStore,readonly onSessions:(sessions:Session[])=>void,readonly onEvent:(e:RelayEvent)=>void,private readonly claudeQuery:typeof query=query,readonly codexDesktop=new CodexDesktop()){
    this.media=new MediaStore(config.dataDir,store.db);
    this.files=new FileStore(config.dataDir,store.db);
    this.history=new NativeHistory(config.hostId,config.codexHome,config.claudeHome,this.media);
    for(const s of store.sessions()) {if(['running','waiting'].includes(s.status))s.status='interrupted';this.managed.set(s.id,s);store.save(s);}
    this.codex=new CodexRpc(config.codexCommand ?? 'codex',config.codexArgs);
    this.codex.on('notification',msg=>{void this.codexEvent(msg).catch(e=>console.error('Codex event failed:',(e as Error).message));});
    this.codex.on('failure',err=>{if(this.closed)return;this.loaded.clear();for(const s of this.managed.values())if(s.provider==='codex'&&['running','waiting'].includes(s.status)){this.event(s,'error',{message:err.message});this.status(s,'failed');}});
    this.flushTimer=setInterval(()=>this.flush(),100);
  }
  list():Session[]{
    const native=this.history.list(),all=new Map(native.map(s=>[s.id,s]));
    for(const s of this.managed.values()){
      const original=all.get(s.id);
      if(original){
        const before=JSON.stringify([s.title,s.status,s.statusOrigin,s.managed,s.updatedAt]);
        s.title=original.title;
        const externalCodex=s.provider==='codex'&&original.statusOrigin==='native'&&['running','waiting'].includes(original.status)&&!this.turns.has(s.nativeId);
        if(!s.managed||externalCodex){
          s.status=original.status;s.statusOrigin=original.statusOrigin;
          if(externalCodex)s.managed=false;
          s.updatedAt=Math.max(s.updatedAt,original.updatedAt);
        }
        if(before!==JSON.stringify([s.title,s.status,s.statusOrigin,s.managed,s.updatedAt]))this.store.save(s);
      }
      all.set(s.id,{...original,...s});
    }
    const inputs=this.store.queued(),peers=claudeSteerSessions(this.claudeHome());
    for(const s of all.values()){s.pendingIds=inputs.filter(a=>a.sessionId===s.id).map(a=>a.id);s.pendingCount=s.pendingIds.length;s.canSteer=this.canSteer(s,peers);}
    return [...all.values()];
  }
  private canSteer(s:Session,peers?:Set<string>):boolean{
    if(s.provider==='claude')return s.managed?this.claude.has(s.id)&&['running','waiting'].includes(s.status):(peers??claudeSteerSessions(this.claudeHome())).has(s.nativeId);
    return ['running','waiting'].includes(s.status)&&(s.managed?this.turns.has(s.nativeId):this.codexDesktop.available(s.nativeId));
  }
  projects():Project[]{return [...this.config.projects.map(p=>({...p,source:p.source??'configured' as const,roots:p.roots??[p.path]})),...(this.config.discoverCodexProjects===false?[]:this.history.projectIndex.projects)];}
  private roots():string[]{return this.projects().flatMap(p=>p.roots??[p.path]).filter(Boolean);}
  private save(s:Session){if(this.closed)return;s.updatedAt=Date.now();s.pendingIds=this.store.queued().filter(a=>a.sessionId===s.id).map(a=>a.id);s.pendingCount=s.pendingIds.length;s.canSteer=this.canSteer(s);this.managed.set(s.id,s);this.store.save(s);this.onSessions([s]);}
  private event(s:Session,type:RelayEvent['type'],data:Record<string,any>){if(this.closed)return;if(type==='message'&&!data.images&&imageSources(data).length)data=messageImages(this.media,s.id,s.cwd,data as any,data);const event:RelayEvent={id:randomUUID(),hostId:this.config.hostId,sessionId:s.id,type,data,at:Date.now()};this.store.event(event);this.onEvent(event);}
  private status(s:Session,status:Session['status']){s.status=status;this.save(s);this.event(s,'status',{status});}
  private delta(s:Session,messageId:string,text:string){const key=s.id+':'+messageId;const old=this.deltaBuffer.get(key);this.deltaBuffer.set(key,{sessionId:s.id,messageId,text:(old?.text ?? '')+text});}
  private flush(){for(const value of this.deltaBuffer.values()){const s=this.managed.get(value.sessionId);if(s)this.event(s,'delta',{messageId:value.messageId,text:value.text});}this.deltaBuffer.clear();}
  private async approve(s:Session,label:string,details:unknown,signal?:AbortSignal):Promise<boolean>{
    const id=randomUUID();this.status(s,'waiting');
    this.event(s,'approval',{approvalId:id,label,details:JSON.stringify(details).slice(0,24000),expiresAt:Date.now()+600_000});
    return new Promise(resolve=>{
      const finish=(allow:boolean)=>{const p=this.approvals.get(id);if(!p)return;clearTimeout(p.timer);this.approvals.delete(id);signal?.removeEventListener('abort',abort);this.event(s,'approval.resolved',{approvalId:id,allow});if(s.status==='waiting')this.status(s,'running');resolve(allow);};
      const abort=()=>finish(false);const timer=setTimeout(abort,600_000);this.approvals.set(id,{sessionId:s.id,resolve:finish,timer});signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });
  }
  private attached(a:Action){
    const scope=this.config.hostId+'|'+(a.type==='start'?'project:'+a.projectId:a.sessionId);
    const files=this.files.files(scope,a.attachmentIds);
    const text=(a.text??'')+(files.length?'\n\n用户附加文件（参考资料）：\n'+files.map(f=>f.file.name+': '+f.path).join('\n'):'');
    const input:any[]=[{type:'text',text,text_elements:[]},...files.filter(f=>f.file.mime.startsWith('image/')).map(f=>({type:'localImage',path:f.path}))];
    const content:any[]=[{type:'text',text},...files.filter(f=>f.file.mime.startsWith('image/')).map(f=>({type:'image',source:{type:'base64',media_type:f.file.mime,data:f.bytes.toString('base64')}}))];
    return {scope,files,text,input,content};
  }
  private get(id:string):Session{const s=this.managed.get(id)??this.history.get(id);if(!s)throw new Error('Unknown local session');return s;}
  private claudeExecutable(){return this.config.claudeCommand ?? (process.platform==='win32'?join(homedir(),'.local','bin','claude.exe'):'claude');}
  private claudeHome(){return this.history.claudeHome;}
  async models(provider:Provider):Promise<AgentModel[]>{
    const prior=this.catalogs.get(provider);if(prior&&Date.now()-prior.at<600_000)return prior.models;
    let models:AgentModel[]=[];
    if(provider==='codex'){
      await this.codex.start();let cursor:string|undefined;
      do {const page=await this.codex.call('model/list',{limit:100,cursor,includeHidden:false});models.push(...page.data.map((m:any)=>({id:m.model,name:m.displayName,description:m.description,isDefault:m.isDefault,efforts:(m.supportedReasoningEfforts??[]).map((e:any)=>e.reasoningEffort),defaultEffort:m.defaultReasoningEffort})));cursor=page.nextCursor??undefined;}while(cursor&&models.length<500);
    }else{
      let release!:()=>void;const gate=new Promise<void>(r=>release=r);
      async function* empty():AsyncGenerator<SDKUserMessage>{await gate;}
      const active=query({prompt:empty(),options:{cwd:this.config.projects[0]?.path??homedir(),pathToClaudeCodeExecutable:this.claudeExecutable(),persistSession:false,permissionMode:'default',settingSources:['user','project','local']}});
      let timeout:NodeJS.Timeout|undefined;
      try{const list=await Promise.race([active.supportedModels(),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Claude model discovery timed out')),20000);})]);models=list.map(m=>({id:m.value,name:m.displayName,description:m.description,efforts:m.supportedEffortLevels,aliases:m.resolvedModel?[m.resolvedModel]:undefined,defaultEffort:undefined}));}
      finally{if(timeout)clearTimeout(timeout);release();active.close();}
    }
    models=[...new Map(models.map(m=>[m.id,m])).values()];this.catalogs.set(provider,{at:Date.now(),models});return models;
  }
  private async checkModel(provider:Provider,model?:string,effort?:string){if(!model&&!effort)return;const list=await this.models(provider),selected=list.find(m=>m.id===model||m.aliases?.includes(model??''))??(!model?list.find(m=>m.isDefault)??list[0]:undefined);if(!selected)throw new Error('该模型不在本机 Agent 返回的列表中，请刷新后重选');if(effort&&effort!=='default'&&!selected.efforts?.includes(effort))throw new Error('该模型不支持此思考强度，请重新选择');}
  async commands(s:Session):Promise<AgentCommand[]>{
    const base:AgentCommand[]=[{name:'help',description:'查看可用命令',source:'relay'},{name:'usage',description:'查询账号额度与重置时间，不打断任务',source:'relay'},{name:'stop',description:'停止网页管理的任务，或取消排队消息',source:'relay'},{name:'model',description:'设置下一轮模型',argumentHint:'<模型 ID>',source:'relay'},{name:'effort',description:'设置下一轮思考强度',argumentHint:'<low|medium|high|xhigh|max|default>',source:'relay'}];
    if(s.provider!=='claude')return base;
    base.unshift({name:'btw',description:'基于会话上下文单独旁问，不打断主任务',argumentHint:'<问题>',source:'relay'});
    let cached=this.commandCatalogs.get(s.cwd);if(cached&&Date.now()-cached.at<600000)return [...base,...cached.commands.filter(c=>!base.some(b=>b.name===c.name))];
    let release!:()=>void;const gate=new Promise<void>(r=>release=r);async function* input():AsyncGenerator<SDKUserMessage>{await gate;}
    const active=query({prompt:input(),options:{cwd:s.cwd,pathToClaudeCodeExecutable:this.claudeExecutable(),persistSession:false,settingSources:['user','project','local'],permissionMode:'default'}});
    try{const list=await active.supportedCommands();const commands=list.filter(c=>!c.name.startsWith('__')).map(c=>({name:c.name,description:c.description,argumentHint:c.argumentHint,source:'claude' as const}));this.commandCatalogs.set(s.cwd,{at:Date.now(),commands});return [...base,...commands.filter(c=>!base.some(b=>b.name===c.name))];}finally{release();active.close();}
  }
  private async usage(s:Session):Promise<string>{
    let timer:NodeJS.Timeout|undefined,probe:Query|undefined,release=()=>{};
    try{
      const read=async()=>{
        if(s.provider==='codex'){await this.codex.start();return codexUsageText(await this.codex.call('account/rateLimits/read',{}));}
        const current=this.claude.get(s.id)?.query;
        if(!current){
          // Only ask for account metadata. No prompt, transcript writer or model call.
          const gate=new Promise<void>(resolve=>{release=resolve;});async function* input():AsyncGenerator<SDKUserMessage>{await gate;}
          probe=this.claudeQuery({prompt:input(),options:{cwd:s.cwd,pathToClaudeCodeExecutable:this.claudeExecutable(),persistSession:false,tools:[],permissionMode:'default',settingSources:['user','project','local'],canUseTool:async()=>({behavior:'deny',message:'Usage queries cannot use tools'})}});this.usageQueries.add(probe);
        }
        const active=current??probe!,method=active.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
        if(typeof method!=='function')throw new Error('当前本地 Claude 版本尚未提供用量查询接口，请更新连接程序与 Claude Code');
        return claudeUsageText(await method.call(active,{skipBehaviors:true}),!!current);
      };
      return await Promise.race([read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('用量查询超时，请稍后重试；当前任务继续执行')),20000);})]);
    }finally{if(timer)clearTimeout(timer);release();if(probe){probe.close();this.usageQueries.delete(probe);}}
  }
  async drainInputs(){
    if(this.draining||this.closed)return;this.draining=true;
    try{const handled=new Set<string>();for(const a of this.store.queued()){
      if(handled.has(a.sessionId!))continue;handled.add(a.sessionId!);const s=this.get(a.sessionId!);
      if(s.provider==='claude'&&!s.managed){const live=this.history.claudeLiveStatus(s.nativeId);s.status=live??'idle';if(live&&!claudeSteerSessions(this.claudeHome()).has(s.nativeId))continue;}
      if(s.provider==='codex'&&!s.managed&&await this.codexDesktop.owner(s.nativeId))continue;
      if(this.steering.has(s.id)||this.busy.has(s.id)||['running','waiting'].includes(s.status))continue;
      this.store.inputState(a.id,'dispatching');
      try{await this.handle(a,true);this.store.inputState(a.id,'sent');}catch(e){
        if(s.provider==='codex'&&codexWriterConflict(e))this.store.inputState(a.id,'queued');
        else{this.store.inputState(a.id,'failed');this.event(s,'error',{message:'排队消息未执行：'+(e as Error).message});}
      }
    }}finally{this.draining=false;}
  }
  private async sideQuestion(s:Session,question:string,id:string){
    let release!:()=>void;const gate=new Promise<void>(r=>release=r);async function* input():AsyncGenerator<SDKUserMessage>{await gate;}
    let active:Query|undefined;
    try{
      // A non-persistent fork reads the original context without writing to its active transcript.
      active=query({prompt:input(),options:{cwd:s.cwd,resume:s.nativeId,forkSession:true,persistSession:false,tools:[],pathToClaudeCodeExecutable:this.claudeExecutable(),permissionMode:'default',settingSources:['user','project','local'],canUseTool:async()=>({behavior:'deny',message:'Side questions cannot use tools'})}});this.sideQueries.add(active);
      const ask=(active as Query&{askSideQuestion?:(question:string,options:{signal:AbortSignal})=>Promise<{response:string;synthetic?:boolean}|null>}).askSideQuestion;
      if(typeof ask!=='function')throw new Error('当前 Claude SDK 不支持旁问接口，请更新本地连接程序');
      const answer=await ask.call(active,question,{signal:AbortSignal.timeout(120000)});
      if(!answer?.response||answer.synthetic)throw new Error(answer?.response??'Claude 未返回旁问答案');
      this.event(s,'message',{id:`btw-answer:${id}`,role:'assistant',label:'CLAUDE · 旁问',text:answer.response});
    }catch(e){this.event(s,'error',{message:'/btw 旁问失败：'+(e as Error).message});}finally{release();active?.close();if(active)this.sideQueries.delete(active);}
  }
  async handle(action:Action,fromQueue=false):Promise<any>{
    if(action.type==='upload'){
      const payload=action.upload!,prefix=this.config.hostId+'|';if(!payload.scope.startsWith(prefix))throw new Error('附件设备不匹配');
      const scope=payload.scope.slice(prefix.length);
      if(scope.startsWith('project:')){const p=this.projects().find(p=>p.id===scope.slice(8));if(!p)throw new Error('项目不存在');assertProjectPath(p.path,this.roots());}
      else assertProjectPath(this.get(scope).cwd,this.roots());
      return {file:this.files.import(payload)};
    }
    if(['start','send'].includes(action.type)&&action.attachmentIds?.length){if(action.text?.trimStart().startsWith('/'))throw new Error('附件请随普通消息发送，不能与 / 命令混用');this.attached(action);}
    if(action.type==='models')return {models:await this.models(action.provider!)};
    if(action.type==='asset'){this.get(action.sessionId!);return this.media.payload(action.sessionId!,action.assetId!);}
    if(action.type==='commands'){const s=this.get(action.sessionId!);assertProjectPath(s.cwd,this.roots());return {commands:await this.commands(s)};}
    if(action.type==='steer'||action.type==='cancel-input'){
      const s=this.get(action.sessionId!);assertProjectPath(s.cwd,this.roots());
      const input=this.store.queued().find(a=>a.id===action.queuedId&&a.sessionId===s.id);
      if(!input)throw new Error('这条消息已不在等待队列中，请刷新');
      if(action.type==='cancel-input'){
        if(!this.store.claimInput(input.id,s.id,'cancelled'))throw new Error('这条消息已开始处理，无法取消排队');
        this.save(s);this.event(s,'message',{id:input.id,role:'user',label:'你 · 排队已取消',text:input.text!,files:this.attached(input).files.map(f=>f.file)});return {ok:true,cancelledId:input.id};
      }
      if(input.text!.trimStart().startsWith('/'))throw new Error('引导仅支持普通文字；这条命令继续保留在队列中');
      if(this.steering.has(s.id))throw new Error('上一条引导正在投递，请稍候');
      if(!this.store.claimInput(input.id,s.id,'steering'))throw new Error('这条消息已开始处理，请刷新');
      this.steering.add(s.id);
      this.save(s);this.event(s,'message',{id:input.id,role:'user',label:'你 · 正在引导',text:input.text!,files:this.attached(input).files.map(f=>f.file)});
      try{
        if(s.provider==='codex'){
          if(s.managed){
            const turn=this.turns.get(s.nativeId);
            if(!turn||!['running','waiting'].includes(s.status))throw new Error('当前任务已结束，请等待排队消息继续执行');
            try{await this.codex.call('turn/steer',{threadId:s.nativeId,expectedTurnId:turn,clientUserMessageId:input.id,input:this.attached(input).input});}
            catch(e){if(/timed out/i.test((e as Error).message))throw new SteerDeliveryError('Codex 引导结果未知，请查看本地会话，勿重复点击',true);throw e;}
          }else await this.codexDesktop.steer(s.nativeId,input.id,this.attached(input).text,this.attached(input).input);
          this.store.inputState(input.id,'sent');this.save(this.get(s.id));
          this.event(this.get(s.id),'message',{id:input.id,role:'user',label:'你 · 引导已接收',text:input.text!,files:this.attached(input).files.map(f=>f.file)});
          return {ok:true,sessionId:s.id,steered:true,mode:'active-turn'};
        }
        if(s.managed){
          const active=this.claude.get(s.id),run=this.claudeRuns.get(s.id);
          if(!active||!run||!['running','waiting'].includes(s.status))throw new Error('当前任务已结束，请使用普通发送继续对话');
          // The SDK owns a single-turn worker. Wait for it to exit before resuming
          // the same transcript; a second writer must never race its cleanup.
          active.controller.abort();active.query.close();
          let timer:NodeJS.Timeout|undefined;
          try{await Promise.race([Promise.all([run,active.query.return(undefined)]),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('本轮尚未停止，引导未重发；请查看任务状态')),10000);})]);}finally{if(timer)clearTimeout(timer);}
          if(this.closed||this.cancelled.has(s.id))throw new Error('引导已取消');
          const result=await this.handle(input,true);
          this.store.inputState(input.id,'sent');this.save(this.get(s.id));
          this.event(this.get(s.id),'message',{id:input.id,role:'user',label:'你 · 引导',text:input.text!,files:this.attached(input).files.map(f=>f.file)});
          return {...result,steered:true,mode:'interrupt-resume'};
        }
        await steerClaude(this.claudeHome(),s.nativeId,s.cwd,input.id,input.text!,input.attachmentIds?.length?this.attached(input).content:undefined);
        this.store.inputState(input.id,'sent');this.save(s);
        this.event(s,'message',{id:input.id,role:'user',label:'你 · 引导已送入本机',text:input.text!,files:this.attached(input).files.map(f=>f.file)});
        return {ok:true,sessionId:s.id,steered:true,mode:'native'};
      }catch(e){
        const uncertain=e instanceof SteerDeliveryError&&e.uncertain,cancelled=this.cancelled.has(s.id);
        this.store.inputState(input.id,uncertain?'unknown':cancelled?'cancelled':'queued');this.save(this.get(s.id));
        this.event(this.get(s.id),'message',{id:input.id,role:'user',label:uncertain?'你 · 引导结果待确认':cancelled?'你 · 排队已取消':'你 · 已排队',text:input.text!,files:this.attached(input).files.map(f=>f.file)});throw e;
      }finally{this.steering.delete(s.id);}
    }
    if(action.type==='send'&&action.text!.trimStart().startsWith('/')){
      const [name,...parts]=action.text!.trim().slice(1).split(/\s+/),argument=parts.join(' '),s=this.get(action.sessionId!);assertProjectPath(s.cwd,this.roots());
      if(name==='btw'){
        if(s.provider!=='claude')throw new Error('/btw 当前仅支持 Claude 会话');if(!argument)throw new Error('请输入 /btw 后接要问的问题');
        this.event(s,'message',{id:action.id,role:'user',label:'你 · 旁问',text:action.text!,files:this.attached(action).files.map(f=>f.file)});void this.sideQuestion(s,argument,action.id);return {ok:true,sessionId:s.id,sideQuestion:true};
      }
      if(name==='usage'){
        if(argument)throw new Error('/usage 不需要参数，请直接发送 /usage');
        const text=await this.usage(s);this.event(s,'message',{id:action.id,role:'user',label:'你 · 命令',text:'/usage'});
        this.event(s,'message',{id:`usage:${action.id}`,role:'system',label:'用量查询',text});return {ok:true,sessionId:s.id,command:true};
      }
      if(name==='stop')return this.handle({...action,type:'stop'});
      if(name==='model'||name==='effort'){
        if(!argument)throw new Error(name==='model'?'请输入 /model 后接模型 ID':'请输入 /effort 后接强度等级');
        return this.handle({...action,type:'set-model',...(name==='model'?{model:argument}:{effort:argument})});
      }
      if(name==='help'){const commands=await this.commands(s);this.event(s,'message',{id:`help:${action.id}`,role:'system',text:commands.map(c=>`/${c.name} ${c.argumentHint??''} — ${c.description}`).join('\n')});return {ok:true,sessionId:s.id};}
      if(s.provider==='codex')throw new Error('此命令不受网页支持，输入 /help 查看可用命令');
      const supported=await this.commands(s);if(!supported.some(c=>c.name===name))throw new Error('当前 Claude 未提供此命令，请从补全列表选择');
      if(!s.managed&&this.history.claudeIsRunning(s.nativeId))throw new Error('此终端专用命令需要在本地 Claude 中执行；网页当前支持 /usage、/help、/btw 等补全中的网页命令');
    }
    if(action.type==='send'){
      let s=this.get(action.sessionId!);if(s.provider==='codex'){this.list();s=this.get(action.sessionId!);}assertProjectPath(s.cwd,this.roots());
      const live=s.provider==='claude'&&!s.managed?this.history.claudeLiveStatus(s.nativeId):undefined;
      if(s.provider==='claude'&&!s.managed){s.status=live??'idle';s.statusOrigin='native';}
      if(!fromQueue&&(this.steering.has(s.id)||this.busy.has(s.id)||['running','waiting'].includes(s.status)||(live&&!claudeSteerSessions(this.claudeHome()).has(s.nativeId))||this.store.queued().some(a=>a.sessionId===s.id))){
        if(this.store.queued().filter(a=>a.sessionId===s.id).length>=100)throw new Error('排队消息已达 100 条，请等待处理');
        this.store.enqueue(action);s.pendingCount=(s.pendingCount??0)+1;this.save(s);this.event(s,'message',{id:action.id,role:'user',label:'你 · 已排队',text:action.text!,files:this.attached(action).files.map(f=>f.file)});
        return {ok:true,sessionId:s.id,queued:true,external:!s.managed};
      }
      if(live){
        if(live!=='idle')throw new Error('本地 Claude 又开始执行任务，这条消息尚未投递');
        this.busy.add(s.id);
        try{await steerClaude(this.claudeHome(),s.nativeId,s.cwd,action.id,action.text!,action.attachmentIds?.length?this.attached(action).content:undefined);this.save(s);this.event(s,'message',{id:action.id,role:'user',text:action.text!,files:this.attached(action).files.map(f=>f.file)});return {ok:true,sessionId:s.id,native:true};}
        finally{this.busy.delete(s.id);}
      }
    }
    if(action.type==='set-model'){
      const s=this.get(action.sessionId!);assertProjectPath(s.cwd,this.roots());
      const model=action.model??s.nextModel??s.model;
      await this.checkModel(s.provider,model,action.effort);
      if(this.busy.has(s.id)||['running','waiting'].includes(s.status)){s.nextModel=model;s.nextEffort=action.effort??(action.model&&action.model!==s.model?'default':s.nextEffort??s.effort);this.save(s);return {ok:true,queued:true,model:s.nextModel,effort:s.nextEffort};}
      const chosenEffort=action.effort??(action.model&&action.model!==s.model?'default':s.nextEffort??s.effort);const updated={...s,model,effort:chosenEffort==='default'?undefined:chosenEffort,nextModel:undefined,nextEffort:undefined};this.save(updated);return {ok:true,model:updated.model,effort:updated.effort};
    }
    if(action.type==='history'){
      this.history.list();
      if(!this.history.get(action.sessionId!)&&this.managed.has(action.sessionId!))return {messages:[],cursor:null,source:'连接程序管理的实时会话'};
      return this.history.page(action.sessionId!,action.cursor);
    }
    if(action.type==='approve'){
      const p=this.approvals.get(action.approvalId!);if(!p||p.sessionId!==action.sessionId)throw new Error('Approval expired or belongs to another session');p.resolve(action.allow!);return {ok:true};
    }
    if(action.type==='stop'){
      const s=this.get(action.sessionId!);for(const a of this.store.queued())if(a.sessionId===s.id){this.store.inputState(a.id,'cancelled');this.event(s,'message',{id:a.id,role:'user',label:'你 · 排队已取消',text:a.text!});}s.pendingCount=0;this.save(s);
      if(!s.managed)return {ok:true,queueCancelled:true,external:true};
      this.cancelled.add(s.id);
      for(const p of this.approvals.values())if(p.sessionId===s.id)p.resolve(false);
      const claude=this.claude.get(s.id);if(claude){claude.controller.abort();claude.query.close();}
      const turn=this.turns.get(s.nativeId);if(turn)await this.codex.call('turn/interrupt',{threadId:s.nativeId,turnId:turn});
      this.flush();this.status(s,'interrupted');return {ok:true};
    }
    let session:Session;
    if(action.type==='start'){
      const project=this.projects().find(x=>x.id===action.projectId);if(!project)throw new Error('Project is not allowed by the local configuration');
      const workspace=(project.roots??[project.path])[action.workspaceIndex??0];if(!workspace)throw new Error('Unknown workspace in this project');
      const cwd=assertProjectPath(workspace,this.roots());
      await this.checkModel(action.provider!,action.model,action.effort);if(action.effort==='default')action.effort=undefined;
      let nativeId=randomUUID();
      if(action.provider==='codex') {
        await this.codex.start();const result=await this.codex.call('thread/start',{cwd,projectId:project.source==='codex'?project.nativeProjectId:undefined,model:action.model,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:'workspace-write'});nativeId=result.thread.id;this.loaded.add(nativeId);action.model=result.model??action.model;
      }
      session={id:sessionKey(this.config.hostId,action.provider!,nativeId),hostId:this.config.hostId,provider:action.provider!,nativeId,cwd,title:(action.text!.trim()||this.attached(action).files[0]?.file.name||'新会话').replace(/\s+/g,' ').slice(0,100),updatedAt:Date.now(),status:'idle',managed:true,model:action.model,effort:action.effort,projectId:project.id,projectName:project.name,projectSource:project.source,statusOrigin:'relay'};
      this.save(session);
    } else {
      session=this.get(action.sessionId!);assertProjectPath(session.cwd,this.roots());
      if(this.busy.has(session.id)||['running','waiting'].includes(session.status))throw new Error('Session is already running; wait or stop it before sending another turn');
      if(session.provider==='claude'&&!session.managed&&this.history.claudeIsRunning(session.nativeId))throw new Error('This Claude session is open in another local process. End that process before resuming here.');
      await this.checkModel(session.provider,action.model,action.effort);const pickedEffort=action.effort??session.nextEffort??session.effort;session={...session,managed:true,statusOrigin:'relay',model:action.model??session.nextModel??session.model,effort:pickedEffort==='default'?undefined:pickedEffort,nextModel:undefined,nextEffort:undefined};this.save(session);
    }
    if(this.busy.has(session.id))throw new Error('A turn is already starting');
    this.busy.add(session.id);this.cancelled.delete(session.id);this.status(session,'running');
    const prepared=this.attached(action);for(const f of prepared.files)this.files.link(prepared.scope,this.config.hostId+'|'+session.id,f.file.id);
    const userId=action.id;
    if(session.provider==='codex'){
      try {
        await this.codex.start();
        if(!this.loaded.has(session.nativeId)) {const restored=await this.codex.call('thread/resume',{threadId:session.nativeId,excludeTurns:true,cwd:session.cwd,model:session.model,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:'workspace-write'});session.model=restored.model??session.model;this.save(session);this.loaded.add(session.nativeId);}
        if(this.cancelled.has(session.id))return {ok:true,sessionId:session.id,interrupted:true};
        const result=await this.codex.call('turn/start',{threadId:session.nativeId,model:session.model,effort:session.effort,clientUserMessageId:userId,input:prepared.input});
        this.event(session,'message',{id:userId,role:'user',text:action.text!,files:prepared.files.map(f=>f.file)});
        if(['running','waiting'].includes(session.status))this.turns.set(session.nativeId,result.turn.id);
        if(this.cancelled.has(session.id))await this.codex.call('turn/interrupt',{threadId:session.nativeId,turnId:result.turn.id});
      } catch(err) {
        if(action.type==='send'&&codexWriterConflict(err)){
          const native=this.history.list(true).find(s=>s.id===session.id);
          session.managed=false;session.statusOrigin='native';session.title=native?.title??session.title;
          this.status(session,native?.statusOrigin==='native'?native.status:'idle');
          if(!fromQueue){this.store.enqueue(action);this.save(session);this.event(session,'message',{id:userId,role:'user',label:'你 · 已排队',text:action.text!,files:prepared.files.map(f=>f.file)});return {ok:true,sessionId:session.id,queued:true,external:true};}
          throw err;
        }
        this.status(session,'failed');this.event(session,'error',{message:(err as Error).message});throw err;
      }
      finally {this.busy.delete(session.id);}
    } else {this.event(session,'message',{id:userId,role:'user',text:action.text!,files:prepared.files.map(f=>f.file)});const run=this.runClaude(session,prepared.text,action.type!=='start',userId,prepared.files.length?prepared.content:undefined);this.claudeRuns.set(session.id,run);void run.finally(()=>{if(this.claudeRuns.get(session.id)===run)this.claudeRuns.delete(session.id);});}
    return {ok:true,sessionId:session.id};
  }
  private async runClaude(s:Session,text:string,resume:boolean,userId:string,content?:any[]){
    const controller=new AbortController();
    let finished:Session['status']|undefined;
    try {
      const executable=this.claudeExecutable();
      async function* prompt():AsyncGenerator<SDKUserMessage>{yield {type:'user',uuid:userId as `${string}-${string}-${string}-${string}-${string}`,session_id:s.nativeId,parent_tool_use_id:null,message:{role:'user',content:content??text}};}
      const active=this.claudeQuery({prompt:prompt(),options:{cwd:s.cwd,model:s.model,effort:s.effort as 'low'|'medium'|'high'|'xhigh'|'max'|undefined,pathToClaudeCodeExecutable:executable,abortController:controller,permissionMode:'default',permissionPrompts:'host',includePartialMessages:true,settingSources:['user','project','local'],...(resume?{resume:s.nativeId}:{sessionId:s.nativeId}),canUseTool:async(name,input,context)=>{
        const allow=await this.approve(s,name,input,context.signal);
        return allow?{behavior:'allow' as const,updatedInput:input}:{behavior:'deny' as const,message:'Denied by the remote operator or approval timed out'};
      }}});
      this.claude.set(s.id,{query:active,controller});this.save(s);let currentMessage='';
      for await(const msg of active){
        if(msg.type==='stream_event') {
          const e=msg.event;
          if(e.type==='message_start')currentMessage=e.message.id;
          if(e.type==='content_block_delta'&&e.delta.type==='text_delta')this.delta(s,`claude-stream:${currentMessage||msg.uuid}`,e.delta.text);
        } else if(msg.type==='assistant'){
          if(msg.message.model&&s.model!==msg.message.model){s.model=msg.message.model;this.save(s);}
          this.flush();const content=msg.message.content;
          const text=content.filter(x=>x.type==='text').map(x=>x.text).join('\n');
          if(text)this.event(s,'message',{id:`claude-text:${msg.uuid}`,role:'assistant',text,replaces:[`claude-stream:${msg.message.id}`]});
          for(const block of content)if(block.type==='tool_use')this.event(s,'message',{id:`claude-tool:${block.id}`,role:'tool',label:block.name,text:JSON.stringify(block.input).slice(0,24000)});
        } else if(msg.type==='result') {
          this.flush();if(msg.is_error)this.event(s,'error',{message:('errors' in msg?msg.errors.join('\n'):'Agent returned an error').slice(0,24000)});
          finished=s.status==='interrupted'?'interrupted':msg.is_error?'failed':'idle';
          active.close();break;
        }
      }
      finished??=controller.signal.aborted||s.status==='interrupted'?'interrupted':'idle';
    } catch(err) {if(!finished){if(controller.signal.aborted)finished='interrupted';else {this.event(s,'error',{message:(err as Error).message});finished='failed';}}}
    finally {this.busy.delete(s.id);this.claude.get(s.id)?.query.close();this.claude.delete(s.id);for(const p of this.approvals.values())if(p.sessionId===s.id)p.resolve(false);this.status(s,finished??'failed');}
  }
  private async codexEvent(msg:any){
    const p=msg.params ?? {};const threadId=p.threadId ?? p.thread?.id;
    const s=[...this.managed.values()].find(s=>s.provider==='codex'&&s.nativeId===threadId);
    if(!s) {if(msg.id!==undefined)this.codex.send({id:msg.id,error:{code:-32601,message:'Unsupported request or unmanaged session'}});return;}
    if(msg.id!==undefined){
      if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(msg.method)) {
        const allow=await this.approve(s,msg.method,p);this.codex.send({id:msg.id,result:{decision:allow?'accept':'decline'}});
      } else {this.codex.send({id:msg.id,error:{code:-32601,message:'This input type is not supported by Agent Relay yet; denied'}});this.event(s,'error',{message:`需要本机处理的请求：${msg.method}`});}
      return;
    }
    if(msg.method==='turn/started'){this.turns.set(threadId,p.turn.id);if(!this.cancelled.has(s.id))this.status(s,'running');}
    else if(msg.method==='item/agentMessage/delta')this.delta(s,p.itemId,p.delta);
    else if(msg.method==='item/completed'){
      this.flush();const m=itemMessage(p.item,Date.now());if(m)this.event(s,'message',messageImages(this.media,s.id,s.cwd,m,p.item));
    } else if(msg.method==='turn/completed'){
      this.flush();this.turns.delete(threadId);this.status(s,p.turn.status==='completed'?'idle':p.turn.status==='interrupted'?'interrupted':'failed');
      if(p.turn.error)this.event(s,'error',{message:p.turn.error.message ?? JSON.stringify(p.turn.error)});
      for(const a of this.approvals.values())if(a.sessionId===s.id)a.resolve(false);
    } else if(msg.method==='error')this.event(s,'error',{message:p.error?.message ?? 'Codex error'});
  }
  async close(){if(this.closed)return;this.closed=true;clearInterval(this.flushTimer);this.flush();for(const p of this.approvals.values())p.resolve(false);for(const v of this.claude.values()){v.controller.abort();v.query.close();}for(const q of this.sideQueries)q.close();for(const q of this.usageQueries)q.close();this.codexDesktop.close();this.codex.close();}
}
