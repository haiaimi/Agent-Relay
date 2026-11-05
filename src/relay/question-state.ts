import type {RelayStore} from './store.js';
import type {Session,RelayEvent} from '../shared/protocol.js';
import type {QuestionCard} from '../shared/questions.js';

// Legacy workers can retain an async question after a server fallback delivered
// its answer. Reconcile exact live card identities, never subtract historical
// answers from a bare counter or infer an answer from subsequent activity.
export class QuestionState {
  private revisions=new Map<string,number>();
  constructor(private store:RelayStore){store.db.exec('CREATE TABLE IF NOT EXISTS question_snapshots(session_id TEXT PRIMARY KEY,json TEXT NOT NULL)');}
  revision(sessionId:string){return this.revisions.get(sessionId)??0;}
  private answered(card:QuestionCard){
    const rows=this.store.db.prepare("SELECT json FROM events WHERE session_id=? AND json_extract(json,'$.type')='question.resolved' AND json_extract(json,'$.data.status')='answered' AND json_extract(json,'$.data.delivery') IN ('sent','queued') AND (json_extract(json,'$.data.id')=? OR json_extract(json,'$.data.source')=?) ORDER BY seq DESC").all(card.sessionId,card.id,card.source);
    return rows.some(row=>{const old=JSON.parse(String(row.json)).data;return old.sessionId===card.sessionId&&JSON.stringify(old.questions)===JSON.stringify(card.questions);});
  }
  observe(event:RelayEvent){
    if(event.type==='question'&&event.data.status==='pending'&&!this.answered(event.data as QuestionCard)){this.revisions.set(event.sessionId,this.revision(event.sessionId)+1);this.store.db.prepare('DELETE FROM question_snapshots WHERE session_id=?').run(event.sessionId);}
  }
  project(session:Session):Session{
    if(!session.questionCount)return session;
    const row=this.store.db.prepare('SELECT json FROM question_snapshots WHERE session_id=?').get(session.id);if(!row)return session;
    const cards:QuestionCard[]=JSON.parse(String(row.json)).cards;
    // A changed raw count can represent a new question whose event is in flight.
    if(session.questionCount!==cards.length)return session;
    const count=cards.filter(card=>!this.answered(card)).length;
    return count===session.questionCount?session:{...session,questionCount:count};
  }
  refresh(sessionId:string){const session=this.store.getSession(sessionId);if(session){const projected=this.project(session);if(projected!==session)this.store.session(projected);return projected;}}
  snapshot(sessionId:string,page:any,revision=this.revision(sessionId)){
    if(page.cached||!Array.isArray(page.questions)||!Number.isFinite(page.questionsAsOf))return page;
    if(revision!==this.revision(sessionId))return page;
    const old=this.store.db.prepare('SELECT json FROM question_snapshots WHERE session_id=?').get(sessionId);
    if(old&&JSON.parse(String(old.json)).asOf>page.questionsAsOf)return page;
    if(page.questions.length>30||page.questions.some((c:any)=>c?.sessionId!==sessionId||typeof c.id!=='string'||typeof c.source!=='string'||c.status!=='pending'||!Array.isArray(c.questions))){this.store.db.prepare('DELETE FROM question_snapshots WHERE session_id=?').run(sessionId);return page;}
    this.store.db.prepare('INSERT OR REPLACE INTO question_snapshots VALUES(?,?)').run(sessionId,JSON.stringify({cards:page.questions,asOf:page.questionsAsOf}));
    this.refresh(sessionId);
    return {...page,questions:page.questions.filter((card:QuestionCard)=>!this.answered(card))};
  }
}
