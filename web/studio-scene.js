const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
export const sceneStageName=stage=>({requirements:'玩法与 LD 设计',prototype:'LD 设计（旧流程）',balance:'数值配置与难度',implementation:'程序实现玩法','functional-test':'功能白模与操作验证',concept:'原画与视觉方案','visual-review':'制作人视觉确认','design-review':'关卡设计审批','scene-review':'实机场景审批','asset-spec':'资产清单与规格',assets:'资产生产',assembly:'LA 正式场景搭建',integration:'布光、效果与程序集成',validation:'QA 验证'}[stage]||'');
const imagePath=path=>/\.(png|jpe?g|gif|webp)$/i.test(path);
export function scenePanel(run,{command,openTask,feedbackFor,notify,fresh=false}){
  if(run.workflow?.kind!=='scene')return null;
  const root=el('section','scene-workflow'),gate=run.tasks.find(t=>t.kind==='visual-review'),finished=['accepted','cancelled'].includes(run.status);
  if(run.workflow.selection){root.append(el('h3','','本需求所选流程'),el('p','fine','仅执行勾选的制作环节和审批节点；未选原画或资产生产时沿用已有设计与资源。'));const list=el('ol','scene-stages');for(const stage of [...new Set(run.tasks.length?run.tasks.map(t=>t.stage).filter(Boolean):run.workflow.selection.stages)]){const tasks=run.tasks.filter(t=>t.stage===stage),state=tasks.some(t=>t.status==='awaiting-review')?'等你审批':tasks.length&&tasks.every(t=>['done','skipped'].includes(t.status))?'已结束':tasks.some(t=>['running','starting'].includes(t.status))?'执行中':tasks.some(t=>t.status==='blocked')?'待处理':'待分发';const li=el('li','scene-step');li.append(el('span','',sceneStageName(stage)),el('small','',state));list.append(li);}root.append(list);}else{
  root.append(el('h3','','场景生产流程'),el('p','fine',run.workflow.assetMode==='reuse'?'沿用已有视觉与资产，仍需你确认本轮复用依据。':'玩法与 LD 设计完成后出原画，等你确认视觉方向；数值与程序实现均在确认后进行。'));
  if(run.workflow.reuseReason)root.append(el('p','scene-reuse',run.workflow.reuseReason));
  const steps=el('ol','scene-stages');for(const stage of ['requirements','concept','visual-review',...run.tasks.some(t=>t.stage==='balance')?['balance']:[],'asset-spec',...run.workflow.assetMode==='new'?['assets']:[],...run.tasks.some(t=>t.stage==='implementation')?['implementation']:[],'assembly','integration','validation']){
    const tasks=run.tasks.filter(t=>t.stage===stage),state=tasks.some(t=>t.status==='blocked')?'blocked':tasks.some(t=>t.status==='awaiting-review')?'awaiting-review':tasks.length&&tasks.every(t=>t.status==='done')?'done':tasks.length&&tasks.every(t=>['done','skipped'].includes(t.status))?'skipped':tasks.some(t=>['running','starting'].includes(t.status))?'running':'queued',li=el('li','scene-step '+state);li.append(el('span','',sceneStageName(stage)),el('small','',({blocked:'待处理','awaiting-review':'等你确认',done:'已完成',skipped:'含跳过项',running:'执行中',queued:'待分发'})[state]));steps.append(li);
  }root.append(steps,el('p','fine','玩法策划与 LD 负责设计，程序统一实现一次；集成阶段复用已有实现。原画未通过时，按你的意见退回修改，再次等你确认。'));
  }
  if(run.workflow.error){root.append(el('p','error',run.workflow.error));if(run.workflow.version!==2&&!finished){const apply=el('button','primary','应用新版流程，保留已有成果');apply.type='button';apply.onclick=async()=>{apply.disabled=true;try{await command(run,'upgrade-scene-flow');}catch(e){notify(e.message);apply.disabled=false;}};root.append(apply);}return root;}
  if(!gate)return root;
  const box=el('section','visual-review-panel');box.append(el('h3','',gate.status==='done'?'已确认的视觉方向':gate.status==='awaiting-review'?'请查看原画，确认视觉方向':'视觉确认节点'));
  if(gate.error)box.append(el('p','error',gate.error));
  const action=(label,fn,primary=false)=>{const b=el('button',primary?'primary':'quiet',label);b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){notify(e.message);b.disabled=false;}};return b;};
  const concepts=run.tasks.filter(t=>gate.dependencies.includes(t.id));
  const sourceButtons=el('div','run-actions');for(const t of concepts)sourceButtons.append(action('查看：'+t.title,()=>openTask(run,t)));const sourceDetails=el('details','task-section');sourceDetails.append(el('summary','','查看制作记录'),sourceButtons);box.append(sourceDetails);
  if(!['awaiting-review','done'].includes(gate.status)){box.append(el('p','muted','原画交付完成后，这里显示本轮图片预览。等待期间不启动资产生产和正式搭建。'));root.append(box);return root;}
  const references=concepts.flatMap(t=>(t.artifacts??[]).flatMap((a,index)=>imagePath(a.path)?[{taskId:t.id,index,path:a.path,description:a.description,sessionId:t.sessionId}]:[])),gallery=el('div','visual-gallery'),hashes=new Map(),failed=new Set();
  const progress=el('p','fine','正在加载本轮原画（0/'+references.length+'）');progress.setAttribute('role','status');box.append(progress,gallery);const approve=action('认可原画并继续',()=>command(run,'approve-visual',{taskId:gate.id,reviewId:gate.reviewId,visualHashes:[...hashes.values()]}),true);approve.disabled=true;
  for(const ref of references){
    const snapshot=gate.visualSnapshots?.find(s=>s.taskId===ref.taskId&&s.path===ref.path),target=snapshot?'/api/images/'+encodeURIComponent(snapshot.sha256)+'?'+new URLSearchParams({sessionId:ref.sessionId}):'/api/studio/artifact?'+new URLSearchParams({runId:run.id,taskId:ref.taskId,index:String(ref.index)}),card=el('figure','visual-reference'),anchor=el('a'),img=el('img'),caption=el('figcaption','',ref.description||ref.path),status=el('span','fine','正在加载本轮原画…');
    img.hidden=true;img.alt=ref.description||ref.path;anchor.href=target;anchor.target='_blank';anchor.rel='noopener';anchor.append(img);card.append(anchor,caption,el('small','fine',ref.path),status);gallery.append(card);
    const load=async()=>{let url;try{
      const response=await fetch(target+'&preview=1'+(fresh?'&refresh=1':''),{cache:'no-store'});if(!response.ok){let reason;try{reason=(await response.json()).error;}catch{}throw Error(reason||'原画读取失败');}
      const sha256=snapshot?.sha256||response.headers.get('X-Visual-Sha256');if(!/^[a-f0-9]{64}$/.test(sha256??''))throw Error('原画版本校验缺失');const blob=await response.blob(),expected=response.headers.get('X-Content-Sha256'),digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');if(!expected||digest!==expected)throw Error('原画预览完整性校验失败');if(!card.isConnected)return;
      url=URL.createObjectURL(blob);img.src=url;img.dataset.objectUrl=url;await img.decode();if(!card.isConnected){URL.revokeObjectURL(url);return;}
      hashes.set(ref.taskId+':'+ref.index,{taskId:ref.taskId,index:ref.index,sha256});img.hidden=false;status.textContent='';progress.textContent='已加载 '+hashes.size+'/'+references.length+' 张原画';approve.disabled=hashes.size!==references.length||finished;
    }catch(e){if(url)URL.revokeObjectURL(url);status.textContent=e.message;failed.add(ref.taskId+':'+ref.index);progress.textContent='已加载 '+hashes.size+'/'+references.length+' 张原画，'+failed.size+' 张读取失败，可重新加载';approve.disabled=true;}};void load();
  }
  if(gate.status==='awaiting-review'&&!finished){
    box.append(el('p','fine','请逐张查看。确认仅对本轮图片有效；原画返工后，资产、场景与 QA 将重新验证。'));
    const actions=el('div','run-actions');actions.append(approve,action('提出修改',()=>feedbackFor(run,gate,{op:'reject-visual',reviewId:gate.reviewId})));sourceDetails.append(action('重新加载原画',()=>{for(const img of root.querySelectorAll('[data-object-url]'))URL.revokeObjectURL(img.dataset.objectUrl);root.replaceWith(scenePanel(run,{command,openTask,feedbackFor,notify,fresh:true}));}));box.append(actions);
  }else if(gate.status==='done'){
    box.append(el('p','fine','制作人已确认 · '+new Date(gate.approvedAt).toLocaleString('zh-CN')));
    if(!finished&&concepts[0])box.append(action('原画需要返工',()=>feedbackFor(run,concepts[0])));
  }
  root.append(box);return root;
}
