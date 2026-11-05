// Store transcript data, never rendered HTML or actions to replay.
const VERSION=1,MAX_ENTRY=8*1024*1024;
let databaseJob;
function database(){
  if(!globalThis.indexedDB)return Promise.resolve(null);
  return databaseJob??=new Promise(resolve=>{
    const request=indexedDB.open('agent-relay-conversations',VERSION),timer=setTimeout(()=>resolve(null),1500);
    request.onupgradeneeded=()=>request.result.createObjectStore('conversations',{keyPath:'key'});
    request.onsuccess=()=>{clearTimeout(timer);resolve(request.result);};request.onerror=request.onblocked=()=>{clearTimeout(timer);resolve(null);};
  });
}
const storage={
  async read(key){const db=await database();if(!db)return null;return new Promise(resolve=>{const r=db.transaction('conversations').objectStore('conversations').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>resolve(null);});},
  async write(entry){const db=await database();if(!db)return;await new Promise((resolve,reject)=>{
    const tx=db.transaction('conversations','readwrite'),store=tx.objectStore('conversations');store.put(entry);
    const r=store.getAll();r.onsuccess=()=>{let size=r.result.reduce((n,v)=>n+v.size,0),count=r.result.length;for(const v of r.result.sort((a,b)=>a.at-b.at)){if(size<=64*1024*1024&&count<=60)break;store.delete(v.key);size-=v.size;count--;}};
    tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);
  });},
  async clear(){const db=await database();if(!db)return;await new Promise(resolve=>{const tx=db.transaction('conversations','readwrite');tx.objectStore('conversations').clear();tx.oncomplete=tx.onerror=tx.onabort=resolve;});}
};
export const conversationIdentity=s=>JSON.stringify([s.id,s.hostId,s.nativeId,s.provider,s.cwd]);
export class ConversationCache{
  constructor({disk=storage,maxEntries=24,maxBytes=32*1024*1024,enabled=true,now=()=>Date.now()}={}){Object.assign(this,{disk,maxEntries,maxBytes,enabled,now});this.entries=new Map();this.epoch=0;this.writes=Promise.resolve();}
  enable(){this.enabled=true;}
  remember(entry){this.entries.delete(entry.key);this.entries.set(entry.key,entry);let size=[...this.entries.values()].reduce((n,v)=>n+v.size,0);for(const[key,value]of this.entries){if(this.entries.size<=this.maxEntries&&size<=this.maxBytes)break;this.entries.delete(key);size-=value.size;}}
  peek(key,identity){if(!this.enabled)return null;const entry=this.entries.get(key);if(!entry||entry.identity!==identity)return null;this.entries.delete(key);this.entries.set(key,entry);return entry.value;}
  async read(key,identity){const memory=this.peek(key,identity);if(memory)return memory;if(!this.enabled)return null;const epoch=this.epoch;
    try{const entry=await this.disk.read(key);if(epoch!==this.epoch||!this.enabled)return null;const newer=this.peek(key,identity);if(newer)return newer;
      if(!entry||entry.version!==VERSION||entry.identity!==identity||entry.size>MAX_ENTRY||!entry.value||typeof entry.value!=='object')return null;this.remember(entry);return entry.value;
    }catch{return null;}
  }
  put(key,identity,value){if(!this.enabled)return;let json;try{json=JSON.stringify(value);}catch{return;}const size=new TextEncoder().encode(json).byteLength;if(size>MAX_ENTRY)return;
    const entry={version:VERSION,key,identity,value:JSON.parse(json),size,at:this.now()},epoch=this.epoch;this.remember(entry);
    this.writes=this.writes.catch(()=>{}).then(()=>epoch===this.epoch&&this.enabled?this.disk.write(entry):undefined).catch(()=>{});
  }
  async clear(){this.epoch++;this.enabled=false;this.entries.clear();await this.writes;try{await this.disk.clear();}catch{}}
}
export const conversationCache=new ConversationCache({enabled:false});
// Studio views share persistence, but replay no cached approvals/questions.
export function pagedConversationCache({target,pages,cursor,restore,view,note}){
  const key=t=>'studio:'+t.identity;
  return {
    save(){const t=target();if(!t||!pages.size)return;const timeline=view(),reading=timeline.clientHeight?{top:timeline.scrollTop,follow:timeline.scrollHeight-timeline.scrollTop-timeline.clientHeight<65}:conversationCache.peek(key(t),t.identity)?.view??{top:0,follow:true};conversationCache.put(key(t),t.identity,{pages:[...pages].map(([id,page])=>[id,{...page,questions:undefined,events:page.events?.filter(e=>!['approval','approval.resolved','question','question.resolved'].includes(e.type))}]),cursor:cursor(),view:reading});},
    load(){if(pages.size)return;const t=target();if(!t)return;const apply=value=>{const current=target();if(!value||!Array.isArray(value.pages)||pages.size||current?.identity!==t.identity||current?.generation!==t.generation)return;
        for(const[id,page]of value.pages)pages.set(id,page);restore(value);const timeline=view();timeline.scrollTop=value.view?.follow?timeline.scrollHeight:value.view?.top??0;note();
      };
      const cached=conversationCache.peek(key(t),t.identity);if(cached)apply(cached);else void conversationCache.read(key(t),t.identity).then(apply);
    }
  };
}
let channel;
if(typeof window!=='undefined'&&typeof BroadcastChannel!=='undefined'){
  channel=new BroadcastChannel('agent-relay-conversation-cache');channel.onmessage=e=>{if(e.data==='clear')void conversationCache.clear();};
}
export function clearConversationCache(){channel?.postMessage('clear');return conversationCache.clear();}
