const {app,BrowserWindow,ipcMain,shell}=require('electron');
const {join,resolve}=require('node:path');
const {pathToFileURL}=require('node:url');
const {readFileSync,existsSync,mkdirSync,openSync,closeSync}=require('node:fs');
const {spawn}=require('node:child_process');
const root=resolve(__dirname,'..'),configPath=resolve(root,process.env.AGENT_RELAY_CONFIG||'bridge.config.json'),uiUrl=pathToFileURL(join(__dirname,'index.html')).href;
app.setName('Agent Relay Desktop');app.setPath('userData',join(app.getPath('appData'),'AgentRelayDesktop'));
if(!app.requestSingleInstanceLock()){app.quit();process.exit(0);}
let window,registry;
app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
function config(){return JSON.parse(readFileSync(configPath,'utf8'));}
function bridgeState(){const c=config(),data=resolve(root,c.dataDir||'.data/bridge');let running=false,pid;try{pid=Number(readFileSync(join(data,'bridge.lock'),'utf8'));if(Number.isSafeInteger(pid)&&pid>0){process.kill(pid,0);running=true;}}catch{}return {running,pid:running?pid:undefined,name:c.name,relayUrl:c.relayUrl,hostId:c.hostId};}
async function handle(event,method,payload){if(event.sender!==window.webContents||event.senderFrame.url!==uiUrl)throw Error('Invalid desktop caller');
  if(method==='load')return {settings:registry.public(),bridge:bridgeState()};
  if(method==='save')return registry.save(payload);
  if(method==='discover'){if(typeof payload!=='string')throw Error('Invalid agent');return registry.discover(payload);}
  if(method==='start'){
    const state=bridgeState();if(state.running)return state;
    const c=config(),data=resolve(root,c.dataDir||'.data/bridge');mkdirSync(data,{recursive:true,mode:0o700});const log=openSync(join(data,'desktop-bridge.log'),'a',0o600);
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(process.env.AGENT_RELAY_NODE||'node',['--env-file-if-exists=.env','dist/bridge/main.js',configPath],{cwd:root,env,detached:true,windowsHide:true,stdio:['ignore',log,log]});closeSync(log);
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return {running:false,starting:true};
  }
  if(method==='website'){const u=new URL(config().relayUrl);u.protocol=u.protocol==='wss:'?'https:':'http:';u.pathname='/';u.search='';u.hash='';if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw Error('Invalid relay address');await shell.openExternal(u.toString());return {};}
  throw Error('Unknown desktop operation');
}
app.whenReady().then(async()=>{
  const {AgentRegistry}=await import(pathToFileURL(join(root,'dist/bridge/agents.js')).href);registry=new AgentRegistry(resolve(root,config().dataDir||'.data/bridge'));
  window=new BrowserWindow({width:1120,height:820,minWidth:850,minHeight:640,title:'Agent Relay · Desktop',icon:join(root,'web/icon-192.png'),autoHideMenuBar:true,webPreferences:{preload:join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',e=>e.preventDefault());window.webContents.session.setPermissionRequestHandler((_web,_permission,reply)=>reply(false));
  ipcMain.handle('relay-desktop',async(event,method,payload)=>{try{return {ok:true,value:await handle(event,method,payload)}}catch(e){return {ok:false,error:e.message}}});await window.loadFile(join(__dirname,'index.html'));
}).catch(error=>{console.error('Desktop startup failed:',error.message);app.quit();});
app.on('window-all-closed',()=>app.quit());
