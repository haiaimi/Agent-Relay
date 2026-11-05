import {QuestionPanel} from './questions.js';
import {disposeMedia} from './studio-media.js';
const el=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls||'';if(text!==undefined)n.textContent=text;return n;};
export function studioAttention({root,getRuns,visible,api,refresh,roleName,review}){
  const rows=new Map(),reviews=new Map(),snapshots=new Map(),writes=new Map();let loading=false,generation=0,signature='',failures=0,retryAt=0,lastRead=0,successUntil=0;
  root.classList.add('studio-attention');root.hidden=true;root.setAttribute('aria-label','当前需要你确认');
  const heading=el('div','attention-heading'),title=el('strong','','需要你确认'),status=el('p','fine'),body=el('div','attention-items'),reload=el('button','quiet','刷新待确认事项');reload.type='button';heading.append(title,reload);root.append(heading,status,body);reload.onclick=()=>void load(true);
  function clean(map,key){const row=map.get(key);if(!row)return;row.panel?.reset();disposeMedia(row.element);row.element.remove();map.delete(key);}
  function online(entry){return entry.online&&failures===0;}
  async function submit(entry,key,value){
    const old=writes.get(key);if(old?.pending)throw Error('正在提交，请稍候');const operation=old??{id:crypto.randomUUID()};writes.set(key,operation);operation.pending=true;
    try{const result=await api('actions',{id:operation.id,sessionId:entry.sessionId,...value});operation.confirmed=true;successUntil=Date.now()+5000;status.textContent=result.queued?'回答已排队，原任务接收后继续；无需重复提交。':'确认已送回原任务，正在同步执行进度…';void refresh(true).catch(()=>{status.textContent='确认已送达，执行状态暂未同步；请勿重复提交。';});void load(true);return result;}
    finally{operation.pending=false;}
  }
  function render(){
    const wanted=new Set(),wantedReviews=new Set();let count=0;
    for(const r of getRuns()){
      const native=snapshots.get(r.id)?.entries??[];
      for(const entry of native){
        const key=r.id+':'+entry.sessionId;wanted.add(key);let row=rows.get(key);
        if(!row){const element=el('section','attention-session'),label=el('h3'),questionsRoot=el('div'),approvalRoot=el('div');element.append(label,questionsRoot,approvalRoot);row={element,label,approvalRoot,questionRoot:questionsRoot,entry,approvalVersion:''};
          row.panel=new QuestionPanel(questionsRoot,(card,answers)=>submit(row.entry,'answer:'+card.id+':'+JSON.stringify(answers),{type:'answer',questionId:card.id,answers}),()=>online(row.entry),message=>{status.textContent=message;});rows.set(key,row);body.insertBefore(element,body.firstChild);
        }
        row.entry=entry;row.label.textContent=r.title+' · '+roleName(entry.role)+(entry.taskId?' · '+entry.taskId+' '+entry.title:'');
        if(!row.waiting){row.waiting=el('p','fine');row.element.append(row.waiting);}row.waiting.hidden=!!(entry.questions.length||entry.approvals.length);row.waiting.textContent=entry.online?(entry.syncFailures?'具体确认内容暂未同步；已保留原任务，连接失败按一分钟间隔尝试五次。':'正在从执行器同步具体确认内容…'):'工作电脑离线，待确认内容保留，连接恢复后可处理。';
        for(const card of entry.questions)row.panel.event(card);row.panel.reconcile(entry.questions,snapshots.get(r.id).checkedAt);row.panel.render();
        const version=JSON.stringify([entry.approvals,online(entry),entry.approvals.map(a=>writes.get('approve:'+a.approvalId))]);
        if(row.approvalVersion!==version){row.approvalVersion=version;row.approvalRoot.replaceChildren();
          for(const approval of entry.approvals){const card=el('section','approval-card'),operation=writes.get('approve:'+approval.approvalId);card.append(el('h3','','需要工具批准'),el('p','fine',approval.label||''),el('pre','',approval.details||approval.description||approval.command||''));
            if(approval.status==='unknown')card.append(el('p','error','本次批准结果尚未确认，请刷新核对，不会自动重复批准。'));
            else for(const [label,allow]of [['允许这一次',true],['拒绝',false]]){const button=el('button','quiet',label);button.type='button';button.disabled=!online(entry)||!!(operation?.pending||operation?.confirmed);button.onclick=async()=>{for(const b of card.querySelectorAll('button'))b.disabled=true;try{await submit(entry,'approve:'+approval.approvalId,{type:'approve',approvalId:approval.approvalId,allow});card.append(el('p','fine','决定已送达，等待执行器继续…'));}catch(e){card.append(el('p','error',e.message));for(const b of card.querySelectorAll('button'))b.disabled=!online(entry);} };card.append(button);}
            row.approvalRoot.append(card);
          }
        }
        count+=entry.questions.length+entry.approvals.length||Number(entry.waiting);
      }
      if(!['accepted','cancelled'].includes(r.status)){
        const gates=r.tasks.filter(t=>t.status==='awaiting-review');
        const items=[...gates,...r.status==='plan-review'?[{id:'plan',mode:'plan'}]:[],...r.status==='review'?[{id:'final',mode:'final'}]:[]];
        for(const gate of items){const key=r.id+':'+gate.id;wantedReviews.add(key);const upstream=r.tasks.filter(t=>gate.dependencies?.includes(t.id)),version=JSON.stringify([gate,upstream.map(t=>[t.id,t.summary,t.artifacts]),gate.mode==='final'?r.delivery:null]);let row=reviews.get(key);
          if(row?.version!==version){const element=el('section','attention-review');element.append(el('h3','',r.title+' · '+(gate.title||gate.mode==='plan'&&'确认制作计划'||'验收交付')));const content=review(r,gate);if(content)element.append(content);if(row){disposeMedia(row.element);row.element.replaceWith(element);}else body.append(element);row={element,version};reviews.set(key,row);}count++;
        }
      }
    }
    for(const key of rows.keys())if(!wanted.has(key))clean(rows,key);for(const key of reviews.keys())if(!wantedReviews.has(key))clean(reviews,key);
    title.textContent='需要你确认 · '+count+' 项';root.hidden=!count&&!failures&&Date.now()>successUntil;
    if(failures)status.textContent='待确认事项暂未同步，现有内容已保留。'+(failures<5?'一分钟后自动重试（'+failures+'/5），也可手动刷新。':'已尝试五次，请检查连接后刷新。');
    else if(Date.now()>successUntil)status.textContent=count?'在这里处理即可，决定会送回对应任务。':'当前没有待确认事项。';
  }
  async function load(force=false){
    if(!visible()||loading||!force&&(Date.now()<retryAt||failures>=5||Date.now()-lastRead<4000))return;
    if(force){failures=0;retryAt=0;}loading=true;lastRead=Date.now();const runs=getRuns(),identity=runs.map(r=>r.id).join(':'),stamp=generation;
    try{const values=await Promise.all(runs.map(r=>api('studio/attention?'+new URLSearchParams({runId:r.id,...force?{refresh:'1'}:{}}))));if(stamp!==generation||identity!==getRuns().map(r=>r.id).join(':'))return;for(const value of values)snapshots.set(value.runId,value);failures=0;retryAt=0;render();}
    catch(e){if(stamp===generation){failures++;retryAt=Date.now()+60000;render();}}
    finally{loading=false;}
  }
  function reset(){generation++;signature='';for(const key of rows.keys())clean(rows,key);for(const key of reviews.keys())clean(reviews,key);snapshots.clear();writes.clear();lastRead=0;failures=0;retryAt=0;successUntil=0;root.hidden=true;}
  return {reset,update(){if(!visible())return;const next=getRuns().map(r=>r.id).join(':');if(next!==signature){reset();signature=next;}render();void load();},refresh:()=>load(true)};
}
