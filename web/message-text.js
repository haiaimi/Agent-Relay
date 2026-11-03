// Presentation only: retain the original prompt and attachment references in history.
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
