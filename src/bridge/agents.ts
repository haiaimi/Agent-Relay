import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import type {AgentModel,AgentInfo} from '../shared/protocol.js';
export interface ApiAgent {id:string;name:string;enabled:boolean;baseUrl:string;apiKey?:string;protocol:'chat'|'responses';models:(AgentModel&{vision?:boolean})[];tools:boolean;reasoning:'none'|'standard'|'thinking'}
export interface AgentSettings {native:{codex:boolean;claude:boolean};agents:ApiAgent[]}
export const agentTemplates=[{id:'grok',name:'Grok',baseUrl:'https://api.x.ai/v1',protocol:'responses'},{id:'deepseek',name:'DeepSeek',baseUrl:'https://api.deepseek.com',protocol:'chat'},{id:'mimo',name:'MiMo',baseUrl:'https://api.xiaomimimo.com/v1',protocol:'chat'}] as const;
export function endpoint(base:string){const u=new URL(base);if(u.username||u.password||u.search||u.hash||(u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname))))throw Error('API address must use HTTPS (HTTP is allowed for localhost only)');return u.toString().replace(/\/$/,'');}
export class AgentRegistry {
  readonly path:string;
  constructor(readonly dataDir:string){this.path=join(dataDir,'agents.json');}
  read():AgentSettings{if(!existsSync(this.path))return {native:{codex:true,claude:true},agents:[]};return this.validate(JSON.parse(readFileSync(this.path,'utf8')));}
  validate(value:any):AgentSettings{
    if(!value||!Array.isArray(value.agents)||value.agents.length>30)throw Error('Invalid agent configuration');
    const ids=new Set<string>();const agents=value.agents.map((a:any)=>{
      if(!/^[a-zA-Z0-9_-]{1,60}$/.test(a.id)||['codex','claude'].includes(a.id)||ids.has(a.id)||typeof a.name!=='string'||!a.name.trim()||a.name.length>80||!['chat','responses'].includes(a.protocol)||!Array.isArray(a.models)||a.models.length>100)throw Error('Invalid agent or duplicate ID');ids.add(a.id);
      if(a.apiKey!==undefined&&(typeof a.apiKey!=='string'||a.apiKey.length>4000||/[\r\n]/.test(a.apiKey)))throw Error('Invalid API key');
      const modelIds=new Set<string>(),models=a.models.map((m:any)=>{if(!m||typeof m.id!=='string'||!m.id||m.id.length>150||/[\r\n]/.test(m.id)||modelIds.has(m.id))throw Error('Invalid model ID');modelIds.add(m.id);const efforts=Array.isArray(m.efforts)?m.efforts.filter((x:any)=>['none','minimal','low','medium','high','xhigh','max','ultra'].includes(x)):[];return {id:m.id,name:typeof m.name==='string'&&m.name.length<=150?m.name:m.id,isDefault:m.isDefault===true,vision:m.vision===true,efforts,defaultEffort:efforts.includes(m.defaultEffort)?m.defaultEffort:undefined};});
      if(models.length&&!models.some((m:AgentModel)=>m.isDefault))models[0].isDefault=true;
      return {id:a.id,name:a.name.trim(),enabled:a.enabled===true,baseUrl:endpoint(a.baseUrl),apiKey:a.apiKey,protocol:a.protocol,models,tools:a.tools===true,reasoning:['none','standard','thinking'].includes(a.reasoning)?a.reasoning:'none'};
    });return {native:{codex:value.native?.codex!==false,claude:value.native?.claude!==false},agents};
  }
  public(){const v=this.read();return {...v,agents:v.agents.map(({apiKey,...a})=>({...a,keyConfigured:!!apiKey})),templates:agentTemplates};}
  save(value:any){if(!Array.isArray(value?.agents))throw Error('Invalid configuration');const prior=this.read();const checked=this.validate({...value,agents:value.agents.map((a:any)=>({...a,apiKey:a.clearKey?undefined:a.apiKey||prior.agents.find(p=>p.id===a.id)?.apiKey}))});mkdirSync(this.dataDir,{recursive:true,mode:0o700});const temp=this.path+'.'+randomUUID();writeFileSync(temp,JSON.stringify(checked,null,2)+'\n',{mode:0o600});renameSync(temp,this.path);chmodSync(this.path,0o600);return this.public();}
  catalog():AgentInfo[]{const v=this.read();return [...(['codex','claude'] as const).filter(id=>v.native[id]).map(id=>({id,provider:id,name:id==='codex'?'Codex':'Claude Code'})),...v.agents.filter(a=>a.enabled).map(a=>({id:a.id,provider:'api' as const,name:a.name,configured:!!a.apiKey&&!!a.models.length,tools:a.tools,revision:createHash('sha256').update(JSON.stringify([a.models,a.tools,a.reasoning,a.protocol])).digest('hex')}))];}
  get(id?:string){const a=this.read().agents.find(a=>a.id===id);if(!a?.enabled)throw Error('This agent is disabled; enable it in the desktop manager');if(!a.apiKey)throw Error('Configure an API key in the desktop manager');if(!a.models.length)throw Error('Select at least one model in the desktop manager');return a;}
  enabled(provider:string,id?:string){if(provider==='api')return this.get(id);if(!this.read().native[provider as 'codex'|'claude'])throw Error('This agent is disabled in the desktop manager');}
  async discover(id:string){const a=this.read().agents.find(a=>a.id===id);if(!a?.apiKey)throw Error('Save an API key first');const res=await fetch(a.baseUrl+'/models',{headers:{Authorization:'Bearer '+a.apiKey},signal:AbortSignal.timeout(20000),redirect:'error'});if(!res.ok)throw Error(`Model discovery failed (HTTP ${res.status}); enter model IDs manually if unsupported`);const body:any=await res.json();return (Array.isArray(body.data)?body.data:[]).slice(0,300).filter((m:any)=>typeof m.id==='string').map((m:any)=>({id:m.id,name:m.id}));}
}
