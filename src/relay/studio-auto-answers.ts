import {randomUUID} from 'node:crypto';
import {automaticAnswer,autoQuestionId} from './studio-autonomy.js';
import type {Studio,StudioRun,Task} from './studio.js';
import type {StudioAttention} from './studio-attention.js';
import type {RelayStore} from './store.js';
import type {Action} from '../shared/protocol.js';
import type {QuestionCard} from '../shared/questions.js';

interface Decision {id:string;runId:string;taskId:string;sessionId:string;questionId:string;source:string;at:number;dueAt:number;phase:'pending'|'sending'|'answered'|'queued'|'closed'|'manual'|'uncertain'|'failed';attempts:number;reason?:string;answers?:Record<string,string[]>;actionId?:string;error?:string}
export class StudioAutoAnswers {
  private closed=false;private ticking=false;private jobs=new Set<Promise<void>>();private busySessions=new Set<string>();private timer?:NodeJS.Timeout;
  constructor(private store:RelayStore,private studio:Studio,private attention:StudioAttention,private remote:(host:string,a:Action,timeout?:number)=>Promise<any>,private submit:(host:string,a:Action,reason:string)=>Promise<any>,private online:(host:string)=>boolean,private changed:()=>void,private now=()=>Date.now(),start=true){
    store.db.exec('CREATE TABLE IF NOT EXISTS studio_auto_answers(id TEXT PRIMARY KEY,json TEXT NOT NULL)');
    for(const d of this.records())if(d.phase==='sending'){
      const row=d.actionId?store.db.prepare('SELECT result FROM actions WHERE id=?').get(d.actionId):undefined;
      const result=row?.result?JSON.parse(String(row.result)):undefined;
      if(result&&!result.error&&(result.ok===true||result.sessionId===d.sessionId)){d.phase=result.queued?'queued':'answered';d.error=undefined;}
      else{d.phase='uncertain';d.error='服务重启时回答回执未确认，保留原记录且不重复投递';}
      this.save(d);
    }
    if(start){this.timer=setInterval(()=>void this.tick(),3000);this.timer.unref();}
  }
  records(){return this.store.db.prepare('SELECT json FROM studio_auto_answers ORDER BY rowid DESC LIMIT 200').all().map(r=>JSON.parse(String(r.json)) as Decision);}
  private save(d:Decision){this.store.db.prepare('INSERT OR REPLACE INTO studio_auto_answers VALUES(?,?)').run(d.id,JSON.stringify(d));this.changed();}
  private tasks(r:StudioRun){return [r.planner,...r.tasks,...r.delivery?[r.delivery]:[]];}
  private eligible(r:StudioRun,t:Task){const migration=(r as StudioRun&{migration?:{phase:string}}).migration;return !r.paused&&(!migration||migration.phase==='complete')&&r.autoAnswerQuestions!==false&&!r.workflow?.error&&r.workspace?.status==='ready'&&['planning','executing','delivery'].includes(r.status)&&!t.kind&&!!t.sessionId&&['running','blocked'].includes(t.status)&&t.dependencies.every(id=>r.tasks.some(x=>x.id===id&&(x.status==='done'||x.status==='skipped'&&x.skip)));}
  private cards(sessionId:string){
    const rows=this.store.db.prepare("SELECT json FROM events WHERE session_id=? AND json_extract(json,'$.type') IN ('question','question.resolved') ORDER BY seq DESC LIMIT 100").all(sessionId),latest=new Map<string,QuestionCard>();
    for(const row of rows){const c=JSON.parse(String(row.json)).data;if(c?.sessionId===sessionId&&typeof c.id==='string'&&!latest.has(c.id))latest.set(c.id,c);}
    return [...latest.values()].filter(c=>c.status==='pending'&&(!c.expiresAt||c.expiresAt>this.now()));
  }
  async tick(){
    if(this.closed||this.ticking)return;this.ticking=true;
    try{
      for(const run of this.studio.runs()){
        const tasks=this.tasks(run).filter(t=>this.eligible(run,t));if(!tasks.length)continue;
        const project=this.studio.projects().find(p=>p.id===run.projectId);if(!project)continue;
        // Discover questions without requiring a browser or role chat to be open.
        if(this.online(project.hostId))this.attention.read(run.id,false,true);
        for(const task of tasks){
          const session=this.store.getSession(task.sessionId!);if(!session||session.hostId!==project.hostId||session.projectId!==run.workspace?.value?.project.id)continue;
          for(const card of this.cards(session.id)){
            if(typeof card.source!=='string'||!Array.isArray(card.questions))continue;
            const id=autoQuestionId(session.id,card),row=this.store.db.prepare('SELECT json FROM studio_auto_answers WHERE id=?').get(id);
            const d:Decision=row?JSON.parse(String(row.json)):{id,runId:run.id,taskId:task.id,sessionId:session.id,questionId:card.id,source:card.source,at:this.now(),dueAt:this.now()+10000,phase:'pending',attempts:0};
            if(!row)this.save(d);
            if(d.phase!=='pending'||d.dueAt>this.now()||this.busySessions.has(session.id)||!this.online(project.hostId))continue;
            d.phase='sending';d.attempts++;this.save(d);this.busySessions.add(session.id);
            const job=this.answer(d,project.hostId,card);this.jobs.add(job);void job.catch(()=>{}).finally(()=>{this.jobs.delete(job);this.busySessions.delete(session.id);});
          }
        }
      }
    }catch{/* An unavailable database/discovery must not create an unhandled timer rejection. */}finally{this.ticking=false;}
  }
  private async answer(d:Decision,host:string,original:QuestionCard){
    try{
      const page=await this.remote(host,{id:randomUUID(),type:'history',sessionId:d.sessionId,live:true},8000);
      if(page.cached||!Array.isArray(page.questions)||!Number.isFinite(page.questionsAsOf))throw Error('问题实时状态尚未确认');
      const card:QuestionCard|undefined=page.questions.find((q:QuestionCard)=>q.sessionId===d.sessionId&&q.source===original.source&&q.status==='pending'&&JSON.stringify(q.questions)===JSON.stringify(original.questions));
      if(!card){d.phase='closed';d.reason='实时核对显示问题已回答或关闭';this.save(d);return;}
      const run=this.studio.runs().find(r=>r.id===d.runId),task=run&&this.tasks(run).find(t=>t.id===d.taskId);
      if(this.closed||!run||!task||!this.eligible(run,task)){d.phase='pending';d.dueAt=this.now()+10000;this.save(d);return;}
      // A human submission in flight or with an unknown receipt owns this card.
      const attempted=this.store.db.prepare("SELECT result FROM actions WHERE host_id=? AND json_extract(request,'$.type')='answer' AND json_extract(request,'$.sessionId')=? AND json_extract(request,'$.questionId')=?").all(host,d.sessionId,card.id);
      if(attempted.some(a=>!a.result||JSON.parse(String(a.result)).error)){d.phase='uncertain';d.error='已有回答投递需核对，不重复提交自动答案';this.save(d);return;}
      const directive=(run.guidance??[]).filter(g=>!g.automatic&&!g.text.includes('<send_user_message_question_reply>')).slice(-3).map(g=>g.text).join('\n');
      const decision=automaticAnswer(card,{brief:run.title+'\n'+run.brief,directive,planning:task===run.planner||task.id==='studio-plan'});
      d.questionId=card.id;d.reason=decision.reason;d.answers=decision.answers;
      if(!decision.answers){d.phase='manual';this.save(d);return;}
      d.actionId??=randomUUID();this.save(d);
      const result=await this.submit(host,{id:d.actionId,type:'answer',sessionId:d.sessionId,questionId:card.id,answers:decision.answers},decision.reason);
      if(result?.error||!(result?.ok===true||result?.sessionId===d.sessionId))throw Error('回答投递回执未确认');
      d.phase=result.queued?'queued':'answered';d.error=undefined;this.save(d);
      this.studio.recordAutomaticAnswer(run.id,task.id,card.questions.map(q=>q.question+'\n答：'+decision.answers![q.id].join(', ')).join('\n\n')+'\n依据：'+decision.reason+'\n'+(result.queued?'已进入原会话队列':'已送达原会话')+'；所选制作人审批未改变');
    }catch(error){
      const message=(error as Error).message;
      // Reads and definitely-undispatched offline writes may retry; uncertain writes may not.
      if((!d.actionId||/^本地电脑离线|^工作电脑离线|^Bridge not connected/.test(message))&&d.attempts<5){d.phase='pending';d.dueAt=this.now()+60000;d.actionId=undefined;}
      else d.phase=d.actionId?'uncertain':'failed';
      d.error=message;this.save(d);
    }
  }
  async close(){this.closed=true;if(this.timer)clearInterval(this.timer);await Promise.allSettled(this.jobs);}
}
