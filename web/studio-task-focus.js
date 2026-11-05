// Reopening an already selected dialog does not reveal any new information.
// Resolve the relevant section, then scroll only its existing detail container.
export function taskFocusKind(task,session){
 if(task.status==='awaiting-review'||session?.status==='waiting'||session?.questionCount||task.recovery?.phase==='waiting-input')return 'attention';
 if(task.status==='blocked')return 'blocker';
 if(['running','starting'].includes(task.status))return 'execution';
 return 'delivery';
}
export function revealTaskSection(element,container,reducedMotion=false){
 if(!element||!container||element.hidden)return false;
 for(let parent=element.parentElement;parent&&parent!==container;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
 const top=element.getBoundingClientRect().top-container.getBoundingClientRect().top+container.scrollTop-12;
 element.tabIndex=-1;element.focus({preventScroll:true});
 container.scrollTo({top:Math.max(0,Math.min(top,container.scrollHeight-container.clientHeight)),behavior:reducedMotion?'auto':'smooth'});
 element.classList.remove('task-revealed');void element.offsetWidth;element.classList.add('task-revealed');return true;
}
