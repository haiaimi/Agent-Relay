export interface PreflightRetry {attempts:number;nextAt?:number;error:string}
export const PREFLIGHT_ATTEMPTS=5,PREFLIGHT_RETRY_MS=60_000;
export function preflightConnectionFailure(message:string){return /(?:电脑|连接|网络).*(?:超时|中断|断开|离线|失败)|(?:connect|socket|network|fetch).*(?:timeout|timed out|reset|closed|failed|offline)|服务重启时投递结果尚未确认/i.test(message);}
export function nextPreflightRetry(previous:PreflightRetry|undefined,error:string,now=Date.now()):PreflightRetry{
  const attempts=(previous?.attempts??0)+1;return {attempts,error,nextAt:attempts<PREFLIGHT_ATTEMPTS?now+PREFLIGHT_RETRY_MS:undefined};
}
