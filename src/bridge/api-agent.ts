import {readFileSync,writeFileSync,mkdirSync,existsSync,renameSync,realpathSync} from 'node:fs';
import {readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {join,resolve,dirname,basename,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {assertProjectPath} from '../shared/security.js';
import type {ApiAgent} from './agents.js';
const definitions=[
  ['read_file','Read a UTF-8 project file',{path:{type:'string'}}],
  ['list_files','List one project directory',{path:{type:'string'}}],
  ['write_file','Write a UTF-8 file; its parent directory must already exist',{path:{type:'string'},content:{type:'string'}}],
  ['run_command','Run a shell command in the project directory; requires user approval unless full access',{command:{type:'string'}}],
  ['ask_user','Ask the user questions and wait for answers',{questions:{type:'array',items:{type:'object',properties:{id:{type:'string'},header:{type:'string'},question:{type:'string'},options:{type:'array',items:{type:'object',properties:{label:{type:'string'},description:{type:'string'}},required:['label']}}},required:['id','header','question','options']}}}]
] as const;
export const apiTools=definitions.map(([name,description,properties])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}}}));
export interface ApiCallbacks {delta:(id:string,text:string)=>void;message:(message:any)=>void;activity:(label:string,detail?:string)=>void;approve:(name:string,input:any,signal:AbortSignal)=>Promise<boolean>;ask:(input:any,signal:AbortSignal)=>Promise<any>}
function filePath(cwd:string,input:string,creating=false){if(typeof input!=='string'||input.length>2000)throw Error('Invalid path');const path=resolve(cwd,input);if(creating&&!existsSync(path)){assertProjectPath(dirname(path),[cwd]);return path;}return assertProjectPath(path,[cwd]);}
export async function executeApiTool(cwd:string,name:string,args:any,signal:AbortSignal,protectedPaths:string[]=[]){
  const checked=(input:string,create=false)=>{const path=filePath(cwd,input,create);if(/^\.env(?:\.|$)/i.test(basename(path))||protectedPaths.some(root=>{const part=relative(existsSync(root)?realpathSync.native(root):resolve(root),path);return part===''||!part.startsWith('..')&&!isAbsolute(part);}))throw Error('Agent Relay configuration and credential files are not available to project file tools');return path;};
  signal.throwIfAborted();if(name==='list_files')return (await readdir(checked(args.path||'.'),{withFileTypes:true})).slice(0,1000).map(f=>f.name+(f.isDirectory()?'/':'')).join('\n');
  if(name==='read_file'){const path=checked(args.path);if((await stat(path)).size>1024*1024)throw Error('File exceeds 1 MiB');return (await readFile(path,'utf8')).slice(0,128000);}
  if(name==='write_file'){if(typeof args.content!=='string'||args.content.length>256000)throw Error('File content exceeds limit');const path=checked(args.path,true);signal.throwIfAborted();await writeFile(path,args.content,'utf8');return 'File saved: '+args.path;}
  if(name!=='run_command'||typeof args.command!=='string'||args.command.length>8000)throw Error('Unknown tool or invalid command');
  const env=Object.fromEntries(['PATH','Path','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','HOME','USERPROFILE','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  return await new Promise<string>((done,reject)=>{
    const child=spawn(process.platform==='win32'?'powershell.exe':'/bin/sh',process.platform==='win32'?['-NoProfile','-NonInteractive','-Command',args.command]:['-c',args.command],{cwd,env,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});let output='',killed=false;
    const kill=()=>{killed=true;if(process.platform==='win32')spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('error',()=>child.kill());else try{process.kill(-child.pid!,'SIGKILL');}catch{child.kill();}};
    const timeout=setTimeout(kill,30000);signal.addEventListener('abort',kill,{once:true});
    child.stdout.on('data',b=>{if(output.length<24000)output+=b.toString().slice(0,24000-output.length);});child.stderr.on('data',b=>{if(output.length<24000)output+=b.toString().slice(0,24000-output.length);});
    const clean=()=>{clearTimeout(timeout);signal.removeEventListener('abort',kill);};child.once('error',e=>{clean();reject(e);});child.once('close',code=>{clean();if(signal.aborted)reject(signal.reason);else done(output+`\n[exit ${code}${killed?', timed out':''}]`);});
  });
}
async function* sse(response:Response){if(!response.body)throw Error('Empty streaming response');const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',size=0;try{while(true){const {value,done}=await reader.read();buffer+=decoder.decode(value,{stream:!done});size+=value?.length??0;if(size>8*1024*1024)throw Error('Model response exceeds 8 MiB');let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(line.startsWith('data:')){const raw=line.slice(5).trim();if(raw==='[DONE]')return;if(raw)yield JSON.parse(raw);}}if(done)break;}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
export class ApiAgentRun {
  readonly controller=new AbortController();
  constructor(readonly directory:string,readonly id:string){if(!/^[a-f0-9-]{36}$/i.test(id))throw Error('Invalid API session');}
  stop(){this.controller.abort(Error('Task stopped'));}
  async run(agent:ApiAgent,model:string,effort:string|undefined,cwd:string,content:any,permission:string,callbacks:ApiCallbacks){
    const signal=this.controller.signal,path=join(this.directory,'api-sessions',this.id+'.json');mkdirSync(dirname(path),{recursive:true,mode:0o700});
    const saved=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
    if(saved&&(saved.agentId!==agent.id||saved.protocol!==agent.protocol))throw Error('Agent identity or API protocol changed; start a new session');
    const messages:any[]=saved?.messages??[];
    const checkpoint=()=>{const temp=path+'.tmp';writeFileSync(temp,JSON.stringify({agentId:agent.id,protocol:agent.protocol,messages}),{mode:0o600});renameSync(temp,path);};
    // A stopped/crashed request may leave tool calls awaiting results. Never replay their effects.
    if(agent.protocol==='chat'){const last=messages.findLastIndex(m=>m.role==='assistant');if(last>=0)for(const call of messages[last].tool_calls??[])if(!messages.slice(last+1).some(m=>m.tool_call_id===call.id))messages.push({role:'tool',tool_call_id:call.id,content:'Previous operation interrupted; effects are unknown. Inspect state before retrying.'});}
    else {for(const call of messages.filter(m=>m.type==='function_call'))if(!messages.some(m=>m.type==='function_call_output'&&m.call_id===call.call_id))messages.push({type:'function_call_output',call_id:call.call_id,output:'Previous operation interrupted; inspect state before retrying.'});}
    const selected=agent.models.find(m=>m.id===model);if(!selected)throw Error('Model is not enabled in the desktop manager');
    if(Array.isArray(content)&&content.some(p=>p.type==='image_url'||p.type==='input_image')&&!selected.vision)throw Error('This model is not configured for image input; enable vision or choose another model');
    messages.push({role:'user',content});checkpoint();
    const system='You are a coding assistant running on the user workstation. Work in '+cwd+'. Use the supplied tools for actual operations. Respect user approvals and project boundaries. Do not claim an action succeeded without a tool result. Ask questions via ask_user. Shell commands are not OS-sandboxed; request only work needed for this task.';
    for(let turn=0;turn<24;turn++){
      if(messages.length>1000||Buffer.byteLength(JSON.stringify(messages))>4*1024*1024)throw Error('Conversation context exceeds the local limit; start a new conversation');
      signal.throwIfAborted();callbacks.activity('正在思考');const id=randomUUID(),tools=agent.protocol==='chat'?apiTools:apiTools.map(t=>({type:'function',...t.function}));
      const effortParams=!effort||effort==='default'||agent.reasoning==='none'?{}:agent.protocol==='responses'?{reasoning:{effort}}:{reasoning_effort:effort,...agent.reasoning==='thinking'?{thinking:{type:effort==='none'?'disabled':'enabled'}}:{}};
      const body=agent.protocol==='chat'?{model,messages:[{role:'system',content:system},...messages],stream:true,...agent.tools?{tools}:{},...effortParams}:{model,instructions:system,input:messages,stream:true,store:false,include:['reasoning.encrypted_content'],...agent.tools?{tools}:{},...effortParams};
      let response:Response;try{response=await fetch(agent.baseUrl+(agent.protocol==='chat'?'/chat/completions':'/responses'),{method:'POST',headers:{Authorization:'Bearer '+agent.apiKey,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(180000)]),redirect:'error'});}catch(e){if(signal.aborted)throw signal.reason;throw Error('Unable to reach the configured model endpoint');}
      if(!response.ok){await response.body?.cancel();throw Error(`Model request failed (HTTP ${response.status}); check the endpoint, key, model and protocol in the desktop manager`);}
      let text='',assistant:any={role:'assistant',content:''},output:any[]=[],complete=false;
      if(agent.protocol==='chat'){
        const calls=new Map<number,any>();for await(const part of sse(response)){if(part.error)throw Error('Model returned a streaming error');const choice=part.choices?.[0],delta=choice?.delta??{};if(delta.content){text+=delta.content;callbacks.activity('正在回复');callbacks.delta(id,delta.content);}if(delta.reasoning_content)assistant.reasoning_content=(assistant.reasoning_content??'')+delta.reasoning_content;for(const call of delta.tool_calls??[]){const old=calls.get(call.index)??{id:'',type:'function',function:{name:'',arguments:''}};if(call.id)old.id=call.id;if(call.function?.name)old.function.name+=call.function.name;old.function.arguments+=call.function?.arguments??'';calls.set(call.index,old);}if(choice?.finish_reason){if(!['stop','tool_calls'].includes(choice.finish_reason))throw Error('Model response was incomplete ('+choice.finish_reason+')');complete=true;}}
        assistant.content=text||null;if(calls.size)assistant.tool_calls=[...calls.values()];output=assistant.tool_calls??[];
      }else{
        for await(const part of sse(response)){if(part.type==='response.output_text.delta'){text+=part.delta;callbacks.activity('正在回复');callbacks.delta(id,part.delta);}if(part.type==='response.completed'){output=part.response?.output??[];complete=part.response?.status==='completed';}if(['error','response.failed','response.incomplete'].includes(part.type))throw Error('Model response failed or was incomplete');}
      }
      if(!complete)throw Error('Model stream ended before completion');if(text)callbacks.message({id,role:'assistant',text,replaces:[id]});
      if(agent.protocol==='chat')messages.push(assistant);else messages.push(...output);checkpoint();
      const calls=agent.protocol==='chat'?output:output.filter(c=>c.type==='function_call');if(!calls.length)return;if(calls.length>32)throw Error('Too many tool calls');
      for(const call of calls){signal.throwIfAborted();const name=agent.protocol==='chat'?call.function?.name:call.name,raw=agent.protocol==='chat'?call.function?.arguments:call.arguments;let result;
        try{if(!agent.tools||!apiTools.some(t=>t.function.name===name))throw Error('Tool not enabled');const args=JSON.parse(raw);callbacks.activity('正在调用工具',name);callbacks.message({id:randomUUID(),role:'tool',label:name,text:JSON.stringify(args)});
          if(name==='ask_user')result=JSON.stringify(await callbacks.ask(args,signal));
          else {const mutating=!['read_file','list_files'].includes(name);if(mutating&&permission!=='full'&&!await callbacks.approve(name,args,signal))throw Error('Operation denied by the user');signal.throwIfAborted();result=await executeApiTool(cwd,name,args,signal,[join(this.directory,'agents.json'),join(this.directory,'api-sessions')]);}
        }catch(e){if(signal.aborted)throw signal.reason;result='Tool error: '+(e as Error).message;}
        callbacks.message({id:randomUUID(),role:'tool',label:name+' · completed',text:result});messages.push(agent.protocol==='chat'?{role:'tool',tool_call_id:call.id,content:result}:{type:'function_call_output',call_id:call.call_id,output:result});checkpoint();
      }
    }throw Error('Agent reached the 24-step limit; send a follow-up to continue');
  }
}
