# 提取质量度量

自动提取流水线在真机持续产出 skill，但产出质量从未被度量。本文件是这条流水线的数据源审计（Q-1）、
只读聚合工具（Q-2）与实测记录（Q-3）。**只做度量，不改提取器行为，不新增任何定时任务。**

> **1.0.0 同步（2026-11-07）**：本文档已随 M-5 / M-6 / M-7 三批改动刷新口径 —— 裁决漏斗改按
> append-only 事件流水计数、候选接受/拒绝改由终局归档提供、lifecycle 补 `firstUsedAt` 与 `useCount`。
> Q-1 的审计结论保留为**改动前的现场记录**（用于说明当时哪些指标不可得及其原因），
> 与当前口径冲突处以本文档「Q-2 采用的定义」为准。

**总口径（贯穿全文）**：数据不存在时如实报不可得，不用假零充数。分母为 0、文件缺失、字段缺失时
返回 `available:false` + `reason`，比例给 `null` 而不是 0；不可得项同时进 `unavailable` 清单。
详见本文最后「总口径复述」。

## Q-1 数据源审计

### 结论

1. 三份数据都只以 skill 名字为键，没有任何记录带 candidate id 或运行 id —— join 只能走 `name`。
2. provenance 一个名字一个文件、后写覆盖前写，所以**按名文件的「全量计数」是名字的最终裁决状态数**，
   不是事件数。**M-5 起每次裁决另追加一行到 `provenance-events.jsonl`**，历史裁决可复盘；
   没有这份流水的旧数据仍只能取最终状态。
3. 没有运行日志：**「最近 10 次运行」不可恢复**；唯一可恢复的窗口是 `at` 的最近 30 天。
   事件流水按裁决记事件，不是按轮次记运行，仍不构成 run 维度。
4. lifecycle 最初只有 `lastUsedAt`。**M-7 起补 `firstUsedAt`（只写一次）与 `useCount`（每次 +1）**，
   「首次使用距入库天数」与「平均使用次数」在两者齐备时可得；老格式条目缺这两个字段时仍报不可得。
   「曾被使用」的定义不变：被 `markSkillUsed` 记过，那是写路径，不等于模型/人工真的调用过 skill。
5. 真机当前（2026-11-07 14:06）provenance 目录与 `skill-lifecycle.json` **都不存在**，candidates 3 条 pending。
   原因：宿主进程 2026-11-06 10:14 启动，而这两处写入点分别在 2026-11-07 09:03 / 09:11 才提交
   （`55a6c2e` lifecycle、`a4e8cb6` provenance）—— 在跑的实例不含这两个写入路径。

### 1. provenance 记录字段

写入点 `lib/extractor.js:618`（`writeProvenance`），按名文件路径
`~/.dsh/dsh-studio/provenance/<name>.json`，事件流水路径
`~/.dsh/dsh-studio/provenance/provenance-events.jsonl`。

按名文件（同名覆盖，保留最新裁决）：

| 字段 | 类型 | 取值 | 可作 join 键 |
| --- | --- | --- | --- |
| `name` | string | `normalizeName()` 归一 | 是（唯一跨源键） |
| `at` | string | ISO 时间；同一轮所有记录相同（`runExtraction` 的 `now`） | 仅用于时间窗口 |
| `action` | string | `SAVE` / `FOLD_INTO` / `tombstone` | 否 |
| `into` | string \| null | FOLD_INTO 的目标名 | 是（指向另一个 skill 名） |
| `source` | string | 固定 `session-extract` | 否 |
| `sessions` | string[] | 本轮扫描到的会话 id | 否（会话日志里没有 skill 名，无对照表） |
| `digest` | string | 本轮摘要 sha256 前 16 位 | 否（只在本轮内相同，无轮次表） |
| `rationale` | string | 模型给的裁决理由 | 否 |

事件流水（M-5，append-only，一行一条 JSON，0600 落盘）：

| 字段 | 说明 |
| --- | --- |
| `at` | 与按名文件同一次裁决的时间，ISO |
| `name` | 归一后的 skill 名 |
| `action` | `SAVE` / `FOLD_INTO` / `tombstone` |
| `rationale` | 裁决理由 |

`into` / `sessions` / `digest` 只留在按名文件里，流水只记四个字段 —— 复盘「谁被合并进谁、什么时候、
为什么」够用，不需要在流水里重复整份记录。

写侧事实：`lib/extractor.js:632` 覆盖同名文件，`:635` 追加一行事件。
三条裁决路径的写入见 `lib/extractor.js:1308-1316`：`accepted` → SAVE、`merged` → FOLD_INTO、
`dropped`（已归档同名且合并不进去）→ tombstone，即 DROP。

### 2. candidates 记录字段

写入点 `lib/extractor.js:1279`，路径 `~/.dsh/dsh-studio/candidates.json`（一个数组）。

| 字段 | 类型 | 取值 | 可作 join 键 |
| --- | --- | --- | --- |
| `id` | string | `${now}-${i}`，前缀是本轮开始毫秒 | 弱轮标识（只覆盖入队项） |
| `status` | string | 队列内实际只会是 `pending` | 否 |
| `created` | number | 毫秒 | 等待时长可算 |
| `sourceCount` | number | 本轮会话数 | 否 |
| `name` / `description` / `rationale` / `group` / `body` | string | 草稿字段 | `name` 是 |
| `guard` | object? | 守门命中的 `hits` | 否 |

`status` 只有一种取值：接受（`lib/index.js:1498`）与拒绝（`lib/index.js:1529`）都会把条目从主数组
移走。**M-6 起不再直接丢弃，而是追加进终局归档 `candidates-archive.json`**，所以「接受/拒绝」历史
可从归档复盘；主表仍然只有 pending。

终局归档（`lib/extractor.js:682` `archiveCandidates`）：

| 字段 | 说明 |
| --- | --- |
| 原候选字段 | `id` / `name` / `description` / `rationale` / `group` / `body` 等原样保留 |
| `decision` | `accepted` / `rejected` |
| `decidedAt` | 裁决时间，ISO |

滚动上限 `CANDIDATE_ARCHIVE_LIMIT = 500`：写入后超过 500 条就丢最旧的那几条
（`next.slice(dropped)`），所以归档条数到顶时，更早的历史已被丢弃 —— 度量侧用 `atCap`
如实标出这一状态，不当作「全部历史」。

### 3. lifecycle 记录字段

路径 `~/.dsh/dsh-studio/skill-lifecycle.json`（`lifecycle.js` 的 `lifecyclePath()`），键是 skill 名。

| 字段 | 类型 | 写入点 |
| --- | --- | --- |
| `lastUsedAt` | number（毫秒） | `markSkillUsed`（`lib/lifecycle.js:97`）：自动提取落库/合并、面板保存、darwin 回收结果 |
| `firstUsedAt` | number（毫秒） | 同上（M-7）：**只在第一次写入**，之后每次调用都沿用旧值 |
| `useCount` | number | 同上（M-7）：每次调用 +1，从 1 起 |
| `status` | `active` / `stale` / `archived` | `scanLifecycle`（`lib/lifecycle.js:149`、`:161`） |
| `lastCheckAt` | number（毫秒） | 同上 |

三者语义分工：`firstUsedAt` 用于「首次使用距入库」，`useCount` 用于「平均使用次数」，
`lastUsedAt` 仍是「距今多久没用」的判据（stale / archive 用），语义不变。

**入库时间**：lifecycle 本身不记入库时间，取 `provenance` 里同名**最早一次 SAVE** 的 `at`
（有事件流水时按流水算，无流水时按名文件算）。这样被再次裁决过的名字也不会把入库时间算晚。

### 4. join 键汇总

| 键 | 覆盖 | 说明 |
| --- | --- | --- |
| `name`（`normalizeName`） | provenance / 事件流水 / candidates / 归档 / lifecycle / skill 根 / 归档目录 | 唯一跨源键 |
| `candidates.id` 前缀 | candidates / 归档 | 归档里保留原 `id`，可回溯到入队轮次 |
| `provenance.into` | provenance ↔ skill 名 | FOLD_INTO 的目标 |
| `provenance.sessions` / `digest` | 仅 provenance 按名文件 | 无外部对照表 |
| 归档目录名（去 `-vN` / `.orig`） | 归档 ↔ skill 名 | 与 `archivedNames()`（`lib/extractor.js:1030`）同口径 |

### 5. 可得性一览（逐条给条件）

| 指标 | 状态 | 条件 / 原因 |
| --- | --- | --- |
| 每个 skill 被使用次数 | 可得 | `useCount`；老格式条目没有该字段时不参与平均 |
| 首次使用时间 | 可得 | `firstUsedAt`；只有旧格式条目的名字不可得 |
| 首次使用距入库天数（中位数） | 可得 | 需要 `firstUsedAt` **且** 同名有 `SAVE` 的 `at`，且首次使用不早于该入库时间 |
| 每个 skill 的裁决历史 | 可得 | `provenance-events.jsonl`；无流水时只能取最终裁决 |
| 轮次日志 / 最近 N 次运行 | 不可得 | 无 run 维度记录；事件流水是「裁决事件」，不是「运行」 |
| 接受率 / 拒绝率 | 可得（有上限） | `candidates-archive.json`；滚动上限 500，超出丢最旧，历史被截断时不算全量 |
| skill 是否真的被模型调用过 | 不可得 | lifecycle 只记写路径，不记读取/调用 |
| 入库时间 | 条件可得 | 有 SAVE 事件即可得（取最早一次）；该名字只有 FOLD/DROP 记录时不可得 |

### 6. 窗口口径裁定

- **采用**：最近 30 天，按 `provenance.at >= now - 30d`。
- **不采用**：最近 10 次运行。没有 run 维度记录；用 `at` 去重只能近似轮次，且被覆盖的记录缺项，
  属估算，不进入指标。事件流水补的是「裁决历史」，不是「运行历史」。

### 7. Q-2 采用的严格定义

| 指标 | 定义 | 分母 |
| --- | --- | --- |
| 漏斗 SAVE / FOLD / DROP | **有 `provenance-events.jsonl` 时按事件计数**（一条裁决 = 一个事件，同名的多次裁决都计入）；**无流水时回退**为按名文件的最新 `action` 计数 | 事件数 / 文件数（= 名字数） |
| 窗口计数 | 同上，仅 `at` 落在最近 30 天 | 窗口内事件数 / 文件数 |
| cohort | 最新裁决为 `SAVE` 的名字（口径不变，仍按名文件） | — |
| used | cohort 中 lifecycle 有有限 `lastUsedAt` 的名字 | cohort N |
| active | cohort 中仍存在于 skill 根（`agentSkillDir` / `mirrorDir`）且 lifecycle 状态不是 `archived` 的名字 | cohort N |
| archived | cohort 中命中归档目录名或 lifecycle `status=archived` 的名字 | cohort N |
| 首次使用距入库（中位数） | cohort 中同时有 `firstUsedAt` 与更早（或相等）的 `SAVE` 时间的样本，取天数的中位数 | 样本数 |
| 平均使用次数 | cohort 中 lifecycle 有有限 `useCount` 的名字，取算术平均 | 样本数 |
| 候选积压 | `status=pending` 条数；最老一条 `created` 起的等待天数 | — |
| 历史接受 / 拒绝 | `candidates-archive.json` 里 `decision` 为 `accepted` / `rejected` 的条数 | — |

**两种漏斗口径的区别**（输出里 `funnel.source` 与 `funnel.all.note` 会写明）：

| 口径 | 触发条件 | 一条记录代表 | 同名多次裁决 | 适用 |
| --- | --- | --- | --- | --- |
| `events` | 存在 `provenance-events.jsonl` | 一次裁决事件 | 都计入 | 新数据，历史可复盘 |
| `by-name` | 无流水（旧数据） | 一个名字的最终状态 | 只算最后一次 | 只能看终态分布 |

lifecycle 文件整体缺失时，`used` 报 `available:false`（不是 0/0 假比例）；provenance 目录缺失时漏斗同理；
`candidates-archive.json` 缺失时历史接受/拒绝报不可得。`firstUsedAt` / `useCount` 全部缺失时，
对应指标报不可得并给出缺哪个字段。

### 8. 真机现状（2026-11-07 14:06，只读，改动前现场）

| 数据源 | 现状 |
| --- | --- |
| `~/.dsh/dsh-studio/provenance/` | 目录不存在（0 条记录，也就没有事件流水） |
| `~/.dsh/dsh-studio/candidates.json` | 3 条，全部 `pending`，`created` = 1794010013675（等待 0.25 天） |
| `~/.dsh/dsh-studio/candidates-archive.json` | 不存在（该批次之前接受/拒绝无归档） |
| `~/.dsh/dsh-studio/skill-lifecycle.json` | 文件不存在 |
| `~/.dsh/skill-archive-*` | 6 个批次，去重后 189 个名字 |
| `~/.agents/skills` | 420 个名字（目录 + 平铺 `.md`） |

所以 Q-3 真机实测里 provenance 侧 N=0、cohort 为空、比例全部分母为 0 → 报不可得。这是数据现状，
不是工具缺陷；宿主重启加载新代码后才有数据。

## Q-2 只读聚合工具 `skillmgr_quality`

实现：`lib/quality.js`（聚合）+ `lib/index.js`（工具注册）。无参数，只读，不写任何文件。

数据源与 join：`provenance/` 下按名 JSON + `provenance-events.jsonl` + `candidates.json` +
`candidates-archive.json` + `skill-lifecycle.json` + 归档目录名 + `agentSkillDir` / `mirrorDir`
下的现存名字，全部按 `normalizeName` 归一后 join。

### 输出结构

```
{
  ok, message,                       // message = 一行摘要
  summary,                           // 同上（结构化字段里再给一次）
  funnel: {
    available, reason, source,       // source = "events" | "by-name"
    eventsFile, eventsSkipped,
    skippedFiles,
    all:    { save, fold, drop, total, other, note },
    window: { days, since, save, fold, drop, total, other }
  },
  cohort: {                          // cohort = 最新裁决为 SAVE 的名字
    n,
    used:     { count, denominator, ratio, available, reason },
    active:   { count, denominator, ratio, available, reason },
    archived: { count, denominator, ratio, available, reason },
    medianDaysToFirstUse: { available, value, samples, reason },
    avgUseCount:          { available, value, samples, reason }
  },
  backlog: { available, reason, pending, oldestCreatedAt, oldestWaitDays },
  history: {                         // M-6：候选终局归档
    available, reason, accepted, rejected, total, cap, atCap
  },
  unavailable: [ { metric, reason } ],
  sources: {
    provenanceDir, provenanceEventsPath, candidatesPath, candidateArchivePath,
    lifecyclePath, skillRoots, windowDays
  }
}
```

规则：比例一律带 `count` 与 `denominator`；分母为 0、文件缺失、字段缺失时 `available:false` +
`reason`，`ratio` 为 `null`，不填 0。

- `funnel.source` / `funnel.all.note` 明示本次用的是哪种口径（见 Q-1 第 7 节的对照表）。
- `active` = 名字仍在 skill 根里且 lifecycle 状态不是 `archived`。
- `archived` = 名字命中归档目录（`archivedNames()` 口径）或 lifecycle 状态为 `archived`。
- 窗口固定最近 30 天（Q-1 裁定），落在 `funnel.window`。
- `history.atCap` 为真表示归档已达 500 条上限、更早的终局已被丢弃，此时计数不是全量历史。

## Q-3 校验与真机实测

### 伪 HOME fixture

`tests/fixtures/quality-home.mjs` 在伪 HOME 里手工构造数据；`quality-history-home.mjs` 构造
「同一 skill 连续裁决 + 归档 + 使用计数」的场景。`tests/quality.test.mjs` 逐项断言：

| 数据 / 用例 | 期望值 |
| --- | --- |
| provenance：alpha（SAVE，10 天前）、beta（SAVE，40 天前）、gamma（FOLD_INTO→alpha，5 天前）、delta（tombstone，3 天前） | 全量 SAVE/FOLD/DROP = 2/1/1，4 个文件 |
| 窗口（30 天） | 3 条：beta 被排除 |
| cohort | N=2（alpha、beta） |
| used | 1/2（beta 的 lifecycle 记录缺 `lastUsedAt`，不算 used，也不报不可得） |
| active | 1/2（只有 alpha 仍在 skill 根） |
| archived | 1/2（beta 命中 `skill-archive-*` 目录） |
| 首次使用距入库中位数 | `available:false`，原因指向缺 `firstUsedAt` |
| 平均使用次数 | `available:false`，原因指向缺 `useCount` |
| candidates：3 条 pending（1 条缺 `created`）+ 1 条 accepted | pending 3，最老等待 2 天 |
| 删掉 provenance + lifecycle 后重跑 | 漏斗 / used 报不可得，`ratio` 为 `null` 而不是 0 |
| 两次聚合前后的伪 HOME 文件 sha256 | 完全一致（工具不写文件） |
| M-5：同一 skill 先 SAVE 再 FOLD_INTO | 按名文件保留终局（`FOLD_INTO`，`into` 与 `rationale` 为第二次的）；事件流水 2 条；有流水时 `funnel.source="events"` 且按事件计 SAVE 2 / FOLD 1（total 3） |
| M-5：删掉事件流水后重跑 | `funnel.source="by-name"`，total 回到 2 条文件，注脚仍是「按名字最新裁决」 |
| M-6：接受 1 条 + 拒绝 1 条 | 主表清空；归档 2 条，`decision` 分别为 accepted / rejected，带 `decidedAt` 与原 `id`；quality 报历史 1/1 |
| M-6：归档灌到超上限 | `dropped=2`、`total=500`，保留的是最近 500 条 |
| M-7：同一 skill 标 3 次使用 | `useCount=3`、`firstUsedAt` 停在第一次、`lastUsedAt` 跟着最后一次 |
| M-7：老格式 lifecycle 条目 | 读入不报错，`firstUsedAt` 仍为 `undefined`（不被补写） |
| M-7：事件 + lifecycle 齐备 | 首次使用距入库中位数 = 3 天，平均使用次数 = 3，一行摘要同时带出两者 |

`node tests/quality.test.mjs` → 52 条断言全过；已加入 `npm test` 的六套之一。

### 真机实测（2026-11-07 14:10，只读，改动前现场）

```
漏斗 SAVE/FOLD/DROP 不可得（全量 0 条文件；近 30 天 0 条）｜cohort 0：used 不可得、active 不可得、归档 不可得｜积压 3 条，最老 0.25 天
```

| 项 | 实测 |
| --- | --- |
| provenance | 目录不存在，0 条文件 → 漏斗不可得（也就没有事件流水可回退） |
| cohort | N=0 → 三个比例分母为 0，全部不可得 |
| 首次使用距入库中位数 | 不可得（缺 `firstUsedAt`） |
| 平均使用次数 | 不可得（缺 `useCount`） |
| 历史接受 / 拒绝 | 不可得（`candidates-archive.json` 不存在） |
| 候选积压 | 3 条 pending，最老一条 `created` = 2026-11-07T00:06:53.675Z，等待 0.25 天 |

如实说明：**真机样本为 0**，不是「比例很好」。原因就是 Q-1 第 5 条 —— 当前宿主实例（2026-11-06 10:14
启动）不含 provenance / lifecycle 写入点，所以这两份数据一条都没有；工具逻辑由 fixture 证明，
真机 cohort 要等宿主重启加载新代码后才开始积累。工具在真机上是直接以 node 调用同一批只读路径跑的
（宿主里的 `skillmgr_quality` 要等重启才注册），跑完 `~/.dsh` 与 skill 根无任何改动。

## 总口径复述

- 缺数据 = 报不可得 + 原因，**不给 0、不给空比例、不给「大概」**。
- 有数据但有上限（归档 500 条）= 报出计数并标明已达上限。
- 口径有两种（按事件 / 按名）时，永远连同口径名一起报，不静默替换。
- 工具只读：不改任何数据源文件，fixture 用前后 sha256 比对证明这一点。
