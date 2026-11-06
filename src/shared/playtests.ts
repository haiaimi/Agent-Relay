export interface LaunchTarget {revision?:string;id:string;kind:'functional'|'game';title:string;script:string;cwd:string;scene:string;controls:string}
export interface LaunchRequest {op:'inspect'|'start'|'status';target:LaunchTarget;hash?:string;requestId?:string}
export function relativeLaunchPath(value:unknown,folder=false):string{
 if(typeof value!=='string'||!value||value.length>1000||/[\x00-\x1f:]/.test(value)||/^[\\/]/.test(value))throw Error('启动路径必须位于本需求工作副本内');
 const path=value.replaceAll('\\','/');if(path.split('/').some(p=>p==='..'||!p)||!folder&&path==='.')throw Error('启动路径不能越出工作副本');return path;
}
export function launchTargets(value:unknown):LaunchTarget[]{
 if(value===undefined)return [];if(!Array.isArray(value)||value.length>8)throw Error('启动入口最多 8 项');
 const out=value.map(v=>{
  if(!v||!/^[a-zA-Z0-9_-]{1,60}$/.test(v.id??'')||!['functional','game'].includes(v.kind)||typeof v.title!=='string'||!v.title.trim()||v.title.length>120||typeof v.scene!=='string'||!v.scene.trim()||v.scene.length>1000||/[\x00\r\n]/.test(v.scene)||typeof v.controls!=='string'||v.controls.length>2000)throw Error('启动入口需包含有效的类型、标题、真实场景和操作说明');
  const script=relativeLaunchPath(v.script),cwd=relativeLaunchPath(v.cwd??'.',true);if(!/\.(ps1|bat|cmd|sh)$/i.test(script))throw Error('启动入口仅支持工作副本内的 ps1 / bat / cmd / sh 脚本');
  if(v.revision!==undefined&&(typeof v.revision!=='string'||v.revision.length>100))throw Error('无效交付版本');
  return {...v.revision!==undefined?{revision:v.revision}:{},id:v.id,kind:v.kind,title:v.title.trim(),script,cwd,scene:v.scene,controls:v.controls} as LaunchTarget;
 });if(new Set(out.map(t=>t.id)).size!==out.length)throw Error('启动入口 ID 不能重复');return out;
}
