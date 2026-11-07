# 提取质量度量

自动提取流水线在真机持续产出 skill，但产出质量从未被度量。本文件是这条流水线的数据源审计（Q-1）、
只读聚合工具（Q-2）与实测记录（Q-3）。**只做度量，不改提取器行为，不新增任何定时任务。**

## Q-1 数据源审计

### 结论

1. 三份数据都只以 skill 名字为键，没有任何记录带 candidate id 或运行 id —— join 只能走 `name`。
2. provenance 一个名字一个文件、后写覆盖前写，所以「全量计数」是**名字的最终裁决状态数**，不是事件数；
   同一个名字的历史裁决（先 SAVE 后被 FOLD_INTO）不可恢复。
3. 没有运行日志：**「最近 10 次运行」不可恢复**；唯一可恢复的窗口是 `at` 的最近 30 天。
4. lifecycle 只有 `lastUsedAt`：**没有使用次数、没有首次使用时间** ——「首次使用距入库天数」不可得；
   「曾被使用」只能定义为「被 `markSkillUsed` 记过」，那是写路径，不是模型/人工真正调用过 skill。
5. 真机当前（2026-11-07 14:06）provenance 目录与 `skill-lifecycle.json` **都不存在**，candidates 3 条 pending。
   原因：宿主进程 2026-11-06 10:14 启动，而这两处写入点分别在 2026-11-07 09:03 / 09:11 才提交
   （`55a6c2e` lifecycle、`a4e8cb6` provenance）—— 在跑的实例不含这两个写入路径。

### 1. provenance 记录字段

写入点 `lib/extractor.js:608`（`writeProvenance`），路径 `~/.dsh/dsh-studio/provenance/<name>.json`。

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

写侧事实：`lib/extractor.js:622` 直接覆盖同名文件 —— 无 append、无序号、无「本轮事件表」。
三条裁决路径的写入见 `lib/extractor.js:1308-1316`：`accepted` → SAVE、`merged` → FOLD_INTO、
`dropped`（已归档同名且合并不进去）→ tombstone，即 DROP。

### 2. candidates 记录字段

写入点 `lib/extractor.js:1279`，路径 `~/.dsh/dsh-studio/candidates.json`（一个数组）。

| 字段 | 类型 | 取值 | 可作 join 键 |
| --- | --- | --- | --- |
| `id` | string | `${now}-${i}`，前缀是本轮开始毫秒 | 弱轮标识（只覆盖入队项） |
| `status` | string | 实际只会是 `pending` | 否 |
| `created` | number | 毫秒 | 等待时长可算 |
| `sourceCount` | number | 本轮会话数 | 否 |
| `name` / `description` / `rationale` / `group` / `body` | string | 草稿字段 | `name` 是 |
| `guard` | object? | 守门命中的 `hits` | 否 |

`status` 只有一种取值：接受（`lib/index.js:1498`）与拒绝（`lib/index.js:1529`）都直接把条目从数组删掉，
**没有 accepted / rejected 历史**，所以「接受率」不可从 candidates 复盘。

### 3. lifecycle 记录字段

路径 `~/.dsh/skill-lifecycle.json`，键是 skill 名。

| 字段 | 类型 | 写入点 |
| --- | --- | --- |
| `lastUsedAt` | number（毫秒） | `markSkillUsed`（`lib/lifecycle.js:94`）：自动提取落库/合并（`lib/index.js:1603-1604`）、darwin 回收（`lib/index.js:1963`） |
| `status` | `active` / `stale` / `archived` | `scanLifecycle`（`lib/lifecycle.js:149`、`:161`） |
| `lastCheckAt` | number（毫秒） | 同上 |

没有 `useCount`、没有 `firstUsedAt`、没有入库时间。

### 4. join 键汇总

| 键 | 覆盖 | 说明 |
| --- | --- | --- |
| `name`（`normalizeName`） | provenance / candidates / lifecycle / skill 根 / 归档目录 | 唯一跨源键 |
| `candidates.id` 前缀 | 仅 candidates | 只有入队项有，被接受/拒绝的已删除 |
| `provenance.into` | provenance ↔ skill 名 | FOLD_INTO 的目标 |
| `provenance.sessions` / `digest` | 仅 provenance | 无外部对照表 |
| 归档目录名（去 `-vN` / `.orig`） | 归档 ↔ skill 名 | 与 `archivedNames()`（`lib/extractor.js:1030`）同口径 |

### 5. 不可得指标（逐条给原因）

| 指标 | 状态 | 原因 |
| --- | --- | --- |
| 每个 skill 被使用次数 | 不可得 | lifecycle 没有计数器，`markSkillUsed` 只覆盖 `lastUsedAt` |
| 首次使用时间 | 不可得 | 只有 `lastUsedAt`；首次写入那一刻的时间戳没有留存 |
| 首次使用距入库天数（中位数） | 不可得 | 同上前提缺失 |
| 每个 skill 的裁决历史 | 不可得 | provenance 同名字文件被覆盖 |
| 轮次日志 / 最近 N 次运行 | 不可得 | 无 run 维度记录；`extractor.json` 的 `lastRunAt` 只有最近一次 |
| 接受率 / 拒绝率 | 不可得 | candidates 的 accepted/rejected 条目被删除，无状态残留 |
| skill 是否真的被模型调用过 | 不可得 | lifecycle 只记写路径，不记读取/调用 |
| 入库时间 | 不可得 | `provenance.at` 是**最近一次**裁决时间；被再次裁决过的名字不等于入库时间 |

### 6. 窗口口径裁定

- **采用**：最近 30 天，按 `provenance.at >= now - 30d`。
- **不采用**：最近 10 次运行。没有 run 维度记录；用 `at` 去重只能近似轮次，且被覆盖的记录缺项，
  属估算，不进入指标。

### 7. Q-2 采用的严格定义

| 指标 | 定义 | 分母 |
| --- | --- | --- |
| 漏斗 SAVE / FOLD / DROP | 按 provenance 文件的最新 `action` 计数 | 文件数（= 名字数） |
| 窗口计数 | 同上，仅 `at` 落在最近 30 天 | 窗口内文件数 |
| cohort | 最新裁决为 `SAVE` 的名字 | — |
| used | cohort 中 lifecycle 有有限 `lastUsedAt` 的名字 | cohort N |
| active | cohort 中仍存在于 skill 根（`agentSkillDir` / `mirrorDir`）的名字 | cohort N |
| archived | cohort 中命中归档目录名或 lifecycle `status=archived` 的名字 | cohort N |
| 首次使用距入库（中位数） | 需要 `firstUsedAt`；缺失即 `available:false` 并给原因 | — |
| 候选积压 | `status=pending` 条数；最老一条 `created` 起的等待天数 | — |

lifecycle 文件整体缺失时，`used` 报 `available:false`（不是 0/0 假比例）；provenance 目录缺失时漏斗同理。

### 8. 真机现状（2026-11-07 14:06，只读）

| 数据源 | 现状 |
| --- | --- |
| `~/.dsh/dsh-studio/provenance/` | 目录不存在（0 条记录） |
| `~/.dsh/dsh-studio/candidates.json` | 3 条，全部 `pending`，`created` = 1794010013675（等待 0.25 天） |
| `~/.dsh/skill-lifecycle.json` | 文件不存在 |
| `~/.dsh/skill-archive-*` | 6 个批次，去重后 189 个名字 |
| `~/.agents/skills` | 420 个名字（目录 + 平铺 `.md`） |

所以 Q-3 真机实测里 provenance 侧 N=0、cohort 为空、比例全部分母为 0 → 报不可得。这是数据现状，
不是工具缺陷；宿主重启加载新代码后才有数据。

## Q-2 只读聚合工具 `skillmgr_quality`

实现：`lib/quality.js`（聚合）+ `lib/index.js`（工具注册）。无参数，只读，不写任何文件。

数据源与 join：`provenance/` 全部 JSON + `candidates.json` + `skill-lifecycle.json` + 归档目录名 +
`agentSkillDir` / `mirrorDir` 下的现存名字，全部按 `normalizeName` 归一后 join。

### 输出结构

```
{
  ok, message,                       // message = 一行摘要
  summary,                           // 同上（结构化字段里再给一次）
  funnel: {
    available, reason, skippedFiles,
    all:    { save, fold, drop, total, other, note },
    window: { days, since, save, fold, drop, total, other }
  },
  cohort: {                          // cohort = 最新裁决为 SAVE 的名字
    n,
    used:     { count, denominator, ratio, available, reason },
    active:   { count, denominator, ratio, available, reason },
    archived: { count, denominator, ratio, available, reason },
    medianDaysToFirstUse: { available, value, samples, reason }
  },
  backlog: { available, reason, pending, oldestCreatedAt, oldestWaitDays },
  unavailable: [ { metric, reason } ],
  sources: { provenanceDir, candidatesPath, lifecyclePath, skillRoots, windowDays }
}
```

规则：比例一律带 `count` 与 `denominator`；分母为 0、文件缺失、字段缺失时 `available:false` +
`reason`，`ratio` 为 `null`，不填 0。

- `active` = 名字仍在 skill 根里且 lifecycle 状态不是 `archived`。
- `archived` = 名字命中归档目录（`archivedNames()` 口径）或 lifecycle 状态为 `archived`。
- 窗口固定最近 30 天（Q-1 裁定），落在 `funnel.window`。

