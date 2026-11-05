import {taskGuidance} from './studio-guidance.js';
const names={planning:'需求拆解中','plan-review':'待确认计划',executing:'制作中',delivery:'整理交付中',review:'待你验收',accepted:'已验收',cancelled:'已取消',queued:'等待前置',starting:'正在启动',running:'进行中',done:'已完成',skipped:'制作人已跳过',blocked:'待处理','awaiting-review':'待确认原画'};
const terminal=r=>['accepted','cancelled'].includes(r.status);
export function studioSessionSignature(state,relay){
  const ids=new Set(state.runs.flatMap(r=>[r.planner,...r.tasks,r.delivery,...(r.chats??[])].filter(Boolean).map(t=>t.sessionId)).filter(Boolean));
  return relay.sessions.filter(s=>ids.has(s.id)).map(s=>[s.id,s.status,s.questionCount||0,s.pendingCount||0,s.canStop]);
}
export function studioRunActivity(r,relay){
  const sessions=new Map(relay.sessions.map(s=>[s.id,s])),all=[r.planner,...r.tasks,r.delivery].filter(Boolean);
  const active=all.filter(t=>['starting','running'].includes(t.status)),blocked=all.filter(t=>t.status==='blocked'),approvals=all.filter(t=>t.status==='awaiting-review'),queued=all.filter(t=>t.status==='queued');
  const targets=terminal(r)?[]:[...active,...blocked,...approvals];
  const headline=terminal(r)?r.autoAccepted?'已交付':names[r.status]:active.length?'当前正在推进：'+active.map(t=>t.title).join('；'):r.paused?'已暂停后续分发':blocked.length?'流程等待处理：'+blocked.map(t=>t.title).join('；'):approvals.length?'等待制作人确认：'+approvals.map(t=>t.title).join('；'):r.status==='plan-review'?'等待制作人确认计划':r.status==='review'?'等待制作人验收':queued.length?'等待后续任务分发':'正在整理交付状态';
  const items=targets.map(t=>{const s=sessions.get(t.sessionId),waiting=!!s?.questionCount||s?.status==='waiting';return {id:t.id,title:t.title,role:t.role,status:t.status,label:waiting?'等待你回答 / 确认':t.preflightRetry?.nextAt?'预检连接恢复中（'+t.preflightRetry.attempts+'/5）':t.status==='starting'?'正在核对原画 / 准备投递':t.status==='running'&&['idle','history','failed','interrupted'].includes(s?.status)?'正在核对执行结果':t.status==='blocked'?taskGuidance(t,s).label:t.checkpoint?'待续做':t.kind==='producer-review'&&t.status==='awaiting-review'?'待制作人审批':names[t.status]||t.status};});
  return {headline,items,active:active.map(t=>t.id),blocked:blocked.map(t=>t.id),paused:!!r.paused,terminal:terminal(r)};
}
export function studioProgress(state,relay,projectId,activeRun,activeTask){
  const roles=new Map(state.roles.map(r=>[r.id,r.name])),sessions=new Map(relay.sessions.map(s=>[s.id,s]));
  const runs=state.runs.filter(r=>r.projectId===projectId).map(r=>{
    const all=[r.planner,...r.tasks,r.delivery].filter(Boolean),tasks=all.filter(t=>t!==r.planner||t.status!=='done'||!r.tasks.length).map(t=>{
      const s=sessions.get(t.sessionId),question=!!s?.questionCount||s?.status==='waiting',attention=['blocked','awaiting-review'].includes(t.status)||question;
      return {id:t.id,title:t.title,role:roles.get(t.role)||t.role,status:t.status,attention,label:question?'等待你回答':t.kind==='producer-review'&&t.status==='awaiting-review'?'待制作人审批':t.status==='blocked'?taskGuidance(t,s).label:names[t.status]||t.status};
    });
    const attention=!terminal(r)&&(r.paused||!!r.workflow?.error||r.workspace?.status==='blocked'||['plan-review','review'].includes(r.status)||tasks.some(t=>t.attention));
    const label=terminal(r)?r.autoAccepted?'已交付':names[r.status]:r.paused?'已暂停':r.workflow?.error||r.workspace?.status==='blocked'?'待处理':names[r.status];
    const focus=tasks.filter(t=>t.attention);const active=tasks.filter(t=>['running','starting'].includes(t.status));
    return {id:r.id,title:r.title,status:r.status,label:attention&&!['plan-review','review'].includes(r.status)&&!r.paused?'待你处理':label,attention,done:r.tasks.filter(t=>t.status==='done').length,skipped:r.tasks.filter(t=>t.status==='skipped').length,total:r.tasks.length,tasks,activity:terminal(r)?'':(focus.length?focus:active).map(t=>t.role+' · '+t.title).join('；')||(!r.tasks.length?'统筹正在拆解需求':'等待后续任务分发')};
  });
  return {projectId,projects:state.projects.map(p=>({id:p.id,name:p.name})),activeRun:runs.some(r=>r.id===activeRun)?activeRun:runs.find(r=>!terminal(r))?.id,activeTask,runs};
}

export function setupStudioSidebar(root,send){
  const $=id=>root.querySelector('#'+id),el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
  let snapshot=null,projectId=null;const rows=new Map();
  function action(command,fields={}){send({command,...fields});}
  function build(run){
    const card=el('article','studio-progress-card'),button=el('button','studio-progress-run');button.type='button';button.dataset.run=run.id;button.setAttribute('aria-label',run.title+' · '+run.label+' · '+run.done+'/'+run.total);
    if(run.id===snapshot.activeRun)button.setAttribute('aria-current','true');
    const head=el('span','studio-progress-head');head.append(el('strong','',run.title),el('span','studio-progress-status',run.label));card.dataset.attention=String(run.attention);
    const progress=el('progress');progress.max=run.total||1;progress.value=run.done+(run.skipped||0);progress.setAttribute('aria-label',run.title+'完成进度');
    button.append(head,el('span','studio-progress-count',run.total?`${run.done} / ${run.total} 项完成${run.skipped?' · '+run.skipped+' 项跳过':''}`:'正在拆解需求'),progress);
    if(run.activity)button.append(el('span','studio-progress-activity',run.activity));card.append(button);
    if(run.tasks.length){const details=el('details','studio-progress-tasks');details.append(el('summary','','职能进度 · '+run.tasks.length+' 项'));
      for(const task of run.tasks){const b=el('button','studio-progress-task');b.type='button';b.dataset.run=run.id;b.dataset.task=task.id;b.dataset.status=task.attention?'attention':task.status;
        if(run.id===snapshot.activeRun&&task.id===snapshot.activeTask)b.setAttribute('aria-current','true');
        const copy=el('span','studio-progress-task-copy');copy.append(el('strong','',task.role),el('span','',task.title));b.append(el('i','studio-progress-dot'),copy,el('small','',task.label));details.append(b);
      }card.append(details);
    }return card;
  }
  function render(){
    if(!snapshot)return;const picker=$('studio-sidebar-team'),choices=JSON.stringify(snapshot.projects);if(picker.dataset.choices!==choices){picker.replaceChildren(...snapshot.projects.map(p=>new Option(p.name,p.id)));picker.dataset.choices=choices;}picker.value=snapshot.projectId||'';picker.disabled=!snapshot.projects.length;
    $('studio-sidebar-new').disabled=false;$('studio-sidebar-count').textContent=String(snapshot.runs.length);
    const q=$('studio-sidebar-search').value.trim().toLocaleLowerCase(),runs=snapshot.runs.filter(r=>[r.title,r.label,...r.tasks.flatMap(t=>[t.role,t.title,t.label])].join(' ').toLocaleLowerCase().includes(q)),list=$('studio-progress-list');
    const ids=new Set(runs.map(r=>r.id));for(const[id,row]of rows)if(!ids.has(id)){row.element.remove();rows.delete(id);}list.querySelector('.studio-sidebar-empty')?.remove();
    for(const run of runs){const key=JSON.stringify([run,run.id===snapshot.activeRun,snapshot.activeTask]),old=rows.get(run.id);if(old?.key===key)continue;
      const expanded=old?old.element.querySelector('details')?.open:run.id===snapshot.activeRun,element=build(run),details=element.querySelector('details');if(details)details.open=!!expanded;
      if(old)old.element.replaceWith(element);rows.set(run.id,{key,element});
    }
    let pointer=list.firstElementChild;for(const run of runs){const e=rows.get(run.id).element;if(pointer===e)pointer=pointer.nextElementSibling;else list.insertBefore(e,pointer);}
    if(!runs.length)list.append(el('p','studio-sidebar-empty',q?'没有匹配的制作任务':snapshot.projects.length?'还没有制作需求，先提出一个想法。':'先组建团队，再提出制作需求。'));
  }
  $('studio-sidebar-team').onchange=()=>action('project',{projectId:$('studio-sidebar-team').value});
  $('studio-sidebar-new').onclick=()=>action('brief');$('studio-sidebar-search').oninput=render;
  $('studio-progress-list').onclick=e=>{const b=e.target.closest('button[data-run]');if(b)action(b.dataset.task?'task':'run',{runId:b.dataset.run,taskId:b.dataset.task});};
  return {update(value){if(!value||!Array.isArray(value.projects)||!Array.isArray(value.runs))return;if(projectId!==value.projectId){rows.clear();$('studio-progress-list').replaceChildren();$('studio-sidebar-search').value='';projectId=value.projectId;}snapshot=value;render();},reset(){snapshot=null;projectId=null;rows.clear();$('studio-progress-list').replaceChildren(el('p','studio-sidebar-empty','正在读取制作进度…'));$('studio-sidebar-new').disabled=true;}};
}
