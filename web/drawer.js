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
  const media=matchMedia('(max-width:760px)'),surfaces=new WeakSet();let gesture=null,suppressClick=false,lastTouch=-Infinity;
  const prevent=e=>{if(e.cancelable!==false)e.preventDefault();};
  function release(g){if(g?.kind==='pointer'&&g.target.hasPointerCapture?.(g.id))g.target.releasePointerCapture(g.id);}
  function set(isOpen){const old=gesture;gesture=null;release(old);sidebar.classList.remove('dragging');sidebar.style.removeProperty('--drawer-offset');sidebar.style.removeProperty('--drawer-progress');sidebar.classList.toggle('open',!!isOpen);backdrop.hidden=!media.matches;backdrop.style.removeProperty('opacity');open.setAttribute('aria-expanded',String(!!isOpen));}
  function move(e,x,y){
    const g=gesture;if(!g)return;const dx=x-g.x,dy=y-g.y;
    if(!g.active){
      if(Math.abs(dy)>10&&!horizontalIntent(dx,dy)){gesture=null;release(g);return;}
      if(!horizontalIntent(dx,dy)||(!g.open&&dx<0))return;
      g.active=true;if(g.kind==='pointer')g.target.setPointerCapture?.(g.id);sidebar.classList.add('dragging');backdrop.hidden=false;
    }
    prevent(e);g.offset=dragOffset(g.open?0:-g.width,dx,g.width);const progress=String(1+g.offset/g.width);sidebar.style.setProperty('--drawer-offset',g.offset+'px');sidebar.style.setProperty('--drawer-progress',progress);backdrop.style.opacity=progress;
  }
  function finish(e,x,cancelled=false){const g=gesture;if(!g)return;if(g.active){prevent(e);suppressClick=true;set(cancelled?g.open:drawerOpens(g.offset,g.width,(x-g.x)/Math.max(1,performance.now()-g.time)));}else{gesture=null;release(g);}}
  open.onclick=()=>set(true);close.onclick=()=>set(false);backdrop.onclick=()=>set(false);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&sidebar.classList.contains('open'))set(false);});
  window.addEventListener('pointerdown',e=>{
    // Touch Events own fingers, including Safari's edge gesture. Never run a
    // second pointer controller for the same touch or its emulated mouse input.
    if(e.pointerType==='touch'||performance.now()-lastTouch<800)return;
    suppressClick=false;if(!media.matches||e.button!==0||!e.isPrimary||e.target.closest('input,textarea,select,dialog'))return;
    const isOpen=sidebar.classList.contains('open');if(isOpen?!sidebar.contains(e.target)&&e.target!==backdrop:e.clientX>32||!edge.contains(e.target))return;
    const width=sidebar.getBoundingClientRect().width;gesture={kind:'pointer',id:e.pointerId,x:e.clientX,y:e.clientY,time:performance.now(),width,open:isOpen,active:false,target:e.target,offset:isOpen?0:-width};
  });
  window.addEventListener('pointermove',e=>{if(gesture?.kind==='pointer'&&gesture.id===e.pointerId)move(e,e.clientX,e.clientY);},{passive:false});
  window.addEventListener('pointerup',e=>{if(gesture?.kind==='pointer'&&gesture.id===e.pointerId)finish(e,e.clientX);});
  window.addEventListener('pointercancel',e=>{if(gesture?.kind==='pointer'&&gesture.id===e.pointerId)finish(e,e.clientX,true);});
  function connect(win){
    if(surfaces.has(win))return;surfaces.add(win);
    win.addEventListener('touchstart',e=>{
      lastTouch=performance.now();suppressClick=false;if(gesture)set(gesture.open);
      if(!media.matches||e.touches.length!==1)return;
      const isOpen=sidebar.classList.contains('open'),target=e.target;
      if(target.closest(isOpen?'input,textarea,select,dialog':'input,textarea,select,button,a,video,pre,dialog,.tabs,[data-no-drawer]'))return;
      if(isOpen&&(win!==window||!sidebar.contains(target)&&target!==backdrop))return;
      const p=e.touches[0],width=sidebar.getBoundingClientRect().width;
      gesture={kind:'touch',surface:win,id:p.identifier??0,x:p.clientX,y:p.clientY,time:performance.now(),width,open:isOpen,active:false,target,offset:isOpen?0:-width};
      // Cancelling touchmove is too late for Safari's page-back snapshot.
      // Reserve the page edges at touchstart; interior vertical scrolling and
      // taps on controls keep their native behavior.
      if(p.clientX<=32||p.clientX>=win.innerWidth-24)prevent(e);
    },{capture:true,passive:false});
    win.addEventListener('touchmove',e=>{
      const g=gesture;if(g?.kind!=='touch'||g.surface!==win)return;
      if(e.touches.length!==1){set(g.open);return;}
      const p=e.touches[0];if((p.identifier??0)!==g.id)return;move(e,p.clientX,p.clientY);
    },{capture:true,passive:false});
    const end=(e,cancelled)=>{const g=gesture;if(g?.kind!=='touch'||g.surface!==win)return;const p=[...e.changedTouches].find(p=>(p.identifier??0)===g.id);if(p)finish(e,p.clientX,cancelled);};
    win.addEventListener('touchend',e=>end(e,false),{capture:true,passive:false});win.addEventListener('touchcancel',e=>end(e,true),{capture:true,passive:false});
    win.document.addEventListener('click',e=>{if(suppressClick){prevent(e);e.stopImmediatePropagation();}},{capture:true});
  }
  set(false);connect(window);media.addEventListener('change',()=>set(false));window.addEventListener('blur',()=>set(sidebar.classList.contains('open')));return {close:()=>set(false),open:()=>set(true),connect};
}
