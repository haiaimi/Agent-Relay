const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('relayStudioDesktop',Object.freeze({
  context:()=>ipcRenderer.invoke('relay-studio-desktop','context'),
  pickDirectory:initialPath=>ipcRenderer.invoke('relay-studio-desktop','directory',initialPath),
  pasteFiles:()=>ipcRenderer.invoke('relay-studio-desktop','clipboard-files'),
}));
