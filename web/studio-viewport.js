// iOS resizes/pans the visual viewport for the keyboard while 100dvh can
// continue to describe the layout viewport. Keep the modal in the visible area.
export function studioViewportRect(viewport,height,baseline=height){
  if(viewport&&(viewport.scale>1.05||viewport.height<=0))return null;
  const top=Math.max(0,viewport?.offsetTop??0),visible=Math.max(1,Math.min(viewport?.height??height,Math.max(1,height-top)));
  return {top,height:visible,keyboard:Math.max(height,baseline)-visible>120};
}
export function setupStudioViewport({window:win=window,document:doc=document}={}){
  const mobile=win.matchMedia('(max-width: 800px)'),root=doc.documentElement;
  let locked=false,savedY=0,frame=0,geometry='',baseline=win.innerHeight,width=win.innerWidth;
  function sync(){
    const open=mobile.matches&&!!doc.querySelector('dialog[open]');
    if(open&&!locked){savedY=win.scrollY;root.style.setProperty('--studio-page-offset',-savedY+'px');root.classList.add('studio-modal-open');doc.body.classList.add('studio-modal-open');locked=true;}
    if(!open&&locked){root.classList.remove('studio-modal-open','studio-keyboard-open','studio-short-keyboard');doc.body.classList.remove('studio-modal-open');locked=false;geometry='';win.scrollTo({top:savedY,left:0,behavior:'auto'});}
    if(!open)return;
    if(Math.abs(win.innerWidth-width)>80){width=win.innerWidth;baseline=win.innerHeight;}else baseline=Math.max(baseline,win.innerHeight);
    const rect=studioViewportRect(win.visualViewport,win.innerHeight,baseline);if(!rect)return;
    const signature=JSON.stringify(rect);if(signature===geometry)return;geometry=signature;
    const timeline=doc.querySelector('.chat-dialog[open] .chat-timeline'),follow=timeline&&timeline.scrollHeight-timeline.scrollTop-timeline.clientHeight<60;
    const anchor=timeline&&[...timeline.children].find(e=>e.getBoundingClientRect().bottom>timeline.getBoundingClientRect().top),offset=anchor?.getBoundingClientRect().top-(timeline?.getBoundingClientRect().top??0);
    root.style.setProperty('--studio-viewport-height',rect.height+'px');root.style.setProperty('--studio-viewport-top',rect.top+'px');
    root.classList.toggle('studio-keyboard-open',rect.keyboard);root.classList.toggle('studio-short-keyboard',rect.keyboard&&rect.height<320);
    // Only the conversation scrolls. Never scroll the page or focus the field
    // again while Safari is animating/panning the keyboard.
    if(timeline){if(follow)timeline.scrollTop=timeline.scrollHeight;else if(anchor?.isConnected)timeline.scrollTop+=anchor.getBoundingClientRect().top-timeline.getBoundingClientRect().top-offset;}
  }
  function schedule(){if(!frame)frame=win.requestAnimationFrame(()=>{frame=0;sync();});}
  const observer=new win.MutationObserver(schedule);observer.observe(doc.body,{subtree:true,attributes:true,attributeFilter:['open']});
  win.addEventListener('resize',schedule);win.visualViewport?.addEventListener('resize',schedule);win.visualViewport?.addEventListener('scroll',schedule);mobile.addEventListener('change',schedule);
  doc.addEventListener('focusin',schedule);doc.addEventListener('focusout',schedule);doc.addEventListener('close',schedule,true);sync();
  return {sync};
}
