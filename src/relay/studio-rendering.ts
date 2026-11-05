// Applies to planning, new tasks and replies to old task sessions alike.
export const renderingInstructions=`
渲染验收适用性（优先于历史任务中的通用 UV2/receiver 要求）：
开工先读当前工作副本的 AGENTS.md、project/AGENTS.md 和当前 GI 指南，核对实际启动器、预设文件、显式覆盖参数、引擎及运行日志；不能仅按任务标题、旧报告或“Surfel/Mesh Cell”名称判断当前渲染路径。主干的新默认不自动证明旧副本已迁移，禁止偷偷切换副本或更改预设。
若实际使用无 receiver 的 Voxel 路径，UV2/Lightmap 图集、receiver 覆盖和 xatlas 解包不是其运行验收门禁；历史要求记为“不适用”，注明预设/参数/日志证据，不因旧文件缺 UV2 或旧 receiver 报告失败而阻断，也不为了消除旧报告强制重烘。Surfel 仍可能用于 Voxel 的追踪与光照，不等于依赖 UV2。只有明确运行 Lightmap/UV2 receiver 路径或本阶段确需解包/导出时才要求对应检查和工具。
路径未知或配置与日志冲突时只读核对并给出可执行恢复步骤，不能猜测通过。每项报告区分 PASS、FAIL、未执行与不适用；撤销旧阻断须保留原记录和撤销理由，不把不适用写成实测通过。冷加载、资源依赖、实际新场景、光照/材质质量、玩法与同条件 CPU/GPU 性能仍按实际结果验收，不能因 Voxel 绕过真实失败。
发现前置任务的缺陷不能要求尚依赖本任务的下游先修复，否则会形成流程死锁。当前职能只处理自身权限内的修复；超出责任时明确责任任务、文件与最小修复方案并请求制作人指引，不擅自跳过、伪造完成或突破审批。制作人当前阶段的最新补充优先于冲突的历史说明，所选审批节点仍需明确确认。
`;
