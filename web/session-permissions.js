const names={request:'请求批准',auto:'帮我批准',full:'完整权限'};

export function permissionPresentation(session,loading=false){
  const current=session.permissionLabel||names[session.permissionMode]||(loading?'读取权限中…':'权限未读取');
  const next=names[session.nextPermissionMode]||'';
  const pending=next?`下一轮：${next}`:'';
  const summary=`当前：${current}`+(pending?`；${pending}`:'');
  return {current,pending,summary,mode:session.permissionMode||'',selectedMode:session.nextPermissionMode??session.permissionMode??'',preview:pending?`当前：${current}`:current,
    note:summary+(pending?'。下一轮开始时生效，当前任务继续使用当前权限。':'。仅应用于当前会话；Agent 强制要求的确认仍会显示。'),
    options:Object.keys(names).map(mode=>({mode,selected:mode===(session.nextPermissionMode??session.permissionMode),status:[mode===session.permissionMode?'当前生效':'',mode===session.nextPermissionMode?'下一轮生效':''].filter(Boolean).join(' · ')}))};
}

// Keep the chip, its color and the menu's effective-time labels in agreement.
export function renderPermissionControls(session,{preview,toggle,menu,loading=false}){
  const view=permissionPresentation(session,loading);
  let current=preview.querySelector('.permission-current'),pending=preview.querySelector('.permission-next');
  if(!current||!pending){
    current=document.createElement('span');current.className='permission-current';
    pending=document.createElement('span');pending.className='permission-next';
    preview.replaceChildren(current,pending);
  }
  current.textContent=view.preview;pending.textContent=view.pending;pending.hidden=!view.pending;
  pending.dataset.mode=session.nextPermissionMode||'';
  toggle.dataset.mode=view.mode;toggle.setAttribute('aria-label','会话权限：'+view.summary);
  for(const state of view.options){
    const option=menu.querySelector(`[data-permission="${state.mode}"]`);
    if(!option)continue;
    option.setAttribute('aria-pressed',String(state.selected));
    let badge=option.querySelector('.permission-state');
    if(!badge){badge=document.createElement('span');badge.className='permission-state';option.querySelector('strong').append(badge);}
    badge.textContent=state.status;badge.hidden=!state.status;
  }
  return view;
}
