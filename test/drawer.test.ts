import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Browser helper is plain JavaScript.
import {dragOffset,horizontalIntent,drawerOpens,setupDrawer} from '../web/drawer.js';
test('drawer gestures preserve vertical scrolling, clamp movement, and settle by distance or swipe velocity',()=>{
 assert.equal(horizontalIntent(5,60),false);assert.equal(horizontalIntent(30,25),false);assert.equal(horizontalIntent(60,10),true);
 assert.equal(dragOffset(-320,500,320),0);assert.equal(dragOffset(0,-500,320),-320);
 assert.equal(drawerOpens(-100,320,.1),true);assert.equal(drawerOpens(-240,320,.1),false);
 assert.equal(drawerOpens(-260,320,.8),true);assert.equal(drawerOpens(-40,320,-.8),false);
});
test('the same drawer accepts a studio touch surface, ignores vertical scrolling and inputs, and closes on a left swipe',()=>{
 const original={window:globalThis.window,document:globalThis.document,matchMedia:globalThis.matchMedia};
 const surface=()=>{const handlers=new Map<string,Function[]>(),options=new Map();return {handlers,options,innerWidth:390,document:{addEventListener(){}},addEventListener:(type:string,fn:Function,opts:any)=>{options.set(type,opts);handlers.set(type,[...(handlers.get(type)??[]),fn]);},fire:(type:string,event:any)=>handlers.get(type)?.forEach(fn=>fn(event))};};
 const win=surface(),doc={addEventListener(){}},values=new Set<string>(),classes={contains:(key:string)=>values.has(key),add:(key:string)=>values.add(key),remove:(key:string)=>values.delete(key),toggle:(key:string,on:boolean)=>on?values.add(key):values.delete(key)},style={setProperty(){},removeProperty(){}},inside={closest:()=>null};
 const sidebar={classList:classes,style,getBoundingClientRect:()=>({width:320}),contains:(target:any)=>target===inside},backdrop={hidden:true,style},open={setAttribute(){}},close={};
 try{
  Object.assign(globalThis,{window:win,document:doc,matchMedia:()=>({matches:true,addEventListener(){}})});
  const drawer=setupDrawer(sidebar,backdrop,{contains:()=>false},open,close),child=surface();drawer.connect(child);
  const swipe=(target:any,from:number[],to:number[],cancel=false,surface=child)=>{const e=(point:number[])=>({target,touches:[{clientX:point[0],clientY:point[1]}],changedTouches:[{clientX:point[0],clientY:point[1]}],preventDefault(){}});surface.fire('touchstart',e(from));surface.fire('touchmove',e(to));surface.fire(cancel?'touchcancel':'touchend',e(to));};
  swipe(inside,[140,100],[145,350]);assert.equal(values.has('open'),false);
  swipe({closest:()=>({})},[100,100],[350,100]);assert.equal(values.has('open'),false);
  swipe(inside,[100,100],[350,105],true);assert.equal(values.has('open'),false);
  swipe(inside,[100,100],[350,105]);assert.equal(values.has('open'),true);
  swipe(inside,[280,200],[20,205],false,win);assert.equal(values.has('open'),false);
  drawer.connect(child);assert.equal(child.handlers.get('touchstart')?.length,1,'a retained studio must register only one touch controller');
  assert.deepEqual(child.options.get('touchstart'),{capture:true,passive:false});
  const edgeTouch:any={target:inside,touches:[{identifier:7,clientX:8,clientY:200}],changedTouches:[{identifier:7,clientX:8,clientY:200}],cancelable:true,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};
  child.fire('touchstart',edgeTouch);assert.equal(edgeTouch.defaultPrevented,true,'Safari navigation must be cancelled at touchstart, before its page snapshot starts moving');
  child.fire('touchmove',{...edgeTouch,touches:[{identifier:7,clientX:250,clientY:202}]});assert.equal(values.has('dragging'),true);
  win.fire('pointercancel',{pointerType:'touch',pointerId:7,clientX:250,preventDefault(){}});assert.equal(values.has('dragging'),true,'a synthetic pointer event cannot finish the touch drawer');
  child.fire('touchend',{...edgeTouch,changedTouches:[{identifier:7,clientX:250,clientY:202}]});assert.equal(values.has('open'),true);
  drawer.close();const interior={...edgeTouch,defaultPrevented:false,touches:[{identifier:7,clientX:150,clientY:200}]};child.fire('touchstart',interior);assert.equal(interior.defaultPrevented,false,'interior taps and vertical scrolling keep default behavior');
  child.fire('touchcancel',interior);assert.equal(values.has('open'),false);assert.equal(values.has('dragging'),false);
 }finally{Object.assign(globalThis,original);}
});
