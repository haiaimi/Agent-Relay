// Native transcript timestamps and relay events share one chronological timeline.
// In particular, replaying an old failure must never overwrite the current session.
export function orderedMessages(messages){
  return [...messages].map((message,index)=>({message,index})).sort((a,b)=>(a.message.timestamp??0)-(b.message.timestamp??0)||a.index-b.index).map(x=>x.message);
}
export function acceptsStatusEvent(session,event,replay=false){
  return !replay&&session.managed!==false&&session.statusOrigin!=='native'&&event.at>=session.updatedAt;
}
