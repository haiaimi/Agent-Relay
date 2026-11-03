import {RTCPeerConnection,type RTCDataChannel} from 'werift';
import {DIRECT_LABEL,DIRECT_CHUNK,DIRECT_LIMIT,DIRECT_STUN,validDirectSdp,type DirectOffer,type DirectIceServer} from '../shared/direct.js';
import type {MediaStore} from '../shared/media.js';
import type {FileStore,FileRef} from '../shared/files.js';

interface Peer {pc:RTCPeerConnection;timer:NodeJS.Timeout;close:()=>void}
export class DirectTransfers {
  private peers=new Set<Peer>();
  constructor(private media:MediaStore,private files:FileStore,private register:(scope:string,file:FileRef)=>Promise<void>,private iceServers=DIRECT_STUN){}
  async accept(scope:string,offer:DirectOffer,relayServers?:DirectIceServer[]){
    if(!validDirectSdp(offer,'offer',Boolean(relayServers?.length)))throw new Error('无效直连协商');
    if(this.peers.size>=16)throw new Error('直连数量已达上限，请稍后重试');
    const pc=new RTCPeerConnection({iceServers:[...this.iceServers.map(url=>({urls:url})),...relayServers??[]],iceUseIpv6:true,iceStunGatherTimeout:4000,maxMessageSize:65536});
    const peer:Peer={pc,timer:undefined!,close:()=>{if(!this.peers.delete(peer))return;clearTimeout(peer.timer);void pc.close().catch(()=>{});}};
    const touch=()=>{clearTimeout(peer.timer);peer.timer=setTimeout(peer.close,120000);peer.timer.unref();};
    this.peers.add(peer);touch();
    pc.connectionStateChange.subscribe(state=>{if(state==='failed'||state==='closed')peer.close();});
    let channelSeen=false;
    pc.onDataChannel.subscribe(channel=>{
      if(channelSeen||channel.label!==DIRECT_LABEL||!channel.ordered){channel.close();return;}
      channelSeen=true;this.channel(channel,scope,touch,peer.close);
      channel.stateChanged.subscribe(state=>{if(state==='closed')peer.close();});
    });
    try{
      await pc.setRemoteDescription(offer);await pc.setLocalDescription(await pc.createAnswer());
      const answer={type:'answer' as const,sdp:pc.localDescription!.sdp};
      if(!validDirectSdp(answer,'answer',Boolean(relayServers?.length)))throw new Error('直连协商失败');
      return answer;
    }catch(error){peer.close();throw error;}
  }
  private channel(channel:RTCDataChannel,scope:string,touch:()=>void,close:()=>void){
    let busy=false,upload:{requestId:string;file:FileRef;parts:Buffer[];size:number}|undefined;
    const send=(value:unknown)=>channel.send(JSON.stringify(value));
    const fail=(id:string,error:unknown)=>{if(channel.readyState==='open')send({type:'error',requestId:id,error:(error as Error).message});};
    const drain=async()=>{
      const until=Date.now()+30000;
      while(channel.bufferedAmount>256*1024){if(channel.readyState!=='open'||Date.now()>until)throw new Error('直传中断，请重试');await new Promise(r=>setTimeout(r,10));}
    };
    channel.onMessage.subscribe(data=>{
      touch();
      if(Buffer.isBuffer(data)){
        if(!upload||data.length>DIRECT_CHUNK||(upload.size+=data.length)>upload.file.size){close();return;}
        upload.parts.push(data);return;
      }
      let request:any;try{if(data.length>1500)throw Error();request=JSON.parse(data);if(!/^[a-f0-9-]{36}$/i.test(request.requestId??''))throw Error();}catch{close();return;}
      const id=request.requestId;
      if(request.type==='upload-end'){
        const current=upload;if(!current||current.requestId!==id){close();return;}upload=undefined;
        void (async()=>{try{if(current.size!==current.file.size)throw new Error('附件传输不完整');const file=this.files.put(scope,current.file,Buffer.concat(current.parts,current.size));await this.register(scope,file);send({type:'uploaded',requestId:id,file});}catch(e){fail(id,e);}finally{busy=false;touch();}})();return;
      }
      if(busy){fail(id,new Error('上一份资源仍在传输'));return;}
      if(request.type==='upload'){
        const file=request.file as FileRef;
        if(!file||!Number.isSafeInteger(file.size)||file.size<1||file.size>DIRECT_LIMIT||!/^[a-f0-9]{64}$/.test(file.sha256??'')||typeof file.name!=='string'||file.name.length>180){fail(id,new Error('无效附件'));return;}
        busy=true;upload={requestId:id,file,parts:[],size:0};send({type:'upload-ready',requestId:id});return;
      }
      if(request.type!=='read'||!['image','file'].includes(request.kind)){fail(id,new Error('不支持的直传请求'));return;}
      busy=true;
      void (async()=>{try{
        const sessionId=scope.slice(scope.indexOf('|')+1);if(sessionId.startsWith('project:'))throw new Error('项目连接不可读取会话资源');
        const image=request.kind==='image'?this.media.read(sessionId,request.id):undefined;
        const file=request.kind==='file'?this.files.read(scope,request.id):undefined;
        const bytes=image?.bytes??file?.bytes;if(!bytes||bytes.length>DIRECT_LIMIT)throw new Error('资源不存在或不属于此会话');
        send({type:'start',requestId:id,size:bytes.length,mime:image?.mime??file!.file.mime,sha256:request.kind==='image'?request.id:file!.file.sha256,name:image?.name??file!.file.name});
        for(let offset=0;offset<bytes.length;offset+=DIRECT_CHUNK){await drain();if(channel.readyState!=='open')throw new Error('直传连接已断开');channel.send(bytes.subarray(offset,offset+DIRECT_CHUNK));touch();}
        send({type:'end',requestId:id});
      }catch(e){fail(id,e);}finally{busy=false;}})();
    });
  }
  close(){for(const peer of [...this.peers])peer.close();}
}
