import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createRelay} from '../src/relay/server.js';
// @ts-expect-error Browser module is plain JavaScript; import has no side effects.
import {workspaceRoute,setupWorkspaceShell} from '../web/workspace-shell.js';

test('workspace routes keep studio canonical and retain encoded session deep links',()=>{
  assert.deepEqual(workspaceRoute('/studio'),{view:'studio',sessionId:null});
  assert.deepEqual(workspaceRoute('/?sessionId=host%3Acodex%3Aa'),{view:'sessions',sessionId:'host:codex:a'});
});

test('workspace tabs replace the current URL while explicit session changes still create deep links',()=>{
  const original={window:globalThis.window,document:globalThis.document,history:globalThis.history,location:globalThis.location,requestAnimationFrame:globalThis.requestAnimationFrame};
  const elements=new Map<string,any>(),changes:any[]=[],links=['/','/studio'].map(pathname=>({pathname,classList:{toggle(){}},setAttribute(){},removeAttribute(){}}));
  const element=(id:string)=>{if(!elements.has(id))elements.set(id,{hidden:false,dataset:{},scrollTop:125,textContent:'',querySelector:(selector:string)=>element(selector.slice(1)),classList:{toggle(){}},setAttribute(){},removeAttribute(){},hasAttribute:()=>false,contentWindow:{postMessage(){}}});return elements.get(id);};
  const place:any={origin:'http://relay.test',pathname:'/',search:'',href:'http://relay.test/'},navigate=(type:string,url:string)=>{changes.push([type,url]);Object.assign(place,new URL(url,place.origin));const next=new URL(url,place.origin);place.pathname=next.pathname;place.search=next.search;place.href=next.href;};
  try{
    Object.assign(globalThis,{window:{addEventListener(){}},document:{getElementById:element,querySelector:()=>({addEventListener(){}}),querySelectorAll:()=>links},location:place,history:{pushState:(_a:any,_b:any,url:string)=>navigate('push',url),replaceState:(_a:any,_b:any,url:string)=>navigate('replace',url)},requestAnimationFrame:(fn:Function)=>fn()});
    const shell=setupWorkspaceShell({getState:()=>({sessions:[]}),getSelected:()=>({id:'current'}),selectSession(){},drawer:{close(){}}});
    shell.show('studio');shell.show('sessions');shell.show('studio');shell.show('sessions');
    assert.deepEqual(changes,[['replace','/studio'],['replace','/?sessionId=current'],['replace','/studio'],['replace','/?sessionId=current']]);
    shell.show('sessions',{sessionId:'host:codex:next'});assert.deepEqual(changes.at(-1),['push','/?sessionId=host%3Acodex%3Anext']);
    assert.equal(element('timeline').scrollTop,125);
    element('search').value='kept session filter';shell.show('studio');assert.equal(element('studio-sidebar').hidden,false);assert.equal(element('session-list').hidden,true);assert.equal(element('new-session').hidden,true);
    shell.show('sessions');assert.equal(element('studio-sidebar').hidden,true);assert.equal(element('session-list').hidden,false);assert.equal(element('search').value,'kept session filter');
  }finally{Object.assign(globalThis,original);}
});

test('studio shares the app shell; only its same-origin embedded pane can be framed and every module is served',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-shell-')),app=createRelay({dataDir:dir,phoneToken:'shell-phone-verification-token-123456',bridgeToken:'shell-bridge-verification-token-123456'});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base='http://127.0.0.1:'+(app.server.address() as any).port;
  try{
    const home=await fetch(base+'/'),studio=await fetch(base+'/studio'),embedded=await fetch(base+'/studio?embedded=1');
    const html=await home.text();assert.equal(await studio.text(),html);assert.match(html,/id="studio-frame"/);assert.match(html,/<details class="sidebar-filters"/);
    assert.equal(studio.headers.get('x-frame-options'),'DENY');assert.match(studio.headers.get('content-security-policy')!,/frame-ancestors 'none'/);
    assert.equal(embedded.headers.get('x-frame-options'),'SAMEORIGIN');assert.match(embedded.headers.get('content-security-policy')!,/frame-ancestors 'self'/);assert.match(await embedded.text(),/id="project-picker"/);
    const seen=new Set<string>(),pending=['/app.js','/studio.js','/workspace-shell.css'];
    while(pending.length){const path=pending.pop()!;if(seen.has(path))continue;seen.add(path);const response=await fetch(base+path);assert.equal(response.status,200,path);const body=await response.text();for(const match of body.matchAll(/(?:from\s*|import\s*)['"]\.\/([^'"]+)['"]/g))pending.push('/'+match[1]);}
    assert.ok(seen.has('/workspace-shell.js'));assert.ok(seen.has('/drawer.js'));assert.ok(seen.has('/studio-chat.js'));assert.ok(seen.has('/studio-sidebar.js'));
    assert.equal((await fetch(base+'/api/state')).status,401);
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});

