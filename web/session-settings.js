const efforts={none:'无',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高',ultra:'极高'};
const permissions={request:'请求批准',auto:'帮我批准',full:'完整权限'};
export function settingsPresentation(session,list=[],loading=false){
  const find=id=>list.find(m=>m.id===id||m.aliases?.includes(id));
  const name=id=>find(id)?.name||id|| (loading?'读取模型中…':'模型未读取');
  const effort=(id,level)=>{const resolved=level==='default'?find(id)?.defaultEffort:level;return efforts[resolved]||resolved|| (session.provider==='api'?'服务商默认':loading?'读取强度中…':'强度未读取');};
  // The chip describes the current session, never the select's previous value
  // or an unrelated model/list default. Presets have their own explicit label.
  const current=`${name(session.model)} · ${effort(session.model,session.effort)}`;
  const pending=session.nextModel||session.nextEffort?`下一轮：${name(session.nextModel??session.model)} · ${effort(session.nextModel??session.model,session.nextEffort??session.effort)}`:'';
  return {model:current,pending,permission:session.permissionLabel||permissions[session.permissionMode]||(loading?'读取权限中…':'权限未读取'),permissionPending:session.nextPermissionMode?`下一轮：${permissions[session.nextPermissionMode]}`:''};
}
