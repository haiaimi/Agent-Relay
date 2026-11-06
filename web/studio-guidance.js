// Presentation only: recommendations do not approve, skip or change task state.
export function taskGuidance(task,session,{online=true,syncError='',othersRunning=false,pendingDependencies=[],automatic=false}={}){
 const reason=task.error||task.checkpoint?.reason||task.blockers?.map(b=>b.details).filter(Boolean).join('\n')||'';
 const result=(label,next,action='',button='',why=reason)=>({label,why,next,action,button});
 if(syncError)return result('状态暂未同步','现有记录已保留。先核对最新状态，再执行操作。','refresh','核对最新状态',syncError);
 if(task.status==='awaiting-review')return result(task.kind==='visual-review'?'请确认原画':'请确认本轮成果','查看本页成果，认可后继续；需要调整可直接提出修改。','attention','查看待确认内容','');
 if(session?.questionCount||session?.status==='waiting'||task.recovery?.phase==='waiting-input')return result(session?.questionCount?'请回答 Agent 的问题':'请确认 Agent 的操作','在本页完成问题回答或工具批准，Agent 接收后继续。','attention','加载待确认内容','');
 if(['done','skipped','cancelled'].includes(task.status))return result(task.status==='done'?'本步骤已完成':task.status==='skipped'?'本步骤已跳过':'本步骤已取消',task.status==='skipped'?'跳过记录保留，后续仍按实际结果验收。':'可直接查看本页成果，或在更多操作里补充修改意见。');
 if(!online)return result('工作电脑未连接','请让工作电脑上的 Relay 服务保持运行；连接恢复后继续原任务。','refresh','重新检查连接','当前无法联系执行这项任务的电脑。');
 if(['running','starting'].includes(task.status))return result(task.status==='starting'?'正在准备执行':'Agent 正在处理',session?.activity?.label||'无需操作，进度会自动更新。');
 if(task.status==='queued')return result('等待前置步骤完成','前置步骤或审批完成后会自动执行，无需重复启动。');
 if(task.status!=='blocked')return result('正在核对进度','进度会自动更新。');
 if(pendingDependencies.length)return result('请先完成前置步骤','先处理“'+pendingDependencies.map(t=>t.title||t.id).join('、')+'”，完成后才能继续本步骤。','dependency','处理前置步骤');
 if(othersRunning)return result('等待当前工作结束','其他任务或职能对话仍在执行，结束后再继续本步骤。','active','查看正在进行的工作');
 if(automatic&&!task.kind&&task.sessionId&&(task.finishedAt&&!task.checkpoint&&session?.status==='idle'||task.autoFollowup&&['idle','failed','interrupted'].includes(session?.status))){
  const f=task.autoFollowup;if(f?.phase==='collaborating')return result('程序协作修复中',f.note);if(f?.nextAt>Date.now())return result('已安排自动续做','下一次核对：'+new Date(f.nextAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})+'。'+f.note);return result(f?.phase==='checking'?'正在核对原会话':f?.phase==='unavailable'?'连接恢复后自动补做':'Agent 将自动补做未完成项',f?.note||'无需点击继续。系统会交回原 Agent 修复或按最新指引记录延期项，完成后继续后续流程。');
 }
 if(task.checkpoint)return result('上次工作已中断','断点和已有成果已保存，点击后接着未完成的部分做。','resume','继续上次工作');
 if(!task.sessionId||session?.status==='history')return result('任务启动或执行状态需核对','先检查投递回执与流程状态，避免重复启动任务。','repair','诊断并修复流程');
 if(/STUDIO_PLAN|职能与所选阶段不匹配|计划.*(?:校验|无效)/i.test(reason))return result('制作计划需要修正','让统筹修正拆解格式或依赖，保留已有工程分析与所选流程。','recheck','请统筹修正计划');
 if(/STUDIO_RESULT|交付.*(?:格式|outcome)|未提供实际验证记录|JSON.{0,12}(?:解析失败|格式错误)|(?:无法解析|无效).{0,12}JSON/i.test(reason))return result('Agent 的交付说明不完整','请 Agent 补齐实际交付、验证记录和结果格式，不能把缺失信息当作通过。','recheck','请 Agent 补齐交付结果');
 if(/原画阶段必须交付|(?:缺少|未交付|未生成|没有).{0,20}(?:原画|实际图片)|原画.{0,20}(?:缺失|未交付|未生成|尚未交齐)/.test(reason))return result('原画图片尚未交齐','需要补齐实际可查看的图片，文字说明不能代替原画。','recheck','请 Agent 补齐原画');
 if(task.blockers?.some(b=>b.category==='environment')||/Blender.{0,25}(?:未找到|不可用|找不到)|(?:未找到|找不到|缺少).{0,30}(?:Blender|Python|xatlas|shapely|依赖|工具)|Python.{0,25}(?:缺少|未安装)|环境.{0,15}(?:缺|错误)/i.test(reason))return result('工具环境需要检查','让 Agent 按当前工具配置检查环境，并继续未完成部分。','recheck','检查环境并继续');
 if(task.role==='qa')return result('QA 验收未通过','以下是本轮未通过项。相关制作内容修正后，请 QA 重新实测；不会自动认定通过。','recheck','请 QA 重新实测');
 return result('这一步尚未完成','失败原因如下。交回原 Agent 核对并补做，已完成的前置成果保留。','recheck','交给 Agent 继续处理');
}
