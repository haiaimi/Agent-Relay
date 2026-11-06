// Mounting the UI must not depend on a successful first network read.
export function createStudioStartup({load,show,ready,success,error,schedule=setTimeout,cancel=clearTimeout}){
 let attempts=0,timer,running,generation=0;
 const run=()=>{
  if(running)return running;const token=generation;attempts++;
  running=Promise.resolve().then(load).then(()=>{if(token!==generation)return false;success();return true;},e=>{
   if(token!==generation)return false;const retry=e.transport===true&&!e.httpError&&attempts<5;
   error(e,attempts,retry);if(retry)timer=schedule(()=>{timer=undefined;void run();},60000);return false;
  }).finally(()=>{running=undefined;});return running;
 };
 return {start(){if(running)return running;if(timer!==undefined)cancel(timer);timer=undefined;attempts=0;generation++;show();ready();return run();},stop(){generation++;if(timer!==undefined)cancel(timer);timer=undefined;},get attempts(){return attempts;}};
}
