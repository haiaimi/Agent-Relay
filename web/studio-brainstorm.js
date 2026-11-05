import {displayUserMessage} from './message-text.js';
import {setupReplyKeys} from './composer.js';
import {AttachmentInput} from './attachments.js';
import {mediaCard,disposeMedia,clipboardFiles} from './studio-media.js';
import {QuestionPanel} from './questions.js';
import {roleAvatar} from './studio-avatar.js';
import {reviewMessages} from './studio-review.js';
import {enhanceDiagrams} from './diagrams.js';
import {SettingsWrites} from './operations.js';
import {findModel,modelName} from './session-settings.js';
import {pagedConversationCache} from './conversation-cache.js';
const $=id=>document.getElementById(id),el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const markdown=window.markdownit({html:false,linkify:true,breaks:true});
export function studioBrainstorm({snapshot,api,refresh,current,notify,openRun,configureLaunch}){
  let topicId='',generation=0,loading=false,sending=false,lastLoad=0,cursor=null,requestId=null,detail,channelsSignature='';
  const pages=new Map(),rows=new Map(),inflight=new Set();
  const catalogs=new Map(),settingsErrors=new Map();
  const effortNames={none:'无',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高',ultra:'极高'};
  const topic=()=>snapshot().state.brainstorms?.find(t=>t.id===topicId),team=()=>snapshot().state.projects.find(p=>p.id===topic()?.projectId),session=()=>snapshot().relay.sessions.find(s=>s.id===topic()?.sessionId);
  const online=()=>snapshot().relay.hosts.some(h=>h.id===topic()?.hostId&&h.online);
  const cache=pagedConversationCache({target:()=>topic()?{identity:JSON.stringify(['brainstorm',topic().hostId,topicId,topic().sessionId,topic().workspace?.path]),generation}:null,pages,cursor:()=>cursor,view:()=>$('brainstorm-timeline'),restore:value=>{cursor=value.cursor;$('brainstorm-earlier').hidden=cursor===null;renderMessages();},note:()=>$('brainstorm-status').textContent+=' · 已显示浏览器缓存'});
  const error=e=>$('brainstorm-error').textContent=e||'';
  const context=()=>{const t=topic();return t?.workspace?{key:t.id,target:{hostId:t.hostId,...t.sessionId?{sessionId:t.sessionId}:{projectId:t.workspace.id}}}:null;};
  const files=new AttachmentInput($('brainstorm-form'),$('brainstorm-attach'),$('brainstorm-files'),context,message=>{if(message)error(message);},{clipboardFiles});
  const action=fields=>api('actions',{id:crypto.randomUUID(),sessionId:topic()?.sessionId,...fields});
  const settings=new SettingsWrites((id,patch)=>api('studio/brainstorm/settings',{id:crypto.randomUUID(),topicId:id,...patch}),()=>{if(topic())paintSettings();},(id,patch,result)=>{
    const t=snapshot().state.brainstorms.find(t=>t.id===id),s=snapshot().relay.sessions.find(s=>s.id===t?.sessionId);if(t)Object.assign(t,result.topic);
    if(s)Object.assign(s,result.queued?{nextModel:result.model,nextEffort:result.effort}:{model:result.model,effort:result.effort,nextModel:undefined,nextEffort:undefined});settingsErrors.delete(id);
  },(id,e)=>{settingsErrors.set(id,e.message);if(id===topicId)error('模型设置未保存：'+e.message+'；请核对后重新选择。');});
  function modelFields(prefix,list,model,effort){
    const select=$(prefix+'-model'),strength=$(prefix+'-effort'),choices=[['','沿用本机默认'],...list.map(m=>[m.id,m.name||m.id])];
    if(model&&!choices.some(([id])=>id===model))choices.push([model,modelName(list,model)]);
    const signature=JSON.stringify(choices);if(select.dataset.choices!==signature){select.replaceChildren(...choices.map(([id,name])=>new Option(name,id)));select.dataset.choices=signature;}select.value=model||'';
    const m=findModel(list,model)??(!model?list.find(m=>m.isDefault)??list[0]:undefined),levels=[['default','使用模型推荐强度'],...(m?.efforts??[]).map(v=>[v,effortNames[v]||v])];
    if(effort&&!levels.some(([id])=>id===effort))levels.push([effort,effortNames[effort]||effort]);const key=JSON.stringify(levels);if(strength.dataset.choices!==key){strength.replaceChildren(...levels.map(([id,name])=>new Option(name,id)));strength.dataset.choices=key;}strength.value=effort||'default';
  }
  function paintSettings(){
    const t=topic();if(!t)return;const s=session(),pending=settings.pending(t.id),list=catalogs.get(t.hostId)?.list??[],model=pending?.model??(s?s.nextModel??s.model:t.model),effort=pending?.effort??(s?s.nextEffort??s.effort:t.effort);
    $('brainstorm-model-preview').textContent='Claude · '+(modelName(list,model)?.replace(/^Claude\s*/i,'')||'本机默认')+(effort&&effort!=='default'?' · '+(effortNames[effort]||effort):'');
    $('brainstorm-settings-note').textContent=settingsErrors.get(t.id)?'设置未保存，请重新选择':pending?'正在保存…':s?.nextModel||s?.nextEffort?'已预设，下一轮生效':'切换后下一轮生效 · Codex 继续负责参考图';
    modelFields('brainstorm',list,model,effort);$('brainstorm-model').disabled=$('brainstorm-effort').disabled=!online();
  }
  async function loadModels(hostId){
    let cache=catalogs.get(hostId);if(!cache){cache={};catalogs.set(hostId,cache);}if(cache.list)return cache.list;
    cache.job??=api('models?'+new URLSearchParams({hostId,provider:'claude'})).then(r=>cache.list=r.models).finally(()=>cache.job=null);return cache.job;
  }
  async function settingsModels(){const id=topicId,t=topic();if(!t)return;try{await loadModels(t.hostId);if(id===topicId)paintSettings();}catch(e){if(id===topicId)$('brainstorm-settings-note').textContent='模型读取失败：'+e.message;}}
  function changeSettings(modelChanged){if(!topic())return;settingsErrors.delete(topicId);error('');void settings.set(topicId,{model:$('brainstorm-model').value,effort:modelChanged?'default':$('brainstorm-effort').value}).catch(()=>{});}
  const questions=new QuestionPanel($('brainstorm-questions'),(card,answers)=>action({type:'answer',questionId:card.id,answers}),online,notify);
  const draftKey=id=>'relay-brainstorm-draft:'+id;
  function save(){if(topicId)localStorage.setItem(draftKey(topicId),$('brainstorm-text').value);}
  function header(){
    const t=topic(),p=team(),s=session();if(!t)return;$('brainstorm-title').textContent=t.title;
    $('brainstorm-status').textContent=t.error||[p?.name,'工程上下文已关联',s?({running:'Claude 正在工作',waiting:'等待你回答',idle:'等待新的想法',failed:'本轮执行失败',interrupted:'已停止本轮工作'}[s.status]||'讨论记录'):t.workspace?'可以开始讨论':'正在准备讨论资料目录'].join(' · ');
    $('brainstorm-stop').hidden=!['running','waiting'].includes(s?.status);$('brainstorm-full').hidden=!t.sessionId;$('brainstorm-full').href='/?sessionId='+encodeURIComponent(t.sessionId||'');
    $('brainstorm-send').disabled=sending||!online()||!t.workspace||!!t.error;$('brainstorm-propose').disabled=sending||!t.sessionId||!online();
    paintSettings();
    const topics=(snapshot().state.brainstorms??[]).filter(x=>x.projectId===t.projectId),signature=JSON.stringify([topics.map(x=>[x.id,x.title]),topicId]);if(signature!==channelsSignature){channelsSignature=signature;$('brainstorm-channels').replaceChildren(...topics.map(x=>{const b=el('button','role-channel'+(x.id===topicId?' active':''));b.type='button';b.append(roleAvatar(t.projectId,'brainstorm','头脑风暴'),el('span','role-channel-copy',x.title));b.onclick=()=>open(x.id);return b;}));}
  }
  function proposalButton(m,body){
    if(!m.proposal)return;const proposal=m.proposal,box=el('div','brainstorm-proposal'),launch=detail?.launches?.find(x=>x.proposalId===proposal.id);box.append(el('strong','','制作提案'),el('p','','发起前可选择制作环节与审批'+' · '+(proposal.image_ids?.length||0)+' 张参考图 · '+team()?.name));
    const b=el('button','primary',launch?'查看已发起的制作任务 ↗':'发起制作任务 ↗');b.type='button';b.disabled=inflight.has(proposal.id);b.onclick=async()=>{
      if(launch){openRun(launch.runId);return;}if(configureLaunch){configureLaunch({topicId,proposalId:proposal.id,title:proposal.title,brief:proposal.brief,workflow:proposal.workflow});return;}if(inflight.has(proposal.id))return;inflight.add(proposal.id);b.disabled=true;error('');
      try{const result=await api('studio/brainstorm/launch',{topicId,proposalId:proposal.id});await refresh(true);await load();openRun(result.runId);notify('已交给制作团队，正在准备独立分支');}
      catch(e){error(e.message);}finally{inflight.delete(proposal.id);if(b.isConnected)b.disabled=false;}
    };box.append(b);body.append(box);
  }
  function build(m){
    m=displayUserMessage(m);
    const row=el('article','chat-message '+m.role),body=el('div','chat-message-body'),head=el('div','chat-message-head');row.dataset.messageId=m.id;row.append(roleAvatar(topic().projectId,m.role==='user'?'producer':m.label?.startsWith('Codex')?'brainstorm-codex':'brainstorm',m.role==='user'?'制作人':'头脑风暴'));
    head.append(el('strong','',m.role==='user'?'制作人':m.label||'Claude · 头脑风暴'));if(m.timestamp)head.append(el('time','',new Date(m.timestamp).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})));body.append(head);
    if(m.role==='tool'){const details=el('details','chat-tool');details.append(el('summary','',m.label||'工作记录'),el('pre','',m.text));body.append(details);}
    else{const copy=el('div','chat-copy');copy.innerHTML=window.DOMPurify.sanitize(markdown.render(m.text||''));for(const a of copy.querySelectorAll('a')){a.target='_blank';a.rel='noopener noreferrer';}body.append(copy);}
    for(const f of m.files??[])body.append(mediaCard(f,{sessionId:topic().sessionId,hostId:topic().hostId}));for(const f of m.images??[])body.append(mediaCard(f,{sessionId:topic().sessionId,hostId:topic().hostId,kind:'image'}));
    proposalButton(m,body);row.append(body);return row;
  }
  function renderMessages(){
    const timeline=$('brainstorm-timeline'),messages=reviewMessages([...pages.values()]),bottom=timeline.scrollHeight-timeline.scrollTop-timeline.clientHeight<65,anchor=[...timeline.children].find(e=>e.getBoundingClientRect().bottom>timeline.getBoundingClientRect().top),top=anchor?.getBoundingClientRect().top;
    for(const p of detail?.proposals??[])if(!messages.some(m=>m.proposal?.id===p.id))messages.push({id:'brain-proposal:'+p.id,role:'assistant',label:'制作提案',text:p.title+'\n\n'+p.brief,proposal:p,timestamp:p.at});messages.sort((a,b)=>(a.timestamp??0)-(b.timestamp??0));
    const all=new Set(messages.map(m=>m.id));for(const [id,row]of rows)if(!all.has(id)){disposeMedia(row.element);row.element.remove();rows.delete(id);}
    timeline.querySelector('.chat-empty')?.remove();
    for(const m of messages){const version=JSON.stringify([m,m.proposal?detail?.launches?.map(l=>[l.proposalId,l.runId]):null]),old=rows.get(m.id);if(old?.version===version)continue;const element=build(m);if(old){disposeMedia(old.element);old.element.replaceWith(element);}rows.set(m.id,{version,element});}
    let pointer=timeline.firstElementChild;for(const m of messages){const element=rows.get(m.id).element;if(pointer===element)pointer=pointer.nextElementSibling;else timeline.insertBefore(element,pointer);}
    if(!messages.length){const empty=el('div','chat-empty');empty.append(roleAvatar(topic().projectId,'brainstorm','头脑风暴'),el('h3','','一起推敲这个想法'),el('p','fine','我会结合项目组背景讨论玩法、画面与关卡。你可以让我画参考图、SVG 示意图或流程图。认可方案后，再点击提案里的“发起制作任务”。'));timeline.append(empty);}
    enhanceDiagrams(timeline);
    if(bottom||!rows.size)timeline.scrollTop=timeline.scrollHeight;else if(anchor?.isConnected)timeline.scrollTop+=anchor.getBoundingClientRect().top-top;
  }
  function approvals(page){const map=new Map();for(const e of page.events??[]){if(e.type==='approval')map.set(e.data.approvalId,e.data);if(e.type==='approval.resolved')map.delete(e.data.approvalId);}const root=$('brainstorm-approvals');root.replaceChildren();for(const[id,a]of map){if(a.expiresAt<Date.now())continue;const box=el('div','approval-card');box.append(el('strong','','需要工具批准'),el('pre','',a.description||a.command||JSON.stringify(a)));for(const[label,allow]of[['允许这一次',true],['拒绝',false]]){const b=el('button','quiet',label);b.type='button';b.onclick=async()=>{b.disabled=true;try{await action({type:'approve',approvalId:id,allow});await load();}catch(e){notify(e.message);b.disabled=false;}};box.append(b);}root.append(box);}}
  async function load(older){
    if(loading||!$('brainstorm-dialog').open||!topic())return;loading=true;const stamp=generation,target=topicId;lastLoad=Date.now();
    cache.load();
    try{const t=topic(),values=await Promise.all([api('studio/brainstorm?topicId='+encodeURIComponent(target)),t.sessionId?api('history?'+new URLSearchParams({sessionId:t.sessionId,...older!==undefined?{cursor:String(older)}:{live:'1'}})):Promise.resolve({messages:[],events:[]})]);if(stamp!==generation||target!==topicId)return;
      detail=values[0];pages.set(older??'latest',values[1]);if(older!==undefined||pages.size===1)cursor=values[1].cursor??null;$('brainstorm-earlier').hidden=cursor===null;questions.reconcile(values[1].questions??[],values[1].questionsAsOf);for(const e of values[1].events??[])if(e.type==='question'||e.type==='question.resolved')questions.event(e.data);questions.render();approvals(values[1]);renderMessages();header();cache.save();
    }catch(e){if(stamp===generation)error(e.message);}finally{if(stamp===generation)loading=false;}
  }
  async function send(value){
    if(sending)return;const t=topic(),contextValue=context();if(!t||!contextValue)return;const text=value??$('brainstorm-text').value;if(!text.trim()&&!files.count)return;sending=true;header();error('');requestId??=crypto.randomUUID();
    try{await settings.wait(t.id);if(settingsErrors.has(t.id))throw Error('模型设置未保存，请先重新选择');const attachmentIds=value?[]:await files.upload(contextValue);await api('studio/brainstorm/send',{id:requestId,topicId:t.id,text:text.trim()||'请查看这些参考资料。',attachmentIds});requestId=null;if(!value){$('brainstorm-text').value='';files.clear(t.id);save();}await refresh(true);await load();}
    catch(e){error(e.message+'；讨论记录会保留，请先核对后再发送。');requestId=null;}finally{sending=false;header();}
  }
  function open(id){
    cache.save();
    save();topicId=id;generation++;loading=false;pages.clear();for(const row of rows.values())disposeMedia(row.element);rows.clear();$('brainstorm-timeline').replaceChildren();questions.reset();detail=undefined;cursor=null;requestId=null;error('');$('brainstorm-settings').open=false;$('brainstorm-text').value=localStorage.getItem(draftKey(id))||'';files.render();header();if(!$('brainstorm-dialog').open)$('brainstorm-dialog').showModal();renderMessages();void load();void settingsModels();
  }
  function render(){
    const p=current();$('brainstorm-new').disabled=!p;$('brainstorm-team').textContent=p?p.name+' · 讨论随项目组分别保存与继承上下文':'先选择项目组';const topics=(snapshot().state.brainstorms??[]).filter(t=>t.projectId===p?.id);
    $('brainstorm-topics').replaceChildren(...topics.map(t=>{const b=el('button','run-card');b.type='button';b.append(el('h3','',t.title),el('p','brainstorm-topic-meta',(t.error?'需要处理':t.sessionId?'继续讨论':'尚未开始')+' · Claude · '+new Date(t.createdAt).toLocaleDateString('zh-CN')));b.onclick=()=>open(t.id);return b;}));
    if(!topics.length)$('brainstorm-topics').append(el('p','fine','还没有讨论。为这个项目组开启一个主题，先把方向想清楚。'));
  }
  $('brainstorm-new').onclick=()=>{if(!current())return;const p=current();$('brainstorm-new-team').textContent=p.name;$('brainstorm-new-title').value='';$('brainstorm-new-error').textContent='';modelFields('brainstorm-new',catalogs.get(p.hostId)?.list??[],'','default');$('brainstorm-new-dialog').showModal();void loadModels(p.hostId).then(list=>{if(current()?.id===p.id&&$('brainstorm-new-dialog').open)modelFields('brainstorm-new',list,$('brainstorm-new-model').value,$('brainstorm-new-effort').value);}).catch(e=>$('brainstorm-new-error').textContent='模型读取失败：'+e.message);};
  $('brainstorm-new-model').onchange=()=>modelFields('brainstorm-new',catalogs.get(current()?.hostId)?.list??[],$('brainstorm-new-model').value,'default');
  $('brainstorm-model').onchange=()=>changeSettings(true);$('brainstorm-effort').onchange=()=>changeSettings(false);
  $('brainstorm-new-form').onsubmit=async e=>{e.preventDefault();const projectId=current()?.id;$('brainstorm-create').disabled=true;try{const result=await api('studio/brainstorm',{projectId,title:$('brainstorm-new-title').value,model:$('brainstorm-new-model').value,effort:$('brainstorm-new-effort').value});await refresh(true);$('brainstorm-new-dialog').close();open(result.topic.id);}catch(e){$('brainstorm-new-error').textContent=e.message;}finally{$('brainstorm-create').disabled=false;}};
  $('brainstorm-text').addEventListener('input',()=>{requestId=null;save();});$('brainstorm-form').onsubmit=e=>{e.preventDefault();void send();};
  setupReplyKeys($('brainstorm-text'),$('brainstorm-send'));
  $('brainstorm-propose').onclick=()=>void send('请把我们已讨论并认可的方向整理为可执行制作提案，调用 propose_task，明确目标、范围、验收标准与参考图；如果关键方向尚不明确，先问我。');
  $('brainstorm-stop').onclick=async()=>{try{await action({type:'stop'});await refresh(true);await load();}catch(e){error(e.message);}};
  $('brainstorm-earlier').onclick=()=>void load(cursor);$('brainstorm-dialog').addEventListener('close',()=>{cache.save();save();generation++;loading=false;});
  return {render,open,update(){if($('brainstorm-dialog').open){header();if(Date.now()-lastLoad>1500)void load();}}};
}
