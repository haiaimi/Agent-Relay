export interface UserQuestion {id:string;header:string;question:string;options:{label:string;description:string}[];multiSelect:boolean;allowOther:boolean;secret?:boolean;sourceIndex?:number}
export interface QuestionCard {delivery?:'queued'|'sent';id:string;sessionId:string;questions:UserQuestion[];status:'pending'|'answered'|'cancelled'|'expired'|'unknown';answers?:Record<string,string[]>;createdAt:number;expiresAt?:number;source:string}
export function normalizeQuestions(raw:unknown,source:'codex'|'claude'|'async'):UserQuestion[]{
  if(!Array.isArray(raw)||!raw.length||raw.length>10)throw new Error('问题格式无效');
  const questions=raw.map((q,index)=>{
    const text=String(q.question??q.title??'');if(!text||text.length>8000)throw new Error('问题内容无效');
    const options=(Array.isArray(q.options)?q.options:[]).map((o:any)=>({label:String(typeof o==='string'?o:o.label??''),description:String(typeof o==='string'?'':o.description??'')}));
    if(options.length>30||options.some((o:any)=>!o.label||o.label.length>2000||o.description.length>4000))throw new Error('问题选项无效');
    return {id:String(q.id??'q'+index),header:String(q.header??'问题 '+(index+1)).slice(0,100),question:text,options,multiSelect:q.multiSelect===true,allowOther:source!=='codex'||q.isOther!==false||!options.length,secret:q.isSecret===true};
  });
  if(questions.some(q=>q.id.length>160||['__proto__','constructor','prototype'].includes(q.id))||new Set(questions.map(q=>q.id)).size!==questions.length)throw new Error('问题 ID 无效');return questions;
}
export function validateAnswers(questions:UserQuestion[],value:unknown):Record<string,string[]>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('请填写回答');
  const entries=Object.entries(value);if(entries.length!==questions.length)throw new Error('请回答所有问题');
  const answers:Record<string,string[]>={};let total=0;
  for(const q of questions){const values=(value as Record<string,unknown>)[q.id];if(!Array.isArray(values)||!values.length||values.length>(q.multiSelect?30:1)||values.some(v=>typeof v!=='string'||!v.trim()||v.length>8000)||new Set(values).size!==values.length)throw new Error('请为每个问题选择选项或填写回答');
    if(!q.allowOther&&values.some(v=>!q.options.some(o=>o.label===v)))throw new Error('请从给定选项中选择');
    total+=values.join('').length;answers[q.id]=values.map(v=>v.trim());
  }if(total>24000)throw new Error('回答内容过长');return answers;
}
