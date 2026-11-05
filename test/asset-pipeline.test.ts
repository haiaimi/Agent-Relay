import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

// Tests exercise orchestration only; production Blender is an explicit local smoke.
const pipeline=await import('../scripts/asset-pipeline.mjs' as string);
test('asset downloads retry five times a minute apart while permanent failures stop immediately',async()=>{
  const delays:number[]=[],attempts:number[]=[];
  await assert.rejects(pipeline.retry((n:number)=>{attempts.push(n);throw Error('offline');},{sleep:async(ms:number)=>{delays.push(ms);},onRetry:()=>{}}),/offline/);
  assert.deepEqual(attempts,[1,2,3,4,5]);assert.deepEqual(delays,[60000,60000,60000,60000]);
  let calls=0;await assert.rejects(pipeline.retry(()=>{calls++;throw Object.assign(Error('hash mismatch'),{permanent:true});},{sleep:()=>assert.fail('must not retry')}),/hash mismatch/);assert.equal(calls,1);
});

test('asset CLI retains paths and script arguments without shell interpolation; invalid input fails',async()=>{
  const parsed=pipeline.parse(['run','--script','path with spaces/model.py','--out','new outputs/one','--','--variant','stone']);assert.equal(parsed.script,resolve('path with spaces/model.py'));assert.deepEqual(parsed.args,['--variant','stone']);
  assert.throws(()=>pipeline.parse(['setup','--blender']),/missing/);assert.throws(()=>pipeline.parse(['setup','--unknown','x']),/Unknown/);assert.throws(()=>pipeline.parse(['setup','--tools','bad\npath']),/argument/);
  const result=await pipeline.run(process.execPath,['-e','console.log(process.argv[1])','literal ` $() ; &'],{quiet:true});assert.equal(result.trim(),'literal ` $() ; &');
  await assert.rejects(pipeline.run(process.execPath,['-e','process.exit(3)'],{quiet:true}),/exited 3/);
});

test('asset tool pins cover supported platforms and discovery honors a local config with explicit pins taking precedence',()=>{
  const lock=JSON.parse(readFileSync('tools/asset-pipeline/toolchain.lock.json','utf8'));for(const platform of ['win32-x64','darwin-arm64','darwin-x64','linux-x64']){assert.match(lock.platforms[platform].sha256,/^[a-f0-9]{64}$/);assert.ok(lock.platforms[platform].file.includes(lock.blender));}
  const dir=mkdtempSync(join(tmpdir(),'relay-asset-tools-'));try{
    const config=join(dir,'studio-toolchain.json'),deps=join(dir,'deps');mkdirSync(deps);writeFileSync(config,JSON.stringify({blender:process.execPath,pythonPaths:[deps]}));
    const probe=(extra:string[])=>{const r=spawnSync(process.execPath,['scripts/discover-studio-tools.mjs','--project',dir,'--toolchain',config,'--needs','blender',...extra],{encoding:'utf8',env:{...process.env,BLENDER_EXE:''}});return {status:r.status,data:JSON.parse(r.stdout)};};
    const available=probe([]);assert.equal(available.status,0);assert.equal(available.data.blender.path,process.execPath);assert.ok(available.data.python.pythonPaths.includes(deps));
    const missing=probe(['--blender',join(dir,'missing.exe')]);assert.equal(missing.status,2);assert.equal(missing.data.blender.path,undefined);
    const explicit=probe(['--python',process.execPath]);assert.ok(!explicit.data.python.pythonPaths.includes(deps),'Python override must not inherit another ABI dependency directory');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('asset execution streams complete logs and importing the module has no setup side effects',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-asset-log-'));try{const logFile=join(dir,'blender.log');await pipeline.run(process.execPath,['-e','console.log("stdout");console.error("stderr")'],{quiet:true,logFile});const log=readFileSync(logFile,'utf8');assert.match(log,/stdout/);assert.match(log,/stderr/);}finally{rmSync(dir,{recursive:true,force:true});}
});
