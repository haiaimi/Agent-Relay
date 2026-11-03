export class QuestionPanel {
  cards=new Map();rendered=new Map();submitting=new Set();drafts=new Map();generation=0;
  constructor(root,submit,online,notify){Object.assign(this,{root,submit,online,notify});}
  reset(clearDrafts=false){this.generation++;this.cards.clear();for(const entry of this.rendered.values())entry.element.remove();this.rendered.clear();this.root.replaceChildren();if(clearDrafts)this.drafts.clear();}
  event(card,capture=false){if(card?.id&&Array.isArray(card.questions)){const old=this.cards.get(card.id);if(old&&old.status!=='pending'&&card.status==='pending')return;const anchorId=old?.anchorId??card.anchorId??(capture?this.anchor?.():undefined);this.cards.set(card.id,{...card,...anchorId?{anchorId}:{}});}}
  replaceAnchors(ids,replacement){for(const [id,card] of this.cards)if(ids.includes(card.anchorId))this.cards.set(id,{...card,anchorId:replacement});}
  reconcile(active,asOf=Infinity){const ids=new Set(active.map(c=>c.id));for(const [id,c] of this.cards)if(c.status==='pending'&&c.createdAt<=asOf&&!ids.has(id))this.cards.set(id,{...c,status:'cancelled'});for(const c of active)this.event(c);}
  render(){let changed=false,snapshot;for(const [id,card] of this.cards){const version=JSON.stringify([card.status,card.answers,card.questions,this.online()]);if(this.rendered.get(id)?.version===version)continue;if(!changed)snapshot=this.beforeRender?.();changed=true;const old=this.rendered.get(id)?.element,element=this.build(card);if(old)old.replaceWith(element);else if(!this.afterRender)this.root.append(element);this.rendered.set(id,{version,element});}if(changed)this.afterRender?.(snapshot);}
  build(card){
    const generation=this.generation;
    const form=document.createElement(card.status==='pending'?'form':'details');form.className='question-card';form.dataset.messageId='question:'+card.id;form.setAttribute('aria-label','Agent 提问');
    const title=document.createElement(card.status==='pending'?'h3':'summary');title.textContent=card.status==='pending'?'需要你回答':card.status==='answered'?'已回答的问题':card.status==='unknown'?'回答结果待确认':'已关闭的问题';form.append(title);const groups=[];
    for(const q of card.questions){
      const field=document.createElement('fieldset'),legend=document.createElement('legend');legend.textContent=q.header+' · '+q.question;field.append(legend);const choices=[];
      for(const [index,option] of q.options.entries()){
        const label=document.createElement('label');label.className='question-option';const input=document.createElement('input');input.type=q.multiSelect?'checkbox':'radio';input.name=card.id+'-'+q.id;input.value=option.label;input.id=card.id+'-'+q.id+'-'+index;input.disabled=card.status!=='pending';input.checked=(card.status==='pending'?this.drafts.get(card.id)?.[q.id]?.choices:card.answers?.[q.id])?.includes(option.label)??false;
        const text=document.createElement('span'),strong=document.createElement('strong');strong.textContent=option.label;text.append(strong);if(option.description){const description=document.createElement('small');description.textContent=option.description;text.append(description);}label.append(input,text);field.append(label);choices.push(input);
      }
      let free;if(q.allowOther||!q.options.length){free=document.createElement(q.secret?'input':'textarea');if(q.secret)free.type='password';else free.rows=2;free.maxLength=8000;free.placeholder=q.options.length?'其他回答（填写后使用这里的内容）':'输入你的回答…';free.setAttribute('aria-label',q.question+'：自填回答');free.disabled=card.status!=='pending';const custom=card.answers?.[q.id]?.filter(v=>!q.options.some(o=>o.label===v));free.value=card.status==='pending'?(this.drafts.get(card.id)?.[q.id]?.free??''):custom?.length?(q.secret?'已提交':custom.join(', ')):'';field.append(free);}
      groups.push({q,choices,free});form.append(field);
    }
    const note=document.createElement('p');note.className='question-note';note.setAttribute('role','status');
    form.addEventListener('input',()=>this.drafts.set(card.id,Object.fromEntries(groups.map(({q,choices,free})=>[q.id,{choices:choices.filter(c=>c.checked).map(c=>c.value),free:free?.value??''}]))));
    if(card.status==='pending'){
      const button=document.createElement('button');button.type='submit';button.className='question-submit';button.textContent='提交回答';button.disabled=!this.online();form.append(button);if(!this.online())note.textContent='电脑离线，连接恢复后可提交';
      form.onsubmit=async event=>{
        event.preventDefault();if(this.submitting.has(card.id))return;const answers={};
        for(const {q,choices,free} of groups){const custom=free?.value.trim(),values=custom?[custom]:choices.filter(c=>c.checked).map(c=>c.value);if(!values.length){note.textContent='请回答所有问题后提交';return;}answers[q.id]=values;}
        this.submitting.add(card.id);button.disabled=true;note.textContent='正在把回答送回原任务…';
        try{await this.submit(card,answers);this.drafts.delete(card.id);if(this.generation===generation){this.cards.set(card.id,{...card,status:'answered',answers});this.render();}}catch(error){if(this.generation===generation){note.textContent=error.message;this.notify(error.message);button.disabled=!this.online();}}finally{this.submitting.delete(card.id);}
      };
    }else note.textContent=card.status==='answered'?'已回答':card.status==='unknown'?'提交结果待本机确认，请勿重复发送':card.status==='expired'?'问题已过期':'问题已在本机关闭或任务已结束';
    form.append(note);return form;
  }
}
