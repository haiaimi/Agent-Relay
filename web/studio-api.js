export function studioNetworkError(error,write=false){
  if(error?.httpError)return error;
  const timeout=['TimeoutError','AbortError'].includes(error?.name)||/signal timed out|timed? ?out/i.test(error?.message||'');
  if(!timeout&&!(error instanceof TypeError))return error;
  const result=new Error(write?'操作结果暂未确认，请先核对最新记录，不要重复提交。':timeout?'状态读取暂时超时，已保留现有记录；稍后自动重试。':'暂时无法连接服务器，已保留现有记录。');
  result.transport=true;result.uncertain=write;return result;
}
export function createStudioApi({fetcher=fetch,sharedState=()=>null,onUnauthorized=()=>{}}={}){
  const cache=new Map();
  const api=async(path,payload,signal)=>{
    if(path==='state'&&!payload&&sharedState())return sharedState();
    const write=!!payload,old=!write?cache.get(path):undefined;
    try{
      const response=await fetcher('/api/'+path,{method:write?'POST':'GET',headers:write?{'Content-Type':'application/json'}:old?.etag?{'If-None-Match':old.etag}:{},body:write?JSON.stringify(payload):undefined,signal:signal??AbortSignal.timeout(write?95000:30000)});
      if(response.status===401){cache.clear();onUnauthorized();const e=new Error('请登录工作室');e.httpError=true;throw e;}
      if(response.status===304&&old)return old.value;
      if([502,503,504].includes(response.status)){const e=new Error('服务器响应暂时不可用');e.name='TimeoutError';throw e;}
      const value=await response.json();if(!response.ok||value.error){const e=new Error(value.error||'操作失败');e.httpError=!/signal timed out|timed? ?out|电脑连接中断|Bridge not connected/i.test(e.message);throw e;}
      const etag=response.headers.get('etag');if(!write&&etag){cache.delete(path);cache.set(path,{etag,value});while(cache.size>24)cache.delete(cache.keys().next().value);}
      return value;
    }catch(error){throw studioNetworkError(error,write);}
  };
  api.clear=()=>cache.clear();return api;
}
