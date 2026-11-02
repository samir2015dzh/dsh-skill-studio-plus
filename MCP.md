# MCP 按需加载（studio 内置）

`dsh-skill-studio` 0.6.0 起自带 MCP 管理，参照 MCP-cell（luohui1/MCP-cell）的进程思路和
dsh-skill-mcp-manager 的目录化思路：**会话开头只给名字 + 截断描述，完整 schema 等真正要用再取**。

## 三档

| 档位 | 工具注册 | 进目录 | 用途 |
|---|---|---|---|
| **启用**（`eager`） | 注册成 `mcp__<server>__<tool>` | 是 | 高频、schema 小，或需要模型无条件看见的 |
| **按需启用**（`on-demand`，默认） | 不注册 | 是（名字 + 描述） | 工具多、schema 大的，按需 `mcp_load` |
| **停用**（`disabled`） | 不注册 | 否 | 临时关掉 |

省的是**每轮系统提示里的工具 schema**。实测：一个 95 工具的 MCP 走 eager 大约 33K token/轮，
走 on-demand 只剩十几行目录。

## 五个工具

- `mcp_list` — 档位、连接状态、工具数与截断描述。
- `mcp_register {name, tier, transport, command|url, args, env, headers, notes}` — 新增或修改。
  **先试连 + 拉一次工具列表**，通过才写注册表。
- `mcp_load {name, peek?}` — 建立连接并返回完整 `inputSchema`；`peek` 只读缓存不连接。
- `mcp_call {name, tool, args}` — 调用；on-demand 会按需连接，被回收过的会先重连。
- `mcp_takeover {name}` — 接管 profile 里已有的原生 MCP：禁用 `cordis.patch.yml` 里那条行，
  改由本插件按需加载。需要重启 DSH 才生效。

## 空闲回收

`idleTimeoutMinutes`（默认 5，`0` 关闭）内没有任何工具调用就断开上游：stdio 子进程退出 /
HTTP 会话关闭。**工具缓存与注册表保留**，下次调用透明重连——冷启动只发生在真正用到的时候。

- 活跃时间取「最近一次工具调用」，不是 UI 轮询。
- 单条服务器可用 `idleTimeout` 覆盖（单位分钟，支持小数）。

## 存储

`~/.dsh/dsh-skill-studio/mcp.json`

```json
{
  "version": 1,
  "idleTimeoutMinutes": 5,
  "toolDescriptionMaxLength": 150,
  "servers": [
    { "name": "context7", "tier": "on-demand", "transport": "stdio",
      "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }
  ]
}
```

## HTTP 面（设置页用，仅 loopback）

设置页入口：**设置 → MCP 服务器**（独立一页，不放在 Skill 工作台里——两者渲染树分开，
skill 列表刷新不会带着 MCP 面板重建）。布局照 MCP-cell：统计条 → 设置行 → 一行一个服务器，
状态点区分已连接 / 空闲 / 错误 / 已停用，档位用可点的胶囊切换。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/dsh-skill-studio/mcp` | 列表 |
| POST | `/api/dsh-skill-studio/mcp` | 新增/改（传 name + 要改的字段） |
| DELETE | `/api/dsh-skill-studio/mcp?name=` | 删除 |
| POST | `/api/dsh-skill-studio/mcp/reload` | 断开重连 |
| POST | `/api/dsh-skill-studio/mcp/settings` | 改空闲阈值 / 描述截断长度 |

## 已知限制

- 只桥接 tools，不桥接 resources / prompts / sampling。
- 单例连接（不是按会话隔离）：桌面版单用户，换来的复杂度不值得；要隔离请装 dsh-skill-mcp-manager。
- 无 OAuth 2.0：streamable-http 只支持静态 headers。需要 OAuth 的服务器请继续用原生 mcp-client 条目。
- 重连是「用到时重连」，没有指数退避；连不上会直接把错误抛给调用方。
- 启动时的自动导入扫三层 patch：`DSH_HOME/cordis.patch.yml`（全局层）、profile 的
  `cordis.patch.yml`、每个 bundle 的 `cordis.patch.yml`。写在前两层的手工 MCP 才会被认出来。
- 插件自己封装 MCP 的条目（如 `dsh-computer-use-win` → `mcp__wincu__*`）不会被自动导入：
  它的 patch 行 `name` 是插件包名，`serverName` 在插件 JS 里，静态扫描认不出来。
  这类要么在注册表里手动 `mcp_register`，要么继续用原生行。

## 验证

```powershell
# 起一个假 MCP（仅测试用）
node D:\dsh-plugins\dsh-skill-studio\test-mcp.mjs
# 在 DSH 里：mcp_register → mcp_load → mcp_call → 等 5 分钟 → mcp_call（应自动重连）
# 假 MCP 每次被拉起都会往 test-mcp.log 追加一行 start，可用来数冷启动次数
```

## 回滚

```powershell
copy lib\index.js.bak-mcp-20261102 lib\index.js
copy lib\client.js.bak-mcp-20261102 lib\client.js
```

`lib/mcp.js`、`lib/mcp-client.js` 是新增文件，删掉即可（删之前把 `index.js` 里对它们的
import 与 `mountMcp()` 一起去掉）。
