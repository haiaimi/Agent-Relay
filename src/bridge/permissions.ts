import type {PermissionMode} from '../shared/protocol.js';

export function codexPermissions(mode:PermissionMode='request',cwd:string){
  return {
    approvalPolicy:mode==='full'?'never':'on-request',
    approvalsReviewer:mode==='auto'?'auto_review':'user',
    sandbox:mode==='full'?'danger-full-access':'workspace-write',
    sandboxPolicy:mode==='full'?{type:'dangerFullAccess'}:{type:'workspaceWrite',writableRoots:[cwd],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false}
  };
}
export function claudePermissions(mode:PermissionMode='request'){
  return {permissionMode:mode==='full'?'bypassPermissions' as const:mode==='auto'?'auto' as const:'default' as const,...mode==='full'?{allowDangerouslySkipPermissions:true}:{}};
}
