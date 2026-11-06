import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {DirectTransfers} from '../src/bridge/direct.js';
import {MediaStore} from '../src/shared/media.js';
import {FileStore} from '../src/shared/files.js';
import {validDirectSdp} from '../src/shared/direct.js';
import {validateAction} from '../src/shared/protocol.js';
import {directClient} from './helpers/direct-client.js';

test('direct assets stream multi-chunk content, reject corrupted uploads and enforce immutable peer scope',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-direct-')),db=new DatabaseSync(':memory:'),media=new MediaStore(root,db),files=new FileStore(root,db),registered:any[]=[];
  const direct=new DirectTransfers(media,files,async(scope,file)=>{registered.push({scope,file});},[]),scope='pc|pc:codex:a',peers:Awaited<ReturnType<typeof directClient>>[]=[];
  try{
    const bytes=Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB','base64'),randomBytes(2*1024*1024)]),ref=media.put('pc:codex:a',bytes,'large.png');
    const a=await directClient(offer=>direct.accept(scope,offer));peers.push(a);
    const read=await a.read('image',ref.id!);assert.deepEqual(read.bytes,bytes);assert.equal(read.meta.sha256,createHash('sha256').update(bytes).digest('hex'));
    const file=await a.upload('large.bin',bytes);assert.deepEqual(files.read(scope,file.id).bytes,bytes);assert.equal(registered[0].scope,scope);
    await assert.rejects(a.upload('broken.bin',bytes,randomUUID(),'0'.repeat(64)),/校验/);assert.equal(registered.length,1);
    await assert.rejects(a.read('file','../secret'),/无效/);
    const b=await directClient(offer=>direct.accept('pc|pc:codex:b',offer));peers.push(b);await assert.rejects(b.read('image',ref.id!),/不存在|不属于/);await assert.rejects(b.read('file',file.id),/不属于/);
    const project=await directClient(offer=>direct.accept('pc|project:work',offer));peers.push(project);await assert.rejects(project.read('image',ref.id!),/项目连接/);
  }finally{for(const peer of peers)await peer.close();direct.close();db.close();rmSync(root,{recursive:true,force:true});}
});

test('signaling only accepts a single authenticated data channel offer and refuses relay candidates',()=>{
  const sdp='v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 01:02\r\n';
  assert.equal(validDirectSdp({type:'offer',sdp},'offer'),true);
  assert.equal(validDirectSdp({type:'offer',sdp:sdp+'a=candidate:1 1 udp 1 203.0.113.10 1234 typ relay\r\n'},'offer'),false);
  assert.equal(validDirectSdp({type:'offer',sdp:sdp+'m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'},'offer'),false);
  assert.throws(()=>validateAction({id:randomUUID(),type:'direct',offer:{type:'offer',sdp}}),/目标/);
  assert.throws(()=>validateAction({id:randomUUID(),type:'direct',projectId:'work',sessionId:'other',offer:{type:'offer',sdp}}),/目标/);
});
