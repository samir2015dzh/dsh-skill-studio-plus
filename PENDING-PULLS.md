# PENDING_PULLS.json 契约（PULL-1 审计）

恢复端待拉取清单的现行形态、产生链路与复用点。所有结论来自代码（基线 `1b739f2`），
不是设计稿；与口头描述不一致的地方单独列出。

## 1. 落盘位置

`<externalSkillRoot>/PENDING_PULLS.json`

`externalSkillRoot` 的唯一定义在 `lib/snapshot.js` 的 `externalSkillRoot(home)`：

1. 读 `~/.dsh/dsh-studio/extractor.json` 的 `agentSkillDir`；
2. 该值解析后落在 `~/.dsh` **之外**才采用（`externalSkillTargetFromConfig`）；
3. 配置缺失、为空、或指向 `~/.dsh` 内部 → 退回 `resolve(homedir(), ".agents", "skills")`。

真机落在 `~/.agents/skills/PENDING_PULLS.json`。恢复落点与清单位置共用这一个函数
（PULL-1 之前是两处各写一遍同样的表达式）。

## 2. restore 产生它的完整路径

```
restoreSnapshot(id)                                  lib/snapshot.js
  unpackTarGz(archive) → entries
  entries.find(rel === "EXTERNAL_SKILLS.json")       ← 包内链接清单
    JSON.parse → parsed.skills[]                     ← 解析失败按空处理，不报错
    externalSkills = skills
  summary.pendingPulls = skills.map(…)               ← dry-run 也返回，不写文件
  options.dryRun === true ? 返回 summary : 继续写盘
  prepare 写盘 → 逐条 writeFile
  externalSkills.length > 0:
    pendingPath = join(externalRoot, "PENDING_PULLS.json")
    writeFile(pendingPath, JSON.stringify({note, at, pulls}, null, 2) + "\n")
```

`restoreSnapshot` 全程没有网络调用：只读包、读目标机现值、写文件。联网只可能在
恢复端显式拉取时发生（即本方向的 R-2）。

包内清单由 `createSnapshot()` 产生：

```
collectFiles({skipped, maxSkillFileBytes})           白名单文件 + 超大文件记账
collectExternalSkills(files, skipped, home)
  按 skills/<name>/ 与 agents-skills/<name>/ 分组累计字节（入包 + 被 C-2 跳过的）
  g.bytes > EXTERNAL_SKILL_MIN_BYTES (5 MB) 才进入候选
  resolveSkillSource(name, dir) → 来源不可判定就保底打包（不进清单，防丢）
  产出 {name, repo, ref, sha, subdir, sizeBytes, fileCount}
entries.push({rel: "EXTERNAL_SKILLS.json", data: {note, thresholdBytes, skills}})
```

被链接化的 skill 同时从入包文件与被 C-2 跳过的文件里剔除 —— 内容既不进包、也不进
`SKIPPED.json`（那是「太大」的语义，不是「只记链接」）。

## 3. 两种清单的字段

`EXTERNAL_SKILLS.json`（包内，恢复时跳过不写盘）：

```json
{
  "note": "…只记仓库链接、不打包内容。恢复端按 PENDING_PULLS.json 自行拉取。",
  "thresholdBytes": 5242880,
  "skills": [{ "name": "…", "repo": "…", "ref": "…", "sha": "…", "subdir": "…", "sizeBytes": 0, "fileCount": 0 }]
}
```

`PENDING_PULLS.json`（目标 skill 根，恢复端消费）：

```json
{
  "note": "…用 skill-import 或 git 自行拉取。",
  "at": "2026-11-07T06:37:10.000Z",
  "pulls": [{ "name": "…", "source": "…", "ref": "…", "sha": "…", "subdir": "…" }]
}
```

逐项对照：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `name` | `EXTERNAL_SKILLS.skills[i].name` | skill 目录名，等于 `skill-lock.json` 的键 |
| `source` | `.repo` | **重命名**：包内叫 `repo`，清单里叫 `source`；值可以是 GitHub 仓库根 URL，也可以是本地 `.tar.gz` 绝对路径（`resolveSkillSource` 的 lock 分支原样透出 `lock.source`） |
| `ref` | `.ref` | 分支/标签/commit；`lock.ref` 为空时用 `splitSourceUrl(lock.source)` 从旧 tree URL 里拆出的 ref；仍为空则空串 |
| `sha` | `.sha` | **语义不统一**，见 §4 |
| `subdir` | `.subdir` | 子目录；产物里恒为字符串（无子目录写 `""`），字段形态稳定 |

`sizing` 字段（`sizeBytes` / `fileCount`）只出现在 `EXTERNAL_SKILLS.json`，不带进待拉清单。

## 4. `sha` 的两种语义

`resolveSkillSource(name, dir)` 两级判定，写进 `sha` 的东西不同：

| 判定路径 | `via` | `sha` 实际值 | 形态 |
| --- | --- | --- | --- |
| `skill-lock.json` 有该 skill 的 `source` | `lock` | `lock.sha256`：**tar.gz 内容哈希** | 64 位 hex |
| 目录内有 `.git`，`remote get-url origin` 取到 URL | `git` | `git rev-parse HEAD`：**commit sha** | 40 位 hex |
| 两条都不成立 | — | 返回 `null` → 保底打包，不进清单 | — |

所以消费端不能把 `sha` 一律当 commit 用：64 位的是内容哈希（只能事后比对下载到的
tarball），40 位的才是可以钉版本的 commit。`ref` 为空而 `sha` 是 40 位时，用 `sha` 当 ref
是唯一可复现的钉版方式。

## 5. 复用点：`lib/skillsrc.js`

| 函数 | 语义 | 现状 |
| --- | --- | --- |
| `parseSkillSource(input)` | GitHub `https://github.com/<owner>/<repo>[/tree/<ref>[/<subPath>]]` 或本地 `.tar.gz`/`.tgz` 路径 → `{kind, owner, repo, ref, subPath, url}`；`ref` 缺省 `HEAD` | 导出，可直接用 |
| `loadSourceBytes(parsed)` | tarball 读文件 / GitHub 拉 `codeload`（60 s 超时） | 内部；PULL-2 抽出成 `resolveSkillPackage` 复用 |
| `findSkillRoot(entries, subPath)` | 剥掉 `<repo>-<ref>/` 顶层，按 `subPath` 收窄，定 `SKILL.md` 根 | 导出 |
| `skillNameOf(found)` | frontmatter `name`（必须 kebab-case）否则目录名，否则 `imported-skill` | 导出 |
| `importSkill({source, targetDir, now})` | 拉字节 → 解包 → 定名 → **写文件 → 更新 lock** | 导出，HTTP 路由 `skillImport` 与 R-2 工具共用 |
| `lockRecordFor(parsed, {sha256, now})` | `{source, ref, sha256, at, subPath}`；`source` 只存仓库根 URL（tarball 存原路径） | 导出 |
| `loadLock()` / `lockPath()` | `~/.dsh/dsh-studio/skill-lock.json` | 导出 |

### `importSkill` 的 lock 校验语义

```
sha256  = sha256(下载到的 tar.gz 字节)
name    = frontmatter name
prev    = lock[name]
prev !== undefined && prev.sha256 === sha256 && prev.ref === parsed.ref
        → 返回 {ok:true, changed:false}（跳过，不写盘、不写锁）
否则    → 逐文件写入 <targetDir>/<name>/…，lock[name] = lockRecordFor(…)
```

三条要点：

1. 校验键是 **tar.gz 字节哈希 + ref**，不是逐文件内容哈希，也不看目标目录现值；
2. **同名冲突直接覆盖**：`prev` 存在但 `sha256` 不同时没有任何拦截，写盘照旧；
3. 锁只在成功路径写，失败不留记录。

第 2 条是 R-2 必须自己补的缺口：待拉清单的 `conflict` 判定不能指望 `importSkill`。

## 6. 现行缺口（R-2 的输入条件）

1. 清单没有状态字段（没有 per-entry 的 `status` / `attempts` / 错误原因）—— 只写过、没消费过；
2. 清单没有 id 与版本，同一条目无法区分「这次恢复写的」与「上次遗留的」；
3. 每次 `restoreSnapshot` 到同一个目标根都会**整份重写**清单，不合并、不保留历史；
4. dry-run 不落清单文件，但 `summary.pendingPulls` 里带同样的 `{name, repo, ref, sha, subdir}`；
5. 清单内条目的 `source` 可能是本地路径（来自 lock 的 tarball 导入）—— 消费端不能假定只有 GitHub。

## 7. 与背景描述的出入（以代码为准）

| 背景描述 | 实际 |
| --- | --- |
| 字段 `name/repo/ref/sha/subPath` | 清单里是 `name/source/ref/sha/subdir`；`repo` 在包内清单才叫 `repo`，落到待拉清单时改名 `source`；`subPath` 是 `skill-lock.json` 的字段名，清单里叫 `subdir` |
| 「restore 时把待拉清单写成 PENDING_PULLS.json 并只做提示」 | 与代码一致；位置是外部 skill 根（不是 `~/.dsh`），且 dry-run 不写 |
| 「只记链接的大 skill」 | 门槛是**目录总大小 > 5 MB** 且来源可判定；来源不可判定时保底打包，不做链接化 |
