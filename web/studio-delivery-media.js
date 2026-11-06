export function deliveryReferences(run,task){
  const sources=task.id==='studio-delivery'?[...run.tasks,task]:[task],seen=new Set(),result=[];
  for(const owner of sources)for(const [index,a]of(owner.artifacts??[]).entries()){
    const kind=/\.(mp4|webm|mov|m4v)$/i.test(a.path)?'video':/\.(png|jpe?g|webp|gif)$/i.test(a.path)?'image':null,key=a.path.replaceAll('\\','/').toLowerCase();
    if(!kind||!owner.sessionId||seen.has(key))continue;seen.add(key);result.push({...a,kind,taskId:owner.id,index,sessionId:owner.sessionId});
  }return result;
}
export function deliveryMedia(run,task){
  const refs=deliveryReferences(run,task),root=document.createElement('section');root.className='task-section';if(!refs.length)return root;
  const heading=document.createElement('h3');heading.textContent='成果预览 · '+refs.length;root.append(heading);const grid=document.createElement('div');grid.className='delivery-media-grid';root.append(grid);
  for(const ref of refs){
    const card=document.createElement('figure'),caption=document.createElement('figcaption'),url='/api/studio/'+(ref.kind==='video'?'video':'artifact')+'?'+new URLSearchParams({runId:run.id,taskId:ref.taskId,index:String(ref.index)});caption.textContent=ref.description||ref.path.split(/[\\/]/).at(-1);card.append(caption);grid.append(card);
    if(ref.kind==='video'){const video=document.createElement('video');video.controls=true;video.playsInline=true;video.preload='none';video.src=url;const note=document.createElement('p');note.className='fine';note.textContent='点击播放后从工作电脑流式读取；视频保存在本机。';video.onerror=()=>{note.textContent='视频暂不可播放，请确认工作电脑在线后重试。';};card.append(video,note);continue;}
    const status=document.createElement('p'),a=document.createElement('a'),img=document.createElement('img');status.className='fine';status.textContent='正在加载图片…';img.alt=caption.textContent;img.hidden=true;a.href=url;a.target='_blank';a.rel='noopener';a.append(img);card.append(a,status);
    const load=async()=>{try{const r=await fetch(url+'&preview=1');if(!r.ok)throw Error((await r.json()).error||'图片读取失败');const blob=await r.blob(),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');if(hash!==r.headers.get('X-Content-Sha256'))throw Error('图片完整性校验失败');if(!card.isConnected)return;const objectUrl=URL.createObjectURL(blob);img.dataset.objectUrl=objectUrl;img.src=objectUrl;await img.decode();if(!card.isConnected){URL.revokeObjectURL(objectUrl);return;}img.hidden=false;status.textContent='';}catch(e){status.textContent=e.message+' · 点击重试';status.onclick=()=>void load();}};void load();
  }return root;
}
