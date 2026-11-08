# 安装与连接

## Mac 软件

当前构建脚本支持 Apple Silicon / macOS 13+，Intel、Windows、Linux 尚未适配。安装 Apple Command Line Tools（`xcode-select --install`）及 Python 3.9+ 后：

```bash
./scripts/dev setup
./scripts/dev doctor
./scripts/dev build
./scripts/dev check
PORT=8876 ./scripts/dev run --mock
./scripts/dev mac
```

应用安装到 `~/Applications/AgentCompanion.app`，源码构建采用本机临时签名，尚未 Apple 公证。首次依赖下载需要网络和数 GB 空间；字体与固件首次构建较慢。运行真实模式时，本机管理接口仅监听 `127.0.0.1:8736`；请勿把它经 Nginx 暴露到公网。

Mac 应用的私有数据目录为 `~/Library/Application Support/AgentCompanion/`；命令行 Gateway 默认使用项目 `.runtime/`。二者不要混用；不要提交或共享这些目录。开发命令行若需沿用应用配置，可显式设置 `AGENT_COMPANION_RUNTIME` 为应用目录。

## 可选 API

在 Mac 的 **Agent** 页选择要显示和整理的来源，至少 1 个、最多 3 个。默认 Codex、Grok、DeepSeek；Claude Code 保留为可选项。所选来源用于小屏、Token 统计和 AI 助手；取消选择不会停止原软件任务。板端需升级到 0.2.13 才能使用新 Agent 和可变数量布局。

Grok 当前接入 **Grok Bot 桌面应用**的本地缓存，无需 API Key。按 Bot 名称展示已缓存的公开消息；实时“工作中”、完成事件和 Token 未在缓存中提供，界面显示未知或“—”；每周额度每 5 分钟读取本地缓存，界面不显示更新时间。尚未在客户端加载的云端记录不会自动下载。Grok 桌宠素材暂用占位。

在“API 设置”填写 HTTPS 的 OpenAI 兼容推理根地址（通常以 `/v1` 结尾），不要填管理后台网页或 `/chat/completions` 完整路径；模型名按服务商实际提供的名称填写。先保存设置，再到助手页手动更新简报。开启“自动整理”后，变化会合批处理；无变化不请求。每日上限覆盖简报与聊天，最多可设为 200 次。

接口暂时不可用时保留已有简报，连续失败逐步延长自动重试间隔至最多一小时；新对话仍继续采集。“更新简报”可立即重试。若提示“没有可用账号”，需检查你配置的 API 服务端账号池；这与小屏连接状态无关。

DeepSeek Key 只用于官方 `https://api.deepseek.com/user/balance`，约每分钟更新；不会用它调用推理。空配置不会提供余额数值。保存按钮表示配置已保存，不代表服务商鉴权、模型可用或有余额。

密钥文件仅当前用户可读写，界面和管理 API 只返回“已设置”状态，不回显原值。清除后对应功能停止新的请求；已经发出的网络请求无法撤回。助手关闭后仍可查看已有消息。

## ESP32-P4 7B

目标板为微雪 **ESP32-P4-WIFI6-Touch-LCD-7B，1024×600、32MB Flash、32MB PSRAM**。P4 负责界面，C6 通过 ESP-Hosted 提供 Wi-Fi。请用可传数据的 USB 线连接 **P4 USB1.1 / USB TO UART**，勿将 C6 调试端口误当 P4；板子需稳定供电。

[官方手册](https://www.waveshare.net/wiki/ESP32-P4-WIFI6-Touch-LCD-7B)。必须先确认实际芯片修订，不能只按外观猜测。已验证主线为 P4 rev3.x；旧版 `rev1_3` 仅保留构建配置。

```bash
./scripts/device setup
./scripts/device doctor
./scripts/dev build
./scripts/device build rev3_x
```

编译**不会自动刷写**。首次请用工具链的 esptool 对实际端口读取芯片信息并备份完整 32MiB Flash（备份含个人 NVS，勿上传）。固件在 `.build/device-rev3_x/`，确认备份、芯片 profile 与供电后，使用该目录生成的 `flash_args` 经 IDF `idf.py -C apps/device -B .build/device-rev3_x -p <实际端口> flash` 刷写。使用相同 SDKCONFIG/profile 的工具链环境；勿 `erase-flash`，以免清除 Wi-Fi/配对或原厂数据。不要刷别人的带 NVS 镜像。

### USB 连接（默认）

打开 Mac 应用，用可传数据的线连接 P4 USB 接口。应用会自动检测一块 Espressif USB Serial/JTAG 设备，并在确认板端协议后同步。连接页显示“USB 已连接”表示已经收到屏幕应用回执，接上线本身不算同步成功。无需填写 Wi-Fi 或服务器。

“连接方式”默认为 USB 优先；拔线或外出时，自动使用已经配置好的局域网或中转，Mac 的中转连接会继续待命。只选局域网/云中转时，USB 仅处理配网、配对与屏幕操作。连接多块同类开发板时，不自动选板，请先只保留一块。烧录或使用其他串口工具前先退出 Mac 应用，避免串口被占用。

### Wi-Fi 连接（可选）

**更换环境时，直接在板子上操作：工具 → Wi-Fi 网络 → 扫描网络 → 选择网络 → 输入密码 → 连接并保存。** 支持 2.4GHz 普通 WPA2/WPA3 网络、手机热点和开放网络；需要网页登录的网络、企业账号认证暂不支持。隐藏网络可手动输入名称。已保存网络可留空密码重新连接；勾选“开放网络”才会按无密码连接。

板端只更改 Wi-Fi 名称和密码，保留服务器、令牌及局域网配对。事先在 Mac 完成一次中转配置后，外出换 Wi-Fi 不需要 Mac 在场。Mac 应用仍需在主机上保持运行，主机也需能访问中转；只显示“Wi-Fi 已连接”不代表 Mac 数据已经连上。

首次设置中转或需要通过 USB 配网时：

1. 保持屏幕通过 USB 连接，打开应用的“连接”页。

2. “连接”页填写 2.4GHz Wi-Fi 名称和密码，点击“通过 USB 配网”。iPhone 热点请开启最大兼容性。密码通过 USB 下发并保存在板端 NVS。
3. Mac 与板子处于同一网络时，选择 Mac 的局域网地址，点击“通过 USB 配对主机”。私有 CA 和独立设备令牌经 USB 配对，后续走 `wss://<Mac>:8737/v1/device`。
4. 等待“局域网已连接”及实时回执。地址变化时重新配对，或使用网络内可解析的 `.local` 主机名。防火墙需允许设备访问 8737；勿开放到公网。
5. 异地才需要按 [中转文档](RELAY.md) 部署自己的服务器并下发中转配置。

打开 USB 可能使板子重启一次，应用会等待它恢复。数据新鲜度由板端应用 ACK 判断，不能仅凭串口打开、Wi-Fi 或 WebSocket 已连接认定数据同步。开发用 `./scripts/device bridge` 仍保留；不要与应用的自动桥接同时占用串口。
