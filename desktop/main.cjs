const {app,BrowserWindow,ipcMain,Menu,dialog,clipboard}=require('electron');
const {readClipboardFiles}=require('./clipboard-files.cjs');
const {join,resolve,isAbsolute}=require('node:path');
const {pathToFileURL}=require('node:url');
const {readFileSync,existsSync,mkdirSync,openSync,closeSync,statSync,appendFileSync}=require('node:fs');
const {spawn}=require('node:child_process');
const {workspaceOrigin,restoreLogin}=require('./workspace.cjs');
const root=resolve(__dirname,'..'),configPath=resolve(root,process.env.AGENT_RELAY_CONFIG||'bridge.config.json'),settingsUrl=pathToFileURL(join(__dirname,'index.html')).href;
app.setName('Agent Relay Desktop');app.setPath('userData',join(app.getPath('appData'),'AgentRelayDesktop'));
if(!app.requestSingleInstanceLock()){app.quit();process.exit(0);}
let window,settingsWindow,registry,origin,loading,pasteGrant=0;
function desktopLog(message){try{mkdirSync(join(root,'.data'),{recursive:true});appendFileSync(join(root,'.data','desktop-ui.log'),new Date().toISOString()+' '+message+'\n');}catch{}}
app.on('second-instance',()=>{if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();}});
function config(){return JSON.parse(readFileSync(configPath,'utf8'));}
function bridgeState(){const c=config(),data=resolve(root,c.dataDir||'.data/bridge');let running=false,pid;try{pid=Number(readFileSync(join(data,'bridge.lock'),'utf8'));if(Number.isSafeInteger(pid)&&pid>0){process.kill(pid,0);running=true;}}catch{}return {running,pid:running?pid:undefined,name:c.name,relayUrl:c.relayUrl,hostId:c.hostId};}
async function startBridge(){
  if(process.platform==='win32'){
    const helper=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'scripts/install-background-service.ps1'),'-ConfigPath',configPath],{cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe']});
    let error='';helper.stderr.on('data',data=>{error+=data.toString();});
    await new Promise((resolve,reject)=>{helper.once('error',reject);helper.once('exit',code=>code===0?resolve():reject(Error('后台服务启动失败：'+error.slice(-1000))));});
    return {...bridgeState(),background:true};
  }
  const state=bridgeState();if(state.running)return state;
  const c=config(),data=resolve(root,c.dataDir||'.data/bridge');mkdirSync(data,{recursive:true,mode:0o700});const log=openSync(join(data,'desktop-bridge.log'),'a',0o600);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(process.env.AGENT_RELAY_NODE||'node',['--env-file-if-exists=.env','dist/bridge/main.js',configPath],{cwd:root,env,detached:true,windowsHide:true,stdio:['ignore',log,log]});closeSync(log);
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return {running:false,starting:true};
}
function showSettings(){
  if(settingsWindow&&!settingsWindow.isDestroyed()){settingsWindow.show();settingsWindow.focus();return;}
  settingsWindow=new BrowserWindow({width:1120,height:820,minWidth:850,minHeight:640,title:'Agent Relay · Agent 与模型设置',icon:join(root,'web/icon-192.png'),autoHideMenuBar:true,webPreferences:{preload:join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  settingsWindow.setMenu(null);settingsWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));settingsWindow.webContents.on('will-navigate',e=>e.preventDefault());settingsWindow.webContents.session.setPermissionRequestHandler((_web,_permission,reply)=>reply(false));
  void settingsWindow.loadFile(join(__dirname,'index.html'));
}
async function showWorkspace(path='/studio'){
  if(loading)return loading;
  if(!window||window.isDestroyed()){
    window=new BrowserWindow({width:1320,height:920,minWidth:900,minHeight:650,title:'Agent Relay · 游戏工作室',icon:join(root,'web/icon-192.png'),autoHideMenuBar:false,backgroundColor:'#111318',webPreferences:{preload:join(__dirname,'studio-preload.cjs'),partition:'persist:relay-workspace',nodeIntegration:false,contextIsolation:true,sandbox:true}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('before-input-event',(_event,input)=>{if(input.type==='keyDown'&&((input.control||input.meta)&&input.key.toLowerCase()==='v'||input.shift&&input.key==='Insert'))pasteGrant=Date.now()+5000;});
    window.webContents.on('did-start-navigation',()=>{pasteGrant=0;});
    window.webContents.on('did-fail-load',(_event,code,description,_url,isMainFrame)=>{if(isMainFrame)desktopLog('load failed '+code+' '+description);});
    window.webContents.on('did-finish-load',()=>desktopLog('page loaded'));
    window.webContents.on('render-process-gone',(_event,details)=>desktopLog('renderer '+details.reason));
    const allow=(event,url)=>{try{if(new URL(url).origin!==origin)event.preventDefault();}catch{event.preventDefault();}};
    window.webContents.on('will-navigate',allow);window.webContents.on('will-redirect',allow);
    window.webContents.on('page-title-updated',event=>event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_web,_permission,reply)=>reply(false));
    await window.loadFile(join(__dirname,'loading.html'));
  }
  window.show();window.focus();window.setTitle(path==='/studio'?'Agent Relay · 游戏工作室':'Agent Relay · 会话工作台');
  loading=(async()=>{try{const restored=await restoreLogin(window.webContents.session,origin,root);desktopLog('login '+(restored?'restored':'manual'));}catch(e){desktopLog('login unavailable '+e.message);}await window.loadURL(origin+path);})().catch(async(error)=>{desktopLog('workspace failed '+error.message);if(window&&!window.isDestroyed()){window.setTitle('Agent Relay · 连接失败');await window.loadFile(join(__dirname,'loading.html'));}}).finally(()=>{loading=undefined;});
  return loading;
}
async function handle(event,method,payload){
  if(!settingsWindow||event.sender!==settingsWindow.webContents||event.senderFrame!==event.sender.mainFrame||event.senderFrame.url!==settingsUrl)throw Error('Invalid desktop caller');
  if(method==='load')return {settings:registry.public(),bridge:bridgeState()};
  if(method==='save')return registry.save(payload);
  if(method==='discover'){if(typeof payload!=='string')throw Error('Invalid agent');return registry.discover(payload);}
  if(method==='start')return startBridge();
  if(method==='website'||method==='studio'){await showWorkspace(method==='studio'?'/studio':'/');return {};}
  throw Error('Unknown desktop operation');
}
app.whenReady().then(async()=>{
  origin=workspaceOrigin(config().relayUrl);
  const {AgentRegistry}=await import(pathToFileURL(join(root,'dist/bridge/agents.js')).href);registry=new AgentRegistry(resolve(root,config().dataDir||'.data/bridge'));
  ipcMain.handle('relay-desktop',async(event,method,payload)=>{try{return {ok:true,value:await handle(event,method,payload)}}catch(e){return {ok:false,error:e.message}}});
  ipcMain.handle('relay-studio-desktop',async(event,method,payload)=>{
    if(!window||event.sender!==window.webContents||event.senderFrame!==event.sender.mainFrame)throw Error('Invalid studio caller');
    const url=new URL(event.senderFrame.url);if(url.origin!==origin||url.pathname!=='/studio')throw Error('Invalid studio origin');
    if(method==='context')return {hostId:config().hostId};
    if(method==='clipboard-files'){const granted=pasteGrant>Date.now();pasteGrant=0;if(!granted||!window.isFocused())return [];return readClipboardFiles(clipboard);}
    if(method==='directory'){
      if(payload!==undefined&&(typeof payload!=='string'||payload.length>2000||/[\r\n\x00]/.test(payload)))throw Error('Invalid initial folder');
      let defaultPath;try{if(payload&&isAbsolute(payload)&&existsSync(payload)&&statSync(payload).isDirectory())defaultPath=payload;}catch{}
      const choice=await dialog.showOpenDialog(window,{title:'选择游戏工程文件夹',defaultPath,properties:['openDirectory','createDirectory']});
      return {cancelled:choice.canceled,path:choice.canceled?undefined:choice.filePaths[0],hostId:config().hostId};
    }throw Error('Unknown studio operation');
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'工作台',submenu:[{label:'游戏团队工作室',accelerator:'CmdOrCtrl+1',click:()=>void showWorkspace('/studio')},{label:'会话工作台',accelerator:'CmdOrCtrl+2',click:()=>void showWorkspace('/')},{type:'separator'},{label:'Agent 与模型设置',click:showSettings},{label:'启动本机连接',click:()=>void startBridge().catch(e=>dialog.showErrorBox('无法启动连接',e.message))},{type:'separator'},{label:'刷新当前页面',accelerator:'CmdOrCtrl+R',click:()=>window?.webContents.reload()},{role:'quit',label:'退出桌面窗口'}]},
    {label:'编辑',submenu:[{role:'undo',label:'撤销'},{role:'redo',label:'重做'},{type:'separator'},{role:'cut',label:'剪切'},{role:'copy',label:'复制'},{label:'粘贴',accelerator:'CmdOrCtrl+V',click:()=>{const focused=BrowserWindow.getFocusedWindow();if(focused===window)pasteGrant=Date.now()+5000;focused?.webContents.paste();}},{role:'selectAll',label:'全选'}]},
    {label:'显示',submenu:[{role:'resetZoom',label:'实际大小'},{role:'zoomIn',label:'放大'},{role:'zoomOut',label:'缩小'},{role:'togglefullscreen',label:'全屏'}]},
  ]));
  void startBridge().catch(e=>console.log('Bridge startup unavailable:',e.message));await showWorkspace();
}).catch(error=>{console.error('Desktop startup failed:',error.message);app.quit();});
app.on('window-all-closed',()=>app.quit());
