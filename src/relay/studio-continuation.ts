import type {StudioRun} from './studio.js';

export interface StudioContinuation {
  parentRunId:string; title:string; hostId:string; projectId:string;
  source:{projectId:string;path:string;branch:string;head:string};
  brief:string; summary:string;
  artifacts:{path:string;description:string}[];
  approvals:{taskId:string;title:string;approvedAt?:number;snapshots?:{path:string;sha256:string}[]}[];
  requestHash:string; createdAt:number;
}

export function continuationSnapshot(parent:StudioRun,hostId:string,requestHash:string):StudioContinuation {
  const w=parent.workspace!.value!,artifacts=new Map<string,{path:string;description:string}>();
  for(const t of [...parent.tasks,...parent.delivery?[parent.delivery]:[]])for(const a of t.artifacts??[])artifacts.set(a.path,{...a});
  return {parentRunId:parent.id,title:parent.title,hostId,projectId:parent.projectId,
    source:{projectId:w.project.id,path:w.project.path,branch:w.branch,head:w.head},
    brief:parent.brief,summary:parent.delivery?.summary??'',artifacts:[...artifacts.values()].slice(0,128),
    approvals:parent.tasks.filter(t=>t.kind&&t.status==='done').map(t=>({taskId:t.id,title:t.title,approvedAt:t.approvedAt,snapshots:t.visualSnapshots?.map(s=>({path:s.path,sha256:s.sha256}))})),
    requestHash,createdAt:Date.now()};
}

export function continuationInstructions(c?:StudioContinuation){
  if(!c)return '';
  return `【基于已交付需求继续制作】上游需求 ${c.parentRunId}「${c.title}」。本次源副本：${c.source.path}，源分支：${c.source.branch}。本次独立副本已经从此处复制已跟踪改动及未被忽略的未跟踪文件；不是从团队默认工程重新开始。源副本只读，所有新文件、修改及试玩入口必须留在当前需求副本，不回写或自动合并上游。\n上游原需求：${c.brief.slice(0,1000)}\n上游交付摘要：${c.summary.slice(0,2200)}\n上游交付文件索引（路径相对于继承的工程，截断时读取 .studio/${c.parentRunId}/studio-delivery/README.md 及各职能交付文件补全）：${JSON.stringify(c.artifacts).slice(0,4500)}\n上游审批参考：${JSON.stringify(c.approvals).slice(0,1800)}\n先核对继承文件与已确认设计，复用已交付成果，仅按本次所选环节补齐，不重新生产未选的原画或模型。上游审批只作来源参考，不替代本次所选审批，也不能证明新场景已经完成。忽略文件、缓存、默认未复制的 captures 可能仍在上游；需要时只读核对并复制必要资源到当前副本，禁止擅自替换缺失文件或虚构验收。涉及游戏接入时必须验证实际游戏入口加载本次新场景；交付 Windows 工作副本路径、实际可用的启动命令或脚本、真实运行截图/视频与遗留问题，不能以旧场景回归或资产转台冒充接入完成。\n`;
}
