import {createHash} from 'node:crypto';
import {validateAnswers,type QuestionCard} from './questions.js';

export function missingDesktopOwner(error:unknown){
  if((error as {uncertain?:boolean})?.uncertain)return false;
  return /未找到(?:支持引导的)?本地 Codex 窗口|^no-client-found$/i.test((error as Error)?.message??'');
}
export function questionReplyId(sessionId:string,source:string){
  const h=createHash('sha256').update('async-answer\0'+sessionId+'\0'+source).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
export function asyncQuestionReply(card:QuestionCard,value:unknown){
  if(!card.source.startsWith('async:')||!card.source.slice(6))throw Error('此问题不是异步设计提问');
  const answers=validateAnswers(card.questions,value),source=card.source.slice(6);
  const replies=card.questions.map((q,i)=>({questionItemId:JSON.stringify(['request_user_input_async',source,q.sourceIndex??i]),question:q.question,answer:answers[q.id].join(', ')}));
  return {answers,text:'<send_user_message_question_reply>\n'+JSON.stringify(replies)+'\n</send_user_message_question_reply>'};
}
