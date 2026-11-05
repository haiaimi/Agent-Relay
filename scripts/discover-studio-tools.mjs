// Read-only inventory. Does not install tools, update builds or write project files.
import {existsSync,statSync,readdirSync,readFileSync} from 'node:fs';
import {resolve,join,delimiter,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const flags={pythonPaths:[],searchRoots:[],needs:[]},names={'--project':'project','--source':'source','--blender':'blender','--python':'python','--engine':'engine','--python-path':'pythonPaths','--search-root':'searchRoots','--needs':'needs','--toolchain':'toolchain'};
for(let i=2;i<process.argv.length;i++){const key=names[process.argv[i]],value=process.argv[++i];if(!key||!value||/[\0\r\n]/.test(value))throw Error('Invalid tool inventory argument');if(Array.isArray(flags[key]))flags[key].push(...(key==='needs'?value.split(','): [value]));else flags[key]=value;}
// Machine paths are generated locally, never copied from another host or committed.
const localConfig=flags.toolchain?resolve(flags.toolchain):fileURLToPath(new URL('../.data/asset-tools/studio-toolchain.json',import.meta.url));
if(flags.toolchain||existsSync(localConfig)){const cfg=JSON.parse(readFileSync(localConfig,'utf8'));for(const k of ['blender','python','engine'])flags[k]??=process.env[{blender:'BLENDER_EXE',python:'PYTHON_EXE',engine:'GODOT_EXE'}[k]]||cfg[k];if(!flags.pythonPaths.length&&flags.python===cfg.python)flags.pythonPaths.push(...(cfg.pythonPaths??[]));flags.searchRoots.push(...(cfg.searchRoots??[]));}
const project=resolve(flags.project??process.cwd()),source=flags.source?resolve(flags.source):undefined;
const file=p=>{try{return !!p&&statSync(p).isFile();}catch{return false;}},dir=p=>{try{return !!p&&statSync(p).isDirectory();}catch{return false;}};
const unique=values=>[...new Set(values.filter(Boolean))],roots=unique([project,join(project,'project'),source,source&&join(source,'project'),...flags.searchRoots.map(p=>resolve(p))]);
const paths=unique([...(process.env.PATH??'').split(delimiter)]),findOnPath=name=>paths.flatMap(p=>process.platform==='win32'?[join(p,name+'.exe'),join(p,name)]:[join(p,name)]).find(file);
const absolute=p=>p&&(isAbsolute(p)?p:resolve(project,p));
const run=(exe,args,env=process.env)=>{try{const result=spawnSync(exe,args,{env,encoding:'utf8',timeout:10000,maxBuffer:256*1024,windowsHide:true,shell:false});return {ok:!result.error&&result.status===0,status:result.status,output:((result.stdout??'')+(result.stderr??'')).trim().slice(0,8000),error:result.error?.message};}catch(error){return {ok:false,error:error.message};}};
const search=[];for(const root of roots){for(const base of [root,join(root,'captures','asset-pipeline-dcc'),join(root,'asset-pipeline-dcc')]){search.push(base);if(!dir(base))continue;if(file(join(base,'blender.exe')))search.push(join(base,'blender.exe'));for(const entry of readdirSync(base,{withFileTypes:true}).slice(0,200)){if(entry.isDirectory()&&/^blender[- ]/i.test(entry.name))search.push(join(base,entry.name,'blender.exe'));}}}
if(process.platform==='win32')for(const base of [join(process.env.ProgramFiles??'C:/Program Files','Blender Foundation'),join(process.env.LOCALAPPDATA??'C:/Users/Default/AppData/Local','Programs','Blender Foundation')]){search.push(base);if(dir(base))for(const entry of readdirSync(base,{withFileTypes:true}).slice(0,100))if(entry.isDirectory())search.push(join(base,entry.name,'blender.exe'));}
const blenderCandidates=unique([absolute(flags.blender),process.env.BLENDER_EXE,findOnPath('blender'),...search.filter(p=>/blender\.exe$/i.test(p))]),blender=flags.blender?(file(absolute(flags.blender))?absolute(flags.blender):undefined):blenderCandidates.find(file);
const python=absolute(flags.python)||process.env.PYTHON_EXE||findOnPath('python')||findOnPath('python3'),pythonPaths=unique([...flags.pythonPaths.map(absolute),...roots.map(p=>join(p,'captures','asset-pipeline-deps')),...(process.env.PYTHONPATH??'').split(delimiter)]).filter(dir);
const pythonCode=`import sys,json,importlib
modules={}; errors={}; versions={}
for name in ['numpy','scipy','PIL','xatlas','shapely']:
 try:
  value=importlib.import_module(name); modules[name]=True; versions[name]={'version':getattr(value,'__version__',None),'file':getattr(value,'__file__',None)}
 except Exception as error:
  modules[name]=False; errors[name]=str(error)
print(json.dumps({'executable':sys.executable,'version':sys.version,'modules':modules,'moduleErrors':errors,'moduleVersions':versions}))`;
const pythonProbe=python?run(python,['-c',pythonCode],{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONPATH:pythonPaths.join(delimiter)}):{ok:false,error:'Python not located'};
let pythonInfo={};if(pythonProbe.ok)try{pythonInfo=JSON.parse(pythonProbe.output);}catch{pythonProbe.ok=false;}
const engineCandidates=unique([absolute(flags.engine),process.env.GODOT_EXE,...roots.flatMap(p=>[join(p,'engine','bin','godot_lightgame_voxel_latest.windows.editor.x86_64.console.exe'),join(p,'..','engine','bin','godot_lightgame_voxel_latest.windows.editor.x86_64.console.exe')])]),engine=flags.engine?(file(absolute(flags.engine))?absolute(flags.engine):undefined):engineCandidates.find(file);
const blenderProbe=blender?run(blender,['--version']):{ok:false,error:'Not found within listed locations'},engineProbe=engine?run(engine,['--version']):{ok:false,error:'Engine candidate not located'};
const available={blender:!!blenderProbe.ok,python:!!pythonProbe.ok,engine:!!engineProbe.ok,...pythonInfo.modules},unknown=flags.needs.filter(n=>!['blender','python','engine','numpy','scipy','PIL','xatlas','shapely'].includes(n));if(unknown.length)throw Error('Unknown required tool: '+unknown.join(', '));
const blockers=unique(flags.needs).filter(n=>!available[n]).map(name=>({category:'environment',code:'MISSING_'+name.toUpperCase(),details:'Required capability unavailable in this inventory: '+name,remedy:'Configure the correct executable or project dependency directory and rerun the same inventory.'}));
console.log(JSON.stringify({schema:'agent-relay.toolchain/1',checkedAt:new Date().toISOString(),project,source,scope:'Configured paths, named project/source caches, PATH and common install directories; no whole-disk scan',searchedRoots:roots,blender:{path:blender,candidates:blenderCandidates,...blenderProbe},python:{path:python,pythonPaths,...pythonInfo,...pythonProbe},engine:{path:engine,sha256:engine?createHash('sha256').update(readFileSync(engine)).digest('hex'):undefined,provenance:'not-validated',...engineProbe},requirements:flags.needs,blockers,passed:blockers.length===0,acceptance:'Tool availability only; not asset, runtime, visual or release acceptance'},null,2));
process.exitCode=blockers.length?2:0;
