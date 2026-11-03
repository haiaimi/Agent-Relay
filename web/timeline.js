// Native transcript timestamps and relay events share one chronological timeline.
// In particular, replaying an old failure must never overwrite the current session.
export function orderedMessages(messages){
  return [...messages].map((message,index)=>({message,index})).sort((a,b)=>(a.message.timestamp??0)-(b.message.timestamp??0)||a.index-b.index).map(x=>x.message);
}
export function timelineWithQuestions(messages,cards){
  const ordered=orderedMessages(messages),slots=new Map(),times=ordered.map(m=>m.timestamp).filter(t=>Number.isFinite(t)&&t>0),oldest=times.length?Math.min(...times):Infinity;
  for(const card of [...cards].sort((a,b)=>a.createdAt-b.createdAt)){
    const source=String(card.source??''),sourceId=source.slice(source.lastIndexOf(':')+1);
    const captured=card.anchorId?ordered.findIndex(m=>m.id===card.anchorId):-1;
    const anchor=captured>=0?captured:ordered.findIndex(m=>m.id===sourceId||m.id==='claude-tool:'+sourceId);
    let index;
    if(anchor>=0)index=anchor+1;
    else if(card.anchorId){if(card.status!=='pending')continue;index=ordered.length;}
    else if(!Number.isFinite(card.createdAt)||card.createdAt<oldest){if(card.status!=='pending')continue;index=ordered.length;}
    else{index=ordered.findIndex(m=>Number.isFinite(m.timestamp)&&m.timestamp>card.createdAt);if(index<0)index=ordered.length;}
    const entries=slots.get(index)??[];entries.push({id:'question:'+card.id,role:'question',question:card,timestamp:card.createdAt});slots.set(index,entries);
  }
  const result=[];for(let i=0;i<=ordered.length;i++){result.push(...(slots.get(i)??[]));if(i<ordered.length)result.push(ordered[i]);}return result;
}
export function acceptsStatusEvent(session,event,replay=false){
  return !replay&&session.managed!==false&&session.statusOrigin!=='native'&&event.at>=session.updatedAt;
}
// Reconcile in place. An unchanged refresh must not detach decoded images,
// focused controls, text selections or open tool details from the document.
export function reconcileChildren(parent,children){
  let cursor=parent.firstChild,changed=false;
  for(const child of children){if(child===cursor)cursor=cursor.nextSibling;else{parent.insertBefore(child,cursor);changed=true;}}
  while(cursor){const next=cursor.nextSibling;parent.removeChild(cursor);cursor=next;changed=true;}
  return changed;
}

export class HistoryPager {
  generation=0;sessionId=null;cursor=null;initialized=false;olderLoaded=false;active=null;
  reset(sessionId){this.generation++;this.sessionId=sessionId;this.cursor=null;this.initialized=false;this.olderLoaded=false;this.active=null;}
  begin(older=false){
    if(!this.sessionId||this.active||older&&(!this.initialized||this.cursor===null))return null;
    return this.active={sessionId:this.sessionId,generation:this.generation,older,cursor:older?this.cursor:undefined};
  }
  current(request){return this.active===request&&request.generation===this.generation&&request.sessionId===this.sessionId;}
  complete(request,nextCursor){
    if(!this.current(request))return false;
    if(nextCursor!==null&&(!Number.isSafeInteger(nextCursor)||nextCursor<0||request.older&&nextCursor>=request.cursor))throw new Error('历史分页未前进，请稍后下拉重试');
    if(!this.initialized||request.older||this.cursor===null&&!this.olderLoaded)this.cursor=nextCursor;
    if(request.older)this.olderLoaded=true;
    this.initialized=true;this.active=null;return true;
  }
  release(request){if(this.current(request))this.active=null;}
}
