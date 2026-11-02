import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { EventEmitter } from 'node:events';

export function codexProgram(command:string):{file:string;args:string[]} {
  if(process.platform!=='win32' || isAbsolute(command))return {file:command,args:[]};
  if(command==='codex') {
    const arch=process.arch==='arm64'?'arm64':'x64';const triplet=arch==='arm64'?'aarch64-pc-windows-msvc':'x86_64-pc-windows-msvc';
    const root=join(process.env.APPDATA ?? '', 'npm','node_modules','@openai','codex');
    for(const binary of [join(root,'node_modules','@openai',`codex-win32-${arch}`,'vendor',triplet,'bin','codex.exe'),join(root,'vendor',triplet,'bin','codex.exe')])if(existsSync(binary))return {file:binary,args:[]};
    throw new Error('Cannot find the native npm Codex binary; set codexCommand to the installed codex.exe path');
  }
  return {file:command,args:[]};
}
export class CodexRpc extends EventEmitter {
  private child?:ChildProcessWithoutNullStreams;
  private waiting=new Map<number,{resolve:(value:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  private counter=0;
  private starting?:Promise<void>;
  constructor(readonly command:string,readonly prefixArgs:string[]=[]){super();}
  async start():Promise<void>{
    if(this.starting)return this.starting;
    this.starting=this.initialize().catch(e=>{this.starting=undefined;throw e;});return this.starting;
  }
  private async initialize(){
    const program=codexProgram(this.command);
    const child=spawn(program.file,[...program.args,...this.prefixArgs,'app-server','--listen','stdio://'],{stdio:'pipe',windowsHide:true,shell:false});this.child=child;
    let failed=false;
    const die=(error:Error)=>{if(failed)return;failed=true;this.child=undefined;this.starting=undefined;for(const p of this.waiting.values()){clearTimeout(p.timer);p.reject(error);}this.waiting.clear();this.emit('failure',error);};
    child.on('error',die);child.on('exit',code=>die(new Error(`Local Codex process exited (${code})`)));
    // Provider logs can contain private paths; they stay on this computer.
    child.stderr.on('data',()=>{});
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{
      try {
        const msg=JSON.parse(line);
        if(msg.method) this.emit('notification',msg);
        else if(this.waiting.has(msg.id)) {const p=this.waiting.get(msg.id)!;this.waiting.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(new Error(msg.error.message)):p.resolve(msg.result);}
      } catch(e) {this.emit('protocolError',e);}
    });
    await this.call('initialize',{clientInfo:{name:'agent_relay',title:'Agent Relay',version:'0.1.0'},capabilities:{experimentalApi:true}});
    this.send({method:'initialized'});
  }
  send(msg:unknown){if(!this.child?.stdin.writable)throw new Error('Codex is not connected');this.child.stdin.write(JSON.stringify(msg)+'\n');}
  call(method:string,params?:unknown):Promise<any>{
    const id=++this.counter;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.waiting.delete(id);reject(new Error(`Codex ${method} timed out`));},60_000);
      this.waiting.set(id,{resolve,reject,timer});
      try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.waiting.delete(id);reject(e as Error);}
    });
  }
  close(){this.child?.kill();}
}
