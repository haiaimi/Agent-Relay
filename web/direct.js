const LIMIT=16*1024*1024;
const scope=t=>t.hostId+'|'+(t.sessionId??'project:'+t.projectId);
const hex=bytes=>[...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');
const digest=async blob=>hex(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()));
const requestPromise=request=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
let cacheDb;
async function database(){
  if(!('indexedDB' in window))return null;
  if(!cacheDb)cacheDb=new Promise((resolve,reject)=>{const r=indexedDB.open('agent-relay-direct-assets',1);r.onupgradeneeded=()=>r.result.createObjectStore('assets',{keyPath:'key'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  return cacheDb;
}
async function cached(key){try{const db=await database();return db?await requestPromise(db.transaction('assets').objectStore('assets').get(key)):null;}catch{return null;}}
async function save(key,blob,valid=()=>true){
  try{
    const db=await database();if(!db||!valid())return;
    const tx=db.transaction('assets','readwrite'),store=tx.objectStore('assets');store.put({key,blob,at:Date.now(),size:blob.size});
    const r=store.getAll();r.onsuccess=()=>{let size=r.result.reduce((n,v)=>n+v.size,0),count=r.result.length;for(const v of r.result.sort((a,b)=>a.at-b.at)){if(size<=64*1024*1024&&count<=100)break;store.delete(v.key);size-=v.size;count--;}};
  }catch{/* Cache denial/quota never prevents a successful direct transfer. */}
}
export class AssetTransfers {
  memory=new Map();failures=new Map();nodes=new Set();requests=new Set();epoch=0;
  async request(path,options={},decode=response=>response.json()){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90000);this.requests.add(controller);
    try{
      const response=await fetch(path,{...options,credentials:'same-origin',signal:controller.signal});
      if(!response.ok){let error;try{error=await response.json();}catch{}throw new Error(error?.error||'资源传输失败，请重试');}
      return await decode(response);
    }finally{clearTimeout(timer);this.requests.delete(controller);}
  }
  key(target,kind,ref,preview=false){return scope(target)+'|'+kind+'|'+ref.id+(preview?'|preview-v1':'');}
  async read(target,kind,ref,retry=false,preview=false){
    const key=this.key(target,kind,ref,preview);if(retry)this.failures.delete(key);
    if(this.memory.has(key))return this.memory.get(key);
    const failed=this.failures.get(key);if(failed){if(Date.now()-failed.at<15000)throw failed.error;this.failures.delete(key);}
    const epoch=this.epoch;
    const job=(async()=>{
      const local=await cached(key)??(preview?await cached(this.key(target,kind,ref)):null);let blob=local?.blob,mode='设备缓存';
      if(!blob){
        const path='/api/'+(kind==='image'?'images':'files')+'/'+encodeURIComponent(ref.id)+'?'+new URLSearchParams({sessionId:target.sessionId,...(preview?{preview:'1'}:{})});
        const result=await this.request(path,{},async response=>{if(Number(response.headers.get('Content-Length'))>LIMIT)throw new Error('资源超过 16 MB');return {blob:await response.blob(),source:response.headers.get('X-Asset-Source'),hash:response.headers.get('X-Content-Sha256')};});
        const expected=preview?result.hash:(kind==='image'?ref.id:ref.sha256);
        blob=result.blob;if(!expected||!blob.size||blob.size>LIMIT||await digest(blob)!==expected)throw new Error('资源完整性校验失败');
        mode=result.source==='server-cache'?'服务器缓存':'服务器中转';
        if(epoch!==this.epoch)throw new Error('登录状态已改变');await save(key,blob,()=>epoch===this.epoch);
      }
      if(epoch!==this.epoch)throw new Error('登录状态已改变');return {url:URL.createObjectURL(blob),mode,blob};
    })();
    this.memory.set(key,job);
    try{const result=await job;if(this.memory.size>100){const first=this.memory.keys().next().value;if(first!==key){this.memory.get(first).then(v=>URL.revokeObjectURL(v.url)).catch(()=>{});this.memory.delete(first);}}return result;}
    catch(error){if(this.memory.get(key)===job)this.memory.delete(key);if(epoch===this.epoch)this.failures.set(key,{error,at:Date.now()});throw error;}
  }
  bind(img,status,target,kind,ref){
    img.alt=ref.name||'图片';img.hidden=true;status.textContent='';status.dataset.state='loading';status.setAttribute('role','status');status.setAttribute('aria-label','正在加载图片…');
    const load=async(retry,preview=false)=>{
      status.hidden=!img.hidden;status.textContent='';status.dataset.state='loading';status.setAttribute('aria-label','正在加载图片…');status.removeAttribute('title');
      try{
        const result=await this.read(target,kind,ref,retry,preview),decoded=new Image();decoded.src=result.url;await decoded.decode();
        // Size the card before revealing the image; existing reading anchors handle the one-time resize.
        img.parentElement.parentElement.style.setProperty('--image-ratio',String(decoded.naturalWidth/decoded.naturalHeight));
        img.src=result.url;img.hidden=false;status.hidden=true;status.removeAttribute('title');return result;
      }catch(error){status.hidden=false;status.dataset.state='error';status.setAttribute('aria-label','加载失败 · 点此重试');status.textContent='加载失败 · 点此重试';status.title=error.message;throw error;}
    };
    const start=()=>load(false,true).catch(()=>{});img._directStart=start;this.nodes.add(img);
    if(!this.observer)this.observer=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){this.observer.unobserve(e.target);this.nodes.delete(e.target);e.target._directStart();}},{root:document.getElementById('timeline'),rootMargin:'300px'});
    // Observe the card, not a hidden image, so lazy loading works before src exists.
    const card=img.parentElement;card._directStart=start;this.nodes.delete(img);this.nodes.add(card);this.observer.observe(card);
    return load;
  }
  sweep(){for(const node of this.nodes)if(!node.isConnected){this.observer?.unobserve(node);this.nodes.delete(node);}}
  async upload(target,file,id=crypto.randomUUID()){
    if(!file.size||file.size>LIMIT)throw new Error('附件应为 1 字节至 16 MB');
    const result=await this.request('/api/uploads?'+new URLSearchParams({...target,name:file.name,id}),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
    if(result.file?.id!==id||result.file.size!==file.size||result.file.name!==file.name)throw new Error('附件回执不匹配');return result.file;
  }
  async reset(){
    this.epoch++;for(const controller of this.requests)controller.abort();this.requests.clear();this.failures.clear();this.observer?.disconnect();this.nodes.clear();
    for(const job of this.memory.values())job.then(v=>URL.revokeObjectURL(v.url)).catch(()=>{});this.memory.clear();
    try{const db=await database();if(db)db.transaction('assets','readwrite').objectStore('assets').clear();}catch{}
  }
}
// Keep the existing module export for already-integrated composer/gallery code.
export const directAssets=new AssetTransfers();
