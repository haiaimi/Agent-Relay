import {setupReplyKeys} from './composer.js';
const el=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls||'';if(text!==undefined)n.textContent=text;return n;};
export function stageGuidance({api,refresh,notify}){
  const drafts=new Map();
  return (run,task)=>{
    if(task.kind||!['queued','blocked','running'].includes(task.status)||['accepted','cancelled'].includes(run.status))return null;
    const key=run.id+':'+task.id;let row=drafts.get(key);
    if(!row){
      const form=el('form','stage-guide workspace-summary'),input=el('textarea'),send=el('button','primary'),note=el('p','fine'),history=el('div','stage-guide-history');
      input.rows=3;input.maxLength=8000;input.placeholder='补充本阶段方向，例如：按当前 Voxel 路径核对验收，保留真实画质与性能失败项…';input.setAttribute('aria-label','当前阶段指引');send.type='submit';note.setAttribute('role','status');
      form.append(el('strong','','当前阶段指引'),el('p','fine','向这个任务直接补充方向，保留工作副本、原会话和已完成成果；审批仍按所选流程进行。'),input,send,note,history);
      row={form,input,send,note,history,busy:false,request:null,run,task};drafts.set(key,row);setupReplyKeys(input,send);
      input.oninput=()=>{if(!row.busy&&row.request?.text!==input.value.trim())row.request=null;};
      form.onsubmit=async e=>{
        e.preventDefault();if(row.busy||!input.value.trim())return;
        row.request??={id:crypto.randomUUID(),runId:row.run.id,taskId:row.task.id,expectedSessionId:row.task.sessionId??null,text:input.value.trim()};
        row.busy=true;send.disabled=true;note.textContent='正在投递阶段指引…';
        try{
          const result=await api('studio/guidance',row.request);
          note.textContent=result.status==='saved'?'已保存；前置步骤和审批完成后，Agent 按指引执行。':result.status==='queued'?'已确认原会话排队回执；即时引导未确认，请核对职能会话。':'已投递给原 Agent，继续当前任务。';
          if(result.error)note.textContent+=' '+result.error;
          input.value='';row.request=null;notify(note.textContent);await refresh(true).catch(()=>{});
        }catch(error){note.textContent=error.message;}
        finally{row.busy=false;send.disabled=false;}
      };
    }
    row.run=run;row.task=task;row.send.textContent=task.sessionId?'发送指引并继续':'保存阶段指引';row.send.disabled=row.busy;
    row.history.replaceChildren(...(run.directions??[]).filter(d=>d.taskId===task.id).slice(-3).map(d=>{
      const item=el('div','stage-guide-record');item.append(el('small','fine',({saved:'已保存，等待本阶段执行',sending:'正在投递',delivered:'已投递',queued:'原会话排队中',uncertain:'投递未确认'}[d.status]||d.status)),el('p','',d.text));if(d.error)item.append(el('p','fine',d.error));return item;
    }));return row.form;
  };
}
