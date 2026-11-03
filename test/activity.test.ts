import {test} from 'node:test';
import assert from 'node:assert/strict';
import {transcriptActivity} from '../src/bridge/activity.js';
const codex=(...payloads:any[])=>payloads.map(payload=>JSON.stringify({type:'response_item',timestamp:'2026-11-03T00:00:00Z',payload})).join('\n');

test('native steps expose public plan/tool phases without copying reasoning, arguments or tool output',()=>{
  const thinking=codex({type:'reasoning',summary:[{text:'PRIVATE_CHAIN_OF_THOUGHT'}]});
  assert.equal(transcriptActivity('codex',thinking)?.label,'正在思考');
  const plan={type:'function_call',name:'update_plan',arguments:JSON.stringify({plan:[{step:'确认数据来源',status:'completed'},{step:'比较实际开销',status:'in_progress'}]})};
  const calls=codex(plan,{type:'function_call',name:'exec_command',call_id:'shell',arguments:'SECRET_TOKEN=abc'},{type:'function_call',name:'read_file',call_id:'read',arguments:'private-path'});
  const active=transcriptActivity('codex',calls);assert.equal(active?.label,'正在读取内容');assert.equal(active?.detail,'比较实际开销');
  const oneCompleted=transcriptActivity('codex',calls+'\n'+codex({type:'function_call_output',call_id:'read',output:'PRIVATE_RESULT'}));assert.equal(oneCompleted?.label,'正在执行命令');
  const completed=transcriptActivity('codex',calls+'\n'+codex({type:'function_call_output',call_id:'read',output:'PRIVATE_RESULT'},{type:'function_call_output',call_id:'shell',output:'PRIVATE_RESULT'}));assert.equal(completed?.kind,'thinking');assert.equal(completed?.detail,'比较实际开销');
  for(const value of [transcriptActivity('codex',thinking),active,completed])assert.doesNotMatch(JSON.stringify(value),/PRIVATE|SECRET|private-path/);
  assert.doesNotMatch(JSON.stringify(transcriptActivity('codex',codex({type:'message',role:'assistant',channel:'analysis',content:[{type:'output_text',text:'PRIVATE_ANALYSIS'}]}))),/PRIVATE_ANALYSIS/);
  assert.equal(transcriptActivity('codex',calls+'\n'+codex({type:'message',role:'assistant',phase:'final',content:[]})),undefined);
  assert.equal(transcriptActivity('codex',calls+'\n'+JSON.stringify({type:'event_msg',payload:{type:'task_complete'}})),undefined);
});

test('Claude tool steps, tool completion and final state are derived without revealing hidden thinking',()=>{
  const lines=(...rows:any[])=>rows.map(r=>JSON.stringify(r)).join('\n');
  const thinking={type:'assistant',message:{content:[{type:'thinking',thinking:'PRIVATE_THINKING'}]}};
  const tool={type:'assistant',message:{content:[{type:'tool_use',id:'a',name:'Bash',input:{command:'SECRET'}}]}};
  assert.equal(transcriptActivity('claude',lines(thinking))?.label,'正在思考');assert.equal(transcriptActivity('claude',lines(thinking,tool))?.label,'正在执行命令');
  const done={type:'user',message:{content:[{type:'tool_result',tool_use_id:'a',content:'PRIVATE_OUTPUT'}]}};
  assert.equal(transcriptActivity('claude',lines(thinking,tool,done))?.kind,'thinking');
  assert.equal(transcriptActivity('claude',lines(thinking,tool,done,{type:'result'})),undefined);
  assert.doesNotMatch(JSON.stringify(transcriptActivity('claude',lines(thinking,tool))),/PRIVATE|SECRET/);
});
