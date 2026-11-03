import {createHmac,randomBytes} from 'node:crypto';
import {validTurnServers,type DirectIceServer} from '../shared/direct.js';

export interface TurnConfig {urls:string[];secret:string}
export function turnCredentials(config:TurnConfig,now=Date.now()):{iceServers:DirectIceServer[];expiresAt:number}{
  if(config.secret.length<32)throw new Error('TURN_SECRET must contain at least 32 characters');
  const expiresAt=Math.floor(now/1000)+600,username=expiresAt+':'+randomBytes(12).toString('hex');
  const credential=createHmac('sha1',config.secret).update(username).digest('base64');
  const iceServers=config.urls.map(urls=>({urls,username,credential}));
  if(!validTurnServers(iceServers))throw new Error('Invalid TURN_URLS');
  return {iceServers,expiresAt:expiresAt*1000};
}
