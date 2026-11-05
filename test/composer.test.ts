import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore Browser keyboard controller is exercised as shipped.
import {setupComposerKeys,setupReplyKeys} from '../web/composer.js';

function fixture(){
  const handlers=new Map<string,Function>();let time=1000,submitted=0,completed=0,hidden=0,moves:number[]=[],open=false;
  let candidate:any={name:'usage'};
  const input={value:'hello',addEventListener:(name:string,fn:Function)=>handlers.set(name,fn)};
  setupComposerKeys(input,{open:()=>open,current:()=>candidate,move:(n:number)=>moves.push(n),complete:()=>completed++,hide:()=>{hidden++;open=false;}},()=>submitted++,()=>time);
  return {input,key:(args:any={})=>{let prevented=false;handlers.get('keydown')!({key:'Enter',preventDefault:()=>prevented=true,...args});return prevented;},composition:(type:string)=>handlers.get(type)!(),advance:(n:number)=>time+=n,menu:(c:any)=>{open=true;candidate=c;},result:()=>({submitted,completed,hidden,moves})};
}
test('Enter sends through the shared form callback; Shift+Enter stays a newline',()=>{
  const f=fixture();assert.equal(f.key({shiftKey:true}),false);assert.equal(f.key({altKey:true}),false);assert.equal(f.result().submitted,0);
  assert.equal(f.key(),true);assert.equal(f.result().submitted,1);
  f.key({repeat:true});assert.equal(f.result().submitted,1);
  f.key({ctrlKey:true});f.key({metaKey:true});assert.equal(f.result().submitted,3);
});
test('IME confirmation including Safari composition-end Enter never sends',()=>{
  const f=fixture();f.key({isComposing:true});f.key({keyCode:229});f.composition('compositionstart');f.key();
  f.composition('compositionend');f.key();f.advance(49);f.key();assert.equal(f.result().submitted,0);
  f.advance(51);f.key();assert.equal(f.result().submitted,1);
});
test('command menu completes first, sends exact standalone commands and keeps navigation',()=>{
  const f=fixture();f.input.value='/us';f.menu({name:'usage'});f.key();assert.equal(f.result().completed,1);assert.equal(f.result().submitted,0);
  f.key({key:'ArrowDown'});f.key({key:'ArrowUp'});assert.deepEqual(f.result().moves,[1,-1]);
  f.input.value='/usage';f.key();assert.equal(f.result().submitted,1);assert.equal(f.result().hidden,1);
  f.input.value='/btw';f.menu({name:'btw',argumentHint:'<question>'});f.key();assert.equal(f.result().completed,2);assert.equal(f.result().submitted,1);
  assert.equal(f.key({shiftKey:true}),false);f.key({key:'Escape'});assert.equal(f.result().hidden,2);
  f.menu({name:'usage'});f.key({key:'Tab'});assert.equal(f.result().completed,3);
});

test('studio PC replies submit the existing form once and respect IME, newlines and disabled send buttons',()=>{
 const handlers=new Map<string,Function>(),button={disabled:false},submitted:unknown[]=[];
 const input={addEventListener:(name:string,fn:Function)=>handlers.set(name,fn),form:{requestSubmit:(b:unknown)=>submitted.push(b)}};
 setupReplyKeys(input,button,()=>true);
 const key=(extra:any={})=>{let prevented=false;handlers.get('keydown')!({key:'Enter',preventDefault:()=>prevented=true,...extra});return prevented;};
 assert.equal(key({shiftKey:true}),false);assert.equal(key({isComposing:true}),false);assert.equal(key({keyCode:229}),false);assert.equal(submitted.length,0);
 assert.equal(key(),true);assert.deepEqual(submitted,[button]);key({repeat:true});assert.equal(submitted.length,1);
 button.disabled=true;key();assert.equal(submitted.length,1);button.disabled=false;key();assert.equal(submitted.length,2);
});

test('studio touch keyboards retain Enter newlines, including key repeats',()=>{
 const handlers=new Map<string,Function>();let submitted=0;
 setupReplyKeys({addEventListener:(name:string,fn:Function)=>handlers.set(name,fn),form:{requestSubmit:()=>submitted++}},{disabled:false},()=>false);
 for(const repeat of [false,true]){let prevented=false;handlers.get('keydown')!({key:'Enter',repeat,preventDefault:()=>prevented=true});assert.equal(prevented,false);}
 assert.equal(submitted,0);
});
