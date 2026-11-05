import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore Browser module.
import {studioViewportRect,setupStudioViewport} from '../web/studio-viewport.js';

test('iPhone keyboard geometry uses the visible viewport including Safari pan, and ignores transient invalid/zoomed samples',()=>{
  assert.deepEqual(studioViewportRect({height:430,offsetTop:90,scale:1},844),{height:430,top:90,keyboard:true});
  assert.deepEqual(studioViewportRect({height:430,offsetTop:0,scale:1},430,844),{height:430,top:0,keyboard:true});
  assert.deepEqual(studioViewportRect(undefined,844),{height:844,top:0,keyboard:false});
  assert.equal(studioViewportRect({height:0,offsetTop:0,scale:1},844),null);
  assert.equal(studioViewportRect({height:430,offsetTop:50,scale:2},844),null);
});
function fixture(){
  const classes=()=>{const values=new Set<string>();return {values,add:(...names:string[])=>names.forEach(n=>values.add(n)),remove:(...names:string[])=>names.forEach(n=>values.delete(n)),toggle:(name:string,on:boolean)=>on?values.add(name):values.delete(name)};};
  const properties=new Map(),root={classList:classes(),style:{setProperty:(key:string,value:string)=>properties.set(key,value)}},body={classList:classes()},calls:any[]=[],media={matches:true,addEventListener(){}},viewport={height:844,offsetTop:0,scale:1,addEventListener(){}};
  let open=0;const win={innerHeight:844,innerWidth:390,scrollY:1700,visualViewport:viewport,matchMedia:()=>media,scrollTo:(value:any)=>calls.push(value),addEventListener(){},requestAnimationFrame:(fn:()=>void)=>{fn();return 0;},MutationObserver:class{observe(){}}};
  const doc={documentElement:root,body,querySelector:(selector:string)=>selector==='dialog[open]'&&open?{}:null,addEventListener(){}};
  const manager=setupStudioViewport({window:win,document:doc});return {root,body,properties,calls,viewport,win,media,manager,setOpen:(n:number)=>{open=n;manager.sync();}};
}
test('stacked studio modals lock the original page once; keyboard movement never scrolls it and closing the last modal restores its place',()=>{
  const f=fixture();f.setOpen(1);assert.equal(f.properties.get('--studio-page-offset'),'-1700px');assert.equal(f.body.classList.values.has('studio-modal-open'),true);
  f.setOpen(2);f.win.scrollY=0;f.viewport.height=430;f.viewport.offsetTop=90;f.manager.sync();assert.equal(f.properties.get('--studio-viewport-height'),'430px');assert.equal(f.properties.get('--studio-viewport-top'),'90px');assert.equal(f.root.classList.values.has('studio-keyboard-open'),true);assert.equal(f.calls.length,0);
  f.setOpen(1);assert.equal(f.calls.length,0);f.viewport.height=844;f.viewport.offsetTop=0;f.manager.sync();assert.equal(f.root.classList.values.has('studio-keyboard-open'),false);
  f.setOpen(0);assert.equal(f.body.classList.values.has('studio-modal-open'),false);assert.deepEqual(f.calls,[{top:1700,left:0,behavior:'auto'}]);f.manager.sync();assert.equal(f.calls.length,1);
});
test('keyboard adaptation also handles browsers that shrink innerHeight and does not lock the desktop page',()=>{
  const f=fixture();f.setOpen(1);f.win.innerHeight=430;f.viewport.height=430;f.manager.sync();assert.equal(f.root.classList.values.has('studio-keyboard-open'),true);
  f.win.innerWidth=844;f.win.innerHeight=390;f.viewport.height=390;f.manager.sync();assert.equal(f.root.classList.values.has('studio-keyboard-open'),false);
  const desktop=fixture();desktop.media.matches=false;desktop.setOpen(2);assert.equal(desktop.body.classList.values.has('studio-modal-open'),false);assert.equal(desktop.calls.length,0);
});
