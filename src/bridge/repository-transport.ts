import {homedir} from 'node:os';
import {join} from 'node:path';
import {lstat,readdir} from 'node:fs/promises';
import {repositoryKey} from '../shared/repository-url.js';
import type {Project} from '../shared/protocol.js';

type Git=(cwd:string,args:string[],input?:string,env?:Record<string,string>)=>Promise<string>;
const authenticationFailure=(e:unknown)=>/permission denied.*publickey|authentication failed|could not read (?:username|password)|terminal prompts disabled|repository not found/i.test((e as Error).message);
const quote=(s:string)=>"'"+s.replaceAll('\\','/').replaceAll("'","'\"'\"'")+"'";

// Probe repository access, never read key contents. Keys and commands stay local.
export async function repositoryTransport(cwd:string,url:string,known:Project[],git:Git,keyDirectory=join(homedir(),'.ssh')){
  const probe=async(address:string,command?:string)=>{for(let attempt=0;;attempt++)try{return await git(cwd,['ls-remote','--heads',address],undefined,command?{GIT_SSH_COMMAND:command,GIT_TERMINAL_PROMPT:'0'}:{GIT_TERMINAL_PROMPT:'0'});}catch(e){if(authenticationFailure(e)||attempt===4||!/timed? out|connection|could not resolve|unable to access|network|远程主机/i.test((e as Error).message))throw e;await new Promise(r=>setTimeout(r,60000));}};
  try{await probe(url);return {url,env:{} as Record<string,string>};}catch(e){if(!authenticationFailure(e))throw e;}
  const key=repositoryKey(url)!,ssh='git@github.com:'+key+'.git',commands=new Set<string>();
  const verify=async(command:string)=>{if(commands.has(command))return false;commands.add(command);try{await probe(ssh,command);return true;}catch(e){if(!authenticationFailure(e)&&!/no such identity|load key|invalid format|bad permissions/i.test((e as Error).message))throw e;return false;}};
  // A workstation may already have a per-repository SSH identity or wrapper.
  for(const p of known.slice(0,40)){
    let command='';try{const origin=(await git(p.path,['config','--get','remote.origin.url'])).trim();if(repositoryKey(origin)!==key)continue;command=(await git(p.path,['config','--get','core.sshCommand'])).trim();}catch{continue;}
    if(command&&command.length<3000&&!/[\r\n\x00]/.test(command)&&await verify(command))return {url:ssh,env:{GIT_SSH_COMMAND:command},command};
  }
  let names:string[]=[];try{names=await readdir(keyDirectory);}catch{}
  const candidates=names.filter(n=>!/^\.|\.(?:pub|bak|old|txt|json|conf|log|sh)$|^(?:config|known_hosts|authorized_keys)/i.test(n)&&(/^id_(?:rsa|ed25519|ecdsa|dsa)(?:$|_)/i.test(n)||/github|relay|\.pem$/i.test(n)||names.includes(n+'.pub'))).sort().slice(0,12);
  for(const name of candidates){const path=join(keyDirectory,name);if(!(await lstat(path)).isFile())continue;
    const command='ssh -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 -i '+quote(path);
    if(await verify(command))return {url:ssh,env:{GIT_SSH_COMMAND:command},command};
  }
  throw Error('目标电脑的 GitHub 认证失败；已逐个验证本机 SSH key，仍无仓库访问权限。请检查目标电脑的 GitHub 登录与仓库授权。');
}
