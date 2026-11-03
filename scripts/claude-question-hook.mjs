import {readFileSync} from 'node:fs';
// Fail open to Claude's local question UI when the bridge is absent. This hook
// never changes permission decisions for any tool other than AskUserQuestion.
try{
  if(process.env.AGENT_RELAY_MANAGED==='1')process.exit(0);
  const raw=readFileSync(0,'utf8');if(Buffer.byteLength(raw)>40000)process.exit(0);const input=JSON.parse(raw);
  if(input.tool_name!=='AskUserQuestion'||input.hook_event_name!=='PreToolUse')process.exit(0);
  const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
  if(!Number.isInteger(config.port)||config.port<1||config.port>65535||!/^[a-f0-9]{64}$/.test(config.token))process.exit(0);
  const response=await fetch('http://127.0.0.1:'+config.port+'/ask',{method:'POST',headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(3600000)});
  const result=await response.json();if(!response.ok||!result.answers)process.exit(0);
  process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',permissionDecisionReason:'用户已在 Agent Relay 网页回答本次问题',updatedInput:{...input.tool_input,answers:result.answers}}}));
}catch{/* Local Claude remains responsible if remote questioning is unavailable. */}
