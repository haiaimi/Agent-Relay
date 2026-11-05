import {studioVideo} from './studio-video.js';
import { randomUUID } from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { CodexRpc } from './codex.js';
import {CodexDesktop,codexIpcPath} from './codex-desktop.js';
import { NativeHistory, itemMessage } from './history.js';
import { BridgeStore } from './store.js';
import {claudeSteerSessions,steerClaude,SteerDeliveryError} from './claude-steer.js';
import {codexUsageText,claudeUsageText} from './usage.js';
import {MediaStore} from '../shared/media.js';
import {FileStore} from '../shared/files.js';
import {messageImages,imageSources,imageSafeJson} from './media.js';
import { assertProjectPath } from '../shared/security.js';
import { sessionKey, type Session, type Action, type Project, type RelayEvent, type Provider, type AgentModel, type AgentCommand } from '../shared/protocol.js';
import {QuestionBroker} from './questions.js';
import {normalizeQuestions} from '../shared/questions.js';
import {codexPermissions,claudePermissions} from './permissions.js';
import {prepareBrainstorm,brainProject,brainstormTools,brainstormInstructions} from './brainstorm.js';
import {studioArtifact} from './studio-artifact.js';
import {prepareStudioWorkspace} from './studio-workspace.js';
import {createLocalProject} from './projects.js';
import {toolActivity} from './activity.js';
import {codexSettings,claudeSettings,type SessionSettings} from './settings.js';
import type {Activity} from '../shared/protocol.js';
import {AgentRegistry} from './agents.js';
import {ApiAgentRun} from './api-agent.js';

const codexWriterConflict=(error:unknown)=>/already has an active writer/i.test((error as Error)?.message??'');

export interface BridgeConfig {
  projectSourceDataDir?:string;service?:'brainstorm';relayUrl:string;hostId:string;name:string;dataDir:string;projects:Project[];
  codexCommand?:string;codexArgs?:string[];claudeCommand?:string;syncIntervalSeconds?:number;
  codexHome?:string;claudeHome?:string;discoverCodexProjects?:boolean;syncHistory?:boolean;
}
export class AgentRuntime {
  readonly agents:AgentRegistry;
  private apiRuns=new Map<string,{runner:ApiAgentRun;promise:Promise<void>}>();
  private managed=new Map<string,Session>();
  private turns=new Map<string,string>();
  private loaded=new Set<string>();
  private claude=new Map<string,{query:Query;controller:AbortController}>();
  private claudeRuns=new Map<string,Promise<void>>();
  private steering=new Set<string>();
  private approvals=new Map<string,{sessionId:string;resolve:(allow:boolean,remember?:boolean)=>void;timer:NodeJS.Timeout}>();
  private nativeApprovals=new Map<string,string>();
  private nativeApprovalDelivery=new Map<string,Promise<void>>();
  private deltaBuffer=new Map<string,{sessionId:string;messageId:string;text:string}>();
  private flushTimer:NodeJS.Timeout;
  private closed=false;
  private busy=new Set<string>();
  private nativeStarts=new Map<string,number>();
  private nativeWriterWait=new Map<string,number>();
  private cancelled=new Set<string>();
  private stopping=new Set<string>();
  private catalogs=new Map<Provider,{at:number;models:AgentModel[]}>();
  private nativeSettings=new Map<string,SessionSettings>();
  private nativeSettingsAt=new Map<string,number>();
  private nativeSettingsReads=new Map<string,Promise<void>>();
  private commandCatalogs=new Map<string,{at:number;commands:AgentCommand[]}>();
  private draining=false;
  private sideQueries=new Set<Query>();
  private usageQueries=new Set<Query>();
  readonly history:NativeHistory;
  readonly media:MediaStore;
  readonly files:FileStore;
  readonly codex:CodexRpc;
  readonly questions:QuestionBroker;
  constructor(readonly config:BridgeConfig,readonly store:BridgeStore,readonly onSessions:(sessions:Session[])=>void,readonly onEvent:(e:RelayEvent)=>void,private readonly claudeQuery:typeof query=query,readonly codexDesktop=new CodexDesktop(codexIpcPath(config.codexHome))){
    this.agents=new AgentRegistry(config.dataDir);
    this.media=new MediaStore(config.dataDir,store.db);
    this.questions=new QuestionBroker(card=>{
      const s=this.managed.get(card.sessionId)??this.history?.get(card.sessionId);if(!s)return;
      this.event(s,card.status==='pending'?'question':'question.resolved',card);
      s.questionCount=this.questions.list(s.id).length;
      if(s.managed&&s.status==='waiting'&&!s.questionCount&&![...this.approvals.values()].some(a=>a.sessionId===s.id))this.status(s,'running');else this.save(s);
    });
    this.codexDesktop.onRequests=(threadId,requests)=>{
      const s=this.managed.get(sessionKey(config.hostId,'codex',threadId))??this.history.get(sessionKey(config.hostId,'codex',threadId));if(!s||s.managed)return;
      const active=new Set<string>(),pending=new Set<string>();for(const request of requests){
        if(request.method!=='item/tool/requestUserInput'){
          const key=s.id+'|'+String(request.id);pending.add(key);
          if(!this.nativeApprovals.has(key)){
            const delivery=this.approve(s,request.method,request.params,undefined,key).then(async result=>{
              const approvalId=this.nativeApprovals.get(key);await this.codexDesktop.decideApproval(threadId,request.id,result.allow,result.remember);
              if(approvalId)this.event(s,'approval.resolved',{approvalId,allow:result.allow,remember:result.remember});
            });
            const id=this.nativeApprovals.get(key)!;this.nativeApprovalDelivery.set(id,delivery);
            void delivery.catch(error=>{this.event(s,'approval.resolved',{approvalId:id,unconfirmed:true});if(!/关闭/.test(error.message))this.event(s,'error',{message:error.message});});
          }
          continue;
        }
        try{const source='native:'+String(request.params?.turnId??'')+':'+String(request.id);active.add(source);this.questions.attach(s.id,source,normalizeQuestions(request.params?.questions,'codex'),answers=>this.codexDesktop.answer(threadId,request.id,answers));}catch{}
      }
      for(const [key,id] of this.nativeApprovals)if(key.startsWith(s.id+'|')&&!pending.has(key)){this.approvals.get(id)?.resolve(false);this.nativeApprovals.delete(key);this.nativeApprovalDelivery.delete(id);}
      this.questions.reconcile(s.id,'native:',active);
    };
    this.codexDesktop.onSettings=(threadId,settings)=>{
      const id=sessionKey(config.hostId,'codex',threadId),s=this.managed.get(id)??this.history.get(id);if(!s||s.managed)return;
      this.nativeSettingsAt.set(id,Date.now());
      const merged={...this.nativeSettings.get(id),...settings};if(JSON.stringify(merged)===JSON.stringify(this.nativeSettings.get(id)))return;
      this.nativeSettings.set(id,merged);this.onSessions([{...s,...merged}]);
    };
    this.files=new FileStore(config.dataDir,store.db);
    this.history=new NativeHistory(config.hostId,config.codexHome,config.claudeHome,this.media);
    for(const s of store.sessions()) {if(['running','waiting'].includes(s.status))s.status='interrupted';this.managed.set(s.id,s);store.save(s);}
    this.codex=new CodexRpc(config.codexCommand ?? 'codex',config.codexArgs);
    this.codex.on('notification',msg=>{void this.codexEvent(msg).catch(e=>console.error('Codex event failed:',(e as Error).message));});
    this.codex.on('failure',err=>{if(this.closed)return;this.loaded.clear();this.turns.clear();for(const s of this.managed.values())if(s.provider==='codex'&&s.managed&&['running','waiting'].includes(s.status)){this.questions.cancelSession(s.id);this.event(s,'error',{message:err.message});this.status(s,'failed');}});
    this.flushTimer=setInterval(()=>this.flush(),100);
  }
  list():Session[]{
    const native=this.history.list(),all=new Map(native.map(s=>[s.id,s]));
    for(const s of this.managed.values()){
      const original=all.get(s.id);
      if(original){
        const before=JSON.stringify([s.title,s.status,s.statusOrigin,s.managed,s.updatedAt]);
        s.title=original.title;
        const externalCodex=s.provider==='codex'&&!this.busy.has(s.id)&&!this.turns.has(s.nativeId)&&(original.statusOrigin==='native'||s.statusOrigin==='native');
        const submitted=this.nativeStarts.get(s.id);
        const awaitingNative=submitted!==undefined&&Date.now()-submitted<15000&&original.updatedAt<submitted&&!['running','waiting'].includes(original.status);
        if(!awaitingNative)this.nativeStarts.delete(s.id);
        if((!s.managed||externalCodex)&&!awaitingNative){
          s.status=original.status;s.statusOrigin=original.statusOrigin;
          s.activity=original.activity;
          if(externalCodex)s.managed=false;
          s.updatedAt=Math.max(s.updatedAt,original.updatedAt);
        }
        if(before!==JSON.stringify([s.title,s.status,s.statusOrigin,s.managed,s.updatedAt]))this.store.save(s);
      }
      all.set(s.id,{...original,...s});
    }
    const inputs=this.store.queued(),peers=claudeSteerSessions(this.claudeHome());
    for(const s of all.values()){if(!s.managed)Object.assign(s,this.nativeSettings.get(s.id));s.pendingIds=inputs.filter(a=>a.sessionId===s.id).map(a=>a.id);s.pendingCount=s.pendingIds.length;s.canSteer=this.canSteer(s,peers);s.canStop=this.canStop(s);s.canSetPermissions=s.managed||s.provider==='codex'||!this.history.claudeIsRunning(s.nativeId);s.questionCount=this.questions.list(s.id).length;}
    for(const s of [...all.values()].filter(s=>s.provider==='codex'&&!s.managed&&['running','waiting'].includes(s.status)).slice(0,20))void this.codexDesktop.watch(s.nativeId).catch(()=>{});
    return [...all.values()];
  }
  private canSteer(s:Session,peers?:Set<string>):boolean{
    if(s.provider==='api')return this.apiRuns.has(s.id)&&['running','waiting'].includes(s.status);
    if(s.provider==='claude')return s.managed?this.claude.has(s.id)&&['running','waiting'].includes(s.status):(peers??claudeSteerSessions(this.claudeHome())).has(s.nativeId);
    return ['running','waiting'].includes(s.status)&&(s.managed?this.turns.has(s.nativeId):this.codexDesktop.available(s.nativeId));
  }
  private canStop(s:Session):boolean{
    return ['running','waiting'].includes(s.status)&&(s.managed?this.busy.has(s.id)||this.claude.has(s.id)||this.turns.has(s.nativeId):s.provider==='codex'&&this.codexDesktop.available(s.nativeId));
  }
  private sharedProjects():Project[]{if(this.config.service!=='brainstorm'||!this.config.projectSourceDataDir)return [];let db:DatabaseSync|undefined;try{db=new DatabaseSync(join(this.config.projectSourceDataDir,'bridge.sqlite'),{readOnly:true});return db.prepare('SELECT json FROM local_projects').all().map(r=>JSON.parse(String(r.json))).filter(p=>!p.id.startsWith('brainstorm-'));}catch{return [];}finally{db?.close();}}
  projects():Project[]{return [...this.sharedProjects(),...this.config.projects.map(p=>({...p,source:p.source??'configured' as const,roots:p.roots??[p.path]})),...this.store.projects(),...(this.config.discoverCodexProjects===false?[]:this.history.projectIndex.projects)];}
  private roots():string[]{return this.projects().flatMap(p=>p.roots??[p.path]).filter(Boolean);}
  private save(s:Session){if(this.closed)return;s.updatedAt=Date.now();s.pendingIds=this.store.queued().filter(a=>a.sessionId===s.id).map(a=>a.id);s.pendingCount=s.pendingIds.length;s.canSteer=this.canSteer(s);s.canStop=this.canStop(s);s.canSetPermissions=s.managed||s.provider==='codex'||!this.history.claudeIsRunning(s.nativeId);this.managed.set(s.id,s);this.store.save(s);this.onSessions([s]);}
  private event(s:Session,type:RelayEvent['type'],data:Record<string,any>){if(this.closed)return;if(type==='message'&&!data.images&&imageSources(data).length)data=messageImages(this.media,s.id,s.cwd,data as any,data);const event:RelayEvent={id:randomUUID(),hostId:this.config.hostId,sessionId:s.id,type,data,at:Date.now()};this.store.event(event);this.onEvent(event);}
  private status(s:Session,status:Session['status']){const prior=s.status;s.status=status;if(status==='waiting')s.activity={kind:'waiting',label:'等待你确认'};else if(status!=='running')s.activity=undefined;else if(!s.activity||prior!=='running')s.activity={kind:'thinking',label:'正在思考'};this.save(s);this.event(s,'status',{status,activity:s.activity??null});}
  private activity(s:Session,activity:Activity){if(!['running','waiting'].includes(s.status)||JSON.stringify([s.activity?.kind,s.activity?.label,s.activity?.detail])===JSON.stringify([activity.kind,activity.label,activity.detail]))return;s.activity={...activity,at:Date.now()};this.save(s);this.event(s,'activity',s.activity);}
  private delta(s:Session,messageId:string,text:string){const key=s.id+':'+messageId;const old=this.deltaBuffer.get(key);this.deltaBuffer.set(key,{sessionId:s.id,messageId,text:(old?.text ?? '')+text});}
  private flush(){for(const value of this.deltaBuffer.values()){const s=this.managed.get(value.sessionId);if(s)this.event(s,'delta',{messageId:value.messageId,text:value.text});}this.deltaBuffer.clear();}
  private async approve(s:Session,label:string,details:unknown,signal?:AbortSignal,nativeKey?:string):Promise<{allow:boolean;remember:boolean}>{
    const id=randomUUID();this.status(s,'waiting');
    if(nativeKey)this.nativeApprovals.set(nativeKey,id);
    this.event(s,'approval',{approvalId:id,label,details:imageSafeJson(details).slice(0,24000),expiresAt:Date.now()+600_000,rememberLabel:s.provider!=='codex'?'本会话允许此工具，不再询问':'本会话不再询问此操作',rememberDescription:s.provider!=='codex'?`仅在当前会话内允许 ${label} 工具；其他会话仍单独确认`:'使用 Codex 本机会话批准范围，不写入全局授权'});
    return new Promise(resolve=>{
      const finish=(allow:boolean,remember=false)=>{const p=this.approvals.get(id);if(!p)return;clearTimeout(p.timer);this.approvals.delete(id);signal?.removeEventListener('abort',abort);if(!nativeKey)this.event(s,'approval.resolved',{approvalId:id,allow,remember:allow&&remember});if(s.status==='waiting')this.status(s,'running');resolve({allow,remember:allow&&remember});};
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
  private get(id:string):Session{const s=this.managed.get(id)??this.history.get(id);if(!s)throw new Error('Unknown local session');if(!s.managed)Object.assign(s,this.nativeSettings.get(id));return s;}
  private refreshNativeSettings(s:Session,force=false):Promise<void>{
    const prior=this.nativeSettingsReads.get(s.id);if(prior)return prior;
    if(!force&&Date.now()-(this.nativeSettingsAt.get(s.id)??0)<10000)return Promise.resolve();
    this.nativeSettingsAt.set(s.id,Date.now());
    const read=(async()=>{
      let settings={...this.history.settings(s.id)},error:string|undefined;
      if(s.provider==='codex')try{const live=await this.codexDesktop.readSettings(s.nativeId);if(live)settings={...settings,...live};}catch{error='无法读取桌面当前设置';}
      if(s.provider==='codex'&&settings.effort==='default')try{
        await this.codex.start();const config=await this.codex.call('config/read',{cwd:s.cwd,includeLayers:false});
        if(typeof config.config?.model_reasoning_effort==='string')settings.effort=config.config.model_reasoning_effort;
      }catch{/* Keep unresolved metadata explicit. */}
      const current=this.managed.get(s.id)??this.history.get(s.id)??s;
      if(this.closed||current.managed)return;
      this.nativeSettings.set(s.id,settings);Object.assign(s,settings,{settingsError:error});
      this.onSessions([{...current,...settings,settingsError:error}]);
    })().finally(()=>this.nativeSettingsReads.delete(s.id));
    this.nativeSettingsReads.set(s.id,read);return read;
  }
  directScope(action:Action){
    if(action.sessionId){const s=this.get(action.sessionId);assertProjectPath(s.cwd,this.roots());return this.config.hostId+'|'+s.id;}
    const project=this.projects().find(p=>p.id===action.projectId);if(!project)throw new Error('项目不存在');assertProjectPath(project.path,this.roots());return this.config.hostId+'|project:'+project.id;
  }
  private syncAsyncQuestions(s:Session){
    const active=new Set<string>();
    for(const request of this.history.asyncQuestions(s.id)){
      const source='async:'+request.sourceId;active.add(source);
      this.questions.attach(s.id,source,request.questions,async answers=>{
        if(!this.history.asyncQuestions(s.id).some(q=>q.sourceId===request.sourceId))throw new Error('问题已在本机回答或失效，请刷新');
        const replies=request.questions.map((q,index)=>({questionItemId:JSON.stringify(['request_user_input_async',request.sourceId,q.sourceIndex??index]),question:q.question,answer:answers[q.id].join(', ')}));
        const text='<send_user_message_question_reply>\n'+JSON.stringify(replies)+'\n</send_user_message_question_reply>',id=randomUUID(),input=[{type:'text',text,text_elements:[]}];
        this.list();const current=this.get(s.id);
        if(['running','waiting'].includes(current.status))await this.codexDesktop.steer(s.nativeId,id,text,input);else await this.codexDesktop.startTurn(s.nativeId,id,text,input);
        this.event(s,'message',{id,role:'user',text:replies.map(r=>r.question+'\n'+r.answer).join('\n\n'),timestamp:Date.now()});
      });
    }
    this.questions.reconcile(s.id,'async:',active);
  }
  async askClaudeNative(nativeId:string,cwd:string,toolId:string,input:any,signal:AbortSignal){
    if(!/^[a-f0-9-]{36}$/i.test(nativeId)||typeof cwd!=='string'||typeof toolId!=='string'||toolId.length>200)throw new Error('无效本地提问');
    assertProjectPath(cwd,this.roots());this.list();const id=sessionKey(this.config.hostId,'claude',nativeId);
    let s=this.managed.get(id)??this.history.get(id);if(s&&s.cwd.toLowerCase()!==cwd.toLowerCase())throw new Error('会话目录不匹配');
    if(!s){s={id,hostId:this.config.hostId,provider:'claude',nativeId,cwd,title:'Claude 正在等待回答',status:'waiting',updatedAt:Date.now()};this.save(s);}
    const questions=normalizeQuestions(input.questions,'claude');this.status(s,'waiting');
    const answers=await this.questions.ask(s.id,'claude-hook:'+toolId,questions,signal);if(!answers)return undefined;
    return Object.fromEntries(questions.map(q=>[q.question,answers[q.id].join(', ')]));
  }
  private claudeExecutable(){return this.config.claudeCommand ?? (process.platform==='win32'?join(homedir(),'.local','bin','claude.exe'):'claude');}
  private claudeHome(){return this.history.claudeHome;}
  async models(provider:Provider,agentId?:string):Promise<AgentModel[]>{
    if(provider==='api')return this.agents.get(agentId).models;
    this.agents.enabled(provider);
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
  private async checkModel(provider:Provider,model?:string,effort?:string,agentId?:string){if(!model&&!effort)return;const list=await this.models(provider,agentId),selected=list.find(m=>m.id===model||m.aliases?.includes(model??''))??(!model?list.find(m=>m.isDefault)??list[0]:undefined);if(!selected)throw new Error('该模型不在本机 Agent 返回的列表中，请刷新后重选');if(effort&&effort!=='default'&&!selected.efforts?.includes(effort))throw new Error('该模型不支持此思考强度，请重新选择');}
  async commands(s:Session):Promise<AgentCommand[]>{
    const base:AgentCommand[]=[{name:'help',description:'查看可用命令',source:'relay'},{name:'usage',description:'查询账号额度与重置时间，不打断任务',source:'relay'},{name:'stop',description:'停止当前任务并取消排队；独立 Claude 窗口需在电脑上停止',source:'relay'},{name:'model',description:'设置下一轮模型',argumentHint:'<模型 ID>',source:'relay'},{name:'effort',description:'设置下一轮思考强度',argumentHint:'<low|medium|high|xhigh|max|default>',source:'relay'}];
    if(s.provider!=='claude')return base;
    base.unshift({name:'btw',description:'基于会话上下文单独旁问，不打断主任务',argumentHint:'<问题>',source:'relay'});
    let cached=this.commandCatalogs.get(s.cwd);if(cached&&Date.now()-cached.at<600000)return [...base,...cached.commands.filter(c=>!base.some(b=>b.name===c.name))];
    let release!:()=>void;const gate=new Promise<void>(r=>release=r);async function* input():AsyncGenerator<SDKUserMessage>{await gate;}
    const active=query({prompt:input(),options:{cwd:s.cwd,pathToClaudeCodeExecutable:this.claudeExecutable(),persistSession:false,settingSources:['user','project','local'],permissionMode:'default'}});
    try{const list=await active.supportedCommands();const commands=list.filter(c=>!c.name.startsWith('__')).map(c=>({name:c.name,description:c.description,argumentHint:c.argumentHint,source:'claude' as const}));this.commandCatalogs.set(s.cwd,{at:Date.now(),commands});return [...base,...commands.filter(c=>!base.some(b=>b.name===c.name))];}finally{release();active.close();}
  }
  private async usage(s:Session):Promise<string>{
    if(s.provider==='api')throw Error('Usage is available from the model provider console; no balance API is configured');
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
      if(handled.has(a.sessionId!))continue;handled.add(a.sessionId!);let s=this.get(a.sessionId!);
      if(s.provider==='codex'&&!s.managed&&!this.busy.has(s.id)){await this.history.refreshSessionStatus(s.id);this.list();s=this.get(s.id);}
      if(s.provider==='claude'&&!s.managed){const live=this.history.claudeLiveStatus(s.nativeId);s.status=live??'idle';if(live&&live!=='idle'&&!claudeSteerSessions(this.claudeHome()).has(s.nativeId))continue;}
      if((this.nativeWriterWait.get(s.id)??0)>Date.now()&&!this.codexDesktop.available(s.nativeId))continue;
      if(this.stopping.has(s.id)||this.steering.has(s.id)||this.busy.has(s.id)||['running','waiting'].includes(s.status))continue;
      this.store.inputState(a.id,'dispatching');
      try{await this.handle(a,true);this.store.inputState(a.id,'sent');}catch(e){
        if(e instanceof SteerDeliveryError&&e.uncertain){this.store.inputState(a.id,'unknown');this.event(s,'message',{id:a.id,role:'user',label:'你 · 投递待确认',text:a.text!,files:this.attached(a).files.map(f=>f.file)});this.event(s,'error',{message:'续聊投递结果未知，请查看本地会话，勿重复发送'});}
        else if(s.provider==='codex'&&(codexWriterConflict(e)||/already.*(?:running|progress)|current turn|active turn|no-client-found|未找到本地 Codex/i.test((e as Error).message)))this.store.inputState(a.id,'queued');
        else{this.store.inputState(a.id,'failed');this.event(s,'error',{message:'排队消息未执行：'+(e as Error).message});}
        this.save(this.get(s.id));
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
    if(action.type==='start')this.agents.enabled(action.provider!,action.agentId);
    if(action.type==='send'){const current=this.get(action.sessionId!);if(!action.text?.trimStart().startsWith('/'))this.agents.enabled(current.provider,current.agentId);}
    if(action.type==='prepare-brainstorm'){const p=this.projects().find(p=>p.id===action.projectId);if(!p)throw Error('工程不存在');const source=assertProjectPath((p.roots??[p.path])[action.workspaceIndex??0],this.roots());return {project:prepareBrainstorm(this.store,this.config.dataDir,action.workspaceId!,source)};}
    if(action.type==='prepare-workspace'){const project=this.projects().find(p=>p.id===action.projectId);if(!project)throw Error('工程不在本机允许范围内');assertProjectPath((project.roots??[project.path])[action.workspaceIndex??0],this.roots());const workspace=await prepareStudioWorkspace(this.store,this.config.dataDir,project,action.workspaceIndex??0,action.workspaceId!,action.includeCaptures);for(const id of action.attachmentIds??[])this.files.link(this.config.hostId+'|project:'+project.id,this.config.hostId+'|project:'+workspace.project.id,id);return {workspace};}
    if(action.type==='create-project')return {project:createLocalProject(this.store,action)};
    if(action.type==='set-permissions'){
      const s=this.get(action.sessionId!);assertProjectPath(s.cwd,this.roots());const mode=action.permissionMode!;
      if(!s.managed&&s.provider==='claude'&&this.history.claudeIsRunning(s.nativeId))throw new Error('独立 Claude 窗口的权限需在电脑上修改；网页启动的 Claude 支持切换');
      if(!s.managed&&s.provider==='codex')await this.codexDesktop.setPermissions(s.nativeId,mode,s.cwd);
      const active=this.claude.get(s.id),running=['running','waiting'].includes(s.status)||this.busy.has(s.id);
      if(active){await active.query.setPermissionMode(claudePermissions(mode).permissionMode);s.permissionMode=mode;s.nextPermissionMode=undefined;}
      else if(running)s.nextPermissionMode=mode;
      else{s.permissionMode=mode;s.nextPermissionMode=undefined;}
      if(!s.nextPermissionMode)s.permissionLabel=undefined;
      this.save(s);return {ok:true,queued:!active&&running,permissionMode:mode};
    }
    if(action.sessionId&&this.stopping.has(action.sessionId)&&['send','steer','stop'].includes(action.type))throw new Error('正在停止当前任务，请稍候');
    if(action.type==='answer'){this.get(action.sessionId!);await this.questions.answer(action.sessionId!,action.questionId!,action.answers);return {ok:true};}
    if(action.type==='upload'){
      const payload=action.upload!,prefix=this.config.hostId+'|';if(!payload.scope.startsWith(prefix))throw new Error('附件设备不匹配');
      const scope=payload.scope.slice(prefix.length);
      if(scope.startsWith('project:')){const p=this.projects().find(p=>p.id===scope.slice(8));if(!p)throw new Error('项目不存在');assertProjectPath(p.path,this.roots());}
      else assertProjectPath(this.get(scope).cwd,this.roots());
      return {file:this.files.import(payload)};
    }
    if(['start','send'].includes(action.type)&&action.attachmentIds?.length){if(action.text?.trimStart().startsWith('/'))throw new Error('附件请随普通消息发送，不能与 / 命令混用');this.attached(action);if(action.type==='send'){const session=this.get(action.sessionId!);if(session.projectId?.startsWith('studio-'))for(const id of action.attachmentIds)this.files.link(this.config.hostId+'|'+session.id,this.config.hostId+'|project:'+session.projectId,id);}}
    if(action.type==='models')return {models:await this.models(action.provider!,action.agentId)};
    if(action.type==='studio-video'){const s=this.get(action.sessionId!),project=this.store.projects().find(p=>p.id===s.projectId);if(!project)throw Error('视频只能从已登记的工作副本读取');return studioVideo(s,action.artifactPath!,project.path,action.videoOffset,action.videoLength,action.videoVersion);}
    if(action.type==='studio-artifact'){const s=this.get(action.sessionId!),project=this.store.projects().find(p=>p.id===s.projectId);if(!project)throw Error('原画只能从已登记的需求工作副本读取');assertProjectPath(s.cwd,[project.path]);return studioArtifact(this.media,s,action.artifactPath!,project.path,action.artifactHash);}
    if(action.type==='asset'){this.get(action.sessionId!);return this.media.payload(action.sessionId!,action.assetId!);}
    if(action.type==='file'){const scope=this.directScope(action),{file,bytes}=this.files.read(scope,action.fileId!);return {scope,file,data:bytes.toString('base64')};}
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
        if(s.provider==='api'){
          const active=this.apiRuns.get(s.id);if(!active)throw Error('Current API turn is no longer running');active.runner.stop();await active.promise;
          if(this.cancelled.has(s.id))throw Error('Steering was cancelled');
          const result=await this.handle(input,true);this.store.inputState(input.id,'sent');this.save(this.get(s.id));return {...result,steered:true,mode:'interrupt-resume'};
        }
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
      let s=this.get(action.sessionId!);if(s.provider==='codex'){if(!fromQueue&&!s.managed&&!this.busy.has(s.id))await this.history.refreshSessionStatus(s.id);this.list();s=this.get(action.sessionId!);}assertProjectPath(s.cwd,this.roots());
      const live=s.provider==='claude'&&!s.managed?this.history.claudeLiveStatus(s.nativeId):undefined;
      if(s.provider==='claude'&&!s.managed){s.status=live??'idle';s.statusOrigin='native';}
      if(!fromQueue&&(this.steering.has(s.id)||this.busy.has(s.id)||['running','waiting'].includes(s.status)||this.store.queued().some(a=>a.sessionId===s.id))){
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
      if(s.provider==='codex'&&!s.managed&&await this.codexDesktop.owner(s.nativeId)){
        const pendingModel=s.nextModel,pendingEffort=s.nextEffort,model=action.model??pendingModel,effort=action.effort??pendingEffort;
        await this.checkModel(s.provider,model,effort);
        this.busy.add(s.id);
        try{
          const prepared=this.attached(action);
          if(s.nextPermissionMode)await this.codexDesktop.setPermissions(s.nativeId,s.nextPermissionMode,s.cwd);
          await this.codexDesktop.startTurn(s.nativeId,action.id,prepared.text,prepared.input,{model,...effort?{effort:effort==='default'?null:effort}:{}});
          this.nativeStarts.set(s.id,Date.now());
          this.nativeSettings.set(s.id,{...this.nativeSettings.get(s.id),...model&&{model},...effort&&{effort},settingsSource:'desktop'});
          if(s.nextPermissionMode)s.permissionMode=s.nextPermissionMode;s.nextPermissionMode=undefined;
          // A preference saved while start-turn was awaiting acknowledgement
          // belongs to the following turn, not the one we just submitted.
          if(s.nextModel===pendingModel&&s.nextEffort===pendingEffort){s.nextModel=undefined;s.nextEffort=undefined;}
          s.statusOrigin='native';this.status(s,'running');
          this.event(s,'message',{id:action.id,role:'user',text:action.text!,files:prepared.files.map(f=>f.file)});
          return {ok:true,sessionId:s.id,native:true};
        }catch(error){
          if(!fromQueue&&(codexWriterConflict(error)||/already.*(?:running|progress)|current turn|active turn/i.test((error as Error).message))){
            this.store.enqueue(action);this.save(s);this.event(s,'message',{id:action.id,role:'user',label:'你 · 已排队',text:action.text!,files:this.attached(action).files.map(f=>f.file)});return {ok:true,sessionId:s.id,queued:true,external:true};
          }
          throw error;
        }finally{this.busy.delete(s.id);}
      }
    }
    if(action.type==='set-model'){
      const s=this.get(action.sessionId!);assertProjectPath(s.cwd,this.roots());
      const model=action.model??s.nextModel??s.model;
      await this.checkModel(s.provider,model,action.effort,s.agentId);
      // Native conversations may have no open desktop owner. Store a durable
      // next-turn preference without opening a writer or depending on its UI.
      if(s.provider==='codex'&&!s.managed||this.busy.has(s.id)||['running','waiting'].includes(s.status)){s.nextModel=model;s.nextEffort=action.effort??(action.model&&action.model!==s.model?'default':s.nextEffort??s.effort);this.save(s);return {ok:true,queued:true,model:s.nextModel,effort:s.nextEffort};}
      const chosenEffort=action.effort??(action.model&&action.model!==s.model?'default':s.nextEffort??s.effort);
      const updated={...s,model,effort:chosenEffort==='default'&&s.managed?undefined:chosenEffort,nextModel:undefined,nextEffort:undefined};this.save(updated);return {ok:true,model:updated.model,effort:updated.effort};
    }
    if(action.type==='history'){
      if(action.live)this.history.refreshFocusedStatus(action.sessionId!);
      this.list();
      const s=this.get(action.sessionId!);
      if(action.live&&!['running','waiting'].includes(s.status)&&this.store.queued().some(a=>a.sessionId===s.id))void this.drainInputs().catch(()=>{});
      if(s.provider==='api')return {...this.store.apiPage(s.id,action.cursor),session:s,questions:this.questions.list(s.id),questionsAsOf:Date.now()};
      if(!s.managed){
        if(action.live){Object.assign(s,this.history.settings(s.id),this.nativeSettings.get(s.id));void this.refreshNativeSettings(s).catch(()=>{});}
        else await this.refreshNativeSettings(s,true);
      }
      this.onSessions([s]);
      if(s.provider==='codex'&&!s.managed){void this.codexDesktop.watch(s.nativeId).catch(()=>{});this.syncAsyncQuestions(s);}
      if(!this.history.get(action.sessionId!)&&this.managed.has(action.sessionId!))return {messages:[],cursor:null,source:'连接程序管理的实时会话',questions:this.questions.list(s.id),questionsAsOf:Date.now()};
      return {...await this.history.page(action.sessionId!,action.cursor),questions:this.questions.list(s.id),questionsAsOf:Date.now()};
    }
    if(action.type==='approve'){
      const p=this.approvals.get(action.approvalId!);if(!p||p.sessionId!==action.sessionId)throw new Error('Approval expired or belongs to another session');const delivery=this.nativeApprovalDelivery.get(action.approvalId!);p.resolve(action.allow!,action.approvalScope==='session');if(delivery)await delivery;return {ok:true};
    }
    if(action.type==='stop'){
      const s=this.get(action.sessionId!);assertProjectPath(s.cwd,this.roots());
      const active=['running','waiting'].includes(s.status)||this.busy.has(s.id);
      if(!action.queueOnly&&active&&!s.managed&&s.provider==='claude')throw new Error('这个独立 Claude 窗口尚未提供远程停止接口，请在电脑上按 Esc；网页启动的 Claude 任务支持停止');
      this.stopping.add(s.id);
      try{
      // Stop delivery must be acknowledged before changing native state or
      // cancelling queued input; a failed request must never look successful.
      if(!action.queueOnly&&!s.managed&&s.provider==='codex'){
        const result=await this.codexDesktop.interrupt(s.nativeId);
        this.nativeStarts.delete(s.id);
        if(result.goalPauseError)this.event(s,'error',{message:'当前任务已停止，但目标暂停失败：'+result.goalPauseError});
      }
      for(const a of this.store.queued())if(a.sessionId===s.id){this.store.inputState(a.id,'cancelled');this.event(s,'message',{id:a.id,role:'user',label:'你 · 排队已取消',text:a.text!,files:this.attached(a).files.map(f=>f.file)});}s.pendingCount=0;this.save(s);
      if(action.queueOnly)return {ok:true,queueCancelled:true};
      this.questions.cancelSession(s.id);
      this.cancelled.add(s.id);
      this.apiRuns.get(s.id)?.runner.stop();
      if(!s.managed)return {ok:true,external:true,stopRequested:active};
      for(const p of this.approvals.values())if(p.sessionId===s.id)p.resolve(false);
      const claude=this.claude.get(s.id);if(claude){claude.controller.abort();claude.query.close();}
      const turn=this.turns.get(s.nativeId);if(turn)await this.codex.call('turn/interrupt',{threadId:s.nativeId,turnId:turn});
      this.flush();this.status(s,'interrupted');return {ok:true};
      }finally{this.stopping.delete(s.id);}
    }
    let session:Session;let nativeResume=false;
    if(action.type==='start'){
      const project=this.projects().find(x=>x.id===action.projectId);if(!project)throw new Error('Project is not allowed by the local configuration');
      const workspace=(project.roots??[project.path])[action.workspaceIndex??0];if(!workspace)throw new Error('Unknown workspace in this project');
      const cwd=assertProjectPath(workspace,this.roots());
      await this.checkModel(action.provider!,action.model,action.effort,action.agentId);if(action.effort==='default')action.effort=undefined;
      if(action.provider==='api'){const agent=this.agents.get(action.agentId);action.model??=agent.models.find(m=>m.isDefault)?.id??agent.models[0].id;}
      let nativeId=randomUUID();
      if(action.provider==='codex') {
        await this.codex.start();const result=await this.codex.call('thread/start',{cwd,projectId:project.source==='codex'?project.nativeProjectId:undefined,model:action.model,...(({approvalPolicy,approvalsReviewer,sandbox})=>({approvalPolicy,approvalsReviewer,sandbox}))(codexPermissions(action.permissionMode,cwd))});nativeId=result.thread.id;this.loaded.add(nativeId);action.model=result.model??action.model;action.effort??=result.reasoningEffort??undefined;
      }
      session={id:sessionKey(this.config.hostId,action.provider!,nativeId),hostId:this.config.hostId,provider:action.provider!,nativeId,cwd,title:(action.text!.trim()||this.attached(action).files[0]?.file.name||'新会话').replace(/\s+/g,' ').slice(0,100),updatedAt:Date.now(),status:'idle',managed:true,model:action.model,effort:action.effort,permissionMode:action.permissionMode??'request',projectId:project.id,projectName:project.name,projectSource:project.source,statusOrigin:'relay'};
      if(session.provider==='api'){session.agentId=action.agentId;session.agentName=this.agents.get(action.agentId).name;}
      session.settingsSource='agent';this.save(session);
    } else {
      session=this.get(action.sessionId!);nativeResume=session.provider==='codex'&&!session.managed;assertProjectPath(session.cwd,this.roots());
      if(this.busy.has(session.id)||['running','waiting'].includes(session.status))throw new Error('Session is already running; wait or stop it before sending another turn');
      if(session.provider==='claude'&&!session.managed&&this.history.claudeIsRunning(session.nativeId))throw new Error('This Claude session is open in another local process. End that process before resuming here.');
      await this.checkModel(session.provider,action.model,action.effort,session.agentId);const pickedEffort=action.effort??session.nextEffort??session.effort;session={...session,managed:true,statusOrigin:'relay',permissionMode:session.nextPermissionMode??session.permissionMode??'request',nextPermissionMode:undefined,model:action.model??session.nextModel??session.model,effort:pickedEffort==='default'?undefined:pickedEffort,nextModel:undefined,nextEffort:undefined};this.save(session);
    }
    if(this.busy.has(session.id))throw new Error('A turn is already starting');
    this.busy.add(session.id);this.cancelled.delete(session.id);if(!nativeResume)this.status(session,'running');
    const prepared=this.attached(action);for(const f of prepared.files)this.files.link(prepared.scope,this.config.hostId+'|'+session.id,f.file.id);
    const userId=action.id;
    if(session.provider==='api'){
      this.event(session,'message',{id:userId,role:'user',text:action.text!,files:prepared.files.map(f=>f.file)});
      const runner=new ApiAgentRun(this.config.dataDir,session.nativeId),run=this.runApi(session,runner,prepared);this.apiRuns.set(session.id,{runner,promise:run});this.save(session);void run.finally(()=>{if(this.apiRuns.get(session.id)?.runner===runner)this.apiRuns.delete(session.id);});
    }else if(session.provider==='codex'){
      try {
        await this.codex.start();
        if(!this.loaded.has(session.nativeId)) {const restored=await this.codex.call('thread/resume',{threadId:session.nativeId,excludeTurns:true,cwd:session.cwd,model:session.model,...(({approvalPolicy,approvalsReviewer,sandbox})=>({approvalPolicy,approvalsReviewer,sandbox}))(codexPermissions(session.permissionMode,session.cwd))});session.model=restored.model??session.model;this.save(session);this.loaded.add(session.nativeId);}
        if(this.cancelled.has(session.id))return {ok:true,sessionId:session.id,interrupted:true};
        const result=await this.codex.call('turn/start',{threadId:session.nativeId,model:session.model,effort:session.effort,clientUserMessageId:userId,input:prepared.input,...(({approvalPolicy,approvalsReviewer,sandboxPolicy})=>({approvalPolicy,approvalsReviewer,sandboxPolicy}))(codexPermissions(session.permissionMode,session.cwd))});
        if(nativeResume){this.nativeWriterWait.delete(session.id);this.status(session,'running');}
        this.event(session,'message',{id:userId,role:'user',text:action.text!,files:prepared.files.map(f=>f.file)});
        if(['running','waiting'].includes(session.status))this.turns.set(session.nativeId,result.turn.id);
        if(this.cancelled.has(session.id))await this.codex.call('turn/interrupt',{threadId:session.nativeId,turnId:result.turn.id});
      } catch(err) {
        if(action.type==='send'&&codexWriterConflict(err)){
          this.nativeWriterWait.set(session.id,Date.now()+60000);
          const native=this.history.list(true).find(s=>s.id===session.id);
          session.managed=false;session.statusOrigin='native';session.title=native?.title??session.title;
          this.status(session,native?.statusOrigin==='native'?native.status:'idle');
          if(!fromQueue){this.store.enqueue(action);this.save(session);this.event(session,'message',{id:userId,role:'user',label:'你 · 已排队',text:action.text!,files:prepared.files.map(f=>f.file)});return {ok:true,sessionId:session.id,queued:true,external:true};}
          throw err;
        }
        this.status(session,'failed');this.event(session,'error',{message:(err as Error).message});throw err;
      }
      finally {this.busy.delete(session.id);}
    } else {this.event(session,'message',{id:userId,role:'user',text:action.text!,files:prepared.files.map(f=>f.file)});const run=this.runClaude(session,prepared.text,action.type!=='start',userId,prepared.files.length?prepared.content:undefined,action.brainstormContext);this.claudeRuns.set(session.id,run);void run.finally(()=>{if(this.claudeRuns.get(session.id)===run)this.claudeRuns.delete(session.id);});}
    return {ok:true,sessionId:session.id};
  }
  private async runApi(s:Session,runner:ApiAgentRun,prepared:ReturnType<AgentRuntime['attached']>){
    try{
      const agent=this.agents.get(s.agentId),imageParts=prepared.files.filter(f=>f.file.mime.startsWith('image/')).map(f=>agent.protocol==='chat'?{type:'image_url',image_url:{url:`data:${f.file.mime};base64,${f.bytes.toString('base64')}`}}:{type:'input_image',image_url:`data:${f.file.mime};base64,${f.bytes.toString('base64')}`});
      const content=imageParts.length?[{type:agent.protocol==='chat'?'text':'input_text',text:prepared.text},...imageParts]:prepared.text;
      await runner.run(agent,s.model!,s.effort,s.cwd,content,s.permissionMode??'request',{
        delta:(id,text)=>this.delta(s,id,text),message:m=>{this.flush();this.event(s,'message',m);},activity:(label,detail)=>this.activity(s,{kind:'tool',label,detail}),
        approve:async(name,input,signal)=>{if(s.approvedTools?.includes(name))return true;const decision=await this.approve(s,name,input,signal);if(decision.allow&&decision.remember){s.approvedTools=[...new Set([...(s.approvedTools??[]),name])];this.save(s);}return decision.allow;},
        ask:async(input,signal)=>{this.status(s,'waiting');return await this.questions.ask(s.id,'api:'+randomUUID(),normalizeQuestions(input.questions,'codex'),signal);}
      });this.flush();this.status(s,runner.controller.signal.aborted?'interrupted':'idle');
    }catch(e){this.flush();if(!runner.controller.signal.aborted)this.event(s,'error',{message:(e as Error).message});this.status(s,runner.controller.signal.aborted?'interrupted':'failed');}
    finally{this.questions.cancelSession(s.id);this.busy.delete(s.id);for(const p of this.approvals.values())if(p.sessionId===s.id)p.resolve(false);}
  }
  private async runClaude(s:Session,text:string,resume:boolean,userId:string,content?:any[],brainstormContext?:string){
    const controller=new AbortController();
    let finished:Session['status']|undefined;
    try {
      const executable=this.claudeExecutable();
      async function* prompt():AsyncGenerator<SDKUserMessage>{yield {type:'user',uuid:userId as `${string}-${string}-${string}-${string}-${string}`,session_id:s.nativeId,parent_tool_use_id:null,message:{role:'user',content:content??text}};}
      const active=this.claudeQuery({prompt:prompt(),options:{...(brainProject.test(s.projectId??'')?{systemPrompt:{type:'preset' as const,preset:'claude_code' as const,append:brainstormInstructions+'\n当前项目组上下文：\n'+(brainstormContext??'')},tools:['AskUserQuestion'],allowedTools:['mcp__brainstorm__project_context','mcp__brainstorm__generate_image','mcp__brainstorm__propose_task'],mcpServers:{brainstorm:brainstormTools(s,this.media,this.config.codexCommand??'codex',this.config.codexArgs,controller.signal,m=>{this.flush();this.event(s,'message',m);},this.store)}}:{}),cwd:s.cwd,model:s.model,effort:s.effort as 'low'|'medium'|'high'|'xhigh'|'max'|undefined,pathToClaudeCodeExecutable:executable,abortController:controller,...claudePermissions(s.permissionMode),allowDangerouslySkipPermissions:true,permissionPrompts:'host',includePartialMessages:true,env:{...process.env,AGENT_RELAY_MANAGED:'1'},settingSources:['user','project','local'],...(resume?{resume:s.nativeId}:{sessionId:s.nativeId}),canUseTool:async(name,input,context)=>{
        if(name==='AskUserQuestion'){
          const questions=normalizeQuestions(input.questions,'claude');this.status(s,'waiting');
          const answers=await this.questions.ask(s.id,'claude:'+context.toolUseID,questions,context.signal);
          return answers?{behavior:'allow' as const,updatedInput:{...input,answers:Object.fromEntries(questions.map(q=>[q.question,answers[q.id].join(', ')]))}}:{behavior:'deny' as const,message:'用户问题已取消，未自动选择答案'};
        }
        if(s.approvedTools?.includes(name))return {behavior:'allow' as const,updatedInput:input};
        const decision=await this.approve(s,name,input,context.signal);
        if(decision.allow&&decision.remember){s.approvedTools=[...new Set([...(s.approvedTools??[]),name])];this.save(s);}
        return decision.allow?{behavior:'allow' as const,updatedInput:input,...decision.remember?{updatedPermissions:[{type:'addRules' as const,rules:[{toolName:name}],behavior:'allow' as const,destination:'session' as const}]}:{}}:{behavior:'deny' as const,message:'Denied by the remote operator or approval timed out'};
      }}});
      this.claude.set(s.id,{query:active,controller});this.save(s);let currentMessage='';
      for await(const msg of active){
        const progress=msg as any;
        if(progress.type==='system'&&progress.subtype==='init'){Object.assign(s,claudeSettings(progress),{settingsSource:'agent'});this.save(s);}
        if(progress.type==='tool_progress')this.activity(s,toolActivity(String(progress.tool_name??'工具')));
        if(progress.type==='user'&&progress.message?.content?.some?.((b:any)=>b.type==='tool_result'))this.activity(s,{kind:'thinking',label:'正在思考'});
        if(msg.type==='stream_event') {
          const e=msg.event;
          if(e.type==='content_block_start')this.activity(s,e.content_block.type==='tool_use'?toolActivity(e.content_block.name):e.content_block.type==='thinking'?{kind:'thinking',label:'正在思考'}:{kind:'reply',label:'正在回复'});
          if(e.type==='message_start')currentMessage=e.message.id;
          if(e.type==='content_block_delta'&&e.delta.type==='text_delta')this.delta(s,`claude-stream:${currentMessage||msg.uuid}`,e.delta.text);
        } else if(msg.type==='assistant'){
          if(msg.message.model&&s.model!==msg.message.model){s.model=msg.message.model;s.settingsSource='agent';this.save(s);}
          this.flush();const content=msg.message.content;
          const text=content.filter(x=>x.type==='text').map(x=>x.text).join('\n');
          if(text||imageSources(content).length)this.event(s,'message',messageImages(this.media,s.id,s.cwd,{id:`claude-text:${msg.uuid}`,role:'assistant',text,replaces:[`claude-stream:${msg.message.id}`]} as any,msg.message));
          for(const block of content)if(block.type==='tool_use'){this.activity(s,toolActivity(block.name));this.event(s,'message',{id:`claude-tool:${block.id}`,role:'tool',label:block.name,text:imageSafeJson(block.input).slice(0,24000)});}
        } else if(msg.type==='result') {
          this.flush();if(msg.is_error)this.event(s,'error',{message:('errors' in msg?msg.errors.join('\n'):'Agent returned an error').slice(0,24000)});
          finished=s.status==='interrupted'?'interrupted':msg.is_error?'failed':'idle';
          active.close();break;
        }
      }
      finished??=controller.signal.aborted||s.status==='interrupted'?'interrupted':'idle';
    } catch(err) {if(!finished){if(controller.signal.aborted)finished='interrupted';else {this.event(s,'error',{message:(err as Error).message});finished='failed';}}}
    finally {this.questions.cancelSession(s.id);this.busy.delete(s.id);this.claude.get(s.id)?.query.close();this.claude.delete(s.id);for(const p of this.approvals.values())if(p.sessionId===s.id)p.resolve(false);this.status(s,finished??'failed');}
  }
  private async codexEvent(msg:any){
    const p=msg.params ?? {};const threadId=p.threadId ?? p.thread?.id;
    const s=[...this.managed.values()].find(s=>s.provider==='codex'&&s.nativeId===threadId);
    if(!s||!s.managed) {if(msg.id!==undefined)this.codex.send({id:msg.id,error:{code:-32601,message:'Unsupported request or unmanaged session'}});return;}
    if(msg.id!==undefined){
      if(['item/tool/requestUserInput','tool/requestUserInput'].includes(msg.method)){
        try{const questions=normalizeQuestions(p.questions,'codex');this.status(s,'waiting');const answers=await this.questions.ask(s.id,'codex:'+String(p.turnId??'')+':'+String(msg.id),questions,undefined,p.autoResolutionMs??undefined);this.codex.send({id:msg.id,result:{answers:Object.fromEntries(Object.entries(answers??{}).map(([id,values])=>[id,{answers:values}]))}});}
        catch(error){this.codex.send({id:msg.id,error:{code:-32602,message:(error as Error).message}});}
      }else if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(msg.method)) {
        const decision=await this.approve(s,msg.method,p);this.codex.send({id:msg.id,result:{decision:decision.allow?(decision.remember?'acceptForSession':'accept'):'decline'}});
      } else {this.codex.send({id:msg.id,error:{code:-32601,message:'This input type is not supported by Agent Relay yet; denied'}});this.event(s,'error',{message:`需要本机处理的请求：${msg.method}`});}
      return;
    }
    if(msg.method==='serverRequest/resolved'){const card=this.questions.list(s.id).find(q=>q.source.startsWith('codex:')&&q.source.endsWith(':'+String(p.requestId)));if(card)this.questions.cancel(card.id);}
    else if(msg.method==='turn/started'){this.turns.set(threadId,p.turn.id);if(!this.cancelled.has(s.id))this.status(s,'running');}
    else if(msg.method==='item/started'){const item=p.item??{};this.activity(s,item.type==='agentMessage'?{kind:'reply',label:'正在回复'}:item.type==='reasoning'?{kind:'thinking',label:'正在思考'}:toolActivity(String(item.type==='commandExecution'?'command':item.type==='fileChange'?'fileChange':item.tool??item.type??'工具')));}
    else if(msg.method==='turn/plan/updated'){const step=p.plan?.find((step:any)=>step.status==='inProgress'||step.status==='in_progress')?.step;if(typeof step==='string')this.activity(s,{kind:'plan',label:'正在执行',detail:step.replace(/\s+/g,' ').slice(0,150)});}
    else if(msg.method==='item/agentMessage/delta'){this.activity(s,{kind:'reply',label:'正在回复'});this.delta(s,p.itemId,p.delta);}
    else if(msg.method==='item/completed'){
      this.flush();const m=itemMessage(p.item,Date.now());if(m)this.event(s,'message',messageImages(this.media,s.id,s.cwd,m,p.item));
      if(p.item?.type!=='agentMessage')this.activity(s,{kind:'thinking',label:'正在思考'});
    } else if(msg.method==='turn/completed'){
      this.flush();this.turns.delete(threadId);this.status(s,p.turn.status==='completed'?'idle':p.turn.status==='interrupted'?'interrupted':'failed');
      this.questions.cancelSession(s.id);
      if(p.turn.error)this.event(s,'error',{message:p.turn.error.message ?? JSON.stringify(p.turn.error)});
      for(const a of this.approvals.values())if(a.sessionId===s.id)a.resolve(false);
    } else if(msg.method==='error')this.event(s,'error',{message:p.error?.message ?? 'Codex error'});
  }
  async close(){if(this.closed)return;this.closed=true;this.questions.close();for(const active of this.apiRuns.values())active.runner.stop();clearInterval(this.flushTimer);this.flush();for(const p of this.approvals.values())p.resolve(false);for(const v of this.claude.values()){v.controller.abort();v.query.close();}for(const q of this.sideQueries)q.close();for(const q of this.usageQueries)q.close();this.codexDesktop.close();this.codex.close();}
}
