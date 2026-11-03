# 本机桌面管理与 API Agent

[中文](#中文) · [English](#english)

## 中文

### 启动独立桌面窗口

安装 Node.js 24.14+ 后，在工程目录执行：

```powershell
npm ci
npm run desktop
```

Windows 也可以运行 `scripts/start-desktop.ps1`。这是独立 Electron 窗口，不是浏览器管理页。窗口可以切换中文 / English，勾选 Codex、Claude，以及添加 Grok、DeepSeek、MiMo 或自定义 API 服务。第一次会生成缺失的基础配置；已有配置不覆盖。

桌面窗口显示本机连接工具是否运行，并提供“启动连接工具”和“打开会话网页”。已有实例运行时不会再开第二个；关闭窗口不停止后台连接工具或任务。服务器连接与允许的工程目录仍由 `bridge.config.json` 配置，服务器连接密钥来自本机 `.env` 的 `BRIDGE_TOKEN`。桌面窗口本身不需要云端账号。

### 配置服务与模型

1. 点击“添加 Agent”，选择服务预设，检查 API 地址与协议。Grok 预设使用 Responses；DeepSeek、MiMo 预设使用 Chat Completions，也可填写其他兼容接口。
2. 填写该服务的 API key。保存后不再显示原值，留空保存会保留已有密钥；勾选“清除已保存的密钥”才删除密钥。
3. 点击“发现模型”获取服务返回的列表，点击模型加入启用列表；若服务不提供模型发现，手动填写准确的模型 ID。第一个模型作为新会话默认模型。不要将产品显示名当作模型 ID。
4. 仅对支持的模型启用图片输入、思考等级。思考参数默认不发送；按服务文档选择标准 `reasoning_effort`、`thinking` 参数或 Responses 的 `reasoning.effort`。不支持的等级不要填写。
5. 需要读写项目与命令时勾选“启用项目工具”，再勾选启用服务并保存。连接工具在下一次同步时更新列表，通常约 15 秒；网页的新建会话只列出此电脑启用的 Agent。未配置密钥或模型的 API Agent 不可启动。

配置文件为本机 `<dataDir>/agents.json`，使用与其他本机配置一致的受限文件权限，密钥明文保存在本机，不上传 Git、中转服务器或浏览器。模型调用由工作电脑直接访问所配置的服务商；会话内容及启用的图片输入因此会发送给该服务商。服务器继续保存会话与被查看的资源，仍遵循项目现有的数据约定。

文件工具禁止读取本程序的 Agent 密钥配置、API 上下文目录及 `.env` 文件；项目范围外的路径也会拒绝。Shell 命令不是操作系统沙箱，用户确认的命令或完整权限仍拥有本机进程权限，可能访问其他文件。

### 支持范围

| 能力 | Codex / Claude | API Agent |
| --- | --- | --- |
| 本地已有历史与原生窗口 | 保留现有适配 | 不导入服务商网页聊天记录；在本项目中新建会话 |
| 模型选择 | 从本机 CLI / SDK 读取 | 桌面启用模型列表，可从服务发现 |
| 流式回复、停止、持久上下文 | 支持 | Chat Completions / Responses 支持 |
| 运行中输入 | 现有排队与原生引导 | 排队；引导会停止本轮，再沿同一会话继续 |
| 文件与命令 | 原生 Agent 能力 | 可选 read_file、list_files、write_file、run_command |
| 问题回答 | 现有原生适配 / hook | ask_user 等待网页回答 |
| 权限 | 原生策略 | 默认确认写文件与命令；完整权限可跳过；“帮我批准”仍确认修改操作 |
| 图片输入 | 现有支持 | 需模型与协议支持，并在桌面勾选 |
| 账号额度 | 支持的原生接口 | 不猜测额度，请看服务商控制台 |

API 执行每轮最多 24 个模型步骤，单次命令最多 30 秒，回复与工具输出有大小限制。中断后不自动重发请求或重放未完成工具；继续前会提示模型先核查状态。更换一个已有 API Agent 的协议后应新建会话，旧上下文不会跨协议混用。禁用 Agent 会阻止新的请求，已保存历史保留。

真实 Grok、DeepSeek、MiMo 调用需要用户自己的有效密钥、可用模型与账户额度。本项目自动测试使用隔离模拟接口，不代替每个服务商、模型和订阅方案的实测。

### 文档参考

- [xAI Responses](https://docs.x.ai/developers/rest-api-reference/inference/responses)
- [DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)
- [MiMo 首次调用 API](https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call)

## English

Run `npm ci`, then `npm run desktop` from the repository. On Windows, `scripts/start-desktop.ps1` also opens the independent Electron window. Select Chinese or English, enable native Codex / Claude, and add API agents. Closing the window leaves the bridge and running tasks alone. An existing bridge is reused. Relay identity, project roots, and `BRIDGE_TOKEN` still use `bridge.config.json` and `.env`.

Choose a preset or custom HTTPS base URL. Grok defaults to Responses; DeepSeek and MiMo default to Chat Completions. Enter your API key, save, then discover models or enter exact model IDs manually. Add supported effort levels and vision only when documented by your model provider. Reasoning parameters are omitted by default. Enable project tools only if needed. Enable the agent and save; the bridge advertises it at its next sync, normally about 15 seconds. Model-list changes invalidate the web catalog cache.

Keys are stored locally in `<dataDir>/agents.json` with restrictive file permissions. They are not sent to the relay or web UI and are not committed. A blank key field preserves the saved key; explicitly choose Remove saved key to clear it. Model requests run on the workstation and send conversation content and enabled image inputs directly to the configured provider. Existing relay conversation and resource caching still applies.

API agents have their own persistent conversations; they do not import chats from provider websites or impersonate native CLI sessions. They support streaming, stop, queues, interrupt/resume steering, model presets, and optional project tools. File reads/listing stay within the project. Writes and commands ask for approval unless Full access is selected; Automatic review also confirms modifications for API agents. The `ask_user` tool waits for web answers. Files containing Agent Relay keys, internal API context, and `.env` are excluded from file tools. Shell commands are not OS-sandboxed and may access other files when explicitly approved or allowed by Full access.

Each turn is limited to 24 model steps and commands to 30 seconds. Context, file size, response size, and tool output are bounded. Interrupted requests and unfinished tool effects are not automatically replayed. Start a new conversation after changing an agent’s API protocol. Provider quota is not guessed; consult its console. Disabled agents cannot start new requests, while history remains available.

The UI defaults to the browser language and has an EN / 中文 switch. It translates interface labels, actions, settings, and statuses; user messages, conversation titles, filenames, and model replies keep their original content. The independent desktop window also has a language selector.

Real provider operation requires your own valid key, account access, and supported model. Automated tests use isolated mock endpoints for both protocols and do not establish live-provider compatibility or consume paid quota. See the official links above for provider-specific parameters.
