const MAX_BYTES=16*1024*1024;
export class AttachmentInput {
  drafts=new Map();locked=false;
  constructor(root,button,preview,context,changed){
    Object.assign(this,{root,button,preview,context,changed});
    // Keep this synchronous with the tap so iOS opens its own source picker.
    // No accept/capture restriction: the system offers photos, camera and files.
    const input=document.createElement('input');input.type='file';input.hidden=true;input.multiple=true;root.append(input);
    input.onchange=()=>{this.add([...input.files]);input.value='';};
    button.onclick=()=>{if(!this.locked)input.click();};
    root.addEventListener('paste',e=>{const files=[...(e.clipboardData?.files??[])];if(files.length){e.preventDefault();this.add(files);}});
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
    for(const file of files)items.push({file,url:file.type.startsWith('image/')?URL.createObjectURL(file):null});
    this.drafts.set(key,items);this.render();this.changed();
  }
  clear(key){for(const item of this.list(key))if(item.url)URL.revokeObjectURL(item.url);this.drafts.delete(key);this.render();this.changed();}
  reset(){for(const key of [...this.drafts.keys()])this.clear(key);}
  render(){
    this.preview.replaceChildren();this.preview.hidden=!this.count;this.button.disabled=this.locked;
    for(const item of this.list()){
      const card=document.createElement('div');card.className='attachment-draft';
      if(item.url){const img=document.createElement('img');img.src=item.url;img.alt=item.file.name;card.append(img);}
      const label=document.createElement('span');label.textContent=item.file.name;label.title=item.file.name;card.append(label);
      const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','移除附件：'+item.file.name);remove.disabled=this.locked;
      remove.onclick=()=>{const items=this.list();items.splice(items.indexOf(item),1);if(item.url)URL.revokeObjectURL(item.url);this.render();this.changed();};card.append(remove);this.preview.append(card);
    }
  }
  async upload(context){
    const items=[...this.list(context.key)];if(!items.length)return [];
    this.locked=true;this.render();this.changed('正在把附件传到电脑…');
    try{for(const item of items){
      if(item.ref)continue;
      const query=new URLSearchParams({...context.target,name:item.file.name});
      const r=await fetch('/api/uploads?'+query,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:item.file});const result=await r.json().catch(()=>({error:r.status===413?'附件超过上传大小限制':'附件传送失败，请重试'}));
      if(!r.ok||result.error)throw new Error(result.error??'附件上传失败');item.ref=result.file;
    }return items.map(i=>i.ref.id);}
    finally{this.locked=false;this.render();this.changed();}
  }
}
