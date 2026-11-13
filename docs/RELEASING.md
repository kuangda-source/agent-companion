# 发布与公开演示

仅发布程序、源码和合成演示。真实运行目录、原始会话、个人服务器、密钥、Wi-Fi、整片 Flash 与 NVS 不进入发布包。发布前同时检查 Git 当前树与历史。

## 构建与打包

```bash
./scripts/dev check
python3 tools/release/scan_public.py
./scripts/dev mac --output /tmp/agent-companion-release/AgentCompanion.app
# 确认芯片 profile 后按 docs/SETUP.md 构建固件；本步骤不会自动刷写
./scripts/device build rev3_x
```

先提交源码，记录 `git rev-parse HEAD`；使用该提交作为 `--source-commit` 参数。替换下面的占位参数及实际输出路径：

```bash
python3 tools/release/package_release.py --app /tmp/agent-companion-release/AgentCompanion.app --firmware .build/device-rev3_x --output /tmp/agent-companion-packages --source-commit SOURCE_COMMIT
```

输出目录必须使用新的 `package-staging`。脚本只复制三个指定程序文件，不读取板子备份。Mac 发布副本移除调试信息与诊断源码绝对路径后重新临时签名；不修改已安装应用。已保存的私有值仅用于本机负向匹配检查，不打印或上传。

请在隔离的 MOCK 运行目录验证打包后的 Gateway 与预览程序，核对签名与压缩包内容。打包不等于真机验收。版本号、发布说明、下载链接和固件目标需在每次发布前同步修改。

## 演示录制

在已有 FFmpeg 的环境运行：

```bash
python3 tools/release/record_demo.py --output /tmp/agent-companion-demo
```

直接录制共享 LVGL 帧缓冲，使用独立端口的 MOCK Gateway 和 SDL dummy 驱动；不采集桌面、麦克风或真实会话。输出包含两段 MP4、GIF 与首屏图。人工逐段检查画面与字幕后再复制到 `docs/media/` 并提交。

## 上传 Release

可使用自己的 GitHub CLI 登录态或网页上传。没有本机 API 令牌时，本仓库提供 GitHub Actions 的交付分支流程：

1. 源码、文档与演示提交到 main，创建对应发布 tag 并推送。
2. 打包目录仅保留两份 ZIP、`SHA256SUMS.txt` 与 `release-manifest.json`；manifest 必须对应当前源码与 tag。
3. 执行 `python3 tools/release/stage_publish.py /tmp/agent-companion-packages --tag v0.4.19 --push`。
4. 临时 `release-assets/v0.4.19` 分支触发发布。Actions 使用短期仓库令牌，校验 tag、父提交、文件清单与 SHA256，上传完整草稿后再发布预览版；不会使用本机模型密钥。
5. 下载并校验远端 Release 的包，确认首页链接可用后，删除该次临时交付分支。程序包只在 Release 作为长期下载入口，main 不跟踪二进制包。

该流程不创建长期 PAT，也不需要扩展访问本机文件。ZIP 曾作为公开交付分支的 Git 对象传输，因此必须在推送前完成全部脱敏；删除分支不能撤回已经公开的数据。
