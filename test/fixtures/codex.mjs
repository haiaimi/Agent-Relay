import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const notify=(method,params)=>send({method,params});
let threadId,turnId,approvalId,questionId,mode;
const complete=()=>{notify('item/completed',{threadId,item:{id:'answer',type:'agentMessage',text:'本地测试完成'}});notify('turn/completed',{threadId,turn:{id:turnId,status:'completed'}});};
for await(const line of createInterface({input:process.stdin})){
  const m=JSON.parse(line);
  if(m.id===questionId&&m.result){notify('serverRequest/resolved',{threadId,requestId:questionId});notify('item/completed',{threadId,item:{id:'question-proof',type:'agentMessage',text:'QUESTION_ANSWERED:'+JSON.stringify(m.result.answers)}});complete();continue;}
  if(m.id===approvalId&&m.result){notify('item/agentMessage/delta',{threadId,itemId:'answer',delta:['accept','acceptForSession'].includes(m.result.decision)?'已允许':'已拒绝'});complete();continue;}
  if(m.method==='initialize')send({id:m.id,result:{}});
  if(m.method==='account/rateLimits/read')send({id:m.id,result:{rateLimitsByLimitId:{codex:{limitId:'codex',planType:'pro',primary:{usedPercent:25,windowDurationMins:300,resetsAt:1793600000},secondary:{usedPercent:40,windowDurationMins:10080,resetsAt:1793800000}}}}});
  if(m.method==='model/list')send({id:m.id,result:{data:[{model:'fixture-a',displayName:'Fixture A',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},{model:'fixture-b',displayName:'Fixture B',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}]}});
  if(m.method==='thread/start'){threadId=randomUUID();send({id:m.id,result:{thread:{id:threadId},model:m.params.model??'fixture-a'}});}
  if(m.method==='thread/resume'){threadId=m.params.threadId;send({id:m.id,result:{thread:{id:threadId}}});}
  if(m.method==='turn/start'){
    threadId=m.params.threadId;turnId=randomUUID();mode=m.params.input[0].text;
    if(mode.startsWith('verify-attachments')){
      const image=m.params.input.find(i=>i.type==='localImage'),notes=mode.split('\n').find(l=>l.startsWith('notes.txt: '))?.slice(11);
      if(!image||!notes||readFileSync(image.path)[0]!==137||readFileSync(notes,'utf8')!=='ATTACHMENT_TEXT_OK'){send({id:m.id,error:{message:'Attachments did not reach the local agent'}});continue;}
      notify('item/completed',{threadId,item:{id:'attachment-proof',type:'agentMessage',text:'ATTACHMENT_INPUT_OK'}});
    }
    if(mode==='verify-model'&&m.params.model!=='fixture-b'){send({id:m.id,error:{message:'Model switch did not reach the local process'}});continue;}
    if(mode==='verify-queued'&&(m.params.model!=='fixture-a'||m.params.effort!=='high')){send({id:m.id,error:{message:'Queued model and effort did not reach the local process'}});continue;}
    send({id:m.id,result:{turn:{id:turnId}}});notify('turn/started',{threadId,turn:{id:turnId}});
    notify('item/agentMessage/delta',{threadId,itemId:'answer',delta:'本地测试'});
    if(mode==='approval'){approvalId=99;send({id:approvalId,method:'item/commandExecution/requestApproval',params:{threadId,command:'echo fixture'}});}
    else if(mode==='question'){questionId=201;send({id:questionId,method:'item/tool/requestUserInput',params:{threadId,turnId,itemId:'ask',questions:[{id:'choice',header:'选择',question:'选哪个方案？',isOther:true,options:[{label:'方案 A',description:'保持现状'},{label:'方案 B',description:'调整实现'}]},{id:'details',header:'补充',question:'需要补充什么？',isOther:true,options:[]}]}});}
    else if(mode.split('\n')[0]!=='wait')setTimeout(complete,30);
  }
  if(m.method==='turn/interrupt'){send({id:m.id,result:{}});notify('turn/completed',{threadId,turn:{id:turnId,status:'interrupted'}});}
  if(m.method==='turn/steer'){
    if(m.params.threadId!==threadId||m.params.expectedTurnId!==turnId){send({id:m.id,error:{message:'Wrong active turn'}});continue;}
    send({id:m.id,result:{turnId}});
    if(m.params.input[0].text.startsWith('verify-steer-attachments')){
      const image=m.params.input.find(i=>i.type==='localImage');
      if(!image||readFileSync(image.path)[0]!==137)throw new Error('Missing steering image');
      notify('item/completed',{threadId,item:{id:'attachment-steer-proof',type:'agentMessage',text:'ATTACHMENT_STEER_OK'}});
    }
    notify('item/completed',{threadId,item:{id:'steer-proof',type:'agentMessage',text:'STEERED:'+m.params.input[0].text}});
  }
}
