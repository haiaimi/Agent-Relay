import { resolve } from 'node:path';
import { createRelay } from './server.js';
const port=Number(process.env.RELAY_PORT ?? 8787), host=process.env.RELAY_HOST ?? '127.0.0.1';
const app=createRelay({dataDir:resolve(process.env.RELAY_DATA_DIR ?? '.data/relay'),phoneToken:process.env.PHONE_TOKEN ?? '',bridgeToken:process.env.BRIDGE_TOKEN ?? '',publicOrigin:process.env.PUBLIC_ORIGIN});
app.server.listen(port,host,()=>console.log(`Agent Relay listening on ${host}:${port}`));
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>void app.close().then(()=>process.exit(0)));
