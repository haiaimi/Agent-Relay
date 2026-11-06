const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text)n.textContent=text;return n;};
export function studioPlaytests({api,notify}){
 let generation=0,timer;
 return {render(run,root){
  const stamp=++generation;let readFailures=0,statusFailures=0;if(timer)clearTimeout(timer);
  const panel=el('section','workspace-summary playtest-panel');panel.append(el('h3','','本机试玩'),el('p','fine','在工作电脑启动，可分别验证功能白模与真实游戏场景。'));root.append(panel);
  const content=el('div'),network=el('p','fine');network.setAttribute('role','status');panel.append(content,network);
  const active=()=>stamp===generation&&panel.isConnected&&panel.closest('dialog')?.open!==false&&!document.hidden;
  async function poll(id){if(!active())return;try{await api('studio/playtests/status?'+new URLSearchParams({runId:run.id,id}));statusFailures=0;network.textContent='';await load();}catch(e){statusFailures++;network.textContent='启动状态核对失败，记录已保留：'+e.message+(statusFailures<5?'；一分钟后重试':'；已尝试五次，可手动核对');if(statusFailures<5)timer=setTimeout(()=>void poll(id),60000);}}
  async function load(){
   try{
    const value=await api('studio/playtests?'+new URLSearchParams({runId:run.id}));if(stamp!==generation||!panel.isConnected)return;readFailures=0;
    content.replaceChildren();content.append(el('p','fine','工作电脑：'+value.device));if(value.worktree)content.append(el('code','',value.worktree));
    if(!value.targets.length){content.append(el('p','fine','尚未交付可操作的启动入口；功能验证完成后会在这里显示。'));return;}
    for(const entry of value.targets){
     const t=entry.target,row=el('div','task-section'),name=t.kind==='functional'?'启动功能白模测试':'启动真实游戏场景';row.append(el('strong','',t.title),el('p','fine','场景：'+t.scene),el('p','delivery-copy',t.controls),el('code','',t.script));
     const message=el('p','fine');message.setAttribute('role','status');const button=el('button','quiet',name);button.type='button';
     const current=value.requests.find(j=>j.targetId===entry.id&&j.currentTarget!==false),status=current?.result?.status;
     const existing=current&&(current.phase==='uncertain'||['sending','inspecting'].includes(current.phase)||['starting','started','ready','unknown'].includes(status));
     if(existing)button.textContent=status==='ready'?'游戏已就绪 · 核对状态':'核对启动状态';
     if(!value.available){button.disabled=true;message.textContent='本机启动服务未连接；工程和启动记录已保留。';}
     else if(current)show(current,message);
     button.onclick=async()=>{
      button.disabled=true;
      try{
       let response;
       if(existing)response=await api('studio/playtests/status?'+new URLSearchParams({runId:run.id,id:current.id}));
       else{const request={id:crypto.randomUUID(),runId:run.id,targetId:entry.id};localStorage.setItem('relay:launch:'+run.id+':'+entry.id,JSON.stringify(request));response=await api('studio/playtests/start',request);}
       show(response.launch,message);await load();
      }catch(e){message.textContent=e.message;notify(e.message);if(e.uncertain)message.textContent+=' 请核对启动状态，避免重复启动。';void load();}
      finally{button.disabled=false;}
     };
     row.append(button,message);content.append(row);
    }
    const pending=value.requests.find(j=>['inspecting','sending','uncertain'].includes(j.phase)||['starting','started','ready'].includes(j.result?.status));
    if(pending&&value.available)timer=setTimeout(()=>void poll(pending.id),3000);
   }catch(e){if(stamp===generation){readFailures++;network.textContent='启动入口暂未同步：'+e.message+(readFailures<5?'；一分钟后重试':'；已尝试五次');if(readFailures<5)timer=setTimeout(()=>{if(active())void load();},60000);}}
  }
  function show(j,node){const r=j.result;node.textContent=j.error||r?.error||(j.phase==='inspecting'?'正在核对工作副本与脚本版本':j.phase==='sending'?'启动请求正在送往工作电脑':j.phase==='uncertain'?'启动结果尚未确认，请核对状态':r?.status==='ready'?'实际场景已就绪 · PID '+r.pid:r?.status==='started'?'启动脚本已执行，等待游戏就绪回执':r?.status==='exited'?'启动进程已结束':r?.status==='failed'?'启动失败，请查看本机日志':'');if(r?.logPath)node.append(el('br'),el('span','','本机日志：'+r.logPath));}
  void load();
 }};
}
