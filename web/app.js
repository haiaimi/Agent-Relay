import {AttachmentInput} from './attachments.js';
import {setupDrawer} from './drawer.js';
import {userMessageText} from './message-text.js';
const $=id=>document.getElementById(id);
let state={hosts:[],sessions:[]},provider='all',selected=null,messages=new Map(),approvals=new Map(),seen=new Set(),events=null,cursor=null,loading=0,refreshTimer,historyLoaded=false;
const modelCache=new Map();let modelLoading=0,createModelLoading=0;
const drafts=new Map(),expandedTools=new Set(),sending=new Set();let commandOptions=[],commandCandidates=[],commandIndex=0,commandsLoading=0;
const effortNames={default:'本机默认',none:'无',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高',ultra:'极高'};
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
  for(const ref of message.images??[]){
    const figure=node('figure','image-card'),caption=node('figcaption','',ref.name||'图片');
    if(ref.id&&/^[a-f0-9]{64}$/.test(ref.id)){
      const sessionId=selected.id,url='/api/images/'+ref.id+'?sessionId='+encodeURIComponent(sessionId),button=node('button','image-thumb'),img=node('img');button.type='button';button.setAttribute('aria-label','查看图片：'+(ref.name||'图片'));img.alt=ref.name||'会话图片';img.loading='lazy';img.decoding='async';img.src=url;
      img.onerror=()=>{img.hidden=true;button.disabled=true;button.append(node('span','image-error','图片暂未同步或读取失败，电脑上线后可重试'));};
      button.append(img);button.onclick=()=>{const viewer=$('image-viewer');$('image-title').textContent=ref.name||'图片';$('image-full').alt=ref.name||'会话图片';$('image-full').src=url;$('image-original').href=url;if(!viewer.open)viewer.showModal();};figure.append(button);
    }else figure.append(node('p','image-error',ref.error||'图片暂不可用'));
    figure.append(caption);gallery.append(figure);
  }
  return gallery;
}
function fileGallery(message){
  const gallery=node('div','file-gallery');for(const file of message.files??[]){
    if(!/^[a-f0-9-]{36}$/i.test(file.id))continue;const url='/api/files/'+file.id+'?sessionId='+encodeURIComponent(selected.id),card=node('div','file-card');
    if(file.mime?.startsWith('image/')){const button=node('button','image-thumb'),img=node('img');button.type='button';button.setAttribute('aria-label','查看图片：'+file.name);img.src=url;img.alt=file.name;img.loading='lazy';button.append(img);button.onclick=()=>{$('image-title').textContent=file.name;$('image-full').alt=file.name;$('image-full').src=url;$('image-original').href=url;$('image-viewer').showModal();};card.append(button);}
    const link=node('a','file-download',file.name+' · '+Math.max(1,Math.round(file.size/1024))+' KB');link.href=url;link.download=file.name;card.append(link);gallery.append(card);
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
    const top=node('div','row-head');top.append(node('i','dot'+(['running','waiting'].includes(s.status)?' online':'')),node('span','',s.provider==='codex'?'CODEX':'CLAUDE CODE'),node('span','',s.archived?'· 已归档':s.status!=='history'?'· '+(statusNames[s.status]??s.status):''));
    const title=node('strong','',s.title);const bottom=node('div','row-folder');bottom.append(node('span','',`${s.projectName??'未归属项目'} · ${folder(s.cwd)}`),node('time','',when(s.updatedAt)));row.append(top,title,bottom);row.title=`${hostOf(s)?.hostname??s.hostId}\n${s.projectName??'未归属项目'}\n${s.cwd}\n${s.title}`;row.onclick=()=>void select(s);children.push(row);
  }
  if(!children.length)children.push(node('p','empty-list',state.hosts.length?'没有匹配的会话。试试新建一个？':'等待本地电脑连接。启动连接程序后，会话会出现在这里。'));
  if(list.length>300)children.push(node('p','empty-list',`显示最近 300 条，共 ${list.length} 条。搜索可查找更早的会话。`));
  $('session-list').replaceChildren(...children);
  const switcher=$('session-switch');switcher.replaceChildren(new Option('切换会话…',''),...list.slice(0,300).map(s=>new Option(`${s.provider==='codex'?'Codex':'Claude'} · ${s.projectName??folder(s.cwd)} · ${s.title.slice(0,45)}`,s.id)));switcher.value=selected?.id??'';
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
  const online=hostOf(selected)?.online;$('host-label').textContent=hostOf(selected)?.hostname??hostOf(selected)?.name??selected.hostId;$('agent-badge').textContent=selected.provider==='codex'?'CODEX':'CLAUDE CODE';$('session-title').textContent=selected.title;$('session-project').textContent=`项目：${selected.projectName??'未归属项目'}${selected.projectSource==='codex'?' · Codex Project':''}`;$('session-folder').textContent=selected.cwd;$('session-status').textContent=(statusNames[selected.status]??selected.status)+(online?'':' · 电脑离线');
  const busy=['running','waiting'].includes(selected.status);$('stop').hidden=!(selected.managed&&busy)&&!selected.pendingCount;$('stop').textContent=selected.managed&&busy?'■ 停止':'取消排队';
  composerFiles.render();const hasInput=!!$('prompt').value.trim()||!!composerFiles.count,active=busy&&online;
  $('prompt').disabled=false;$('send-button').hidden=!hasInput;$('send-button').disabled=!hasInput||!online||sending.has(selected.id);
  $('run-indicator').hidden=hasInput||!active;$('run-indicator').setAttribute('aria-label',selected.status==='waiting'?'等待你确认':'任务正在执行');$('run-indicator').title=selected.status==='waiting'?'等待你确认':'任务正在执行';
  $('model-select').disabled=!online;$('effort-select').disabled=!online;
  const targetModel=selected.nextModel??selected.model;if(targetModel&&[...$('model-select').options].some(o=>o.value===targetModel))$('model-select').value=targetModel;
  const targetEffort=selected.nextEffort??selected.effort??'default';if([...$('effort-select').options].some(o=>o.value===targetEffort))$('effort-select').value=targetEffort;
  $('pending-settings').textContent=selected.nextModel||selected.nextEffort?`下一轮：${selected.nextModel??selected.model??'本机模型'} · ${effortNames[selected.nextEffort??selected.effort]??'本机默认'}`:'';
  const modelName=$('model-select').selectedOptions[0]?.textContent.replace(/^当前：|（默认）/g,'')||'默认模型';
  $('settings-preview').textContent=`${selected.nextModel||selected.nextEffort?'下轮 · ':''}${modelName==='沿用本机默认模型'?'默认模型':modelName} · ${effortNames[targetEffort]??targetEffort}`;
  $('settings-toggle').title=$('settings-preview').textContent;
  const pending=selected.pendingCount?` · ${selected.pendingCount} 条排队中`:'';
  const note=!online?'电脑离线，可先编辑草稿':selected.canSteer?((selected.provider==='codex'?'排队消息可逐条引导：送入 Codex 当前任务':selected.managed?'排队消息可逐条引导：中止本轮并沿同一会话继续':'排队消息可逐条引导：直接送入本地 Claude')+(selected.provider==='claude'?'；/btw 单独旁问':'')+pending):busy||selected.pendingCount?((selected.provider==='codex'?'普通消息排队到下一轮；引导通道可用后可逐条引导':selected.managed?'普通消息排队到下一轮；/btw 单独旁问':'原生会话仍由本地应用控制；消息排队等原会话关闭，/btw 可旁问')+pending):'在本地电脑中执行 · 输入 / 查看命令';
  $('settings-input-note').textContent=note;$('composer-note').title=note;$('composer-note').dataset.attention=String(!online||busy||!!selected.pendingCount);
  $('composer-note').textContent=!online?'电脑离线 · 可编辑草稿':selected.canSteer?'发送后可在该条消息上点「引导」'+pending:busy||selected.pendingCount?(selected.managed?'运行中 · 消息排队到下一轮'+pending:(selected.provider==='codex'?'本地 Codex 运行中 · 消息先排队':'本地会话未退出 · 消息先排队')+pending):'输入 / 查看命令';
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
async function refresh(){state=await api('state');if(selected){const updated=state.sessions.find(s=>s.id===selected.id);if(updated)selected=updated;}renderFilters();renderList();renderHosts();renderHead();if(selected)renderMessages(true);}
function renderMessages(keepPosition=false){
  const timeline=$('timeline');const nearBottom=timeline.scrollHeight-timeline.scrollTop-timeline.clientHeight<140;const rows=[];let toolGroup=null;
  for(const m of messages.values()){
    if(m.role==='tool'){
      if(!toolGroup){const key='group:'+m.id,card=node('article','message tool'),group=node('details','tool-group'),summary=node('summary');group.open=expandedTools.has(key);group.ontoggle=()=>{if(group.open)expandedTools.add(key);else expandedTools.delete(key);};group.append(summary);card.append(group);rows.push(card);toolGroup={group,summary,count:0};}
      toolGroup.count++;toolGroup.summary.textContent=`工具调用与结果 · ${toolGroup.count} 项`;
      const details=node('details','tool-call'),summary=node('summary','',m.label||'工具调用');details.open=expandedTools.has(m.id);details.ontoggle=()=>{if(details.open)expandedTools.add(m.id);else expandedTools.delete(m.id);};details.append(summary,node('pre','tool-details',m.text));if(m.images?.length)details.append(imageGallery(m));toolGroup.group.append(details);continue;
    }
    toolGroup=null;const card=node('article','message '+m.role);card.dataset.messageId=m.id;card.append(node('div','message-label',m.label||(m.role==='user'?'你':m.role==='assistant'?(selected?.provider==='codex'?'CODEX':'CLAUDE'):'运行提示')),messageBody(m));
    if(m.images?.length)card.append(imageGallery(m));if(m.files?.length)card.append(fileGallery(m));
    if(m.role==='user'&&selected?.pendingIds?.includes(m.id)&&m.label==='你 · 已排队'){
      const controls=node('div','queued-actions'),cancel=node('button','cancel-input','取消排队');cancel.type='button';cancel.disabled=!hostOf(selected)?.online||sending.has(selected.id);cancel.onclick=()=>void queuedAction('cancel-input',m.id);controls.append(cancel);
      const steer=node('button','steer','引导');steer.type='button';steer.disabled=cancel.disabled||!selected.canSteer||m.text.trimStart().startsWith('/');steer.title=!selected.canSteer?'本地引导通道暂不可用；消息保留在队列中':m.text.trimStart().startsWith('/')?'命令不支持引导':selected.provider==='codex'?'把这条消息送入 Codex 当前任务，其他消息继续排队':selected.managed?'中止本轮，按这条消息沿同一会话继续':'立即把这条消息送入本地 Claude；当前操作可让出时处理';steer.onclick=()=>void queuedAction('steer',m.id);controls.append(steer);card.append(controls);
    }
    rows.push(card);
  }
  for(const [id,a] of approvals){
    const card=node('article','approval');card.append(node('h3','',`需要确认 · ${a.label}`),node('pre','',a.details));
    if(a.resolved||a.expiresAt<Date.now())card.append(node('p','fine',a.resolved?(a.allow?'已允许':'已拒绝'):'请求已过期'));
    else{const buttons=node('div','approval-actions');for(const [label,allow] of [['允许这一次',true],['拒绝',false]]){const b=node('button','',label);b.type='button';b.onclick=async()=>{b.disabled=true;try{await action({type:'approve',sessionId:selected.id,approvalId:id,allow});}catch(err){toast(err.message);b.disabled=false;}};buttons.append(b);}card.append(buttons);}rows.push(card);
  }
  $('messages').replaceChildren(...rows);if(!keepPosition&&nearBottom)timeline.scrollTop=timeline.scrollHeight;
}
function applyEvent(event,draw=true){
  if(event.sessionId!==selected?.id||seen.has(event.id))return;seen.add(event.id);const d=event.data;
  if(event.type==='message'){for(const id of d.replaces??[])messages.delete(id);const old=messages.get(d.id);messages.set(d.id,{...old,...d,images:d.images??old?.images});}
  if(event.type==='delta'){const old=messages.get(d.messageId);messages.set(d.messageId,{id:d.messageId,role:'assistant',text:(old?.text??'')+d.text});}
  if(event.type==='error')messages.set(event.id,{id:event.id,role:'system',text:d.message});
  if(event.type==='status'){selected.status=d.status;renderHead();}
  if(event.type==='approval')approvals.set(d.approvalId,d);
  if(event.type==='approval.resolved'){const a=approvals.get(d.approvalId);if(a)approvals.set(d.approvalId,{...a,resolved:true,allow:d.allow});}
  if(draw)renderMessages();
}
async function history(older=false,silent=false){
  const current=selected;if(!current)return;const n=++loading;
  if(!silent){$('history-note').textContent='正在读取会话…';$('history-note').dataset.state='loading';}
  try{
    const page=await api(`history?sessionId=${encodeURIComponent(current.id)}${older&&cursor!==null?`&cursor=${cursor}`:''}`);
    if(n!==loading||selected?.id!==current.id)return;
    const beforeHeight=$('timeline').scrollHeight;const beforeTop=$('timeline').scrollTop;const nearBottom=beforeHeight-beforeTop-$('timeline').clientHeight<140;
    const combined=older||!historyLoaded?new Map(page.messages.map(m=>[m.id,m])):new Map(messages);
    if(older||!historyLoaded){for(const [id,m] of messages){const old=combined.get(id);if(!old||m.text.length>old.text.length)combined.set(id,{...old,...m,images:m.images??old?.images});}}
    else for(const m of page.messages){const old=combined.get(m.id);if(!old||m.text.length>=old.text.length)combined.set(m.id,{...old,...m,images:m.images??old?.images});}
    messages=combined;historyLoaded=true;
    for(const event of page.events??[])applyEvent(event,false);
    if(!silent||cursor===null)cursor=page.cursor;$('older').hidden=cursor===null;$('history-note').textContent=page.cached?'电脑离线或未响应 · 显示之前缓存的历史':`${page.source} · 内容在本机读取`;$('history-note').dataset.state=page.cached?'cached':'ready';
    renderMessages(older||silent);if(older)$('timeline').scrollTop=beforeTop+$('timeline').scrollHeight-beforeHeight;else if(!silent||nearBottom)$('timeline').scrollTop=$('timeline').scrollHeight;
  }catch(err){if(n===loading){$('history-note').textContent=err.message;$('history-note').dataset.state='error';}}
}
async function select(s){if(selected)drafts.set(selected.id,$('prompt').value);selected=s;$('session-title').setAttribute('aria-expanded','false');$('session-title').setAttribute('aria-label','展开完整会话标题');$('prompt').value=drafts.get(s.id)??'';hideCommands();messages=new Map();markdownCache.clear();seen=new Set();approvals=new Map();cursor=null;historyLoaded=false;$('welcome').hidden=true;$('conversation').hidden=false;drawer.close();renderList();renderHead();renderMessages();resizeComposer();void sessionModels(s);void sessionCommands(s);await history();}
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
function projects(){const host=state.hosts.find(h=>h.id===$('host-select').value);$('project-select').replaceChildren(...(host?.projects??[]).map(p=>new Option(`${p.source==='codex'?'Codex · ':''}${p.name}`,p.id)));$('create-submit').disabled=!host?.online||!host?.projects.length;workspaces();void createModels();}
async function models(hostId,provider){const key=hostId+':'+provider;if(!modelCache.has(key))modelCache.set(key,api(`models?hostId=${encodeURIComponent(hostId)}&provider=${provider}`).catch(err=>{modelCache.delete(key);throw err;}));return (await modelCache.get(key)).models;}
function modelOptions(element,list,current){element.replaceChildren(new Option('沿用本机默认模型',''),...list.map(m=>new Option(m.name+(m.isDefault?'（默认）':''),m.id)));if(current&&!list.some(m=>m.id===current))element.add(new Option(`当前：${current}`,current));element.value=current??'';}
function effortOptions(element,list,model,current){const m=list.find(m=>m.id===model||m.aliases?.includes(model))??(!model?list.find(m=>m.isDefault)??list[0]:null);element.replaceChildren(new Option('本机默认','default'),...(m?.efforts??[]).map(v=>new Option(effortNames[v]??v,v)));if(current&&![...element.options].some(o=>o.value===current))element.add(new Option(`当前：${effortNames[current]??current}`,current));element.value=current??'default';}
async function sessionModels(s){const n=++modelLoading;modelOptions($('model-select'),[],s.nextModel??s.model);$('model-hint').textContent='正在读取本机模型列表…';try{const list=await models(s.hostId,s.provider);if(selected?.id!==s.id||n!==modelLoading)return;modelOptions($('model-select'),list,selected.nextModel??selected.model);effortOptions($('effort-select'),list,selected.nextModel??selected.model,selected.nextEffort??selected.effort);$('model-hint').textContent='运行中也可预设，下一轮生效';renderHead();}catch(err){if(selected?.id===s.id)$('model-hint').textContent=err.message;}}
async function createModels(){const n=++createModelLoading,host=$('host-select').value,provider=$('provider-select').value;modelOptions($('create-model'),[]);effortOptions($('create-effort'),[]);if(!host)return;try{const list=await models(host,provider);if(n===createModelLoading){modelOptions($('create-model'),list);effortOptions($('create-effort'),list);}}catch(err){if(n===createModelLoading)$('create-error').textContent=err.message;}}
function openCreate(){
  $('create-error').textContent='';$('host-select').replaceChildren(...state.hosts.map(h=>new Option(h.name+(h.online?'':'（离线）'),h.id)));const online=state.hosts.find(h=>h.online);if(online)$('host-select').value=online.id;projects();createFiles.render();$('create-dialog').showModal();$('initial-prompt').focus();
}
const drawer=setupDrawer($('sidebar'),$('drawer-backdrop'),$('drawer-edge'),$('open-sidebar'),$('close-sidebar'));
const composerContext=()=>selected?{key:selected.id,target:{hostId:selected.hostId,sessionId:selected.id}}:null;
const createContext=()=>({key:'create:'+ $('host-select').value+':'+$('project-select').value,target:{hostId:$('host-select').value,projectId:$('project-select').value}});
const composerFiles=new AttachmentInput(document.querySelector('.composer-wrap'),$('attach-button'),$('attachment-preview'),composerContext,message=>{if(message)toast(message);renderHead();});
const createFiles=new AttachmentInput($('create-form'),$('create-attach-button'),$('create-attachment-preview'),createContext,message=>{if(message)$('create-error').textContent=message;});
$('login-form').onsubmit=async e=>{e.preventDefault();$('login-error').textContent='';try{await api('login',{token:$('token').value});$('token').value='';await start();}catch(err){$('login-error').textContent=err.message;}};
$('logout').onclick=async()=>{try{await api('logout',{});}finally{composerFiles.reset();createFiles.reset();state={hosts:[],sessions:[]};selected=null;messages.clear();approvals.clear();$('messages').replaceChildren();$('session-list').replaceChildren();$('conversation').hidden=true;$('welcome').hidden=false;loggedOut();}};
$('new-session').onclick=openCreate;$('welcome-new').onclick=openCreate;$('cancel-create').onclick=()=>$('create-dialog').close();$('host-select').onchange=()=>{projects();createFiles.render();};
$('create-form').onsubmit=async e=>{e.preventDefault();if(!$('initial-prompt').value.trim()&&!createFiles.count){$('create-error').textContent='请输入任务或添加附件';return;}const context=createContext();$('create-submit').disabled=true;$('create-error').textContent='';try{const attachmentIds=await createFiles.upload(context);const result=await action({attachmentIds,type:'start',hostId:$('host-select').value,projectId:$('project-select').value,workspaceIndex:Number($('workspace-select').value),provider:$('provider-select').value,model:$('create-model').value||undefined,effort:$('create-effort').value, text:$('initial-prompt').value});createFiles.clear(context.key);await refresh();$('create-dialog').close();$('initial-prompt').value='';const s=state.sessions.find(s=>s.id===result.sessionId);if(s)await select(s);}catch(err){$('create-error').textContent=err.message;}finally{$('create-submit').disabled=false;}};
$('composer').onsubmit=async e=>{e.preventDefault();const text=$('prompt').value,s=selected,context=composerContext();if(!s||(!text.trim()&&!composerFiles.count)||sending.has(s.id))return;sending.add(s.id);hideCommands();renderHead();try{const attachmentIds=await composerFiles.upload(context);const result=await action({type:'send',sessionId:s.id,text,attachmentIds});composerFiles.clear(context.key);if(selected?.id===s.id&&$('prompt').value===text)$('prompt').value='';drafts.set(s.id,selected?.id===s.id?$('prompt').value:'');if(result.queued)toast('消息已排队，可在该条消息上操作');else if(result.sideQuestion)toast('旁问已发出，主任务继续执行');await refresh();}catch(err){toast(err.message);}finally{sending.delete(s.id);renderHead();resizeComposer();}};
$('prompt').oninput=()=>{if(selected)drafts.set(selected.id,$('prompt').value);commandIndex=0;resizeComposer();renderCommands();renderHead();};
$('messages').addEventListener('click',async event=>{
  const button=event.target.closest('.code-copy');if(!button)return;
  const code=button.closest('.code-block')?.querySelector('code');if(!code)return;
  try{await navigator.clipboard.writeText(code.textContent);button.textContent='已复制';setTimeout(()=>{if(button.isConnected)button.textContent='复制';},1500);}
  catch{toast('复制失败，请长按代码选择');}
});
$('prompt').onkeydown=e=>{
  if(e.isComposing)return;
  if(!$('command-menu').hidden){
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();commandIndex=(commandIndex+(e.key==='ArrowDown'?1:-1)+commandCandidates.length)%commandCandidates.length;renderCommands();return;}
    if(e.key==='Tab'||(e.key==='Enter'&&!e.shiftKey&&!e.ctrlKey&&!e.metaKey)){
      e.preventDefault();const candidate=commandCandidates[commandIndex];
      if(e.key==='Enter'&&candidate&&!candidate.argumentHint&&$('prompt').value.trim()==='/'+candidate.name){hideCommands();$('composer').requestSubmit();}else completeCommand(commandIndex);return;
    }
    if(e.key==='Escape'){e.preventDefault();hideCommands();return;}
  }
  const command=commandOptions.find(c=>!c.argumentHint&&$('prompt').value.trim()==='/'+c.name);
  if(e.key==='Enter'&&((e.ctrlKey||e.metaKey)||(!e.shiftKey&&command))){e.preventDefault();$('composer').requestSubmit();}
};
$('stop').onclick=async()=>{try{await action({type:'stop',sessionId:selected.id});await refresh();}catch(err){toast(err.message);}};
$('refresh').onclick=async()=>{try{await refresh();if(selected)await history();}catch(err){toast(err.message);}};
$('older').onclick=()=>void history(true);$('search').oninput=renderList;
$('device-filter').onchange=()=>{renderFilters();renderList();};$('project-filter').onchange=renderList;
$('session-switch').onchange=()=>{const s=state.sessions.find(s=>s.id===$('session-switch').value);if(s)void select(s);};
$('session-title').onclick=()=>{const button=$('session-title');const expanded=button.getAttribute('aria-expanded')==='true';button.setAttribute('aria-expanded',String(!expanded));button.setAttribute('aria-label',expanded?'展开完整会话标题':'收起会话标题');};
$('project-select').onchange=()=>{workspaces();createFiles.render();};$('provider-select').onchange=()=>void createModels();
$('activity-filter').onchange=renderList;
$('model-select').onchange=async()=>{if(!selected||!$('model-select').value)return;const s=selected,model=$('model-select').value;$('model-select').disabled=true;try{const result=await action({type:'set-model',sessionId:s.id,model});await refresh();await sessionModels(selected);toast(result.queued?'已预设下一轮模型，当前任务继续执行':'下一轮使用 '+model);}catch(err){toast(err.message);if(selected?.id===s.id)$('model-select').value=s.nextModel??s.model??'';}finally{renderHead();}};
$('effort-select').onchange=async()=>{if(!selected)return;try{const result=await action({type:'set-model',sessionId:selected.id,model:$('model-select').value||undefined,effort:$('effort-select').value});await refresh();toast(result.queued?'已预设下一轮思考强度，当前任务继续执行':'思考强度已更新');}catch(err){toast(err.message);}finally{renderHead();}};
$('create-model').onchange=async()=>{try{const list=await models($('host-select').value,$('provider-select').value);effortOptions($('create-effort'),list,$('create-model').value);}catch(err){toast(err.message);}};
document.querySelectorAll('[data-provider]').forEach(b=>b.onclick=()=>{provider=b.dataset.provider;document.querySelectorAll('[data-provider]').forEach(x=>x.classList.toggle('active',x===b));renderList();});

$('settings-toggle').onclick=()=>{hideCommands();$('session-settings').showModal();};$('settings-close').onclick=()=>$('session-settings').close();
window.addEventListener('resize',fitViewport);window.visualViewport?.addEventListener('resize',fitViewport);window.visualViewport?.addEventListener('scroll',fitViewport);document.addEventListener('focusin',()=>requestAnimationFrame(fitViewport));document.addEventListener('focusout',()=>requestAnimationFrame(fitViewport));fitViewport();
async function start(){await refresh();$('login').hidden=true;$('workspace').hidden=false;stream();}
void start().catch(()=>loggedOut());
let polling=false;
setInterval(async()=>{if(polling||document.hidden||!selected||!hostOf(selected)?.online||$('workspace').hidden)return;polling=true;try{await history(false,true);}finally{polling=false;}},5000);

$('image-close').onclick=()=>{$('image-viewer').close();$('image-full').removeAttribute('src');};
