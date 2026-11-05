import {randomUUID} from 'node:crypto';
import {mkdirSync,realpathSync,writeFileSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {createSdkMcpServer,tool} from '@anthropic-ai/claude-agent-sdk';
import {z} from 'zod';
import {CodexRpc} from './codex.js';
import {messageImages} from './media.js';
import type {BridgeStore} from './store.js';
import type {MediaStore} from '../shared/media.js';
import type {Message,Project,Session} from '../shared/protocol.js';

export const brainProject=/^brainstorm-[a-f0-9-]{36}$/i;
export function prepareBrainstorm(store:BridgeStore,dataDir:string,id:string,source?:string):Project{
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))throw Error('无效讨论 ID');
  const parent=resolve(dataDir,'brainstorms');mkdirSync(parent,{recursive:true});const path=join(realpathSync.native(parent),id);mkdirSync(path,{recursive:true});
  if(realpathSync.native(path)!==path)throw Error('讨论目录不能是链接');
  store.db.exec('CREATE TABLE IF NOT EXISTS brainstorm_sources(id TEXT PRIMARY KEY,path TEXT NOT NULL)');
  if(source){source=realpathSync.native(source);const old=store.db.prepare('SELECT path FROM brainstorm_sources WHERE id=?').get('brainstorm-'+id);if(old&&old.path!==source)throw Error('讨论绑定的项目组工程已变化');store.db.prepare('INSERT OR IGNORE INTO brainstorm_sources VALUES(?,?)').run('brainstorm-'+id,source);}
  const project:Project={id:'brainstorm-'+id,name:'头脑风暴 · '+id.slice(0,8),path,roots:[path],source:'configured'};store.saveProject(project);return project;
}
export const brainstormInstructions=`你是独立的游戏头脑风暴部门，由 Claude 担任设计讨论伙伴。先使用 project_context 只读了解本项目组的工程说明、已有玩法与关卡结构，再结合当前项目组上下文设计。回答可用 Markdown 表格、\`\`\`mermaid 流程图和 \`\`\`svg 示意图（代码围栏）；SVG/图表仅是设计示意，不得冒充原画。和制作人用中文讨论玩法、画面、关卡、系统与体验，提出可比较的方案，保留未知事项。当前目录仅用于讨论资料，禁止修改游戏工程、启动制作、提交代码或发布内容。
需要参考图时，必须调用 mcp__brainstorm__generate_image 委托本机 Codex 的原生 image_generation 工具，不能以 SVG、HTML、代码绘图或占位图冒充生成图，也不要调用付费 API 或要求 API key。生成失败应明确说明。参考图只用于讨论，不等于制作人的原画批准。
制作人认可方向，或请你整理可执行方案时，调用 mcp__brainstorm__propose_task，整理需求名称、完整范围、验收标准与制作流程。可附生成工具返回的 image_ids（最多 5 张）。系统将显示“发起制作任务”按钮；只有制作人点击该按钮才会执行。不要声称已经创建任务。涉及场景、关卡、资产或画面制作时选 scene-new，纯代码配置用 general，其余 auto。`;

// A separate native thread owns each image request. Only actual imageGeneration
// items are accepted; quoted paths, viewed files and generated code are not proof.
export async function codexBrainstormImage(options:{command:string;args?:string[];session:Session;media:MediaStore;prompt:string;signal:AbortSignal;publish:(m:Message)=>void;rpc?:CodexRpc;timeoutMs?:number}){
  const {session,media,signal,publish}=options,rpc=options.rpc??new CodexRpc(options.command,[...(options.args??[]),'-c','features.image_generation=true','-c','features.shell_tool=false']);
  let threadId='',turnId='',finish!:(e?:Error)=>void;const images=new Map<string,NonNullable<Message['images']>[number]>();
  const completed=new Promise<void>((resolveResult,reject)=>{finish=e=>e?reject(e):resolveResult();});
  // Install the rejection handler before asynchronous initialization can fail.
  void completed.catch(()=>{});
  const abort=()=>{if(threadId&&turnId)void rpc.call('turn/interrupt',{threadId,turnId}).catch(()=>{});finish(Error('参考图生成已停止'));};
  const timer=setTimeout(()=>finish(Error('Codex 生成参考图超时，请检查本机账号和图片工具；未自动重试')),options.timeoutMs??600_000);
  const failure=(e:Error)=>finish(e);
  rpc.on('failure',failure);rpc.on('protocolError',failure);
  rpc.on('notification',(msg:any)=>{
    const p=msg.params??{};if(msg.id!==undefined){rpc.send({id:msg.id,error:{code:-32601,message:'Brainstorm image delegate only permits native image generation'}});return;}
    if((p.threadId??p.thread?.id)!==threadId)return;
    if(msg.method==='turn/started')turnId=p.turn.id;
    if(msg.method==='item/completed'&&p.item?.type==='imageGeneration'){
      if(p.item.status==='failed'){finish(Error(p.item.failure?.message??'Codex 原生图片生成失败'));return;}
      const result=messageImages(media,session.id,session.cwd,{id:'brain-image:'+p.item.id,role:'assistant',label:'Codex · 参考图',text:''},p.item);
      for(const ref of result.images??[])if(ref.id){const saved=media.read(session.id,ref.id);if(!saved)continue;const name='reference-'+ref.id.slice(0,16)+'.'+(saved.mime==='image/jpeg'?'jpg':saved.mime.split('/')[1]);writeFileSync(join(session.cwd,name),saved.bytes);images.set(ref.id,{...ref,name});}
      if(images.size)publish({...result,images:[...images.values()]});
    }
    if(msg.method==='turn/completed')finish(p.turn.status==='completed'?undefined:Error(p.turn.error?.message??'Codex 参考图生成未完成'));
    if(msg.method==='error'&&p.willRetry!==true)finish(Error(p.error?.message??'Codex 参考图生成失败'));
  });
  signal.addEventListener('abort',abort,{once:true});
  try{
    if(signal.aborted)throw Error('参考图生成已停止');await rpc.start();if(signal.aborted)throw Error('参考图生成已停止');
    const result=await rpc.call('thread/start',{cwd:session.cwd,approvalPolicy:'never',sandbox:'workspace-write',ephemeral:true,developerInstructions:'Generate one reference image using the native image_generation tool. Do not use shell, scripts, SVG, file edits, web images, or an external API. If the image_generation tool is unavailable, explain that limitation and stop.'});threadId=result.thread.id;
    if(signal.aborted)throw Error('参考图生成已停止');
    const started=await rpc.call('turn/start',{threadId,input:[{type:'text',text:'请用原生 image_generation 工具生成一张游戏设计参考图：\n'+options.prompt,text_elements:[]} ]});turnId=started.turn.id;
    await completed;if(!images.size)throw Error('Codex 未返回实际生成图片。请检查本机 Codex 账号是否可使用原生 image_generation；未用代码或占位图替代');return [...images.values()];
  }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);rpc.close();}
}

export function readBrainstormProject(source:string,path='.',offset=0){
  const root=realpathSync.native(source),target=realpathSync.native(resolve(root,path)),rel=relative(root,target);if(rel.startsWith('..')||isAbsolute(rel))throw Error('只能读取本项目组的工程目录');
  if(statSync(target).isDirectory())return {path:rel||'.',entries:readdirSync(target,{withFileTypes:true}).filter(f=>!['.git','.data','node_modules','.godot','dist','build'].includes(f.name)&&!/^\.env(?:\.|$)/.test(f.name)).slice(0,160).map(f=>({name:f.name,directory:f.isDirectory()}))};
  const stat=statSync(target);if(!stat.isFile()||stat.size>2*1024*1024||/(?:^|[\\/])\.env(?:\.|$)/.test(rel))throw Error('文件不适合文本预览，请选择工程说明、场景或脚本');
  const bytes=readFileSync(target);if(bytes.includes(0))throw Error('这是二进制文件，不能作为文本读取');const content=bytes.toString('utf8');return {path:rel,text:content.slice(offset,offset+20000),nextOffset:offset+20000<content.length?offset+20000:null};
}
export function brainstormTools(session:Session,media:MediaStore,command:string,args:string[]|undefined,signal:AbortSignal,publish:(m:Message&{proposal?:unknown})=>void,store?:BridgeStore){
  const source=store?.db.prepare('SELECT path FROM brainstorm_sources WHERE id=?').get(session.projectId??'')?.path;
  return createSdkMcpServer({name:'brainstorm',version:'1.0.0',tools:[
    tool('project_context','只读查看所属项目组的源工程目录或文本文件，以项目实际内容设计；不能写入。',{path:z.string().max(2000).default('.'),offset:z.number().int().min(0).max(2000000).default(0)},async({path,offset})=>{
      try{if(!source)throw Error('项目组源工程尚未绑定');return {content:[{type:'text',text:JSON.stringify(readBrainstormProject(String(source),path,offset))}]};}catch(e){return {isError:true,content:[{type:'text',text:(e as Error).message}]};}
    }),
    tool('generate_image','委托本机 Codex 原生图片生成；返回并展示实际参考图。仅用于设计讨论。',{prompt:z.string().min(1).max(8000)},async({prompt})=>{
      publish({id:randomUUID(),role:'tool',label:'Claude → Codex',text:'委托 Codex 生成参考图：\n'+prompt});
      try{const images=await codexBrainstormImage({command,args,session,media,prompt,signal,publish});return {content:[{type:'text',text:JSON.stringify({image_ids:images.map(i=>i.id),message:'图片已发送给制作人。这些是讨论参考，尚未批准进入制作。'})},...images.map(ref=>{const value=media.read(session.id,ref.id!)!;return {type:'image' as const,mimeType:value.mime,data:value.bytes.toString('base64')};})]};}
      catch(e){const text=(e as Error).message;publish({id:randomUUID(),role:'system',label:'参考图生成失败',text});return {isError:true,content:[{type:'text',text}]};}
    }),
    tool('propose_task','整理可执行制作提案，显示制作人一键发起按钮；此工具本身不会启动制作。',{title:z.string().min(1).max(160),brief:z.string().min(1).max(9000),workflow:z.enum(['auto','scene-new','general']),image_ids:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(5).default([])},async proposal=>{
      const ids=[...new Set(proposal.image_ids)];for(const id of ids)if(!media.read(session.id,id))return {isError:true,content:[{type:'text',text:'参考图不属于本次讨论，请使用 generate_image 返回的图片 ID'}]};
      const id=randomUUID();publish({id:'brain-proposal:'+id,role:'assistant',label:'制作提案',text:proposal.title+'\n\n'+proposal.brief,proposal:{id,...proposal,image_ids:ids}});
      return {content:[{type:'text',text:'提案已显示，等待制作人点击“发起制作任务”。尚未启动制作。提案编号：'+id}]};
    })
  ]});
}
