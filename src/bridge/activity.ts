import {openSync,readSync,closeSync,statSync} from 'node:fs';
import type {Activity,Provider} from '../shared/protocol.js';

const short=(value:unknown)=>typeof value==='string'?value.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,150):undefined;
export function toolActivity(name:string,at?:number):Activity{
  const label=/exec|bash|shell|command|terminal/i.test(name)?'正在执行命令':/apply_patch|edit|write|fileChange/i.test(name)?'正在修改文件':/search|browse|web|fetch/i.test(name)?'正在搜索资料':/read|view|inspect/i.test(name)?'正在读取内容':/imagegen|image_generation/i.test(name)?'正在生成图片':'正在调用工具';
  return {kind:'tool',label,detail:short(name),at};
}
// Only public steps, tool names and plan labels are exported. Reasoning text,
// tool arguments/results, credentials and private scratchpads are never copied.
export function transcriptActivity(provider:Provider,text:string):Activity|undefined{
  let activity:Activity|undefined,plan:string|undefined;const calls=new Map<string,Activity>();
  const think=(at?:number)=>activity=calls.size?[...calls.values()].at(-1):{kind:'thinking',label:'正在思考',detail:plan,at};
  for(const raw of text.split('\n')){try{
    const r=JSON.parse(raw),at=Number.isFinite(Date.parse(r.timestamp))?Date.parse(r.timestamp):undefined;
    if(provider==='codex'){
      const p=r.payload;if(r.type==='event_msg'){
        if(p?.type==='task_started'){calls.clear();plan=undefined;think(at);}
        else if(['task_complete','turn_aborted','task_aborted'].includes(p?.type)){activity=undefined;calls.clear();plan=undefined;}
        else if(p?.type==='agent_reasoning')think(at);
      }
      if(r.type!=='response_item'||!p)continue;
      if(p.type==='reasoning')think(at);
      else if(p.type==='image_generation_call'){activity=['completed','failed'].includes(p.status)?{kind:'thinking',label:'正在思考',detail:plan,at}:toolActivity('image_generation',at);}
      else if(['function_call','custom_tool_call','web_search_call'].includes(p.type)){
        if(p.type==='web_search_call'&&['completed','failed'].includes(p.status)){think(at);continue;}
        const name=String(p.name??(p.type==='web_search_call'?'web_search':'工具'));
        if(/(?:^|\.)update_plan$/.test(name)){
          let args=p.arguments;try{if(typeof args==='string')args=JSON.parse(args);}catch{args=null;}
          plan=short(args?.plan?.find((step:any)=>step.status==='in_progress')?.step);
          activity=plan?{kind:'plan',label:'正在执行',detail:plan,at}:{kind:'thinking',label:'正在思考',at};
        }else{activity=toolActivity(name,at);if(plan)activity.detail=plan;calls.set(String(p.call_id??p.id??name),activity);}
      }else if(['function_call_output','custom_tool_call_output'].includes(p.type)){calls.delete(String(p.call_id));think(at);}
      else if(p.type==='message'&&p.role==='assistant'){
        if(['analysis','reasoning'].includes(p.channel)||['analysis','reasoning'].includes(p.phase)){think(at);continue;}
        if(['final','final_answer'].includes(p.phase)){activity=undefined;calls.clear();plan=undefined;}
        else {const publicText=p.phase==='commentary'||p.channel==='commentary'?(p.content??[]).filter((c:any)=>['text','output_text'].includes(c.type)).map((c:any)=>c.text).join(' '):undefined;activity={kind:'reply',label:'正在回复',detail:short(publicText)||plan,at};}
      }
    }else if(['assistant','user'].includes(r.type)&&!r.isMeta){
      const content=Array.isArray(r.message?.content)?r.message.content:[];
      if(r.type==='user'){const results=content.filter((c:any)=>c.type==='tool_result');if(results.length){for(const result of results)calls.delete(result.tool_use_id);think(at);}else{calls.clear();think(at);}}
      else for(const block of content){
        if(block.type==='tool_use'){activity=toolActivity(String(block.name??'工具'),at);calls.set(block.id,activity);}
        else if(block.type==='thinking')think(at);
        else if(block.type==='text')activity={kind:'reply',label:'正在回复',detail:short(block.text),at};
      }
    }else if(provider==='claude'&&r.type==='result'){activity=undefined;calls.clear();}
  }catch{/* Partial bounded records never become a displayed step. */}}
  return activity;
}

export class NativeActivities {
  private cache=new Map<string,{size:number;mtime:number;activity?:Activity}>();
  read(provider:Provider,path:string):Activity|undefined{
    if(!path.endsWith('.jsonl'))return;
    try{
      const stat=statSync(path),old=this.cache.get(path);if(old?.size===stat.size&&old.mtime===stat.mtimeMs)return old.activity;
      const start=Math.max(0,stat.size-2*1024*1024),buffer=Buffer.alloc(stat.size-start),fd=openSync(path,'r');let count:number;
      try{count=readSync(fd,buffer,0,buffer.length,start);}finally{closeSync(fd);}
      const tail=buffer.subarray(0,count).toString('utf8'),text=start?tail.slice(tail.indexOf('\n')+1):tail,activity=transcriptActivity(provider,text);
      this.cache.set(path,{size:stat.size,mtime:stat.mtimeMs,activity});if(this.cache.size>100)this.cache.delete(this.cache.keys().next().value!);return activity;
    }catch{return;}
  }
}
