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
- 定时任务只读 Codex 元数据，不创建、触发或修改原自动化。运行优先于后续计划。
- 助手的聊天与项目整理使用 Mastra，应用持有来源引用、预算与规范记忆。Letta 仅预留端口。语音、声纹、唤醒、TTS、OTA、音量控制尚未接入。
- 主屏亮度使用 macOS DisplayServices 读取，不是物理亮度校准；部分外接屏不可读，回退手动亮度。跟随熄屏保留网络。
- Gateway 子进程退出时由运行中的 Mac 应用自动恢复；不是系统级常驻服务，也不覆盖整个应用退出/卡死。
- V1 为卡片式界面；共享可交互房间与三渲二场景属于后续 V2，本仓库不包含未完成的 V2 草稿。

## 贡献与隐私

保持增量修改。不要提交 `.runtime/`、应用数据目录、真实会话、数据库、固件全盘备份、证书私钥或配网文件。Issue 和录屏请使用 MOCK 数据。通过 PR 提交代码，说明改动目的、测试与硬件验证范围。
