import {readFileSync,writeFileSync,existsSync,mkdirSync,copyFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),config=JSON.parse(readFileSync(process.argv[2]??join(root,'bridge.config.json'),'utf8'));
const home=config.claudeHome??join(homedir(),'.claude');mkdirSync(home,{recursive:true});const path=join(home,'settings.json');
const settings=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
const hooks=settings.hooks??{},pre=hooks.PreToolUse??[];
if(!pre.some(entry=>entry.matcher==='AskUserQuestion'&&entry.hooks?.some(h=>String(h.command??'').includes('claude-question-hook.mjs')))){
  if(existsSync(path))copyFileSync(path,path+'.agent-relay-backup-'+Date.now());
  const quote=s=>'"'+s.replaceAll('"','\\"')+'"',command=[process.execPath,join(root,'scripts','claude-question-hook.mjs'),resolve(root,config.dataDir??'.data/bridge','question-hook.json')].map(quote).join(' ');
  pre.push({matcher:'AskUserQuestion',hooks:[{type:'command',command,timeout:3600}]});settings.hooks={...hooks,PreToolUse:pre};writeFileSync(path,JSON.stringify(settings,null,2)+'\n',{mode:0o600});
}
console.log('Claude AskUserQuestion hook ready; new sessions can answer through Agent Relay.');
