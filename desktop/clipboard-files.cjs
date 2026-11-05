const {lstatSync,readFileSync}=require('node:fs');
const {isAbsolute,basename}=require('node:path');
const LIMIT=16*1024*1024;
function clipboardPaths(buffer,format){
  if(!Buffer.isBuffer(buffer)||buffer.length>128*1024)return [];
  let bytes=buffer;if(format==='CF_HDROP'){if(buffer.length<20)return [];const offset=buffer.readUInt32LE(0);if(offset<20||offset>=buffer.length||!buffer.readUInt32LE(16))return [];bytes=buffer.subarray(offset);}
  if(bytes.length%2)return [];return bytes.toString('utf16le').split('\0').filter(Boolean);
}
function readClipboardFiles(clipboard){
  const formats=clipboard.availableFormats();let paths=[];
  for(const format of ['FileNameW','CF_HDROP'])if(formats.includes(format)){paths=clipboardPaths(clipboard.readBuffer(format),format);if(paths.length)break;}
  if(paths.length>5)throw Error('最多粘贴 5 个文件');let size=0;
  return paths.map(path=>{if(!isAbsolute(path)||/[\r\n]/.test(path))throw Error('无效剪贴板文件');const stat=lstatSync(path);if(!stat.isFile())throw Error('请选择普通文件；文件夹或快捷链接暂不支持');size+=stat.size;if(!stat.size||size>LIMIT)throw Error('附件总大小不能超过 16 MB');const data=readFileSync(path);if(data.length!==stat.size)throw Error('文件已变化，请重新复制');const name=basename(path),ext=name.split('.').at(-1).toLowerCase(),mime=({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime',m4v:'video/mp4'})[ext];return {name,mime,data:data.toString('base64')};});
}
module.exports={clipboardPaths,readClipboardFiles};
