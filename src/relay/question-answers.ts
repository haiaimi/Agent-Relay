import {randomUUID} from 'node:crypto';
import {asyncQuestionReply,missingDesktopOwner,questionReplyId} from '../shared/async-answers.js';
import type {QuestionCard} from '../shared/questions.js';
import type {Action} from '../shared/protocol.js';
import type {RelayStore} from './store.js';
import type {Studio} from './studio.js';

const acknowledged=(result:any,sessionId:string)=>!!result&&!result.error&&(!result.sessionId||result.sessionId===sessionId)&&(result.ok===true||result.sessionId===sessionId);

// Compatibility for connected workers whose question callbacks still use only
// desktop IPC. The ordinary send path already owns headless resume and queueing.
export class QuestionAnswers {
  constructor(private store:RelayStore,private studio:Studio,private remote:(host:string,action:Action)=>Promise<any>,private changed:(event:any)=>void){}
  card(action:Action):QuestionCard|undefined{
    if(action.type!=='answer')return;
    const row=this.store.db.prepare("SELECT json FROM events WHERE session_id=? AND json_extract(json,'$.data.id')=? AND json_extract(json,'$.type') IN ('question','question.resolved') ORDER BY seq DESC LIMIT 1").get(action.sessionId!,action.questionId!);
    return row?JSON.parse(String(row.json)).data:undefined;
  }
  async fallback(host:string,action:Action,error:unknown,automatic=false){
    if(action.type!=='answer'||!missingDesktopOwner(error)||this.store.getSession(action.sessionId!)?.provider!=='codex')throw error;
    const card=this.card(action);if(!card||card.sessionId!==action.sessionId||!card.source.startsWith('async:'))throw error;
    const {text}=asyncQuestionReply(card,action.answers),id=questionReplyId(action.sessionId!,card.source);
    const prior=this.store.db.prepare('SELECT host_id,request,result FROM actions WHERE id=?').get(id);
    if(prior){
      const request=JSON.parse(String(prior.request));
      if(prior.host_id!==host||request.type!=='send'||request.sessionId!==action.sessionId||!request.text.includes(text))throw Error('这张问题卡已有不同的回答投递记录，请先核对原会话');
      if(!prior.result)throw Error('回答投递结果尚未确认，请核对原会话；不会重复发送');
      const result=JSON.parse(String(prior.result));if(!acknowledged(result,action.sessionId!))throw Error(result.error??'回答投递记录未确认');return {...result,ok:true,answerFallback:true,replyActionId:id};
    }
    if(card.status!=='pending')throw Error('问题已回答或已关闭，请刷新原会话；不会重复投递');
    const run=this.studio.runs().find(r=>[r.planner,...r.tasks,...r.delivery?[r.delivery]:[]].some(t=>t.sessionId===action.sessionId));
    let result:any;
    if(run){
      if(['accepted','cancelled'].includes(run.status))throw Error('制作需求已结束，请在交付后讨论中继续，不能重开原生产任务');
      const task=[run.planner,...run.tasks,...run.delivery?[run.delivery]:[]].find(t=>t.sessionId===action.sessionId)!;
      result=await this.studio.chat({id,runId:run.id,role:task.role,sessionId:action.sessionId,text,automatic});
    }else{
      const send:Action={id,type:'send',sessionId:action.sessionId,text};this.store.beginAction(id,host,send);
      result=await this.remote(host,send);if(!acknowledged(result,action.sessionId!))throw Error('回答投递结果未确认，请核对原会话');this.store.finishAction(id,result);
    }
    return {...result,ok:true,answerFallback:true,replyActionId:id};
  }
  confirmed(host:string,action:Action,card:QuestionCard|undefined,result:any,startedAt:number){
    if(action.type!=='answer'||!card||card.sessionId!==action.sessionId||!acknowledged(result,action.sessionId!))return;
    const event={id:randomUUID(),hostId:host,sessionId:action.sessionId,type:'question.resolved' as const,at:Date.now(),data:{...card,status:'answered',automatic:result.automatic===true,decisionReason:result.decisionReason,answers:action.answers,delivery:result.queued?'queued':'sent'}};
    this.store.event(event);this.changed(event);
    if(!result.answerFallback){
      const text=card.source.startsWith('async:')?asyncQuestionReply(card,action.answers).text:card.questions.map(q=>q.question+'\n'+action.answers![q.id]?.join(', ')).join('\n\n');
      this.studio.noteQuestionAnswer(action.id,action.sessionId!,text,startedAt,result.automatic===true);
    }
  }
}
