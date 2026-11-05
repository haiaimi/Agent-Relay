import type {StudioRun,StudioProject} from './studio.js';
import type {RelayStore} from './store.js';
import type {GroupPost} from './studio-group.js';
type Preview={text:string;at:number;author:'user'|'assistant';sessionId?:string};
export function channelPreview(text:string){
  const result=[...text.matchAll(/```STUDIO_RESULT\s*([\s\S]*?)```/g)].at(-1);
  if(result)try{const value=JSON.parse(result[1]);if(typeof value.summary==='string')text=value.summary;}catch{}
  const plan=[...text.matchAll(/```STUDIO_PLAN\s*([\s\S]*?)```/g)].at(-1);
  if(plan)try{text='已提交制作计划 · '+JSON.parse(plan[1]).tasks.length+' 个任务';}catch{}
  return text.replace(/!\[[^\]]*\]\([^)]*\)/g,'[图片]').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/```[^\n]*\n?/g,'').replace(/[*#`]/g,'').replace(/\s+/g,' ').trim().slice(0,160);
}
function latestMessage(store:RelayStore,sessionId:string):Preview|undefined{
  const messages=new Map<string,{text:string;at:number;author:'user'|'assistant'}>(),canonical=new Set<string>();
  // Only read the latest cached conversational item; do not pull history from an agent.
  const cached=store.db.prepare("SELECT m.value FROM history h,json_each(h.json,'$.messages') m WHERE h.session_id=? AND h.cursor='latest' AND json_extract(m.value,'$.role') IN ('user','assistant') ORDER BY CAST(m.key AS INTEGER) DESC LIMIT 1").get(sessionId);
  if(cached){const m=JSON.parse(String(cached.value));canonical.add(m.id);messages.set(m.id,{text:m.text||((m.images?.length||m.files?.length)?'[图片 / 文件]':''),at:m.timestamp??0,author:m.role});}
  const rows=store.db.prepare("SELECT json FROM (SELECT seq,json FROM events WHERE session_id=? AND json_extract(json,'$.type') IN ('message','delta') ORDER BY seq DESC LIMIT 80) ORDER BY seq").all(sessionId);
  for(const row of rows){const e=JSON.parse(String(row.json)),d=e.data;
    if(e.type==='message'&&['user','assistant'].includes(d.role)&&!canonical.has(d.id))messages.set(d.id,{text:d.text||((d.images?.length||d.files?.length)?'[图片 / 文件]':''),at:d.timestamp??e.at,author:d.role});
    if(e.type==='delta'&&!canonical.has(d.messageId)){const m=messages.get(d.messageId)??{text:'',at:e.at,author:'assistant' as const};m.text=(m.text+String(d.text??'')).slice(-18000);m.at=e.at;messages.set(d.messageId,m);}
  }
  const latest=[...messages.values()].filter(m=>m.text.trim()).sort((a,b)=>b.at-a.at)[0];return latest?{...latest,sessionId}:undefined;
}
export function studioChannels(run:StudioRun,project:StudioProject,store:RelayStore,posts:GroupPost[]){
  const tasks=[run.planner,...run.tasks,...run.delivery?[run.delivery]:[]];
  const summaries=project.roles.filter(r=>r.enabled).map(role=>{
    const assigned=tasks.filter(t=>t.role===role.role),ids=new Set([...assigned.map(t=>t.sessionId),...(run.chats??[]).filter(c=>c.role===role.role).map(c=>c.sessionId)].filter((id):id is string=>!!id));
    const candidates:Preview[]=[];
    for(const id of ids){const s=store.getSession(id);if(s?.hostId!==project.hostId)continue;const latest=latestMessage(store,id);if(latest)candidates.push(latest);}
    for(const g of run.guidance??[])if(g.role===role.role)candidates.push({text:g.text||(g.files?.length?'[图片 / 文件]':''),author:'user',at:g.at,sessionId:g.sessionId});
    for(const t of assigned)if(t.summary)candidates.push({text:t.summary,author:'assistant',at:t.finishedAt??t.startedAt??run.createdAt,sessionId:t.sessionId});
    const latest=candidates.sort((a,b)=>b.at-a.at)[0],active=assigned.find(t=>['starting','running'].includes(t.status)),waiting=assigned.find(t=>t.status==='awaiting-review'),blocked=assigned.find(t=>t.status==='blocked'),queued=assigned.find(t=>t.status==='queued');
    const sessions=[...ids].map(id=>store.getSession(id)),needsAnswer=sessions.find(s=>s?.questionCount||s?.status==='waiting'),live=sessions.find(s=>s?.status==='running'),done=assigned.filter(t=>t.status==='done').length,skipped=assigned.filter(t=>t.status==='skipped').length;
    const state=waiting||needsAnswer?'waiting':blocked?'blocked':active||live?'running':queued?'queued':assigned.length&&done===assigned.length?'done':'idle';
    const current=waiting??blocked??active??queued;
    const progress=waiting?waiting.kind==='producer-review'?'等待你审批：'+waiting.title:'等待你确认原画':needsAnswer?'等待你的确认 / 回答':blocked?.checkpoint?'已保存断点，可继续':blocked?'任务待处理':live?.activity?.label|| (active?'正在处理任务':run.paused&&queued?'已暂停分发':queued?'等待前置任务':skipped?'制作人已跳过 '+skipped+' 项，原阻断保留':state==='done'?'任务已完成':'随时可以讨论');
    let preview=latest?.text??'';
    if(preview.startsWith('独立需求分支：')||preview.startsWith('你是游戏团队的'))preview='制作任务：'+(assigned.find(t=>t.sessionId===latest?.sessionId)?.title??run.title);
    return {role:role.role,preview:channelPreview(preview)||'暂无消息，点击开始讨论',author:latest?.author,at:latest?.at??0,sessionId:latest?.sessionId,state,progress,done,skipped,total:assigned.length,taskId:current?.id,taskTitle:current?.title};
  });
  const lastPost=posts.at(-1),lastReply=summaries.filter(s=>s.at).sort((a,b)=>b.at-a.at)[0],postIsLatest=lastPost&&lastPost.at>=(lastReply?.at??0),done=run.tasks.filter(t=>t.status==='done').length;
  const group={role:'team',previewRole:postIsLatest?'producer':lastReply?.role,preview:postIsLatest?channelPreview(lastPost.text)||(lastPost.files.length?'[图片 / 文件]':'群消息'):lastReply?.preview??'任务交接、制作进度与团队讨论',author:postIsLatest?'user':lastReply?.author,at:postIsLatest?lastPost.at:lastReply?.at??0,state:run.paused?'queued':run.tasks.some(t=>t.status==='awaiting-review')?'waiting':run.tasks.some(t=>t.status==='running')?'running':'idle',progress:run.paused?'已暂停分发':run.tasks.some(t=>t.status==='awaiting-review')?'等待制作人确认原画':'团队协作与任务交接',done,total:run.tasks.length};
  return {channels:[group,...summaries]};
}
