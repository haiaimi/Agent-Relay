// A write can require one fresh read after an older poll. Ordinary live events
// share that read instead of repeatedly overtaking a waiting write callback.
export function coalescedRefresh(read){
  let job=null,again=false,forced=false;
  return function refresh(force=false){
    if(job){if(force){again=true;forced=true;}return job;}
    forced=force;
    job=(async()=>{do{const nextForce=forced;again=false;forced=false;await read(nextForce);}while(again);})().finally(()=>{job=null;});
    return job;
  };
}
