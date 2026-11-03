import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {equalSecret} from '../shared/security.js';
import type {AgentRuntime} from './runtime.js';
export function startQuestionHook(runtime:AgentRuntime,dir:string){
  const token=randomBytes(32).toString('hex'),path=join(dir,'question-hook.json'),controllers=new Set<AbortController>();
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.method!=='POST'||req.url!=='/ask'||req.headers.origin||!equalSecret(req.headers.authorization??'','Bearer '+token)){res.writeHead(403);res.end('{}');return;}
    const controller=new AbortController();controllers.add(controller);res.on('close',()=>controller.abort());
    try{let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>40000)throw new Error('问题过长');}const input=JSON.parse(raw);
      if(input.hook_event_name!=='PreToolUse'||input.tool_name!=='AskUserQuestion')throw new Error('仅支持用户提问');
      const answers=await runtime.askClaudeNative(input.session_id,input.cwd,input.tool_use_id,input.tool_input,controller.signal);
      res.end(JSON.stringify(answers?{answers}:{}));
    }catch{if(!res.headersSent)res.writeHead(400);res.end('{}');}finally{controllers.delete(controller);}
  });
  server.listen(0,'127.0.0.1',()=>writeFileSync(path,JSON.stringify({port:(server.address() as {port:number}).port,token}),{mode:0o600}));
  return {close(){for(const c of controllers)c.abort();server.close();try{unlinkSync(path);}catch{}}};
}
