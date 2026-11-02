import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {zstdCompressSync} from 'node:zlib';
import {NativeHistory,transcriptLine} from '../src/bridge/history.js';
test('native read-only history paginates Codex and reads compressed rollouts and Claude',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-history-')),codex=join(root,'codex'),claude=join(root,'claude');mkdirSync(codex);mkdirSync(join(claude,'projects','p'),{recursive:true});
  try{
    const packed=join(codex,'rollout.jsonl');const state=new DatabaseSync(join(codex,'state_5.sqlite'));
    state.exec('CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,archived INTEGER,agent_role TEXT,rollout_path TEXT,model TEXT)');
    for(const id of ['indexed','packed'])state.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)').run(id,'标题',root,123,0,null,packed,'fixture-model');state.close();
    writeFileSync(join(codex,'session_index.jsonl'),JSON.stringify({id:'indexed',thread_name:'本机短标题'})+'\n');
    const history=new DatabaseSync(join(codex,'thread_history_1.sqlite'));history.exec('CREATE TABLE thread_items(thread_id TEXT,rollout_ordinal INTEGER,item_json TEXT,created_at_ms INTEGER)');
    for(let i=0;i<110;i++)history.prepare('INSERT INTO thread_items VALUES(?,?,?,?)').run('indexed',i,JSON.stringify({id:'m'+i,type:'agentMessage',text:'第'+i+'条'}),1000+i);history.close();
    writeFileSync(packed+'.zst',zstdCompressSync(Buffer.from(JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'压缩历史'}]}})+'\n')));
    writeFileSync(join(claude,'projects','p','abc.jsonl'),JSON.stringify({type:'user',uuid:'user-1',sessionId:'abc',cwd:root,message:{content:'你好'}})+'\n'+JSON.stringify({type:'assistant',uuid:'a',message:{id:'answer-1',content:[{type:'text',text:'你好，手机'}]}})+'\n{"partial":');
    const reader=new NativeHistory('pc',codex,claude);assert.equal(reader.list().length,3);
    assert.equal(reader.list().find(s=>s.nativeId==='indexed')?.title,'本机短标题');
    const first=await reader.page('pc:codex:indexed');assert.equal(first.messages.length,50);assert.equal(first.cursor,60);
    const older=await reader.page('pc:codex:indexed',first.cursor!);assert.equal(older.messages[0].id,'m10');
    assert.equal(first.messages.at(-1)?.timestamp,1109);
    const update=new DatabaseSync(join(codex,'thread_history_1.sqlite'));
    update.prepare('INSERT INTO thread_items VALUES(?,?,?,?)').run('indexed',110,JSON.stringify({id:'newest',type:'agentMessage',text:'失败之后的新回复'}),1110);update.close();
    assert.equal((await reader.page('pc:codex:indexed')).messages.at(-1)?.text,'失败之后的新回复');
    assert.equal((await reader.page('pc:codex:packed')).messages[0].text,'压缩历史');
    const page=await reader.page('pc:claude:abc');assert.equal(page.messages.length,2);assert.equal(page.messages[1].id,'claude-text:a');
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('Claude reused API message ids preserve each text block and separate tools',()=>{
  const lines=[
    {type:'assistant',uuid:'text-1',message:{id:'shared-api-id',content:[{type:'text',text:'先分析瓶颈'}]}},
    {type:'assistant',uuid:'call-1',message:{id:'shared-api-id',content:[{type:'tool_use',id:'tool-1',name:'Bash',input:{command:'echo fixture'}}]}},
    {type:'assistant',uuid:'text-2',message:{id:'shared-api-id',content:[{type:'text',text:'这里是分析结果'}]}},
    {type:'user',uuid:'result-1',message:{content:[{type:'tool_result',tool_use_id:'tool-1',content:'fixture'}]}}
  ];
  const messages=new Map(lines.map((l,i)=>{const m=transcriptLine(l,i)!;return [m.id,m]}));
  assert.equal(messages.size,4);assert.equal([...messages.values()].filter(m=>m.role==='assistant').length,2);
  assert.equal(messages.get('claude-text:text-1')?.text,'先分析瓶颈');assert.equal(messages.get('claude-tool:tool-1')?.role,'tool');assert.equal(messages.get('claude-result:tool-1')?.role,'tool');
});
