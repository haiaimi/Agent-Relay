import {randomUUID} from 'node:crypto';
import {validateAnswers,type QuestionCard,type UserQuestion} from '../shared/questions.js';
interface Pending {card:QuestionCard;submit:(answers:Record<string,string[]>)=>Promise<void>;cancel:()=>void;busy:boolean}
export class QuestionBroker {
  private pending=new Map<string,Pending>();private sources=new Map<string,string>();private settled=new Map<string,QuestionCard>();private asking=new Map<string,Promise<Record<string,string[]>|undefined>>();
  constructor(private changed:(card:QuestionCard)=>void){}
  attach(sessionId:string,source:string,questions:UserQuestion[],submit:Pending['submit'],cancel=()=>{},timeout?:number):QuestionCard{
    const key=sessionId+'|'+source,prior=this.sources.get(key);if(prior&&this.pending.has(prior)){const p=this.pending.get(prior)!;if(!p.busy){p.submit=submit;if(JSON.stringify(p.card.questions)!==JSON.stringify(questions)){p.card={...p.card,questions};this.changed(p.card);}}return p.card;}if(this.settled.has(key))return this.settled.get(key)!;
    const card:QuestionCard={id:randomUUID(),sessionId,source,questions,status:'pending',createdAt:Date.now(),...(timeout&&timeout>0?{expiresAt:Date.now()+timeout}:{})};
    let timer:NodeJS.Timeout|undefined;
    const p:Pending={card,submit,cancel:()=>{if(timer)clearTimeout(timer);cancel();},busy:false};this.pending.set(card.id,p);this.sources.set(key,card.id);this.changed(card);
    if(timeout&&timeout>0){timer=setTimeout(()=>this.cancel(card.id,'expired'),timeout);timer.unref();}return card;
  }
  ask(sessionId:string,source:string,questions:UserQuestion[],signal?:AbortSignal,timeout?:number):Promise<Record<string,string[]>|undefined>{
    const key=sessionId+'|'+source,prior=this.asking.get(key);if(prior)return prior;
    const result=new Promise<Record<string,string[]>|undefined>(resolve=>{
      let card:QuestionCard;const abort=()=>this.cancel(card.id);
      const finish=(value:Record<string,string[]>|undefined)=>{signal?.removeEventListener('abort',abort);resolve(value);};
      card=this.attach(sessionId,source,questions,async answers=>finish(answers),()=>finish(undefined),timeout);
      if(card.status!=='pending'){finish(card.status==='answered'?card.answers:undefined);return;}
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });
    this.asking.set(key,result);void result.finally(()=>this.asking.delete(key));return result;
  }
  async answer(sessionId:string,id:string,value:unknown){
    const pending=this.pending.get(id);if(!pending||pending.card.sessionId!==sessionId)throw new Error('问题已回答、失效或不属于此会话，请刷新');
    if(pending.busy)throw new Error('回答正在提交，请勿重复操作');
    const answers=validateAnswers(pending.card.questions,value);pending.busy=true;
    try{await pending.submit(answers);this.pending.delete(id);this.sources.delete(sessionId+'|'+pending.card.source);pending.cancel();this.finish({...pending.card,status:'answered',answers});}
    catch(error){if((error as {uncertain?:boolean}).uncertain){this.pending.delete(id);pending.cancel();this.finish({...pending.card,status:'unknown'});}else pending.busy=false;throw error;}
  }
  list(sessionId:string){return [...this.pending.values()].filter(p=>p.card.sessionId===sessionId).map(p=>p.card);}
  reconcile(sessionId:string,prefix:string,active:Set<string>){for(const p of this.pending.values())if(p.card.sessionId===sessionId&&p.card.source.startsWith(prefix)&&!active.has(p.card.source))this.cancel(p.card.id);}
  private finish(card:QuestionCard){this.settled.set(card.sessionId+'|'+card.source,card);if(this.settled.size>500)this.settled.delete(this.settled.keys().next().value!);this.changed(card);}
  cancel(id:string,status:'cancelled'|'expired'='cancelled'){const p=this.pending.get(id);if(!p)return;this.pending.delete(id);this.sources.delete(p.card.sessionId+'|'+p.card.source);p.cancel();this.finish({...p.card,status});}
  cancelSession(sessionId:string){for(const p of [...this.pending.values()])if(p.card.sessionId===sessionId)this.cancel(p.card.id);}
  close(){for(const id of [...this.pending.keys()])this.cancel(id);}
}
