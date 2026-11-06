# 功能验证场景与本机一键启动

`functional-test` 是独立可选制作环节，位于程序实现之后、正式场景搭建及整合之前。默认完整场景及程序模板包含该环节；自定义模板可单独选择。由程序职能复用已完成角色、控制器、相机和交互，在白模地面、坡道、台阶、障碍和交互目标中提供真实输入、重置和操作说明。不能另造一套演示玩法，不将素材或视频预览当成可操作场景，不以正式场景 GI 观感阻断白模操作验证。

现有需求可点击“补建功能白模与双启动入口”。系统等待当前任务/交付会话结束，追加该环节，保留原角色、资产、程序结果和审批设置；旧交付进入 `deliveryHistory`，新结果完成后重新汇总、按原 final 设置验收。重复请求不重复建任务，不中断正在执行的 Agent。

可玩交付在 `STUDIO_RESULT` 提供 `launchers`：

```json
{"launchers":[{"id":"functional","kind":"functional","title":"功能白模测试","script":"project/Play-Functional.ps1","cwd":".","scene":"res://tests/functional.tscn","controls":"填写实际输入与重置方式"},{"id":"game","kind":"game","title":"真实游戏场景","script":"project/Play-Game.ps1","cwd":".","scene":"实际游戏入口","controls":"填写实际输入"}]}
```

仅登记实际存在、核实并启动过的脚本。Windows 支持 ps1/bat/cmd，macOS/Linux 使用 sh。脚本以本需求 worktree 相对路径登记，游戏窗口可见；脚本保持运行到游戏退出，日志写本副本。引擎来源和参数沿用项目真实启动方式，不能切到源工程、旧默认场景或其他需求。功能验证任务至少必须提供 functional 入口；同时核对并交付真实游戏入口，有缺口如实说明。

网页按钮调用已登录的 `POST /api/studio/playtests/start`，只提交请求 ID、需求 ID 和已登记入口 ID。服务器核对任务交付和设备绑定，通过独立 launcher 连接发送结构化操作；不执行服务器命令，不接收浏览器任意 shell 文本，不运行游戏或存储视频。`GET /api/studio/playtests` 查询入口，`GET /api/studio/playtests/status` 核对启动回执。通用 `/api/actions` 拒绝启动操作，避免绕过登记入口。

工作电脑的 launcher 使用独立 `launcher.sqlite` 和 `launcher.lock`，从主连接程序只读核对需求工作副本，不创建或接管 Agent 会话。启动前校验分支、真实路径和脚本 SHA-256，拒绝源目录、越界链接、错误设备和变化的脚本；按请求 ID 记账，同入口已有进程时复用，不重复启动。不确定回执只查状态，不自动重发。工作副本仍在写入时不启动试玩。

Windows 安装：先构建，再执行 `scripts/install-launcher-service.ps1 -ConfigPath bridge.config.json`。已有 `install-background-service.ps1` 会同时安装 launcher。它以当前交互用户的计划任务运行，独立于 Codex/Claude 桌面窗口；安装/启动它不会重启正在制作的主 Bridge。服务配置位置记录在 `.data/launcher-service.json`，保留其中指向的运行目录，不能作为普通缓存删除。macOS/Linux 可用 `node --env-file-if-exists=.env dist/bridge/launcher-main.js bridge.config.json` 启动，并按设备既有进程管理方式常驻。凭据仍来自本机 `.env`，不写到启动请求或日志中。

启动脚本收到 `AGENT_RELAY_LAUNCH_RECEIPT` 后，原子写 JSON：`{pid, workspace, scene, logPath, ready}`。workspace 是当前 worktree 绝对路径，scene 必须是实际加载场景，pid 是游戏进程；仅真实加载就绪后设置 ready=true。没有回执时网页只显示脚本已启动，不宣称游戏已加载；进程结束、错误场景、错误工作副本或脚本异常会如实显示。脚本/游戏/视频留在工作电脑，服务器仅中转控制和已有视频读取。
