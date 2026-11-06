import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Browser module is plain JavaScript.
import {studioRepository} from '../web/studio-repository.js';

test('repository machine picker shows every registered machine and explains legacy/offline restrictions without sending a request',async()=>{
 const original=globalThis.document;
 const element=(tag:string)=>{let value:string|undefined;const n:any={tagName:tag,children:[],textContent:'',disabled:false,append(...items:any[]){this.children.push(...items);},replaceChildren(...items:any[]){this.children=items;value=undefined;},setAttribute(){},addEventListener(){},showModal(){},close(){},remove(){}};Object.defineProperty(n,'options',{get:()=>n.children});Object.defineProperty(n,'value',{get:()=>value??(tag==='select'?n.children[0]?.value??'':''),set:v=>value=v});return n;};
 const body=element('body'),walk=(n:any):any[]=>[n,...n.children.flatMap(walk)];
 const devices:any[]=[{id:'pc',name:'PC',online:true,capabilities:{studioRepositoryConnect:true},projects:[]},{id:'older-mac',name:'Older Mac',online:true,capabilities:{studioRepository:true},projects:[]},{id:'new-mac',name:'New Mac',online:true,capabilities:{studioRepositoryConnect:true},projects:[]}];let requests=0;
 try{
  Object.assign(globalThis,{document:{createElement:element,body}});
  studioRepository({api:async()=>{requests++;},notify(){},refresh(){},hosts:()=>devices,current:()=>({hostId:'pc',name:'Game'}),binding(){}}).discovery();
  const nodes=walk(body),picker=nodes.find(n=>n.tagName==='select'),submit=nodes.find(n=>n.tagName==='button'&&n.textContent==='准备工程并读取需求');
  assert.equal(picker.options.length,3);assert.deepEqual(picker.options.map((o:any)=>o.value),devices.map(h=>h.id));assert.match(picker.options[1].textContent,/需更新 Relay/);assert.equal(submit.disabled,false);
  picker.value='older-mac';picker.onchange();assert.equal(submit.disabled,true);assert.ok(nodes.some(n=>n.tagName==='p'&&/这台电脑在线.*更新/.test(n.textContent)));await submit.onclick();assert.equal(requests,0);assert.equal(submit.disabled,true);
  devices[1].online=false;picker.onchange();assert.match(picker.options[1].textContent,/离线/);assert.ok(nodes.some(n=>n.tagName==='p'&&/这台电脑当前离线/.test(n.textContent)));assert.equal(submit.disabled,true);
  devices[1].online=true;devices[1].capabilities.studioRepositoryConnect=true;picker.onchange();assert.equal(picker.options[1].textContent,'Older Mac');assert.equal(submit.disabled,false);assert.equal(requests,0);
 }finally{Object.assign(globalThis,{document:original});}
});
