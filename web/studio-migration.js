export function migrationView(run){
  const m=run.migration;if(!m)return {label:'换电脑接力',pending:false};
  const labels={freezing:'正在停止旧电脑任务',exporting:'正在保存制作现场',uploading:'正在传到新电脑',restoring:'正在恢复独立工作副本',complete:'已在新电脑接力',failed:'接力已暂停，可重试'};
  const progress=m.total?Math.min(100,Math.floor((m.done||0)/m.total*100)):undefined;
  return {label:labels[m.phase]||'正在接力',progress,pending:m.phase!=='complete',failed:m.phase==='failed'};
}
export function studioMigration({api,notify,hosts,sourceHost,devices,changed}){
  const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const button=(text,action)=>{const b=node('button',text);b.type='button';b.className='quiet';b.onclick=()=>Promise.resolve().then(action).catch(e=>notify(e.message));return b;};
  async function start(run,hostId,path){const result=await api('studio/migrate',{runId:run.id,hostId,path});await changed(result.run);notify('接力请求已保存，可以关闭窗口；进度会持续更新。');}
  function open(run){
    const dialog=node('dialog'),form=node('form'),heading=node('div');heading.className='dialog-heading';heading.append(node('h2','换电脑接力'),button('关闭',()=>dialog.close()));
    const note=node('p','选择新电脑，填写该电脑上的 game 仓库路径。系统会停止原任务、保存未提交文件，再创建独立工作副本继续；已完成步骤与审批保留。');note.className='fine';
    const hostLabel=node('label','新电脑'),select=node('select'),pathLabel=node('label','game 仓库路径'),path=node('input'),error=node('p');error.className='error';error.setAttribute('role','alert');
    const available=hosts().filter(h=>h.online&&h.capabilities?.studioMigration&&h.id!==sourceHost(run));
    for(const h of available){const option=node('option',h.name);option.value=h.id;select.append(option);}select.required=true;hostLabel.append(select);
    if(run.migration?.phase==='failed'){select.value=run.migration.targetHostId;path.value=run.migration.targetPath;}
    path.required=true;path.autocomplete='off';path.placeholder='例如 E:\\Projects\\MyGame';pathLabel.append(path);
    select.onchange=()=>{const device=devices(run).find(d=>d.hostId===select.value),host=hosts().find(h=>h.id===select.value);path.value=device?device.path||(host?.projects.find(p=>p.id===device.projectId)?.roots??[host?.projects.find(p=>p.id===device.projectId)?.path])[device.workspaceIndex]||'':'';};
    if(run.migration?.phase!=='failed')select.onchange();
    const submit=node('button','开始接力');submit.className='primary';submit.disabled=!available.length;
    if(!available.length)error.textContent='暂无支持接力的在线电脑，请先启动新版连接程序。';
    form.onsubmit=async e=>{e.preventDefault();submit.disabled=true;error.textContent='';try{await start(run,select.value,path.value.trim());dialog.close();}catch(e){error.textContent=e.message;submit.disabled=false;}};
    form.append(heading,note,hostLabel,pathLabel,error,submit);dialog.append(form);dialog.className='migration-dialog';dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();
  }
  return {panel(run){
    const view=migrationView(run),box=node('section');box.className='workspace-summary';box.dataset.migration='';box.append(node('strong',view.label));
    const current=hosts().find(h=>h.id===sourceHost(run)),count=new Set(devices(run).map(d=>d.hostId)).size;box.append(node('p','本需求执行设备：'+(current?.name||'未连接')+(count?' · 本项目已关联 '+count+' 台电脑':'')));
    if(run.migration){const m=run.migration;box.append(node('p',m.targetPath));if(view.progress!==undefined&&!view.failed&&m.phase!=='complete'){const progress=node('progress');progress.max=100;progress.value=view.progress;progress.setAttribute('aria-label','迁移传输进度');box.append(progress,node('span',view.progress+'%'));}if(m.error){const error=node('p',m.error);error.className='error';box.append(error);}}
    if(view.failed)box.append(button('重试接力',()=>start(run,run.migration.targetHostId,run.migration.targetPath)),button('修改目标电脑 / 路径',()=>open(run)));
    else if(!view.pending&&run.workspace?.status==='ready'&&run.status!=='cancelled')box.append(button('换电脑接力',()=>open(run)));
    if(view.pending){const note=node('p','原制作现场与记录已保留；接力完成后从未完成步骤继续。');note.className='fine';box.append(note);}
    return box;
  }};
}
