import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
import sharp from 'sharp';
import {ImagePreviews} from '../src/relay/previews.js';
test('large preview is bounded, shared and cached without replacing the original image',async()=>{
 const root=mkdtempSync(join(tmpdir(),'relay-preview-')),store=new ImagePreviews(root);
 try{
  const original=await sharp(randomBytes(1600*1200*3),{raw:{width:1600,height:1200,channels:3}}).png().toBuffer(),hash=createHash('sha256').update(original).digest('hex');
  const [a,b]=await Promise.all([store.image(original,'image/png'),store.image(original,'image/png')]);
  assert.deepEqual(a.bytes,b.bytes);assert.equal(a.mime,'image/webp');assert.ok(a.bytes.length<original.length/3);
  const meta=await sharp(a.bytes).metadata();assert.equal(meta.width,960);assert.equal(meta.height,720);
  assert.equal(createHash('sha256').update(original).digest('hex'),hash);assert.notEqual(a.hash,hash);
  assert.equal(readdirSync(join(root,'previews')).length,1);assert.deepEqual((await store.image(original,'image/png')).bytes,a.bytes);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('small or undecodable images retain original bytes instead of breaking previews',async()=>{
 const root=mkdtempSync(join(tmpdir(),'relay-preview-safe-')),store=new ImagePreviews(root);
 try{for(const bytes of [Buffer.from('small'),Buffer.alloc(100*1024)])assert.deepEqual((await store.image(bytes,'image/png')).bytes,bytes);}finally{rmSync(root,{recursive:true,force:true});}
});
