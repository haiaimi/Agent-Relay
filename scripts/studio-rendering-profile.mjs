import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
// Configuration evidence only. Never infer the launched path from a source cache.
export function renderingProfile(workspace){
  const result={configuredDefault:'unknown',runtimeVerified:false,evidence:[],note:'核对实际命令、覆盖参数和运行日志后决定验收适用性；本清单不代表运行验收通过。'};
  for(const root of [resolve(workspace),join(resolve(workspace),'project')]){
    const preset=join(root,'config/default_voxel_flags.json'),launcher=join(root,'tools/run_main.py');
    try{
      const bytes=readFileSync(preset),flags=JSON.parse(bytes),launchBytes=readFileSync(launcher),launch=launchBytes.toString();
      if(!Array.isArray(flags)||!flags.every(f=>typeof f==='string'))throw Error('preset must be an array of flags');
      result.evidence.push(...[[preset,bytes],[launcher,launchBytes]].map(([path,data])=>({path,sha256:createHash('sha256').update(data).digest('hex')})));
      if(/add_argument\(["']--gi-preset["'][^\n]*default=["']voxel["']/.test(launch)&&flags.includes('--surfel-voxel-cache')&&flags.includes('--surfel-gpu-hierarchy')){
        result.configuredDefault='voxel-no-receiver';result.note+=' 当前配置为无 receiver 的 Voxel，历史 UV2/Lightmap/receiver 检查不自动作为门禁；真实画质与性能仍须验证。';
      }
      return result;
    }catch(error){if(error.code!=='ENOENT'){result.error=error.message;return result;}}
  }
  return result;
}
