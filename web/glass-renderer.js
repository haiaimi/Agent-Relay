// The scene copy is fixed in the same viewport as #glassWallpaper. The moving
// card only clips it; async iOS scrolling never has to update texture offsets.
function createLayerGlassRenderer(){
  const root=document.documentElement;
  // The session list can contain hundreds of rows. Keep sampled lenses on
  // stable panels and a few small cards, not on every scrolling list item.
  const selector='.topbar,.welcome,.host-card,.conversation-head,.composer-wrap,.login-card,.session-settings,#create-dialog';
  const mounted=new Map(),rimMasks=new Map(),sideMasks=new Map();let scheduled=0,layoutCount=0;
  const ios=/iP(?:hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  let editing=false,resumeTimer=0;
  const editable=e=>e instanceof Element&&!!e.closest('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]),textarea,[contenteditable="true"]');
  function clearPictures(item){item.lens.replaceChildren();item.lens.style.removeProperty('--lg-rim-mask');item.lens.style.removeProperty('--lg-top-mask');item.lens.style.removeProperty('--lg-bottom-mask');item.maskKey='';item.mode='';item.pictures=[]}
  function rimOpacity(distance,band){
    const t=Math.max(0,Math.min(1,1+distance/band));
    // The first refracted pixel must meet the unshifted scene at the perimeter.
    const u=Math.max(0,Math.min(1,-distance/2));
    return Math.pow(t,2.3)*u*u*(3-2*u);
  }
  function sideMask(band,reverse=false){
    const key=band.toFixed(2)+(reverse?':right':':left');
    if(sideMasks.has(key))return sideMasks.get(key);
    const scale=3,w=Math.max(2,Math.ceil(band*scale));
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=1;
    const context=canvas.getContext('2d');if(!context)return '';
    const image=context.createImageData(w,1);
    for(let px=0;px<w;px++){
      const x=(px+.5)/scale,distance=-(reverse?band-x:x);
      const index=px*4;image.data[index]=image.data[index+1]=image.data[index+2]=255;
      image.data[index+3]=Math.round(255*rimOpacity(distance,band));
    }
    context.putImageData(image,0,0);
    const value='url("'+canvas.toDataURL('image/png')+'")';canvas.width=canvas.height=1;
    sideMasks.set(key,value);return value;
  }
  function rimMask(width,height,radius,band,offset=0,maskHeight=height,insideOnly=false){
    const key=[width.toFixed(2),height.toFixed(2),radius.toFixed(2),band.toFixed(2),offset.toFixed(2),maskHeight.toFixed(2),insideOnly?'inner':'full'].join(':');
    if(rimMasks.has(key)){const value=rimMasks.get(key);rimMasks.delete(key);rimMasks.set(key,value);return {key,value}}
    const scale=1.5,w=Math.max(2,Math.ceil(width*scale)),h=Math.max(2,Math.ceil(maskHeight*scale));
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
    const context=canvas.getContext('2d');if(!context)return {key,value:''};
    const image=context.createImageData(w,h),pixels=image.data;
    const halfW=width/2,halfH=height/2;
    for(let py=0;py<h;py++)for(let px=0;px<w;px++){
      const x=(px+.5)/scale,y=offset+(py+.5)/scale;
      const qx=Math.abs(x-halfW)-(halfW-radius),qy=Math.abs(y-halfH)-(halfH-radius);
      const distance=Math.hypot(Math.max(qx,0),Math.max(qy,0))+Math.min(Math.max(qx,qy),0)-radius;
      const index=(py*w+px)*4;pixels[index]=pixels[index+1]=pixels[index+2]=255;
      pixels[index+3]=Math.round(255*rimOpacity(distance,band)*(insideOnly?Math.max(0,Math.min(1,.5-distance)):1));
    }
    context.putImageData(image,0,0);
    const value='url("'+canvas.toDataURL('image/png')+'")';canvas.width=canvas.height=1;
    rimMasks.set(key,value);if(rimMasks.size>48)rimMasks.delete(rimMasks.keys().next().value);
    return {key,value};
  }
  function ringClip(width,height,radius,band,xOffset,yOffset){
    const n=value=>Number(value.toFixed(2));
    function roundedRect(x,y,w,h,r){
      const right=x+w,bottom=y+h;
      return `M${n(x+r)} ${n(y)} H${n(right-r)} A${n(r)} ${n(r)} 0 0 1 ${n(right)} ${n(y+r)} V${n(bottom-r)} A${n(r)} ${n(r)} 0 0 1 ${n(right-r)} ${n(bottom)} H${n(x+r)} A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(bottom-r)} V${n(y+r)} A${n(r)} ${n(r)} 0 0 1 ${n(x+r)} ${n(y)} Z`;
    }
    const outer=roundedRect(-xOffset,-yOffset,width,height,radius);
    const inner=roundedRect(band-xOffset,band-yOffset,width-2*band,height-2*band,Math.max(.1,radius-band));
    return `path(evenodd, "${outer} ${inner}")`;
  }
  function suspend(event){
    if(!ios||(!editable(event.target)&&!event.target.closest?.('.searchBox')))return;
    clearTimeout(resumeTimer);if(editing)return;
    editing=true;root.dataset.glassEditing='1';
    if(scheduled){cancelAnimationFrame(scheduled);scheduled=0}
    for(const item of mounted.values())clearPictures(item);
    root.dataset.glassActivePictures='0';
  }
  function resume(){
    if(!editing)return;clearTimeout(resumeTimer);if(editable(document.activeElement))return;
    resumeTimer=setTimeout(()=>{
      if(editable(document.activeElement))return;
      editing=false;delete root.dataset.glassEditing;schedule();
    },300);
  }
  if(ios){
    for(const type of ['pointerdown','touchstart','focusin'])document.addEventListener(type,suspend,{capture:true,passive:true});
    for(const type of ['focusout','pointerup','touchend','pointercancel'])document.addEventListener(type,resume,{capture:true,passive:true});
    window.addEventListener('resize',resume,{passive:true});
    for(const type of ['resize','scroll'])window.visualViewport?.addEventListener(type,resume,{passive:true});
    window.addEventListener('pageshow',resume,{passive:true});
  }
  const resizeObserver=new ResizeObserver(schedule);
  const onVisibility=entries=>{
    let changed=false;
    for(const entry of entries){const item=mounted.get(entry.target);if(item&&item.near!==entry.isIntersecting){item.near=entry.isIntersecting;changed=true}}
    if(changed)schedule();
  };
  const visible=new IntersectionObserver(onVisibility,{rootMargin:'160px 0px'});
  // Results are numerous. A viewport-sized scene copy on every nearby row
  // can exhaust the iOS browser process while the list is being scrolled.
  const visibleResults=new IntersectionObserver(onVisibility,{rootMargin:'300px 0px'});
  function addPicture(item,container,name){
    const zone=document.createElement('span');zone.className='lg-zone lg-'+name;
    const picture=document.createElement('span');picture.className='lg-picture';
    zone.append(picture);container.append(zone);item.pictures.push(picture);
  }
  function createPictures(item,flat){
    if(flat){
      // The long panel only clips four narrow strips. A vector ring clips the
      // fixed scene itself; WebKit does not reliably clip it with a PNG mask.
      addPicture(item,item.lens,'long-left');addPicture(item,item.lens,'long-right');
      addPicture(item,item.lens,'long-top');addPicture(item,item.lens,'long-bottom');
      item.mode='long';return;
    }
    // The enclosing panel already supplies the base glass color; a result
    // only needs its refracted rim and its own frosted tint.
    for(const name of item.isResult?['rim']:['base','rim']){
      addPicture(item,item.lens,name);
    }
    item.mode='normal';
  }
  function mount(element){
    if(mounted.has(element))return;
    let surface=element;
    if(element.matches('details')){
      if(element.parentElement.classList.contains('lg-disclosure'))surface=element.parentElement;
      else{surface=document.createElement('div');surface.className='lg-disclosure';surface.style.borderRadius=getComputedStyle(element).borderRadius;element.before(surface);surface.append(element)}
    }
    let lens=surface.querySelector(':scope > .lg-lens');
    if(!lens){lens=document.createElement('span');lens.className='lg-lens';lens.setAttribute('aria-hidden','true');surface.append(lens)}
    const isResult=element.matches('.card.glassEntry');
    surface.dataset.layerGlass='1';mounted.set(element,{lens,pictures:[],surface,near:false,isResult});
    resizeObserver.observe(surface);(isResult?visibleResults:visible).observe(element);
  }
  function schedule(){if(!editing&&!scheduled)scheduled=requestAnimationFrame(layout)}
  function layout(){
    scheduled=0;if(editing)return;
    for(const element of document.querySelectorAll(selector))mount(element);
    const bg=document.getElementById('glassWallpaper').getBoundingClientRect();
    for(const [element,item] of mounted){
      if(!element.isConnected){clearPictures(item);resizeObserver.unobserve(item.surface);(item.isResult?visibleResults:visible).unobserve(element);mounted.delete(element);continue}
      const r=item.surface.getBoundingClientRect(),present=r.width>=2&&r.height>=2;
      const flat=present&&(r.height>Math.min(1200,bg.height*1.5)||r.width*r.height>900000);
      item.surface.dataset.glassFlat=flat?'1':'0';
      item.lens.dataset.flat=flat?'1':'0';item.lens.dataset.active=item.near&&present?'1':'0';
      if(!present||!item.near){if(item.pictures.length)clearPictures(item);continue}
      if(item.mode!==(flat?'long':'normal')){if(item.pictures.length)clearPictures(item);createPictures(item,flat)}
      const lensRect=item.lens.getBoundingClientRect(),w=lensRect.width,h=lensRect.height;
      const radius=parseFloat(getComputedStyle(item.surface).borderTopLeftRadius)||20;
      const safeRadius=Math.max(0,Math.min(radius,w/2,h/2));
      const band=Math.max(2,Math.min(9,safeRadius*.45,Math.min(w,h)*.1));
      item.lens.style.setProperty('--lg-radius',safeRadius+'px');
      const key=[w.toFixed(2),h.toFixed(2),safeRadius.toFixed(2),band.toFixed(2)].join(':');
      if(item.maskKey!==key){
        if(flat){
          const cap=Math.min(h/2,Math.max(safeRadius+band,band*2));
          item.lens.style.setProperty('--lg-band',band+'px');
          item.lens.style.setProperty('--lg-cap',cap+'px');
          item.lens.style.setProperty('--lg-left-mask',sideMask(band));
          item.lens.style.setProperty('--lg-right-mask',sideMask(band,true));
          item.lens.style.setProperty('--lg-top-mask',rimMask(w,h,safeRadius,band,0,cap).value);
          item.lens.style.setProperty('--lg-bottom-mask',rimMask(w,h,safeRadius,band,h-cap,cap).value);
          for(const [name,x,y] of [['long-left',0,cap],['long-right',w-band,cap],['long-top',0,0],['long-bottom',0,h-cap]]){
            item.lens.querySelector('.lg-'+name).style.clipPath=ringClip(w,h,safeRadius,band,x,y);
          }
        }else item.lens.style.setProperty('--lg-rim-mask',rimMask(w,h,safeRadius,band).value);
        item.maskKey=key;
      }
      item.lens.dataset.nested=element.matches('.host-card')?'1':'0';
    }
    root.dataset.glassLayoutCount=String(++layoutCount);
    root.dataset.glassActivePictures=String([...mounted.values()].reduce((n,item)=>n+item.pictures.length,0));
  }
  new MutationObserver(records=>{
    if(records.some(r=>!r.target.closest?.('.lg-lens')&&[...r.addedNodes,...r.removedNodes].some(n=>!(n.nodeType===1&&n.classList.contains('lg-lens')))))schedule();
  }).observe(document.body,{childList:true,subtree:true});
  resizeObserver.observe(document.body);window.addEventListener('resize',schedule,{passive:true});document.addEventListener('toggle',schedule,true);
  root.dataset.glassLayers='1';root.dataset.glassBuild='fixed-scene-20261007';schedule();
  return {
    getVisibleCount:()=>mounted.size,
    setScene:()=>{root.dataset.glassScene='ready';schedule()},
    refreshLayout:()=>{if(scheduled){cancelAnimationFrame(scheduled);scheduled=0}layout()}
  };
}
