# Third-party notices

Agent Companion's own software is MIT licensed. This does not relicense any third-party work or included character assets.

| Component | Source / license |
| --- | --- |
| Pet character illustrations and animation derivatives | [CrossPet](https://github.com/lokicorvus/crosspet), community character settings and clea; **CC BY-NC-SA 4.0**, each `assets/pets/*/license.md` retains source, authors and modifications. Noncommercial asset license; replace assets for other uses as needed. |
| Source Han Sans | Adobe / SIL Open Font License 1.1; `assets/fonts/SourceHanSans-LICENSE.txt` |
| Sarasa Gothic / Term SC | be5invis and contributors / SIL OFL 1.1; `assets/fonts/SarasaTermSC-LICENSE.txt` |
| LVGL | LVGL contributors / MIT; downloaded at the version/hash in toolchain locks |
| SDL2 | SDL contributors / zlib; downloaded at the version/hash in toolchain locks |
| ESP-IDF, ESP-Hosted, Waveshare BSP and managed components | Respective authors/licenses in downloaded SDK and IDF component manager; versions pinned in `device-toolchain.lock.json`, component manifest and dependency lock |
| Mastra packages | Respective Mastra authors / community code Apache-2.0 (upstream `ee/` has separate terms and is not used by this project); pinned by `bun.lock`, original LICENSE files copied into built Mac app |
| DSH Superagent event core | DeepSeek / MIT, fixed upstream commit and modifications in `packages/dsh-superagent-core/UPSTREAM.json`, README and LICENSE |

The Mac bundler includes available dependency LICENSE/NOTICE files in `AgentCompanion.app/Contents/Resources/Licenses`. Third-party package managers download upstream sources rather than copying SDK/build caches into Git. No official endorsement by AI providers is claimed.
