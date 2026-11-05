const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('relayDesktop',Object.fromEntries(['load','save','discover','start','website','studio'].map(method=>[method,async payload=>{const result=await ipcRenderer.invoke('relay-desktop',method,payload);if(!result.ok)throw Error(result.error);return result.value;}])));
