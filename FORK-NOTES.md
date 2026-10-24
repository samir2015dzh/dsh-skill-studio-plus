# 本 fork 相对上游的改动

基线：`zhengjy01/dsh-skill-studio` v0.3.1
改动时间：2026-10-23

## 1. 模型走 DSH，不再自己存 API key

`lib/extractor.js`

- 新增 `pickRoute()` / `resolveProviderModel()`：依次尝试
  1. 配置里的 `provider` / `model`（默认空）
  2. 当前 agent 的 route / config / options
  3. `ctx.llm.listProviders()` 的第一个可用供应商及其首个模型
- 新增 `callViaDsh()`：走 `ctx.llm.prepareCall({provider, model, maxTokens})` +
  `prepared.stream({...prepared.config, system, messages})`，只累加 text 块。
- `callLLM()` 新增 `llm` / `agent` / `system` 参数：**有 llm 就走 DSH**，没有才回退到
  原来的 HTTP 实现（`llmBaseUrl` / `llmApiKey` / `llmModel`，现在默认为空）。
- `lib/index.js` 的 `inject` 加 `"llm"`；`apply()` 里记录最近一次 `agent/created`，
  统一通过 `runExtract()` 传入 `{ llm: ctx.llm, agent: lastAgent }`。

配置里 `llmBaseUrl` / `llmApiKey` / `llmModel` 已清空 —— 不配也能跑。

## 2. 自动接受（不进候选队列）

`lib/extractor.js` · `runExtraction()`

`cfg.autoAccept === true` 时，候选直接 `writeSkillDual()` 落盘；只有写失败（同名已存在等）
才留在待确认队列。返回体新增 `accepted: [{name, path}]`。

配置项：`autoAccept`（默认 false，本机已设 true）。

## 3. 语义合并相似 skill

`lib/extractor.js`

- `buildSkillIndex(dir)`：读目标目录所有 skill 的 name/description/正文，建 token 索引。
  token = 英文词 + **中文 2-gram**（整段中文当一个 token 会永不匹配）。
- `bestMatches(index, cand, n)`：Jaccard 相似度取 top-n。
- `tryMerge()`：命中阈值后把「既存 skill 全文 + 新候选」交给模型，返回
  `KEEP` 或 `MERGE: <更新后正文>`；MERGE 时 `writeSkill(force: true)` 覆写主 skill。
- `runExtraction()` 主流程改成：语义合并 → autoAccept 落盘 → 剩下的进队列。

配置项：`mergeThreshold`（默认 0.2，本机已设 0.2）。
实测参考：相关候选 0.26–0.32，无关候选 0，所以 0.2 是安全线。

## 4. 回合结束也触发提取

`lib/index.js`

抽出 `extractIfDue()`，由两处调用：

- `ctx.interval(..., 60s)` —— 原来的定时轮询
- `ctx.on("agent/turn-stopping")` —— 回合收尾后延迟 3s 再跑

冷却仍由 `intervalMinutes` 控制（本机 30 分钟），避免每轮都调模型。

## 5. description 加 YAML 引号

`writeSkill()` / `assembleCandidateFile()` 的 frontmatter：

```js
description: ${JSON.stringify(String(cand.description ?? ""))}
```

描述里含 `": "` 或结尾冒号时，原来会 YAML 解析失败 → DSH 静默丢弃该 skill。

## 配置（`~/.dsh/dsh-skill-studio/extractor.json`）

```json
{
  "enabled": true,
  "intervalMinutes": 30,
  "autoAccept": true,
  "mergeThreshold": 0.2,
  "llmBaseUrl": "",
  "llmApiKey": "",
  "llmModel": ""
}
```

## 安装方式

profile `package.json`：

```json
"dsh-skill-studio": "link:D:/dsh-plugins/dsh-skill-studio"
```

`node_modules/dsh-skill-studio` 是指向本目录的 Junction；npm 原版备份在同目录
`dsh-skill-studio.bak-npm`。

## 回滚

```powershell
cd "$env:DSH_PROFILE_DIR\node_modules"
Remove-Item dsh-skill-studio -Force
Rename-Item dsh-skill-studio.bak-npm dsh-skill-studio
# 再把 profile/package.json 的依赖改回 "0.3.1"，重启 DSH
```

## 未验证

- `ctx.llm.prepareCall` 的 `stream()` 在真实 DSH 运行时返回的 chunk 类型（现在兼容
  `text-delta` 与 `block-end.text` 两种；若都不匹配会报「返回空内容」）。
- `agent/created` 在 web profile 下是否一定会触发（不触发时回落到 `listProviders()`）。
- 语义合并的真实 LLM 判定质量（只做了索引与分支的单元验证）。

## 6. LLM 输出的 JSON 容错（2026-10-23 真机暴露）

模型返回的不是裸 JSON 时（带 ```json 围栏、尾随解释、多个对象串联），原来的
`text.match(/\{[\s\S]*\}/)` 是贪婪匹配，会把后面的内容一起吞进去导致
`Unexpected non-whitespace character after JSON`。

现在：

- `stripFence()` 去掉 ```json 围栏
- `firstJsonObject()` 用括号配平扫描取第一个完整对象（忽略字符串内的花括号与转义）
- `tryMerge()` 的 `MERGE:` 解析同样先过 `stripFence()`

已用 5 种畸形输出验证：裸 JSON / 带围栏 / 尾随解释 / 两个对象 / 字符串含花括号，
全部能正确取到 1 个候选。

## 7. 归属裁决改由模型看全量清单（2026-10-24 真机暴露）

现象：19:55–01:29 自动提取跑了 24 次，生成 24 个新 skill，其中大量是同义重复
（GUI 验证 7 个、离线补丁 3 个、反编译重建 4 个、二进制对拍 2 个、OOM 1 个、交接 1 个）。

实测这 24 个与既有 skill 的 token 相似度只有 **0.07–0.24**，本地 Jaccard 根本抓不住
「措辞不同、做的是同一件事」，所以 mergeThreshold=0.2 几乎拦不住。

改法：新增 `judgePlacement()`，把**整份既有 skill 清单（name + description）+ 新候选**
交给模型，逐条输出 `FOLD_INTO: <已有名>` 或 `SAVE`；本地相似度只保留为兜底
（阈值提到 `mergeThreshold * 2`）。调用序列变成 `extract → placement → merge`。

清理：已把这 22 个重复项移到 `~/.dsh/skill-archive-auto-20261024/`；
4 个子代理/证据门禁类的新主题合并成新 skill `subagent-evidence-gate`；
`java-crypto-classloader-recovery` 是真新主题，保留。skill 总数 177 → 156。

## 8. 模型可选（面板下拉）

- `extractor.js`：新增 `provider` / `model` 配置；`resolveProviderModel()` 优先用它们，
  留空则跟随触发这次提取的会话（`agent/turn-stopping` 的 payload.agent），再回落到
  最近活跃 agent / 第一个可用供应商。
- `runtimeState.lastRoute` 记录实际解析出的 provider/model。
- `index.js`：新增 `listAvailableModels(ctx)`（读 `ctx.llm.listConfigurableProviders()`
  的 settings 里的 models 数组）与 `resolveSettingsReader(ctx)`；`/api/.../extractStatus`
  返回 `availableModels` + `resolvedModel`。
- `client.js`：模型输入框改成下拉（「自动（跟随当前会话）」+ 各 provider/model），
  状态行显示「（实际用 provider / model）」。

## 9. 每轮先判定「值不值得总结」

原行为：`agent/turn-stopping` 直接跑完整提取（3 个候选 × 全量裁决 + 合并，好几次模型调用）。

现在：`judgeThenExtract()` 先发一个小 prompt（最近 1 个会话的 10 条摘要，maxTokens 16），
只要 `YES` / `NO`：

- `YES` → 才跑完整提取
- `NO` → 什么都不做，只记一条 `turn verdict: NO` 日志

节流：判定最少间隔 3 分钟，判定通过后的提取最少间隔 10 分钟。
配置项 `autoPerTurn`（默认 true）可整条关掉。

`extractIfDue(agent, force)` 的 `force` 让「判定通过」绕过 `intervalMinutes`（30 分钟）那道冷却。

## 10. 面板「待确认候选」→「最近添加的 skills」

- `extractor.js`：新增 `recentSkills(dir, limit)`，按 SKILL.md 的 mtime 倒序，
  返回 `{name, description, path, mtime}`。
- `index.js`：新增路由 `GET /api/dsh-skill-studio/extract-recent`。
- `client.js`：候选区改成「最近添加的 skills（N）」，每条显示 **名字 + 描述 + 修改时间**；
  待确认候选只在**非空时**才另外显示（写失败才会入队，平时看不到）。

## 11. 墓碑拦截 + 时间显示 + 定时间隔（2026-10-24）

- `archivedNames()`：扫 `~/.dsh/skill-archive*` 的目录名，得到「以前被合并过」的名字集合。
  `runExtraction()` 里命中墓碑的候选**强制并入最接近的既有 skill**（不再新建）。
  实测 `context-handoff-doc → handoff`（0.26），正是期望目标。
- 面板与工具里的 `lastRunAt` 改成 `toLocaleString()`（本地时分），原来只显示到日期。
- 配置 `intervalMinutes` 30 → 120：及时性交给「每轮判定」，定时只做兜底。
- `shouldExtract()` 的判定 prompt 增加排除项：**关于工具/插件本身如何配置或实现的元讨论不算**。
  否则我们讨论这个插件的过程本身会被判成 YES，反复生成「skill 管理」类的元 skill。

## 12. 类别标签 + FOLD_INTO 本地复核（2026-10-24）

背景：`judgePlacement` 会把 `decompiled-java-semantic-check` 错并到 `java-legacy-parity-probe`
（反编译验证塞进遗留 Java 对拍）。纯靠描述字面判断不可靠。

### 类别标签

- `CATEGORY_ALIASES` + `categoryOf(name)`：按名字前两段 / 首段归一到粗类别
  （gui / handoff / decompile / java / portable / parity / android / bgjob / oom / probe /
  audit / verify / skillmgmt / subagent）。`java-decompile-*` → decompile、`java-oom-*` → oom 等有专门别名。
- `buildSkillIndex()` 的每项带上 `category`；`judgePlacement()` 的清单行变成
  `- [类别] 名字: 描述`，system prompt 明确要求「先看类别，类别不同就不要合并」。

### 本地复核

`runExtraction()` 里对模型的 `FOLD_INTO` 再校验一次：

```js
sameCat = categoryOf(candidate) === categoryOf(target)
sim     = similarityOf(candidate, target)
允许合并 ⇔ sameCat || sim >= mergeThreshold * 1.5
否则改判 SAVE（rejected 标记，且跳过后面的本地相似度兜底）
```

实测三组：

| 候选 → 目标 | 同类 | 相似度 | 结果 |
|---|---|---|---|
| decompiled-java-semantic-check → java-legacy-parity-probe | 否 | 0.130 | 改判 SAVE ✅ |
| swing-gui-change-verification → gui-real-entry-verify | 是 | 0.080 | 允许合并 ✅ |
| context-handoff-doc → handoff | 是 | 0.268 | 允许合并 ✅ |

注意第二行：同类时相似度只有 0.08 也能合并 —— 这正是纯 Jaccard 抓不到、需要类别补位的地方。

### 回归

`scripts/e2e-preview.mjs` 现在覆盖 6 项断言（含跨类别拒绝），全部通过。

已知残留风险：类别按名字前缀推导，名字起得离谱（如 `foo-bar` 描述反编译）会归到 `foo`，
复核会误判。这种情况只能靠 prompt 里「类别不同就不要合并」兜住。

## 13. 墓碑命中时强制合并（2026-10-24）

真机现象：`long-session-handoff-split`（归档过的名字）还是被写进了目录。

原因链：
1. 墓碑命中 → `bestMatches` 选中 `agent-handoff-review-report`（0.25）
2. `tryMerge()` 调模型做正文合并
3. 模型回答 `KEEP`（认为内容不同类）
4. 代码落到 `survivors` → autoAccept 直接落盘

修法：

- 新增 `MERGE_SYSTEM_FORCE`：不给 KEEP 选项，明确「这个名字以前合并过，必须并入」，
  并且「确实没有新内容就原样返回既存正文」。
- `tryMerge(cfg, llm, agent, hit, cand, { force })`：墓碑命中时 `force: true`，
  跳过 KEEP 判断，长度下限从 40 降到 10。
- 合并仍失败时（force 也没拿到 MERGE）→ **丢弃候选**（记入 `dropped`），不再新建重复。
  消息里会显示「丢弃 N 个已归档同名（…）」。

回归：`scripts/e2e-tombstone.mjs`（模型故意说 SAVE + KEEP，墓碑仍须压过）与
`scripts/e2e-preview.mjs`（6 项断言）全部通过。

## 14. 合并结果重复 + 历史脏数据清理（2026-10-24）

真机暴露：`handoff/SKILL.md` 13.7KB，10 个二级标题变成 20 个 —— 模型回「完整更新后正文」时把原文又抄了一遍。

修法：

- `dedupeBody(body)`：从第二个**同名二级标题**起截断。注意正文可能以 `## 概述` 开头
  （没有前导换行），所以先补一个 `\n` 再查找，否则一个重复都找不到（第一版就是这个 bug）。
- 合并结果 `< 原文 60%` → 视为模型截断，保留原文不动。
- 跨类别 FOLD_INTO 的兜底阈值从 `mergeThreshold*1.5`（0.3）提到 **0.5**：
  0.3 会让 `desktop-gui-real-entry-verification` 跨类并进 `bug-hunt-handoff-report`。

历史清理：批量去重 10 个文件（agent-handoff-review-report 5008→2506、
bug-hunt-handoff-report 3780→1918、decompiled-source-repair 7130→3603、
gui-real-entry-verify 7138→3790、java-crypto-classloader-recovery 3448→1741、
java-legacy-parity-probe 4708→2356、java-swing-standalone-probe 4037→2041、
oom-real-heap 3336→1689、handoff、agent-handoff-review-report 二轮）。

唯一保留的重复是 `wayfinder` 的 `## Out of scope`：一次在代码块示例里、一次在正文，合法。

## 15. 模型协议残渣 + 提取输出截断（2026-10-24）

两个真机问题：

**输出被截断**：3 个候选 × 1000+ 字正文，`maxTokens 4000` 装不下，模型写到一半断掉
（花括号 6 开 2 闭），整批报 `LLM response is not JSON`。

- 提取调用 `maxTokens` 4000 → 8000
- 新增 `salvageCandidates()`：JSON 不完整时逐个扫描 candidates 数组里已闭合的对象，
  能救几个算几个（实测从截断样本里救出 1 个完整候选）
- prompt 加约束：body 控制在 600–800 字，不贴大段源码

**协议残渣**：`MERGE:` 会被模型一起写进正文末尾，9 个 skill 中招
（handoff / gui-real-entry-verify / decompiled-source-repair / oom-real-heap 等）。

- 新增 `stripResidue()`：末尾出现 `MERGE:`（<300 字符）或 `KEEP`（<80 字符）就切掉
- 已手工清理那 9 个文件

同时归档了 `agent-handoff-review-report`（3042 字符）—— 与 `handoff` 语义完全重复
（desc 一个中文一个英文，Jaccard 只有 0.041，正是本地相似度失效的又一例）。
