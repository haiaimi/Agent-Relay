import { resolve } from 'node:path';
import { createRelay } from './server.js';
const port=Number(process.env.RELAY_PORT ?? 8787), host=process.env.RELAY_HOST ?? '127.0.0.1';
const turn=process.env.TURN_URLS&&process.env.TURN_SECRET?{urls:process.env.TURN_URLS.split(',').map(v=>v.trim()),secret:process.env.TURN_SECRET}:undefined;
const app=createRelay({dataDir:resolve(process.env.RELAY_DATA_DIR ?? '.data/relay'),phoneToken:process.env.PHONE_TOKEN ?? '',bridgeToken:process.env.BRIDGE_TOKEN ?? '',publicOrigin:process.env.PUBLIC_ORIGIN,turn});
app.server.listen(port,host,()=>console.log(`Agent Relay listening on ${host}:${port}`));
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>void app.close().then(()=>process.exit(0)));
