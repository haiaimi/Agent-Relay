function pathKey(path,platform=''){
  const value=String(path??'').trim().replace(/[\\/]+$/,'');
  return platform.startsWith('win')||/^[a-z]:[\\/]/i.test(value)?value.replaceAll('\\','/').toLowerCase():value;
}
export function matchingStudioProject(host,path,preferredId){
  const key=pathKey(path,host?.platform);if(!key)return undefined;
  const projects=[...(host?.projects??[])].sort((a,b)=>Number(b.id===preferredId)-Number(a.id===preferredId));
  for(const project of projects){const index=(project.roots??[project.path]).findIndex(root=>pathKey(root,host.platform)===key);if(index>=0)return {projectId:project.id,workspaceIndex:index};}
}
export function studioProjectRegistration(host,path,createFolder,id){
  path=String(path??'').trim();
  const windows=/^[a-z]:[\\/]/i.test(path),posix=path.startsWith('/');
  if(!path||path.length>2000||/[\r\n\x00]/.test(path)||(!windows&&!posix)||host?.platform?.startsWith('win')&&!windows||host?.platform?.startsWith('darwin')&&!posix)throw Error('请输入所选工作电脑上的工程文件夹绝对路径');
  if(!host?.online)throw Error('工作电脑离线，无法登记新的工程路径');
  if(!host.capabilities?.createProject)throw Error('请更新该电脑的连接程序，以支持指定新工程路径');
  const name=path.replace(/[\\/]+$/,'').split(/[\\/]/).at(-1)?.slice(0,100);
  if(!name||/^[a-z]:$/i.test(name))throw Error('请选择磁盘中的工程文件夹');
  return {id,type:'create-project',hostId:host.id,projectName:name,projectPath:path,createFolder:!!createFolder};
}
