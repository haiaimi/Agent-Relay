export interface StudioToolchain {blender?:string;python?:string;engine?:string;discoveryScript?:string;pythonPaths?:string[];searchRoots?:string[]}
export interface StudioBlocker {category:'environment'|'provenance'|'upstream'|'quality'|'other';code:string;details:string;remedy:string}
export function validateToolchain(value:unknown):StudioToolchain|undefined{
  if(value===undefined)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('无效团队工具配置');
  const source=value as Record<string,unknown>,result:Record<string,unknown>={};
  const path=(v:unknown)=>{if(typeof v!=='string'||v.length>1000||/[\x00\r\n]/.test(v))throw Error('工具路径无效');return v.trim();};
  for(const key of ['blender','python','engine','discoveryScript'])if(source[key]!==undefined){const v=path(source[key]);if(v)result[key]=v;}
  for(const key of ['pythonPaths','searchRoots'])if(source[key]!==undefined){const values=source[key];if(!Array.isArray(values)||values.length>6)throw Error('工具目录最多 6 项');result[key]=[...new Set(values.map(path).filter(Boolean))];}
  if(JSON.stringify(result).length>4000)throw Error('团队工具配置过长');return result;
}
export function validateBlockers(value:unknown):StudioBlocker[]{
  if(value===undefined)return [];if(!Array.isArray(value)||value.length>12)throw Error('阻断记录格式无效');
  return value.map(item=>{if(!item||!['environment','provenance','upstream','quality','other'].includes(item.category)||typeof item.code!=='string'||!/^[A-Z0-9_-]{1,60}$/.test(item.code)||typeof item.details!=='string'||!item.details.trim()||item.details.length>2000||typeof item.remedy!=='string'||!item.remedy.trim()||item.remedy.length>2000)throw Error('阻断记录需包含类别、代码、实际证据和恢复步骤');return {category:item.category,code:item.code,details:item.details,remedy:item.remedy};});
}
export function toolchainInstructions(config:StudioToolchain|undefined,workspace:string,source:string){
  const argv=['node',config?.discoveryScript??'<本机 Agent Relay 目录>/scripts/discover-studio-tools.mjs','--project',workspace,'--source',source];
  for(const [key,flag] of [['blender','--blender'],['python','--python'],['engine','--engine']] as const)if(config?.[key])argv.push(flag,config[key]!);
  for(const path of config?.pythonPaths??[])argv.push('--python-path',path);
  for(const path of config?.searchRoots??[])argv.push('--search-root',path);
  return `\n团队共享工具环境（所有职能共用）：${JSON.stringify(config??{})}\n开工先做只读工具预检，查看 rendering 字段的配置证据；runtimeVerified=false 时继续核对真实命令与日志，不能当作运行通过。已配置探测脚本时按参数数组执行：${JSON.stringify(argv)}；未配置时依次查团队路径、工程启动器/管线配置、工作副本工具缓存、源工程工具缓存（只读）、PATH/安装目录。captures 未复制不表示工具不存在；便携 DCC、Python 和依赖可使用已核对的外部绝对路径，不复制整个 captures。源工程仅允许读取工具配置/缓存或执行共享工具二进制，严禁修改源工程、源资产或源引擎；所有输出写当前工作副本。\n工具存在、版本可用和生产验收是三件事。用实际 Python 解释器与本次命令的 PYTHONPATH 检查 xatlas/shapely 等依赖；不能只检查默认 python。缺失时先查工程专用环境，禁止自动全局安装或偷偷换官方引擎。\n按本次实际操作确定依赖：纯复用且几何/UV/材质未变，不因没有新建/重导出而强制跑 DCC 或重烘焙；但实际路径适用的验收缺口（冷加载、依赖完整性等）仍须补验；UV2/receiver 仅在实际启用对应 Lightmap 接收路径时补验，无 receiver 的 Voxel 不强制解包或重烘，不能把复用当作验收通过。源文件重建、导出或重烘焙确有需要时才要求对应 DCC/依赖。\n引擎哈希不符要定位记录属于哪次构建，核对当前工作副本启动器与最新程序交付。不要用 --version 代替构建来源验证，也不要修改历史记录冒充匹配；允许只读隔离诊断，但生产/发布门禁仍需真实来源证据。哈希变化按文件责任和阶段区分：上游程序已完成后的合法改动与资产未经授权变化不同；使用任务启动时的最新上游交付作基线，不拿过期资产规格快照误判全部文件。保存核对差异和证据，不擅自回滚。\n仍阻断时在 STUDIO_RESULT 追加 blockers 数组，每项提供 category(environment/provenance/upstream/quality/other)、code、details（具体路径、解释器、搜索范围或哈希证据）和 remedy（可执行恢复步骤）；非本阶段必需工具列提示，不作为硬阻断。缺工具应表述为已检查范围内未找到，不能断言未安装。\n`;
}
