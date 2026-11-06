# 功能预览站

与正式 UI 同源的独立静态演示，入口 `/preview/`。包含九个合成会话、两台演示设备、三张自绘图片和运行中 / 已完成 / 等待回答状态。

## 本地运行

```powershell
node preview/build.mjs
node preview/serve.mjs
```

打开 `http://127.0.0.1:18804/preview/`。构建结果位于忽略目录 `.data/preview-site`；不要直接编辑构建结果。构建会复制当前 `web` UI，并把演示 API 改到 `/preview/api/`。API 在浏览器内存中模拟，不需要登录、密钥、真实数据库、Agent 或服务器应用进程。访问者之间不共享状态；刷新或点击“重置演示”恢复初始数据。发送、新建、附件、停止、引导、问答和设置只影响本页，模拟回复不调用模型。

外观、侧栏宽度及图片设备缓存使用独立命名空间。请勿向示例数据中复制真实会话或截图。图片由构建脚本使用 SVG 和 Sharp 生成，校验与预览沿用正式图片通道。

## 部署到自己的服务器

示例地址：`https://relay.example.com:8443/preview/`，请替换为自己的域名；真实部署地址保存在本机私有配置，不提交到 Git。将构建结果整体上传至独立版本目录，再以 `/opt/agent-relay-preview/current` 指向该目录。现有 8443 TLS 虚拟主机中加入：

```nginx
location = /preview { return 302 /preview/; }
location ^~ /preview/ {
    alias /opt/agent-relay-preview/current/;
    index index.html;
    add_header Cache-Control "no-store" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    limit_except GET { deny all; }
}
```

先验证 Nginx 配置，再平滑重载。正式站 `/` 和 `/api/` 继续使用原有中转服务，443 保持原状。回滚仅需切换预览站软链接或移除此 location；不重启 Agent 或正式中转。预览没有真实后端，服务器直接访问 `/preview/api/` 返回 404 是预期行为。

验证：`node --import tsx --test test/preview.test.ts`，并用浏览器检查图片放大、状态切换、问答提交与模拟发送。发布后核对首页、脚本和三张图片的散列。

公开文档、演示数据和截图不得包含真实服务器 IP。发布前运行 `node scripts/check-public-addresses.mjs` 检查可提交文件；本机私有配置继续由 `.gitignore` 排除。该检查覆盖当前文件，旧提交须另行审查。
