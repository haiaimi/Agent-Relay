export function dragOffset(start,dx,width){return Math.max(-width,Math.min(0,start+dx));}
export function horizontalIntent(dx,dy){return Math.abs(dx)>10&&Math.abs(dx)>Math.abs(dy)*1.25;}
export function drawerOpens(offset,width,velocity){return Math.abs(velocity)>.45?velocity>0:offset>-width/2;}
export function setupDrawer(sidebar,backdrop,edge,open,close){
  const media=matchMedia('(max-width:760px)');let gesture=null,suppressClick=false;
  function set(isOpen){sidebar.classList.remove('dragging');sidebar.style.removeProperty('--drawer-offset');sidebar.classList.toggle('open',!!isOpen);backdrop.hidden=!isOpen||!media.matches;backdrop.style.removeProperty('opacity');open.setAttribute('aria-expanded',String(!!isOpen));}
  open.onclick=()=>set(true);close.onclick=()=>set(false);backdrop.onclick=()=>set(false);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!backdrop.hidden)set(false);});
  window.addEventListener('pointerdown',e=>{
    suppressClick=false;
    if(!media.matches||e.button!==0||!e.isPrimary||e.target.closest('input,textarea,select,dialog'))return;
    const isOpen=sidebar.classList.contains('open');if(isOpen?!sidebar.contains(e.target):e.clientX>28||!edge.contains(e.target))return;
    gesture={id:e.pointerId,x:e.clientX,y:e.clientY,time:performance.now(),width:sidebar.getBoundingClientRect().width,open:isOpen,active:false,target:e.target,offset:isOpen?0:-sidebar.getBoundingClientRect().width};
  });
  window.addEventListener('pointermove',e=>{
    const g=gesture;if(!g||g.id!==e.pointerId)return;const dx=e.clientX-g.x,dy=e.clientY-g.y;
    if(!g.active){if(Math.abs(dy)>10&&!horizontalIntent(dx,dy)){gesture=null;return;}if(!horizontalIntent(dx,dy))return;g.active=true;g.target.setPointerCapture?.(e.pointerId);sidebar.classList.add('dragging');backdrop.hidden=false;}
    e.preventDefault();g.offset=dragOffset(g.open?0:-g.width,dx,g.width);sidebar.style.setProperty('--drawer-offset',g.offset+'px');backdrop.style.opacity=String(1+g.offset/g.width);
  },{passive:false});
  function finish(e,cancelled=false){const g=gesture;if(!g||e.pointerId!==g.id)return;gesture=null;if(g.active){e.preventDefault();suppressClick=true;set(cancelled?g.open:drawerOpens(g.offset,g.width,(e.clientX-g.x)/Math.max(1,performance.now()-g.time)));}}
  window.addEventListener('pointerup',e=>finish(e));window.addEventListener('pointercancel',e=>finish(e,true));
  document.addEventListener('click',e=>{if(suppressClick){e.preventDefault();e.stopImmediatePropagation();}},{capture:true});
  media.addEventListener('change',()=>set(false));return {close:()=>set(false)};
}
