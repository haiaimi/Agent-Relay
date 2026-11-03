// Serialize per-session settings writes, merging rapid edits without locking controls.
export class SettingsWrites {
  entries=new Map();
  constructor(send,changed=()=>{},accepted=()=>{},failed=()=>{}){Object.assign(this,{send,changed,accepted,failed});}
  set(id,patch){
    let entry=this.entries.get(id);
    if(!entry){entry={desired:{},version:0};this.entries.set(id,entry);}
    Object.assign(entry.desired,patch);entry.version++;this.changed();
    if(!entry.job)entry.job=Promise.resolve().then(()=>this.flush(id,entry));
    return entry.job;
  }
  pending(id){return this.entries.get(id)?.desired;}
  async wait(id){while(this.entries.get(id)?.job)await this.entries.get(id).job;}
  async flush(id,entry){
    try{while(this.entries.get(id)===entry){
      const version=entry.version,patch={...entry.desired};
      try{const result=await this.send(id,patch);this.accepted(id,patch,result);}
      catch(error){if(version===entry.version){this.failed(id,error);throw error;}}
      if(version===entry.version){this.entries.delete(id);break;}
    }}finally{if(this.entries.get(id)===entry)this.entries.delete(id);this.changed();}
  }
}
export class SendReceipts {
  entries=new Map();
  begin(sessionId,text){const item={id:crypto.randomUUID(),sessionId,role:'user',text,timestamp:Date.now(),label:'你 · 正在发送',delivery:'sending'};this.entries.set(item.id,item);return item;}
  update(id,patch){const item=this.entries.get(id);if(item)Object.assign(item,patch);}
  observe(message){for(const id of [message.id,...message.replaces??[]])this.entries.delete(id);}
  messages(sessionId,canonical){const merged=new Map([...this.entries.values()].filter(m=>m.sessionId===sessionId).map(m=>[m.id,m]));for(const m of canonical)merged.set(m.id,m);return [...merged.values()];}
}
