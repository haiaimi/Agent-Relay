// Keep authentication on the workstation. Never store tokens in a project URL.
export function repositoryAddress(value:unknown):string|undefined {
  if(value===undefined||value==='')return undefined;
  if(typeof value!=='string'||value.length>500)throw Error('请输入 GitHub 仓库的 HTTPS 或 SSH 地址');
  const url=value.trim();if(!url)return undefined;
  const match=url.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  if(!match||[match[1],match[2]].some(s=>s==='.'||s==='..'||s.toLowerCase()==='.git'||s.startsWith('-')))throw Error('请使用不含密码或令牌的 GitHub HTTPS / SSH 仓库地址');
  return url.replace(/\/$/,'');
}
export function repositoryKey(value:unknown){const address=repositoryAddress(value);return address?.replace(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i,'').replace(/\.git$/,'').toLowerCase();}
