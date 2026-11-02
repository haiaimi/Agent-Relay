# 部署：服务器、电脑端与网站

## 1. 部署结构和准备

服务器运行中转服务并提供 `web/` 网站；电脑运行 bridge 和真正的 Codex / Claude。两端都使用本仓库，无需单独编译网站。

- 服务器：Linux、Node.js 24.14+、npm、HTTPS 反向代理，或 Docker / Compose。
- 电脑：当前主要验证 Windows，Node.js 24.14+、npm、已安装且已登录的 Codex CLI / Claude Code。
- 网络：电脑主动连接服务器 WSS；手机连接服务器 HTTPS。电脑无需开放入站端口。
- HTTPS 示例入口为 `https://relay.example.com:8443`，按实际域名/IP与证书替换。若 443 已被占用可使用独立端口，并放行对应防火墙规则。

真实密钥、模型凭据、`bridge.config.json`、`.data/` 与工程 workspace 不上传 Git。服务器不安装或登录 Agent。

## 2. 服务器：Node / systemd

模板约定服务用户为 `ubuntu`，Node 位于 `/opt/agent-relay-runtime/bin/node`，发布目录为 `/opt/agent-relay/releases/<版本>`，`current` 指向当前版本。其他环境请相应修改 `deploy/agent-relay.service`，确认目录和服务用户一致。

在服务器独立目录获取源码，安装依赖并构建：

```sh
git clone git@github.com:haiaimi/Agent-Relay.git
cd Agent-Relay
npm ci
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
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "scripts/start-bridge.ps1"'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-startup.ps1
```

首条隐藏启动守护循环；第二条在当前用户 Startup 创建快捷方式，登录后运行，不是系统开机即执行的服务。守护程序使用构建后的 `dist/`，有单实例保护、异常退出重启，日志在 `.data/bridge-*.log`。

停止守护循环并避免自动拉起：先创建 `.data/bridge-service.stop`，再结束对应 bridge 与守护进程；结束 bridge 会停止它启动的任务，应先等任务结束。下次显式启动会清除停止标记。移除登录自启动时，仅删除 Startup 中的 `Agent Relay Bridge.lnk` 快捷方式。

## 5. 更新、回退和备份

服务器更新：准备新发布目录，安装锁定依赖并构建，核对环境文件及模板，切换 `current`，重启 relay 后检查健康与实际会话。保留上版完整目录及其 `node_modules`，回退时将 `current` 指回上版并重启。重启中转会短暂断开连接，电脑会重连。

电脑更新：等待运行任务和审批结束，停止守护/bridge，获取源码、执行 `npm ci` 和 `npm run build`，再启动。不要覆盖现有 `.env`、`bridge.config.json`、`.data/`；`setup` 也不会覆盖这些配置。连接恢复不等于中断任务自动重跑。

备份服务器数据目录的 SQLite、`images/` 和上传资源，以及安全保存的环境文件；电脑数据目录也包含持久队列及本地上传附件。在线 SQLite 使用 backup 接口，或停服务后完整备份，避免漏掉 WAL。服务器可读取会话与附件，无端到端加密，也没有自动保留期或清理功能。

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
- 上传 413：检查代理请求体上限；应用限制最多 5 个、合计 16 MiB。
- 引导不可用：查看提示并核对 CLI / 桌面版本，不要另起进程强制写入原会话。

日志可能包含会话内容及路径，分享前应脱敏。自动测试与响应式浏览器验证不能代替真机键盘、相机、网络切换或长时间运行验收。
