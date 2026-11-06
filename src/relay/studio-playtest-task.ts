import type {Task} from './studio.js';
export function functionalTestTask():Task{return {
 id:'studio-functional-test',title:'可操作的功能白模测试场景与双启动入口',role:'engineering',stage:'functional-test',status:'queued',dependencies:[],
 brief:`复用已经实现的真实角色、控制器、相机和交互逻辑，制作独立可操作的功能测试场景，不能另做一套简化玩法或用动画视频冒充操控。3C/角色需求使用白模地面、坡道、台阶、障碍、镜头遮挡和实际交互装置；放置本次角色，支持玩家键鼠/现有手柄输入、移动转向、已有动作、相机和交互，提供重置与屏幕操作说明。只测试已有功能，不新增角色技能或无关关卡。用简单稳定光照，避免正式场景美术、专项 GI 观感阻断功能测试。
另核对本需求真实游戏入口，复用实际新角色开关和指定场景。为功能白模、真实游戏分别交付工作副本内的启动脚本（Windows 优先 ps1，其他设备 sh），标明实际场景、工作目录和输入方式；不可用旧场景、素材预览或截图冒充真实游戏。
脚本核对并复用正确引擎/启动器与原工程参数，游戏窗口应可见。脚本保持运行直到游戏退出，避免一键启动产生重复游戏进程。若 AGENT_RELAY_LAUNCH_RECEIPT 环境变量存在，原子写 JSON 到该路径，包含实际游戏 pid、workspace（当前 worktree 绝对路径）、scene（实际加载场景）、logPath、ready（只有真实加载就绪才 true）；进程存在本身不是就绪。保留 stdout/stderr 或引擎日志于本副本。不能修改源工程或模型凭据。
实际启动并手动/输入回放验证白模交互和真实入口，记录实际场景/PID/操作/结果，提供截图；若要求展示视频，录制真实操作片段并保存在工作电脑。STUDIO_RESULT 中追加 launchers 数组：[{"id":"functional","kind":"functional","title":"功能白模测试","script":"project/Play-Functional-Test.ps1","cwd":".","scene":"实际场景路径","controls":"真实操作说明"},{"id":"game","kind":"game","title":"真实游戏场景","script":"project/Play-Game.ps1","cwd":".","scene":"实际场景路径","controls":"真实操作说明"}]。所有路径按实际文件填写，脚本也列入 artifacts。启动脚本用于用户主动本机试玩，不自动发布或推送。`,
 acceptance:'白模内可实际操作本需求真实角色与控制功能；复用同一套实现。交付功能白模与实际游戏的启动脚本、准确场景和操作说明，记录真实加载及输入测试；功能白模入口必须实际存在，失败如实记录，不冒充通过。'
};}
export const launcherInstructions=`\n交付可玩场景时同时提供 launchers 数组，区分 kind=functional（独立可操作功能白模）和 kind=game（实际游戏入口）。每项含 id、title、工作副本相对 script/cwd、真实 scene、controls。仅登记已核实并实际启动过的脚本，不将素材/视频预览标为游戏。没有某类入口时如实说明，不编造。用户在网页点击启动后，Relay 只通知该工作电脑执行已登记脚本，服务器不运行游戏。\n`;
