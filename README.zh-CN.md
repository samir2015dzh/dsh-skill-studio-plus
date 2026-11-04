<div align="center">

  # DSH Studio

  **技能工作台 + MCP 按需加载，一个插件管完**

  [简体中文](README.zh-CN.md) · [功能](#功能) · [合并怎么工作](#合并怎么工作) · [安装](#安装) · [改动记录](FORK-NOTES.md)

  ![License](https://img.shields.io/badge/License-MIT-blue.svg)
  ![DSH](https://img.shields.io/badge/DSH-Plugin-0f766e.svg)
  ![Fork](https://img.shields.io/badge/Fork-zhengjy01%2Fdsh--skill--studio-6b7280.svg)
  ![Version](https://img.shields.io/badge/Version-0.7.0-2563eb.svg)
</div>

> Fork 自 zhengjy01/dsh-skill-studio，不是 DeepSeek AI 官方产品。上游提供 skill 可视化、编辑与手动提取；
> 本 fork 补上「无人值守」需要的四件事（每轮判断、自动入库、语义合并、模型跟随 DSH），
> 并加了 MCP 按需加载、三层筛选、回收站与按用途分类。

## 功能

在 DSH 里跑着不用管，它会自己判断这一轮学到了什么、该并进哪个 skill、并进去之后会不会重复。

- **每轮自动判断值不值得记**：一轮对话结束 3 秒后发一个只要 YES/NO 的小请求（最近 1 个会话的 10 条摘要），判 YES 才跑完整提取。判定最少间隔 90 秒，提取最少间隔 5 分钟。
- **自动入库，不进候选队列**：提取出的候选直接写进 `~/.agents/skills`，DSH 立刻能加载。写入失败（同名冲突等）才留在队列里等人工处理。
- **语义合并而不是堆新文件**：拿新候选跟全部既有 skill 比对，能并进就并进，只有确实是新主题才新建。实测同一类工作流换个措辞后，词面相似度只有 0.07–0.24，所以本地相似度只做粗筛，最终由模型看整份清单裁决。
- **模型跟随 DSH**：面板下拉列出你 DSH 里配置的 provider/model，留空就跟随触发这次提取的会话。插件自己不再存 API key，也不再要求填网关地址。
- **面板看「最近添加」**：技能工作台列出最近改动过的 skill（名字 + 描述 + 时间），一眼看到它这两天自己学了什么。
- **写进去的内容是干净的**：合并时自动去掉模型重复抄写的章节，切掉 `MERGE:` 这类协议残渣，拦住比原文短一大截的覆盖。
- **skill 体检**：写出一个 `SKILL.md` 后，下一轮自动把它推给 `darwin-skill` 按 9 维 rubric 体检。同族重复项按 `~/.dsh/darwin-auto/families.json` 折叠到一个宿主，表由插件自己的模型通道定期重聚（0.5.0 起并入了原 `dsh-darwin-auto` 插件）。
- **三层筛选**：来源（全部 / 用户 / 内置）、启用状态（已启用 / 已停用）、用途分类（逆向 / 安全 / 代码 / 文档 / 运维 / 数据 / 流程 / 其他），三者是「与」的关系；状态与分类组再点一次已选中的胶囊即取消。
- **按用途分组**：提取时模型必须从固定 8 类里选一个写进 `metadata.group`，合并旧 skill 时保留原分类。存量技能用 `node scripts/classify-skills.mjs --write` 按关键词批量归类（先看 `--limit` 出的明细，每个文件写前备 `.bak-group`）。
- **回收站**：行右侧「删除」把目录移进 `~/.dsh/dsh-studio/trash/<时间戳>-<名>/`，面板「回收站」页可整批或单项恢复、永久删除。
- **多来源扫描**：除 DSH 与公共 Agent 目录，还扫 Codex / Claude / Cursor / Gemini / Windsurf / Trae / Qoder / Lingma / OpenCode / Copilot / Roo / CodeBuddy / WorkBuddy / OpenClaw / CC-Switch，目录存在才加入。
- **诊断**：frontmatter 的 `name` 不是 kebab-case 时标「宿主不认这个名」——这类技能面板看得见、宿主加载不了；跨来源同名时标出「被 X 盖住」。

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
git clone <this-repo> D:/dsh-plugins/dsh-studio
```

2. 在 profile 的 `package.json` 里登记：

```json
{
  "dependencies": { "dsh-studio": "link:D:/dsh-plugins/dsh-studio" },
  "dsh": { "profile": { "bundles": ["dsh-studio"] } }
}
```

3. 建目录联接，让 `node_modules` 解析到本目录：

```powershell
New-Item -ItemType Junction `
  -Path "$env:DSH_PROFILE_DIR\node_modules\dsh-studio" `
  -Target "D:\dsh-plugins\dsh-studio"
```

4. 重启 DSH，打开 **设置 → Skill 工作台**。

## 配置

配置文件：`~/.dsh/dsh-studio/extractor.json`（0600 权限）。

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
| `skillmgr_trash` | 把一个技能移进回收站（不真删，可恢复） |
| `skillmgr_trash_list` | 列回收站里的批次与条目 |
| `skillmgr_restore` | 从回收站搬回原位置 |
| `skillmgr_purge` | 永久删除回收站条目 |

HTTP 路由挂在 `/api/dsh-studio/*`，面板用的就是它们。

## MCP 按需加载

设置页「MCP 服务器」：把 DSH 里已有的 MCP 收进面板，按需加载、空闲回收、可视化白名单。

- 三档：**启用**（工具直接注册成 `mcp__<server>__<tool>`）/ **按需启用**（只进目录，用时 `mcp_load`）/ **停用**
- 目录里只有「服务器名 + 每个工具的名字和截断描述」，完整 schema 要 `mcp_load` 才取，调用走 `mcp_call`
- 空闲 N 分钟（默认 5，可改）没有任何工具调用就断开上游（stdio 子进程退出 / HTTP 会话关闭），工具缓存保留，下次调用透明重连
- 每行点「工具 N/M」展开完整工具清单，勾选决定对外可见的那批，改完即时生效——不用重启 DSH，也不用重启上游
- 启动时自动扫 profile 与各 bundle 的 `cordis.patch.yml`，把 `@deepseek-ai/dsh-mcp-client` 条目抄进面板（停用档，不连接）；点「接管」才禁用原生条目，重启后由本插件接管
- 凭据默认掩码：`authorization` / `api_key` / `token` / `secret` / `password` / `cookie` 这类头与环境变量显示成 `••••••••` + 尾 4 位，点「显示」看明文、点「复制」写剪贴板。非凭据类环境变量（`GHIDRA_INSTALL_DIR`、`PATH` 等）不进面板
- 工具栏可按服务器名 / 备注搜索，右下两排胶囊按档位与连接状态过滤

工具：`mcp_list` / `mcp_register` / `mcp_load` / `mcp_call` / `mcp_takeover`。

配置位置 `~/.dsh/dsh-studio/mcp.json`，HTTP 路由在 `/api/dsh-studio/mcp*`。
详细配置、字段说明与已知限制见 [MCP.md](./MCP.md)。

## 调试

每次调模型的原始输出会留在：

```
~/.dsh/dsh-studio/last-llm-raw.txt
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
