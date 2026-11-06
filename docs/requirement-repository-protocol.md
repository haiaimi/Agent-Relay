# Relay 需求仓库协议 v1

本协议用于在另一台电脑正常 clone / pull 项目后，读取全部制作需求、进度、审批与公开上下文。它替代“必须在线迁移整台制作现场”的使用方式。一个项目对应一个 Git 仓库，一个需求对应一个稳定分支。保存不等于提交；只有制作人点击“同步需求”并选择采用本地版本，才提交并推送。

## 必须的位置

| 所在位置 | 路径 | 内容 |
| --- | --- | --- |
| 主干及需求分支 | `.relay/project.json` | 项目稳定 UUID、协议版本、显示名称；不含设备登录信息 |
| 主干 | `.relay/requirements.json` | 全项目轻量需求索引：需求 UUID、标题、分支、修订、状态、更新时间；已推送条目还含提交 ID 和存档 SHA-256 |
| `codex/studio-<需求 UUID>` | `.relay/requirements/<需求 UUID>.json` | 此需求的完整业务存档：制作要求、任务依赖、任务状态、审批、结果、公开会话、原机器媒体引用 |
| 需求分支 | `.studio/<需求 UUID>/<任务 ID>/` | Agent 产出的文本计划、规格、报告；正式游戏代码和资产沿用游戏工程自己的路径 |
| 原工作电脑 | 工程自己的 `captures/`、帧目录等 | 截图、过程录屏、渲染中间结果、缓存；不要求加入 Git |

项目根是 Git 仓库根；`projectRelative` 表示游戏工程目录相对于仓库根的位置，例如 `project`，仓库根本身则为空字符串。跨设备不得把源电脑绝对路径作为执行目录。

机器可读结构见 [requirement-archive-v1.schema.json](schemas/requirement-archive-v1.schema.json)。实现还会检查任务 ID 唯一性、依赖存在性、循环依赖、路径与体积限制，不能只通过 JSON Schema 就认为可以执行。

## 项目与索引

```json
{"version":1,"id":"11111111-1111-4111-8111-111111111111","name":"LightGame"}
```

```json
{
  "version": 1,
  "projectId": "11111111-1111-4111-8111-111111111111",
  "requirements": [{
    "id": "22222222-2222-4222-8222-222222222222",
    "title": "第一关",
    "branch": "codex/studio-22222222-2222-4222-8222-222222222222",
    "status": "executing",
    "revision": 12,
    "updatedAt": 1793923200000,
    "commit": "<Git commit ID>",
    "sha256": "<SHA-256 of compact JSON.stringify(archive)>"
  }]
}
```

索引只指向需求，不包含代码、图片、视频或整份对话。原工作目录的索引会本地自动更新；同步时从最新远程主干建立**只改变这两个元数据文件**的提交，不会把游戏需求分支整体合入主干，也不会改动用户当前主干的 HEAD、文件或暂存区。主干保护规则不允许直接推送时，同步失败并保留现场，不会强推或改用其他分支冒充成功。

## 需求存档

顶层必需字段：

| 字段 | 格式 / 意义 |
| --- | --- |
| `version` | 固定 `1`；未知版本拒绝加载 |
| `projectId`, `runId` | 项目、需求的稳定 UUID |
| `branch` | `codex/studio-<runId>`；本机恢复用的 worktree 分支可以带后缀，远程协议分支始终不变 |
| `projectRelative` | 游戏目录相对仓库根的位置 |
| `project` | 项目名称与职能分配配置，ID 必须等于 `projectId` |
| `run` | 需求标题、正文、生命周期、修订、时间、`planner`、`tasks`、可选 `delivery`、审批与过程记录；ID 必须等于 `runId` |
| `conversations` | 公开会话数组，见下文 |
| `media` | 原机器的媒体索引，见下文；不包含二进制或 Base64 |

`run.status`：`planning / plan-review / executing / delivery / review / accepted / cancelled`。

任务必需字段：`id, title, role, dependencies, status`。执行任务还保存 `brief, acceptance`，可保存 `summary, output, artifacts, checks, blockers, error`。任务状态为 `queued / starting / running / done / blocked / skipped / cancelled / awaiting-review`。审批保留 `kind, reviewId, approvedAt, visualSnapshots`；被跳过保留 `skip` 与原失败证据。历史通过、延期、失败与未执行不得混淆。

```json
{
  "sessionId": "source-host:codex:original-thread",
  "coverage": "relay-cached-public-messages",
  "messages": [{"id":"message-id","role":"user","text":"保留这个视觉方向","at":1793923200000}]
}
```

只持久化公开 `user / assistant` 消息和业务结果，不保存隐藏推理、原始工具调用、系统登录凭据或运行锁。`coverage` 明确表示 Relay 已缓存的公开内容，**不是原生客户端全量会话的承诺**。后续本地保存按会话 ID 和消息 ID 合并，避免把先前已保存的公开上下文丢掉。单份存档上限 12 MiB，超过限制明确报错，不静默截断成完整存档。

```json
{"hostId":"source-host","sessionId":"source-host:codex:original-thread","path":"captures/demo.mp4","description":"第一关实机演示"}
```

媒体引用记录原电脑和原会话可读取的路径。原电脑在线时通过认证 Relay 按需中转，视频按段传输，服务器不永久存视频。原电脑离线、媒体删除或全新 Relay 没有原设备会话时，应显示不可用；进度仍可读取。正式模型、纹理、场景等**运行所需资产**正常随需求分支同步，过程媒体不能代替正式资产。

## 保存与同步

1. Relay 每隔数秒检查业务内容的变化；工作电脑在线且支持协议时原子写入本机存档。不会自动 commit、push、fetch 或启动 Agent。失败的自动保存最多尝试五次，间隔一分钟，页面显示错误。
2. 点击“同步需求”检查远程 refs，并列出双方进度、可提交文件、排除文件。本地未提交变化及远程提交 ID 都进入版本令牌；确认后若任一版本已变化，必须重新查看。
3. “采用本地”：在临时 Git index 中提交所选代码和正式资产、业务存档；需求提交保留远程提交与本地 HEAD 的历史。再生成主干索引提交。使用原子、正常快进 push 同时更新两个分支，**不使用 force push**。推送结果不确定时只核对远程提交，不自动重发。
4. 原工作分支 HEAD 和真实暂存区保持原样；已发布的快照提交由远程需求分支指向。再次同步比较远程树与现有工作文件，已经同步的文件不会再次被列为未同步，也不会因为未勾选而回退。
5. “采用远程”：保留数据库需求备份及原 worktree，创建独立的新 worktree，再替换当前业务进度并保持暂停。已有原始审批与失败证据保留；未完成的原生会话不直接复用，准备新的会话用公开上下文续接。
6. 正在执行、等待工具/用户输入、还有排队消息的需求必须先结束活动执行，再发布或替换进度。不会只因为本地较旧就覆盖正在生产的数据。

默认排除视频、`captures/ screenshots/ frames/ recordings/ cache/ .godot/ node_modules/ build/`、过程目录中的图片二进制、凭据与环境文件、压缩包/引擎可执行文件。`.studio` 只自动纳入文本规格与报告。超过 25 MiB 的改动文件留在本机并在清单中说明；正式大资产请按项目 Git LFS 规则处理。本功能不会清除历史已提交的大文件，也不会强制忽略正式资产目录中的 PNG、GLB、BLEND 等。

## 新机器读取和续做

正常 clone / pull 后，在本机 Relay 登记该游戏仓库。新版服务会扫描已拉取的 `origin/codex/studio-*` 分支，不切换当前工作分支即可读取存档；主干索引和分支存档都保留稳定 ID。未准备本机副本的需求仅以暂停的只读进度展示。若尚未更新 refs，可在“读取仓库需求”中选择电脑与仓库；检查同步差异也会 fetch 最新 refs。

打开需求 → 同步需求 → 选择目标电脑的仓库 → 在此电脑继续。系统准备独立 worktree，公开上下文可直接查看，随后核对该机器的 Agent 登录、模型、引擎/DCC/Python 与必要子模块。工具路径不沿用源电脑，导入项目默认使用请求批准权限。已完成任务和审批保留；原任务仍卡在审批或质量验收时，不自动视作通过。

这不是多台电脑同时编辑一个需求的分布式执行协议。远程版本变化会阻止旧令牌推送，实际生产仍应由一个工作副本执行。离线尚未同步的代码/进度不能凭空出现在新机器。

## 服务接口

`POST /api/studio/repository` 创建持久化后台操作，传入 UUID `id` 和 `op: scan / inspect / publish / restore`。返回任务 ID；用 `GET /api/studio/repository/job?id=...` 查看结果。同一个 ID 内容必须相同，页面超时重连只读取原任务，不重新提交。`publish / restore` 还需要 inspect 返回的 `token`。

Bridge 内部使用 `studio-repository` 操作，另有 `save` 用于自动落盘；仅允许已登记仓库，禁止通过普通 `/api/actions` 任意发起。能力标记 `capabilities.studioRepository`。服务器与工作电脑均需此版本。

`GET /api/studio/repository/history?runId=...` 查看公开上下文；`GET /api/studio/repository/video?runId=...&index=...` 可转发已导入媒体索引中的视频，沿用原设备认证与路径校验，不接受浏览器任意路径。
