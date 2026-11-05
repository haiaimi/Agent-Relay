// One document owns navigation; each workspace keeps its DOM, scroll and drafts.
import {setupStudioSidebar} from './studio-sidebar.js';
export function workspaceRoute(value){const url=new URL(value,'http://relay.local');return {view:url.pathname==='/studio'?'studio':'sessions',sessionId:url.searchParams.get('sessionId')};}
export function setupWorkspaceShell({getState,selectSession,getSelected,drawer,onView}){
  const $=id=>document.getElementById(id),frame=$('studio-frame');let view='sessions',ready=false,studioReady=false,sessionScroll=0;
  const studioSidebar=setupStudioSidebar($('studio-sidebar'),command=>{frame.contentWindow?.postMessage({type:'relay-studio-command',...command},location.origin);if(command.command!=='project')drawer.close();});
  function sendActive(){frame.contentWindow?.postMessage({type:'relay-workspace-active',active:view==='studio'},location.origin);}
  function loadStudio(){if(!ready||$('workspace').hidden||frame.hasAttribute('src'))return;studioReady=false;$('studio-loading').hidden=false;frame.src='/studio?embedded=1';}
  function show(next,{push=true,sessionId}={}){
    const changed=view!==next;if(changed&&view==='sessions')sessionScroll=$('timeline').scrollTop;
    view=next;$('session-view').hidden=view!=='sessions';$('studio-view').hidden=view!=='studio';$('workspace').dataset.view=view;
    $('studio-sidebar').hidden=view!=='studio';for(const id of ['new-session','session-search-wrap','sidebar-filters','session-list-heading','session-list'])$(id).hidden=view==='studio';
    $('open-sidebar').setAttribute('aria-label',view==='studio'?'打开制作进度':'打开会话列表');$('close-sidebar').setAttribute('aria-label',view==='studio'?'关闭制作进度':'关闭会话列表');
    for(const a of document.querySelectorAll('#sidebar .app-nav-item')){const active=(a.pathname==='/studio')===(view==='studio');a.classList.toggle('active',active);if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}
    $('workspace-name').textContent=view==='studio'?'游戏工作室':'会话工作台';document.title='Agent Relay · '+$('workspace-name').textContent;
    const id=sessionId??getSelected()?.id,url=view==='studio'?'/studio':id?'/?sessionId='+encodeURIComponent(id):'/';
    // Workspaces are tabs in one fixed shell, not separate history pages.
    if(push&&location.pathname+location.search!==url)history[changed?'replaceState':'pushState'](null,'',url);
    if(view==='studio')loadStudio();
    sendActive();drawer.close();
    if(changed&&view==='sessions')requestAnimationFrame(()=>{$('timeline').scrollTop=sessionScroll;onView?.(view);});else onView?.(view);
  }
  async function route(value,{push=true}={}){const target=workspaceRoute(value);show(target.view,{push,sessionId:target.sessionId});if(target.view==='sessions'&&target.sessionId&&getSelected()?.id!==target.sessionId){const session=getState().sessions.find(s=>s.id===target.sessionId);if(session)await selectSession(session);}}
  document.querySelector('#sidebar .app-nav').addEventListener('click',e=>{const a=e.target.closest('a');if(!a||e.button||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();void route(a.href);});
  window.addEventListener('popstate',()=>void route(location.href,{push:false}));
  window.addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==frame.contentWindow)return;if(e.data?.type==='relay-studio-ready'){studioReady=true;$('studio-loading').hidden=true;sendActive();}if(e.data?.type==='relay-studio-progress')studioSidebar.update(e.data.progress);if(e.data?.type==='relay-open-session'&&typeof e.data.sessionId==='string')void route('/?sessionId='+encodeURIComponent(e.data.sessionId));});
  // Same-origin child reads the existing snapshot instead of downloading it again.
  window.relayWorkspace=Object.freeze({getState,connectDrawer:win=>drawer.connect(win),get active(){return view==='studio';}});
  return {get view(){return view;},show,reset(){studioSidebar.reset();},async start(){ready=true;await route(location.href,{push:false});if(window.requestIdleCallback)window.requestIdleCallback(loadStudio,{timeout:1800});else setTimeout(loadStudio,800);},refreshStudio(){if(studioReady)frame.contentWindow.postMessage({type:'relay-studio-refresh'},location.origin);}};
}

export function prepareStudioEmbed(onActive,onRefresh,onCommand){
  const embedded=window.parent!==window&&new URLSearchParams(location.search).get('embedded')==='1';
  if(!embedded)return {get active(){return true;},state:()=>null,ready(){},sidebar(){}};
  const parent=window.parent,shared=parent.relayWorkspace;
  document.documentElement.classList.add('studio-embedded');
  if(parent.relayStudioDesktop)window.relayStudioDesktop=parent.relayStudioDesktop;
  shared?.connectDrawer(window);let active=shared?.active??true;
  document.addEventListener('click',e=>{const a=e.target.closest('a[href]');if(!a||e.button||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||a.target||a.download)return;const url=new URL(a.href,location.href);if(url.origin===location.origin&&url.pathname==='/'&&url.searchParams.has('sessionId')){e.preventDefault();parent.postMessage({type:'relay-open-session',sessionId:url.searchParams.get('sessionId')},location.origin);}});
  window.addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==parent)return;if(e.data?.type==='relay-workspace-active'&&active!==!!e.data.active){active=!!e.data.active;onActive(active);}if(e.data?.type==='relay-studio-refresh')onRefresh();if(e.data?.type==='relay-studio-command')onCommand?.(e.data);});
  // storage events also reach the retained studio when the parent changes theme.
  const syncTheme=()=>{for(const key of ['theme','themeMode'])document.documentElement.dataset[key]=parent.document.documentElement.dataset[key];};
  new MutationObserver(syncTheme).observe(parent.document.documentElement,{attributes:true,attributeFilter:['data-theme','data-theme-mode']});syncTheme();
  return {get active(){return active;},state:()=>shared?.getState(),ready:()=>parent.postMessage({type:'relay-studio-ready'},location.origin),sidebar:progress=>parent.postMessage({type:'relay-studio-progress',progress},location.origin)};
}
