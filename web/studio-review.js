export const taskStatus = {queued:'待分发',starting:'启动中',running:'执行中',done:'已完成',skipped:'制作人已跳过',blocked:'待处理',cancelled:'已取消','awaiting-review':'等待视觉确认'};
const sessionStatus = {running:'正在执行',waiting:'等待确认',idle:'本轮执行结束',failed:'执行失败',interrupted:'执行已停止',history:'历史记录'};
export const runTasks = run => [run.planner,...run.tasks,...run.delivery?[run.delivery]:[]];
export function mentionedRoles(text,roles,roleName,fallback='director'){
  const targets=roles.filter(a=>a.enabled&&[a.role,roleName(a.role),roleName(a.role).split('/')[0].trim()].some(alias=>new RegExp('@'+alias.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=$|[\\s,，:：、。!?！？])','u').test(text))).map(a=>a.role);
  return targets.length?targets:fallback?[fallback]:[];
}
export function groupMessages(pages,roleName){
  const all=new Map();for(const page of pages)for(const entry of page.messages??[])all.set(entry.id,entry);
  return [...all.values()].map(m=>({...m,group:true,systemRecord:['record','handoff'].includes(m.kind),actor:m.role,sourceSessionId:m.sessionId,role:['record','handoff'].includes(m.kind)?'record':m.role==='producer'?'user':'assistant',timestamp:m.at,task:m.taskId?{id:m.taskId,title:m.taskTitle}:undefined,label:m.kind==='handoff'?'上游交接 → '+(m.toRoles??[]).map(roleName).join('、'):'协作进度'}));
}
export function roleSessions(run,role){
  const result=[];
  for(const task of runTasks(run).filter(t=>t.role===role)){
    for(const [index,attempt] of (task.attempts??[]).entries())if(attempt.sessionId&&attempt.sessionId!==task.sessionId)result.push({id:attempt.sessionId,task,archived:true,label:`${task.id} · ${task.title} · 历史第 ${index+1} 次`});
    if(task.sessionId)result.push({id:task.sessionId,task,archived:false,label:`${task.id} · ${task.title} · ${taskStatus[task.status]||task.status}`});
  }
  for(const [index,chat] of (run.chats??[]).filter(c=>c.role===role&&c.sessionId).entries())result.push({id:chat.sessionId,label:(chat.afterDelivery?'交付后讨论 ':'制作人对话 ')+(index+1),archived:false});
  return result.filter((s,i)=>result.findIndex(x=>x.id===s.id)===i);
}
// Native tool messages contain the reviewable command and result. Activity events
// contain only public phase labels; never inspect or reconstruct hidden reasoning.
export function reviewMessages(pages){
  const messages=new Map(),canonical=new Set(),events=new Map();
  for(const page of pages)for(const message of page.messages??[]){messages.set(message.id,{...message});canonical.add(message.id);}
  for(const page of pages)for(const event of page.events??[])events.set(event.id,event);
  let previousActivity='';
  for(const event of [...events.values()].sort((a,b)=>a.at-b.at)){
    const d=event.data??{};
    if(event.type==='message'){
      for(const id of d.replaces??[])messages.delete(id);
      const old=messages.get(d.id);
      messages.set(d.id,{...old,...d,text:canonical.has(d.id)?old?.text:d.text??old?.text,timestamp:d.timestamp??old?.timestamp??event.at,images:canonical.has(d.id)?old?.images:d.images??old?.images,files:d.files??old?.files});
    }else if(event.type==='delta'&&!canonical.has(d.messageId)){
      const old=messages.get(d.messageId)||{id:d.messageId,role:'assistant',text:'',timestamp:event.at};
      old.text+=d.text??'';messages.set(old.id,old);
    }else if(event.type==='activity'){
      const label=String(d.label||'正在执行').slice(0,200),detail=String(d.detail||'').slice(0,500),signature=label+'\n'+detail;
      if(signature===previousActivity)continue;previousActivity=signature;
      messages.set('event:'+event.id,{id:'event:'+event.id,role:'activity',label,text:detail,timestamp:event.at});
    }else if(event.type==='error')messages.set('event:'+event.id,{id:'event:'+event.id,role:'record',label:'执行异常',text:String(d.error||d.message||'请查看完整会话'),timestamp:event.at,error:true});
    else if(event.type==='status'&&sessionStatus[d.status])messages.set('event:'+event.id,{id:'event:'+event.id,role:'record',label:sessionStatus[d.status],text:'',timestamp:event.at});
    if(event.type!=='activity')previousActivity='';
  }
  return [...messages.values()].filter(m=>['user','assistant','system','tool','activity','record'].includes(m.role)).sort((a,b)=>(a.timestamp??0)-(b.timestamp??0));
}
export function roleRecords(run,role,sessionId){
  const selected=roleSessions(run,role).find(s=>s.id===sessionId),tasks=selected?.task?[selected.task]:!sessionId?runTasks(run).filter(t=>t.role===role):[];
  const records=[];
  for(const task of tasks){
    // Archived attempts keep their own transcript; today's task outcome belongs
    // only to the current session, never to a previous attempt.
    if(selected?.archived)continue;
    for(const [index,entry] of (run.log??[]).entries()){
      if(entry.taskId===task.id||!entry.taskId&&['分发：','已启动：','完成：','待处理：','返工：'].some(prefix=>entry.text===prefix+task.title))records.push({id:'run-log:'+index,role:'record',label:'任务进度',task,text:entry.text,timestamp:entry.at});
    }
    if(task.skip)records.push({id:'skip:'+task.id,role:'record',label:'制作人跳过并继续',task,text:task.skip.reason+'\n原阻断保留，后续 QA 按实际结果验收。',timestamp:task.skip.at});
    if(task.summary||task.error||task.checks?.length||task.artifacts?.length)records.push({id:'delivery:'+task.id,role:'delivery',label:'交付与验证 · '+task.id,task,text:task.summary||task.error||'',timestamp:task.finishedAt??task.startedAt??run.createdAt});
  }
  return records;
}
