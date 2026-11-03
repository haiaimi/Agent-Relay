import {RTCPeerConnection,type RTCDataChannel} from 'werift';
import {randomUUID,createHash} from 'node:crypto';
import {DIRECT_LABEL,DIRECT_CHUNK,type DirectIceServer} from '../../src/shared/direct.js';
export async function directClient(signal:(offer:any)=>Promise<any>,options:{iceServers?:DirectIceServer[];relayOnly?:boolean;timeoutMs?:number}={}){
  const pc=new RTCPeerConnection({iceServers:options.iceServers??[],iceUseIpv6:false}),channel=pc.createDataChannel(DIRECT_LABEL,{ordered:true});
  const opened=channel.stateChanged.watch(state=>state==='open',20000);
  await pc.setLocalDescription(await pc.createOffer());
  const relayOnly=(sdp:string)=>sdp.split('\r\n').filter(line=>!line.startsWith('a=candidate:')||/\btyp relay\b/.test(line)).join('\r\n');
  const answer=await signal({type:'offer',sdp:options.relayOnly?relayOnly(pc.localDescription!.sdp):pc.localDescription!.sdp});await pc.setRemoteDescription(options.relayOnly?{...answer,sdp:relayOnly(answer.sdp)}:answer);await opened;
  let current:any;
  channel.onMessage.subscribe(data=>{
    if(!current)return;
    if(Buffer.isBuffer(data)){current.parts.push(data);return;}
    const value=JSON.parse(data);if(value.requestId!==current.id)return;
    if(value.type==='error')current.finish(new Error(value.error));
    if(value.type==='start'){current.meta=value;current.parts=[];}
    if(value.type==='end')current.finish(null,{bytes:Buffer.concat(current.parts),meta:current.meta});
    if(value.type==='upload-ready')void current.ready();
    if(value.type==='uploaded')current.finish(null,value.file);
  });
  const job=(start:(job:any)=>void)=>new Promise<any>((resolve,reject)=>{
    const id=randomUUID(),timer=setTimeout(()=>current.finish(new Error('Direct transfer timed out')),options.timeoutMs??30000);
    current={id,parts:[],finish:(error:any,result:any)=>{clearTimeout(timer);current=null;error?reject(error):resolve(result);}};start(current);
  });
  return {
    pc,channel,
    read:(kind:string,id:string)=>job(j=>channel.send(JSON.stringify({type:'read',requestId:j.id,kind,id}))),
    upload:(name:string,bytes:Buffer,id=randomUUID(),hash=createHash('sha256').update(bytes).digest('hex'))=>job(j=>{
      j.ready=async()=>{for(let i=0;i<bytes.length;i+=DIRECT_CHUNK){while(channel.bufferedAmount>256*1024)await new Promise(r=>setTimeout(r,10));channel.send(bytes.subarray(i,i+DIRECT_CHUNK));}channel.send(JSON.stringify({type:'upload-end',requestId:j.id}));};
      channel.send(JSON.stringify({type:'upload',requestId:j.id,file:{id,name,size:bytes.length,mime:'application/octet-stream',sha256:hash}}));
    }),
    close:()=>pc.close()
  };
}
