// An isolated, browser-local transport. No demo action reaches a real agent.
(() => {
  const assets=window.RELAY_DEMO_ASSETS,base=Date.now()-3600000,clone=v=>structuredClone(v),nativeFetch=window.fetch.bind(window),NativeEvents=window.EventSource;
  const hosts=[{id:'demo-pc',name:'设计与开发电脑',hostname:'STUDIO-PC',platform:'win32',online:true,lastSeen:Date.now(),capabilities:{createProject:true,permissions:true},projects:[{id:'light',name:'Light Studio',path:'E:\\Demo\\LightStudio',source:'codex'},{id:'coast',name:'Coastline',path:'E:\\Demo\\Coastline',source:'configured'}]},{id:'demo-mac',name:'随身工作电脑',hostname:'MACBOOK-PRO',platform:'darwin',online:true,lastSeen:Date.now(),capabilities:{permissions:true},projects:[{id:'notes',name:'产品文档',path:'/Users/demo/Projects/Notes',source:'configured'}]}];
  const sessions=[],transcripts=new Map(),questions=new Map(),pastEvents=new Map(),uploads=new Map(),viewers=new Set(),jobs=new Map();let seq=0;
  function session(id,title,provider,status,project='light',hostId='demo-pc'){
    const p=hosts.find(h=>h.id===hostId).projects.find(p=>p.id===project),s={id:'demo:'+id,hostId,provider,nativeId:id,title,status,projectId:p.id,projectName:p.name,projectSource:p.source,cwd:p.path,updatedAt:base+sessions.length*1000,managed:true,canSteer:true,canStop:true,canSetPermissions:true,permissionMode:'request',settingsSource:'agent',model:provider==='codex'?'demo-codex':'demo-claude',effort:'high',pendingIds:[],pendingCount:0};sessions.push(s);transcripts.set(s.id,[]);return s;
  }
  function message(s,role,text,images,live=false,extra={}){const m={id:'demo-message-'+(++seq),role,text,timestamp:base+seq*1000,...images?{images:images.map(key=>({id:assets[key].id,name:assets[key].name}))}:{},...extra};if(live)m.timestamp=Date.now();transcripts.get(s.id).push(m);if(live)emit('message',s,m);return m;}
  const render=session('lighting','优化动态光照与表面采样','codex','running');
  message(render,'user','帮我检查动态光照的采样分布，保持画面稳定，并给我一张调试图。');
  message(render,'assistant','我会先检查表面采样，再验证移动物体时的光照稳定性。下面是示例场景，绿色点表示按面积分布的采样位置。');
  message(render,'tool','检查采样密度、法线方向和运动更新范围。',null,false,{label:'读取与检查 · completed'});
  message(render,'assistant','采样分布已经调整。接下来正在验证运动场景，图片可以点击放大查看。',['light']);
  render.activity={kind:'tool',label:'正在验证画面',detail:'检查运动物体与采样分布'};
  const coast=session('coast','海边民宿官网 · 设计与实现','claude','idle','coast');
  message(coast,'user','做一个安静、有海边氛围的民宿首页，使用柔和的色彩，手机也要好看。');
  message(coast,'assistant','我会用沙色和海绿色组织页面，让预订入口清楚可见，首屏保留充足留白。');
  message(coast,'tool','完成响应式布局、按钮交互与基础可访问性检查。',null,false,{label:'构建与验证 · completed'});
  message(coast,'assistant','首页已完成，下面是视觉方案。\n\n- 宽屏展示完整海岸插画。\n- 手机自动调整文字与预订入口。\n- 导航和按钮保持清晰的触达区域。',['coast']);
  const choice=session('question','选择新首页的视觉方向','codex','waiting','coast');
  message(choice,'user','在继续实现之前，先让我选一下首页风格。');
  const trigger=message(choice,'assistant','这里准备了一个温暖的海岸风格参考。你可以选择方向，或者直接描述自己的想法。',['coast']);
  const question={id:'aaaaaaaa-1111-4111-8111-111111111111',sessionId:choice.id,source:'async:demo-design',anchorId:trigger.id,createdAt:trigger.timestamp+100,status:'pending',questions:[{id:'style',header:'设计方向',question:'你更喜欢哪种首页风格？',options:[{label:'温暖海岸',description:'沙色与海绿，柔和而放松'},{label:'极简黑白',description:'更克制，突出摄影与文字'}],allowOther:true,multiSelect:false}]};questions.set(question.id,question);choice.questionCount=1;choice.activity={kind:'waiting',label:'等待你的回答',detail:'选择首页视觉方向后继续'};
  const perf=session('performance','性能对比报告与可视化','codex','idle');
  message(perf,'user','把优化前后的帧耗时做成图，给出简短结论。');
  message(perf,'tool','整理示例帧耗时序列并生成对比图。',null,false,{label:'生成报告 · completed'});
  message(perf,'assistant','示例数据中，平均耗时从 **7.8 ms** 降到 **3.4 ms**。\n\n| 指标 | 优化前 | 优化后 |\n| --- | --- | --- |\n| 平均耗时 | 7.8 ms | 3.4 ms |\n| P95 | 10.6 ms | 4.3 ms |\n\n这张图展示了优化后的稳定性。数值仅用于功能演示。',['chart']);
  const docs=session('documentation','整理组件库使用文档','claude','running','notes','demo-mac');
  message(docs,'user','整理组件库的使用方式，补齐按钮、弹窗和主题切换的示例。');
  message(docs,'assistant','已整理目录结构，正在补齐交互示例与使用说明。你也可以在运行时发送补充要求，再逐条选择引导。');docs.activity={kind:'plan',label:'正在编写文档',detail:'第 2 / 3 步：补齐交互示例'};
  const intro=session('guide','欢迎体验 Agent Relay','claude','idle','notes','demo-mac');
  message(intro,'assistant','这里是 **Agent Relay 功能预览**。\n\n你可以体验：\n1. 在侧栏切换 Codex / Claude 会话。\n2. 浏览已完成的任务和图片，点击图片查看原图。\n3. 查看运行中的步骤，发送补充消息并点击引导。\n4. 回答 Agent 的选择题，切换模型、思考强度与权限。\n5. 手机上从左边缘拖开侧栏，电脑拖动侧栏边缘调宽。\n\n所有设备、会话、模型回复和指标都是示例，不会连接工作电脑。刷新页面即可重置。');
  function notify(type,data){for(const v of viewers)v.dispatchEvent(new MessageEvent(type,{data:JSON.stringify(data)}));}
  function state(){notify('state',{});}
  function emit(type,s,data){const event={id:'demo-event-'+(++seq),hostId:s.hostId,sessionId:s.id,type,data,at:Date.now()};if(type.startsWith('question')){const events=pastEvents.get(s.id)??[];events.push(event);pastEvents.set(s.id,events);}notify('event',event);}
  function status(s,value,activity){s.status=value;s.updatedAt=Date.now();s.activity=activity;emit('status',s,{status:value,activity});state();}
  function finish(s,text){if(jobs.has(s.id))clearTimeout(jobs.get(s.id));const token=setTimeout(()=>{jobs.delete(s.id);message(s,'assistant',text,null,true);s.pendingIds=[];s.pendingCount=0;if(s.nextModel)s.model=s.nextModel;if(s.nextEffort)s.effort=s.nextEffort;delete s.nextModel;delete s.nextEffort;status(s,'idle');},2600);jobs.set(s.id,token);}
  const commands=[{name:'help',description:'查看演示功能'},{name:'usage',description:'显示示例额度，未读取真实账号'},{name:'stop',description:'停止示例任务'},{name:'model',description:'切换示例模型'},{name:'effort',description:'切换思考强度'},{name:'btw',description:'不打断任务的旁问',argumentHint:'<问题>'}];
  function act(a){
    let s=sessions.find(s=>s.id===a.sessionId);if(a.type==='create-project'){const h=hosts.find(h=>h.id===a.hostId);if(!h)throw Error('请选择演示电脑');const p={id:crypto.randomUUID(),name:a.projectName,path:a.projectPath,source:'configured'};h.projects.push(p);state();return {project:p};}
    if(a.type==='start'){s=session(crypto.randomUUID(),a.text.trim().slice(0,40)||'新的演示会话',a.provider,'running',a.projectId,a.hostId);s.model=a.model||s.model;s.effort=a.effort||'high';s.permissionMode=a.permissionMode||'request';message(s,'user',a.text,null,true);status(s,'running',{kind:'thinking',label:'正在思考',detail:'准备示例回复'});finish(s,'已收到你的任务。这是功能预览中的模拟回复，你可以继续对话，或刷新页面恢复初始示例。');return {sessionId:s.id};}
    if(!s)throw Error('示例会话不存在');
    if(a.type==='send'){
      const files=(a.attachmentIds??[]).map(id=>uploads.get(id)?.ref).filter(Boolean),command=a.text.trim().startsWith('/'),queued=!command&&['running','waiting'].includes(s.status);
      const m=message(s,'user',a.text,null,true,{...queued?{label:'你 · 已排队'}:{},...files.length?{files}:{}});
      if(command){if(a.text.trim()==='/stop')return act({...a,type:'stop'});message(s,'assistant',a.text.startsWith('/usage')?'预览额度：100% 可用。此处为示例，不会查询真实账号。':a.text.startsWith('/btw')?'这是旁问的模拟回复，主任务继续执行。':'可体验 /help、/usage、/btw 和 /stop；模型与强度也可从输入栏调整。',null,true);return {sideQuestion:true};}
      if(queued){s.pendingIds.push(m.id);s.pendingCount=s.pendingIds.length;state();return {queued:true};}
      status(s,'running',{kind:'thinking',label:'正在思考',detail:'准备示例回复'});finish(s,'收到，我会按这个方向继续。这是一条模拟回复；演示中的消息和附件仅留在当前页面内存中。');return {};
    }
    if(a.type==='stop'){clearTimeout(jobs.get(s.id));jobs.delete(s.id);s.pendingIds=[];s.pendingCount=0;for(const q of questions.values())if(q.sessionId===s.id&&q.status==='pending'){q.status='cancelled';emit('question.resolved',s,q);}s.questionCount=0;status(s,'interrupted');return {};}
    if(a.type==='steer'||a.type==='cancel-input'){s.pendingIds=s.pendingIds.filter(id=>id!==a.queuedId);s.pendingCount=s.pendingIds.length;const m=transcripts.get(s.id).find(m=>m.id===a.queuedId);if(m){m.label=a.type==='steer'?'你 · 引导已接收':'你 · 排队已取消';emit('message',s,m);}if(a.type==='steer'){status(s,'running',{kind:'plan',label:'已接收引导',detail:'正在按补充要求调整'});finish(s,'引导已接收，示例任务已按新的方向完成。');}state();return {mode:'active-turn'};}
    if(a.type==='answer'){const q=questions.get(a.questionId);if(!q||q.sessionId!==s.id||q.status!=='pending')throw Error('问题已关闭');q.status='answered';q.answers=a.answers;s.questionCount=0;emit('question.resolved',s,q);status(s,'running',{kind:'plan',label:'正在继续',detail:'根据你的选择调整设计'});finish(s,'已收到你的选择：**'+Object.values(a.answers).flat().join('、')+'**。方案已更新，已回答的问题会在原触发位置折叠。');return {};}
    if(a.type==='set-model'){const queued=s.status==='running';if(a.model)s[queued?'nextModel':'model']=a.model;if(a.effort)s[queued?'nextEffort':'effort']=a.effort;state();return {queued};}
    if(a.type==='set-permissions'){s.permissionMode=a.permissionMode;state();return {};}
    throw Error('该操作不在功能预览范围内');
  }
  const response=(value,status=200)=>new Response(JSON.stringify(clone(value)),{status,headers:{'Content-Type':'application/json'}});
  window.fetch=async(input,options={})=>{
    const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.origin!==location.origin||!url.pathname.startsWith('/preview/api/'))return nativeFetch(input,options);
    const path=url.pathname.slice('/preview/api/'.length),s=sessions.find(s=>s.id===url.searchParams.get('sessionId'));
    try{
      if(path==='state')return response({hosts,sessions:[...sessions].sort((a,b)=>b.updatedAt-a.updatedAt)});
      if(path==='history'){if(!s)return response({error:'示例会话不存在'},404);const list=transcripts.get(s.id),end=url.searchParams.has('cursor')?Number(url.searchParams.get('cursor')):list.length,start=Math.max(0,end-18);return response({messages:list.slice(start,end),cursor:start||null,source:'演示会话',session:s,events:pastEvents.get(s.id)??[],questions:[...questions.values()].filter(q=>q.sessionId===s.id&&q.status==='pending'),questionsAsOf:Date.now()});}
      if(path==='models')return response({models:url.searchParams.get('provider')==='claude'?[{id:'demo-claude',name:'Claude · 演示模型',isDefault:true,efforts:['low','medium','high'],defaultEffort:'high'},{id:'demo-claude-fast',name:'Claude · 快速演示',efforts:['low','medium','high'],defaultEffort:'medium'}]:[{id:'demo-codex',name:'Codex · 演示模型',isDefault:true,efforts:['low','medium','high','xhigh'],defaultEffort:'high'},{id:'demo-codex-fast',name:'Codex · 快速演示',efforts:['low','medium','high'],defaultEffort:'medium'}]});
      if(path==='commands')return response({commands});
      if(path==='actions')return response(act(JSON.parse(options.body||'{}')));
      if(path==='uploads'){const blob=new Blob([options.body]),id=url.searchParams.get('id'),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(n=>n.toString(16).padStart(2,'0')).join(''),ref={id,name:url.searchParams.get('name'),size:blob.size,mime:options.body?.type||'application/octet-stream',sha256:hash};uploads.set(id,{blob,ref});return response({file:ref});}
      if(path.startsWith('images/')||path.startsWith('files/')){const id=path.split('/')[1],asset=Object.values(assets).find(a=>a.id===id),upload=uploads.get(id);if(!asset&&!upload)return response({error:'示例图片不存在'},404);const blob=upload?.blob??await(await nativeFetch(asset.url)).blob();return new Response(blob,{headers:{'Content-Type':blob.type,'Content-Length':String(blob.size),'X-Content-Sha256':upload?.ref.sha256??id,'X-Asset-Source':'server-cache'}});}
      if(path==='logout'||path==='login')return response({});return response({error:'仅提供预览接口'},404);
    }catch(error){return response({error:error.message},400);}
  };
  window.EventSource=class extends EventTarget{constructor(url){super();if(!new URL(url,location.href).pathname.startsWith('/preview/api/'))return new NativeEvents(url);this.readyState=1;viewers.add(this);setTimeout(()=>this.onopen?.(new Event('open')),0);}close(){this.readyState=2;viewers.delete(this);}};
  setInterval(()=>{const phases=[['正在验证画面','检查运动物体与采样分布'],['正在运行检查','验证静止与运动场景'],['正在整理结果','收集调试图与验证摘要']];if(render.status==='running'&&!jobs.has(render.id)){const [label,detail]=phases[Math.floor(Date.now()/6000)%phases.length];render.activity={kind:'tool',label,detail};emit('activity',render,render.activity);}if(docs.status==='running'&&!jobs.has(docs.id)){docs.activity={kind:'plan',label:'正在编写文档',detail:Math.floor(Date.now()/6000)%2?'第 2 / 3 步：补齐交互示例':'第 3 / 3 步：检查示例与链接'};emit('activity',docs,docs.activity);}},6000);
  document.addEventListener('DOMContentLoaded',()=>{
    const main=document.querySelector('.main'),banner=document.createElement('div');banner.className='demo-banner';banner.innerHTML='<strong>功能预览</strong><span>示例数据 · 操作仅在本页生效</span><button type="button">重置演示</button>';banner.querySelector('button').onclick=()=>location.reload();main.prepend(banner);document.getElementById('logout').textContent='重置演示';document.getElementById('logout').onclick=()=>location.reload();
    const list=document.getElementById('session-list'),observer=new MutationObserver(()=>{const row=[...list.querySelectorAll('button')].find(b=>b.textContent.includes(render.title));if(row){observer.disconnect();row.click();}});observer.observe(list,{childList:true});
  });
})();
