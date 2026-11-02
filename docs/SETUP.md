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

在“API 设置”填写 HTTPS 的 OpenAI 兼容推理根地址（通常以 `/v1` 结尾），不要填管理后台网页或 `/chat/completions` 完整路径；模型名按服务商实际提供的名称填写。先保存设置，再到助手页手动更新简报。开启“自动整理”后，变化会合批处理；无变化不请求。每日上限覆盖简报与聊天，最多可设为 200 次。

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

### 首次配网

1. 打开 Mac 应用。另一个终端启动 USB 配网桥接（当前版本还需此命令，未内置自动 USB 管理）：

```bash
./scripts/device bridge --network-only --port /dev/cu.usbmodemXXXX --runtime "$HOME/Library/Application Support/AgentCompanion"
```

实际参数以 `./scripts/device bridge --help` 为准。先使用 `ls /dev/cu.usb*` 确认端口。串口一次只能由一个进程占用；关闭 IDF monitor 后再启动桥接。

2. “连接”页填写 2.4GHz Wi-Fi 名称和密码，点击“通过 USB 配网”。iPhone 热点请开启最大兼容性。密码通过 USB 下发并保存在板端 NVS。
3. Mac 与板子处于同一网络时，选择 Mac 的局域网地址，点击“通过 USB 配对主机”。私有 CA 和独立设备令牌经 USB 配对，后续走 `wss://<Mac>:8737/v1/device`。
4. 等待“局域网已连接”及实时回执。地址变化时重新配对，或使用网络内可解析的 `.local` 主机名。防火墙需允许设备访问 8737；勿开放到公网。
5. 异地才需要按 [中转文档](RELAY.md) 部署自己的服务器并下发中转配置。

首次配网桥接打开 USB 可能重启板子，属硬件串口行为。USB 模式为调试能力；日常推荐局域网/中转。数据新鲜度由板端应用 ACK 判断，不能仅凭 Wi-Fi 已连接或 WebSocket 已连接认定数据同步。
