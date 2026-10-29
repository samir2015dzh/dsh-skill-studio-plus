<div align="center">

  # DSH Skill Studio

  **每轮自动沉淀 · 语义合并去重 · 走 DSH 自己的模型**

  [简体中文](README.zh-CN.md) · [功能](#功能) · [合并怎么工作](#合并怎么工作) · [安装](#安装) · [改动记录](FORK-NOTES.md)

  ![License](https://img.shields.io/badge/License-MIT-blue.svg)
  ![DSH](https://img.shields.io/badge/DSH-Plugin-0f766e.svg)
  ![Fork](https://img.shields.io/badge/Fork-zhengjy01%2Fdsh--skill--studio-6b7280.svg)
  ![Version](https://img.shields.io/badge/Version-0.5.0-2563eb.svg)
</div>

> 本仓库是 [zhengjy01/dsh-skill-studio](https://github.com/zhengjy01/dsh-skill-studio) 的社区 fork，不是 DeepSeek AI 官方产品。上游提供 skill 可视化、编辑与手动提取；本 fork 在其之上补上「无人值守」需要的四件事：每轮判断、自动入库、语义合并、模型跟随 DSH。

## 功能

在 DSH 里跑着不用管，它会自己判断这一轮学到了什么、该并进哪个 skill、并进去之后会不会重复。

- **每轮自动判断值不值得记**：一轮对话结束 3 秒后发一个只要 YES/NO 的小请求（最近 1 个会话的 10 条摘要），判 YES 才跑完整提取。判定最少间隔 90 秒，提取最少间隔 5 分钟。
- **自动入库，不进候选队列**：提取出的候选直接写进 `~/.agents/skills`，DSH 立刻能加载。写入失败（同名冲突等）才留在队列里等人工处理。
- **语义合并而不是堆新文件**：拿新候选跟全部既有 skill 比对，能并进就并进，只有确实是新主题才新建。实测同一类工作流换个措辞后，词面相似度只有 0.07–0.24，所以本地相似度只做粗筛，最终由模型看整份清单裁决。
- **模型跟随 DSH**：面板下拉列出你 DSH 里配置的 provider/model，留空就跟随触发这次提取的会话。插件自己不再存 API key，也不再要求填网关地址。
- **面板看「最近添加」**：技能工作台列出最近改动过的 skill（名字 + 描述 + 时间），一眼看到它这两天自己学了什么。
- **写进去的内容是干净的**：合并时自动去掉模型重复抄写的章节，切掉 `MERGE:` 这类协议残渣，拦住比原文短一大截的覆盖。
- **skill 体检**：写出一个 `SKILL.md` 后，下一轮自动把它推给 `darwin-skill` 按 9 维 rubric 体检。同族重复项按 `~/.dsh/darwin-auto/families.json` 折叠到一个宿主，表由插件自己的模型通道定期重聚（0.5.0 起并入了原 `dsh-darwin-auto` 插件）。

## 合并怎么工作

一个候选要过四道闸才会落进库，任何一道认为不该合并，它就会变成新 skill（或按规则丢弃）。

```
新候选
  │
  ├─ ① 墓碑：这个名字以前被合并过（扫 ~/.dsh/skill-archive*/）
  │     → 强制并入同类里正文最长的那份；合不进就丢弃，绝不再写一份重复
  │
  ├─ ② 类别标签：清单写成 "- [decompile] 名字: 描述"，模型先看类别再看描述
  │     → 类别不同且描述不像，模型自己就不会选它
  │
  ├─ ③ 本地复核：模型给了 FOLD_INTO，再验一次
  │     → 同类直接放行；跨类别要求相似度 ≥ 0.5，否则改判 SAVE
  │
  └─ ④ 合并本身：让模型把新经验并进主 skill 的既有章节
        → 结果里重复的章节截断、协议残渣切掉、比原文短 40% 以上则拒绝
```

类别从名字推导（`gui-*` → gui、`decompiled-*` / `java-decompile-*` → decompile、`portable-*` / `offline-*` → portable ……），`CATEGORY_ALIASES` 在 `lib/extractor.js` 里，加一行就能扩。

## 安装

插件装在 DSH profile 里，用 `link:` 指向本目录，改代码不用重新发布。

1. clone 到本地任意位置：

```bash
git clone <this-repo> D:/dsh-plugins/dsh-skill-studio
```

2. 在 profile 的 `package.json` 里登记：

```json
{
  "dependencies": { "dsh-skill-studio": "link:D:/dsh-plugins/dsh-skill-studio" },
  "dsh": { "profile": { "bundles": ["dsh-skill-studio"] } }
}
```

3. 建目录联接，让 `node_modules` 解析到本目录：

```powershell
New-Item -ItemType Junction `
  -Path "$env:DSH_PROFILE_DIR\node_modules\dsh-skill-studio" `
  -Target "D:\dsh-plugins\dsh-skill-studio"
```

4. 重启 DSH，打开 **设置 → Skill 工作台**。

## 配置

配置文件：`~/.dsh/dsh-skill-studio/extractor.json`（0600 权限）。

```json
{
  "enabled": true,
  "autoPerTurn": true,
  "intervalMinutes": 60,
  "windowDays": 7,
  "maxCandidatesPerRun": 3,
  "autoAccept": true,
  "mergeThreshold": 0.2,
  "skillLanguage": "auto",
  "agentSkillDir": "C:\\Users\\<you>\\.agents\\skills",
  "provider": "",
  "model": ""
}
```

| 键 | 作用 |
| --- | --- |
| `autoPerTurn` | 每轮结束是否先做 YES/NO 判断 |
| `intervalMinutes` | 兜底扫描间隔；填 `0` = 只靠每轮判断 |
| `autoAccept` | 直接入库，不走候选队列 |
| `mergeThreshold` | 本地相似度粗筛阈值（合并判定主要由模型做） |
| `skillLanguage` | `auto` / `zh` / `en`，代码与命令一律不翻译 |
| `provider` / `model` | 留空 = 跟随会话；也可在面板下拉里选 |

`llmBaseUrl` / `llmApiKey` / `llmModel` 三个旧字段仍然兼容，只在 `ctx.llm` 不可用时作为 HTTP 回退；正常情况留空即可。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `skillmgr_list` | 列出所有 skill（含来源、启用状态、分组） |
| `skillmgr_get` | 读某个 skill 的完整内容 |
| `skillmgr_save` | 整篇写回 SKILL.md |
| `skillmgr_policy` | 启用/禁用模型调用与用户调用 |
| `skillmgr_extract_run` | 立即跑一次提取 |
| `skillmgr_extract_status` | 看开关、间隔、队列、上次运行时间 |
| `skillmgr_extract_config` | 改配置 |
| `skillmgr_extract_list` / `_accept` / `_reject` | 处理候选队列（自动入库开启时通常为空） |

HTTP 路由挂在 `/api/dsh-skill-studio/*`，面板用的就是它们。

## 调试

每次调模型的原始输出会留在：

```
~/.dsh/dsh-skill-studio/last-llm-raw.txt
```

解析报错时先看这个文件 —— 是 JSON 被截断、还是夹了 markdown 围栏、还是模型答非所问，一眼能分辨。

两个回归脚本不碰真实目录：

```bash
node scripts/e2e-preview.mjs    # 提取→裁决→合并→入库 全链路，6 项断言
node scripts/e2e-tombstone.mjs  # 墓碑压制模型裁决（故意让它说 SAVE + KEEP）
```

## 与上游的差异

完整清单见 [FORK-NOTES.md](FORK-NOTES.md)，共 15 条。要点：

1. 模型调用改走 `ctx.llm.prepareCall()`，插件不再存密钥
2. 每轮 YES/NO 判断 + 自动入库
3. 语义合并：类别标签、模型裁决、本地复核、墓碑拦截
4. 合并结果去重、去残渣、短正文拦截
5. 面板「最近添加的 skills」+ 模型下拉
6. 提取输出截断抢救、maxTokens 提到 8000

## 许可

MIT，与上游一致。上游版权归 zhengjy01。
