import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,symlinkSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertRelayUrl,assertProjectPath,makeCookie,validCookie} from '../src/shared/security.js';
import {validateAction} from '../src/shared/protocol.js';
test('credentials expire/tampering fails and remote plain WebSocket is refused',()=>{
  const secret='a'.repeat(40);const cookie=makeCookie(secret);assert.equal(validCookie(cookie,secret),true);assert.equal(validCookie(cookie+'x',secret),false);assert.equal(validCookie(cookie,'b'.repeat(40)),false);
  assert.throws(()=>assertRelayUrl('ws://203.0.113.10/bridge'));assert.throws(()=>assertRelayUrl('wss://host/bridge?token=secret'));assertRelayUrl('ws://127.0.0.1:8787/bridge');
  assert.throws(()=>validateAction({id:'12345678',type:'start',provider:'codex',projectId:'p',text:''}));
});
test('project boundary checks resolve junctions and reject sibling paths',()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-boundary-'));const allowed=join(root,'allowed'),outside=join(root,'allowed-other');mkdirSync(allowed);mkdirSync(outside);
  try{symlinkSync(outside,join(allowed,'escape'),process.platform==='win32'?'junction':'dir');const canonical=realpathSync.native(allowed);assert.equal(assertProjectPath(allowed,[allowed]),canonical);if(process.platform==='win32')assert.equal(assertProjectPath('\\\\?\\'+allowed,[allowed]),canonical);assert.throws(()=>assertProjectPath(outside,[allowed]));assert.throws(()=>assertProjectPath(join(allowed,'escape'),[allowed]));}
  finally{rmSync(root,{recursive:true,force:true});}
});
