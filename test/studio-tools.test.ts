import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {validateToolchain,validateBlockers,toolchainInstructions} from '../src/relay/studio-tools.js';

test('shared tools validate paths and provide operation-specific checks without weakening provenance or quality',()=>{
  const cfg=validateToolchain({blender:' E:/Portable Blender/blender.exe ',pythonPaths:['E:/cache','E:/cache'],searchRoots:['E:/tools']})!;
  assert.equal(cfg.blender,'E:/Portable Blender/blender.exe');assert.deepEqual(cfg.pythonPaths,['E:/cache']);
  assert.throws(()=>validateToolchain({blender:'exe\nmalformed'}),/路径/);assert.throws(()=>validateToolchain({searchRoots:Array(7).fill('E:/tool')}),/最多/);
  const prompt=toolchainInstructions(cfg,'E:/isolated copy','E:/source');assert.match(prompt,/captures 未复制不表示工具不存在/);assert.match(prompt,/不因没有新建\/重导出而强制跑 DCC/);assert.match(prompt,/生产\/发布门禁仍需真实来源证据/);assert.match(prompt,/实际 Python 解释器/);
  assert.deepEqual(validateBlockers(undefined),[]);assert.throws(()=>validateBlockers([{category:'environment',code:'MISSING',details:'missing'}]),/恢复步骤/);
});

test('read-only discovery finds a portable DCC in source caches; explicitly pinned missing tools do not silently fall back',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-tools-')),project=join(dir,'project'),source=join(dir,'source'),portable=join(source,'captures','asset-pipeline-dcc','blender-test');mkdirSync(project);mkdirSync(portable,{recursive:true});
  // A Node binary is sufficient for the --version protocol without requiring Blender in CI.
  const dcc=join(portable,'blender.exe');
  try{
    // Use an explicit executable for the real probe, and a marker to verify cache discovery independently.
    writeFileSync(dcc,'not executable');
    const probe=(args:string[])=>{const r=spawnSync(process.execPath,[resolve('scripts/discover-studio-tools.mjs'),'--project',project,'--source',source,...args],{encoding:'utf8',timeout:20000});assert.equal(r.error,undefined);return {status:r.status,data:JSON.parse(r.stdout)};};
    const found=probe([]);assert.ok(found.data.blender.candidates.includes(dcc));assert.equal(found.status,0,'optional DCC absence does not block a reuse inventory');assert.deepEqual(found.data.requirements,[]);
    const missing=probe(['--blender',join(dir,'missing.exe'),'--needs','blender']);assert.equal(missing.status,2);assert.equal(missing.data.blender.path,undefined);assert.equal(missing.data.blockers[0].code,'MISSING_BLENDER');
    const version=probe(['--blender',process.execPath,'--needs','blender']);assert.equal(version.status,0);assert.equal(version.data.blender.ok,true);assert.equal(version.data.acceptance.includes('not asset'),true);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
