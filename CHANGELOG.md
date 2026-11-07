# Changelog

> `dsh-studio` 的全部版本变更。本文件由 `scripts/release.mjs` 在发布时自动补写。
> 格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
> 说明：0.2.0 及更早的条目依据 git 历史与 npm 发布时间回填。

## [1.0.1] - 2026-11-07

补丁版。修掉三个工具的「返回体与注册 output schema 脱节、被宿主整包拒收」缺陷，并把这类
检查变成常驻回归，防止同类问题再次溜进发版。

### 修复

- **`skillmgr_quality` 此前在宿主里不可用**：返回体带 `history` 字段而注册 schema 未声明，
  宿主按 `additionalProperties: false` 整包打回，连 summary 都出不来。逐键核对返回体后补齐
  唯一缺失的 `history` 声明
- **`skillmgr_get` 查询不存在的技能**：handler 返回 `skill: null`，而 schema 只允许对象，
  同样整包打回。改为查不到时省略该键——渲染侧本来就有「skill 不存在」分支，不影响输出
- **`skillmgr_snapshot_restore` 此前每一次调用都被宿主拒收，现已修复**。两处脱节：①
  `preSnapshot` 在拍前置快照失败时可为 `null`，schema 只允许 string，已改为
  `oneOf: [string, null]`（宿主的 `@deepseek-ai/dsh-tools` 明确拒绝 type 数组，也不认
  `anyOf`，`oneOf` 是其支持子集里的唯一等价写法）；②返回体恒带 `pendingPulls` 而 schema
  未声明，`dry-run` 与真恢复都会被整包打回。两处补齐后恢复工具恢复正常
- 以上改动只落在 schema 与 handler 的返回形状上：`snapshot.js` 的返回体、Web 路由与面板的
  消费代码一行未动

### 测试

- **新增常驻回归：全部 27 个工具经注册层真实调用 + 宿主校验**。测试从注册表取出每个工具的
  schema，跑 handler 后把真实返回体交给宿主自身的 `validateJsonSchemaValue` 校验，
  **0 豁免、0 违规**，没有静默跳过。写类工具各走自己的最小场景（建快照 → dry-run → 真恢复、
  trash → restore → trash → purge、快照导出导入、候选接受/拒绝），git 同步用伪 HOME 里的
  bare 仓库当远端，MCP 三件套用 mock stdio 对端真连，LLM 用内存假 provider，全程离线、
  全程 `mkdtemp` 伪 HOME
- 27 个 schema 另过一遍 `assertSupportedJsonSchema`，确认每个都落在宿主支持的子集内

## [1.0.0] - 2026-11-07

首个稳定版。0.8.0 之后的一整轮改进计划全部落地：安全、自动进化、跨机迁移、上游检查、
质量度量、导入来源、测试七条线，工具集与数据格式按此版本定稿。

### 安全加固

- **快照字段级脱敏**：打包时把凭据文件里的敏感字段（token / secretKey / password 等）值换成
  `__dsh_studio_redacted__` 占位符，命中清单写进包内 `REDACTED.json`；JSON 解析失败的文件整份
  排除并同样记录。**恢复时占位符绝不写回**——目标机该字段已有值时保留本机现值，没有才落空，
  所以快照推到 git / gist / s3 也不会把别处凭据带过来
- **凭据只在构造处出现一次**：面板 state、HTTP JSON、工具返回值、日志一律只拿掩码（中间打点 +
  尾 4 位），明文只走单个回环路由；敏感键名收敛到 `lib/redact.js` 一处，快照、MCP、工具三处共用同一份
- **MCP 路由回环与同源守卫**：所有 MCP 写路由统一校验来源为回环地址 + 同源 Origin，
  跨站页面构造的请求不再能改注册表
- **敏感文件 0600 落盘**：`sync.json`、`mcp.json`、`skill-lifecycle.json`、provenance 文件、
  `last-llm-raw.txt` 以及恢复写盘的凭据文件统一 0600 并走 `hardenPermissions()`
- **运行期信息掩码**：中间态里的凭据值同样只以掩码出现——同步通道配置视图、MCP 服务器条目描述、
  工具渲染文案都走 `maskSecret()`，日志与返回值里不留原文

### 技能自动进化修复

- **frontmatter 原地改写**：合并与优化改写 `SKILL.md` 时保留原 frontmatter，用户手写的
  `disable-model-invocation`、`user-invocable`、`protected`、`metadata.*` 不再被整份覆盖；
  索引补解析 `group` / `tags`
- **Darwin 触发条件收窄**：只在写类工具（write / edit / apply_patch / write_file / multi_edit）
  真正改动 SKILL.md 时记 pending，读操作与无关写入不再触发；范围限两棵 skill 根
  （`~/.agents/skills`、`~/.dsh/skills`）
- **Darwin 总开关**：`enabled` 默认开，关掉即不注入任何提示；加载 darwin-skill 后静默 15 分钟
  防自激，pending 6 小时过期，24 小时巡检一次、每次最多 5 条
- **评测硬性两条**：① 评估前先建/查同目录 `test-prompts.json`，没有就先生成 2–3 条能验证该
  skill 的测试提示词再打分；② keep/revert 只认 paired 多数决（同一 judge 成对比较 + 奇数 N
  多数票），绝对分有 ±8 噪音，只用来排序、不当判据
- **闭环补全**：待办项处理后能回收结果，配对判据与「本体缺失」告警都给出明确状态，不再静默丢结果
- **autoAccept 默认开启**：提取候选默认直接落库，不必每次点确认
- **优化路径去掉确认门**：记住/优化类请求先本地分类，能判定唯一类别就直接落位
  （含整行命令切分、只读感知删除、no-op 快路），不再先问一遍
- **候选保留分组**：提取候选带 `group` 并按 8 类校验，落库后不再全部堆进「未分组」

### 快照瘦身与跨机迁移

- **大 skill 只记链接**：skill 体积超过阈值且来源可确定时，快照只记仓库链接（含子目录来源）到
  `EXTERNAL_SKILLS.json`，不再把内容打进包
- **恢复只出清单、不替你联网**：恢复后生成 `PENDING_PULLS.json`，列出「只记了链接」的那些 skill，
  恢复端自己决定何时拉
- **一键拉取**：新增工具 `skillmgr_pull_pending`，消费清单逐条拉取并写回 lock；逐条独立成败，
  已存在且内容一致的记 `satisfied` 跳过，同名但内容不一致的记 `conflict` 且不覆盖
- **大文件跳过清单**：skill 根下的超大文件（GIF / PNG 之类）不进包，改记进 `SKIPPED.json` 并写明
  原因；`.git` / `.svn` / `.hg` 直接跳过、不占清单
- **恢复落点跟随配置**：快照白名单与恢复落点都取 `agentSkillDir`，改过 skill 根也不再漏备主库
- **计数口径统一**：`countFiles` 与 `collectFiles` 对跳过项按同一口径计数，manifest 里的数字不再
  自相矛盾

### 上游更新检查

- **新增 `skillmgr_update_check`**：只读比对已装 skill 与其来源仓库的最新提交，双口径计数——
  「已查」是本次真正比过的条数，「全库」是锁文件里的全部条数，两者分别报，不混成一个百分比
- **每轮最多联网 3 次**：`ls-remote` 一轮对话上限 3 次，超出静默跳过、不报错；结果缓存 10 分钟，
  缓存命中不计次
- **Darwin 优化前先看上游**：有新版就在评测提示里点出来，避免白改一遍
- **下载退避**：codeload 拉包对网络类错误退避重试 2 次，4xx 直接失败不重试
- **lock 短路更严**：同 ref 同内容跳过的前提是目标目录真实存在，删掉目录后不会再假跳过

### 提取质量指标与数据地基

- **新增 `skillmgr_quality`**：只读聚合提取漏斗、SAVE 队列的使用 / 活跃 / 归档比例、候选积压与
  历史接受 / 拒绝。分母为 0、数据缺失时报 `available:false` + 原因，比例给 `null` 而不是 0
- **裁决事件流水**：provenance 除按名覆盖的最新裁决外，另追加 append-only 的
  `provenance-events.jsonl`（一行一条 `at` / `name` / `action` / `rationale`）。漏斗改按事件计数，
  同一个名字先 SAVE 后 FOLD_INTO 的历史可以复盘；没有这份流水的旧数据自动回退「按名最新裁决」
  口径，两种口径在输出里标明
- **候选终局归档**：接受 / 拒绝的候选不再直接删掉，写进 `candidates-archive.json`（带 `decision`
  与 `decidedAt`），滚动上限 500 条、超出丢最旧；质量度量据此报历史接受 / 拒绝，无归档时报不可得
- **首次使用与使用次数**：lifecycle 补 `firstUsedAt`（首次使用，只写一次）与 `useCount`
  （每次 +1），据此给出「首次使用距入库中位数」（入库时间口径 = 同名最早一次 SAVE 事件的 `at`）
  与「平均使用次数」；老状态文件缺这两个字段时如实报不可得

### 技能导入与来源锁

- **从仓库导入**：支持 `https://github.com/<owner>/<repo>[/tree/<ref>[/<subPath>]]` 与本地
  `.tar.gz`，按子目录收窄后取 SKILL.md，导入完成写 `~/.dsh/dsh-studio/skill-lock.json`
- **来源锁结构化**：lock 记录 `source`（仓库根）/ `ref` / `subPath` / `sha256` / `at`，子目录不再是
  拼在 URL 里的字符串；旧记录里的 tree URL 读侧照样能归一
- **跳过判据**：同 ref、内容 sha256 相同、且目标目录确实存在时才跳过，否则重装并更新 lock

### 测试现代化

- **六套测试串联**：`npm test` = darwin / boot / upstream / skillsrc / quality / pull，
  任一失败即整体非 0 退出
- **boot 套件按平铺视图重写**：分组视图折叠态的场景改为平铺口径断言（headers 0 / rows 3），
  工具数 24、路由数 32 与现状对齐；`ctx` 桩补 `on`，路径断言按分隔符比对
- **临时 HOME 隔离**：boot 全程在 `mkdtemp` 出的临时 HOME 下跑，预热轮询不再写真实
  `registry-cache.json`；quality / pull 各自带伪 HOME fixture，真机路径只读

## [0.8.0] - 2026-11-05

### 改进（2026-11-06 补记）

- **目录段只给工具名**：MCP 目录从「工具名 + 截断描述」改成只列名字，craft-anything
  那种大服务器实测 75,918 → 4,878 字符（≈19K → 1.35K token）。名字足够判断该不该
  load，描述等 `mcp_load` 再取
- **`mcp_load` 缓存优先**：默认用内存缓存，换 `filter` / `limit` 不再重连重拉；
  新增 `refresh: true` 显式刷新。缓存为空时仍然自动连
- **`mcp_call` 支持批量**：`calls: [{tool, args}, ...]` 按顺序执行，某个失败不中断后面的；
  单个仍用 `tool` + `args`。工具之间没有依赖时用它省往返
- **用法段纠正**：`mcp_call` 直接执行即可，不需要先 `mcp_load`

### 修复（2026-11-06 补记）

- **状态点在自建条目上恒灰**：studio 自己建的条目（没有原生 `cordis.patch.yml` 行）
  也按「已接管」显示为绿，不再永远灰着
- **状态文案分四态**：停用档显示「已停用（不连接）」，不再冒充「空闲（未连接）」
- **「未连接」只数 `status === "idle"`**：连接错误单独一档，没有错误时不占位
- **筛选按 status 精确匹配**：点「未连接」不再把已停用和出错的服务器一起翻出来
- **reclaim 时清旧 error**：切档位后不再永久卡在「连接错误」
- **面板删除改二次确认**：点一下变「确认删除」（4 秒后自动恢复），提示会一并丢掉
  备注、工具白名单和空闲阈值
- **工具列表跟随各自卡片**：不再堆在整个列表末尾，展开哪个服务器的工具就贴在哪个卡片下面

### 新增

- **配置快照**：把 `~/.dsh` 的配置按白名单打成 tar.gz 存到
  `~/.dsh/dsh-studio/snapshots/<时间戳>-<标签>/`，附 `manifest.json`（每个文件的相对路径、
  SHA-256、字节数）。白名单收 `cordis.patch.yml`、`AGENTS.md`、`skills/`、`dsh-studio/`、
  各 profile 的 `package.json` 与 `cordis.patch.yml`，实测 248 个文件 3.6 MB → 1.2 MB。
  密钥（`.credentials.yaml`、`sync.json`）、会话日志（`sessions/`）、`node_modules/`、
  `sync-work/` 一律跳过
- **恢复**：`dryRun` 逐文件比 SHA 报 create / overwrite / same，真恢复前自动打一份
  `pre-restore` 快照，恢复后可回退
- **导出 / 导入**：tar.gz 往返，导出的包在另一台机器上导入后 SHA 全部一致
- **跨机路径重映射**：`restoreSnapshot` 收 `pathMap: [{from, to}]`，写盘前替换文本里的绝对
  路径前缀；JSON 里的转义写法（`C:\\Users\\a`）与纯文本原样写法都处理，二进制文件按
  `isProbablyText` 判定后跳过
- **定时备份**：`~/.dsh/dsh-studio/snapshot.json` 存 `{ enabled, intervalHours, keep }`，
  插件每 30 分钟问一次「该不该跑」，到点建 `scheduled` 快照并按 `keep` 清理旧的那几份；
  清理只动 `scheduled` 标签，不碰手动备份
- **四条同步通道**：Git（init + remote add + fetch + checkout，支持空仓库）、
  Gist（GitHub Gist API，tar.gz 走 base64，超大回退 `raw_url`）、
  WebDAV（PUT/GET + 可选 Basic auth）、S3（手写 SigV4，path-style，PUT/GET）。
  配置在 `~/.dsh/dsh-studio/sync.json`，凭据不进快照
- **设置页「配置快照」**（order 302）：统计条、立即备份、保留最近 N 份、导出/导入、
  逐行预览与恢复、定时备份开关、同步通道胶囊与推送/拉取
- 4 条新路由：`/snapshot`、`/snapshot/restore`、`/snapshot/prune`、`/snapshot/transfer`、
  `/snapshot/schedule`、`/sync`、`/sync/push`、`/sync/pull`
- 4 个新工具：`skillmgr_snapshot`、`skillmgr_snapshot_list`、`skillmgr_snapshot_restore`、
  `skillmgr_snapshot_transfer`、`skillmgr_sync`

### 修复

- MCP 注册表瘦身：工具缓存落盘只留 `name` + 截断描述（200 字），完整 `inputSchema` 不再写进
  `mcp.json`。此前 `warmCatalog` / `prefetchTools` / `mcp_register` / `mcp_load` 都把
  `listTools()` 的原始返回整体 upsert，229 个 REA 工具能把注册表撑到 10.4 MB，等于每次面板
  操作都解析一遍 10 MB JSON（实测 28 ms/次）。实测压缩后 10.42 MB → 0.07 MB，工具数不变
- 启动时若注册表超过 2 MB，`warmCatalog` 顺手压一次（兼容旧版本写进去的胖缓存）
- eager 档改为以活连接为数据源：`buildEagerTools` 用 `runtime.cachedTools()` 判空而不是
  `visibleTools()`，否则注册表里的瘦缓存一旦非空就不会去连，`inputSchema` 缺失导致 eager
  工具参数全部退化成 `{}`；同理 `warmCatalog` 不再把瘦缓存塞进 `runtime.slot`
- `skillmgr_list` 补回 `dir` 字段：`fsToSummary()` 从 0.7.0 起带上技能目录，但输出 schema 的
  `items` 是 `additionalProperties: false` 且没声明 `dir`，宿主校验直接判整个调用失败
  （`value.skills[0].dir is not a declared property`），插件最常用的列表工具全线不可用
- 定时备份的保留策略原本调 `pruneSnapshots`，它按时间排「全部」快照，把手动建的那几份也算进
  「保留 N 份」里 —— 实测手动快照被删。改为 `pruneScheduled`，只对 `label === "scheduled"`
  排序清理
- 快照 id 原本精确到秒，同一秒内连建两份会撞 id，后一份直接覆盖前一份。`stamp()` 补毫秒
- 白名单 `dsh-studio/` 原本只跳过 `snapshots`，漏了 `sync.json`（gist token / s3 secretKey
  明文，一进快照等于导出即泄露）与 `sync-work/`（git 工作副本含 `.git`）
- Git 通道原本用 `git clone --depth 1`，对空仓库（bare 但无 commit）clone 出来没有 HEAD，
  之后的 `git pull --ff-only` 报 "no tracking information"。改为 init → remote add → fetch →
  有分支才 checkout，空仓库停在未跟踪状态等首次 `push -u`

## [0.7.0] - 2026-11-04

### 改名

- 包名 `dsh-skill-studio` → `dsh-studio`，GitHub 仓库同改。API 路径 `/api/dsh-studio/*`，
  数据目录 `~/.dsh/dsh-studio`，客户端模块 id 与日志前缀一并更新；工具名 `skillmgr_*` 保持不变

### 新增

- **技能工作台三层筛选**：来源（全部 / 用户 / 内置）、启用状态（已启用 / 已停用）、
  用途分类（逆向分析 / 安全测试 / 代码工程 / 文档写作 / 环境运维 / 数据检索 / 流程协作 / 其他），
  三者是「与」的关系；状态与分类组再点一次已选中的胶囊即取消
- **回收站**：技能行右侧「删除」把目录移进 `~/.dsh/dsh-studio/trash/<时间戳>-<名>/`，
  面板「回收站」页可整批或单项恢复、永久删除；跨盘 rename 失败自动退 copy + rm
- **按用途自动分类**：会话提取时模型必须从固定 8 类里选一个写进 `metadata.group`；
  合并旧 skill 时保留原分类。`scripts/classify-skills.mjs` 可按关键词把存量技能批量归类
  （`--write` 写入，每个文件先备 `.bak-group`）
- **多来源扫描**：除 DSH 与公共 Agent 目录外，补上 Codex / Claude / Cursor / Gemini /
  Windsurf / Trae / Qoder / Lingma / OpenCode / Copilot / Roo / CodeBuddy / WorkBuddy /
  OpenClaw / CC-Switch 等 15 个 Agent 的技能根，目录存在才扫描
- **技能诊断**：frontmatter 的 `name` 不是 kebab-case 时标「宿主不认这个名」（这类技能
  面板看得见、宿主加载不了）；跨来源同名时标出「被 X 盖住」与「盖住 N 个」
- **分页**：每页 6 条，底部居中翻页条，中间的页码可点开输入后回车跳转
- **MCP 面板对齐**：工具栏加服务器搜索、档位筛选（全部 / 启用 / 按需 / 停用）与
  状态筛选（已连接 / 未连接），筛选无结果时给提示
- **MCP 凭据掩码**：`authorization` / `api_key` / `token` / `secret` / `password` / `cookie`
  这类头与环境变量默认显示为 `••••••••` + 尾 4 位，点「显示」看明文、点「复制」写剪贴板；
  非凭据类环境变量（`GHIDRA_INSTALL_DIR`、`PATH` 等）不进面板，避免行卡被撑长

### 改进

- `listSkills` 用磁盘缓存 + 后台刷新 + 启动预热，不再每次请求都阻塞在 `ctx.skills.list()`
  （此前打开面板要等 4–5 秒）
- 26 处写死的中性灰 `rgba(128,128,128,a)` 换成 `color-mix(in srgb, currentColor N%, transparent)`，
  边框与底色跟随深色 / 浅色主题
- 胶囊、tab、组名标签都加 `userSelect: none`，点击时不再选中文字

### 修复

- 启动自动导入漏扫 `DSH_HOME/cordis.patch.yml`（全局层）：只扫了 profile 与 bundle 两层，
  写在这个文件里的 MCP（例如 rea）在 `mcp_list` 里看不到。现在三层都扫
- `parseMcpRows()` 丢失块式 `args`：`args:` 换行后一行一个 `- 元素` 的写法整段没被收，
  导入的条目 `args` 恒为 `[]`，按需加载时会用空参数起进程（rea 少 `mcp`、metis-reverse 少
  `mcp --transport stdio`）。现在块式与一行式都能解析
- MCP.md 与实现对齐：起始版本 0.5.1 → 0.6.0；工具数 4 → 5（补 `mcp_takeover`）；
  已知限制补「自动导入扫哪三层」与「插件自封装 MCP 不会被导入」
- 连接与列工具超时独立于工具调用超时：`McpConnection` 新增 `connectTimeoutMs`（默认 30s，
  `ensure` 里取 `min(toolCallTimeoutMs, 45s)`），握手与 `tools/list` 用它，`tools/call` 仍走
  `toolCallTimeoutMs`。此前握手沿用 900s，服务器起不来时面板会冻住十几分钟
- 面板忙状态按服务器隔离：`busy` 改为 `busyKey`（记录正在操作的服务器名），档位胶囊与
  重载 / 接管 / 删除按钮、工具过滤只在自己那台忙时禁用，一台连不上不再锁住整个面板


## [0.6.0] - 2026-11-02

### 新增

- MCP 按需加载（`lib/mcp.js`、`lib/mcp-client.js`）：三档（启用 / 按需启用 / 停用），
  目录只暴露服务器名与截断描述，完整 schema 由 `mcp_load` 现取，调用走 `mcp_call`
- 零依赖 MCP 客户端：stdio 按行 JSON-RPC、streamable-http 支持 JSON 与 SSE 两种响应
- 空闲回收：超过 `idleTimeoutMinutes`（默认 5，`0` 关闭）没有工具调用就断开上游，
  工具缓存与注册表保留，下次调用透明重连
- 工具白名单：每台服务器可设 `toolFilter`（`all` / `allow` / `deny` + 名单），
  目录与 `mcp_call` 入口同时生效
- 自动导入：启动时扫 profile 与各 bundle 的 `cordis.patch.yml`，把
  `@deepseek-ai/dsh-mcp-client` 条目抄进注册表（停用档）；「接管」才会禁用原生条目
- 设置页新增独立一页「MCP 服务器」（`settings.section`，order 301）：统计条、
  状态点（绿=已接管 / 灰=未接管）、档位胶囊、工具清单勾选

### 变更

- Skill 工作台重做成与 MCP 面板同一套语言：统计条、统一行卡、单行省略描述，
  会话提取设置折叠为一行
- 会话提取表单按「开关 / 调度 / 输出位置 / 模型」四组重排

### 修复

- `savePendingRemember()` 写 `pending-remember.json` 前补 `mkdir(dirname(...), { recursive: true })`：目标目录 `~/.dsh/dsh-studio` 不存在时，首次「记住」会静默失败
- `extractIfDue()` 调用点移除恒为 `false` 的 `forceReview` 实参（`remember` 分支已提前 return，实参永远取不到 `true`）
- 0.5.1 段落修复文字损坏：`Remember` 缺首字母、反引号丢失；`forceReview` 的 `f` 变成控制字符 U+000C（`\f` 转义），`runExtraction()` 的 `r` 被当成回车吃掉 —— 说明写 CHANGELOG 的环节做过一次 C 风格转义
- `!!js "'…' + process.env.PATH"` 这类动态 env 现在拆出字面量前缀存 `envPrefix`，
  连接时拼到父进程同名变量前，不再整条跳过
- 块式 `headers` 的子项以前被当成无关行丢弃（hindsight 因此 401），现在按缩进收进对象
- Node 的 happy-eyeballs 会让 fetch 先试不通的 IPv6 再超时，钉成 `ipv4first`

## [0.5.1] - 2026-11-01

### 新增

- Remember 通道：用户说「记住 X」时，判定直接放行（只认 `- 用户：` 行，助手的话不算）
- 命中后不静默生成，下一轮 system-prompt 注入确认请求，主动问用户落点
- 按类型分流：方法→skill、偏好→AGENTS.md、事实→记忆库；类型明确的直接落位不问

### 变更

- shouldExtract() 返回 { worth, remember, rememberText }，调用链全程透传
- runExtraction() 新增 forceReview，可绕过 autoAccept
- 摘要窗口 10 → 20 条
- 提取 prompt 增加「用户明确要求记住的内容」为第一优先级


## [0.5.0] - 2026-10-29

### 新增

- 并入独立插件 `dsh-darwin-auto`：写入 SKILL.md 后自动把 `darwin-skill` 推到模型面前，按 9 维 rubric 体检（`lib/darwin.js`）
- 同族去重：按 `~/.dsh/darwin-auto/families.json` 把同族重复 skill 折叠到宿主，成员不再重复送审；表缺失时行为与旧版一致
- 借插件已有的 `llm` 服务自动生成族谱（`familyRefreshDays` 控制过期天数，0 关闭），不再依赖模型手工维护

### 变更

- 状态文件沿用 `~/.dsh/darwin-auto/state.json`，`seen` / `scores` 无缝继承，不会全量重扫
- 配置入口搬到 `cordis.patch.yml` 的 `config.darwin` 段
- `tests/boot.test.mjs` 改用 `pathToFileURL`，修掉 Windows 上动态 import 裸盘符路径的报错

### 移除

- profile 里的 `dsh-darwin-auto` 依赖与 bundle 条目；源目录保留作回滚点

## [0.4.0] - 2026-10-24

### 新增

- 每轮对话结束先做 YES/NO 判定（小 prompt），值得才跑完整提取；判定 90 秒节流、提取 5 分钟节流
- 提取结果自动写入 `~/.agents/skills`（`autoAccept`），写入失败才进候选队列
- 语义合并四道闸：墓碑拦截、类别标签、`FOLD_INTO` 本地复核、合并卫生
- 面板新增「最近添加的 skills」列表（名字 + 描述 + 时间）与模型下拉
- 提取输出被截断时逐个抢救完整候选（`salvageCandidates`）

### 变更

- 模型调用改走 `ctx.llm.prepareCall()`，插件不再保存 API key；`llmBaseUrl` / `llmApiKey` / `llmModel` 降级为 HTTP 回退
- 面板移除网关地址与密钥输入框，`intervalMinutes` 标注为「兜底」
- `skillLanguage` 新增 `auto`（跟随会话），三种模式都明确代码与命令不翻译
- 合并结果自动去重复章节、切 `MERGE:` 协议残渣、拦截短正文覆盖
- 提取 `maxTokens` 4000 → 8000，prompt 限制正文 600–800 字

### 移除

- `README.zh.md`（并入 `README.zh-CN.md`）


## [0.3.1] - 2026-09-29

### 兼容性

- 声明兼容 **DSH 0.2.0-rc.2**：`peerDependencies` 中官方 DSH 包的版本范围追加 `^0.2.0-rc.2`。功能与行为无变化，仅解除新版 DSH 下的兼容告警。


<!-- 下一版内容从这里开始累积；发布时把本行下方的内容整段搬到新版本段落，保留本标题 -->

## [0.3.0] - 2026-09-27

### 新增 (Added)

- **skill 分组展示（第一期，只读）**：读取 SKILL.md frontmatter 的 `metadata.group` / `metadata.tags`（DSH 官方支持的 `metadata` 载体），Web 面板「Skill 工作台」按分组折叠展示，带筛选框、「按分组 / 平铺」视图切换与未分组区；`skillmgr_list` / `skillmgr_get` 输出新增 `group` / `tags` 字段。**纯展示层，不改变模型加载哪些 skill**。
- `lib/scanner.js` 的 frontmatter 解析器支持**一层嵌套对象**（此前 `metadata:` 的缩进子键会被直接丢弃），并支持内联数组 `[a, b]` 与 `- item` 块列表；解析仍为零依赖、行级。
- 测试新增：嵌套 frontmatter 解析（含 dedent 后继续解析顶层键）、扫描器与详情的分组字段、面板分组渲染冒烟（fake React 驱动真实客户端组件：分组视图 / 平铺视图 / 折叠态）。

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- 分组数据只读：面板不会写回任何 `SKILL.md`；`metadata.group` 缺失的 skill 落「未分组」区。
- 发布前可移植性验证：✅ 通过（隔离 `DSH_HOME` + tarball 安装 + 15s 稳定性观察）

## [0.2.2] - 2026-09-27

### 修复 (Fixed)

- **会话扫描判据漏 v3/v4，约 60% 会话日志被静默跳过**：`lib/extractor.js` 此前只认字面量 `session.jsonl.zstd`，而 DSH 现网写入 `session.v3.jsonl.zstd`（0.1.5）/ `session.v4.jsonl.zstd`（0.1.7）——本机 945 个日志里 v3 501 + v4 75 被跳过（≈61%），「会话提取」候选系统性偏少且**不报错**。判据改为与核心 `@deepseek-ai/dsh-session-format` 同源的 `/^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/`，v0/v3/v4… 通吃，版本再升也不会失明。
- **桌面端最小 PATH 下 `zstd` spawn ENOENT**：Finder 启动的 Electron 宿主继承 launchd 的 `/usr/bin:/bin:/usr/sbin:/sbin`，裸调 `zstd` 会失败并被逐文件 catch 静默吞掉。改为 `resolveExecutable()` 解析绝对路径（PATH + `DSH_EXTRA_BIN_DIRS` + `/opt/homebrew/bin` / `/usr/local/bin` / `~/.local/bin`）。
- 非 `.zstd` 的裸 `.jsonl` 直接读，不再无条件过 zstd。

### 其它 (Changed)

- 接入发布前门禁：仓库新增 `scripts/portability.mjs` + `PORTABILITY-SOP.md`，`package.json` 新增 `verify` / `verify:full` / `verify:quick`（健康路由 `/api/dsh-studio/list`）；`scripts/release.mjs` 升级到 dsh-release-kit 版（`files` 覆盖检查改为布局自适应、npm 凭据认 `DSH_HOME`）。

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- DSH peer：`^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1`
- 发布前可移植性验证：✅ 通过（隔离 `DSH_HOME` + tarball 安装 + 15s 稳定性观察）

## [0.2.1] - 2026-09-11

### 修复 (Fixed)

- fix(release): dry-run 不再触发真实 registry 校验；CHANGELOG peer 摘要只列 dsh 包

### 其它 (Changed)

- chore(release): 版本纪律工具链（release.mjs / RELEASE.md / CHANGELOG）+ 补 dsh.engines.dsh
- DSH 0.1.5-rc.1 对齐：devDeps 升级 + 客户端类型改由 cordis/renderer 提供

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- Node：`^22.19.0 || >=24.0.0`
- DSH peer：^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1

### 其它 (Changed)

- DSH 0.1.5-rc.1 对齐：devDependencies 升级，客户端类型改由 `cordis` / renderer 提供

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- Node：`^22.19.0 || >=24.0.0`

## [0.2.0] - 2026-08-29

### 新增 (Added)

- 合并「会话提取」能力：用 LLM 从会话日志提取候选 skill（`skillmgr_extract_*` 工具 + 面板待确认卡片）
- 接受的候选 skill 双写：写入 agent 自动加载根（`~/.agents/skills`）+ Obsidian 镜像目录
- 面板扫描支持 per-user 镜像目录（Obsidian skill 库）

### 其它 (Changed)

- 设置面板显示名改为「Skill 工作台」，提取候选卡片置顶
- 语义澄清：agent 根是必需的默认库，镜像目录是可选项
- 可移植性：按用户解析 agent skill 根，去掉硬编码用户路径
- 面板去重：高优先级根已收录时不再重复展示 custom/mirror 副本

### 兼容性 (Compatibility)

- Node：`^22.19.0 || >=24.0.0`
- 注：本版本尚未声明 `dsh.engines.dsh`（下一个版本补）

### 迁移说明 (Migration)

- 无破坏性变更：`0.1.x → 0.2.0` 为纯能力新增，原有 `skillmgr_*` 工具与面板行为不变。

## [0.1.2] - 2026-08-23

### 修复 (Fixed)

- `fix(tools)`：把 null 字段归一为空值，使 `skillmgr_*` 的输出通过 schema 校验

## [0.1.1] - 2026-08-23

### 新增 (Added)

- 首个发布
- 文件系统 skill 扫描器：frontmatter 解析 + 嵌套 bundle 展开
- `skillmgr_*` 宿主工具 + loopback 路由 + 系统提示公告
- 「Skill 工作台」设置面板：列出 / 查看 / 编辑 / 启用禁用 skill
- 测试：启动模拟 + 扫描与读写覆盖
- 双语 README（`README.md` / `README.zh.md`）

### 兼容性 (Compatibility)

- Node：`^22.19.0 || >=24.0.0`
