# V1 开发预览 · Mac 0.4.19 / Board 0.2.26

本次发布提供当前 Mac 软件与板端固件，同时保留完整源码、演示和配置说明。

- Mac：Apple Silicon / macOS 13+；安装包内含 Gateway 与 LVGL 预览，无需另装开发工具。临时代码签名，尚未 Apple 公证。
- 板端：微雪 ESP32-P4-WIFI6-Touch-LCD-7B，P4 rev3.x / 32MB Flash。已在 rev3.2 验证；其他芯片、修订与屏幕型号不适用。
- 功能：1–3 个 Agent、Codex/Grok/DeepSeek/Claude Code 来源、动态桌宠、主题选择、会话与定时状态、Token 图表、额度倒计时、增量助手与历史事件搜索。
- 连接：USB 优先，支持局域网与自建 WSS 中转；屏幕可独立配 Wi-Fi。
- 语音：重要信息按优先级与去重播报，音频由 Mac 生成并交给屏幕播放；板端音量 0–100% 对应驱动 0–100 档。

**首次使用请先读 [首页](https://github.com/kuangda-source/agent-companion#首次使用)。**

- [Mac 安装与配置](https://github.com/kuangda-source/agent-companion/blob/v0.4.19/docs/MAC_INSTALL.md)
- [固件备份与刷写](https://github.com/kuangda-source/agent-companion/blob/v0.4.19/docs/FIRMWARE_INSTALL.md)
- [完整使用手册](https://github.com/kuangda-source/agent-companion/blob/v0.4.19/docs/SETUP.md)
- [演示视频](https://github.com/kuangda-source/agent-companion#演示)：实际共享 LVGL 渲染器录屏，使用明确标注的 MOCK 数据，无真实账号与对话；不是板子实拍。

配置均留空：不含 API Key、Wi-Fi 密码、服务器地址、配对令牌、NVS 或整片 Flash 备份。个人配置仍留在各自 Mac／设备，普通升级会保留它。

下载后用同目录的 `SHA256SUMS.txt` 校验。`release-manifest.json` 记录对应源码提交、目标硬件和每个包的摘要。

```bash
shasum -a 256 -c SHA256SUMS.txt
```

固件包仅包含程序、引导程序和分区表；刷写前必须识别修订、备份自己的原厂 Flash 并核对偏移。Mac 不会自动刷板。

自有代码 MIT；角色与第三方资源适用各自许可，见包内 Licenses 与仓库 THIRD_PARTY_NOTICES。实时语音对话、完整 Letta 记忆与 V2 共享空间尚未接入。
