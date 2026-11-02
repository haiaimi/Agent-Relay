import type {SDKControlGetUsageResponse} from '@anthropic-ai/claude-agent-sdk';

const percent=(value:unknown):string=>typeof value==='number'&&Number.isFinite(value)?`${Math.round(Math.max(0,Math.min(100,value))*10)/10}%`:'未知';
function resetTime(value:unknown,seconds=false):string{
  const date=new Date(seconds&&typeof value==='number'?value*1000:typeof value==='string'?value:NaN);
  return Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未知';
}
function minutes(value:unknown):string{
  if(typeof value!=='number'||!Number.isFinite(value)||value<=0)return '额度窗口';
  if(value%1440===0)return `${value/1440} 天`;
  return value%60===0?`${value/60} 小时`:`${value} 分钟`;
}

export function codexUsageText(report:any):string{
  const entries=report?.rateLimitsByLimitId&&typeof report.rateLimitsByLimitId==='object'?Object.entries(report.rateLimitsByLimitId):[];
  if(!entries.length&&report?.rateLimits)entries.push([report.rateLimits.limitId??'Codex',report.rateLimits]);
  const lines=['Codex 账号用量'];let windows=0;
  for(const [id,value] of entries){
    const bucket=value as any;if(!bucket||typeof bucket!=='object')continue;
    const rows=[bucket.primary,bucket.secondary].filter(w=>w&&typeof w==='object');if(!rows.length)continue;
    lines.push(`\n${bucket.limitName??id}${bucket.planType?' · '+bucket.planType:''}`);
    for(const row of rows){windows++;const remaining=typeof row.usedPercent==='number'&&Number.isFinite(row.usedPercent)?100-row.usedPercent:undefined;
      lines.push(`${minutes(row.windowDurationMins)}：已用 ${percent(row.usedPercent)} · 剩余 ${percent(remaining)}`,`重置：${resetTime(row.resetsAt,true)}（北京时间）`);
    }
  }
  if(!windows)lines.push('\n当前登录方式未返回套餐额度；不能按 0% 用量计算。');
  lines.push('\n额度由此账号各会话共享，并非当前会话单独消耗。');return lines.join('\n');
}

export function claudeUsageText(report:SDKControlGetUsageResponse,includeSession=false):string{
  const lines=['Claude 账号用量'+(report.subscription_type?' · '+report.subscription_type:'')];let windows=0;
  if(report.rate_limits_available&&report.rate_limits){
    const limits=report.rate_limits;
    const rows:[string,{utilization:number|null;resets_at:string|null}|null|undefined][]=[['5 小时',limits.five_hour],['7 天',limits.seven_day],['7 天 · OAuth 应用',limits.seven_day_oauth_apps],['7 天 · Opus',limits.seven_day_opus],['7 天 · Sonnet',limits.seven_day_sonnet],...(limits.model_scoped??[]).map(r=>['7 天 · '+r.display_name,r] as [string,typeof r])];
    for(const [name,row] of rows){if(!row)continue;windows++;const remaining=typeof row.utilization==='number'&&Number.isFinite(row.utilization)?100-row.utilization:undefined;
      lines.push(`\n${name}：已用 ${percent(row.utilization)} · 剩余 ${percent(remaining)}`,`重置：${resetTime(row.resets_at)}（北京时间）`);
    }
  }
  if(!windows)lines.push('\n当前登录方式或接口未返回套餐额度；不能按 0% 用量计算。');
  if(includeSession&&report.session&&typeof report.session.total_cost_usd==='number'&&Number.isFinite(report.session.total_cost_usd))lines.push(`\n本轮本地进程累计 API 成本：$${report.session.total_cost_usd.toFixed(4)}（不等于套餐账单）`);
  lines.push('\n额度由此账号各会话共享，并非当前会话单独消耗。');return lines.join('\n');
}
