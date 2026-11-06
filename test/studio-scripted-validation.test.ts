import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Studio,STUDIO_ROLES} from '../src/relay/studio.js';
import {MAX_TEXT} from '../src/shared/protocol.js';
import {scriptedValidationInstructions} from '../src/relay/studio-rendering.js';

// Exercise the actual prompt composer, including its old-session and size limits.
// No agents, game files, task state or external tools are executed.
const composer=Object.assign(Object.create(Studio.prototype),{
  execution:()=>({id:'work',path:'/qa/worktree'}),groupPosts:()=>[]
});
function prompt(id:string,role:string,resume=false,large=false){
  const task:any={id,role,title:'脚本玩法验证',brief:'旧计划：必须绑定访达后才能验收',acceptance:'移动、拾取、获胜和重置',dependencies:[],status:'queued',...resume?{resumeSessionId:'mac:qa',output:'旧记录'.repeat(large?20000:1)}:{}};
  const run:any={id:'run',title:'石柱试玩',brief:'实际运行保存证据',autoAnswerQuestions:false,tasks:[task],planner:{id:'studio-plan'},workspace:{status:'ready',value:{branch:'codex/studio-run',sourcePath:'/protected/source'}},guidance:[]};
  const project:any={roles:STUDIO_ROLES.map(([role])=>({role,enabled:true,provider:'codex',instructions:large?'旧职责'.repeat(18000):'',tools:''}))};
  return composer.prompt(run,task,project) as string;
}

test('script-first policy reaches planning and resumed QA even with autonomy disabled and long historical context',()=>{
  for(const text of [prompt('studio-plan','director'),prompt('task-4','qa'),prompt('task-4','qa',true,true)]){
    assert.ok(text.length<=MAX_TEXT);
    assert.ok(text.includes(scriptedValidationInstructions));
    assert.match(text,/优先于旧计划自行增加的 Computer Use 限制/);
    assert.match(text,/更换操作方式不等于延期或豁免业务验收/);
    assert.match(text,/自动化验证不能写成人工实测/);
    assert.match(text,/不上传为服务器持久媒体/);
  }
});
