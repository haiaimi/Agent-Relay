import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchingStudioProject,studioProjectRegistration} from '../web/studio-projects.js';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const require=createRequire(import.meta.url);
const {workspaceOrigin,restoreLogin}=require('../desktop/workspace.cjs');

test('explicit studio paths preserve the chosen native project and workspace identity',()=>{
  const host={platform:'win32 x64',projects:[{id:'configured',path:'E:\\Games\\Demo'},{id:'native',path:'E:\\Games\\Demo',roots:['E:\\Games\\Demo','D:\\Art\\Demo']}]};
  assert.deepEqual(matchingStudioProject(host,'e:/games/demo/','native'),{projectId:'native',workspaceIndex:0});
  assert.deepEqual(matchingStudioProject(host,'D:\\Art\\Demo\\','native'),{projectId:'native',workspaceIndex:1});
  assert.equal(matchingStudioProject(host,'E:\\Games\\Demo-Other','native'),undefined);
  const mac={platform:'darwin arm64',projects:[{id:'mac',path:'/Users/you/Game'}]};assert.equal(matchingStudioProject(mac,'/Users/you/game'),undefined);
});
test('new studio paths explicitly register on the selected online workstation, never on the relay',()=>{
  const host={id:'pc',online:true,platform:'win32',capabilities:{createProject:true}};
  const action=studioProjectRegistration(host,' E:\\Projects\\New Game ',true,'action-1234');
  assert.deepEqual(action,{id:'action-1234',type:'create-project',hostId:'pc',projectName:'New Game',projectPath:'E:\\Projects\\New Game',createFolder:true});
  assert.throws(()=>studioProjectRegistration(host,'relative/game',false,'action-1234'),/绝对路径/);
  assert.throws(()=>studioProjectRegistration(host,'E:\\',false,'action-1234'),/文件夹/);
  assert.throws(()=>studioProjectRegistration({...host,online:false},'E:\\Game',false,'action-1234'),/离线/);
  assert.throws(()=>studioProjectRegistration({...host,capabilities:{}},'E:\\Game',false,'action-1234'),/连接程序/);
  assert.throws(()=>studioProjectRegistration(host,'/opt/game',false,'action-1234'),/绝对路径/);
});
test('desktop workspace origins retain configured HTTPS and reject credential-bearing or insecure remote URLs',()=>{
  assert.equal(workspaceOrigin('wss://relay.example.com:8443/bridge'),'https://relay.example.com:8443');
  assert.equal(workspaceOrigin('ws://127.0.0.1:8787/bridge'),'http://127.0.0.1:8787');
  for(const url of ['ws://relay.example.com/bridge','wss://user:secret@relay.example.com/bridge','wss://relay.example.com/bridge?token=secret','https://relay.example.com/'])assert.throws(()=>workspaceOrigin(url));
});
test('desktop login reuses a saved session or sends the existing local key only to the configured origin',async()=>{
  const root=mkdtempSync(join(tmpdir(),'studio-desktop-auth-')),saved:any[]=[],calls:any[]=[];
  const session={cookies:{get:async()=>[],set:async(value:any)=>saved.push(value)}};
  const previous=process.env.PHONE_TOKEN;delete process.env.PHONE_TOKEN;
  try{
    writeFileSync(join(root,'.env'),'PHONE_TOKEN="test-local-phone-key"\nBRIDGE_TOKEN=never-send-this\n');
    const request=async(url:string,options:any)=>{calls.push({url,options});return new Response('{}',{headers:{'Set-Cookie':'relay_session=1234.random.signature; HttpOnly; SameSite=Strict; Path=/'}});};
    assert.equal(await restoreLogin(session,'https://relay.example.com:8443',root,request),true);assert.equal(calls.length,1);
    assert.equal(calls[0].url,'https://relay.example.com:8443/api/login');assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.headers.Origin,'https://relay.example.com:8443');assert.deepEqual(JSON.parse(calls[0].options.body),{token:'test-local-phone-key'});
    assert.equal(saved[0].httpOnly,true);assert.equal(saved[0].secure,true);assert.equal(saved[0].sameSite,'strict');
    const cached={cookies:{...session.cookies,get:async()=>[{name:'relay_session'}]}};await restoreLogin(cached,'https://relay.example.com:8443',root,request);assert.equal(calls.length,1);
    assert.equal(await restoreLogin(session,'https://relay.example.com:8443',root,async()=>new Response('{}',{status:401})),false);assert.equal(saved.length,1);
  }finally{if(previous===undefined)delete process.env.PHONE_TOKEN;else process.env.PHONE_TOKEN=previous;rmSync(root,{recursive:true,force:true});}
});
