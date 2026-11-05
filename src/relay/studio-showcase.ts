import type {Task} from './studio.js';
export const videoPath=(path:string)=>/\.(mp4|webm|mov|m4v)$/i.test(path);
export function withShowcase(tasks:Task[],supplemental=false):Task[]{
  if(tasks.some(t=>t.showcase))return tasks;
  const owner=[...tasks].reverse().find(t=>!t.kind&&t.role!=='qa');if(!owner)throw Error('没有可录制展示的制作任务');
  const downstream=supplemental?[]:tasks.filter(t=>t.role==='qa'||t.reviewType==='scene'||owner.stage==='concept'&&t.kind==='visual-review');
  const capture:Task={id:'studio-showcase',showcase:true,title:'录制成果展示视频',role:owner.role,stage:owner.stage,status:'queued',dependencies:tasks.filter(t=>!downstream.includes(t)).map(t=>t.id),brief:'仅展示本需求已经完成的真实成果，不扩大制作范围，不修改已确认设计、正式资产或引擎。视觉方案可录制并明确标注静态方案轮播；模型/材质成果用真实资产在 Blender 中做转台、巡览或视口录制；已完成关卡录制实际运行，不用静态图片冒充游戏运行。复用已有工具，优先输出 10–60 秒、720p 或以上、H.264/yuv420p/faststart 的 MP4。视频保存到当前工作副本 .studio/本需求/studio-showcase/，不上传视频到服务器，不把视频嵌入消息或列为图片。只在 STUDIO_RESULT.artifacts 中声明视频相对路径，记录工具、录制命令、时长、尺寸和实际 ffprobe/播放验证。工具缺失如实 blocked。',acceptance:'视频真实存在且可播放，内容与本需求成果一致，来源和展示方式如实标注；artifacts 至少包含一份视频，checks 提供实际验证；不提交、推送或发布。'};
  const first=tasks.findIndex(t=>downstream.includes(t)),result=[...tasks];result.splice(first<0?tasks.length:first,0,capture);for(const t of downstream)t.dependencies=[...new Set([...t.dependencies,capture.id])];return result;
}
