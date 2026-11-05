import {randomUUID} from 'node:crypto';
import type {RelayStore} from './store.js';
import type {Studio} from './studio.js';
import type {Action} from '../shared/protocol.js';

// Read only: answering/approving continues through the existing authenticated
// action journal. Never invent an approval or retry a production operation.
export class StudioAttention {
  private syncing=new Map<string,Promise<void>>();
  private checked=new Map<string,number>();
  private failures=new Map<string,number>();
  constructor(private store:RelayStore,private studio:Studio,private remote:(host:string,action:Action,timeout?:number)=>Promise<any>,private changed:(event:any)=>void,private isOnline:(host:string)=>boolean){}
  private context(id:string){
    const run=this.studio.runs().find(r=>r.id===id);if(!run)throw Error('制作需求不存在');
    const project=this.studio.projects().find(p=>p.id===run.projectId);if(!project)throw Error('项目组不存在');
    const tasks=[run.planner,...run.tasks,...run.delivery?[run.delivery]:[]],ids=new Set<string>();
    const entries=[...tasks.map(t=>({sessionId:t.sessionId,taskId:t.id,title:t.title,role:t.role,status:t.status})),...(run.chats??[]).filter(c=>!c.resolved).map(c=>({sessionId:c.sessionId,taskId:undefined,title:'职能对话',role:c.role,status:'chat'}))].filter(entry=>{
      if(!entry.sessionId||ids.has(entry.sessionId))return false;const s=this.store.getSession(entry.sessionId);
      if(!s||s.hostId!==project.hostId||run.workspace?.value&&s.projectId!==run.workspace.value.project.id)return false;
      ids.add(entry.sessionId);return true;
    });
    return {run,project,entries};
  }
  private pending(sessionId:string){
    const questions=new Map<string,any>(),approvals=new Map<string,any>();
    for(const e of this.store.sessionEvents(sessionId)){
      const d=e.data;
      if(['question','question.resolved'].includes(e.type)&&d?.id&&d.sessionId===sessionId)questions.set(d.id,d);
      if(e.type==='approval'&&d?.approvalId)approvals.set(d.approvalId,{...d,status:'pending'});
      if(e.type==='approval.resolved'&&d?.approvalId){if(d.unconfirmed&&approvals.has(d.approvalId))approvals.set(d.approvalId,{...approvals.get(d.approvalId),status:'unknown'});else approvals.delete(d.approvalId);}
    }
    return {questions:[...questions.values()].filter(q=>['pending','unknown'].includes(q.status)&&(!q.expiresAt||q.expiresAt>Date.now())),approvals:[...approvals.values()].filter(a=>a.expiresAt>Date.now())};
  }
  read(id:string,refresh=false){
    const {run,project,entries}=this.context(id),online=this.isOnline(project.hostId);
    if(refresh)for(const entry of entries){this.failures.delete(entry.sessionId!);this.checked.delete(entry.sessionId!);}
    const pending=entries.map(entry=>({...entry,sessionId:entry.sessionId!,online,waiting:this.store.getSession(entry.sessionId!)?.status==='waiting',syncFailures:this.failures.get(entry.sessionId!)??0,...this.pending(entry.sessionId!)})).filter(entry=>entry.questions.length||entry.approvals.length||entry.waiting);
    // Native async questions may first be discovered by a focused history read.
    // Schedule it in the background; a disconnected computer must not delay UI.
    for(const entry of entries){const s=this.store.getSession(entry.sessionId!)!;
      const failures=this.failures.get(s.id)??0;
      if(online&&failures<5&&(s.status==='waiting'||s.questionCount||!s.managed&&['running','blocked'].includes(entry.status))&&!this.syncing.has(s.id)&&Date.now()-(this.checked.get(s.id)??0)>(failures?60_000:15_000))this.sync(project.hostId,s.id);
    }
    return {runId:run.id,checkedAt:Date.now(),refreshing:entries.some(e=>this.syncing.has(e.sessionId!)),entries:pending};
  }
  private sync(hostId:string,sessionId:string){
    this.checked.set(sessionId,Date.now());
    const job=(async()=>{try{
      const page=await this.remote(hostId,{id:randomUUID(),type:'history',sessionId,live:true},8000);
      if(!page.cached)this.failures.delete(sessionId);
      if(page.cached||!Array.isArray(page.questions)||!Number.isFinite(page.questionsAsOf))return;
      for(const card of page.questions){
        if(card?.sessionId!==sessionId||card.status!=='pending'||!Array.isArray(card.questions))continue;
        const row=this.store.db.prepare("SELECT json FROM events WHERE session_id=? AND json_extract(json,'$.data.id')=? AND json_extract(json,'$.type') IN ('question','question.resolved') ORDER BY seq DESC LIMIT 1").get(sessionId,card.id),old=row?JSON.parse(String(row.json)).data:undefined;
        if(old&&old.status!=='pending'||old&&JSON.stringify(old)===JSON.stringify(card))continue;
        this.record(hostId,sessionId,'question',card);
      }
      // Resolution belongs to the original QuestionBroker / answer receipt.
      // A concurrent history snapshot must never erase a new or answered card.
    }catch{this.failures.set(sessionId,(this.failures.get(sessionId)??0)+1);/* Cached cards remain; writes are never retried. */}finally{this.syncing.delete(sessionId);}})();
    this.syncing.set(sessionId,job);
  }
  private record(hostId:string,sessionId:string,type:'question'|'question.resolved',data:any){const event={id:randomUUID(),hostId,sessionId,type,at:Date.now(),data};this.store.event(event);this.changed(event);}
  async close(){await Promise.allSettled(this.syncing.values());}
}
