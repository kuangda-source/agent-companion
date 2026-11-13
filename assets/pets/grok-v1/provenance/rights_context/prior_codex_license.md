# 角色立绘与设定授权 · CC BY-NC-SA 4.0

本目录（`characters/`）以及 `docs/prompts/`、`docs/images/` 中的角色立绘、角色设定与生图提示词，采用
**[知识共享 署名-非商业性使用-相同方式共享 4.0 国际许可协议（CC BY-NC-SA 4.0）](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)**。

你可以自由地转载、修改、二次创作，但须：

- **署名**：注明 CrossPet 以及下面列出的原作者；
- **非商业性使用**：不得用于商业目的；
- **相同方式共享**：基于这些素材的衍生作品也要用 CC BY-NC-SA 4.0 发布。

## 原作者与来源

这些角色都是社区对 AI 产品的拟人化二创，CrossPet 的立绘由 AI 生图工具按以下设定重新绘制：

| 角色 | 设定来源 |
|---|---|
| DeepSeek | 原型「溟月」：**上善无形**（2025-06，CC BY-NC-SA 4.0）；深蓝女仆鲸鱼娘（「大肥鱼」）：B 站 **ZipZipPipe** |
| GPT | 「御姐白龙」：B 站 **ZipZipPipe** |
| GLM | 黑狐狸女仆：B 站 **ZipZipPipe**（「心机涨价狐」的性格和专属动作是 CrossPet 的二创） |
| 千问 | 国风千金：B 站 **ZipZipPipe**（「温柔大方的千金」的性格和专属动作是 CrossPet 的二创） |
| 彩蛋（DeepSeek 把活外包给千问） | CrossPet 原创情节，基于以上角色 |
| Grok | 哥特小恶魔女王：B 站 **ZipZipPipe**（「爱查证、爱抬杠的小恶魔」的性格和专属动作是 CrossPet 的二创） |
| 彩蛋（DeepSeek 偷穿 Grok 的衣服） | CrossPet 原创情节，基于以上角色 |
| Gemini | 社区流行的 Gemini 娘设定（猫耳、异色瞳、四芒星发饰） |
| Claude | 社区流行的 Claude 娘设定（铜橙色长发、橙花发饰、书） |
| 彩蛋（DeepSeek cos Claude / GPT） | CrossPet 原创情节，基于以上角色 |

参考资料：[萌娘百科 DeepSeek 娘](https://zh.moegirl.org.cn/DeepSeek%E5%A8%98)、[ai-school-op](https://github.com/lshhhhhhh/ai-school-op)、[openpet-ai-girls](https://github.com/AwesomeHou/openpet-ai-girls)。

「Claude」「GPT」「ChatGPT」「Codex」「DeepSeek」「Gemini」「GLM」「Qwen」「千问」「Grok」「xAI」是各自公司的商标，本项目为非官方同人项目，与这些公司无关。

如果你是原作者并且对使用方式有异议，请在 GitHub 提 Issue，我们会第一时间修改或移除。


---

## 本包适配与补充署名

CrossPet（lokicorvus 与贡献者）；设定来源：B站 ZipZipPipe「御姐白龙」。

原作：https://github.com/lokicorvus/crosspet ，固定提交 `5c64326b6e7fc175eda0360c0bb5c4732541d138`。

改动：等比缩放、透明补边、脚底锚点对齐、sRGB/straight-alpha 规范化、状态映射和文件封装；未重绘立绘，未制造中间动画帧。规范 PNG 延续 **CC BY-NC-SA 4.0**。

上游 README 的权利边界：仅本项目有权授权的内容适用其授权；社区既有设定及第三方作品的权利以各自来源为准。此包不构成独立权利清除、官方授权或商用授权。

完整许可条款：https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.zh-hans


## V1.1 Codex 动画小样
2026-10-30，clea 使用 OpenAI 内置图像生成工具，基于上述角色重新生成 idle/running 动作图集；确定性等分切帧、透明散点清理、每动作统一缩放与补边、sRGB 标记。衍生素材沿用 CC BY-NC-SA 4.0。非官方角色，非独占原创，非商用授权。


## 修正版 R2，2026-10-31
clea 使用 OpenAI 内置图像工具制作局部工作姿态，基于原小样 idle 稳定底稿做局部合成与有界网格动画，再烘焙为完整 PNG。保留原头脸、龙角、衣饰及整体比例；不是逐帧全身重绘。沿用上文 CC BY-NC-SA 4.0，非官方、非独占原创、非商用许可。

## 完整七动作，2026-10-31
clea 基于既有固定人物底稿，使用 OpenAI 内置图像工具绘制局部状态表情/手势，通过局部合成与有界网格动作烘焙44张完整PNG。idle保留已确认R2，working加强整手/手腕动作；新增其余五状态。沿用上文许可及原作者署名，不是独占原创或官方授权。
