// Local, opt-in asset tool installation and reproducible DCC execution.
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,createWriteStream,existsSync} from 'node:fs';
import {mkdir,readFile,writeFile,rename,readdir,cp} from 'node:fs/promises';
import {resolve,join,dirname,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

export const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const defaults=join(root,'.data','asset-tools'),lockPath=join(root,'tools/asset-pipeline/toolchain.lock.json'),requirements=join(root,'tools/asset-pipeline/requirements.lock');
export const hash=async path=>{const h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);return h.digest('hex');};
export function parse(args){
  const [command='help',...rest]=args,options={command,args:[]};
  for(let i=0;i<rest.length;i++){if(rest[i]==='--'){options.args=rest.slice(i+1);break;}const key={'--tools':'tools','--blender':'blender','--out':'out','--script':'script','--project':'project','--engine':'engine'}[rest[i]];
    if(!key||!rest[i+1]||rest[i+1].startsWith('--')||/[\0\r\n]/.test(rest[i+1]))throw Error('Unknown/missing argument: '+rest[i]);options[key]=resolve(rest[++i]);}
  if(!['help','setup','doctor','demo','run','project'].includes(command))throw Error('Unknown command: '+command);return options;
}
export async function retry(operation,{attempts=5,delay=60000,sleep=ms=>new Promise(r=>setTimeout(r,ms)),onRetry=console.error}={}){
  for(let n=1;;n++)try{return await operation(n);}catch(e){if(n>=attempts||e.permanent)throw e;onRetry(`Connection/download failed (${n}/${attempts}): ${e.message}; retrying in ${delay/1000}s`);await sleep(delay);}
}
export function run(exe,args,{env={},cwd=root,quiet=false,logFile}={}){
  return new Promise((yes,no)=>{let output='';const log=logFile?createWriteStream(logFile):undefined,child=spawn(exe,args,{cwd,env:{...process.env,...env},shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    log?.on('error',no);const collect=stream=>stream.on('data',b=>{output=(output+b).slice(-100000);log?.write(b);if(!quiet)process.stdout.write(b);});collect(child.stdout);collect(child.stderr);
    child.on('error',e=>{log?.end();no(e);});child.on('close',code=>{const done=()=>code===0?yes(output):no(Error(`${exe} exited ${code}\n${output.slice(-6000)}`));if(log)log.end(done);else done();});});
}
const json=async path=>JSON.parse(await readFile(path,'utf8'));
async function save(path,data){await mkdir(dirname(path),{recursive:true});const temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(data,null,2)+'\n');await rename(temp,path);}
async function download(url,path,sha256){
  if(existsSync(path)&&await hash(path)===sha256)return;
  await retry(async()=>{const r=await fetch(url,{signal:AbortSignal.timeout(600000)});if(!r.ok){const e=Error(`HTTP ${r.status}: ${url}`);e.permanent=r.status>=400&&r.status<500&&![408,429].includes(r.status);throw e;}
    const temp=path+'.partial';await pipeline(Readable.fromWeb(r.body),createWriteStream(temp));
    if(await hash(temp)!==sha256){const e=Error('SHA-256 mismatch: '+url);e.permanent=true;throw e;}await rename(temp,path);});
}
async function bundledPython(blender){
  const base=process.platform==='darwin'?resolve(dirname(blender),'../Resources'):dirname(blender);
  for(const entry of await readdir(base,{withFileTypes:true})){if(!entry.isDirectory()||!/^\d+\.\d+$/.test(entry.name))continue;
    const bin=join(base,entry.name,'python','bin');if(!existsSync(bin))continue;
    const candidates=(await readdir(bin)).filter(n=>process.platform==='win32'?n==='python.exe':/^python3(?:\.\d+)?$/.test(n));
    if(candidates.length)return join(bin,candidates.sort().at(-1));}
  throw Error('Bundled Python not found beside Blender: '+blender);
}
const cleanEnv={PYTHONPATH:'',PYTHONHOME:'',PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',IMAGEIO_FFMPEG_EXE:'',PIP_CONFIG_FILE:process.platform==='win32'?'NUL':'/dev/null',PIP_DISABLE_PIP_VERSION_CHECK:'1'};
async function setup(o){
  const dir=o.tools??defaults,lock=await json(lockPath),artifact=lock.platforms[process.platform+'-'+process.arch];
  if(!artifact)throw Error('Unsupported platform; use a supported x64 / macOS ARM64 machine.');
  await mkdir(dir,{recursive:true});let blender=o.blender;
  if(!blender){const install=join(dir,'blender-'+lock.blender),archive=join(dir,artifact.file);blender=process.platform==='win32'?join(install,'blender.exe'):process.platform==='darwin'?join(install,'Blender.app/Contents/MacOS/Blender'):join(install,'blender');
    if(!existsSync(blender)){console.log('Downloading verified Blender '+lock.blender+' portable package…');await download(lock.downloadBase+artifact.file,archive,artifact.sha256);
      const staging=join(dir,'extract-'+randomUUID());await mkdir(staging);
      if(process.platform==='win32')await run('powershell.exe',['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath $env:ASSET_ARCHIVE -DestinationPath $env:ASSET_STAGE'],{env:{ASSET_ARCHIVE:archive,ASSET_STAGE:staging}});
      else if(process.platform==='darwin'){const mount=join(staging,'mount');await mkdir(mount);await run('hdiutil',['attach',archive,'-nobrowse','-readonly','-mountpoint',mount]);try{await cp(join(mount,'Blender.app'),join(staging,'Blender.app'),{recursive:true});}finally{await run('hdiutil',['detach',mount]);}}
      else await run('tar',['-xJf',archive,'-C',staging]);
      const extracted=process.platform==='darwin'?staging:join(staging,artifact.file.replace(/\.(zip|tar\.xz)$/,''));
      await rename(extracted,install);}
  }
  const version=await run(blender,['--version'],{quiet:true});if(!version.startsWith('Blender '+lock.blender+' '))throw Error('Expected Blender '+lock.blender+'; got '+version.split('\n')[0]);
  const basePython=await bundledPython(blender),venv=join(dir,'venv'),python=join(venv,process.platform==='win32'?'Scripts/python.exe':'bin/python');
  if(!existsSync(python))await run(basePython,['-m','venv',venv],{env:cleanEnv});
  const pythonVersion=(await run(python,['-c','import sys; print("%d.%d"%sys.version_info[:2])'],{env:cleanEnv,quiet:true})).trim();if(pythonVersion!==lock.python)throw Error('Expected Python '+lock.python+'; use a new --tools directory.');
  // Only downloads/wheel installation are retried; DCC, task starts and publishes are never replayed.
  await retry(()=>run(python,['-m','pip','install','--require-hashes','--only-binary=:all:','--retries','0','--timeout','60','--index-url','https://pypi.org/simple','-r',requirements],{env:cleanEnv}).catch(e=>{if(!/connection|timed? ?out|temporary failure|network|remote end|proxyerror|sslerror|429|503/i.test(e.message))e.permanent=true;throw e;}));
  const site=(await run(python,['-c','import sysconfig; print(sysconfig.get_path("purelib"))'],{env:cleanEnv,quiet:true})).trim();
  const config={schema:'agent-relay.asset-tools/1',blender,python,pythonPaths:[site],discoveryScript:join(root,'scripts/discover-studio-tools.mjs'),requirementsHash:await hash(requirements),toolchainHash:await hash(lockPath)};
  await save(join(dir,'local.json'),config);
  // Doctor must pass before publishing a ready-to-use Studio configuration.
  await doctor(o,config);await save(join(dir,'studio-toolchain.json'),{blender,python,pythonPaths:[site],discoveryScript:config.discoveryScript});
  console.log('Ready: '+join(dir,'studio-toolchain.json')+'\nNext: npm run assets:demo');return config;
}
async function doctor(o,cfg){
  cfg??=await json(join(o.tools??defaults,'local.json'));
  if(cfg.requirementsHash!==await hash(requirements)||cfg.toolchainHash!==await hash(lockPath))throw Error('Tool lock changed. Run assets:setup again.');
  const version=await run(cfg.blender,['--version'],{quiet:true});const lock=await json(lockPath);if(!version.startsWith('Blender '+lock.blender+' '))throw Error('Blender version changed; rerun setup.');
  const args=[cfg.discoveryScript,'--project',o.project??root,'--blender',cfg.blender,'--python',cfg.python,'--needs','blender,python,numpy,scipy,PIL,xatlas,shapely'];for(const p of cfg.pythonPaths)args.push('--python-path',p);if(o.engine)args.push('--engine',o.engine,'--needs','engine');
  const report=JSON.parse(await run(process.execPath,args,{env:cleanEnv,quiet:true}));
  if(!report.python.version.startsWith(lock.python+'.'))throw Error('Python version changed; rerun setup.');
  const probe=await run(cfg.python,['-c','import json,importlib.metadata as m,imageio_ffmpeg; print(json.dumps({"versions":{n:m.version(n) for n in ["numpy","scipy","Pillow","xatlas","shapely","imageio-ffmpeg"]},"ffmpeg":imageio_ffmpeg.get_ffmpeg_exe()}))'],{env:{...cleanEnv,PYTHONPATH:cfg.pythonPaths.join(delimiter)},quiet:true});
  const {versions,ffmpeg}=JSON.parse(probe),locked=await readFile(requirements,'utf8');for(const [n,v] of Object.entries(versions))if(!locked.includes(n+'=='+v+' '))throw Error('Dependency version changed: '+n+' '+v);
  await run(ffmpeg,['-version'],{quiet:true});Object.assign(report,{versions,ffmpeg});await save(join(o.tools??defaults,'doctor.json'),report);console.log('Asset tools ready: Blender '+lock.blender+', Python dependencies and FFmpeg verified.');return {...cfg,ffmpeg};
}
export async function main(args=process.argv.slice(2)){
  const o=parse(args);if(o.command==='help'){console.log('assets: setup | doctor | demo | run --script model.py --out DIR -- [script args] | project --project WORKTREE --engine EXE -- build|image|intake|publish [project pipeline args]\nOptions: --tools DIR, setup --blender EXE (reuse explicit Blender installation)\nNo credentials, production assets or server settings are copied.');return;}
  if(o.command==='setup')return setup(o);
  const cfg=await doctor(o);if(o.command==='doctor')return;
  const env={...cleanEnv,PYTHONPATH:cfg.pythonPaths.join(delimiter),BLENDER_EXE:cfg.blender,PYTHON_EXE:cfg.python,...o.engine?{GODOT_EXE:o.engine}:{}};
  if(o.command==='project'){
    if(!o.project)throw Error('project requires --project WORKTREE.');
    const candidates=[join(o.project,'tools/unified_asset_pipeline.py'),join(o.project,'project/tools/unified_asset_pipeline.py')],script=candidates.find(existsSync);if(!script)throw Error('tools/unified_asset_pipeline.py is not in the selected project.');
    const [operation,...forward]=o.args;if(!['build','image','intake','publish'].includes(operation))throw Error('Expected project operation after --: build, image, intake or publish.');
    if(forward.some(a=>/^--(godot|blender)(=|$)/i.test(a)))throw Error('Use top-level --engine / --tools for executable paths.');
    if(['build','image'].includes(operation)&&!o.engine)throw Error('Project build/image requires --engine CUSTOM_ENGINE; official Godot is not substituted.');
    const managed=['build','image'].includes(operation)?['--godot',o.engine,...operation==='image'?['--blender',cfg.blender]:[]]:[];
    await run(cfg.python,[script,operation,...managed,...forward],{env,cwd:resolve(dirname(script),'..')});return;
  }
  if(o.command==='run'&&!o.script)throw Error('run requires --script model.py');
  const out=o.out??(o.command==='demo'?join(root,'.data/asset-output','demo-'+Date.now()):undefined);if(!out)throw Error('run requires --out DIR');
  // An output directory is one immutable execution receipt, never silently overwritten.
  await mkdir(dirname(out),{recursive:true});await mkdir(out);
  const script=o.command==='demo'?join(root,'tools/asset-pipeline/demo.py'):o.script;
  console.log('Running Blender; full log: '+join(out,'blender.log'));
  await run(cfg.blender,['--background','--factory-startup','--python-use-system-env','--python-exit-code','1','--python',script,'--','--out',out,...o.args],{env,cwd:out,quiet:true,logFile:join(out,'blender.log')});
  if(o.command==='demo')await run(cfg.python,[join(root,'tools/asset-pipeline/verify.py'),'--out',out],{env,cwd:out});
  const helpers=o.command==='demo'?Object.fromEntries(await Promise.all(['unwrap.py','verify.py'].map(async name=>[name,await hash(join(root,'tools/asset-pipeline',name))]))):undefined;
  await save(join(out,'execution.json'),{script,scriptHash:await hash(script),helperHashes:helpers,runnerHash:await hash(fileURLToPath(import.meta.url)),blender:cfg.blender,python:cfg.python,toolchainHash:cfg.toolchainHash,requirementsHash:cfg.requirementsHash,output:out,at:new Date().toISOString(),acceptance:'DCC output only; project import, receiver coverage, visual approval and gameplay QA are separate.'});console.log('Local output: '+out);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error('Asset pipeline failed: '+e.message);process.exitCode=1;});
