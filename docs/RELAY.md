# 自建云中转（可选）

同一 Wi-Fi 直连无需服务器。异地使用需一台有公网地址的 Ubuntu/Linux 服务器、指向它的域名和有效的公有 CA TLS 证书。服务只转发一对 Mac/屏幕的数据，不持久化会话；它仍可在转发时接触摘要/标题等明文，部署在你信任的主机上。

## 生成独立角色令牌

在本机仓库运行：

```bash
python3 tools/relay/init_config.py
```

会生成被 Git 忽略、权限 600 的 `.private/relay/`：

- `relay.json`：仅含两枚 SHA-256，可复制到服务器 `/etc/agent-companion/relay.json`。
- `client.json`：两枚原始令牌留在本机，在 Mac 连接页填写；不要提交、截图或上传工单。`url` 保持空白，填你自己的 `wss://域名/v1/link`。

## 服务部署

Mac 上交叉编译 Linux x64（其他 CPU 需相应 target）：

```bash
mkdir -p .build/relay
.tools/bin/bun build --compile --target=bun-linux-x64 apps/relay/main.ts --outfile .build/relay/relay
```

将可执行文件装到服务器 `/opt/agent-companion/relay`，创建无登录的 `agentrelay` 用户，令该用户可读取配置（目录 750、配置 640、root:agentrelay），安装 `deploy/relay/agent-companion-relay.service` 到 systemd。确认配置后执行 `systemctl daemon-reload`、`systemctl enable --now agent-companion-relay`。

Relay 仅监听 `127.0.0.1:18736`。用 Nginx 代理公网 WSS：将 `deploy/relay/nginx-tls.conf` 中的 **relay.example.com** 和证书路径替换成自己的。先准备 A/AAAA DNS 和公有 CA 证书，`nginx -t` 通过后再 reload。按需用 `nginx-http.conf` 作为申请证书时的 HTTP 站点模板；不要替换其他站点。防火墙仅需开放 443（证书签发可能用 80），不开放 18736 或 Mac 的 8736/8737。

`https://你的域名/health` 仅用于服务健康检查；角色认证及实际数据回执另行验证。不要关闭证书校验，板端用系统 CA 验证服务器域名。模板关闭访问日志，应用日志也不记录载荷。

## Mac 与屏幕

“连接 → 异地连接”填自己的 WSS 地址和两枚不同的 64 位十六进制角色令牌，启用并保存。USB 连接板子，再点“通过 USB 配网”下发当前 Wi-Fi 与中转配置。模型 Key 仍只在 Mac。

选择“自动”时优先已配对 LAN，不可达才走中转；选择“仅云中转”控制 Mac 的中转发送，板端已保存的 LAN 仍有探测能力。要检验异地路径，请将板子置于另一个网络，并以实时应用 ACK 为准。更改令牌需同时更新服务器、Mac 和板子。

当前为单用户、单 Mac/单屏幕设计，不提供公共托管、多租户或多人共用服务器功能。
