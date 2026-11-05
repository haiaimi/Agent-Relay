// Share keyboard behavior without depending on session/provider state. The
// submit callback uses the same form handler and in-flight guard as the button.
export function setupComposerKeys(input,commands,submit,now=()=>performance.now(),sendOnEnter=()=>true){
  let composing=false,endedAt=-Infinity;
  input.addEventListener('compositionstart',()=>{composing=true;});
  input.addEventListener('compositionend',()=>{composing=false;endedAt=now();});
  input.addEventListener('keydown',e=>{
    // Safari can end composition immediately before the confirming Enter.
    if(composing||e.isComposing||e.keyCode===229||now()-endedAt<50)return;
    if(!sendOnEnter())return;
    if(e.key==='Enter'&&e.repeat){e.preventDefault();return;}
    if(commands.open()){
      if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();commands.move(e.key==='ArrowDown'?1:-1);return;}
      if(!e.shiftKey&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&(e.key==='Tab'||e.key==='Enter')){
        e.preventDefault();const candidate=commands.current();
        if(e.key==='Enter'&&candidate&&!candidate.argumentHint&&input.value.trim()==='/'+candidate.name){commands.hide();submit();}
        else commands.complete();
        return;
      }
      if(e.key==='Escape'){e.preventDefault();commands.hide();return;}
    }
    if(e.key==='Enter'&&!e.shiftKey&&!e.altKey){e.preventDefault();submit();}
  });
}

// Studio replies share the button's validation, attachment and in-flight path.
// Touch keyboards keep Enter for newlines; the PC shortcut follows its input device.
export function setupReplyKeys(input,button,desktop=()=>matchMedia('(hover: hover) and (pointer: fine)').matches){
  setupComposerKeys(input,{open:()=>false},()=>{if(!button.disabled)input.form.requestSubmit(button);},undefined,desktop);
}
