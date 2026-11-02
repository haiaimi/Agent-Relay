import {test} from 'node:test';
import assert from 'node:assert/strict';
import {codexTailStatus,codexStatuses} from '../src/bridge/native-status.js';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,utimesSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Session} from '../src/shared/protocol.js';
test('Codex long turn tail detects activity without its start and respects terminal records',()=>{
  const line=(type:string,payload:unknown)=>JSON.stringify({type,payload})+'\n';
  const active='partial record\n'+line('response_item',{type:'reasoning'})+line('response_item',{type:'custom_tool_call'});
  assert.equal(codexTailStatus(active),'running');
  assert.equal(codexTailStatus(active+line('response_item',{type:'message',role:'assistant',phase:'final_answer'})+line('event_msg',{type:'token_count'})),'idle');
  assert.equal(codexTailStatus(active+line('event_msg',{type:'turn_aborted'})),'interrupted');
  assert.equal(codexTailStatus(line('event_msg',{type:'task_complete'})+line('response_item',{type:'message',role:'assistant',phase:'commentary'})),'running');
  assert.equal(codexTailStatus('partial record'),undefined);
});
test('Windows active writer uses live index when file mtime is delayed',{skip:process.platform!=='win32'},async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-lock-status-'));mkdirSync(join(root,'thread-writer-locks'));
  const nativeId='fixture',lock=join(root,'thread-writer-locks',nativeId+'.lock'),log=join(root,'rollout.jsonl');
  writeFileSync(lock,'0');writeFileSync(log,JSON.stringify({type:'response_item',payload:{type:'reasoning'}})+'\n');utimesSync(log,new Date(0),new Date(0));
  const writer=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command','$f=[System.IO.File]::Open($env:RELAY_TEST_LOCK,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::ReadWrite);$f.Lock(0,1);[Console]::WriteLine("locked");[Console]::ReadLine()|Out-Null;$f.Dispose()'],{env:{...process.env,RELAY_TEST_LOCK:lock},windowsHide:true,stdio:['pipe','pipe','pipe']});
  try{
    const output=await Promise.race([once(writer.stdout,'data').then(([b])=>String(b)),once(writer,'exit').then(()=>{throw new Error('Lock writer exited before ready');})]);assert.match(output,/locked/);
    const session={id:'test:codex:fixture',nativeId,provider:'codex',updatedAt:Date.now()} as Session;
    assert.equal(codexStatuses(root,new Map([[session.id,log]]),[session]).get(nativeId),'running');
  }finally{if(writer.exitCode===null&&writer.signalCode===null){const exited=once(writer,'exit');writer.kill();await exited;}assert.ok(root.startsWith(join(tmpdir(),'relay-lock-status-')));rmSync(root,{recursive:true,force:true});}
});
