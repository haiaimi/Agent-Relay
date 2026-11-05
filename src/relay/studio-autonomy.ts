import {createHash} from 'node:crypto';
import {validateAnswers,type QuestionCard} from '../shared/questions.js';

export const autonomyInstructions=`
执行问题自动决策：制作人允许团队在其长时间不操作时持续制作。依据原始需求、已确认方案和最新制作人指引，自主选择可逆、最小改动的可行实现并记录依据，不为普通设计选择、文件分工、兼容修复反复调用提问工具或等待制作人回复。历史任务里由 Agent 自行拟定的文件责任可在本需求独立副本内协调调整；制作人明确禁止的事项仍须遵守。同文件写入串行协调，不等待依赖自己的下游先修复。
只有流程配置中明确开启的制作人审批节点需要人工确认；不能新增审批，也不能用自动答复冒充制作人批准。需要原画选择时先形成建议和候选，到了已开启的审批节点再等待；关闭审批时由团队按需求选择并记录。普通问题即使被提出来，也由团队按既定方案自动处理，不重复问同一件事。
最新制作人补充优先于冲突的旧任务说明。优先完成本轮目标，记录假设和遗留项，不擅自把角色/关卡需求扩大成整个渲染器研究。源工程、其他需求和凭据保持保护；不提交、推送或发布，除非另有明确授权。不能编造真实玩家、测试数据、凭据或验收通过；真实质量/工具故障按实际记录并主动尝试职责内修复。工具批准仍按会话权限设置执行。
`;

export function autoQuestionId(sessionId:string,card:QuestionCard){
  const h=createHash('sha256').update(JSON.stringify(['studio-auto-answer-v1',sessionId,card.source,card.questions])).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
export function automaticAnswer(card:QuestionCard,context:{brief:string;directive:string;planning:boolean}){
  if(card.questions.some(q=>q.secret))return {reason:'问题需要实际凭据，不能生成或猜测',answers:undefined};
  const answers:Record<string,string[]>={},basis:string[]=[];
  for(const q of card.questions){
    if(q.allowOther||!q.options.length){
      answers[q.id]=['团队自动决策（不是制作人审批）：'+(context.directive?'优先执行制作人最新指引：“'+context.directive.slice(0,500)+'”。':'依据既定需求与已确认方案。')+(context.planning?'当前只读规划，自行提出最合适的方案，完成 STUDIO_PLAN，不提前制作。':'请你结合工程和问题中的可行方案自行选择并继续当前任务；允许在本需求工作副本内协调必要的接入/兼容修复，遵守制作人明确限制，保留已有成果。')+' 不为普通分工或实现选择再次等待用户。已开启的审批到系统节点再人工确认，不把这条回复当成批准；不扩大未选生产阶段。真实外部资料或测量缺失须如实记录，继续能完成的部分，不编造资料或声称失败项已通过。'];
      basis.push('按既定方案及最新指引，交由当前职能自主实施');continue;
    }
    const usable=q.options.filter(o=>!/暂不决定|等待制作人|保持阻断|停止后续|清空.*数据库|上传.*密钥|关闭.*鉴权|强制删除.*源工程/.test(o.label));
    if(!usable.length)return {reason:'没有符合当前授权范围的可自动选择项',answers:undefined};
    const norm=(s:string)=>s.toLowerCase().replace(/[\s，。、“”‘’()（）]/g,'');
    const rank=(label:string)=>{
      const n=norm(label),d=norm(context.directive),b=norm(context.brief);
      return (n.length>3&&d.includes(n)?100:0)+(/推荐|recommended/i.test(label)?30:0)+(n.length>3&&b.includes(n)?15:0)+(/沿用|复用|现有|最小/.test(label)?3:0);
    };
    const choice=[...usable].sort((a,b)=>rank(b.label)-rank(a.label))[0];answers[q.id]=[choice.label];
    basis.push(rank(choice.label)?'按最新指引、需求或推荐项选择：'+choice.label:'未指定细节，按首个可行选项继续并验证：'+choice.label);
  }
  return {answers:validateAnswers(card.questions,answers),reason:[...new Set(basis)].join('；')};
}
