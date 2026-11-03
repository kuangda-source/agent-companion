# 开发说明

## 源码入口

- `apps/macos/`：SwiftUI 控制端，管理自身 Gateway/预览子进程，修改配置并采样主屏亮度与熄屏。
- `apps/gateway/`：Bun 本机只读采集、Token 账本、额度/余额、助手、私有 LAN 与中转客户端。
- `apps/device/`：ESP-IDF P4 7B 固件，Wi-Fi/配对配置由 USB 输入；无内置账号和默认密码。
- `apps/simulator/`：SDL2 + LVGL 的 Mac 预览，与板端共用 UI。
- `apps/relay/`：单 Mac / 单屏幕的无数据库 WSS 转发服务。
- `packages/ui/`、`client-core/`、`protocol/`：共享 UI、状态/动画与协议。
- `packages/dsh-superagent-core/`：固定来源的 MIT 事件处理核心；没有启用其自主编码执行器。
- `assets/pets/`：128px 透明 PNG 七态动画、时间轴和脚底锚点。见资源清单/schema；不要叠加全身呼吸位移。

## 验证

```bash
./scripts/dev check
.venv-dev/bin/python -m unittest discover -s tests -p 'test_device*.py'
./scripts/device build rev3_x
```

测试使用临时目录、合成会话与模拟推理，不需要真实 Key。`tests/fixtures/` 均为测试数据。硬件显示、触摸、网络恢复和外接屏亮度需要另做真机验收；编译成功不等于真机通过。

## 当前边界

- Codex 本机记录、Claude Code JSONL、DeepSeek Harness 本机记录只读，具体兼容性取决于来源软件记录结构；不发消息/暂停原 Agent。缺失来源保持未知。
- 定时任务只读 Codex 元数据，不创建、触发或修改原自动化。运行优先于后续计划。Mac“屏幕 → 显示定时任务”控制列表可见性，小屏不再有独立的会话/定时切换按钮。关闭后仍保留真实会话。
- 助手的聊天与项目整理使用 Mastra，应用持有来源引用、预算与规范记忆。Letta 仅预留端口。语音、声纹、唤醒、TTS、OTA、音量控制尚未接入。
- 主屏亮度使用 macOS DisplayServices 读取，不是物理亮度校准；部分外接屏不可读，回退手动亮度。跟随熄屏保留网络。
- Gateway 子进程退出时由运行中的 Mac 应用自动恢复；不是系统级常驻服务，也不覆盖整个应用退出/卡死。
- V1 为卡片式界面；共享可交互房间与三渲二场景属于后续 V2，本仓库不包含未完成的 V2 草稿。

## 贡献与隐私

保持增量修改。不要提交 `.runtime/`、应用数据目录、真实会话、数据库、固件全盘备份、证书私钥或配网文件。Issue 和录屏请使用 MOCK 数据。通过 PR 提交代码，说明改动目的、测试与硬件验证范围。


## Codex 额度补查

本机日志约每 2 秒随会话采集；有确认运行中的 Codex 轮次时，每分钟用官方 CLI 的 `account/rateLimits/read` 核对一次。空闲且剩余额度严格低于 20% 时每小时补查，恰好 20% 或更高则不做空闲轮询。启动、系统/显示器唤醒、新运行轮次、全部结束与预计重置时间是独立的补查触发；到点只查询，不推算额度恢复。日志不会因 15 分钟空闲而被清除。

优先使用已运行的 app-server 代理；不可用时临时启动官方 app-server，仅发送 initialize / initialized / account/rateLimits/read，结果读取后退出并回收进程。不会创建会话、调用模型、重置额度或修改 Codex 原配置。需有已登录的官方 Codex CLI；在 PATH 与官方 Mac 应用位置自动发现，也可自行设置 CODEX_CLI_PATH。无可用 CLI/登录时保留本地最后读数，查询失败不影响设备通道。凭据由官方 CLI 自行管理，应用不提取 OAuth 文件或把令牌转发给板子/中转。

私有运行目录的 codex-quota.json 只缓存额度观测（600 权限），不含密钥。管理 API /api/v1/quotas/status 可查看调度状态，POST /api/v1/quotas/refresh 仅接受固定 wake/manual 原因；均沿用 loopback 鉴权与 Origin 检查。官方协议依据：https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt 。
