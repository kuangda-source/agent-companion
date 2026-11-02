# 界面字体

界面使用 [Sarasa Term SC 1.0.43](https://github.com/be5invis/Sarasa-Gothic/releases/tag/v1.0.43) Regular / Bold（更纱等宽黑体），保留 `SarasaTermSC-LICENSE.txt` 的 OFL 许可。版本、归档哈希、两个字体文件哈希与许可哈希固定在 `dev-toolchain.lock.json.ui_font_mono`。仅安装到本项目 `.cache/fonts`，不更改系统字体。旧 Source Han Sans 许可与锁条目保留为早期构建记录。

`tools/dev/build_font.py` 通过固定版本 lv_font_conv 生成 16px 正文（CJK 统一汉字/扩展 A、常用中西文标点、Latin、Greek、数学符号）、13px 说明、20px 粗体和 22px 标题，输出到 `generated/fonts/`。数字与拉丁字母等宽，正文 16px 下 Latin 8px / 汉字 16px；不再混用 Montserrat。构建记录字集、行高与输入哈希。动态会话保留完整 CJK 字集，正文行高 20px，基线 4px；其它字号覆盖界面静态用字。未覆盖的 emoji 或生僻字不能保证显示。

这是界面字体管线；桌宠角色素材仍由 clea 提供，按 `docs/PET_ASSET_CONTRACT.md` 接入。
