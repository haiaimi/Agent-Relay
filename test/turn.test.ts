import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {turnCredentials} from '../src/relay/turn.js';
import {createRelay} from '../src/relay/server.js';
import {validDirectSdp} from '../src/shared/direct.js';

const turn={urls:['turn:relay.example:3478?transport=tcp'],secret:'a'.repeat(64)};
const sdp='v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 01:02\r\na=candidate:1 1 udp 1 1.2.3.4 1234 typ relay\r\n';
test('TURN credentials expire, use independent random identities, and do not expose the shared secret',()=>{
  const first=turnCredentials(turn,1000000),second=turnCredentials(turn,1000000),server=first.iceServers[0];
  assert.equal(first.expiresAt,1600000);assert.match(server.username!,/^1600:/);assert.notEqual(server.username,second.iceServers[0].username);
  assert.equal(server.credential,createHmac('sha1',turn.secret).update(server.username!).digest('base64'));
  assert.ok(!JSON.stringify(first).includes(turn.secret));
  assert.throws(()=>turnCredentials({...turn,urls:['turn:http://evil/']}));
  assert.equal(validDirectSdp({type:'offer',sdp},'offer'),false);
  assert.equal(validDirectSdp({type:'offer',sdp},'offer',true),true);
});

test('TURN config requires login and a valid online target; relay injects only its own transient credentials',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-turn-')),phone=randomUUID(),bridgeToken=randomUUID();
  const relay=createRelay({dataDir:root,phoneToken:phone,bridgeToken,turn});relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  const base='http://127.0.0.1:'+(relay.server.address() as any).port;let cookie='';
  const request=(path:string,value?:any)=>fetch(base+path,{method:value?'POST':'GET',headers:{cookie,Origin:base,...(value?{'Content-Type':'application/json'}:{})},body:value?JSON.stringify(value):undefined});
  const ws=new WebSocket(base.replace('http','ws')+'/bridge',{headers:{Authorization:'Bearer '+bridgeToken}});let forwarded:any;
  try{
    await once(ws,'open');ws.on('message',raw=>{const m=JSON.parse(String(raw));if(m.type==='action'){forwarded=m.action;ws.send(JSON.stringify({type:'result',id:m.action.id,result:{type:'answer',sdp}}));}});
    ws.send(JSON.stringify({type:'hello',host:{id:'pc',name:'PC',projects:[{id:'work',name:'work',path:'C:/work'}]}}));
    for(let i=0;i<100&&!relay.store.hosts().length;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal((await request('/api/direct-config?hostId=pc&projectId=work')).status,401);
    const login=await request('/api/login',{token:phone});cookie=login.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await request('/api/direct-config?hostId=pc&projectId=missing')).status,404);
    const config=await (await request('/api/direct-config?hostId=pc&projectId=work')).json() as any;
    assert.equal(config.iceServers[0].urls,turn.urls[0]);assert.ok(!JSON.stringify(config).includes(turn.secret));
    const response=await request('/api/direct',{hostId:'pc',projectId:'work',relay:true,offer:{type:'offer',sdp},iceServers:[{urls:'turn:evil:3478?transport=tcp',username:'evil',credential:'evil'}]});
    assert.equal(response.status,200);assert.equal(forwarded.iceServers[0].urls,turn.urls[0]);
    assert.notEqual(forwarded.iceServers[0].username,'evil');assert.equal(relay.store.db.prepare('SELECT count(*) n FROM actions').get()!.n,0);
    assert.equal((await request('/api/direct',{hostId:'pc',projectId:'work',offer:{type:'offer',sdp}})).status,400);
  }finally{ws.terminate();await relay.close();rmSync(root,{recursive:true,force:true});}
});
