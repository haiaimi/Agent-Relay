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
  if(message.role!=='user')return message;
  const task=provider==='claude'&&!message.label?.startsWith('你 ·')?claudeTaskNotification(message.text):null;
  return task?{...message,...task,role:'tool'}:displayUserMessage(message);
}

// Uploaded files use UUIDs; native image history uses the content SHA-256.
// Prefer the original upload card when both describe the same bytes. Scope this
// to one message so intentional repeated sends and assistant output stay intact.
export function displayUserMessage(message){
  if(message.role!=='user')return message;
  const envelope=userImageEnvelope(message.text,[...message.files??[],...message.images??[]]);
  const nativeImages=[];
  for(let i=0;i<(message.images?.length??0);i++){
    const image=message.images[i],inline=message.images[i+1];
    // Native transcripts include both an original path and its resized inline
    // companion inside a single image envelope. Their byte hashes can differ.
    if(envelope.names.includes(image.name)&&inline?.name==='图片'&&inline.id){nativeImages.push(image.id?image:{...inline,name:image.name});i++;}
    else nativeImages.push(image);
  }
  const files=[],fileIds=new Set(),hashes=new Set(),images=[],imageIds=new Set();
  for(const file of message.files??[]){
    if(file.id&&fileIds.has(file.id))continue;
    files.push(file);if(file.id)fileIds.add(file.id);
    if(/^(?:image|video)\//.test(file.mime??'')&&/^[a-f0-9]{64}$/i.test(file.sha256??''))hashes.add(file.sha256.toLowerCase());
  }
  for(const image of nativeImages){
    const id=image.id?.toLowerCase();
    if(envelope.names.includes(image.name)&&files.some(f=>f.name===image.name&&/^(?:image|video)\//.test(f.mime??'')))continue;
    if(id&&(hashes.has(id)||imageIds.has(id)))continue;
    images.push(image);if(id)imageIds.add(id);
  }
  const text=userMessageText(envelope.text);
  if(text===message.text&&files.length===(message.files?.length??0)&&images.length===(message.images?.length??0))return message;
  return {...message,text,...message.files?{files}:{},...message.images?{images}:{}};
}

function userImageEnvelope(value,refs){
  const text=String(value??''),tail=/(?:\r?\n)?(?:<image name=\[Image #\d+\] path="[^"\r\n]+">\s*<\/image>\s*)+$/.exec(text);
  if(!tail)return {text,names:[]};
  const paths=[...tail[0].matchAll(/path="([^"\r\n]+)"/g)].map(m=>m[1]),names=paths.map(p=>p.replace(/\\/g,'/').split('/').at(-1));
  if(paths.some(p=>! /^(?:[A-Za-z]:[\\/]|\/)/.test(p))||names.some(n=>!refs.some(r=>r.name===n)))return {text,names:[]};
  return {text:text.slice(0,tail.index).trimEnd(),names};
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
  // This exact footer is added by Relay's transport, never entered into the
  // composer. Match only complete generated upload paths at the end; ordinary
  // user paths, headings and quoted/fenced examples remain visible.
  const footer=/(?:^|\r?\n\r?\n)用户附加文件（参考资料）：\r?\n([\s\S]+)$/.exec(text);
  if(footer&&footer[1].split(/\r?\n/).every(line=>{
    const entry=/^([^\r\n]+?): ((?:[A-Za-z]:[\\/]|\/)[^\r\n]+)$/.exec(line);
    if(!entry)return false;
    const path=entry[2].replace(/\\/g,'/');
    return /\/uploads\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\//i.test(path)&&path.split('/').at(-1)===entry[1];
  })){text=text.slice(0,footer.index);}
  return questionReplyText(unwrapped?text.trim():text);
}
