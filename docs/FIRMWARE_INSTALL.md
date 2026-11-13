# ESP32-P4 板端固件安装

版本：V1-board-0.2.26。仅用于 **Waveshare ESP32-P4-WIFI6-Touch-LCD-7B，P4 rev3.x，32MB Flash / 32MB PSRAM，1024×600**。

请先识别实际芯片修订；本包不能用于 rev1.x、其他屏幕型号、ESP32-S3 或 C6。已在 P4 rev3.2 验证；未覆盖所有硬件修订组合。

## 包内文件

| 文件 | 写入偏移 |
| --- | --- |
| `bootloader.bin` | `0x2000` |
| `partition-table.bin` | `0x9000` |
| `agent_companion_device.bin` | `0x20000` |

不含 NVS、PHY 备份、Wi-Fi、配对令牌或服务器配置；不要把别人的整片 Flash 备份刷到自己设备。

## 准备与备份

先退出占用串口的 Mac 应用／开发终端。使用可传数据的 USB 线连接板子的 P4 USB1.1 / USB TO UART 接口，保持稳定供电。用系统的实际串口路径替换下文 `PORT`；不要照抄别人的端口。

可在 Python 虚拟环境安装官方 esptool，然后执行只读识别和备份：

```bash
python3 -m venv .flash-tools
.flash-tools/bin/pip install 'esptool>=5,<6'
.flash-tools/bin/python -m esptool --chip esp32p4 --port PORT chip_id
.flash-tools/bin/python -m esptool --chip esp32p4 --port PORT read_flash 0 0x2000000 factory-backup-32MiB.bin
```

备份含设备私有配置，留在本机并核对文件大小为 33,554,432 字节；不要上传 GitHub 或公开工单。第一次刷写会替换原厂应用与分区表；原厂演示不会与本应用同时保留，可用自己的完整备份恢复。

## 首次安装

确认型号、rev3.x、32MB 容量、完整备份和上述偏移后，在本包目录执行：

```bash
.flash-tools/bin/python -m esptool --chip esp32p4 --port PORT --baud 921600 write_flash --flash_mode dio --flash_freq 80m --flash_size 32MB 0x2000 bootloader.bin 0x9000 partition-table.bin 0x20000 agent_companion_device.bin
```

本命令不执行 `erase_flash`，不写入 NVS 文件；首次更换分区布局仍需保留完整备份，不能据此保证兼容未知原厂配置布局。

## 已安装本项目后的应用升级

**仅当现有 Agent Companion 使用相同分区布局（应用偏移 `0x20000`、大小 `0x1800000`）时**，可只更新应用：

```bash
.flash-tools/bin/python -m esptool --chip esp32p4 --port PORT --baud 921600 write_flash --flash_mode dio --flash_freq 80m --flash_size 32MB 0x20000 agent_companion_device.bin
```

保留已有 Wi-Fi、配对和音量。不要为普通升级执行全片擦除或刷入他人的 NVS。

## 首次使用

1. 打开配套 Mac 软件，默认 USB 同步；触摸左侧 Agent、右上角衣服图标和右下角工具，确认显示与触摸方向。
2. Wi-Fi 在 **工具 → Wi-Fi 网络** 扫描并保存。USB 已连接不等于 Wi-Fi 已连接；界面分别显示网络、主机与数据同步状态。
3. 同一网络时在 Mac 连接页通过 USB 配对局域网主机；异地需要先部署自己的中转，再下发自己的服务器地址及令牌。
4. 安装扬声器后再开启 TTS 测试。声音在板端播放；音量范围 0–100 对应驱动刻度，响度不按百分比线性变化。

安装完整手册：https://github.com/kuangda-source/agent-companion/blob/main/docs/SETUP.md
