import type {StudioRun,Task} from './studio.js';
import type {RelayStore} from './store.js';
export interface GroupPost {id:string;runId:string;at:number;text:string;roles:string[];files:any[];deliveries:{role:string;actionId:string;sessionId?:string;status:'pending'|'sent'|'unconfirmed';error?:string}[]}
export interface GroupEntry {id:string;at:number;role:string;kind:string;text:string;taskId?:string;taskTitle?:string;sessionId?:string;toRoles?:string[];files?:any[];images?:any[];artifacts?:any[];checks?:string[];deliveries?:GroupPost['deliveries']}
export function groupEntries(run:StudioRun,posts:GroupPost[],store:RelayStore,roleName=(id:string)=>id,logs=run.log){
  const tasks=[run.planner,...run.tasks,...run.delivery?[run.delivery]:[]],entries:GroupEntry[]=posts.map(p=>({id:'post:'+p.id,at:p.at,role:'producer',kind:'message',text:p.text,toRoles:p.roles,files:p.files,deliveries:p.deliveries}));
  for(const [index,log] of logs.entries()){
    const current=tasks.find(t=>t.id===log.taskId)??tasks.find(t=>['分发：','已启动：','完成：','待处理：','返工：'].some(prefix=>log.text===prefix+t.title))??(log.taskId?{id:log.taskId,title:log.taskTitle??log.taskId,role:log.role??'studio',dependencies:[] as string[]}:undefined);
    const task=log.taskId&&log.taskTitle?{id:log.taskId,title:log.taskTitle,role:log.role??current?.role??'studio',dependencies:current?.dependencies??[]}:current;
    const handoff:NonNullable<StudioRun['log'][number]['handoff']>=log.handoff??(task&&log.text==='已启动：'+task.title?tasks.filter(t=>task.dependencies.includes(t.id)).map(t=>({id:t.id,role:t.role,title:t.title})):[]);
    entries.push({id:'log:'+(log.id??log.at+':'+index),at:log.at,role:log.skip?'producer':task?.role??'studio',kind:handoff.length?'handoff':'record',taskId:task?.id,taskTitle:task?.title,toRoles:task?[task.role]:[],text:handoff.length?handoff.map(t=>`${roleName(t.role)}「${t.id} · ${t.title}」→ ${roleName(task!.role)}「${task!.id} · ${task!.title}」\n${t.summary||'上游任务已完成，交付文件已传入本任务上下文。'}`).join('\n\n'):log.text,artifacts:handoff.flatMap(t=>t.artifacts??[])});
  }
  const sources=new Map<string,{role:string;task?:Partial<Task>&Pick<Task,'id'|'title'>;since?:number}>();
  for(const task of tasks){if(task.sessionId)sources.set(task.sessionId,{role:task.role,task});for(const attempt of task.attempts??[])if(attempt.sessionId&&!sources.has(attempt.sessionId))sources.set(attempt.sessionId,{role:task.role,task});}
  for(const log of logs)if(log.sessionId&&log.taskId&&!sources.has(log.sessionId))sources.set(log.sessionId,{role:log.role??'studio',task:{id:log.taskId,title:log.taskTitle??log.taskId,sessionId:log.sessionId}});
  for(const post of posts)for(const delivery of post.deliveries){const sessionId=delivery.sessionId??run.chats?.find(c=>c.actionId===delivery.actionId)?.sessionId;if(sessionId&&!sources.get(sessionId)?.task)sources.set(sessionId,{role:delivery.role,since:Math.min(sources.get(sessionId)?.since??Infinity,post.at)});}
  for(const [sessionId,source] of sources){
    const messages=new Map<string,any>();
    for(const event of store.sessionEvents(sessionId)){
      if(event.at<(source.since??0))continue;const d=event.data;if(event.type==='message'&&d.role==='assistant')messages.set(d.id,{...d,at:d.timestamp??event.at});
      if(event.type==='delta'){const m=messages.get(d.messageId)??{id:d.messageId,role:'assistant',text:'',at:event.at};m.text+=String(d.text??'');messages.set(d.messageId,m);}
      const notice=event.type==='approval'?'需要制作人批准工具操作，请打开该职能完整过程处理。':event.type==='question'?'需要制作人补充答案，请打开该职能完整过程回答。':event.type==='approval.resolved'?'工具批准已处理。':event.type==='question.resolved'?'制作人问题已回答。':event.type==='error'?String(d.error||d.message||'执行异常，请核对完整过程。'):'';
      if(notice)entries.push({id:'notice:'+event.id,at:event.at,role:source.role,kind:'record',taskId:source.task?.id,taskTitle:source.task?.title,sessionId,text:notice});
    }
    const seenReplies=new Set<string>();
    for(const m of messages.values()){
      let text=String(m.text||''),artifacts:any[]|undefined,checks:string[]|undefined;
      const original=text,plan=[...text.matchAll(/```STUDIO_PLAN\s*([\s\S]*?)```/g)].at(-1);
      if(plan)try{const parsed=JSON.parse(plan[1]);if(Array.isArray(parsed.tasks))text='当时提交的制作计划（'+parsed.tasks.length+' 个任务）：\n\n'+parsed.tasks.map((t:any)=>`${t.id} · ${roleName(t.role)} · ${t.title}\n接收上游：${Array.isArray(t.dependencies)&&t.dependencies.length?t.dependencies.join('、'):'无'}`).join('\n\n')+'\n\n当前计划及补齐环节请展开「团队任务与协作依赖」。';}catch{}
      const result=[...text.matchAll(/```STUDIO_RESULT\s*([\s\S]*?)```/g)].at(-1);
      if(result)try{const parsed=JSON.parse(result[1]);if(typeof parsed.summary==='string'){text=parsed.summary;artifacts=Array.isArray(parsed.artifacts)?parsed.artifacts:undefined;checks=Array.isArray(parsed.checks)?parsed.checks:undefined;}}catch{}
      // Native streamed and reconciled copies may have different IDs. Suppress
      // exact mirrors, retaining the original execution record for full review.
      const identity=(plan?'plan:':m.at+':')+original+JSON.stringify([m.images,m.files]);if(seenReplies.has(identity))continue;seenReplies.add(identity);
      if(text||m.images?.length||m.files?.length)entries.push({id:'reply:'+sessionId+':'+m.id,at:m.at,role:source.role,kind:'reply',taskId:source.task?.id,taskTitle:source.task?.title,sessionId,text:text.slice(-16000),images:m.images,files:m.files,artifacts,checks});
    }
    if(source.task?.sessionId===sessionId&&source.task.summary&&!messages.size)entries.push({id:'summary:'+source.task.id,at:source.task.finishedAt??source.task.startedAt??run.createdAt,role:source.role,kind:'delivery',taskId:source.task.id,taskTitle:source.task.title,sessionId,text:source.task.summary,artifacts:source.task.artifacts,checks:source.task.checks});
  }
  return entries.sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
}
export function groupPage(entries:GroupEntry[],before?:string){
  let list=entries;if(before){const split=before.indexOf('|'),at=Number(before.slice(0,split)),id=before.slice(split+1);if(split<0||!Number.isSafeInteger(at)||id.length>1000)throw Error('无效群聊历史位置');list=list.filter(e=>e.at<at||e.at===at&&e.id.localeCompare(id)<0);}
  const messages=list.slice(-100),first=messages[0];return {messages,cursor:list.length>messages.length&&first?first.at+'|'+first.id:null};
}
