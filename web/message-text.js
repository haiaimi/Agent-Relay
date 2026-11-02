// Presentation only: retain the original prompt and attachment references in history.
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
  return unwrapped?text.trim():text;
}
