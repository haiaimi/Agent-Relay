// Presentation only: retain the original prompt and attachment references in history.
// Shared by the native history reader and browser cache presentation. Match
// complete notification envelopes only; prose and fenced XML examples stay text.
export function claudeTaskNotification(value){
  if(typeof value!=='string'||value.length>32000)return null;
  const envelope=/^\s*<task-notification>\s*([\s\S]*?)\s*<\/task-notification>\s*$/.exec(value);
  if(!envelope)return null;
  const fields=new Map();let rest=envelope[1];
  while(rest.trim()){
    const field=/^\s*<([a-z][a-z0-9-]*)>([\s\S]*?)<\/\1>\s*/.exec(rest);
    if(!field||fields.has(field[1]))return null;
    fields.set(field[1],field[2]);rest=rest.slice(field[0].length);
  }
  const status=fields.get('status')?.trim(),summary=fields.get('summary')?.trim(),event=fields.get('event')?.trim();
  const labels={completed:'已完成',failed:'执行失败',stopped:'已停止'};
  if(!/^[a-zA-Z0-9_-]{1,200}$/.test(fields.get('task-id')??'')||!summary||!(Object.hasOwn(labels,status)||status===undefined&&event))return null;
  const decode=text=>text.replace(/&(quot|apos|lt|gt|amp);/g,(_,name)=>({quot:'"',apos:"'",lt:'<',gt:'>',amp:'&'}[name]));
  return {label:'后台任务 · '+(labels[status]??'通知'),text:[summary,event].filter(Boolean).map(decode).join('\n\n')};
}
export function displayMessage(message,provider){
  if(provider!=='claude'||message.role!=='user'||message.label?.startsWith('你 ·'))return message;
  const task=claudeTaskNotification(message.text);
  return task?{...message,...task,role:'tool'}:message;
}
function questionReplyText(text) {
  const wrapper=text.match(/^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/);
  if(!wrapper)return text;
  try{
    const replies=JSON.parse(wrapper[1]);
    if(!Array.isArray(replies)||!replies.length||replies.length>50)return text;
    for(const reply of replies){
      if(!reply||typeof reply.question!=='string'||typeof reply.answer!=='string'||typeof reply.questionItemId!=='string')return text;
      const id=JSON.parse(reply.questionItemId);
      if(!Array.isArray(id)||id.length!==3||id[0]!=='request_user_input_async'||typeof id[1]!=='string'||!Number.isInteger(id[2])||id[2]<0)return text;
    }
    return replies.map(reply=>'问题：'+reply.question+'\n回答：'+reply.answer).join('\n\n');
  }catch{return text;}
}

export function userMessageText(value) {
  let text=String(value??''),unwrapped=false;
  for(;;){
    const context=text.match(/^\s*(<in-app-browser-context\b[^>]*source="ambient-ui-state"[^>]*>[\s\S]*?<\/in-app-browser-context>|<environment_context>\s*<cwd>[\s\S]*?<\/environment_context>)\s*/);
    if(!context)break;
    text=text.slice(context[0].length);unwrapped=true;
  }
  const files=text.match(/^\s*# Files mentioned by the user:\s*\r?\n([\s\S]*?)^## My request:[ \t]*\r?\n/m);
  // Require a real generated file entry; ordinary headings/examples stay intact.
  if(files?.index===0&&/^## [^\r\n]+:[ \t]*(?:[A-Za-z]:[\\/]|\/|\r?\n(?:[A-Za-z]:[\\/]|\/))/m.test(files[1])){
    text=text.slice(files[0].length);unwrapped=true;
  }else if(unwrapped)text=text.replace(/^## My request:[ \t]*\r?\n/,'');
  return questionReplyText(unwrapped?text.trim():text);
}
