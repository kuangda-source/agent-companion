# Mac 安装与首次配置

适用版本：Agent Companion 0.4.19；Apple Silicon（M 系列）Mac，macOS 13 或更新。

1. 解压 `AgentCompanion-0.4.19-macos-arm64.zip`。
2. 把 `AgentCompanion.app` 拖到“应用程序”，也可放在用户自己的 `Applications` 目录。
3. 打开应用。当前采用临时代码签名，尚未 Apple 公证；首次如被系统阻止，请按 macOS“隐私与安全性”的正常允许打开流程处理，也可从仓库源码构建。不要关闭系统的全局安全检查。
4. 用数据线连接已安装配套固件的屏幕。默认 USB 优先，看到“USB 已连接”才表示实际收到屏幕回执。
5. 在 **Agent** 页选择 1–3 个本机来源；没有找到记录的来源会显示未知。Grok Bot 只展示缓存消息和可读额度，不推断实时执行状态或 Token。

程序、Gateway 和屏幕预览已包含在安装包中，普通运行不需要另装 Bun、Python 或编译工具链。首次安装不附带任何人的账号配置、API Key、Wi-Fi 密码、中转地址或访问令牌。

## 按需开启 API

- **AI 助手**：在“API 设置”填写你自己的兼容 API 地址、模型和 Key，再在助手页更新简报；自动整理按变化合批，不重复提交完整长历史。
- **DeepSeek 余额**：填写你自己的 DeepSeek 官方 Key；仅用于余额查询，不调用推理。没有 Key 可继续使用会话监控。
- **语音**：单独配置 TTS 服务、模型、音色与 Key，开启语音生成，再到“语音播报”开启播报并选择类别。声音由监视器播放；Mac 不会自动代播。
- **远程连接**：仅 USB 或同一 Wi-Fi 不需要云服务器。异地使用请自行部署中转，并填入自己的 WSS 地址及分别生成的 Mac／屏幕令牌；首次通过 USB 下发给板子。

板端“工具 → 声音与音量”可设置音量、静音与停止；0–100% 对应驱动 0–100 档。板端“工具 → Wi-Fi 网络”可在新环境直接配网，无需远程 Mac 在场。

个人配置保存在你本机 `~/Library/Application Support/AgentCompanion/`，不要上传或共享该目录。升级应用会保留它。模型服务会接收已开启功能所需的公开对话节选；仅本地监控不需要模型 Key。

完整说明：https://github.com/kuangda-source/agent-companion/blob/main/docs/SETUP.md
