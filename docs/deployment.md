# 部署：服务器、电脑端与网站

## 1. 部署结构和准备

服务器运行中转服务并提供 `web/` 网站；电脑运行 bridge 和真正的 Codex / Claude。两端都使用本仓库，无需单独编译网站。

- 服务器：Linux、Node.js 24.14+、npm、HTTPS 反向代理，或 Docker / Compose。
- 电脑：当前主要验证 Windows，Node.js 24.14+、npm、已安装且已登录的 Codex CLI / Claude Code。
- 网络：电脑主动连接服务器 WSS；手机连接服务器 HTTPS。当前网页通过已鉴权的 HTTPS 接口收发图片和附件，服务器按需从电脑取图并缓存；无需 STUN、TURN 或电脑公网 HTTP 文件服务。旧版直连兼容配置见后文。
- HTTPS 示例入口为 `https://relay.example.com:8443`，按实际域名/IP与证书替换。若 443 已被占用可使用独立端口，并放行对应防火墙规则。

真实密钥、模型凭据、`bridge.config.json`、`.data/` 与工程 workspace 不上传 Git。服务器不安装或登录 Agent。

本机可用 `npm run desktop` 打开独立桌面窗口，选择 Codex / Claude 原生接入，或配置 Grok、DeepSeek、MiMo 与自定义 API Agent。API 模型不要求安装 Codex / Claude，但需要自己的服务商密钥。详见 [桌面与多 Agent 接入](local-agents.md)。网页右上角的 EN / 中文切换仅翻译操作界面，保留会话正文。

## 2. 服务器：Node / systemd

模板约定服务用户为 `ubuntu`，Node 位于 `/opt/agent-relay-runtime/bin/node`，发布目录为 `/opt/agent-relay/releases/<版本>`，`current` 指向当前版本。其他环境请相应修改 `deploy/agent-relay.service`，确认目录和服务用户一致。

在服务器独立目录获取源码，安装依赖并构建：

```sh
git clone git@github.com:haiaimi/Agent-Relay.git
cd Agent-Relay
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run check
npm run build
npm prune --omit=dev
```

仓库私有时可配置只读 deploy key，或在可信电脑构建后通过 SSH 传输发布产物；不必将个人 GitHub 私钥复制到服务器。运行目录至少包含 `dist/`、`web/`、`node_modules/` 和 `package.json`。

以 ubuntu 用户首次安装，例如：

```sh
sudo install -d -o ubuntu -g ubuntu -m 0755 /opt/agent-relay/releases/initial
sudo install -d -o ubuntu -g ubuntu -m 0700 /var/lib/agent-relay
cp -a dist web node_modules package.json /opt/agent-relay/releases/initial/
sudo ln -sfn /opt/agent-relay/releases/initial /opt/agent-relay/current
```

用 `npm run keys` 生成两个不同的随机密钥，在服务器创建 root 所有、权限 0600 的 `/etc/agent-relay.env`，内容为：

```dotenv
RELAY_HOST=127.0.0.1
RELAY_PORT=8787
RELAY_DATA_DIR=/var/lib/agent-relay
PHONE_TOKEN=<手机登录密钥>
BRIDGE_TOKEN=<电脑连接密钥，与手机密钥不同>
PUBLIC_ORIGIN=https://relay.example.com:8443
```

`PUBLIC_ORIGIN` 必须与浏览器实际访问的来源完全一致，不带末尾斜杠。不要使用 `.env.example` 中的占位值。

确认 Node 实际路径、用户和工作目录后安装服务：

```sh
sudo install -m 0644 deploy/agent-relay.service /etc/systemd/system/agent-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now agent-relay.service
curl -fsS http://127.0.0.1:8787/healthz
```

### HTTPS 与网站

网站由中转服务直接提供，不需要额外启动前端开发服务器。外部只暴露 HTTPS，8787 保持回环监听。

`deploy/nginx-ip.conf` 是 8443 的模板：安装前检查 `server_name`、端口、证书路径及现有站点冲突；`deploy/nginx-upgrade.conf` 放在 nginx 的 `http` 级 include 中。模板假设证书已在 `/etc/letsencrypt/live/agent-relay-ip/`，证书签发不包含在脚本中。域名部署可修改为自己的证书路径，或采用 `deploy/Caddyfile.example`。

反向代理须支持 `/bridge` 的 WebSocket Upgrade，关闭 `/api/events` 的 SSE 缓冲，并允许长连接。附件上传上限至少 16 MiB（nginx `client_max_body_size 16m`）。装好证书并检查配置后再重载 nginx，不要覆盖其他站点。

`agent-relay-ip-renew.service` / `.timer` 是特定 certbot 路径及证书名的续期模板，使用前检查实际环境。HTTP 验证方式需公网 80 可达；timer active 不代表续期成功。

`deploy/install-release.sh RELEASE_ID ARCHIVE ENV_FILE` 是固定 Ubuntu 目录布局的更新辅助脚本。压缩包根目录应包含已构建的 `dist/`、`web/`、`deploy/`、`package.json` 与锁文件。脚本安装生产依赖、替换环境文件、切换 current、重启服务并重载 nginx，只适用于已核对 Node、证书及模板的环境，不是任意服务器的自动安装器。

## 3. 服务器：Docker 替代方式

不使用 systemd 时，在服务器克隆源码，创建服务器专用 `.env`，填入 `PHONE_TOKEN`、`BRIDGE_TOKEN` 和 `PUBLIC_ORIGIN`，然后执行：

```sh
docker compose --env-file .env -f deploy/compose.yaml up -d --build
curl -fsS http://127.0.0.1:8787/healthz
```

Compose 只绑定 `127.0.0.1:8787`，仍须配置 HTTPS。容器只运行 relay，数据保存在命名卷 `/data`，需安排备份。Docker 模板已提供，尚未完成容器实际运行验收。

## 4. Windows 电脑端安装与连接

在准备运行 Agent 的电脑执行：

```powershell
git clone git@github.com:haiaimi/Agent-Relay.git
cd Agent-Relay
npm ci
npm run setup
npm run build
```

`setup` 自动创建 `.env` 和 `bridge.config.json`。将电脑 `.env` 的 `BRIDGE_TOKEN` 改为服务器同名值。电脑不需要服务器的 `PHONE_TOKEN`，除非同时运行本地 relay 或显式验证脚本。

编辑本机 `bridge.config.json`，例如：

```json
{
  "relayUrl": "wss://relay.example.com:8443/bridge",
  "hostId": "my-work-pc",
  "name": "我的工作电脑",
  "dataDir": ".data/bridge",
  "projects": [
    { "id": "my-project", "name": "My Project", "path": "C:/Projects/my-project" }
  ],
  "codexCommand": "codex",
  "syncIntervalSeconds": 15,
  "discoverCodexProjects": true,
  "syncHistory": true
}
```

每台电脑使用不同 `hostId`。`name` 是显示名称；`projects` 是额外允许执行的目录。`discoverCodexProjects: true` 自动导入 Codex 项目、多根 workspace 及原生会话归属，也将这些目录加入执行允许范围；仅允许显式目录时设为 `false`。`syncHistory: false` 关闭后台全文同步，保留索引和按需读取。

先确认电脑 Codex / Claude CLI 能使用现有登录。Windows 默认使用 npm Codex，可用 `codexCommand` 指定可执行文件。Claude 默认路径为 `~/.local/bin/claude.exe`，其他位置用 `claudeCommand` 指定。`codexHome` / `claudeHome` 可调整历史目录，不要上传其中的登录文件。

前台测试：

```powershell
npm run bridge
```

手机打开 HTTPS 入口，用服务器 `PHONE_TOKEN` 登录，确认设备在线，检查项目与历史。初次同步需要时间，已同步内容在电脑离线后仍可浏览；上传及执行要求电脑在线。

### 后台运行与登录自启动

确认前台连接正常后，退出前台 bridge，在项目根目录 PowerShell 执行：

```powershell
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-background-service.ps1
```

安装器创建当前用户的 `AgentRelay-<路径哈希>` 计划任务，登录后以隐藏窗口启动独立守护程序，不需要管理员权限。它分别监督主 bridge 和脑爆 bridge，使用构建后的 `dist/`，具有单实例保护和异常退出重启。关闭桌面窗口或 Codex 客户端不会停止守护任务；电脑休眠、关机或退出用户登录仍会断线。旧版 Startup 快捷方式如仍存在，应只移除它自己的快捷方式，避免重复启动。

停止守护循环并避免自动拉起：创建 `.data/background-service.stop`。该标记不主动终止现有工作进程；先检查执行中的任务、审批、排队及未确认操作，等待空闲，再按确切 PID 和工程启动路径停止对应进程。不要批量结束所有 Node/Codex 进程。重新运行安装器会清除停止标记并启用计划任务；移除自启动时删除本工程对应的计划任务。

## 5. 更新、回退和备份

服务器更新：准备新发布目录，安装锁定依赖并构建，核对环境文件及模板，切换 `current`，重启 relay 后检查健康与实际会话。保留上版完整目录及其 `node_modules`，回退时将 `current` 指回上版并重启。重启中转会短暂断开连接，电脑会重连。

电脑更新：等待运行任务和审批结束，停止守护/bridge，获取源码、执行 `npm ci` 和 `npm run build`，再启动。不要覆盖现有 `.env`、`bridge.config.json`、`.data/`；`setup` 也不会覆盖这些配置。连接恢复不等于中断任务自动重跑。

备份服务器数据目录的 SQLite、`images/`、`uploads/` 及安全保存的环境文件；电脑数据目录包含图片、持久队列及本地上传附件。在线 SQLite 使用 backup 接口，或停服务后完整备份，避免漏掉 WAL。服务器缓存会话和资源内容，磁盘不额外加密；目前没有自动清理缓存的功能。

### 图片与附件：服务器传输和缓存

电脑、服务器和网页需一起更新，并刷新已打开的手机页面。构建前执行 `npm ci`；只替换网页无法恢复旧电脑版本禁用的资源接口。

- 网页通过已登录的 `/api/images/`、`/api/files/` 直接下载二进制内容，不协商 WebRTC。服务器缓存未命中时，经电脑已有 WSS 通道按会话读取资源并验证散列，写入服务器缓存后返回。重复的同资源冷请求合并，最多并行 3 个资源任务。缓存命中时不需要电脑在线。
- 上传使用 `/api/uploads` 原始文件请求体；服务器验证名称、大小、散列及会话/项目范围，缓存文件并传给电脑。电脑确认后网页才把附件随消息发送。稳定上传 ID 允许用户重试同一上传而不创建第二份附件；失败不会自动发送消息。单份及每次附件合计最多 16 MiB、最多 5 项。
- 图片按进入阅读区域加载，显示“服务器中转 / 服务器缓存 / 设备缓存 / 加载失败”。浏览器缓存最多 64 MiB / 100 项，退出登录清除；服务器缓存继续保留。服务器原有图片缓存可复用，旧版仅登记索引的附件可在电脑上线后按需补取。
- 列表使用 `preview=1` 读取较小预览；超过 96 KiB 的图片生成最长边 960 像素的 WebP，缓存在 `previews/`，单次串行生成且限制输入 2000 万像素。小图、转换失败或压缩无收益时保留原格式。点击放大和文件下载仍读取原字节，预览与原图使用独立设备缓存键。GIF 列表预览为首帧，放大后可读取原动画。
- 传输保留 HTTPS/WSS、登录 cookie 和会话隔离，不再增加 DataChannel 端到端加密。服务器可读取资源内容，数据目录需限制访问并监控容量；不上传 workspace 整体文件或模型凭据。

服务器增加 sharp 原生依赖，更新版本需在目标 Linux 上执行 `npm ci --omit=dev`，不要沿用不含 sharp 的旧 node_modules 或从 Windows 复制二进制。服务器需可写数据目录下的 previews/，备份时可把预览视为可重建缓存。

### 旧版客户端兼容：TURN 加密中转

当前网页不再请求直连或 TURN 接口，以下配置仅供尚未更新的旧客户端使用，可不安装 coturn。

在服务器通过系统软件源安装 `coturn`，按 `deploy/turnserver.conf.example` 配置公网/内网地址和独立随机密钥。服务器环境文件加入 `TURN_URLS=turn:公网地址:3478?transport=tcp,turn:公网地址:3478?transport=udp` 和相同的 `TURN_SECRET`（至少 32 个随机字符）。真实配置和密钥不提交 Git；配置文件仅 root 和 turnserver 组可读，环境文件仅 root 可读。

开放 TCP/UDP 3478 和 UDP 49160–49260（示例配置的 relay 端口范围）；云安全组和系统防火墙均需允许。不要占用已有 443 服务。`no-tcp-relay` 只禁止 RFC 6062 TCP peer endpoints，不阻止客户端通过 TCP 访问 TURN。WebRTC 的 DTLS/SCTP 在手机与工作电脑之间保持加密；TURN 可观察连接、流量与时间，不能直接读取文件明文。身份仍依赖既有 HTTPS 登录和 SDP 协商，尚无独立设备指纹配对。

旧版网页先尝试直连，失败后通过已鉴权的 `/api/direct-config` 取得 10 分钟 TURN 凭据；共享密钥不发往电脑或网页。服务器为电脑独立签发配置，不接受网页自选 TURN 地址；协商和凭据不写入任务命令表。

旧版直连可能受 STUN、NAT 或 TURN 端口限制。更新网页后走服务器 HTTP 接口，不依赖这些端口。

### Agent 提问与回答

网页管理的 Codex `item/tool/requestUserInput`、Claude `AskUserQuestion` 会暂停原任务并展示问题卡片；未选中任何默认项，单选、多选或自填后提交。回答按会话和问题 ID 校验，重复、过期或已在本机关闭的问题不会再次投递。问题事件和当前未答快照支持刷新恢复；网页刷新不会清空输入中的回答。已答问题默认折叠。

Windows Codex 桌面原生会话通过只读 follower 快照/补丁取得等待中的问题，并用 `thread-follower-submit-user-input` v1 回答；异步 `agentMessage.questions` 从原生历史读取，按原生 `send_user_message_question_reply` 格式引导当前轮或在空闲时继续原会话，不新开 transcript writer。本机已回答的子问题不再展示为待答。适配桌面 26.1013.4894 的 IPC；升级后应重新验证。

Claude 原生终端需在电脑工程执行一次 `npm run questions:install`。安装器会备份 `~/.claude/settings.json`，合并一个仅匹配 `AskUserQuestion` 的 `PreToolUse` hook，保留其他 hooks 和权限规则。**已有 Claude 终端会话需重开以加载此 hook；安装前已弹出的提问仍需本机处理。** 网页管理的 Claude 使用 SDK 回调，不依赖重开终端。

连接工具在电脑 `127.0.0.1` 的随机端口运行问答入口，令牌只写入本地 `.data/bridge/question-hook.json`，不会同步服务器。hook 收集网页答案后回传原始问题和 `answers`，只针对本次 AskUserQuestion，不批准其他工具。桥接工具离线、取消或响应失败时不输出 allow，交还 Claude 本机界面。提问最长等待一小时；不自动替用户选答案。移除时仅删除安装器加入的 AskUserQuestion hook，不要覆盖之后新改过的整个设置文件。

图片提取只接受用户/助手正文中的引用和工具的结构化图片块，不把命令输出、补丁或工具代码里的图片示例当作资产。临时路径失效时，仅在本会话存在唯一且校验通过的同名电脑缓存时恢复，避免错配其他会话图片。连接失败与本地文件缺失分别显示，不使用服务器旧文件作为回退。

## 6. 验证与排查

```sh
systemctl is-active agent-relay nginx
journalctl -u agent-relay -n 80 --no-pager
curl -fsS https://relay.example.com:8443/healthz
```

健康接口只能证明 relay 存活，还需实际验证：

1. 手机登录，设备在线，Codex 项目及会话归属正确。
2. Codex / Claude 分别新建与续聊，模型/强度下轮生效。
3. 运行中排队、逐条取消/引导；不可用时显示明确原因。
4. 上传图片和文件，本机可读取、手机可预览或下载。
5. 审批/停止、电脑断开后浏览缓存历史、恢复连接。

- 登录失败：检查使用服务器 `PHONE_TOKEN`，不要使用 bridge 密钥。
- 设备离线：核对 `BRIDGE_TOKEN`、WSS URL、证书、代理 Upgrade 及电脑日志。
- 来源错误 403：核对 `PUBLIC_ORIGIN` 与浏览器实际协议、域名/IP、端口一致。
- SSE 不更新：检查代理关闭缓冲及长连接超时。
- 图片加载失败：先核对网页和电脑 bridge 是否一起更新；缓存未命中需要电脑在线，并查看电脑资源读取与服务器缓存日志。检查 nginx 的 `client_max_body_size` 至少 16m。旧页面仍显示“直连/加密中转”时刷新网页。
- 引导不可用：查看提示并核对 CLI / 桌面版本，不要另起进程强制写入原会话。

日志可能包含会话内容及路径，分享前应脱敏。自动测试与响应式浏览器验证不能代替真机键盘、相机、网络切换或长时间运行验收。


### 停止当前任务

会话运行时，标题旁显示绿色运行指示。输入框为空时，右侧方形按钮停止当前任务并取消尚未投递的排队消息，会话和历史记录保留；有草稿或附件时显示发送按钮。顶部“取消排队”只撤销待投递消息，不打断当前任务。

网页启动的 Codex / Claude 任务均支持停止。原生 Codex 桌面通过已有窗口的本地 IPC 请求停止，不创建第二个会话写入者，最终状态继续以本机为准。独立 Claude Code 窗口的当前 peer 协议不提供中断操作，点击时明确提示在电脑上按 Esc，不强杀进程、不伪报已停止。原生桌面协议升级后需重新验证适配。


### 网页工程与会话权限

在“新建会话 → 项目 → ＋ 新建工程”中输入工程名称和工作电脑上的绝对文件夹路径。可以使用已有文件夹，或勾选“文件夹不存在时创建”。登记独立于发送任务，结果保存在该电脑 bridge 数据目录的 `local_projects` 表中，重启后仍可选择。Windows 使用本机盘符路径，路径对应工作电脑，不是手机或服务器。文件仍留在工作电脑；网页登记不会覆盖 Codex 原生项目、猜测原生项目归属或改写 Codex 数据库。

新会话可选择“请求批准”“帮我批准”“完整权限”。默认请求批准；完整权限允许 Agent 访问电脑文件和网络，跳过常规批准，仅作用于明确选定的会话。“帮我批准”交由 Agent 自带的自动审查，支持情况受模型、账户及本机策略限制；不可用时显示 Agent 返回的错误，不自动降级或升级权限。所有 Agent 强制要求的确认、问题回答和已有拒绝规则继续由其自身机制决定。

输入框下方可打开权限和模型/思考强度选择。Codex 正在执行时，权限预设在下一轮生效；网页管理的 Claude 可通过运行中的 SDK 更新后续工具权限。已有待确认卡片仍需单独处理。独立 Claude 窗口的权限需要在电脑上修改；旧版本电脑连接程序会明确显示需更新，不把未支持的选择当成成功。

批准卡片提供一次允许、当前会话不再询问及拒绝。Codex 使用本机会话批准范围；Claude 的按钮明确表示允许当前会话的该工具，授权随此会话保存，其他工具及会话仍独立确认，不写入用户全局设置。问题选择不会因此自动作答。模型和思考强度仍是下一轮设置。
