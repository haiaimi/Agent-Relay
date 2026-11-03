import {agentLabel,agentChoice,hostAgents} from './agent-ui.js';
import {AttachmentInput} from './attachments.js';
import {setupDrawer,setupSidebarResize} from './drawer.js';
import {userMessageText,displayMessage} from './message-text.js';
import {orderedMessages,acceptsStatusEvent,HistoryPager,reconcileChildren,timelineWithQuestions} from './timeline.js';
import {directAssets} from './direct.js';
import {QuestionPanel} from './questions.js';
import {settingsPresentation,findModel,modelName} from './session-settings.js';
import {setupComposerKeys} from './composer.js';
const $=id=>document.getElementById(id);
let state={hosts:[],sessions:[]},provider='all',selected=null,messages=new Map(),approvals=new Map(),seen=new Set(),events=null,refreshTimer;
const historyPager=new HistoryPager();let olderError='',olderRequested=false,retainedReadingAnchor=null;
const canonicalMessages=new Set(),renderedMessages=new Map(),renderedGroups=new Map(),renderedApprovals=new Map();
let lastMessagesChanged=false;
const questionPanel=new QuestionPanel($('question-cards'),(card,answers)=>action({type:'answer',sessionId:card.sessionId,questionId:card.id,answers}),()=>!!hostOf(selected)?.online,toast);
questionPanel.anchor=()=>orderedMessages(messages.values()).at(-1)?.id;
questionPanel.beforeRender=()=>({anchor:readingAnchor(),follow:$('timeline').scrollHeight-$('timeline').scrollTop-$('timeline').clientHeight<40});
questionPanel.afterRender=snapshot=>{if(!selected)return;renderMessages(true);if(snapshot?.follow)$('timeline').scrollTop=$('timeline').scrollHeight;else restoreReadingAnchor(snapshot?.anchor);rememberReadingPosition();};
const modelCache=new Map(),modelLists=new Map(),settingChanges=new Set();let modelLoading=0,createModelLoading=0;
const drafts=new Map(),expandedTools=new Set(),sending=new Set(),stopping=new Set();let commandOptions=[],commandCandidates=[],commandIndex=0,commandsLoading=0;
const effortNames={default:'本机默认',none:'无',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高',ultra:'极高'};
const permissionNames={request:'请求批准',auto:'帮我批准',full:'完整权限'};
const permissionChanges=new Set();
const statusNames={history:'历史会话',idle:'已完成',running:'正在执行',waiting:'等待你确认',failed:'执行失败',interrupted:'已停止'};
const markdown=typeof window.markdownit==='function'?window.markdownit({html:false,linkify:true,breaks:true}):null;
const markdownCache=new Map();
if(markdown){
  markdown.renderer.rules.image=(tokens,index,options,env)=>{
    const token=tokens[index],src=token.attrGet('src')??'',alt=markdown.utils.escapeHtml(token.content||'图片');
    if(/^https?:\/\//i.test(src))return `<a href="${markdown.utils.escapeHtml(src)}" target="_blank" rel="noopener noreferrer">${alt}（外部图片）</a>`;
    return env?.hasImages?'':alt+'（图片待同步）';
  };
  const renderLink=markdown.renderer.rules.link_open??((tokens,index,options,env,self)=>self.renderToken(tokens,index,options));
  markdown.renderer.rules.link_open=(tokens,index,options,env,self)=>{
    tokens[index].attrSet('target','_blank');
    tokens[index].attrSet('rel','noopener noreferrer');
    return renderLink(tokens,index,options,env,self);
  };
}
function node(tag,className,text){const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e;}
function messageBody(message){
  const body=node('div','message-body'+(message.role==='assistant'?' markdown':''));
  const content=message.role==='user'?userMessageText(message.text):String(message.text??'');
  if(message.role!=='assistant'||!markdown||!window.DOMPurify){body.textContent=content;return body;}
  let cached=markdownCache.get(message.id);
  const hasImages=!!message.images?.length;
  if(!cached||cached.text!==content||cached.hasImages!==hasImages){
    cached={text:content,hasImages,html:window.DOMPurify.sanitize(markdown.render(content,{hasImages}),{USE_PROFILES:{html:true},FORBID_TAGS:['img'],FORBID_ATTR:['style'],ADD_ATTR:['target','rel']})};
    markdownCache.set(message.id,cached);
    if(markdownCache.size>500)markdownCache.delete(markdownCache.keys().next().value);
  }
  if(!cached.decorated){
    body.innerHTML=cached.html;
    for(const pre of body.querySelectorAll('pre')){
      const code=pre.querySelector('code');if(!code)continue;
      const language=code.className.match(/(?:^|\s)language-([\w+.-]+)/)?.[1]??'';
      if(language&&window.hljs?.getLanguage(language)){
        try{code.innerHTML=window.hljs.highlight(code.textContent,{language,ignoreIllegals:true}).value;}catch{}
      }
      const block=node('div','code-block'),toolbar=node('div','code-toolbar'),copy=node('button','code-copy','复制');
      copy.type='button';copy.setAttribute('aria-label','复制代码');toolbar.append(node('span','',language||'代码'),copy);
      pre.replaceWith(block);block.append(toolbar,pre);
    }
    cached.decorated=body.innerHTML;
  }else body.innerHTML=cached.decorated;
  return body;
}
function imageGallery(message){
  const gallery=node('div','image-gallery');
  for(const ref of (message.images??[]).filter(ref=>message.role!=='tool'||ref.id)){
    const figure=node('figure','image-card'),caption=node('figcaption','',ref.name||'图片');
    if(ref.id&&/^[a-f0-9]{64}$/.test(ref.id)){
      const target={hostId:selected.hostId,sessionId:selected.id},button=node('button','image-thumb'),img=node('img'),status=node('span','asset-status');button.type='button';button.setAttribute('aria-label','查看图片：'+(ref.name||'图片'));img.decoding='async';button.append(img,status);
      const load=directAssets.bind(img,status,target,'image',ref);
      button.onclick=async()=>{try{const {url}=await load(true),viewer=$('image-viewer');$('image-title').textContent=ref.name||'图片';$('image-full').alt=ref.name||'会话图片';$('image-full').src=url;$('image-original').href=url;if(!viewer.open)viewer.showModal();}catch(error){toast(error.message);}};figure.append(button);
    }else figure.append(node('p','image-error',ref.error||'图片暂不可用'));
    figure.append(caption);gallery.append(figure);
  }
  gallery.hidden=!gallery.childElementCount;return gallery;
}
function fileGallery(message){
  const gallery=node('div','file-gallery');for(const file of message.files??[]){
    if(!/^[a-f0-9-]{36}$/i.test(file.id))continue;const target={hostId:selected.hostId,sessionId:selected.id},card=node('div','file-card');
    if(file.mime?.startsWith('image/')){const button=node('button','image-thumb'),img=node('img'),status=node('span','asset-status');button.type='button';button.setAttribute('aria-label','查看图片：'+file.name);button.append(img,status);const load=directAssets.bind(img,status,target,'file',file);button.onclick=async()=>{try{const {url}=await load(true);$('image-title').textContent=file.name;$('image-full').alt=file.name;$('image-full').src=url;$('image-original').href=url;$('image-viewer').showModal();}catch(error){toast(error.message);}};card.append(button);}
    const link=node('button','file-download',file.name+' · '+Math.max(1,Math.round(file.size/1024))+' KB');link.type='button';link.title='通过服务器下载附件';link.onclick=async()=>{link.disabled=true;try{const result=await directAssets.read(target,'file',file,true),a=node('a');a.href=result.url;a.download=file.name;a.click();toast(result.mode);}catch(error){toast(error.message);}finally{link.disabled=false;}};card.append(link);gallery.append(card);
  }return gallery;
}
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,5000);}
async function api(path,body){const response=await fetch('/api/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const result=await response.json();if(response.status===401&&path!=='login'){loggedOut();throw new Error('请重新登录');}if(!response.ok||result.error)throw new Error(result.error||'请求失败');return result;}
function loggedOut(){events?.close();events=null;$('login').hidden=false;$('workspace').hidden=true;}
function hostOf(s){return state.hosts.find(h=>h.id===s?.hostId);}
function folder(path){return path?.replace(/[\\/]+$/,'').split(/[\\/]/).pop()||'未指定项目';}
function when(at){const days=Math.floor((Date.now()-at)/86400000);return days===0?'今天':days===1?'昨天':days<7?`${days} 天前`:new Date(at).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'});}
function renderList(){
  const search=$('search').value.trim().toLowerCase(),device=$('device-filter').value,project=$('project-filter').value;
  const activity=$('activity-filter').value;const list=state.sessions.filter(s=>(!activity||(activity==='active'?['running','waiting'].includes(s.status):activity==='failed'?['failed','interrupted'].includes(s.status):s.status===activity))&&(!device||s.hostId===device)&&(!project||(project==='__none__'?!s.projectId:`${s.hostId}|${s.projectId}`===project))&&(provider==='all'||s.provider===provider)&&(!search||`${s.title} ${s.cwd} ${s.projectName??''} ${hostOf(s)?.name??''}`.toLowerCase().includes(search)));
  $('session-count').textContent=list.length;const children=[];
  for(const s of list.slice(0,300)){
    const row=node('button','session-row'+(s.id===selected?.id?' selected':''));row.type='button';
    const top=node('div','row-head');top.append(node('i','dot'+(['running','waiting'].includes(s.status)?' online':'')),node('span','',agentLabel(s).toUpperCase()),node('span','',s.archived?'· 已归档':s.status!=='history'?'· '+(statusNames[s.status]??s.status):''));
    const title=node('strong','',s.title);const bottom=node('div','row-folder');bottom.append(node('span','',`${s.projectName??'未归属项目'} · ${folder(s.cwd)}`),node('time','',when(s.updatedAt)));row.append(top,title,bottom);row.title=`${hostOf(s)?.hostname??s.hostId}\n${s.projectName??'未归属项目'}\n${s.cwd}\n${s.title}`;row.onclick=()=>void select(s);children.push(row);
  }
  if(!children.length)children.push(node('p','empty-list',state.hosts.length?'没有匹配的会话。试试新建一个？':'等待本地电脑连接。启动连接程序后，会话会出现在这里。'));
  if(list.length>300)children.push(node('p','empty-list',`显示最近 300 条，共 ${list.length} 条。搜索可查找更早的会话。`));
  $('session-list').replaceChildren(...children);
  const switcher=$('session-switch');switcher.replaceChildren(new Option('切换会话…',''),...list.slice(0,300).map(s=>new Option(`${agentLabel(s)} · ${s.projectName??folder(s.cwd)} · ${s.title.slice(0,45)}`,s.id)));switcher.value=selected?.id??'';
}
function renderFilters(){
  const device=$('device-filter').value,project=$('project-filter').value;
  $('device-filter').replaceChildren(new Option('全部工作设备',''),...state.hosts.map(h=>new Option(`${h.hostname??h.name}${h.online?' · 在线':' · 离线'}`,h.id)));$('device-filter').value=state.hosts.some(h=>h.id===device)?device:'';
  const entries=state.hosts.filter(h=>!device||h.id===device).flatMap(h=>h.projects.map(p=>new Option(`${p.source==='codex'?'Codex · ':''}${p.name}${state.hosts.length>1?' · '+h.name:''}`,`${h.id}|${p.id}`)));
  $('project-filter').replaceChildren(new Option('全部项目',''),new Option('未归属项目','__none__'),...entries);if([...$('project-filter').options].some(o=>o.value===project))$('project-filter').value=project;
}
function renderHosts(){
  $('host-cards').replaceChildren(...state.hosts.map(h=>{const card=node('div','host-card');card.append(node('strong','',h.hostname??h.name));if(h.hostname&&h.name!==h.hostname)card.append(node('p','',h.name));const sub=node('p');sub.append(node('i','dot'+(h.online?' online':'')),node('span','',h.online?`${h.projects.length} 个项目 · ${h.platform??''} · 在线`:'离线 · 可浏览已缓存历史'));card.append(sub);if(h.sync)card.append(node('p','sync-state',`历史同步 ${h.sync.done}/${h.sync.total}${h.sync.state==='complete'?' · 已完成':h.sync.errors?' · '+h.sync.errors+' 条待重试':' · 进行中'}`));return card;}));
  if(!state.hosts.length)$('host-cards').append(node('div','host-card','尚未连接电脑 · 启动本地连接程序后即可开始'));
  $('connection').replaceChildren(node('i','dot'+(events?.readyState===1?' online':'')),document.createTextNode(events?.readyState===1?'中转连接正常':'正在重新连接'));
  if(!selected)$('host-label').textContent=state.hosts.map(h=>h.hostname??h.name).join(' · ')||'等待工作设备上线';
}
function renderHead(){
  if(!selected)return;
  $('session-title').title=selected.title;
  const online=hostOf(selected)?.online;$('host-label').textContent=hostOf(selected)?.hostname??hostOf(selected)?.name??selected.hostId;$('agent-badge').textContent=agentLabel(selected).toUpperCase();$('session-title').textContent=selected.title;$('session-project').textContent=`项目：${selected.projectName??'未归属项目'}${selected.projectSource==='codex'?' · Codex Project':''}`;$('session-folder').textContent=selected.cwd;$('session-status').textContent=(statusNames[selected.status]??selected.status)+(selected.questionCount?' · 待回答':'')+(online?'':' · 电脑离线');
  const busy=['running','waiting'].includes(selected.status);$('stop').hidden=!selected.pendingCount;$('stop').textContent='取消排队';$('stop').disabled=!online||stopping.has(selected.id);
  composerFiles.render();const hasInput=!!$('prompt').value.trim()||!!composerFiles.count,active=busy&&online;
  $('prompt').disabled=false;$('send-button').hidden=!hasInput;$('send-button').disabled=!hasInput||!online||sending.has(selected.id)||stopping.has(selected.id);
  $('run-indicator').hidden=!active;
  $('stop-task').hidden=hasInput||!active;$('stop-task').disabled=stopping.has(selected.id);$('stop-task').setAttribute('aria-busy',String(stopping.has(selected.id)));
  $('stop-task').title=stopping.has(selected.id)?'正在停止…':selected.canStop===false?(selected.provider==='claude'&&!selected.managed?'请在电脑上按 Esc 停止此 Claude 窗口':'本地停止通道尚未就绪，点击重试'):'停止当前任务，同时取消排队消息；保留会话记录';$('run-indicator').setAttribute('aria-label',selected.status==='waiting'?'等待你确认':'任务正在执行');$('run-indicator').title=selected.status==='waiting'?'等待你确认':'任务正在执行';
  $('model-select').disabled=!online||settingChanges.has(selected.id);$('effort-select').disabled=!online||settingChanges.has(selected.id);
  const presentation=settingsPresentation(selected,modelLists.get(selected.hostId+':'+selected.provider+':'+(selected.agentId??''))??[],!selected.settingsSource&&!selected.settingsError&&online);
  const permission=selected.nextPermissionMode??selected.permissionMode??'';
  $('permission-preview').textContent=presentation.permission;$('permission-toggle').dataset.mode=permission;
  $('permission-toggle').disabled=permissionChanges.has(selected.id);
  $('permission-toggle').title=presentation.permissionPending||selected.settingsError||(selected.canSetPermissions===false?'此原生 Claude 窗口需在电脑上修改权限':'选择当前会话权限');
  for(const option of document.querySelectorAll('[data-permission]')){option.setAttribute('aria-pressed',String(option.dataset.permission===permission));option.disabled=!online||!hostOf(selected)?.capabilities?.permissions||selected.canSetPermissions===false||permissionChanges.has(selected.id);}
  $('permission-note').textContent=!hostOf(selected)?.capabilities?.permissions?'此电脑的连接程序需要更新后才能选择权限':selected.canSetPermissions===false?'独立 Claude 窗口的权限需在电脑上修改；网页启动的 Claude 支持切换':selected.nextPermissionMode?'已预设下一轮权限，当前任务保持原权限':'仅应用于当前会话；Agent 强制要求的确认仍会显示';
  const targetModel=selected.nextModel??selected.model;if(targetModel&&[...$('model-select').options].some(o=>o.value===targetModel))$('model-select').value=targetModel;
  const targetEffort=selected.nextEffort??selected.effort??'default';if([...$('effort-select').options].some(o=>o.value===targetEffort))$('effort-select').value=targetEffort;
  const settingsModels=modelLists.get(selected.hostId+':'+selected.provider+':'+(selected.agentId??''))??[];
  if(settingsModels.length)effortOptions($('effort-select'),settingsModels,targetModel,targetEffort);
  renderSettingsChoices(settingsModels);
  $('pending-settings').textContent=presentation.pending;
  $('settings-preview').textContent=presentation.model;
  $('settings-toggle').title=[presentation.model,presentation.pending,selected.settingsError,selected.settingsSource==='transcript'?'最近一次任务的设置':null].filter(Boolean).join('\n');
  const pending=selected.pendingCount?` · ${selected.pendingCount} 条排队中`:'';
  const note=!online?'电脑离线，可先编辑草稿':selected.canSteer?((selected.provider==='codex'?'排队消息可逐条引导：送入 Codex 当前任务':selected.managed?'排队消息可逐条引导：中止本轮并沿同一会话继续':'排队消息可逐条引导：直接送入本地 Claude')+(selected.provider==='claude'?'；/btw 单独旁问':'')+pending):busy||selected.pendingCount?((selected.provider==='codex'?'普通消息排队到下一轮；引导通道可用后可逐条引导':selected.managed?'普通消息排队到下一轮；/btw 单独旁问':'原生会话仍由本地应用控制；消息排队等原会话关闭，/btw 可旁问')+pending):'在本地电脑中执行 · 输入 / 查看命令';
  $('settings-input-note').textContent=note;$('composer-note').title=note;$('composer-note').dataset.attention=String(!online||busy||!!selected.pendingCount);
  $('composer-note').textContent=!online?'电脑离线 · 可编辑草稿':selected.canSteer?'发送后可在该条消息上点「引导」'+pending:busy?(selected.managed?'运行中 · 消息排队到下一轮'+pending:(selected.provider==='codex'?'本地 Codex 运行中 · 消息先排队':'本地会话运行中 · 消息先排队')+pending):selected.pendingCount?'任务已结束 · 正在投递排队消息'+pending:'输入 / 查看命令';
  renderActivity();
  if($('session-settings').open)positionComposerDialog($('session-settings'),$('settings-toggle'));
}
function renderActivity(){
  const root=$('agent-activity'),busy=selected&&['running','waiting'].includes(selected.status);root.hidden=!busy;if(!busy)return;
  const activity=selected.activity,label=!hostOf(selected)?.online?'电脑离线':selected.status==='waiting'?'等待你确认':activity?.label||'正在执行';
  const detail=!hostOf(selected)?.online?'显示最后同步的步骤':activity?.detail||'';
  if($('activity-label').textContent!==label)$('activity-label').textContent=label;
  if($('activity-detail').textContent!==detail)$('activity-detail').textContent=detail;
  root.title=[label,detail].filter(Boolean).join(' · ');root.dataset.kind=activity?.kind||'working';
}
function resizeComposer(){
  const prompt=$('prompt');if($('conversation').hidden)return;
  const timeline=$('timeline'),atBottom=timeline.scrollHeight-timeline.scrollTop-timeline.clientHeight<100;
  prompt.style.height='0px';const limit=Math.max(64,Math.min(160,(window.visualViewport?.height??window.innerHeight)*.22));
  prompt.style.height=Math.max(44,Math.min(prompt.scrollHeight,limit))+'px';prompt.style.overflowY=prompt.scrollHeight>limit?'auto':'hidden';
  if(atBottom)timeline.scrollTop=timeline.scrollHeight;
}
let lastViewportHeight=0;
function fitViewport(){
  const viewport=window.visualViewport;
  const height=viewport&&viewport.scale===1&&viewport.height>180?viewport.height:window.innerHeight;
  const top=viewport&&viewport.scale===1?viewport.offsetTop:0;
  document.documentElement.style.setProperty('--viewport-height',height+'px');
  document.documentElement.style.setProperty('--viewport-top',top+'px');
  if(height!==lastViewportHeight){lastViewportHeight=height;resizeComposer();}
}
async function refresh(){const previous=JSON.stringify(state.hosts.map(h=>[h.id,h.agents]));state=await api('state');const agentsChanged=previous!==JSON.stringify(state.hosts.map(h=>[h.id,h.agents]));if(agentsChanged){modelCache.clear();modelLists.clear();}if(selected){const updated=state.sessions.find(s=>s.id===selected.id);if(updated)selected=updated;}renderFilters();renderList();renderHosts();renderHead();if(selected){questionPanel.render();renderMessages(true);if(agentsChanged)void sessionModels(selected);}}
function readingAnchor(){
  const top=$('timeline').getBoundingClientRect().top;
  const message=[...$('timeline').querySelectorAll('[data-message-id]')].find(e=>e.getBoundingClientRect().bottom>top+1);
  return message?{id:message.dataset.messageId,offset:message.getBoundingClientRect().top-top}:null;
}
function restoreReadingAnchor(anchor){
  if(!anchor)return false;
  const message=[...$('timeline').querySelectorAll('[data-message-id]')].find(e=>e.dataset.messageId===anchor.id);
  if(!message)return false;
  $('timeline').scrollTop+=message.getBoundingClientRect().top-$('timeline').getBoundingClientRect().top-anchor.offset;return true;
}
function readingSelection(){const selection=window.getSelection();return selection&&!selection.isCollapsed&&$('timeline').contains(selection.anchorNode);}
function rememberReadingPosition(){const t=$('timeline');retainedReadingAnchor=t.scrollHeight-t.scrollTop-t.clientHeight>40||readingSelection()?readingAnchor():null;}
function renderMessages(keepPosition=false){
  if(document.activeElement?.closest('.question-card')||readingSelection())keepPosition=true;
  const timeline=$('timeline'),nearBottom=timeline.scrollHeight-timeline.scrollTop-timeline.clientHeight<40;
  const anchor=keepPosition||!nearBottom?readingAnchor():null,rows=[],live=new Set(),groups=new Set(),groupCards=new Set(),approvalIds=new Set(),sequence=timelineWithQuestions([...messages.values()].map(m=>displayMessage(m,selected?.provider)),questionPanel.cards.values()),placedQuestions=new Set();let group=null,changed=false;
  const text=(element,value)=>{if(element.textContent!==value){element.textContent=value;changed=true;}};
  for(const [index,m] of sequence.entries()){
    if(m.role==='question'){
      if(group){text(group.summary,`工具调用与结果 · ${group.items.length} 项`);changed=reconcileChildren(group.details,[group.summary,...group.items])||changed;changed=reconcileChildren(group.card,[group.details,...group.galleries])||changed;group=null;}
      const element=questionPanel.rendered.get(m.question.id)?.element;if(element){rows.push(element);placedQuestions.add(m.question.id);}continue;
    }
    live.add(m.id);let entry=renderedMessages.get(m.id);
    if(!entry||entry.role!==m.role){
      if(m.role==='tool'){
        const details=node('details','tool-call'),summary=node('summary'),pre=node('pre','tool-details');details.dataset.messageId=m.id;details.open=expandedTools.has(m.id);details.ontoggle=()=>{if(details.open)expandedTools.add(m.id);else expandedTools.delete(m.id);};details.append(summary,pre);entry={role:m.role,card:details,label:summary,body:pre};
      }else{const card=node('article','message '+m.role),label=node('div','message-label'),body=node('div');card.dataset.messageId=m.id;card.append(label,body);entry={role:m.role,card,label,body};}
      renderedMessages.set(m.id,entry);changed=true;
    }
    text(entry.label,m.label||(m.role==='user'?'你':m.role==='assistant'?(agentLabel(selected).toUpperCase()):m.role==='tool'?'工具调用':'运行提示'));
    const bodyVersion=JSON.stringify([m.text,!!m.images?.length]);
    if(entry.bodyVersion!==bodyVersion){if(m.role==='tool')text(entry.body,m.text);else{const body=messageBody(m);entry.body.replaceWith(body);entry.body=body;changed=true;}entry.bodyVersion=bodyVersion;}
    const imagesVersion=JSON.stringify(m.images??[]),filesVersion=JSON.stringify(m.files??[]);
    if(entry.imagesVersion!==imagesVersion){entry.images?.remove();entry.images=m.images?.length?imageGallery(m):null;entry.imagesVersion=imagesVersion;changed=true;}
    if(entry.filesVersion!==filesVersion){entry.files?.remove();entry.files=m.files?.length?fileGallery(m):null;entry.filesVersion=filesVersion;changed=true;}
    if(m.role==='tool'){
      if(!group){const key='group:'+m.id;groups.add(key);let cached=renderedGroups.get(key);
        if(!cached){for(let i=index;i<sequence.length&&sequence[i].role==='tool';i++){const oldParent=renderedMessages.get(sequence[i].id)?.card.parentElement;cached=[...renderedGroups.values()].find(g=>g.details===oldParent&&!groupCards.has(g.card));if(cached)break;}if(cached)renderedGroups.set(key,cached);}
        if(!cached){const card=node('article','message tool'),details=node('details','tool-group'),summary=node('summary');card.dataset.messageId=m.id;details.open=expandedTools.has(key);details.ontoggle=()=>{if(details.open)expandedTools.add(key);else expandedTools.delete(key);};details.append(summary);card.append(details);cached={card,details,summary};renderedGroups.set(key,cached);changed=true;}
        groupCards.add(cached.card);group={...cached,items:[],galleries:[]};rows.push(group.card);
      }
      group.items.push(entry.card);if(entry.images)group.galleries.push(entry.images);if(entry.files)group.galleries.push(entry.files);
      // Finalize after collecting all adjacent tools, avoiding transient removals.
      continue;
    }
    if(group){text(group.summary,`工具调用与结果 · ${group.items.length} 项`);changed=reconcileChildren(group.details,[group.summary,...group.items])||changed;changed=reconcileChildren(group.card,[group.details,...group.galleries])||changed;group=null;}
    const queued=m.role==='user'&&selected?.pendingIds?.includes(m.id)&&m.label==='你 · 已排队';
    const controlsVersion=JSON.stringify([!!queued,!!hostOf(selected)?.online,!!selected.canSteer,sending.has(selected.id),m.text.trimStart().startsWith('/')]);
    if(entry.controlsVersion!==controlsVersion){
      entry.controls?.remove();entry.controls=null;
      if(queued){const controls=node('div','queued-actions'),cancel=node('button','cancel-input','取消排队');cancel.type='button';cancel.disabled=!hostOf(selected)?.online||sending.has(selected.id);cancel.onclick=()=>void queuedAction('cancel-input',m.id);controls.append(cancel);
        const steer=node('button','steer','引导');steer.type='button';steer.disabled=cancel.disabled||!selected.canSteer||m.text.trimStart().startsWith('/');steer.title=!selected.canSteer?'本地引导通道暂不可用；消息保留在队列中':m.text.trimStart().startsWith('/')?'命令不支持引导':selected.provider==='codex'?'把这条消息送入 Codex 当前任务，其他消息继续排队':selected.managed?'中止本轮，按这条消息沿同一会话继续':'立即把这条消息送入本地 Claude；当前操作可让出时处理';steer.onclick=()=>void queuedAction('steer',m.id);controls.append(steer);entry.controls=controls;}
      entry.controlsVersion=controlsVersion;
    }
    changed=reconcileChildren(entry.card,[entry.label,entry.body,entry.images,entry.files,entry.controls].filter(Boolean))||changed;rows.push(entry.card);
  }
  if(group){text(group.summary,`工具调用与结果 · ${group.items.length} 项`);changed=reconcileChildren(group.details,[group.summary,...group.items])||changed;changed=reconcileChildren(group.card,[group.details,...group.galleries])||changed;}
  for(const [id,a] of approvals){
    approvalIds.add(id);const version=JSON.stringify([a,a.expiresAt<Date.now()]);let entry=renderedApprovals.get(id);
    if(!entry||entry.version!==version){const card=node('article','approval');card.dataset.messageId='approval:'+id;card.append(node('h3','',`需要确认 · ${{'item/commandExecution/requestApproval':'命令执行','item/fileChange/requestApproval':'文件修改'}[a.label]??a.label}`),node('pre','',a.details));
      if(a.resolved||a.expiresAt<Date.now())card.append(node('p','fine',a.resolved?(a.unconfirmed?'投递未确认，请查看本机':a.allow?(a.remember?'已允许，本会话不再询问此范围':'已允许'):'已拒绝'):'请求已过期'));
      else{const buttons=node('div','approval-actions'),sessionId=selected.id;const choices=[['允许这一次',true,'once'],...(a.rememberLabel?[[a.rememberLabel,true,'session']]:[]),['拒绝',false,'once']];for(const [label,allow,approvalScope] of choices){const b=node('button','',label);b.type='button';b.onclick=async()=>{for(const button of buttons.children)button.disabled=true;try{await action({type:'approve',sessionId,approvalId:id,allow,...a.rememberLabel?{approvalScope}:{}});}catch(err){toast(err.message);for(const button of buttons.children)button.disabled=false;}};buttons.append(b);}card.append(buttons);if(a.rememberDescription)card.append(node('p','fine',a.rememberDescription));}
      entry={version,card};renderedApprovals.set(id,entry);changed=true;
    }rows.push(entry.card);
  }
  for(const [id,entry] of questionPanel.rendered)if(!placedQuestions.has(id)&&entry.element.isConnected){entry.element.remove();changed=true;}
  changed=reconcileChildren($('messages'),rows)||changed;lastMessagesChanged=changed;
  for(const id of renderedMessages.keys())if(!live.has(id))renderedMessages.delete(id);
  for(const id of renderedGroups.keys())if(!groups.has(id))renderedGroups.delete(id);
  for(const id of renderedApprovals.keys())if(!approvalIds.has(id))renderedApprovals.delete(id);
  directAssets.sweep();renderActivity();
  if(!changed)return false;
  if(!keepPosition&&nearBottom){timeline.scrollTop=timeline.scrollHeight;rememberReadingPosition();return false;}
  const restored=restoreReadingAnchor(anchor);rememberReadingPosition();return restored;
}
function applyEvent(event,draw=true,replay=false){
  if(event.sessionId!==selected?.id||seen.has(event.id))return;seen.add(event.id);const d=event.data;
  const wasNearBottom=$('timeline').scrollHeight-$('timeline').scrollTop-$('timeline').clientHeight<40;
  if(event.type==='message'){questionPanel.replaceAnchors(d.replaces??[],d.id);for(const id of d.replaces??[])messages.delete(id);const old=messages.get(d.id);messages.set(d.id,{...old,...d,timestamp:d.timestamp??old?.timestamp??event.at,images:replay&&canonicalMessages.has(d.id)?old?.images:d.images??old?.images});}
  if(event.type==='delta'){const old=messages.get(d.messageId);messages.set(d.messageId,{id:d.messageId,role:'assistant',text:(old?.text??'')+d.text,timestamp:old?.timestamp??event.at});}
  if(event.type==='error')messages.set(event.id,{id:event.id,role:'system',text:d.message,timestamp:event.at});
  if(event.type==='status'&&acceptsStatusEvent(selected,event,replay)){selected.status=d.status;selected.activity=d.activity??undefined;renderHead();}
  if(event.type==='activity'){selected.activity=d;renderActivity();}
  if(event.type==='approval')approvals.set(d.approvalId,d);
  if(event.type==='approval.resolved'){const a=approvals.get(d.approvalId);if(a)approvals.set(d.approvalId,{...a,resolved:true,allow:d.allow,remember:d.remember,unconfirmed:d.unconfirmed});}
  if(event.type==='question'||event.type==='question.resolved')questionPanel.event(d,!replay&&event.type==='question');
  if(draw){questionPanel.render();if(['message','delta','error','approval','approval.resolved'].includes(event.type))renderMessages();if(!replay&&event.type==='question'&&wasNearBottom)$('timeline').scrollTop=$('timeline').scrollHeight;}
}
async function history(older=false,silent=false){
  const current=selected;if(!current)return;const request=historyPager.begin(older);if(!request)return;
  if(older){olderError='';renderHistoryLoader();}
  if(!silent&&!older){$('history-note').textContent='正在读取会话…';$('history-note').dataset.state='loading';}
  try{
    const page=await api(`history?sessionId=${encodeURIComponent(current.id)}${older?`&cursor=${request.cursor}`:''}`);
    if(!historyPager.current(request)||selected?.id!==current.id)return;
    const beforeHeight=$('timeline').scrollHeight;const beforeTop=$('timeline').scrollTop;const nearBottom=beforeHeight-beforeTop-$('timeline').clientHeight<40;
    const firstPage=!historyPager.initialized;
    for(const message of page.messages)canonicalMessages.add(message.id);
    if(!historyPager.complete(request,page.cursor))return;
    const combined=older||firstPage?new Map(page.messages.map(m=>[m.id,m])):new Map(messages);
    if(older||firstPage){for(const [id,m] of messages){const old=combined.get(id);if(!old||m.text.length>old.text.length)combined.set(id,{...old,...m,images:m.images??old?.images});}}
    else for(const m of page.messages){const old=combined.get(m.id);if(!old||m.text.length>=old.text.length)combined.set(m.id,{...old,...m,images:m.images??old?.images});else if(m.images!==undefined)combined.set(m.id,{...old,images:m.images});}
    messages=combined;
    if(page.session?.id===selected.id)selected=page.session;
    for(const event of page.events??[])applyEvent(event,false,true);
    if(!page.cached&&Array.isArray(page.questions))questionPanel.reconcile(page.questions,page.questionsAsOf);questionPanel.render();
    renderHead();
    $('history-note').textContent=page.cached?'电脑离线或未响应 · 显示之前缓存的历史':`${page.source} · 内容在本机读取`;$('history-note').dataset.state=page.cached?'cached':'ready';
    const restored=renderMessages(older||!firstPage);if(older&&!restored&&lastMessagesChanged)$('timeline').scrollTop=beforeTop+$('timeline').scrollHeight-beforeHeight;else if(!older&&(firstPage||lastMessagesChanged&&nearBottom))$('timeline').scrollTop=$('timeline').scrollHeight;
  }catch(err){if(selected?.id===request.sessionId&&historyPager.generation===request.generation){if(older)olderError=err.message;else{$('history-note').textContent=err.message;$('history-note').dataset.state='error';}}}
  finally{historyPager.release(request);if(selected?.id===request.sessionId&&historyPager.generation===request.generation){renderHistoryLoader();rememberReadingPosition();requestAnimationFrame(()=>{if(olderRequested||older&&!olderError||$('timeline').scrollHeight<=$('timeline').clientHeight+80)maybeLoadOlder();});}}
}
function renderHistoryLoader(){const hint=$('older');hint.hidden=!historyPager.initialized;hint.dataset.state=historyPager.active?.older?'loading':olderError?'error':historyPager.cursor===null?'end':'ready';hint.textContent=hint.dataset.state==='loading'?'正在加载更早消息…':olderError?'加载失败，继续下拉重试':historyPager.cursor===null?'已到最早消息':'下拉查看更早消息';hint.title=olderError;}
function maybeLoadOlder(retry=false){
  if(!selected||!historyPager.initialized||historyPager.cursor===null||$('timeline').scrollTop>120){olderRequested=false;return;}
  if(olderError){if(!retry)return;olderError='';}
  olderRequested=true;if(historyPager.active)return;
  olderRequested=false;void history(true,true);
}
async function select(s){if(selected)drafts.set(selected.id,$('prompt').value);selected=s;questionPanel.reset();canonicalMessages.clear();renderedMessages.clear();renderedGroups.clear();renderedApprovals.clear();$('messages').replaceChildren();historyPager.reset(s.id);olderError='';olderRequested=false;retainedReadingAnchor=null;renderHistoryLoader();$('session-title').setAttribute('aria-expanded','false');$('session-title').setAttribute('aria-label','展开完整会话标题');$('prompt').value=drafts.get(s.id)??'';hideCommands();messages=new Map();markdownCache.clear();seen=new Set();approvals=new Map();$('welcome').hidden=true;$('conversation').hidden=false;drawer.close();renderList();renderHead();renderMessages();resizeComposer();void sessionModels(s);void sessionCommands(s);await history();}
function hideCommands(){$('command-menu').hidden=true;$('prompt').setAttribute('aria-expanded','false');$('prompt').removeAttribute('aria-activedescendant');}
async function sessionCommands(s){const n=++commandsLoading;commandOptions=[{name:'help',description:'查看可用命令'},{name:'usage',description:'查询账号额度与重置时间，不打断任务'},{name:'stop',description:'停止任务或取消排队'},{name:'model',description:'选择下一轮模型',argumentHint:'<模型 ID>'},{name:'effort',description:'选择思考强度',argumentHint:'<强度>'},...(s.provider==='claude'?[{name:'btw',description:'不打断主任务的旁问',argumentHint:'<问题>'}]:[])];renderCommands();try{const result=await api('commands?sessionId='+encodeURIComponent(s.id));if(n!==commandsLoading||selected?.id!==s.id)return;commandOptions=result.commands;renderCommands();}catch{/* Built-in relay completions remain available if discovery is offline. */}}
function renderCommands(){
  const text=$('prompt').value;if(!/^\/[^\s]*$/.test(text)||!selected){hideCommands();return;}const prefix=text.slice(1).toLowerCase();commandCandidates=commandOptions.filter(c=>c.name.toLowerCase().startsWith(prefix)).slice(0,12);if(!commandCandidates.length){hideCommands();return;}commandIndex=Math.min(commandIndex,commandCandidates.length-1);
  $('command-menu').replaceChildren(...commandCandidates.map((c,i)=>{const b=node('button','command-option'+(i===commandIndex?' active':''));b.type='button';b.id='command-option-'+i;b.setAttribute('role','option');b.setAttribute('aria-selected',String(i===commandIndex));b.append(node('strong','',`/${c.name} ${c.argumentHint??''}`),node('span','',c.description));b.onclick=()=>completeCommand(i);return b;}));$('command-menu').hidden=false;$('prompt').setAttribute('aria-expanded','true');$('prompt').setAttribute('aria-activedescendant','command-option-'+commandIndex);
}
function completeCommand(i){const c=commandCandidates[i];if(!c)return;$('prompt').value='/'+c.name+' ';drafts.set(selected.id,$('prompt').value);hideCommands();resizeComposer();renderHead();$('prompt').focus();}
function stream(){
  events?.close();events=new EventSource('/api/events');events.onopen=()=>renderHosts();events.onerror=()=>renderHosts();
  events.addEventListener('state',()=>{clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>void refresh().catch(e=>toast(e.message)),150);});
  events.addEventListener('reset',()=>{void refresh();if(selected)void history();});
  events.addEventListener('event',e=>{const event=JSON.parse(e.data);applyEvent(event);if(event.type==='status')void refresh().catch(()=>{});});
}
async function action(value){return api('actions',{id:crypto.randomUUID(),...value});}
async function queuedAction(type,queuedId){const s=selected;if(!s||sending.has(s.id))return;sending.add(s.id);renderHead();renderMessages(true);try{const result=await action({type,sessionId:s.id,queuedId});if(selected?.id===s.id){const message=messages.get(queuedId);if(message)messages.set(queuedId,{...message,label:type==='steer'?(result.mode==='active-turn'?'你 · 引导已接收':result.mode==='native'?'你 · 引导已送入本机':'你 · 引导'):'你 · 排队已取消'});}if(type==='steer')toast(result.mode==='active-turn'?'这条消息已送入 Codex 当前任务；其他消息继续排队':result.mode==='native'?'这条消息已送入本地 Claude；其他消息继续排队':'已中止本轮，按这条消息继续；其他消息继续排队');else toast('已取消这条消息的排队');await refresh();}catch(err){toast(err.message);await refresh().catch(()=>{});}finally{sending.delete(s.id);renderHead();renderMessages(true);}}
function workspaces(){const host=state.hosts.find(h=>h.id===$('host-select').value),project=host?.projects.find(p=>p.id===$('project-select').value);$('workspace-select').replaceChildren(...(project?.roots??(project?[project.path]:[])).map((root,i)=>new Option(root,String(i))));}
function projects(){const host=state.hosts.find(h=>h.id===$('host-select').value);$('project-select').replaceChildren(...(host?.projects??[]).map(p=>new Option(`${p.source==='codex'?'Codex · ':''}${p.name}`,p.id)));$('create-submit').disabled=!host?.online||!host?.projects.length;$('new-project-button').disabled=!host?.online||!host?.capabilities?.createProject;$('new-project-button').title=host?.capabilities?.createProject?'在选定的工作电脑上创建或使用文件夹':'此电脑的连接程序需要更新后才能新建工程';$('create-permission').disabled=!host?.capabilities?.permissions;if(!host?.capabilities?.permissions)$('create-permission').value='request';updateCreatePermissionNote();$('new-project-path').placeholder=host?.platform?.startsWith('win')?'例如：E:\\Projects\\MyGame':'例如：/Users/you/Projects/MyGame';$('new-project-panel').hidden=true;const previous=$('provider-select').value;$('provider-select').replaceChildren(...hostAgents(host).map(a=>{const o=new Option(a.name+(a.configured===false?'（未配置）':''),a.provider==='api'?'api:'+a.id:a.provider);o.disabled=a.configured===false;return o;}));if([...$('provider-select').options].some(o=>o.value===previous&&!o.disabled))$('provider-select').value=previous;$('create-submit').disabled=$('create-submit').disabled||![...$('provider-select').options].some(o=>!o.disabled);workspaces();void createModels();}
async function models(hostId,provider,agentId){const key=hostId+':'+provider+':'+(agentId??'');if(!modelCache.has(key))modelCache.set(key,api(`models?hostId=${encodeURIComponent(hostId)}&provider=${provider}${agentId?`&agentId=${encodeURIComponent(agentId)}`:''}`).catch(err=>{modelCache.delete(key);throw err;}));const list=(await modelCache.get(key)).models;modelLists.set(key,list);return list;}
function modelOptions(element,list,current){element.replaceChildren(new Option('沿用本机默认模型',''),...list.map(m=>new Option(m.name+(m.isDefault?'（默认）':''),m.id)));if(current&&!list.some(m=>m.id===current))element.add(new Option(`当前：${current}`,current));element.value=current??'';}
function effortOptions(element,list,model,current){const m=findModel(list,model)??(!model?list.find(m=>m.isDefault)??list[0]:null);element.replaceChildren(new Option('本机默认','default'),...(m?.efforts??[]).map(v=>new Option(effortNames[v]??v,v)));if(current&&![...element.options].some(o=>o.value===current))element.add(new Option(`当前：${effortNames[current]??current}`,current));element.value=current??'default';}
const settingChoiceKeys=new WeakMap();
function renderSettingsChoices(list){
  const model=$('model-select'),effort=$('effort-select'),current=findModel(list,model.value);
  $('model-picker-label').textContent=modelName(list,model.value)||'正在读取…';
  const descriptions={none:'不进行额外推理',minimal:'尽量缩短推理时间',low:'响应更快，适合简单任务',medium:'兼顾推理深度与响应速度',high:'更深入地分析和验证',xhigh:'投入更多时间处理复杂问题',max:'使用模型支持的最高推理强度',ultra:'投入更充分的推理时间'};
  function choices(root,select,options){
    const signature=JSON.stringify([select.value,select.disabled,options]);if(settingChoiceKeys.get(root)===signature)return;settingChoiceKeys.set(root,signature);
    root.replaceChildren(...options.map(({value,label,description})=>{
      const button=node('button','permission-option setting-option');button.type='button';button.disabled=select.disabled;button.setAttribute('aria-pressed',String(value===select.value));button.append(node('strong','',label));if(description)button.append(node('span','',description));
      button.onclick=async()=>{const s=selected;if(!s||settingChanges.has(s.id))return;if(select.value===value)return;select.value=value;settingChanges.add(s.id);renderHead();
        // Keep the chosen value through renderHead, which reflects server state.
        select.value=value;try{await select.onchange();if(select===model)$('model-picker').open=false;}finally{settingChanges.delete(s.id);renderHead();}
      };return button;
    }));
  }
  choices($('model-options'),model,[...model.options].filter(o=>o.value).map(o=>{const m=findModel(list,o.value);return {value:o.value,label:modelName(list,o.value)||o.textContent.replace(/^当前：|（默认）/g,''),description:m?.description};}));
  const options=[...effort.options].filter(o=>o.value!=='default').map(o=>({value:o.value,label:effortNames[o.value]||o.textContent,description:descriptions[o.value]}));
  if(list.length)options.push({value:'default',label:current?.defaultEffort?`推荐 · ${effortNames[current.defaultEffort]??current.defaultEffort}`:'使用模型推荐强度',description:'跟随当前模型的推荐设置'});
  choices($('effort-options'),effort,options);
}
async function sessionModels(s){const n=++modelLoading;modelOptions($('model-select'),[],s.nextModel??s.model);$('model-hint').textContent='正在读取本机模型列表…';try{const list=await models(s.hostId,s.provider,s.agentId);if(selected?.id!==s.id||n!==modelLoading)return;modelOptions($('model-select'),list,selected.nextModel??selected.model);effortOptions($('effort-select'),list,selected.nextModel??selected.model,selected.nextEffort??selected.effort);$('model-hint').textContent='运行中也可预设，下一轮生效';renderHead();}catch(err){if(selected?.id===s.id)$('model-hint').textContent=err.message;}}
async function createModels(){const n=++createModelLoading,host=$('host-select').value,choice=agentChoice($('provider-select').value);modelOptions($('create-model'),[]);effortOptions($('create-effort'),[]);if(!host)return;if(!choice.provider){$('create-error').textContent='请在本机桌面窗口启用并配置 Agent';return;}try{const list=await models(host,choice.provider,choice.agentId);if(n===createModelLoading){modelOptions($('create-model'),list);effortOptions($('create-effort'),list);}}catch(err){if(n===createModelLoading)$('create-error').textContent=err.message;}}
function openCreate(){
  $('create-error').textContent='';$('new-project-error').textContent='';$('new-project-panel').hidden=true;$('create-permission').value='request';updateCreatePermissionNote();$('host-select').replaceChildren(...state.hosts.map(h=>new Option(h.name+(h.online?'':'（离线）'),h.id)));const online=state.hosts.find(h=>h.online&&h.id===selected?.hostId)??state.hosts.find(h=>h.online&&h.capabilities?.createProject)??state.hosts.find(h=>h.online);if(online)$('host-select').value=online.id;projects();createFiles.render();$('create-dialog').showModal();$('create-dialog').scrollTop=0;$('host-select').focus({preventScroll:true});
}
const drawer=setupDrawer($('sidebar'),$('drawer-backdrop'),$('drawer-edge'),$('open-sidebar'),$('close-sidebar'));
setupSidebarResize($('workspace'),$('sidebar'),$('sidebar-resize'));
const composerContext=()=>selected?{key:selected.id,target:{hostId:selected.hostId,sessionId:selected.id}}:null;
const createContext=()=>({key:'create:'+ $('host-select').value+':'+$('project-select').value,target:{hostId:$('host-select').value,projectId:$('project-select').value}});
const composerFiles=new AttachmentInput(document.querySelector('.composer-wrap'),$('attach-button'),$('attachment-preview'),composerContext,message=>{if(message)toast(message);renderHead();});
const createFiles=new AttachmentInput($('create-form'),$('create-attach-button'),$('create-attachment-preview'),createContext,message=>{if(message)$('create-error').textContent=message;});
$('login-form').onsubmit=async e=>{e.preventDefault();$('login-error').textContent='';try{await api('login',{token:$('token').value});$('token').value='';await start();}catch(err){$('login-error').textContent=err.message;}};
$('logout').onclick=async()=>{try{await api('logout',{});}finally{await directAssets.reset();questionPanel.reset(true);composerFiles.reset();createFiles.reset();state={hosts:[],sessions:[]};selected=null;messages.clear();approvals.clear();$('messages').replaceChildren();$('session-list').replaceChildren();$('conversation').hidden=true;$('welcome').hidden=false;loggedOut();}};
$('new-session').onclick=openCreate;$('welcome-new').onclick=openCreate;$('cancel-create').onclick=()=>$('create-dialog').close();$('host-select').onchange=()=>{projects();createFiles.render();};
$('create-form').onsubmit=async e=>{e.preventDefault();if(!$('initial-prompt').value.trim()&&!createFiles.count){$('create-error').textContent='请输入任务或添加附件';return;}const context=createContext();$('create-submit').disabled=true;$('create-error').textContent='';try{const attachmentIds=await createFiles.upload(context);const result=await action({attachmentIds,type:'start',hostId:$('host-select').value,projectId:$('project-select').value,workspaceIndex:Number($('workspace-select').value),...agentChoice($('provider-select').value),model:$('create-model').value||undefined,effort:$('create-effort').value,...state.hosts.find(h=>h.id===$('host-select').value)?.capabilities?.permissions?{permissionMode:$('create-permission').value}:{}, text:$('initial-prompt').value});createFiles.clear(context.key);await refresh();$('create-dialog').close();$('initial-prompt').value='';const s=state.sessions.find(s=>s.id===result.sessionId);if(s)await select(s);}catch(err){$('create-error').textContent=err.message;}finally{$('create-submit').disabled=false;}};
$('composer').onsubmit=async e=>{e.preventDefault();const text=$('prompt').value,s=selected,context=composerContext();if(!s||(!text.trim()&&!composerFiles.count)||sending.has(s.id))return;sending.add(s.id);hideCommands();renderHead();try{const attachmentIds=await composerFiles.upload(context);const result=await action({type:'send',sessionId:s.id,text,attachmentIds});composerFiles.clear(context.key);if(selected?.id===s.id&&$('prompt').value===text)$('prompt').value='';drafts.set(s.id,selected?.id===s.id?$('prompt').value:'');if(result.queued)toast('消息已排队，可在该条消息上操作');else if(result.sideQuestion)toast('旁问已发出，主任务继续执行');await refresh();}catch(err){toast(err.message);}finally{sending.delete(s.id);renderHead();resizeComposer();}};
$('prompt').oninput=()=>{if(selected)drafts.set(selected.id,$('prompt').value);commandIndex=0;resizeComposer();renderCommands();renderHead();};
$('messages').addEventListener('click',async event=>{
  const button=event.target.closest('.code-copy');if(!button)return;
  const code=button.closest('.code-block')?.querySelector('code');if(!code)return;
  try{await navigator.clipboard.writeText(code.textContent);button.textContent='已复制';setTimeout(()=>{if(button.isConnected)button.textContent='复制';},1500);}
  catch{toast('复制失败，请长按代码选择');}
});
setupComposerKeys($('prompt'),{
  open:()=>!$('command-menu').hidden,
  current:()=>commandCandidates[commandIndex],
  move:delta=>{commandIndex=(commandIndex+delta+commandCandidates.length)%commandCandidates.length;renderCommands();},
  complete:()=>completeCommand(commandIndex),hide:hideCommands
},()=>{if(!$('send-button').disabled)$('composer').requestSubmit();});
async function stopTask(queueOnly=false){
  if(!selected||stopping.has(selected.id))return;
  if(!queueOnly&&!selected.managed&&selected.canStop===undefined){toast('此电脑的连接程序尚未支持停止原生任务，请更新连接程序或在电脑上停止');return;}
  const sessionId=selected.id,legacy=selected.canStop===undefined,pendingIds=[...(selected.pendingIds??[])];stopping.add(sessionId);renderHead();
  try{
    // Older bridges ignore unknown action fields. Never send queueOnly to one
    // that could interpret it as a full stop of a running managed task.
    if(queueOnly&&legacy){if(!pendingIds.length)throw new Error('排队信息尚未同步，请刷新后重试');for(const queuedId of pendingIds)await action({type:'cancel-input',sessionId,queuedId});}
    else await action({type:'stop',sessionId,queueOnly});
    toast(queueOnly?'已取消排队消息':'已请求停止当前任务');await refresh();}
  catch(err){toast(err.message);}
  finally{stopping.delete(sessionId);renderHead();}
}
$('stop').onclick=()=>void stopTask(true);
$('stop-task').onclick=()=>void stopTask();
$('refresh').onclick=async()=>{try{await refresh();if(selected)await history();}catch(err){toast(err.message);}};
let lastHistoryTop=0,historyTouchY,userScrollUntil=0;
$('timeline').addEventListener('scroll',()=>{const top=$('timeline').scrollTop;if(top<lastHistoryTop&&performance.now()<userScrollUntil)maybeLoadOlder(true);lastHistoryTop=top;rememberReadingPosition();},{passive:true});
$('timeline').addEventListener('wheel',e=>{userScrollUntil=performance.now()+1500;if(e.deltaY<0)maybeLoadOlder(true);},{passive:true});
$('timeline').addEventListener('touchstart',e=>{userScrollUntil=performance.now()+3000;historyTouchY=e.touches[0]?.clientY;},{passive:true});
$('timeline').addEventListener('touchend',e=>{if(historyTouchY!==undefined&&e.changedTouches[0]?.clientY-historyTouchY>24)maybeLoadOlder(true);historyTouchY=undefined;},{passive:true});
$('timeline').addEventListener('pointerdown',()=>{userScrollUntil=performance.now()+3000;},{passive:true});
$('timeline').addEventListener('touchmove',()=>{userScrollUntil=performance.now()+3000;},{passive:true});
document.addEventListener('keydown',e=>{if(['ArrowUp','PageUp','Home','PageDown','ArrowDown','End',' '].includes(e.key)&&!e.target.closest('input,textarea,select'))userScrollUntil=performance.now()+2000;});
if('ResizeObserver' in window){const readingResize=new ResizeObserver(()=>{if(!selected||!historyPager.initialized)return;if(retainedReadingAnchor)restoreReadingAnchor(retainedReadingAnchor);else $('timeline').scrollTop=$('timeline').scrollHeight;});readingResize.observe($('messages'));readingResize.observe($('timeline'));}
$('search').oninput=renderList;
$('device-filter').onchange=()=>{renderFilters();renderList();};$('project-filter').onchange=renderList;
$('session-switch').onchange=()=>{const s=state.sessions.find(s=>s.id===$('session-switch').value);if(s)void select(s);};
$('session-title').onclick=()=>{const button=$('session-title');const expanded=button.getAttribute('aria-expanded')==='true';button.setAttribute('aria-expanded',String(!expanded));button.setAttribute('aria-label',expanded?'展开完整会话标题':'收起会话标题');};
$('project-select').onchange=()=>{workspaces();createFiles.render();};$('provider-select').onchange=()=>void createModels();
$('activity-filter').onchange=renderList;
$('model-select').onchange=async()=>{if(!selected||!$('model-select').value)return;const s=selected,model=$('model-select').value;$('model-select').disabled=true;try{const result=await action({type:'set-model',sessionId:s.id,model});await refresh();await sessionModels(selected);toast(result.queued?'已预设下一轮模型，当前任务继续执行':'下一轮使用 '+model);}catch(err){toast(err.message);if(selected?.id===s.id)$('model-select').value=s.nextModel??s.model??'';}finally{renderHead();}};
$('effort-select').onchange=async()=>{if(!selected)return;try{const result=await action({type:'set-model',sessionId:selected.id,model:$('model-select').value||undefined,effort:$('effort-select').value});await refresh();toast(result.queued?'已预设下一轮思考强度，当前任务继续执行':'思考强度已更新');}catch(err){toast(err.message);}finally{renderHead();}};
$('create-model').onchange=async()=>{try{const choice=agentChoice($('provider-select').value),list=await models($('host-select').value,choice.provider,choice.agentId);effortOptions($('create-effort'),list,$('create-model').value);}catch(err){toast(err.message);}};
document.querySelectorAll('[data-provider]').forEach(b=>b.onclick=()=>{provider=b.dataset.provider;document.querySelectorAll('[data-provider]').forEach(x=>x.classList.toggle('active',x===b));renderList();});

$('settings-toggle').onclick=()=>{hideCommands();openComposerDialog($('session-settings'),$('settings-toggle'));};function openComposerDialog(dialog,anchor){
  dialog.style.margin='0';dialog.style.position='fixed';dialog.style.inset='auto';dialog.tabIndex=-1;dialog.showModal();
  positionComposerDialog(dialog,anchor);
  dialog.focus({preventScroll:true});
}
function positionComposerDialog(dialog,anchor){
  const rect=anchor.getBoundingClientRect(),width=dialog.offsetWidth,height=dialog.offsetHeight;
  dialog.style.left=Math.max(8,Math.min(innerWidth-width-8,rect.right-width))+'px';
  dialog.style.top=Math.max(8,Math.min(innerHeight-height-8,rect.top-height-10))+'px';
}
$('model-picker').addEventListener('toggle',()=>{if($('session-settings').open)positionComposerDialog($('session-settings'),$('settings-toggle'));});
for(const dialog of [$('permission-menu'),$('session-settings')]){
  let outsidePress=false;
  const outside=event=>{const r=dialog.getBoundingClientRect();return event.target===dialog&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom);};
  dialog.addEventListener('pointerdown',event=>{outsidePress=event.isPrimary&&event.button===0&&outside(event);});
  dialog.addEventListener('pointercancel',()=>{outsidePress=false;});
  dialog.addEventListener('close',()=>{outsidePress=false;});
  dialog.addEventListener('click',event=>{const dismiss=outsidePress&&outside(event);outsidePress=false;if(dismiss){event.preventDefault();event.stopPropagation();dialog.close();}});
}
$('permission-toggle').onclick=()=>{if(selected){renderHead();openComposerDialog($('permission-menu'),$('permission-toggle'));}};
$('permission-close').onclick=()=>$('permission-menu').close();
for(const option of document.querySelectorAll('[data-permission]'))option.onclick=async()=>{
  const s=selected;if(!s||permissionChanges.has(s.id))return;permissionChanges.add(s.id);renderHead();
  try{const result=await action({type:'set-permissions',sessionId:s.id,permissionMode:option.dataset.permission});await refresh();$('permission-menu').close();toast(result.queued?'已预设下一轮权限':'会话权限已更新；已有确认仍可在卡片上处理');}
  catch(error){toast(error.message);}finally{permissionChanges.delete(s.id);renderHead();}
};
function updateCreatePermissionNote(){const mode=$('create-permission').value;$('create-permission-note').textContent=mode==='full'?'允许访问工作电脑上的文件和网络，跳过常规批准；只用于新会话':mode==='auto'?'由 Agent 自带的自动审查决定，仍受其权限限制':'需要批准的操作由你确认，仅作用于本会话。';$('create-permission-note').dataset.mode=mode;}
$('create-permission').onchange=updateCreatePermissionNote;
$('new-project-button').onclick=()=>{$('new-project-panel').hidden=!$('new-project-panel').hidden;if(!$('new-project-panel').hidden)$('new-project-name').focus();};
$('save-project').onclick=async()=>{
  const hostId=$('host-select').value,name=$('new-project-name').value.trim(),path=$('new-project-path').value.trim();
  if(!name||!path){$('new-project-error').textContent='请输入工程名称和工作电脑上的文件夹绝对路径';return;}
  $('save-project').disabled=true;$('new-project-error').textContent='';
  try{const {project}=await action({type:'create-project',hostId,projectName:name,projectPath:path,createFolder:$('new-project-mkdir').checked});await refresh();
    if($('host-select').value!==hostId)return;
    const host=state.hosts.find(h=>h.id===hostId);if(host&&!host.projects.some(p=>p.id===project.id))host.projects.push(project);
    $('project-select').replaceChildren(...(host?.projects??[]).map(p=>new Option(`${p.source==='codex'?'Codex · ':''}${p.name}`,p.id)));$('project-select').value=project.id;workspaces();createFiles.render();$('create-submit').disabled=false;$('new-project-panel').hidden=true;toast('工程已就绪，文件保留在工作电脑上');
  }catch(error){$('new-project-error').textContent=error.message;}finally{$('save-project').disabled=false;}
};
$('settings-close').onclick=()=>$('session-settings').close();
window.addEventListener('resize',fitViewport);window.visualViewport?.addEventListener('resize',fitViewport);window.visualViewport?.addEventListener('scroll',fitViewport);document.addEventListener('focusin',()=>requestAnimationFrame(fitViewport));document.addEventListener('focusout',()=>requestAnimationFrame(fitViewport));fitViewport();
async function start(){await refresh();$('login').hidden=true;$('workspace').hidden=false;stream();}
void start().catch(()=>loggedOut());
let polling=false;
setInterval(async()=>{if(polling||document.hidden||!selected||!hostOf(selected)?.online||$('workspace').hidden)return;polling=true;try{await history(false,true);}finally{polling=false;}},5000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!$('workspace').hidden){void refresh().then(()=>selected&&history(false,true)).catch(()=>{});}});

$('image-close').onclick=()=>{$('image-viewer').close();$('image-full').removeAttribute('src');};
