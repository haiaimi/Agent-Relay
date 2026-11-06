# 工作室启动与加载恢复

HTTPS 部署必须启用 HTTP/2，避免多个浏览器标签页的 SSE 长连接占满 HTTP/1.1 每个来源通常只有六个连接的名额。`deploy/nginx-ip.conf` 使用 Nginx 1.25.1+ 的 `http2 on;`；更旧版本应在两条 `listen ... ssl` 中使用兼容的 `http2` 参数。修改后先 `nginx -t`，再平滑 reload。需要确认客户端 TLS ALPN 协商为 `h2`，不能只看配置文件。

参见 [NGINX HTTP/2 模块](https://nginx.org/en/docs/http/ngx_http_v2_module.html) 和 [MDN SSE 连接限制](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)。

工作室界面挂载后立即通知外层工作台就绪，首次数据同步单独显示进度。首次读取失败时显示原因与“重新读取工作室”，连接错误最多尝试五次，每次失败后间隔一分钟；耗尽后由用户手动重试。登录失效时返回登录界面，不恢复旧的认证状态。

外层页面若在 20 秒内没有收到界面就绪信号，显示“重新连接工作室”。该按钮重新载入工作室页面，不会重新发起或取消制作任务；未发送草稿宜先保存。切换工作空间继续保留现有 iframe、会话草稿和滚动状态。

`/api/studio` 对支持 gzip 的浏览器压缩较大的状态快照；保持 Cookie 鉴权、ETag 条件请求、`Vary: Accept-Encoding` 和 `no-store`。只在进程内保留最近一份压缩快照；视频仍按原约定保存在工作电脑。完成任务、原始失败证据与已选审批均不受加载恢复影响。

交付汇总的图片使用与制作任务相同的安全预览链路，并将 planner/delivery 纳入任务索引，避免汇总图片因未找到任务而报 `reading 'id'`。
