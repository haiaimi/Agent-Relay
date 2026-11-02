import { readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startBridge } from './connector.js';
import type { BridgeConfig } from './runtime.js';
const path=resolve(process.argv[2] ?? 'bridge.config.json');
const config=JSON.parse(readFileSync(path,'utf8')) as BridgeConfig;
config.dataDir=resolve(config.dataDir??'.data/bridge');mkdirSync(config.dataDir,{recursive:true,mode:0o700});
const lock=join(config.dataDir,'bridge.lock');
try {writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});}
catch(error){
  let alive=false;try{process.kill(Number(readFileSync(lock,'utf8')),0);alive=true;}catch{}
  if(alive)throw new Error('Another bridge is running with this data directory');
  unlinkSync(lock);writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
}
try{
  const app=startBridge(config,process.env.BRIDGE_TOKEN??'');
  const close=()=>void app.close().then(()=>{unlinkSync(lock);process.exit(0);});
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,close);
  console.log(`Local bridge started: ${config.name}`);
}catch(err){unlinkSync(lock);throw err;}
