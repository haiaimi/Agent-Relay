import {directAssets} from './direct.js';
const MAX_BYTES=16*1024*1024;
export class AttachmentInput {
  drafts=new Map();locked=false;
  constructor(root,button,preview,context,changed,options={}){
    Object.assign(this,{root,button,preview,context,changed,options});
    // Keep this synchronous with the tap so iOS opens its own source picker.
    // No accept/capture restriction: the system offers photos, camera and files.
    const input=document.createElement('input');input.type='file';input.hidden=true;input.multiple=true;root.append(input);
    input.onchange=()=>{this.add([...input.files]);input.value='';};
    button.onclick=()=>{if(!this.locked)input.click();};
    root.addEventListener('paste',e=>{const files=[...(e.clipboardData?.files??[])];if(files.length){e.preventDefault();this.add(files);}else if(e.isTrusted&&this.options.clipboardFiles&&!e.clipboardData?.getData('text/plain')){void this.options.clipboardFiles().then(files=>this.add(files)).catch(error=>this.changed(error.message));}});
    root.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();root.classList.add('file-dragover');}});
    root.addEventListener('dragleave',e=>{if(!root.contains(e.relatedTarget))root.classList.remove('file-dragover');});
    root.addEventListener('drop',e=>{e.preventDefault();root.classList.remove('file-dragover');this.add([...(e.dataTransfer?.files??[])]);});
  }
  list(key=this.context()?.key){return this.drafts.get(key)??[];}
  get count(){return this.list().length;}
  add(files){
    if(this.locked||!files.length||!this.context())return;
    const key=this.context().key,items=this.list(key);
    if(items.length+files.length>5||items.reduce((n,x)=>n+x.file.size,0)+files.reduce((n,f)=>n+f.size,0)>MAX_BYTES){this.changed('最多 5 个附件，总大小不能超过 16 MB');return;}
    if(files.some(f=>!f.size)){this.changed('不能发送空文件');return;}
    for(const file of files)items.push({file,url:/^(image|video)\//.test(file.type)?URL.createObjectURL(file):null});
    this.drafts.set(key,items);this.render();this.changed();
  }
  clear(key){for(const item of this.list(key))if(item.url)URL.revokeObjectURL(item.url);this.drafts.delete(key);this.render();this.changed();}
  reset(){for(const key of [...this.drafts.keys()])this.clear(key);}
  render(){
    this.preview.replaceChildren();this.preview.hidden=!this.count;this.button.disabled=this.locked;
    for(const item of this.list()){
      const card=document.createElement('div');card.className='attachment-draft';
      if(item.url){const media=document.createElement(item.file.type.startsWith('video/')?'video':'img');media.src=item.url;if(media.tagName==='VIDEO'){media.controls=true;media.preload='metadata';media.playsInline=true;}else media.alt=item.file.name;card.append(media);}
      const label=document.createElement('span');label.textContent=item.file.name;label.title=item.file.name;card.append(label);
      const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','移除附件：'+item.file.name);remove.disabled=this.locked;
      remove.onclick=()=>{const items=this.list();items.splice(items.indexOf(item),1);if(item.url)URL.revokeObjectURL(item.url);this.render();this.changed();};card.append(remove);this.preview.append(card);
    }
  }
  async upload(context){
    const items=[...this.list(context.key)];if(!items.length)return [];
    this.locked=true;this.render();this.changed('正在把附件传到电脑…');
    try{for(const item of items){
      const target=JSON.stringify(context.target);if(item.ref&&item.target===target)continue;
      if(item.target&&item.target!==target)item.uploadId=undefined;
      item.uploadId??=crypto.randomUUID();item.ref=await directAssets.upload(context.target,item.file,item.uploadId);
      item.target=target;
    }return items.map(i=>i.ref.id);}
    finally{this.locked=false;this.render();this.changed();}
  }
}
