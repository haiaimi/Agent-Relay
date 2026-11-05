import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const {clipboardPaths,readClipboardFiles}=createRequire(import.meta.url)('../desktop/clipboard-files.cjs');
test('desktop file paste decodes Unicode file lists and bounds malformed HDROP data',()=>{
  const paths=['E:\\Art\\参考.png','E:\\Video\\intro.mp4'],list=Buffer.from(paths.join('\0')+'\0\0','utf16le');assert.deepEqual(clipboardPaths(list,'FileNameW'),paths);const header=Buffer.alloc(20);header.writeUInt32LE(20);header.writeUInt32LE(1,16);assert.deepEqual(clipboardPaths(Buffer.concat([header,list]),'CF_HDROP'),paths);header.writeUInt32LE(999999);assert.deepEqual(clipboardPaths(Buffer.concat([header,list]),'CF_HDROP'),[]);assert.deepEqual(clipboardPaths(Buffer.alloc(200000),'FileNameW'),[]);
});
test('desktop paste reads only explicitly supplied ordinary fixture files and enforces 16 MB total',()=>{
  const dir=mkdtempSync(join(tmpdir(),'studio-clipboard-'));try{const path=join(dir,'clip.mp4');writeFileSync(path,'video fixture');const mock=(paths:string[])=>({availableFormats:()=>['FileNameW'],readBuffer:()=>Buffer.from(paths.join('\0')+'\0\0','utf16le')});const files=readClipboardFiles(mock([path]));assert.equal(files[0].name,'clip.mp4');assert.equal(files[0].mime,'video/mp4');assert.equal(Buffer.from(files[0].data,'base64').toString(),'video fixture');assert.throws(()=>readClipboardFiles(mock(Array(6).fill(path))),/5/);const folder=join(dir,'folder');mkdirSync(folder);assert.throws(()=>readClipboardFiles(mock([folder])),/普通文件/);const large=join(dir,'large.mp4');writeFileSync(large,Buffer.alloc(16*1024*1024+1));assert.throws(()=>readClipboardFiles(mock([large])),/16 MB/);}finally{rmSync(dir,{recursive:true,force:true});}
});
