import {existsSync,mkdirSync,realpathSync,statSync} from 'node:fs';
import {isAbsolute,parse,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Action,Project} from '../shared/protocol.js';
import type {BridgeStore} from './store.js';

// A project registration is an explicit authenticated operation, separate from
// sending a prompt. Never infer new allowed roots from messages or attachments.
export function createLocalProject(store:BridgeStore,a:Action):Project{
  const name=a.projectName?.trim(),path=a.projectPath?.trim();
  if(!name||name.length>100||!path||path.length>2000||/[\r\n\x00]/.test(name+path)||!isAbsolute(path))throw new Error('请输入项目名称和工作电脑上的文件夹绝对路径');
  if(process.platform==='win32'&&(!/^[a-z]:[\\/]/i.test(path)||/[<>:"|?*]/.test(path.slice(2))))throw new Error('请使用本机磁盘绝对路径，例如 E:\\Projects\\NewGame');
  const full=resolve(path);if(full===parse(full).root)throw new Error('请选择磁盘中的项目文件夹');
  if(!existsSync(full)){if(a.createFolder!==true)throw new Error('文件夹不存在，请勾选创建文件夹');mkdirSync(full,{recursive:true});}
  if(!statSync(full).isDirectory())throw new Error('指定路径不是文件夹');
  const actual=realpathSync.native(full),key=(p:string)=>process.platform==='win32'?p.toLowerCase():p;
  // A shared cwd does not prove native Codex project membership. Deduplicate
  // only explicit web registrations; never assign a native project by path.
  for(const project of store.projects())if(project.name===name){try{if(key(realpathSync.native(project.path))===key(actual))return project;}catch{}}
  const project:Project={id:'web-'+randomUUID(),name,path:actual,roots:[actual],source:'configured'};
  store.saveProject(project);return project;
}
