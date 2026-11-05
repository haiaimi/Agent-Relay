import {deliveryMedia} from './studio-delivery-media.js';
import {prepareStudioEmbed} from './workspace-shell.js';
import {studioProgress} from './studio-sidebar.js';
import {conversationCache,clearConversationCache} from './conversation-cache.js';
import {coalescedRefresh} from './refresh.js';
import {roleAvatar} from './studio-avatar.js';
import {setupStudioViewport} from './studio-viewport.js';
import {scenePanel,sceneStageName} from './studio-scene.js';
import {AttachmentInput} from './attachments.js';
import {mediaCard,disposeMedia,clipboardFiles} from './studio-media.js';
import {studioBrainstorm} from './studio-brainstorm.js';
import {studioChat} from './studio-chat.js';
import {matchingStudioProject,studioProjectRegistration} from './studio-projects.js';
const $=id=>document.getElementById(id);
const embed=prepareStudioEmbed(active=>{if(active){syncDesktop();stream();void refresh(true).catch(()=>{});}else{source?.close();source=null;}},()=>void refresh(true).catch(()=>{}),studioSidebarCommand);
setupStudioViewport();
try{const previous=localStorage.getItem('relay-last-session');if(previous)document.querySelector('.app-nav-item[href="/"]').href='/?sessionId='+encodeURIComponent(previous);}catch{}
let desktopHostId='';
function syncDesktop(){if(window.relayStudioDesktop)void window.relayStudioDesktop.context().then(info=>{desktopHostId=info.hostId;syncBrowse();}).catch(()=>{});}
if(embed.active)syncDesktop();
let state={roles:[],projects:[],runs:[]},relay={hosts:[],sessions:[]},selected=localStorage.getItem('relay-studio-team')||'',editing=null,activeRun=null,activeTask=null,feedback=null,source,lastSignature='',noticeTimer;
let skipTimer,skipGeneration=0,skipLoading=false,feedbackSubmitting=false,skipRetryAt=0,skipFailures=0;const skipStops=new Map();
const labels={planning:'统筹拆解中','plan-review':'等待确认计划',executing:'团队制作中',delivery:'整理交付中',review:'等待制作人验收',accepted:'已验收',cancelled:'已取消','awaiting-review':'待制作人审批',queued:'待分发',starting:'启动中',running:'执行中',done:'已完成',skipped:'制作人已跳过',blocked:'待处理'};
const node=(tag,cls,value)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(value!==undefined)n.textContent=value;return n;};
const pill=(status,label)=>node('span','pill '+status,label||labels[status]||status);
const current=()=>state.projects.find(p=>p.id===selected);
const roleName=id=>state.roles.find(r=>r.id===id)?.name||id;
const hostOf=p=>relay.hosts.find(h=>h.id===p?.hostId);
const allTasks=r=>[r.planner,...r.tasks,...r.delivery?[r.delivery]:[]];
const date=at=>new Date(at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
function notify(message){$('notice').textContent=message;$('notice').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('notice').hidden=true,6000);}
async function api(path,payload,signal){if(path==='state'&&!payload&&embed.state())return embed.state();const response=await fetch('/api/'+path,{method:payload?'POST':'GET',headers:payload?{'Content-Type':'application/json'}:{},body:payload?JSON.stringify(payload):undefined,signal});const result=await response.json();if(response.status===401){void clearConversationCache();$('app').hidden=true;$('login').hidden=false;source?.close();throw Error('请登录工作室');}if(!response.ok||result.error)throw Error(result.error||'操作失败');return result;}
function option(value,label){const o=document.createElement('option');o.value=value;o.textContent=label;return o;}
function button(label,fn,cls='quiet'){const b=node('button',cls,label);b.type='button';b.onclick=()=>Promise.resolve().then(fn).catch(e=>notify(e.message));return b;}
function link(label,url){const a=node('a','button quiet',label);a.href=url;return a;}
function show(id){if(!$(id).open)$(id).showModal();}
function selectedProject(){if(!current())selected=state.projects[0]?.id||'';localStorage.setItem('relay-studio-team',selected);}
let sidebarSignature='';
function publishStudioSidebar(){const progress=studioProgress(state,relay,selected,activeRun,activeTask),signature=JSON.stringify(progress);if(signature!==sidebarSignature){sidebarSignature=signature;embed.sidebar(progress);}}
function closeStudioDialogs(){if($('brief-dialog').open)saveBrief();for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();}
function studioSidebarCommand(v){
  if(v.command==='project'){if(state.projects.some(p=>p.id===v.projectId)){closeStudioDialogs();selected=v.projectId;selectedProject();activeRun=null;activeTask=null;render();}return;}
  if(v.command==='brief'){closeStudioDialogs();openBrief();return;}
  const r=state.runs.find(r=>r.id===v.runId&&r.projectId===selected);if(!r)return;
  const t=v.command==='task'&&allTasks(r).find(t=>t.id===v.taskId);if(v.command==='task'&&!t)return;
  closeStudioDialogs();
  if(t)openTask(r,t);else{activeRun=r.id;activeTask=null;renderRun();show('run-dialog');}
}
const refresh=coalescedRefresh(async force=>{const values=await Promise.all([api('studio'),api('state')]);state=values[0];relay=values[1];selectedProject();const signature=JSON.stringify([state,relay.hosts.map(h=>[h.id,h.online,h.agents,h.projects]),relay.sessions.filter(s=>s.questionCount||s.status==='waiting').map(s=>[s.id,s.status,s.questionCount])]);if(force||signature!==lastSignature){lastSignature=signature;render();if($('run-dialog').open)renderRun();if($('task-dialog').open)renderTask();}chats.update();brainstorms.update();$('connection').textContent=relay.hosts.filter(h=>h.online).length+' 台工作电脑在线';$('connection').dataset.offline=String(!relay.hosts.some(h=>h.online));});
function render(){
  publishStudioSidebar();
  brainstorms.render();const brain=$('tab-brainstorm').getAttribute('aria-selected')==='true';$('brainstorm-view').hidden=!brain||!current();$('studio-brainstorm-nav').classList.toggle('active',brain);
  const picker=$('project-picker');picker.replaceChildren(...state.projects.map(p=>option(p.id,p.name)));picker.value=selected;picker.disabled=!current();$('edit-team').disabled=!current();$('new-brief').disabled=!current();$('empty').hidden=!!current();$('board-view').hidden=brain||!current()||$('tab-team').getAttribute('aria-selected')==='true';$('team-view').hidden=brain||!current()||$('tab-team').getAttribute('aria-selected')!=='true';
  $('studio-board-nav').classList.toggle('active',!brain&&$('tab-board').getAttribute('aria-selected')==='true');$('studio-team-nav').classList.toggle('active',$('tab-team').getAttribute('aria-selected')==='true');const p=current();$('sidebar-new-brief').disabled=!p;$('member-count').textContent=p?p.roles.filter(r=>r.enabled).length:0;if(!p)return;
  const runs=state.runs.filter(r=>r.projectId===p.id),pending=runs.filter(r=>!['accepted','cancelled'].includes(r.status));
  $('studio-demand-list').replaceChildren(...runs.map(r=>{const b=button('',()=>{activeRun=r.id;renderRun();show('run-dialog');},'studio-demand');b.append(node('strong','',r.title),node('small','',r.paused?'已暂停':labels[r.status]||r.status));return b;}));
  $('stats').replaceChildren(...[['制作需求',runs.length],['正在推进',pending.filter(r=>!r.paused&&!(allTasks(r).some(t=>['blocked','awaiting-review'].includes(t.status))||r.workflow?.error)).length],['待你处理',pending.filter(r=>r.paused||['plan-review','review'].includes(r.status)||allTasks(r).some(t=>['blocked','awaiting-review'].includes(t.status))||!!r.workflow?.error).length],['已完成',runs.filter(r=>r.status==='accepted').length]].map(([label,value])=>{const n=node('div','stat');n.append(node('span','',label),node('strong','',value));return n;}));
  $('runs').replaceChildren(...runs.map(r=>{
    const card=button('',()=>{activeRun=r.id;renderRun();show('run-dialog');},'run-card');const head=node('div','run-head'),title=node('div');title.append(node('h3','',r.title));const blocked=allTasks(r).some(t=>['blocked','awaiting-review'].includes(t.status))||!!r.workflow?.error;head.append(title,pill(blocked?(allTasks(r).some(t=>t.status==='awaiting-review')?'awaiting-review':'blocked'):r.status,r.paused?'已暂停':r.autoAccepted?'已交付':undefined));
    const count=r.tasks.filter(t=>t.status==='done').length,skipped=r.tasks.filter(t=>t.status==='skipped').length,progress=node('div','progress'),bar=node('i');bar.style.width=(r.tasks.length?(count+skipped)/r.tasks.length*100:0)+'%';progress.append(bar);const footer=node('div','run-footer');footer.append(node('span','',r.tasks.length?`${count} / ${r.tasks.length} 个制作任务完成${skipped?' · '+skipped+' 项跳过':''}`:'统筹正在拆解需求'),node('time','',date(r.createdAt)));
    card.append(head,node('p','excerpt',r.brief),progress,footer);return card;
  }));
  if(!runs.length){const empty=node('div','panel run-empty');empty.append(node('h3','','制作看板已就绪'),node('p','muted','提出一个具体需求，交给你的游戏团队。'),button('＋ 提出第一个需求',openBrief,'primary'));$('runs').append(empty);}
  const host=hostOf(p),project=host?.projects.find(x=>x.id===p.projectId);$('team-info').textContent=[p.name,host?.name+(host?.online?' · 在线':' · 离线'),project?.name+' · '+((project?.roots??[project?.path])[p.workspaceIndex]||''),`${p.concurrency} 个任务同时执行`,p.reviewPlan?'先确认计划':'自动分发计划'].join(' / ');
  $('team-grid').replaceChildren(...p.roles.map(a=>{const role=state.roles.find(r=>r.id===a.role),card=node('article','panel member'+(!a.enabled?' disabled':''));card.append(roleAvatar(p.id,a.role,role.name),node('h3','',role.name),node('p','muted',role.description),node('div','agent-name',a.enabled?agentLabel(a,host)+(a.model?' / '+a.model:' / 默认模型'):'未启用'));if(a.enabled){const latest=state.runs.find(r=>r.projectId===p.id);if(latest)card.append(button('打开角色对话',()=>chats.open(latest.id,a.role)));}return card;}));
}
const brainstorms=studioBrainstorm({configureLaunch:proposal=>openBrief(proposal),snapshot:()=>({state,relay}),api,refresh,current,notify,openRun:id=>{if($('brainstorm-dialog').open)$('brainstorm-dialog').close();activeRun=id;renderRun();show('run-dialog');}});
$('tab-brainstorm').onclick=$('studio-brainstorm-nav').onclick=()=>{for(const key of ['board','team','brainstorm']){$('tab-'+key).setAttribute('aria-selected',String(key==='brainstorm'));$('tab-'+key).classList.toggle('active',key==='brainstorm');}render();};
function agentLabel(a,host){return host?.agents?.find(x=>x.id===a.agentId)?.name||(a.provider==='codex'?'Codex':a.provider==='claude'?'Claude Code':a.agentId||'API Agent');}
function tab(team){$('tab-brainstorm').setAttribute('aria-selected','false');$('tab-brainstorm').classList.remove('active');$('tab-team').setAttribute('aria-selected',String(team));$('tab-board').setAttribute('aria-selected',String(!team));$('tab-team').classList.toggle('active',team);$('tab-board').classList.toggle('active',!team);render();}
function syncBrowse(){const local=!!desktopHostId&&$('team-host').value===desktopHostId;$('team-browse').hidden=!local;}
function hostProjects(desiredProject,desiredWorkspace=0){const host=relay.hosts.find(h=>h.id===$('team-host').value);$('team-project').replaceChildren(...(host?.projects??[]).map(p=>option(p.id,p.name)),option('__new__','自定义工程（下方指定路径）'));if(desiredProject&&host?.projects.some(p=>p.id===desiredProject))$('team-project').value=desiredProject;workspaces(desiredWorkspace);$('team-path').placeholder=host?.platform?.startsWith('win')?'例如：E:\\Projects\\MyGame':'例如：/Users/you/Projects/MyGame';syncBrowse();}
function workspaces(index=0,updatePath=true){
  const host=relay.hosts.find(h=>h.id===$('team-host').value),p=host?.projects.find(p=>p.id===$('team-project').value);
  $('team-workspace').replaceChildren(...(p?.roots??(p?[p.path]:[])).map((path,i)=>option(String(i),path)));
  if(!p)$('team-workspace').append(option('','使用下方自定义工程路径'));
  $('team-workspace').value=p?String(index):'';$('team-workspace').required=!!p;$('team-workspace').disabled=!p;
  if(updatePath)$('team-path').value=p?(p.roots??[p.path])[index]||p.path:'';
  updatePathNote(p);
}
function updatePathNote(project){$('team-path-note').textContent=project?'已匹配工程：'+project.name+'。每个需求将在独立工作副本中执行。':$('team-path').value.trim()?'自定义源工程；保存后登记，每个需求创建独立分支和工作副本。':'输入工程文件夹绝对路径，或选择一个已有工程。';}
function syncProjectFromPath(){
  const host=relay.hosts.find(h=>h.id===$('team-host').value),match=matchingStudioProject(host,$('team-path').value,$('team-project').value),project=host?.projects.find(p=>p.id===match?.projectId);
  if(project&&![...$('team-project').options].some(o=>o.value===project.id))$('team-project').append(option(project.id,project.name));
  $('team-project').value=match?.projectId??'__new__';workspaces(match?.workspaceIndex??0,false);
}

function choices(host){return host?.agents?.filter(a=>a.configured!==false&&(a.provider!=='api'||a.tools))??[{id:'codex',provider:'codex',name:'Codex'},{id:'claude',provider:'claude',name:'Claude Code'}];}
function roleEditor(role,assignment){
  const host=relay.hosts.find(h=>h.id===$('team-host').value),available=choices(host),defaultAgent=available.find(a=>a.provider===(['director','gameplay','level','balance','systems','concept'].includes(role.id)?'claude':'codex'))??available[0];
  const a=assignment??{role:role.id,enabled:true,provider:defaultAgent?.provider||'codex',agentId:defaultAgent?.provider==='api'?defaultAgent.id:undefined,instructions:'',tools:''};
  const card=node('section','role-editor');card.dataset.role=role.id;const top=node('div','role-top'),enabled=node('input');enabled.type='checkbox';enabled.checked=a.enabled;enabled.dataset.field='enabled';enabled.disabled=['director','qa'].includes(role.id);const label=node('label','check');label.append(enabled,document.createTextNode(role.name));top.append(label,node('span','',['director','qa'].includes(role.id)?'必需职能':'可选职能'));card.append(top);
  const fields=node('div','agent-fields'),agent=node('select'),model=node('select'),effort=node('select');agent.dataset.field='agent';model.dataset.field='model';effort.dataset.field='effort';agent.setAttribute('aria-label',role.name+' Agent');model.setAttribute('aria-label',role.name+' 模型');effort.setAttribute('aria-label',role.name+' 思考强度');
  agent.replaceChildren(...available.map(v=>option(v.provider+':'+(v.provider==='api'?v.id:''),v.name)));const desired=a.provider+':'+(a.provider==='api'?(a.agentId||''):'');if(![...agent.options].some(x=>x.value===desired))agent.append(option(desired,agentLabel(a,host)+' · 当前不可用'));agent.value=desired;
  model.append(option('','本机默认模型'));if(a.model)model.append(option(a.model,a.model));model.value=a.model||'';for(const [v,l] of [['','默认'],['low','低'],['medium','中'],['high','高'],['xhigh','很高'],['max','最高'],['ultra','Ultra']])effort.append(option(v,l));effort.value=a.effort||'';
  for(const [title,input] of [['Agent',agent],['模型',model],['思考强度',effort]]){const label=node('label','',title);label.append(input);fields.append(label);}card.append(fields);
  const details=node('details'),summary=node('summary','','职责、工具与本机命令');details.append(summary);for(const [key,title,placeholder] of [['instructions','职能补充说明',role.description],['tools','引擎 / DCC / 工具说明','例如：Godot 命令、Blender 路径、资源构建脚本、已配置的 MCP']]){const l=node('label','',title),input=node('textarea');input.rows=3;input.maxLength=2500;input.dataset.field=key;input.value=a[key]||'';input.placeholder=placeholder;l.append(input);details.append(l);}card.append(details);
  enabled.onchange=()=>card.setAttribute('aria-disabled',String(!enabled.checked));enabled.onchange();
  let modelsLoaded=false,loading=0;
  const loadModels=async()=>{if(modelsLoaded)return;const stamp=++loading;const [provider,agentId]=agent.value.split(':');try{const result=await api('models?'+new URLSearchParams({hostId:$('team-host').value,provider,...agentId?{agentId}:{}}));if(stamp!==loading)return;const value=model.value;model.replaceChildren(option('','本机默认模型'),...result.models.map(m=>option(m.id,m.name||m.id)));if(value&&![...model.options].some(o=>o.value===value))model.append(option(value,value));model.value=value;card._models=result.models;modelsLoaded=true;}catch(e){notify('模型读取失败：'+e.message);}};
  model.onfocus=()=>void loadModels();agent.onchange=()=>{loading++;modelsLoaded=false;model.replaceChildren(option('','本机默认模型'));effort.value='';if(document.activeElement===agent)void loadModels();};
  model.onchange=()=>{const supported=card._models?.find(m=>m.id===model.value)?.efforts;for(const o of effort.options)o.disabled=!!o.value&&!!supported&&!supported.includes(o.value);if(effort.selectedOptions[0]?.disabled)effort.value='';};return card;
}
function assignments(){return [...$('role-editors').children].map(card=>{const field=k=>card.querySelector(`[data-field="${k}"]`),[provider,agentId]=field('agent').value.split(':');return {role:card.dataset.role,enabled:field('enabled').checked,provider,agentId:agentId||undefined,model:field('model').value||undefined,effort:field('effort').value||undefined,instructions:field('instructions').value,tools:field('tools').value};});}
function readToolchain(){return {blender:$('tool-blender').value,python:$('tool-python').value,engine:$('tool-engine').value,discoveryScript:$('tool-discovery').value,pythonPaths:$('tool-python-paths').value.split(/\r?\n/).filter(x=>x.trim()),searchRoots:$('tool-search-roots').value.split(/\r?\n/).filter(x=>x.trim())};}
$('save-toolchain').onclick=async()=>{$('save-toolchain').disabled=true;try{await api('studio/toolchain',{projectId:editing,toolchain:readToolchain()});await refresh(true);$('toolchain-note').textContent='已保存，后续制作和原任务复核将使用这些路径。';}catch(e){$('toolchain-note').textContent=e.message;}finally{$('save-toolchain').disabled=!editing;}};
function openTeam(p){editing=p?.id||null;$('save-toolchain').disabled=!editing;$('toolchain-note').textContent=editing?'可在制作过程中单独更新工具环境；已有任务和审批会保留。':'新团队请先保存团队。';$('team-dialog-title').textContent=p?'团队配置':'组建游戏团队';$('team-error').textContent='';$('team-name').value=p?.name||'';$('team-host').replaceChildren(...relay.hosts.map(h=>option(h.id,h.name+(h.online?' · 在线':' · 离线'))));if(p)$('team-host').value=p.hostId;else if(relay.hosts.some(h=>h.id===desktopHostId))$('team-host').value=desktopHostId;else if(relay.hosts.some(h=>h.online))$('team-host').value=relay.hosts.find(h=>h.online).id;hostProjects(p?.projectId,p?.workspaceIndex);$('team-concurrency').value=p?.concurrency||1;$('team-permission').value=p?.permissionMode||'request';$('team-review').checked=p?.reviewPlan??true;$('team-create-folder').checked=false;$('team-include-captures').checked=p?.includeCaptures??false;for(const [field,key] of [['tool-blender','blender'],['tool-python','python'],['tool-engine','engine'],['tool-discovery','discoveryScript'],['tool-python-paths','pythonPaths'],['tool-search-roots','searchRoots']])$(field).value=Array.isArray(p?.toolchain?.[key])?p.toolchain[key].join('\n'):p?.toolchain?.[key]||'';$('role-editors').replaceChildren(...state.roles.map(r=>roleEditor(r,p?.roles.find(a=>a.role===r.id))));if(!relay.hosts.length)$('team-error').textContent='尚未连接工作电脑，请先启动本机连接程序。';show('team-dialog');}
let briefProposal=null,briefParent=null,briefRequest=null;
function briefDraftKey(){return briefParent?'relay-studio-continuation:'+briefParent.id:briefProposal?'relay-proposal-flow:'+briefProposal.proposalId:'relay-studio-brief:'+current().id;}
function briefContext(){const p=current();return p?{key:briefParent?'continuation:'+briefParent.id:p.id,target:{hostId:p.hostId,projectId:p.projectId}}:null;}
function openContinuation(r){
  if(r.status!=='accepted'||r.workspace?.status!=='ready')return;
  selected=r.projectId;selectedProject();render();openBrief({parentRun:r});
}
function openBrief(proposal){
  briefProposal=proposal?.proposalId?proposal:null;briefParent=proposal?.parentRun??null;
  const p=current();if(!p)return openTeam();
  const draft=JSON.parse(localStorage.getItem(briefDraftKey())||'{}');briefRequest=draft.request??null;
  briefAttachments.render();$('brief-dialog-title').textContent=briefParent?'基于本次交付继续制作':'提出制作需求';
  $('brief-team').textContent=p.name+' · 本需求按下面所选环节和审批执行';$('brief-error').textContent='';
  const source=$('brief-source');source.hidden=!briefParent;source.replaceChildren();
  if(briefParent)source.append(node('strong','','继承：'+briefParent.title),node('p','fine','从这次交付的工作副本创建新分支，带入设计、资产和交付上下文。原任务与审批记录保留；以下流程、审批可以重新选择。'),node('code','',briefParent.workspace.value.project.path));
  $('brief-title').readOnly=!!briefProposal;$('brief-text').readOnly=!!briefProposal;$('brief-attach').hidden=!!briefProposal;$('brief-files').hidden=!!briefProposal||!briefAttachments.count;
  const defaults=briefParent?{title:(briefParent.title+' · 后续制作').slice(0,160),brief:'基于上游已交付的设计与资产继续制作。请把选定方案实际组装成游戏场景，接入游戏的可玩入口，复用已有玩法与资源，不重做已完成的原画和模型。交付 Windows 本机试玩的工作副本路径及可用启动命令或脚本；实际运行新场景并提供截图、展示视频和验收记录。具体选择哪个方案、关卡数量及细节可在这里补充。',workflow:'scene-reuse',reuseReason:'复用上游需求 '+briefParent.id+'「'+briefParent.title+'」已确认的视觉设计及已交付资产，先核对继承文件和交付说明。',flowConfig:{template:'custom',stages:['assembly','integration','validation'],approvals:{plan:true,design:false,visual:false,scene:true,final:true}}}:{};
  $('brief-title').value=briefProposal?.title??draft.title??defaults.title??'';$('brief-text').value=briefProposal?.brief??draft.brief??defaults.brief??'';
  $('brief-workflow').value=draft.workflow||briefProposal?.workflow||defaults.workflow||'auto';$('brief-reuse').value=draft.reuseReason??defaults.reuseReason??'';$('brief-record-video').checked=draft.recordVideo??true;
  renderBriefFlow(draft.flowConfig||defaults.flowConfig||flowPreset('full-scene'));syncBriefWorkflow();show('brief-dialog');
}
async function command(r,op,extra={}){await api('studio/command',{runId:r.id,op,...extra});await refresh(true);notify({pause:'已暂停后续任务分发',resume:'已继续分发任务','continue-run':'已从原会话断点继续，已完成任务保持不变','continue-task':'已安排原任务从断点继续','recheck-task':'已安排在原会话复核阻断，保留已完成前置任务',accept:'制作人验收通过','approve-plan':'计划已确认，开始制作',cancel:'已取消需求，停止结果请查看记录',bind:'已绑定会话'}[op]||'操作已保存');}
function producerReview(r,t){const box=node('section','producer-review');box.append(node('h3','',t.title),pill(t.status));for(const up of r.tasks.filter(x=>t.dependencies.includes(x.id))){box.append(node('h3','',up.title));if(up.summary)box.append(node('p','delivery-copy',up.summary));box.append(button('查看交付与执行记录',()=>openTask(r,up)));for(const a of up.artifacts??[]){const row=node('div','artifact');row.append(node('code','',a.path),node('p','fine',a.description));if(/\.(png|jpg|jpeg|webp|gif)$/i.test(a.path)&&up.sessionId){const img=node('img');img.loading='lazy';img.alt=a.description||'本轮实机交付';img.style.maxWidth='100%';img.src='/api/studio/artifact?'+new URLSearchParams({runId:r.id,taskId:up.id,index:String(up.artifacts.indexOf(a))});row.append(img);}box.append(row);}}if(t.status==='awaiting-review'&&!['accepted','cancelled'].includes(r.status)){const actions=node('div','run-actions');actions.append(button('批准并继续',()=>command(r,'approve-step',{taskId:t.id,reviewId:t.reviewId}),'primary'),button('打回修改',()=>feedbackFor(r,t,{op:'reject-step',reviewId:t.reviewId})));box.append(actions);}return box;}
function openTask(r,t){activeRun=r.id;activeTask=t.id;renderTask();show('task-dialog');}
async function inspectSkip(manual=false){
  if(skipLoading||feedbackSubmitting||!$('feedback-dialog').open||feedback?.op!=='skip-task'||!manual&&(Date.now()<skipRetryAt||skipFailures>=5))return;
  const generation=skipGeneration,target={...feedback},root=$('feedback-recovery');skipLoading=true;
  try{
    const value=await api('studio/skip-state?'+new URLSearchParams({runId:target.runId,taskId:target.taskId}),undefined,AbortSignal.timeout(12000));if(generation!==skipGeneration||!$('feedback-dialog').open)return;skipFailures=0;skipRetryAt=0;
    root.replaceChildren();const changed=value.expectedActionId!==target.expectedActionId||value.expectedFinishedAt!==target.expectedFinishedAt;
    $('feedback-submit').disabled=feedbackSubmitting||changed||!value.canSkip;
    root.append(node('p',value.canSkip&&!changed?'fine':'error',changed?'任务执行记录已变化，请关闭窗口后重新核对。':value.canSkip?value.notDispatched?'本轮在预检阶段结束，执行日志确认尚未投递；没有正在执行或排队的会话，可以确认跳过。':value.finishedHistory?'本任务已结束，目前仅保留历史记录，无需停止，可以确认跳过。':'执行已结束且没有未确认投递，可以确认跳过。':'请在下面处理阻挡项。停止请求确认后仍需等待状态结束，再确认跳过。'));
    for(const b of value.blockers){
      const row=node('section','workspace-summary');row.append(node('strong','',b.title),node('p','fine',b.message));
      if(b.sessionId){const a=link('打开对应会话核对 ↗','/?sessionId='+encodeURIComponent(b.sessionId));a.target='_blank';a.rel='noopener';row.append(a);}
      for(const queueOnly of [false,true])if(b.sessionId&&(queueOnly?b.canCancelQueue:b.canStop)){
        const key=b.sessionId+':'+queueOnly,previous=skipStops.get(key),stop=button(previous?.pending?'停止请求处理中…':previous?.done?'请求已确认，等待状态更新':previous?.error?'重新核对停止回执':queueOnly?'取消此会话排队':'停止此会话执行',async()=>{
          const operation=skipStops.get(key)??{id:crypto.randomUUID()};skipStops.set(key,operation);operation.pending=true;stop.disabled=true;
          try{await api('actions',{id:operation.id,type:'stop',sessionId:b.sessionId,...queueOnly?{queueOnly:true}:{}} ,AbortSignal.timeout(30000));operation.done=true;operation.error='';if(generation===skipGeneration)$('feedback-error').textContent='停止/取消请求已确认，正在等待会话状态更新；不会自动跳过。';await refresh(true);}
          catch(e){operation.error=e.message;if(generation===skipGeneration)$('feedback-error').textContent='停止结果需核对：'+e.message+'。请打开对应会话查看，不会自动重复停止。';}
          finally{operation.pending=false;if(generation===skipGeneration)void inspectSkip();}
        });stop.disabled=!!(previous?.pending||previous?.done);row.append(stop);if(previous?.error)row.append(node('p','error',previous.error));
      }
      if(b.kind==='active'&&b.sessionId&&!b.canStop)row.append(node('p','fine','当前没有可用的远程停止入口；请打开对应本机会话停止，结束后点下方刷新核对。'));
      if(b.taskId&&b.kind==='receipt')row.append(button('查看任务并核对绑定',()=>{$('feedback-dialog').close();const r=state.runs.find(r=>r.id===target.runId),t=r&&allTasks(r).find(t=>t.id===b.taskId);if(t)openTask(r,t);}));
      root.append(row);
    }
    root.append(button('刷新核对状态',()=>inspectSkip(true)));
  }catch(e){if(generation===skipGeneration){skipFailures++;skipRetryAt=Date.now()+60000;$('feedback-submit').disabled=true;root.replaceChildren(node('p','error','状态核对失败：'+e.message+(skipFailures<5?'；一分钟后重试（'+skipFailures+'/5），也可手动核对。':'；已尝试 5 次，请检查连接后手动核对。')),button('重新核对',()=>{skipFailures=0;return inspectSkip(true);}));}}
  finally{skipLoading=false;}
}
$('feedback-dialog').addEventListener('close',()=>{clearInterval(skipTimer);skipGeneration++;});
function feedbackFor(r,t,extra={}){
  const skip=extra.op==='skip-task',accept=extra.op==='accept';feedback={runId:r.id,taskId:t.id,...extra,...skip?{expectedActionId:t.actionId??null,expectedFinishedAt:t.finishedAt??null}:{}};
  $('feedback-title').textContent=skip?'跳过并继续下一步':accept?'确认遗留问题并验收':extra.op==='reject-visual'?'修改场景原画':extra.op==='reject-step'?'打回修改':'返工 / 重试';
  $('feedback-text').value='';$('feedback-text').required=!accept;$('feedback-text').placeholder=skip?'填写跳过原因，遗留问题将交给后续 QA 核查。':accept?'可补充对跳过任务和遗留问题的验收说明。':'说明需要修正的问题或环境已恢复。';
  $('feedback-note').textContent=skip?'将此任务标为“制作人已跳过”，恢复分发满足依赖的后续任务。保留当前失败、文件和执行记录，QA 仍按实际结果验收；不会重跑已完成前置任务。':accept?'确认你已查看交付报告中的跳过记录及遗留问题。跳过任务仍显示为跳过，原失败记录继续保留。':'重新执行此任务及依赖它的后续任务，旧执行记录会保留。最终交付汇总的重试只重写汇总报告；产品问题请对具体制作任务返工。';
  $('feedback-submit').textContent=skip?'确认跳过并继续':accept?'确认遗留问题并验收':'确认返工';$('feedback-error').textContent='';$('feedback-target').textContent=t.title;show('feedback-dialog');
  clearInterval(skipTimer);skipGeneration++;skipStops.clear();skipFailures=0;skipRetryAt=0;feedbackSubmitting=false;let recovery=$('feedback-recovery');if(!recovery){recovery=node('section','task-section');recovery.id='feedback-recovery';$('feedback-error').before(recovery);}recovery.hidden=!skip;recovery.replaceChildren();$('feedback-submit').disabled=skip;if(skip){recovery.append(node('p','fine','正在核对执行、回执与排队状态…'));void inspectSkip();skipTimer=setInterval(()=>{if(!document.hidden)void inspectSkip();},2000);}
}
let renderedRunKey='';
function renderRun(){
  const r=state.runs.find(x=>x.id===activeRun);if(!r)return;
  publishStudioSidebar();
  // Keep in-flight image loads and object URLs alive across unchanged inventory polls.
  const children=state.runs.filter(x=>x.continuation?.parentRunId===r.id);
  const viewKey=JSON.stringify([r.id,r.revision,children.map(x=>[x.id,x.revision]),allTasks(r).map(t=>{const s=relay.sessions.find(s=>s.id===t.sessionId);return [s?.status,s?.questionCount,s?.pendingCount];})]);if(renderedRunKey===viewKey)return;renderedRunKey=viewKey;
  $('run-title').textContent=r.title;const root=$('run-content');disposeMedia(root);root.replaceChildren();const p=state.projects.find(p=>p.id===r.projectId),finished=['accepted','cancelled'].includes(r.status);
  const meta=node('div','task-info');meta.append(pill(r.status,r.autoAccepted?'已交付':undefined),node('span','',p?.name+' · '+date(r.createdAt)),...r.paused?[pill('blocked','已暂停后续分发')]:[]);root.append(meta,node('p','run-summary',r.brief));if(r.workflow?.selection){const f=r.workflow.selection;root.append(node('p','fine','本需求流程：'+f.stages.map(s=>flowStageNames[s]).join(' → ')+' · 制作人审批：'+(Object.entries(f.approvals).filter(([,v])=>v).map(([k])=>approvalNames[k]).join('、')||'无')));}
  if(r.status==='accepted'&&r.workspace?.status==='ready'){const next=node('div','run-actions');next.append(button('基于本次交付继续制作',()=>openContinuation(r),'primary'));root.append(next);}
  if(r.continuation){const c=r.continuation,section=node('section','workspace-summary');section.append(node('strong','','接续制作 · '+c.title),node('p','fine','从上游工作副本继承成果；本次在新分支独立制作、审批和验收。'),node('code','',c.source.path),node('p','fine',c.source.branch));const parent=state.runs.find(x=>x.id===c.parentRunId);if(parent)section.append(button('查看上游交付',()=>{activeRun=parent.id;renderRun();}));root.append(section);}
  if(children.length){const section=node('section','workspace-summary');section.append(node('strong','','后续制作'));for(const child of children)section.append(button(child.title+' · '+({planning:'拆解中','plan-review':'等你确认',executing:'制作中',delivery:'汇总中',review:'待验收',accepted:'已交付',cancelled:'已取消'}[child.status]||child.status),()=>{activeRun=child.id;renderRun();}));root.append(section);}
  const workspace=node('section','workspace-summary');workspace.append(node('strong','','需求独立分支'),node('p','',r.workspace?.value?.branch||({queued:'等待准备',preparing:'正在创建分支和工作副本',blocked:'准备失败'}[r.workspace?.status]||'未建立')));if(r.workspace?.value)workspace.append(node('code','',r.workspace.value.project.path),node('p','fine',`源分支 ${r.workspace.value.sourceBranch} · 保留未提交改动 ${r.workspace.value.trackedSnapshot?'是':'无'} · 复制未跟踪文件 ${r.workspace.value.untrackedFiles} 个 · 隔离子模块 ${r.workspace.value.submodules??0} 个 · 未复制测试截图 ${r.workspace.value.skippedCaptures??0} 个`));if(r.workspace?.error)workspace.append(node('p','error',r.workspace.error));if(r.workspace?.status==='blocked'&&!allTasks(r).some(t=>t.sessionId)&&!finished)workspace.append(button('重新核对工作副本',()=>command(r,'retry-workspace')));root.append(workspace);
  if(r.attachments?.length){const media=node('div','run-media');for(const file of r.attachments)media.append(mediaCard(file,{runId:r.id}));root.append(media);}
  const scene=scenePanel(r,{command,openTask,feedbackFor,notify});if(scene)root.append(scene);for(const gate of r.tasks.filter(t=>t.kind==='producer-review'&&t.status==='awaiting-review'))root.append(producerReview(r,gate));
  const channels=node('div','role-channels');channels.append(button('团队群聊 · 查看协作',()=>chats.open(r.id,'team'),'primary'));for(const a of p.roles.filter(a=>a.enabled))channels.append(button(roleName(a.role),()=>chats.open(r.id,a.role)));root.append(node('h3','','职能对话'),channels);
  const pipeline=node('div','pipeline'),f=r.workflow?.selection,stages=f?[['需求拆解',['planning']],...f.approvals.plan?[['计划审批',['plan-review']]]:[],['职能制作',['executing']],[f.stages.includes('validation')?'QA / 汇总':'汇总交付',['delivery']],[f.approvals.final?'制作人验收':'自动交付',['review','accepted']]]:[['需求拆解',['planning']],['计划确认',['plan-review']],['职能制作',['executing']],['QA / 汇总',['delivery']],['制作人验收',['review','accepted']]],index=stages.findIndex(s=>s[1].includes(r.status));stages.forEach((s,i)=>pipeline.append(node('div','stage'+(i===index?' current':i<index?' passed':''),String(i+1).padStart(2,'0')+' '+s[0])));root.append(pipeline);
  const actions=node('div','run-actions');if(!finished){if(allTasks(r).some(t=>t.status==='blocked'&&t.checkpoint))actions.append(button('从断点继续',()=>command(r,'continue-run'),'primary'));if(r.status==='plan-review')actions.append(button('确认计划，开始制作',()=>command(r,'approve-plan'),'primary'),button('调整拆解计划',()=>feedbackFor(r,r.planner)));if(r.status==='review')actions.append(button(r.tasks.some(t=>t.status==='skipped')?'确认遗留问题并验收':'验收通过',()=>r.tasks.some(t=>t.status==='skipped')?feedbackFor(r,r.delivery,{op:'accept',acknowledgeSkipped:true}):command(r,'accept'),'primary'),button('查看交付报告',()=>openTask(r,r.delivery)));actions.append(button(r.paused?'继续分发':'暂停分发',()=>command(r,r.paused?'resume':'pause')));const cancel=button('取消需求',()=>command(r,'cancel'));let armed=false;cancel.onclick=()=>{if(!armed){armed=true;cancel.textContent='再次点击确认取消';setTimeout(()=>{armed=false;cancel.textContent='取消需求';},5000);}else void command(r,'cancel').catch(e=>notify(e.message));};actions.append(cancel);}root.append(actions);
  if(r.tasks.length&&r.tasks.every(x=>['done','skipped'].includes(x.status))&&!r.tasks.some(x=>x.showcase))root.append(button('补录成果展示视频',()=>command(r,'record-showcase')));
  const tasks=node('div','task-list');allTasks(r).forEach((t,i)=>{const s=relay.sessions.find(s=>s.id===t.sessionId),row=button('',()=>openTask(r,t),'task-row'),body=node('div');body.append(node('div','task-heading',t.title),node('small','',(t.kind?'制作人确认':roleName(t.role))+(t.stage?' · '+sceneStageName(t.stage):'')+(t.dependencies.length?' · 依赖 '+t.dependencies.join(', '):' · 无前置依赖')));if(t.skip)body.append(node('small','','跳过原因：'+t.skip.reason));if(t.error)body.append(node('div','error',t.error.slice(0,180)));row.append(node('span','task-number',String(i+1).padStart(2,'0')),body,pill(t.status,s?.status==='waiting'?'等待确认':s?.questionCount?'待回答问题':undefined));tasks.append(row);});root.append(tasks);
  if(r.status==='review'&&r.delivery?.summary){const result=node('section','task-section');result.append(node('h3','','交付摘要'),node('div','delivery-copy',r.delivery.summary));root.append(result);}
  const log=node('details','run-log');log.append(node('summary','','制作记录 · '+r.log.length));[...r.log].reverse().forEach(l=>{const row=node('div','log-row');row.append(node('time','',date(l.at)),node('span','',(l.taskId?'['+l.taskId+'] ':'')+l.text));log.append(row);});root.append(log);
}
let renderedTaskKey='';
function renderTask(){
  publishStudioSidebar();
  const r=state.runs.find(x=>x.id===activeRun),t=r&&allTasks(r).find(t=>t.id===activeTask);if(!r||!t)return;const s=relay.sessions.find(s=>s.id===t.sessionId),finished=['accepted','cancelled'].includes(r.status);const taskKey=JSON.stringify([r.id,r.status,t,s?.status,s?.questionCount, t.id==='studio-delivery'?r.tasks.map(x=>[x.id,x.sessionId,x.artifacts]):null]);if(taskKey===renderedTaskKey)return;renderedTaskKey=taskKey;$('task-title').textContent=t.title;const root=$('task-content');disposeMedia(root);root.replaceChildren();if(t.kind==='visual-review'){root.append(scenePanel(r,{command,openTask,feedbackFor,notify}));return;}if(t.kind==='producer-review'){root.append(producerReview(r,t));return;}const meta=node('div','task-info');meta.append(pill(t.status),node('span','',roleName(t.role)),node('span','',t.startedAt?date(t.startedAt):'等待分发'));root.append(meta);
  const actions=node('div','run-actions');if(t.sessionId)actions.append(button('与该职能对话',()=>chats.open(r.id,t.role,t.sessionId)));if(t.sessionId)actions.append(link(s?.status==='waiting'?'打开会话，处理确认 ↗':'打开完整执行记录 ↗','/?sessionId='+encodeURIComponent(t.sessionId)));if(!finished&&t.status==='blocked'&&t.sessionId&&!t.checkpoint)actions.append(button('复核阻断并继续原任务',()=>command(r,'recheck-task',{taskId:t.id}),'primary'));if(!finished&&t.status==='blocked'&&t.checkpoint)actions.append(button('从断点继续',()=>command(r,'continue-task',{taskId:t.id}),'primary'));if(!finished&&t.status==='blocked'&&r.tasks.includes(t)&&t.role!=='qa')actions.append(button('跳过并继续下一步',()=>feedbackFor(r,t,{op:'skip-task'})));if(!finished&&['blocked','done','skipped'].includes(t.status))actions.append(button(t.status==='blocked'?'处理 / 重试':'要求返工',()=>feedbackFor(r,t)));root.append(actions);
  if(t.feedback){const section=node('section','workspace-summary'),notes=[...new Set([r.feedback,t.feedback].filter(Boolean))].join('\n\n').replace(/^\[scene-correction-[^\]]+\]\s*/,'');section.append(node('strong','','本轮返工要求'),node('p','fine',notes.slice(0,220)+(notes.length>220?'…':'')));if(notes.length>220){const details=node('details','task-section');details.append(node('summary','','查看完整返工要求'),node('div','delivery-copy',notes));section.append(details);}section.append(node('p','fine','本轮制作人意见优先；下方原任务说明保留用于追溯。'));root.append(section);}
  if(t.skip){const section=node('section','workspace-summary');section.append(node('strong','','制作人已跳过 · '+date(t.skip.at)),node('p','',t.skip.reason),node('p','fine','原验收失败记录保留；后续任务继续执行，跳过不代表验收通过。'));root.append(section);}
  if(t.blockers?.length){const blockers=node('section','task-section');blockers.append(node('h3','','阻断原因与恢复步骤'));for(const b of t.blockers){const item=node('div','workspace-summary');item.append(node('strong','',({environment:'工具环境',provenance:'构建来源',upstream:'上游变化',quality:'质量验收',other:'其他'}[b.category]||b.category)+' · '+b.code),node('p','',b.details),node('p','fine','恢复：'+b.remedy));blockers.append(item);}root.append(blockers);}if(t.checkpoint)root.append(node('p','fine',`断点保存于 ${date(t.checkpoint.at)} · 原分支、原会话及已完成前置任务均保留`));if(t.checkpoint?.reason){const cause=node('section','task-section');cause.append(node('h3','','执行中断原因'),node('p','error',t.checkpoint.reason));if(/model.*capacity|capacity.*model/i.test(t.checkpoint.reason))cause.append(node('p','fine','当前模型服务繁忙。可在完整会话中切换可用模型后继续，或稍后重试；已有文件和前置任务保留。'));root.append(cause);}if(t.error)root.append(node('p','error',t.error));if(t.status==='blocked'&&!t.sessionId&&!finished){const p=state.projects.find(x=>x.id===r.projectId),candidates=relay.sessions.filter(s=>s.hostId===p.hostId&&s.projectId===r.workspace?.value?.project?.id&&s.updatedAt>=(t.startedAt??r.createdAt)&&!state.runs.some(x=>allTasks(x).some(t=>t.sessionId===s.id)));if(candidates.length){const select=node('select','session-select');select.append(option('','投递结果不确定？选择核对后的会话…'),...candidates.map(s=>option(s.id,s.title)));select.setAttribute('aria-label','绑定已核对的任务会话');root.append(select,button('绑定已核对会话',()=>command(r,'bind',{taskId:t.id,sessionId:select.value})));}}
  if(t.recovery){const recovery=t.recovery,section=node('section','workspace-summary');section.append(node('strong','','模型连接恢复'),node('p','fine',`自动重试 ${recovery.retries}/5 · 接力会话 ${recovery.handoffs}/1`));section.append(node('p','',recovery.phase==='waiting-input'?'等待制作人回答问题或工具批准':recovery.phase==='scheduled'?'下次尝试：'+date(recovery.nextAt):recovery.phase==='retrying'?'已在原会话重试':recovery.phase==='handoff'?'已安排新会话接力，沿用原工作副本':'已停止自动恢复'));if(recovery.note)section.append(node('p','fine',recovery.note));if(recovery.handoff)section.append(link('查看接力前的原会话 ↗','/?sessionId='+encodeURIComponent(recovery.handoff.sessionId)));root.append(section);}
  for(const [title,content] of [[t.feedback?'原任务说明':'任务说明',t.brief],['验收标准',t.acceptance],['交付摘要',t.summary]])if(content){const section=node('section','task-section');section.append(node('h3','',title),node('div','delivery-copy',content));root.append(section);}
  root.append(deliveryMedia(r,t));
  if(t.artifacts?.length){const section=node('section','task-section');section.append(node('h3','','交付物 · 工程中的文件'));for(const a of t.artifacts){const row=node('div','artifact');row.append(node('code','',a.path),node('p','',a.description));section.append(row);}root.append(section);}
  if(t.checks?.length){const section=node('section','task-section'),list=node('ul','checks');section.append(node('h3','','Agent 提交的实际验证记录'));for(const c of t.checks)list.append(node('li','',c));section.append(list);root.append(section);}
  if(t.output){const raw=node('details','task-section');raw.append(node('summary','','完整交付回复'),node('pre','',t.output));root.append(raw);}
  if(t.attempts?.length){const attempts=node('section','task-section');attempts.append(node('h3','','历史执行'));for(const [i,a]of t.attempts.entries()){const row=node('div','artifact');row.append(node('p','',`第 ${i+1} 次 · ${date(a.at)}`));if(a.sessionId)row.append(link('查看旧记录 ↗','/?sessionId='+encodeURIComponent(a.sessionId)));attempts.append(row);}root.append(attempts);}

}
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>$(b.dataset.close).close();
$('project-picker').onchange=()=>{selected=$('project-picker').value;selectedProject();render();};$('tab-board').onclick=()=>tab(false);$('tab-team').onclick=()=>tab(true);
$('new-team').onclick=()=>openTeam();$('empty-create').onclick=()=>openTeam();$('edit-team').onclick=()=>openTeam(current());$('new-brief').onclick=openBrief;$('sidebar-new-brief').onclick=openBrief;$('studio-board-nav').onclick=()=>tab(false);$('studio-team-nav').onclick=()=>tab(true);
$('team-host').onchange=()=>{const old=assignments();hostProjects();$('role-editors').replaceChildren(...state.roles.map(r=>roleEditor(r,old.find(a=>a.role===r.id))));};$('team-project').onchange=()=>{workspaces();syncProjectFromPath();};
$('team-workspace').onchange=()=>{const host=relay.hosts.find(h=>h.id===$('team-host').value),project=host?.projects.find(p=>p.id===$('team-project').value);$('team-path').value=(project?.roots??[project?.path])[Number($('team-workspace').value)]||'';syncProjectFromPath();};
$('team-path').oninput=syncProjectFromPath;
$('team-path').onchange=syncProjectFromPath;
$('team-browse').onclick=async()=>{try{const result=await window.relayStudioDesktop.pickDirectory($('team-path').value);if(!result.cancelled&&result.hostId===$('team-host').value){$('team-path').value=result.path;syncProjectFromPath();}}catch(e){$('team-error').textContent=e.message;}};
$('team-form').onsubmit=async e=>{
  e.preventDefault();$('team-save').disabled=true;$('team-error').textContent='';
  try{
    const hostId=$('team-host').value,host=relay.hosts.find(h=>h.id===hostId),path=$('team-path').value.trim();
    let target=matchingStudioProject(host,path,$('team-project').value);
    if(!target){
      const registration=studioProjectRegistration(host,path,$('team-create-folder').checked,crypto.randomUUID());
      const {project}=await api('actions',registration);await refresh(true);
      const updated=relay.hosts.find(h=>h.id===hostId);if(updated&&!updated.projects.some(p=>p.id===project.id))updated.projects.push(project);
      hostProjects(project.id,0);target={projectId:project.id,workspaceIndex:0};
    }
    const value={id:editing||undefined,name:$('team-name').value,hostId,...target,concurrency:Number($('team-concurrency').value),permissionMode:$('team-permission').value,reviewPlan:$('team-review').checked,includeCaptures:$('team-include-captures').checked,toolchain:readToolchain(),roles:assignments()};
    const result=await api('studio/project',value);selected=result.project.id;await refresh(true);$('team-dialog').close();notify('团队与工程路径已保存，可以提出制作需求了');
  }catch(e){$('team-error').textContent=e.message;}finally{$('team-save').disabled=false;}
};
const chats=studioChat({snapshot:()=>({state,relay}),api,refresh,roleName,notify});
const briefAttachments=new AttachmentInput($('brief-form'),$('brief-attach'),$('brief-files'),()=>briefContext(),message=>{$('brief-error').textContent=message||'';},{clipboardFiles});
const flowStageNames={requirements:'玩法 / 关卡设计',concept:'原画 / 视觉方案','asset-spec':'资产清单 / 规格',assets:'模型 / 材质生产',balance:'数值设计',implementation:'程序实现',assembly:'关卡 / 场景搭建',integration:'整合与实测',validation:'QA 验证'};
const approvalNames={plan:'拆解计划审批',design:'关卡 / 玩法设计审批',visual:'原画视觉审批',scene:'实机场景 / 关卡审批',final:'最终交付审批'};
function flowPreset(template){const stages={"full-scene":Object.keys(flowStageNames),levels:['requirements','implementation','assembly','integration','validation'],design:['requirements'],code:['implementation','integration','validation'],custom:['requirements','implementation','validation']}[template]||Object.keys(flowStageNames);return {template,stages,approvals:{plan:template==='design'?false:current()?.reviewPlan??true,design:template==='levels'||template==='design',visual:template==='full-scene',scene:template==='levels',final:template!=='design'}};}
function readBriefFlow(){return {template:$('brief-template').value,stages:[...$('brief-stages').querySelectorAll('input:checked')].map(i=>i.value),approvals:Object.fromEntries([...$('brief-approvals').querySelectorAll('input')].map(i=>[i.value,i.checked]))};}
function renderBriefFlow(flow){$('brief-template').value=flow.template;for(const [id,values,selected] of [['brief-stages',flowStageNames,key=>flow.stages.includes(key)],['brief-approvals',approvalNames,key=>!!flow.approvals[key]]]){$(id).replaceChildren(...Object.entries(values).map(([key,name])=>{const label=node('label','check'),input=node('input');input.type='checkbox';input.value=key;input.checked=selected(key);input.onchange=()=>{if(id==='brief-stages')$('brief-template').value='custom';syncBriefFlow();saveBrief();};label.append(input,document.createTextNode(name));return label;}));}syncBriefFlow();}
function syncBriefFlow(){const flow=readBriefFlow();for(const key of ['design','visual','scene']){const input=$('brief-approvals').querySelector('input[value="'+key+'"]'),available=key==='design'?flow.stages.includes('requirements'):key==='visual'?flow.stages.includes('concept'):flow.stages.some(s=>['assembly','integration'].includes(s));input.disabled=!available;if(!available)input.checked=false;}const actual=readBriefFlow();$('brief-flow-preview').textContent='执行路线：'+(actual.stages.map(s=>flowStageNames[s]).join(' → ')||'请至少选择一个制作环节')+'。等待你审批：'+(Object.entries(actual.approvals).filter(([,v])=>v).map(([key])=>approvalNames[key]).join('、')||'无，完成后自动交付')+'。';}
$('brief-template').onchange=()=>{const template=$('brief-template').value;renderBriefFlow(flowPreset(template));if(template==='levels'){$('brief-workflow').value='scene-reuse';$('brief-reuse').value||='复用当前项目已有玩法、视觉与适用资产；实际制作本需求指定的新关卡，不以旧关卡充当交付。';}else if(template==='full-scene')$('brief-workflow').value='scene-new';else if(['design','code'].includes(template))$('brief-workflow').value='general';syncBriefWorkflow();saveBrief();};
function syncBriefWorkflow(){$('brief-reuse-label').hidden=$('brief-workflow').value!=='scene-reuse';$('brief-reuse').required=$('brief-workflow').value==='scene-reuse';}

$('brief-record-video').onchange=()=>saveBrief();
$('brief-workflow').onchange=()=>{syncBriefWorkflow();saveBrief();};$('brief-reuse').oninput=()=>saveBrief();
function saveBrief(){if(!current())return;const draft={workflow:$('brief-workflow').value,reuseReason:$('brief-reuse').value,flowConfig:readBriefFlow(),recordVideo:$('brief-record-video').checked};if(!briefProposal)Object.assign(draft,{title:$('brief-title').value,brief:$('brief-text').value});if(briefParent)draft.request=briefRequest;localStorage.setItem(briefDraftKey(),JSON.stringify(draft));}$('brief-title').oninput=saveBrief;$('brief-text').oninput=saveBrief;
$('brief-form').onsubmit=async e=>{
  e.preventDefault();$('brief-submit').disabled=true;$('brief-error').textContent='';
  try{
    const p=current(),context=briefContext(),draftKey=briefDraftKey();
    if(briefParent&&!(await api('studio')).features?.continuation)throw Error('服务器尚未支持继续制作，请刷新或等待更新完成后再提交；本次尚未创建需求。');
    const attachmentIds=briefProposal?[]:await briefAttachments.upload(context);
    const payload={projectId:p.id,title:$('brief-title').value,brief:$('brief-text').value,workflow:$('brief-workflow').value,reuseReason:$('brief-reuse').value,flowConfig:readBriefFlow(),recordVideo:$('brief-record-video').checked,attachmentIds};
    if(briefParent){payload.parentRunId=briefParent.id;const key=JSON.stringify(payload);if(briefRequest?.key!==key)briefRequest={key,id:crypto.randomUUID()};payload.requestId=briefRequest.id;saveBrief();}
    const result=briefProposal?await api('studio/brainstorm/launch',{topicId:briefProposal.topicId,proposalId:briefProposal.proposalId,workflow:payload.workflow,reuseReason:payload.reuseReason,flowConfig:payload.flowConfig,recordVideo:payload.recordVideo}).then(r=>({run:{id:r.runId}})):await api('studio/run',payload);
    if(briefParent&&(result.run.id!==briefRequest.id||result.run.continuation?.parentRunId!==briefParent.id))throw Error('服务器未确认继承上游，请先核对需求 '+result.run.id+'，不要重新提交；续做草稿已保留。');
    // Clear only after a confirmed creation receipt. An uncertain retry reuses requestId.
    if(!briefProposal)briefAttachments.clear(context.key);localStorage.removeItem(draftKey);briefProposal=null;briefParent=null;briefRequest=null;
    activeRun=result.run.id;$('brief-dialog').close();await refresh(true).catch(e=>notify('需求已创建；刷新状态失败，请稍后重试：'+e.message));renderRun();show('run-dialog');
  }catch(e){$('brief-error').textContent=e.message;}finally{$('brief-submit').disabled=false;}
};
$('feedback-form').onsubmit=async e=>{e.preventDefault();if(feedbackSubmitting)return;feedbackSubmitting=true;$('feedback-submit').disabled=true;$('feedback-error').textContent='';try{await api('studio/command',{op:'retry',...feedback,feedback:$('feedback-text').value});await refresh(true);$('feedback-dialog').close();notify(feedback.op==='skip-task'?'已记录跳过，继续分发后续任务；原失败记录保留':feedback.op==='accept'?'已确认遗留问题并验收':feedback.op==='reject-step'?'已打回修改，本轮审批与下游将重新验证':feedback.op==='reject-visual'?'已安排原画修改；旧视觉确认与下游结果已失效':'已安排返工，下游任务将重新执行');}catch(e){$('feedback-error').textContent=e.message;}finally{feedbackSubmitting=false;if(feedback?.op==='skip-task'&&$('feedback-dialog').open)void inspectSkip(true);else $('feedback-submit').disabled=false;}};
function stream(){source?.close();source=new EventSource('/api/events');for(const type of ['studio','state','sessions','reset','event'])source.addEventListener(type,()=>void refresh().catch(()=>{}));source.onerror=()=>{$('connection').textContent='连接恢复中';$('connection').dataset.offline='true';};}
async function start(){await refresh(true);conversationCache.enable();$('login').hidden=true;$('app').hidden=false;if(embed.active)stream();embed.ready();}
$('login-form').onsubmit=async e=>{e.preventDefault();$('login-error').textContent='';try{await api('login',{token:$('token').value});$('token').value='';await start();}catch(e){$('login-error').textContent=e.message;}};
setInterval(()=>{if(embed.active&&!$('app').hidden&&!document.hidden)void refresh().catch(e=>notify(e.message));},5000);
document.addEventListener('visibilitychange',()=>{if(embed.active&&!document.hidden&&!$('app').hidden)void refresh().catch(()=>{});});
void start().catch(e=>{if($('login').hidden)notify(e.message);});
