export const DIRECT_LABEL='agent-relay-assets-v1';
export const DIRECT_CHUNK=16*1024;
export const DIRECT_LIMIT=16*1024*1024;
// Werift uses the first STUN URL only. Keep the reachable service first.
export const DIRECT_STUN=['stun:stun.l.google.com:19302','stun:stun.cloudflare.com:3478'];
export interface DirectIceServer {urls:string;username?:string;credential?:string}
export function validTurnServers(value:unknown):value is DirectIceServer[]{
  return Array.isArray(value)&&value.length>0&&value.length<=4&&value.every(v=>v&&typeof v.urls==='string'&&/^turns?:[a-zA-Z0-9.\[\]:-]+\?transport=(tcp|udp)$/.test(v.urls)&&typeof v.username==='string'&&v.username.length<=150&&typeof v.credential==='string'&&v.credential.length<=150);
}
export interface DirectOffer {type:'offer';sdp:string}
export function validDirectSdp(value:unknown,type:'offer'|'answer',allowRelay=false):boolean{
  const v=value as {type?:unknown;sdp?:unknown};
  if(!v||v.type!==type||typeof v.sdp!=='string'||v.sdp.length>50000||!v.sdp.startsWith('v=0\r\n'))return false;
  const media=v.sdp.split(/\r?\n/).filter(line=>line.startsWith('m='));
  return media.length===1&&/^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel$/.test(media[0])
    &&(allowRelay||!/^a=candidate:.*\btyp relay\b/m.test(v.sdp))&&/^a=fingerprint:sha-256 /m.test(v.sdp);
}
