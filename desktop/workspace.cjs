const {readFileSync}=require('node:fs');
const {join}=require('node:path');
function workspaceOrigin(relayUrl){
  const u=new URL(relayUrl);
  if(!['ws:','wss:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('Invalid relay address');
  if(u.protocol==='ws:'&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('Remote relay requires HTTPS');
  u.protocol=u.protocol==='wss:'?'https:':'http:';return u.origin;
}
function phoneToken(root){
  if(process.env.PHONE_TOKEN)return process.env.PHONE_TOKEN;
  try{const line=readFileSync(join(root,'.env'),'utf8').split(/\r?\n/).find(line=>/^\s*PHONE_TOKEN\s*=/.test(line));return line?.slice(line.indexOf('=')+1).trim().replace(/^(['"])(.*)\1$/,'$2');}catch{return undefined;}
}
async function restoreLogin(session,origin,root,request=fetch){
  const saved=await session.cookies.get({url:origin,name:'relay_session'});if(saved.length)return true;
  const token=phoneToken(root);if(!token)return false;
  // Only the configured relay receives the existing key. Renderers never receive it.
  const response=await request(origin+'/api/login',{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token})});
  if(!response.ok)return false;
  const cookie=response.headers.get('set-cookie')?.match(/(?:^|,\s*)relay_session=([a-zA-Z0-9_.-]+);/);if(!cookie)return false;
  await session.cookies.set({url:origin,name:'relay_session',value:cookie[1],httpOnly:true,secure:origin.startsWith('https:'),sameSite:'strict',expirationDate:Date.now()/1000+604800});return true;
}
module.exports={workspaceOrigin,restoreLogin};
