// The authenticated media URL supports byte ranges, so playback and seeking need not download a full blob first.
export function videoCard(ref,target,kind='file'){
  const card=document.createElement('div');card.className='video-card';
  const video=document.createElement('video');video.controls=true;video.playsInline=true;video.preload='metadata';video.setAttribute('aria-label','会话视频');
  const url='/api/'+(kind==='image'?'images':'files')+'/'+encodeURIComponent(ref.id)+'?'+new URLSearchParams({sessionId:target.sessionId});video.src=url;
  const fallback=document.createElement('div');fallback.className='video-fallback';fallback.hidden=true;
  const hint=document.createElement('span');hint.textContent='视频无法播放，请重试或下载';
  const retry=document.createElement('button');retry.type='button';retry.textContent='重试';retry.onclick=()=>{fallback.hidden=true;video.load();};
  const download=document.createElement('a');download.href=url;download.download=ref.name||'video.mp4';download.textContent='下载视频';fallback.append(hint,retry,download);
  video.onloadedmetadata=()=>{if(video.videoWidth&&video.videoHeight)card.style.setProperty('--video-ratio',String(video.videoWidth/video.videoHeight));fallback.hidden=true;};
  video.onerror=()=>{fallback.hidden=false;};
  card.append(video,fallback);return card;
}
