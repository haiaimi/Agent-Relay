import {svgCard} from './diagrams.js';
import {directAssets} from './direct.js';
export const videoMime=name=>({mp4:'video/mp4',m4v:'video/mp4',webm:'video/webm',mov:'video/quicktime',ogv:'video/ogg'}[name?.split('.').at(-1)?.toLowerCase()]);
export async function clipboardFiles(){
  if(!window.relayStudioDesktop?.pasteFiles)return [];
  const files=await window.relayStudioDesktop.pasteFiles();
  return files.map(f=>{const bytes=Uint8Array.from(atob(f.data),c=>c.charCodeAt(0));return new File([bytes],f.name,{type:f.mime||videoMime(f.name)||'application/octet-stream'});});
}
// Only trusted API references are rendered. Arbitrary HTML and remote media URLs are never executed.
export function mediaCard(ref,{sessionId,hostId,runId,kind='file'}){
  const card=document.createElement('div');card.className='studio-media';const download=document.createElement('a');download.textContent=ref.name||'图片';download.download=ref.name||'image';
  download.href=runId?'/api/studio/files/'+encodeURIComponent(ref.id)+'?runId='+encodeURIComponent(runId):'/api/'+(kind==='image'?'images':'files')+'/'+encodeURIComponent(ref.id)+'?sessionId='+encodeURIComponent(sessionId);card.append(download);
  if(!ref.id){download.removeAttribute('href');return card;}
  const svg=/\.svg$/i.test(ref.name??'');
  const mime=ref.mime?.startsWith('video/')?ref.mime:videoMime(ref.name),image=!mime&&(kind==='image'||ref.mime?.startsWith('image/'));
  if(image||mime||svg){const load=document.createElement('button');load.type='button';load.className='quiet';load.textContent=image||svg?'查看图片':'播放视频';card.append(load);
    const start=async()=>{load.disabled=true;try{
      let result;if(runId){const response=await fetch(download.href);if(!response.ok)throw Error('附件加载失败');const blob=await response.blob();if(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()).then(b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join(''))!==ref.sha256)throw Error('附件校验失败');result={blob};}
      else result=await directAssets.read({hostId,sessionId},kind,ref);
      if(!card.isConnected)return;
      if(svg){if(result.blob.size>1000000)throw Error('SVG 超过 1 MB 预览上限');card.append(svgCard(await result.blob.text(),ref.name));load.hidden=true;return;}
      const media=document.createElement(image?'img':'video');const url=URL.createObjectURL(mime?new Blob([result.blob],{type:mime}):result.blob);
      media.src=url;if(image){media.alt=ref.name;media.loading='lazy';}else{media.controls=true;media.playsInline=true;media.preload='metadata';media.onerror=()=>{load.hidden=false;load.textContent='此格式无法播放，可点击文件名下载';};}media.dataset.objectUrl=url;card.append(media);load.hidden=true;
    }catch(e){load.textContent=e.message+' · 重试';}finally{load.disabled=false;}};load.onclick=()=>void start();if(image||svg)void start();
  }return card;
}
export function disposeMedia(root){for(const media of root.querySelectorAll('[data-object-url]')){media.pause?.();if(media.dataset.objectUrl.startsWith('blob:'))URL.revokeObjectURL(media.dataset.objectUrl);}}
