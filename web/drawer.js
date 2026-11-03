export function dragOffset(start,dx,width){return Math.max(-width,Math.min(0,start+dx));}
export function horizontalIntent(dx,dy){return Math.abs(dx)>10&&Math.abs(dx)>Math.abs(dy)*1.25;}
export function drawerOpens(offset,width,velocity){return Math.abs(velocity)>.45?velocity>0:offset>-width/2;}
export function sidebarWidth(width,viewport){return Math.round(Math.max(220,Math.min(520,Math.max(220,viewport-420),width)));}
export function setupSidebarResize(workspace,sidebar,handle){
  const media=matchMedia('(min-width:761px)'),key='agent-relay-sidebar-width';let preferred=null,drag=null;
  try{const stored=Number(localStorage.getItem(key));if(Number.isFinite(stored)&&stored>=220&&stored<=520)preferred=stored;}catch{}
  const defaultWidth=()=>innerWidth>=1500?290:270;
  function render(){
    handle.hidden=!media.matches;
    if(!media.matches){workspace.style.removeProperty('--sidebar-width');return;}
    const width=sidebarWidth(preferred??defaultWidth(),innerWidth);
    workspace.style.setProperty('--sidebar-width',width+'px');handle.setAttribute('aria-valuenow',String(width));handle.setAttribute('aria-valuemax',String(sidebarWidth(520,innerWidth)));handle.setAttribute('aria-valuetext',width+' 像素');
  }
  function save(){try{if(preferred===null)localStorage.removeItem(key);else localStorage.setItem(key,String(preferred));}catch{}}
  function finish(cancel=false){
    if(!drag)return;const old=drag;drag=null;
    if(cancel)preferred=old.before;else save();
    document.documentElement.classList.remove('sidebar-resizing');
    if(handle.hasPointerCapture(old.id))handle.releasePointerCapture(old.id);render();
  }
  handle.addEventListener('pointerdown',e=>{
    if(!media.matches||e.button!==0||!e.isPrimary)return;e.preventDefault();
    drag={id:e.pointerId,x:e.clientX,width:sidebar.getBoundingClientRect().width,before:preferred};handle.setPointerCapture(e.pointerId);document.documentElement.classList.add('sidebar-resizing');
  });
  handle.addEventListener('pointermove',e=>{if(!drag||e.pointerId!==drag.id)return;e.preventDefault();preferred=sidebarWidth(drag.width+e.clientX-drag.x,innerWidth);render();});
  handle.addEventListener('pointerup',e=>{if(e.pointerId===drag?.id)finish();});
  handle.addEventListener('pointercancel',()=>finish(true));handle.addEventListener('lostpointercapture',()=>finish(true));
  handle.addEventListener('dblclick',()=>{preferred=null;save();render();});
  handle.addEventListener('keydown',e=>{
    if(!media.matches)return;if(e.key==='Escape'){if(drag){e.preventDefault();finish(true);}return;}
    const current=sidebar.getBoundingClientRect().width,step=e.shiftKey?50:10;
    const next=e.key==='ArrowLeft'?current-step:e.key==='ArrowRight'?current+step:e.key==='Home'?220:e.key==='End'?520:null;
    if(next===null)return;e.preventDefault();preferred=sidebarWidth(next,innerWidth);save();render();
  });
  window.addEventListener('resize',()=>{finish(true);render();});window.addEventListener('blur',()=>finish(true));media.addEventListener('change',()=>{finish(true);render();});render();
}
export function setupDrawer(sidebar,backdrop,edge,open,close){
  const media=matchMedia('(max-width:760px)');let gesture=null,suppressClick=false;
  function set(isOpen){sidebar.classList.remove('dragging');sidebar.style.removeProperty('--drawer-offset');sidebar.style.removeProperty('--drawer-progress');sidebar.classList.toggle('open',!!isOpen);backdrop.hidden=!media.matches;backdrop.style.removeProperty('opacity');open.setAttribute('aria-expanded',String(!!isOpen));}
  open.onclick=()=>set(true);close.onclick=()=>set(false);backdrop.onclick=()=>set(false);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&sidebar.classList.contains('open'))set(false);});
  window.addEventListener('pointerdown',e=>{
    suppressClick=false;
    if(!media.matches||e.button!==0||!e.isPrimary||e.target.closest('input,textarea,select,dialog'))return;
    const isOpen=sidebar.classList.contains('open');if(isOpen?!sidebar.contains(e.target):e.clientX>28||!edge.contains(e.target))return;
    gesture={id:e.pointerId,x:e.clientX,y:e.clientY,time:performance.now(),width:sidebar.getBoundingClientRect().width,open:isOpen,active:false,target:e.target,offset:isOpen?0:-sidebar.getBoundingClientRect().width};
  });
  window.addEventListener('pointermove',e=>{
    const g=gesture;if(!g||g.id!==e.pointerId)return;const dx=e.clientX-g.x,dy=e.clientY-g.y;
    if(!g.active){if(Math.abs(dy)>10&&!horizontalIntent(dx,dy)){gesture=null;return;}if(!horizontalIntent(dx,dy))return;g.active=true;g.target.setPointerCapture?.(e.pointerId);sidebar.classList.add('dragging');backdrop.hidden=false;}
    e.preventDefault();g.offset=dragOffset(g.open?0:-g.width,dx,g.width);sidebar.style.setProperty('--drawer-offset',g.offset+'px');sidebar.style.setProperty('--drawer-progress',String(1+g.offset/g.width));backdrop.style.opacity=String(1+g.offset/g.width);
  },{passive:false});
  function finish(e,cancelled=false){const g=gesture;if(!g||e.pointerId!==g.id)return;gesture=null;if(g.active){e.preventDefault();suppressClick=true;set(cancelled?g.open:drawerOpens(g.offset,g.width,(e.clientX-g.x)/Math.max(1,performance.now()-g.time)));}}
  window.addEventListener('pointerup',e=>finish(e));window.addEventListener('pointercancel',e=>finish(e,true));
  document.addEventListener('click',e=>{if(suppressClick){e.preventDefault();e.stopImmediatePropagation();}},{capture:true});
  media.addEventListener('change',()=>set(false));set(false);return {close:()=>set(false)};
}
