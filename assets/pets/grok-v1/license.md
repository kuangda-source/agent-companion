# 来源、署名与权利边界

## 本次新角色的实际来源

本包为 clea 使用 OpenAI 图像生成工具制作的新 2D 角色与动画评审候选。已确认概念图是 `provenance/approved_concept.png`：黑色短发、G 形发夹、黑银紫哥特服饰。生成该概念图时，唯一图像风格参考是上一批三宠总览 `pet_v11_final/all_pets_seven_states_light.png`，并未直接使用旧 Grok 立绘作为图像参考。

后续动作图集以确认概念为角色依据。生成原始图集保留在 `../source/`，切帧、透明处理和统一画布的脚本为 `../tools/normalize_sheets.py`。它们不是手绘分层原稿或骨骼工程。实际生成提示词与生产记录以包内保留记录为准，不以本文件补造不存在的历史提示词。

## 三宠风格参考的来源与限制

风格参考中的 Codex/GPT、Claude、DeepSeek 来自既有 CrossPet 相关素材。保留 CrossPet（lokicorvus 与贡献者）署名及其原来源：

- 项目：https://github.com/lokicorvus/crosspet
- 先前三宠包记录的固定提交：`5c64326b6e7fc175eda0360c0bb5c4732541d138`。
- GPT「御姐白龙」设定来源：B 站 ZipZipPipe。
- DeepSeek「溟月」原型：上善无形；深蓝女仆鲸鱼娘相关设定：B 站 ZipZipPipe。
- Claude：社区流行的铜橙长发、花饰、书本拟人设定。

上游角色素材声明采用 CC BY-NC-SA 4.0，要求署名、非商业性使用、相同方式共享。上游能够授权的范围不自动涵盖第三方已有设定的全部权利。其实际角色许可文件原样复制到 `provenance/rights_context/crosspet_characters_LICENSE.md`；先前三宠各自的来源和制作记录原样保留于该目录的 `prior_*_license.md`。这些是上下文证据，不是声称上游原作者绘制了本次新像素。

许可说明：https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans
完整条款：https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.zh-hans

不得把“新生成”理解为已经取得独占原创权利、可以绕过参考材料限制，或已获得商业使用授权。本文件也不替第三方作出新的衍生许可。若实际使用构成受保护材料的改编，应遵守适用的原许可与第三方权利；是否构成改编、可适用何种保护和授权，不能仅凭生成方式确认。

## 名称与商标

Grok、xAI 及上述 AI 产品名称或标志属于各自权利人。本包为非官方角色制作，不代表与相关公司或原作者存在合作、认可或授权。不作商标许可、商用清权或版权有效性的保证。对外发布或商业使用前，使用方应核实生成服务条款、参考作品权利和名称标志使用范围。
