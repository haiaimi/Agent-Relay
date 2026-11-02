import {existsSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {homedir,hostname} from 'node:os';
import {resolve,join} from 'node:path';
if(!existsSync('.env')){
  writeFileSync('.env',`RELAY_HOST=127.0.0.1\nRELAY_PORT=8787\nRELAY_DATA_DIR=.data/relay\nPHONE_TOKEN=${randomBytes(32).toString('base64url')}\nBRIDGE_TOKEN=${randomBytes(32).toString('base64url')}\n`,{mode:0o600});
  console.log('Created .env with separate random phone and bridge secrets.');
}
if(!existsSync('bridge.config.json')){
  writeFileSync('bridge.config.json',JSON.stringify({relayUrl:'ws://127.0.0.1:8787/bridge',hostId:'windows-pc',name:hostname(),dataDir:'.data/bridge',projects:[{id:'agent-relay',name:'Agent Relay',path:resolve('.')}],codexCommand:'codex',claudeCommand:process.platform==='win32'?join(homedir(),'.local','bin','claude.exe'):'claude',syncIntervalSeconds:15,discoverCodexProjects:true,syncHistory:true},null,2)+'\n',{mode:0o600});
  console.log('Created bridge.config.json. Add project roots before enabling remote work.');
}
mkdirSync('.data',{recursive:true,mode:0o700});
console.log('Start npm run relay and npm run bridge in separate terminals. Phone login key is PHONE_TOKEN in .env.');
