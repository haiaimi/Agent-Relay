export const agentLabel=s=>s?.agentName||(s?.provider==='codex'?'Codex':s?.provider==='claude'?'Claude Code':'API Agent');
export const agentChoice=value=>value.startsWith('api:')?{provider:'api',agentId:value.slice(4)}:{provider:value};
export const hostAgents=host=>host?.agents??[{id:'codex',provider:'codex',name:'Codex'},{id:'claude',provider:'claude',name:'Claude Code'}];
