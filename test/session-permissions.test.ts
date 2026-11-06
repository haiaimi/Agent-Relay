import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore Browser module is exercised as shipped.
import {permissionPresentation,renderPermissionControls} from '../web/session-permissions.js';

test('permission labels distinguish the effective policy from the saved next-turn policy',()=>{
  const view=permissionPresentation({permissionMode:'request',nextPermissionMode:'full'});
  assert.equal(view.current,'请求批准');assert.equal(view.preview,'当前：请求批准');assert.equal(view.pending,'下一轮：完整权限');assert.equal(view.mode,'request');
  assert.equal(view.summary,'当前：请求批准；下一轮：完整权限');
  assert.deepEqual(view.options,[{mode:'request',selected:false,status:'当前生效'},{mode:'auto',selected:false,status:''},{mode:'full',selected:true,status:'下一轮生效'}]);
  assert.match(view.note,/下一轮开始时生效/);
  const restricted=permissionPresentation({permissionMode:'full',nextPermissionMode:'request'});
  assert.equal(restricted.mode,'full');assert.equal(restricted.preview,'当前：完整权限');assert.equal(restricted.pending,'下一轮：请求批准');
});

test('unknown and native custom permissions never imply a preset has already taken effect',()=>{
  const unknown=permissionPresentation({nextPermissionMode:'full'},true);
  assert.equal(unknown.preview,'当前：读取权限中…');assert.equal(unknown.mode,'');assert.equal(unknown.options.some((o:any)=>o.status==='当前生效'),false);
  const custom=permissionPresentation({permissionLabel:'只读 · 不请求批准',nextPermissionMode:'full'});
  assert.equal(custom.current,'只读 · 不请求批准');assert.match(custom.summary,/下一轮：完整权限/);
});

test('composer and menu update together through queued changes, cancellation and next-turn activation',()=>{
  const original=globalThis.document;
  const element=()=>{
    const n:any={className:'',textContent:'',hidden:false,dataset:{},children:[],attributes:{},append(child:any){this.children.push(child);},replaceChildren(...children:any[]){this.children=children;},setAttribute(k:string,v:string){this.attributes[k]=v;},querySelector(selector:string):any{
      return this.children.find((c:any)=>selector==='strong'?c.tag==='strong':selector.startsWith('.')?c.className===selector.slice(1):selector===`[data-permission="${c.dataset.permission}"]`)??this.children.map((c:any)=>c.querySelector(selector)).find(Boolean);
    }};return n;
  };
  const preview=element(),toggle=element(),menu=element();
  for(const mode of ['request','auto','full']){const option=element(),strong=element();option.dataset.permission=mode;strong.tag='strong';option.append(strong);menu.append(option);}
  try{
    Object.assign(globalThis,{document:{createElement:element}});
    const render=(session:object)=>renderPermissionControls(session,{preview,toggle,menu});
    const badge=(mode:string)=>menu.querySelector(`[data-permission="${mode}"]`).querySelector('.permission-state');
    render({permissionMode:'request'});
    assert.equal(preview.children[0].textContent,'请求批准');assert.equal(preview.children[1].hidden,true);assert.equal(badge('request').textContent,'当前生效');
    render({permissionMode:'request',nextPermissionMode:'full'});
    assert.equal(toggle.dataset.mode,'request');assert.equal(toggle.attributes['aria-label'],'会话权限：当前：请求批准；下一轮：完整权限');
    assert.equal(preview.children[0].textContent,'当前：请求批准');assert.equal(preview.children[1].textContent,'下一轮：完整权限');assert.equal(preview.children[1].hidden,false);
    assert.equal(badge('request').textContent,'当前生效');assert.equal(badge('full').textContent,'下一轮生效');
    render({permissionMode:'request',nextPermissionMode:'auto'});
    assert.equal(badge('full').hidden,true);assert.equal(badge('auto').textContent,'下一轮生效');
    render({permissionMode:'request'});
    assert.equal(preview.children[1].hidden,true);assert.equal(badge('auto').hidden,true);
    render({permissionMode:'full'});
    assert.equal(preview.children[0].textContent,'完整权限');assert.equal(preview.children[1].hidden,true);assert.equal(toggle.dataset.mode,'full');
    assert.equal(badge('request').hidden,true);assert.equal(badge('full').textContent,'当前生效');assert.equal(badge('full').hidden,false);
    assert.equal(preview.children.length,2);assert.equal(menu.querySelector('[data-permission="full"]').querySelector('strong').children.length,1);
  }finally{Object.assign(globalThis,{document:original});}
});
