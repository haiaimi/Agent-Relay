import {displayUserMessage} from './message-text.js';
import {setupReplyKeys} from './composer.js';
import {enhanceDiagrams} from './diagrams.js';
import {pagedConversationCache} from './conversation-cache.js';
import {AttachmentInput} from './attachments.js';
import {mediaCard,disposeMedia,clipboardFiles} from './studio-media.js';
import {QuestionPanel} from './questions.js';
import {roleAvatar} from './studio-avatar.js';
import {runTasks,roleSessions,reviewMessages,roleRecords,taskStatus,groupMessages,mentionedRoles} from './studio-review.js';
const $=id=>document.getElementById(id),el=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls||'';if(text!==undefined)n.textContent=text;return n;};
export function studioChat({snapshot,api,refresh,roleName,notify}){
  let lastLoadAt=0,lastChannelsAt=0,channelsJob,mobileDetail=false,listScroll=0;
  const mobile=window.matchMedia('(max-width: 800px)'),channelData=new Map();
  let runId,role='director',sessionId='',generation=0,loading=false,sending=false,signature='',lastTarget='',messageId=null,newConversation=false;
  const drafts=new Map(),pages=new Map(),rows=new Map(),seen=new Set(),expanded=new Set();
  let contextSignature='',rolesSignature='',choicesSignature='',historyCursor=null,loadJob;
  const tasks=runTasks;
  const run=()=>snapshot().state.runs.find(r=>r.id===runId),team=()=>snapshot().state.projects.find(p=>p.id===run()?.projectId);
  const sessions=()=>run()?roleSessions(run(),role):[];
  const selection=()=>sessions().find(s=>s.id===sessionId);
  const cache=pagedConversationCache({target:()=>run()&&(role==='team'||sessionId)?{identity:JSON.stringify([team().hostId,runId,role,role==='team'?'':sessionId,run().workspace?.value?.project?.path]),generation}:null,pages,cursor:()=>historyCursor,view:()=>$('chat-timeline'),restore:value=>{historyCursor=value.cursor;$('chat-earlier').hidden=historyCursor===null;$('chat-earlier').dataset.cursor=String(historyCursor??'');renderTimeline();},note:()=>$('chat-cache-note').textContent='已显示浏览器缓存 · 正在同步最新记录…'});
  const key=()=>runId+':'+role,context=()=>{const p=team(),r=run();return p&&r?{key:key(),target:{hostId:p.hostId,...sessionId?{sessionId}:{projectId:r.workspace?.value?.project?.id}}}:null;};
  const files=new AttachmentInput($('chat-form'),$('chat-attach'),$('chat-files'),context,m=>{$('chat-error').textContent=m||'';},{clipboardFiles});
  const action=async value=>api('actions',{id:crypto.randomUUID(),sessionId,...value});
  const questions=new QuestionPanel($('chat-questions'),(card,answers)=>action({type:'answer',questionId:card.id,answers}),()=>snapshot().relay.hosts.some(h=>h.id===team()?.hostId&&h.online),notify);
  function saveDraft(){drafts.set(key(),$('chat-text').value);localStorage.setItem('studio-chat-draft:'+key(),$('chat-text').value);}
  $('chat-text').oninput=()=>{saveDraft();messageId=null;};
  function reset(){generation++;loading=false;loadJob=null;lastLoadAt=0;signature='';contextSignature='';lastTarget='';historyCursor=null;pages.clear();rows.clear();seen.clear();expanded.clear();disposeMedia($('chat-timeline'));$('chat-timeline').replaceChildren();$('chat-approvals').replaceChildren();$('chat-cache-note').textContent='';$('chat-earlier').hidden=true;questions.reset();}
  function syncView(){
    const detail=!mobile.matches||mobileDetail;$('chat-dialog').dataset.chatView=detail?'conversation':'list';$('chat-back').hidden=!mobile.matches||!mobileDetail;
    if(!detail&&run()){$('chat-title').textContent=run().title+' · 职能会话';$('chat-branch').textContent='团队群聊与 '+team().roles.filter(a=>a.enabled).length+' 位角色';}
  }
  function switchRole(next,nextSession=''){if(sending)return;cache.save();listScroll=$('chat-roles').scrollTop;saveDraft();role=next;sessionId=nextSession;newConversation=false;mobileDetail=true;reset();renderHeader();restore();void load();}
  function renderChannels(r,p){
    const channels=[{role:'team'},...p.roles.filter(a=>a.enabled)],sig=JSON.stringify([r.id,role,channels.map(c=>[c.role,channelData.get(c.role),tasks(r).filter(t=>c.role==='team'||t.role===c.role).map(t=>[t.id,t.status])])]);if(sig===rolesSignature)return;rolesSignature=sig;
    const list=$('chat-roles'),scroll=mobile.matches&&mobileDetail?listScroll:list.scrollTop;list.replaceChildren(...channels.map(c=>{
      const id=c.role,name=id==='team'?'团队群聊':roleName(id),data=channelData.get(id),assigned=id==='team'?r.tasks:tasks(r).filter(t=>t.role===id),done=assigned.filter(t=>t.status==='done').length;
      const state=data?.state||(assigned.some(t=>t.status==='awaiting-review')?'waiting':assigned.some(t=>t.status==='blocked')?'blocked':assigned.some(t=>['running','starting'].includes(t.status))?'running':assigned.length&&done===assigned.length?'done':'idle');
      const b=el('button','role-channel'+(id===role?' active':'')),body=el('span','role-channel-copy'),head=el('span','channel-heading'),meta=el('span','channel-progress');b.type='button';b.dataset.role=id;b.setAttribute('aria-pressed',String(id===role));
      head.append(el('strong','',name),el('time','channel-time',data?.at?new Date(data.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}):''));
      const prefix=data?.author==='user'?'你：':id==='team'&&data?.previewRole?roleName(data.previewRole)+'：':'';body.append(head,el('span','channel-preview',prefix+(data?.preview||'暂无消息，点击查看会话')));
      meta.append(el('span','channel-state '+state,data?.progress||(state==='waiting'?'等待你确认':state==='running'?'正在处理任务':state==='done'?'任务已完成':assigned.length?'等待任务分发':'随时可以讨论')));
      if((data?.total??assigned.length)>0)meta.append(el('span','channel-count',`${data?.done??done}/${data?.total??assigned.length} 已完成`));body.append(meta);
      if(data?.taskId)body.append(el('span','channel-task',data.taskId+' · '+data.taskTitle));b.append(roleAvatar(p.id,id,name),body);b.onclick=()=>switchRole(id);return b;
    }));list.scrollTop=scroll;
  }
  async function loadChannels(force=false){
    if(!$('chat-dialog').open||channelsJob||!force&&Date.now()-lastChannelsAt<4000)return;lastChannelsAt=Date.now();const target=runId,job={};channelsJob=job;
    try{const value=await api('studio/channels?'+new URLSearchParams({runId:target}));if(target!==runId)return;channelData.clear();for(const c of value.channels)channelData.set(c.role,c);renderChannels(run(),team());}catch(e){if(target===runId&&mobile.matches&&!mobileDetail)$('chat-branch').textContent='消息摘要暂不可用 · 点击职能查看已同步记录';}finally{if(channelsJob===job)channelsJob=null;}
  }
  $('chat-back').onclick=()=>{saveDraft();if($('chat-form').contains(document.activeElement))document.activeElement.blur();mobileDetail=false;syncView();$('chat-roles').scrollTop=listScroll;void loadChannels(true);};
  mobile.addEventListener('change',()=>{if($('chat-dialog').open){renderHeader();void load();}});
  function renderHeader(){
    const r=run(),p=team();if(!r||!p)return;$('chat-new').hidden=false;$('chat-text').placeholder='向这个角色补充方向、讨论细节；支持粘贴图片、视频和文件…';renderChannels(r,p);
    $('chat-recipient').hidden=role!=='team';$('chat-session').hidden=role==='team';if(role==='team'){renderGroupHeader(r,p);syncView();return;}
    $('chat-title').textContent=r.title+' · '+roleName(role);$('chat-branch').textContent=r.workspace?.value?.branch||'正在准备独立分支';
    const choices=sessions();if(!newConversation&&(!sessionId||!choices.some(s=>s.id===sessionId)))sessionId=tasks(r).find(t=>t.role===role&&t.sessionId&&['starting','running'].includes(t.status))?.sessionId||choices.at(-1)?.id||'';
    const selector=$('chat-session'),choiceSig=JSON.stringify([choices.map(s=>[s.id,s.label]),newConversation]);if(choiceSig!==choicesSignature){choicesSignature=choiceSig;selector.replaceChildren(...choices.map(s=>{const o=el('option','',s.label);o.value=s.id;return o;}));if(!choices.length||newConversation){const o=el('option','',newConversation?'新的制作人对话':'首次发消息时开启角色对话');o.value='';selector.append(o);}}if(selector.value!==sessionId)selector.value=sessionId;selector.disabled=sending;
    const s=snapshot().relay.sessions.find(s=>s.id===sessionId),archived=selection()?.archived,finished=r.status==='cancelled'||archived,ready=r.workspace?.status==='ready';
    $('chat-status').textContent=archived?'历史执行记录 · 只读，可新建对话继续讨论':r.status==='accepted'?'已交付 · 可继续追问，发送后进入交付后讨论，保留原任务与验收记录':s?({running:'正在工作',waiting:'等待你的确认',idle:'可继续对话',failed:'上次执行失败',interrupted:'已停止'}[s.status]||s.status)+(s.pendingCount?' · '+s.pendingCount+' 条排队':'')+(['running','waiting'].includes(s.status)&&s.activity?.label?' · '+s.activity.label:''):ready?'任务尚未启动；可以先与该角色讨论方向':'独立分支准备完成后可发送';
    $('chat-submit').disabled=sending||finished||!ready;$('chat-attach').disabled=sending||finished||!ready;$('chat-text').disabled=sending||finished||!ready;
    $('chat-stop').hidden=archived||!s||!['running','waiting'].includes(s.status);$('chat-full').hidden=!sessionId;$('chat-full').href='/?sessionId='+encodeURIComponent(sessionId);
    $('chat-new').disabled=sending||r.status==='cancelled'||!ready||tasks(r).some(t=>t.role===role&&['starting','running'].includes(t.status));
    renderContext();renderTimeline();syncView();
    const unresolved=(r.chats??[]).find(c=>c.role===role&&!c.sessionId&&c.error&&!c.resolved);const recovery=$('chat-recovery');recovery.replaceChildren();if(unresolved){$('chat-error').textContent=unresolved.error+' 请先核对完整会话，系统不会自动重发。';const used=new Set(snapshot().state.runs.flatMap(x=>[...tasks(x).map(t=>t.sessionId),...(x.chats??[]).map(c=>c.sessionId)])),candidates=snapshot().relay.sessions.filter(s=>s.hostId===p.hostId&&s.projectId===r.workspace?.value?.project?.id&&s.updatedAt>=unresolved.startedAt&&!used.has(s.id));if(candidates.length){const select=el('select');select.setAttribute('aria-label','绑定未确认的角色会话');for(const s of candidates){const o=el('option','',s.title+' · '+s.provider);o.value=s.id;select.append(o);}const bind=el('button','quiet','核对后绑定会话');bind.onclick=async()=>{try{await api('studio/command',{runId,op:'bind-chat',actionId:unresolved.actionId,sessionId:select.value});await refresh(true);}catch(e){notify(e.message);}};recovery.append(select,bind);}const dismiss=el('button','quiet','核对会话未启动');let armed=false;dismiss.onclick=async()=>{if(!armed){armed=true;dismiss.textContent='确认未启动，解除等待';return;}try{await api('studio/command',{runId,op:'resolve-chat',actionId:unresolved.actionId,confirmedNotStarted:true});await refresh(true);}catch(e){notify(e.message);}};recovery.append(dismiss);}
  }
  function renderGroupHeader(r,p){
    $('chat-title').textContent=r.title+' · 团队群聊';$('chat-branch').textContent=r.workspace?.value?.branch||'正在准备独立分支';
    const finished=r.status==='cancelled',ready=r.workspace?.status==='ready',recipient=$('chat-recipient');
    const options=[['','发到群里 · 仅记录'],...p.roles.filter(a=>a.enabled).map(a=>[a.role,'请 '+roleName(a.role)+' 回应'])],sig=JSON.stringify(options);if(recipient.dataset.options!==sig){const previous=recipient.value;recipient.replaceChildren(...options.map(([id,label])=>{const o=el('option','',label);o.value=id;return o;}));recipient.value=recipient.dataset.options?previous:'director';recipient.dataset.options=sig;}
    recipient.disabled=sending||finished||!ready;$('chat-new').hidden=true;$('chat-full').hidden=true;$('chat-stop').hidden=true;
    $('chat-submit').disabled=sending||finished||!ready;$('chat-text').disabled=sending||finished||!ready;$('chat-attach').disabled=sending||finished||!ready;
    $('chat-status').textContent=r.status==='accepted'?'已交付 · 可以继续群聊，回复进入交付后讨论，保留原任务与验收记录':p.roles.filter(a=>a.enabled).length+' 位角色 · 任务交接、进度与回复共享在群里';$('chat-text').placeholder='给团队发消息；可 @关卡策划 @原画 指定角色，也可选择回应角色…';
    const sigContext=JSON.stringify([r.tasks.map(t=>[t.id,t.status,t.dependencies]),r.paused]);if(contextSignature!==sigContext){contextSignature=sigContext;const root=$('chat-context'),wasOpen=root.open;root.replaceChildren(el('summary','','团队任务与协作依赖 · '+r.tasks.length+' 个任务'));root.open=wasOpen;for(const t of r.tasks){const section=el('section','chat-task-brief');section.append(el('strong','',t.id+' · '+t.title),el('p','fine',roleName(t.role)+' · '+(taskStatus[t.status]||t.status)),el('p','fine','接收上游：'+(t.dependencies.map(id=>{const upstream=tasks(r).find(x=>x.id===id);return upstream?roleName(upstream.role)+' / '+upstream.title:id;}).join('、')||'无前置依赖')));root.append(section);}}
    renderTimeline();
  }
  function restore(){$('chat-text').value=drafts.get(key())??localStorage.getItem('studio-chat-draft:'+key())??'';messageId=null;files.render();}
  function friendly(m){if(m.role!=='user')return m;const r=run(),t=selection()?.task,g=[...(r.guidance??[])].reverse().find(g=>g.id===m.id||g.sessionId===sessionId&&((m.text||'').startsWith(g.text+'\n这是制作人')||(m.text||'').startsWith('这是制作人通过团队群聊')&&(m.text||'').split('\n这是制作人对本任务')[0].endsWith(g.text)));
    if(g)return {...m,text:g.text||'请查看附件。'};
    if(t&&m.text?.startsWith('独立需求分支：'))return {...m,text:'制作任务：'+t.title+'\n\n'+r.brief+'\n\n'+t.brief+'\n验收标准：'+t.acceptance};
    if(m.text?.startsWith('你是游戏团队的')){const first=(r.guidance??[]).find(g=>g.sessionId===sessionId);if(first)return {...m,text:first.text||'请查看附件。'};}return m;}
  const date=at=>at?new Date(at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'';
  function renderContext(){
    const r=run(),selected=selection(),assigned=selected?.task?[selected.task]:tasks(r).filter(t=>t.role===role),sig=JSON.stringify([assigned,selected?.archived,r.paused]);if(sig===contextSignature)return;contextSignature=sig;
    const root=$('chat-context'),wasOpen=root.open;root.replaceChildren();root.open=wasOpen;
    root.append(el('summary','',selected?.task?`${selected.archived?'历史任务':'当前任务'} · ${selected.task.id} · ${selected.task.title}`:assigned.length?`该职能的 ${assigned.length} 个制作任务`:'制作人对话 · 尚未关联制作任务'));
    for(const t of assigned){const block=el('section','chat-task-brief');block.append(el('strong','',t.id+' · '+t.title),el('span','pill',selected?.archived?'历史执行':taskStatus[t.status]||t.status),el('p','',t.brief),el('p','fine','验收：'+t.acceptance));if(t.dependencies.length)block.append(el('p','fine','前置任务：'+t.dependencies.map(id=>tasks(r).find(x=>x.id===id)?.title||id).join('、')));if(t.status==='queued')block.append(el('p','fine',r.paused?'需求已暂停，等待制作人继续分发。':'等待前置任务和计划确认后分发。'));root.append(block);}
  }
  function build(original){
    const m=displayUserMessage(original.group?original:friendly(original)),actor=m.actor??role,actorName=actor==='studio'?'工作室':actor==='producer'?'制作人':roleName(actor),t=m.task??selection()?.task,row=el('article','chat-message '+m.role),body=el('div','chat-message-body'),head=el('div','chat-message-head');row.dataset.messageId=m.id;
    row.append(roleAvatar(team().id,m.role==='user'?'producer':m.systemRecord?'studio':actor,m.role==='user'?'制作人':m.systemRecord?'协作记录':actorName),body);
    head.append(el('strong','',m.role==='user'?'制作人':m.group?(m.systemRecord?'协作记录':actorName):['record','system'].includes(m.role)?'制作记录':roleName(role)),el('time','',date(m.timestamp)));body.append(head,el('span','chat-task-tag',t?t.id+' · '+t.title:m.group?'团队群聊'+(m.toRoles?.length?' · @'+m.toRoles.map(roleName).join(' @'):''):'制作人对话 · '+run().title));
    if(m.role==='tool'){
      const details=el('details','chat-tool'),summary=el('summary','',m.label||'工具调用与执行结果');details.open=expanded.has(m.id);details.ontoggle=()=>{if(details.open)expanded.add(m.id);else expanded.delete(m.id);};details.append(summary,el('pre','',m.text||'暂无工具输出'));body.append(details);
    }else if(['activity','record'].includes(m.role))body.append(el('div','chat-record-label'+(m.error?' error':''),m.label),el('div','chat-copy',m.text||''));
    else{const text=el('div','chat-copy');if(window.markdownit&&window.DOMPurify){text.innerHTML=window.DOMPurify.sanitize(window.markdownit({html:false,linkify:false}).render(m.text||''));for(const a of text.querySelectorAll('a')){a.target='_blank';a.rel='noopener noreferrer';}}else text.textContent=m.text||'';body.append(text);}
    if(m.role==='delivery'||m.group){
      for(const artifact of (m.group?m.artifacts:m.task.artifacts)??[]){const item=el('div','chat-delivery-file');item.append(el('code','',artifact.path),el('span','fine',artifact.description));body.append(item);}
      if((m.group?m.checks:m.task.checks)?.length){body.append(el('strong','chat-check-title','Agent 提交的实际验证记录'));const list=el('ul','chat-checks');for(const check of m.group?m.checks:m.task.checks)list.append(el('li','',check));body.append(list);}
    }
    for(const f of m.files??[])body.append(mediaCard(f,m.group&&m.actor==='producer'?{runId}: {sessionId:m.sourceSessionId??sessionId,hostId:team().hostId}));for(const f of m.images??[])body.append(mediaCard(f,{sessionId:m.sourceSessionId??sessionId,hostId:team().hostId,kind:'image'}));
    if(m.group){for(const d of m.deliveries??[])body.append(el('p',d.error?'error':'fine','@'+roleName(d.role)+' · '+(d.status==='sent'?'已投递':d.status==='pending'?'投递结果等待核对':'未确认投递')+(d.error?'：'+d.error:'')));if(m.sourceSessionId){const open=el('button','quiet','查看该职能完整过程');open.type='button';open.onclick=()=>{if(roleSessions(run(),actor).some(s=>s.id===m.sourceSessionId))switchRole(actor,m.sourceSessionId);else{saveDraft();location.href='/?sessionId='+encodeURIComponent(m.sourceSessionId);}};body.append(open);}}
    const s=snapshot().relay.sessions.find(s=>s.id===sessionId);if(s?.pendingIds?.includes(m.id)){body.append(el('small','muted','排队中'));for(const [type,label] of [['steer','立即引导'],['cancel-input','取消排队']]){const b=el('button','quiet',label);b.type='button';b.disabled=type==='steer'&&!s.canSteer;b.onclick=async()=>{b.disabled=true;try{await action({type,queuedId:m.id});await refresh(true);signature='';void load();notify(type==='steer'?'已将消息送入当前工作':'已取消排队');}catch(e){notify(e.message);b.disabled=false;}};body.append(b);}}
    return row;
  }
  function renderTimeline(older=false){
    const r=run();if(!r)return;const timeline=$('chat-timeline'),bottom=timeline.scrollHeight-timeline.scrollTop-timeline.clientHeight<100,oldHeight=timeline.scrollHeight,anchor=[...timeline.children].find(e=>e.getBoundingClientRect().bottom>timeline.getBoundingClientRect().top),offset=anchor?.getBoundingClientRect().top;
    const order=(role==='team'?groupMessages([...pages.values()].reverse(),roleName):[...reviewMessages([...pages.values()].reverse()),...roleRecords(r,role,sessionId)]).sort((a,b)=>(a.timestamp??0)-(b.timestamp??0)),all=new Set(order.map(m=>m.id));
    let empty=timeline.querySelector('.chat-empty');const emptyState=sessionId?(pages.size?'empty':'loading'):'unstarted';if(order.length||empty&&empty.dataset.state!==emptyState){empty?.remove();empty=null;}
    for(const [id,row] of rows)if(!all.has(id)){disposeMedia(row.element);row.element.remove();rows.delete(id);}
    for(const m of order){const active=snapshot().relay.sessions.find(s=>s.id===sessionId),pending=active?.pendingIds?.includes(m.id),v=JSON.stringify([m,pending,pending?active.canSteer:null]),old=rows.get(m.id);if(old?.version===v)continue;const element=build(m);if(old){disposeMedia(old.element);old.element.replaceWith(element);}rows.set(m.id,{version:v,element});}
    // Keep videos and expanded tools mounted through ordinary live updates.
    let cursor=timeline.firstElementChild;for(const m of order){const element=rows.get(m.id).element;if(element===cursor)cursor=cursor.nextElementSibling;else timeline.insertBefore(element,cursor);}
    if(!order.length&&!empty){const n=el('div','chat-empty');n.dataset.state=emptyState;n.append(roleAvatar(team().id,role,roleName(role)),el('h3','',sessionId?(pages.size?'尚无已同步的生产记录':'正在读取生产记录…'):(role==='team'?'团队群聊':roleName(role)+'的工作空间')),el('p','fine',sessionId?'消息、工具调用和公开执行步骤会按时间显示。':'任务开始后，这里会显示消息、工具执行、交付和验证记录。上方可展开查看已分配的任务。'));timeline.append(n);}
    enhanceDiagrams(timeline);
    const records=order.filter(m=>['tool','activity','record'].includes(m.role)).length;$('chat-review-meta').textContent=order.length?`${order.length} 条记录 · ${records} 条执行步骤`:'生产记录';
    if(older||!bottom&&seen.size){if(anchor?.isConnected)timeline.scrollTop+=anchor.getBoundingClientRect().top-offset;else if(older)timeline.scrollTop+=timeline.scrollHeight-oldHeight;}else timeline.scrollTop=timeline.scrollHeight;
    if(order.length)seen.add(sessionId||role);
  }
  function approvals(page){const map=new Map();for(const e of page.events??[]){const d=e.data;if(e.type==='approval')map.set(d.approvalId,d);if(e.type==='approval.resolved')map.delete(d.approvalId);}const root=$('chat-approvals');root.replaceChildren();for(const [id,a]of map){if(a.expiresAt<Date.now())continue;const box=el('div','approval-card');box.append(el('strong','','需要工具批准'),el('pre','',a.description||a.command||JSON.stringify(a)));for(const [label,allow]of [['允许这一次',true],['拒绝',false]]){const b=el('button','quiet',label);b.onclick=async()=>{b.disabled=true;try{await action({type:'approve',approvalId:id,allow});signature='';await load();}catch(e){notify(e.message);b.disabled=false;}};box.append(b);}root.append(box);}}
  async function load(cursor){
    if(mobile.matches&&!mobileDetail)return;
    cache.load();
    if(role==='team')return loadGroup(cursor);
    if(loading||!$('chat-dialog').open||!sessionId)return;loading=true;lastLoadAt=Date.now();const job={};loadJob=job;const stamp=generation,target=sessionId;try{
      const page=await api('history?'+new URLSearchParams({sessionId:target,...cursor!==undefined?{cursor:String(cursor)}:{live:'1'}}));if(stamp!==generation||target!==sessionId)return;
      pages.set(cursor===undefined?'latest':String(cursor),page);renderTimeline(cursor!==undefined);
      if(cursor!==undefined||pages.size===1)historyCursor=page.cursor??null;$('chat-earlier').hidden=historyCursor===null;$('chat-earlier').dataset.cursor=String(historyCursor??'');
      $('chat-cache-note').textContent=page.cached?'电脑暂不可达，正在显示已同步的记录。':'';
      if(cursor===undefined){approvals(page);for(const event of page.events??[])if(['question','question.resolved'].includes(event.type))questions.event(event.data);if(!page.cached)questions.reconcile(page.questions??[],page.questionsAsOf??Infinity);questions.render();}
      cache.save();
    }catch(e){if(stamp===generation)$('chat-error').textContent=e.message;}finally{if(loadJob===job)loading=false;}
  }
  async function loadGroup(cursor){
    if(loading||!$('chat-dialog').open)return;loading=true;lastLoadAt=Date.now();const job={},stamp=generation;loadJob=job;
    try{const page=await api('studio/group?'+new URLSearchParams({runId,...cursor?{before:String(cursor)}:{}}));if(stamp!==generation||role!=='team')return;pages.set(cursor?'before:'+cursor:'latest',page);renderTimeline(!!cursor);if(cursor||pages.size===1)historyCursor=page.cursor;$('chat-earlier').hidden=!historyCursor;$('chat-earlier').dataset.cursor=historyCursor||'';$('chat-cache-note').textContent='';cache.save();}catch(e){if(stamp===generation)$('chat-error').textContent=e.message;}finally{if(loadJob===job)loading=false;}
  }
  $('chat-session').onchange=()=>{cache.save();saveDraft();newConversation=false;sessionId=$('chat-session').value;reset();renderHeader();void load();};
  $('chat-earlier').onclick=()=>void load(role==='team'?$('chat-earlier').dataset.cursor:Number($('chat-earlier').dataset.cursor));
  $('chat-new').onclick=()=>{if(sending)return;cache.save();saveDraft();newConversation=true;sessionId='';reset();renderHeader();sessionId='';$('chat-session').value='';$('chat-status').textContent='下一条消息将开启新的角色对话';};
  $('chat-stop').onclick=async()=>{try{await action({type:'stop'});await refresh(true);renderHeader();}catch(e){notify(e.message);}};
  $('chat-form').onsubmit=async e=>{e.preventDefault();if(sending)return;const r=run(),p=team(),content=$('chat-text').value;if(selection()?.archived)return;if(!content.trim()&&!files.count)return;const target=context(),targetRole=role,targetRun=runId,targetSession=sessionId;messageId??=crypto.randomUUID();sending=true;renderHeader();$('chat-error').textContent='';
    try{const ids=await files.upload(target),result=await api(targetRole==='team'?'studio/group':'studio/chat',{id:messageId,runId:targetRun,...targetRole==='team'?{roles:mentionedRoles(content,p.roles,roleName,$('chat-recipient').value)}:{role:targetRole,sessionId:targetSession||undefined},text:content,attachmentIds:ids});files.clear(target.key);$('chat-text').value='';saveDraft();messageId=null;newConversation=false;sessionId=result.sessionId||'';await refresh(true);renderHeader();signature='';await load();notify(targetRole==='team'?(result.post.deliveries.some(d=>d.status!=='sent')?'群消息已保存，请核对各角色的投递状态':'群消息已保存'+(result.post.roles.length?'，已请指定角色回应':'')):result.queued?'消息已排队，可在消息旁点“立即引导”':'消息已发送');}
    catch(e){$('chat-error').textContent=e.message;}finally{sending=false;renderHeader();}
  };
  setupReplyKeys($('chat-text'),$('chat-submit'));
  $('chat-dialog').addEventListener('close',()=>{cache.save();saveDraft();generation++;});
  return {open(id,targetRole='director',targetSession=''){cache.save();if($('chat-dialog').open)saveDraft();runId=id;role=targetRole;newConversation=false;sessionId=targetSession;mobileDetail=!!targetSession;listScroll=0;channelData.clear();lastChannelsAt=0;rolesSignature='';reset();renderHeader();restore();if(!$('chat-dialog').open)$('chat-dialog').showModal();void loadChannels(true);void load();},update(){if($('chat-dialog').open){void loadChannels();const before=sessionId;renderHeader();if(before!==sessionId){reset();renderHeader();}if(Date.now()-lastLoadAt>1200)void load();}}};
}
