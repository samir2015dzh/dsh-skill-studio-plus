window.__ModuleLoader__.load({
	id: "dsh-studio",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");
		//#region src/client/api.ts
		/** Error carrying the route's JSON error message. */
		var ApiError = class extends Error {
			constructor(message) {
				super(message);
				this.name = "SkillManagerApiError";
			}
		};
		/** Parse a JSON response or throw an ApiError. */
		async function readJson(response) {
			let body;
			try {
				body = await response.json();
			} catch {
				throw new ApiError("HTTP " + response.status + ": invalid JSON response");
			}
			if (!response.ok) {
				throw new ApiError(typeof body === "object" && body !== null && typeof body.error === "string" ? body.error : "HTTP " + response.status);
			}
			return body;
		}
		/** Plain fetch helper with an error wrapper. */
		async function request(path, init) {
			let response;
			try {
				response = await fetch(path, init);
			} catch (error) {
				throw new ApiError("网络请求失败: " + String(error instanceof Error ? error.message : error));
			}
			return readJson(response);
		}
		/** The skill-manager panel API. */
		var Api = class {
			async list() {
				return request("/api/dsh-studio/list");
			}
			async get(name) {
				return request("/api/dsh-studio/skill?name=" + encodeURIComponent(name));
			}
			async save(name, content) {
				return request("/api/dsh-studio/skill", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name, content })
				});
			}
			async setPolicy(name, patch) {
				return request("/api/dsh-studio/policy", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(Object.assign({ name }, patch))
				});
			}
			/** 回收站：列表 / 删除到回收站 / 恢复 / 永久删除。 */
			async trashList() {
				return request("/api/dsh-studio/trash");
			}
			async trashSkill(name, cwd) {
				return request("/api/dsh-studio/trash", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name, cwd })
				});
			}
			async restoreTrash(id, name) {
				return request("/api/dsh-studio/restore", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id, name })
				});
			}
			async purgeTrash(id, name) {
				return request("/api/dsh-studio/purge", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id, name })
				});
			}
			/** 配置快照：建 / 列 / 恢复 / 清理 / 导出导入。 */
			async snapshotList() {
				return request("/api/dsh-studio/snapshot");
			}
			async snapshotCreate(label) {
				return request("/api/dsh-studio/snapshot", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ label })
				});
			}
			async snapshotRestore(id, dryRun, pathMap) {
				return request("/api/dsh-studio/snapshot/restore", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id, dryRun, pathMap })
				});
			}
			async snapshotPrune(keep) {
				return request("/api/dsh-studio/snapshot/prune", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ keep })
				});
			}
			async syncConfig(patch) {
				if (patch === undefined) return request("/api/dsh-studio/sync");
				return request("/api/dsh-studio/sync", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(patch)
				});
			}
			async syncPush(snapshotId, channel) {
				return request("/api/dsh-studio/sync/push", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ snapshotId, channel })
				});
			}
			async syncPull(channel, label) {
				return request("/api/dsh-studio/sync/pull", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ channel, label })
				});
			}
			async snapshotSchedule(patch) {
				if (patch === undefined) return request("/api/dsh-studio/snapshot/schedule");
				return request("/api/dsh-studio/snapshot/schedule", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(patch)
				});
			}
			async snapshotDelete(id) {
				return request("/api/dsh-studio/snapshot/delete", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id })
				});
			}
			async snapshotTransfer(payload) {
				return request("/api/dsh-studio/snapshot/transfer", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload)
				});
			}
			async extractStatus() {
				return request("/api/dsh-studio/extract-status");
			}
			async extractConfig(patch) {
				return request("/api/dsh-studio/extract-config", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(patch)
				});
			}
			async extractRun() {
				return request("/api/dsh-studio/extract-run", { method: "POST" });
			}
			async extractCandidates() {
				return request("/api/dsh-studio/extract-candidates");
			}
			async extractCandidate(id, patch) {
				return request("/api/dsh-studio/extract-candidate", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(Object.assign({ id }, patch))
				});
			}
			async extractAccept(ids) {
				return request("/api/dsh-studio/extract-accept", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ ids })
				});
			}
			async extractRecent() {
				return request("/api/dsh-studio/extract-recent");
			}
			async extractReject(ids) {
				return request("/api/dsh-studio/extract-reject", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ ids })
				});
			}
			/** MCP 按需加载：注册表、档位、空闲阈值。 */
			async mcpList() {
				return request("/api/dsh-studio/mcp");
			}
			async mcpUpsert(entry) {
				return request("/api/dsh-studio/mcp", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(entry)
				});
			}
			async mcpRemove(name) {
				return request("/api/dsh-studio/mcp?name=" + encodeURIComponent(name), { method: "DELETE" });
			}
			async mcpReload(name) {
				return request("/api/dsh-studio/mcp/reload", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name })
				});
			}
			async mcpPrefetch(name) {
				return request("/api/dsh-studio/mcp/prefetch", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name })
				});
			}
			async mcpTools(name, mode, names) {
				return request("/api/dsh-studio/mcp/tools", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name, mode, names })
				});
			}
			async mcpTakeover(name) {
				return request("/api/dsh-studio/mcp/takeover", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name })
				});
			}
			async mcpSettings(patch) {
				return request("/api/dsh-studio/mcp/settings", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(patch)
				});
			}
		};
		//#endregion
		//#region src/client/SkillManagerPanel.tsx
		/**
		 * Skill 管理器 settings panel — rendered inside the web settings page
		 * (settings.section entry). Lists every discovered skill with its
		 * invocation state, lets the user view/edit the full SKILL.md body, and
		 * toggle enable/disable (model / user invocation). Plain React with
		 * inline styles — no external UI package.
		 */
		/** Module-level API client (stateless; the component closes over it). */
		const api = new Api();
		/** Shortcut for React.createElement. */
		const h = React.createElement;
		/** One shared style sheet (theme-agnostic, mirrors dsh-flomo). */
		const s = {
			card: {
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				maxWidth: "760px",
				padding: "14px 16px",
				borderRadius: "10px",
				border: "1px solid color-mix(in srgb, currentColor 15%, transparent)",
				fontSize: "13px",
				color: "inherit"
			},
			title: { fontWeight: 600, fontSize: "13px", margin: 0 },
			status: { fontSize: "12px", opacity: 0.85 },
			statusWarn: { fontSize: "12px", opacity: 0.9, color: "#c9763a" },
			row: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
			item: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				padding: "8px 10px",
				borderRadius: "8px",
				border: "1px solid color-mix(in srgb, currentColor 13%, transparent)",
				background: "color-mix(in srgb, currentColor 3%, transparent)",
				cursor: "pointer"
			},
			itemSel: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				padding: "8px 10px",
				borderRadius: "8px",
				border: "1px solid rgba(90,140,220,0.6)",
				background: "rgba(90,140,220,0.08)",
				cursor: "pointer"
			},
			itemBody: { flex: 1, minWidth: 0 },
			itemName: { fontWeight: 600, fontSize: "12.5px", margin: 0, wordBreak: "break-all" },
			itemDesc: {
				fontSize: "11.5px",
				opacity: 0.75,
				margin: "2px 0 0",
				overflow: "hidden",
				textOverflow: "ellipsis",
				display: "-webkit-box",
				WebkitLineClamp: 2,
				WebkitBoxOrient: "vertical"
			},
			badge: {
				fontSize: "10.5px",
				padding: "1px 6px",
				borderRadius: "999px",
				border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
				whiteSpace: "nowrap"
			},
			badgeOn: {
				fontSize: "10.5px",
				padding: "1px 6px",
				borderRadius: "999px",
				border: "1px solid rgba(90,170,110,0.5)",
				color: "#4c9a63",
				whiteSpace: "nowrap"
			},
			badgeOff: {
				fontSize: "10.5px",
				padding: "1px 6px",
				borderRadius: "999px",
				border: "1px solid rgba(190,110,90,0.5)",
				color: "#b06a55",
				whiteSpace: "nowrap"
			},
			check: { margin: 0, accentColor: "#3b82f6" },
			label: { fontSize: "12px", display: "inline-flex", alignItems: "center", gap: "5px", cursor: "pointer" },
			button: {
				padding: "4px 10px",
				borderRadius: "6px",
				cursor: "pointer",
				border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
				background: "color-mix(in srgb, currentColor 7%, transparent)",
				color: "inherit",
				fontSize: "12px"
			},
			textarea: {
				width: "100%",
				boxSizing: "border-box",
				minHeight: "280px",
				resize: "vertical",
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: "12px",
				lineHeight: 1.5,
				padding: "8px 10px",
				borderRadius: "8px",
				border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
				background: "color-mix(in srgb, currentColor 4%, transparent)",
				color: "inherit"
			},
			meta: {
				fontSize: "11.5px",
				opacity: 0.8,
				margin: 0,
				wordBreak: "break-all",
				whiteSpace: "pre-wrap"
			},
			msg: { fontSize: "12px", whiteSpace: "pre-wrap", wordBreak: "break-all", opacity: 0.9 },
			msgErr: { fontSize: "12px", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "#c9763a" },
			flex: { flex: 1 },
			search: {
				flex: 1,
				minWidth: "150px",
				boxSizing: "border-box",
				padding: "5px 8px",
				borderRadius: "6px",
				border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
				background: "color-mix(in srgb, currentColor 4%, transparent)",
				color: "inherit",
				fontSize: "12px"
			},
			groupRow: {
				display: "flex",
				alignItems: "center",
				gap: "6px",
				padding: "5px 9px",
				marginTop: "4px",
				borderRadius: "7px",
				background: "color-mix(in srgb, currentColor 4%, transparent)",
				borderLeft: "3px solid rgba(90,140,220,0.45)",
				cursor: "pointer",
				userSelect: "none"
			},
			groupName: { fontWeight: 600, fontSize: "12.5px", opacity: 0.95 },
			groupCount: { fontSize: "10.5px", opacity: 0.55, marginLeft: "2px" }
		};
		/** Source label map (fall back to the raw source). */
		function sourceLabel(source) {
			const map = {
				"user-agents": "用户 ~/.agents/skills",
				"user-dsh": "用户 ~/.dsh/skills",
				"project-dsh": "项目 .dsh/skills",
				"project-agents": "项目 .agents/skills",
				custom: "自定义目录",
				runtime: "运行时注入",
				bundled: "内置 bundled"
			};
			return map[source] ?? source;
		}
		/** Invocation badge. */
		function InvBadge({ ok, children }) {
			return h("span", { style: ok ? s.badgeOn : s.badgeOff }, children);
		}
		/** Monochrome chevron (inline SVG, no emoji) used by the group fold rows. */
		function Chevron({ open }) {
			return h(
				"svg",
				{
					width: 10,
					height: 10,
					viewBox: "0 0 10 10",
					"aria-hidden": "true",
					style: { flex: "0 0 auto", transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms ease" }
				},
				h("path", {
					d: "M3 1.5 L7 5 L3 8.5",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.4,
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})
			);
		}
		/** One collapsible group header row (group view). */
		function GroupHeader({ label, count, open, hint, onToggle }) {
			return h(
				"div",
				{ style: s.groupRow, onClick: onToggle },
				h(Chevron, { key: "c", open }),
				h("span", { style: s.groupName, key: "n" }, label),
				h("span", { style: s.groupCount, key: "k" }, String(count)),
				hint ? h("span", { style: s.badge, key: "h" }, hint) : null
			);
		}
		/** Master + per-interface checkboxes for one skill. */
		function PolicyRow({ skill, disabled, onToggle }) {
			const checked = skill.modelInvocable && skill.userInvocable;
			return h(
				"div",
				{ style: s.row },
				h(
					"label",
					{ style: s.label },
					h("input", {
						type: "checkbox",
						style: s.check,
						checked,
						disabled,
						onChange: (event) => onToggle({ enabled: event.target.checked })
					}),
					"启用"
				),
				h(
					"label",
					{ style: s.label },
					h("input", {
						type: "checkbox",
						style: s.check,
						checked: skill.modelInvocable,
						disabled,
						onChange: (event) => onToggle({ modelInvocable: event.target.checked })
					}),
					"模型可调用"
				),
				h(
					"label",
					{ style: s.label },
					h("input", {
						type: "checkbox",
						style: s.check,
						checked: skill.userInvocable,
						disabled,
						onChange: (event) => onToggle({ userInvocable: event.target.checked })
					}),
					"用户可调用"
				)
			);
		}
		/** One skill row in the list view——和 MCP 面板同一套行卡语言。 */
		function SkillRow({ skill, selected, onSelect, onToggle, onDelete, showGroup }) {
			const editable = skill.editable === true;
			const active = skill.modelInvocable === true && skill.userInvocable === true;
			const badges = [];
			if (showGroup && typeof skill.group === "string" && skill.group !== "") {
				badges.push(h("span", { style: s.badge, key: "grp" }, skill.group));
			}
			badges.push(h("span", { style: s.badge, key: "src" }, sourceLabel(skill.source)));
			if (skill.nested) badges.push(h("span", { style: s.badge, key: "nest" }, "嵌套"));
			if (!editable) badges.push(h("span", { style: s.badgeOff, key: "ro" }, "只读"));
			// 宿主只认 kebab-case 的 frontmatter name，中文名会让它默默加载不了
			if (skill.nameValid === false) {
				badges.push(
					h(
						"span",
						{ style: s.badgeOff, key: "nv", title: "frontmatter name 是「" + (skill.declaredName || "") + "」，宿主只认小写字母/数字/连字符" },
						"宿主不认这个名"
					)
				);
			}
			if (typeof skill.shadowedBy === "string" && skill.shadowedBy !== "") {
				badges.push(
					h("span", { style: s.badge, key: "sb", title: "同名技能以 " + skill.shadowedBy + " 生效" }, "被 " + skill.shadowedBy + " 盖住")
				);
			}
			if (Array.isArray(skill.shadows) && skill.shadows.length > 0) {
				badges.push(h("span", { style: s.badge, key: "sw", title: "盖住了 " + skill.shadows.join(", ") }, "盖住 " + skill.shadows.length + " 个"));
			}
			return h(
				"div",
				{
					style: {
						display: "flex",
						alignItems: "center",
						gap: "10px",
						padding: "9px 11px",
						borderRadius: "9px",
						border: selected ? "1px solid rgba(90,140,220,0.6)" : "1px solid color-mix(in srgb, currentColor 13%, transparent)",
						background: selected ? "rgba(90,140,220,0.08)" : "color-mix(in srgb, currentColor 3%, transparent)",
						cursor: "pointer"
					},
					onClick: onSelect
				},
				h("span", {
					style: {
						width: "7px",
						height: "7px",
						borderRadius: "50%",
						flex: "0 0 auto",
						background: active ? "#4c9a63" : "#9a9a9a"
					}
				}),
				h(
					"div",
					{ style: { flex: 1, minWidth: 0 } },
					h(
						"div",
						{ style: { display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap" } },
						h("span", { style: { fontWeight: 600, fontSize: "12.5px" } }, skill.name),
						...badges
					),
					h(
						"div",
						{
							style: {
								fontSize: "11.5px",
								opacity: 0.7,
								marginTop: "2px",
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap"
							}
						},
						skill.description || "（无描述）"
					)
				),
				h(
					"label",
					{
						style: {
							display: "inline-flex",
							alignItems: "center",
							gap: "5px",
							fontSize: "11.5px",
							opacity: editable ? 0.85 : 0.4
						},
						onClick: (event) => event.stopPropagation()
					},
					h("input", {
						type: "checkbox",
						style: { margin: 0, accentColor: "#3b82f6" },
						checked: active,
						disabled: !editable,
						onChange: (event) => onToggle({ enabled: event.target.checked })
					}),
					"启用"
				),
				typeof onDelete === "function" && typeof skill.dir === "string" && skill.dir !== ""
					? h(
						"button",
						{
							style: Object.assign({}, s.button, { fontSize: "11px", padding: "2px 7px" }),
							onClick: (event) => {
							event.stopPropagation();
							onDelete(skill);
							}
						},
						"删除"
					)
					: null
			);
		}
		/** Inline style for compact single-line inputs in the extractor panel. */
		function smallInput(extra) {
			return Object.assign(
				{ boxSizing: "border-box", padding: "5px 8px", borderRadius: "6px", border: "1px solid color-mix(in srgb, currentColor 18%, transparent)", background: "color-mix(in srgb, currentColor 4%, transparent)", color: "inherit", fontSize: "12px" },
				extra || {}
			);
		}
		/**
		 * MCP 服务器面板（独立设置页）。
		 * 布局参照 MCP-cell：顶部统计条 → 设置行 → 一行一个服务器。
		 */
		function McpPanel() {
			const [data, setData] = React.useState(null);
			// 忙状态记到具体服务器：一台在重连时，别的服务器的档位仍可点
			const [busyKey, setBusyKey] = React.useState(null);
			const busy = busyKey !== null;
			const [msg, setMsg] = React.useState("");
			const [err, setErr] = React.useState("");
			const [openTools, setOpenTools] = React.useState(null);
			const [serverQuery, setServerQuery] = React.useState("");
			const [tierFilter, setTierFilter] = React.useState("all");
			const [connFilter, setConnFilter] = React.useState("all");
			// 凭据默认掩码：key = "<server>|<kind>|<key>"，展开过才显示明文
			const [revealedCreds, setRevealedCreds] = React.useState({});
			const [copiedKey, setCopiedKey] = React.useState("");
			const [toolQuery, setToolQuery] = React.useState("");
			const [confirmRemove, setConfirmRemove] = React.useState(null);
			const [idle, setIdle] = React.useState("5");
			const [trunc, setTrunc] = React.useState("150");
			const refresh = React.useCallback(async () => {
				try {
					const result = await api.mcpList();
					setData(result);
					setIdle(String(result.idleTimeoutMinutes ?? 5));
					setTrunc(String(result.toolDescriptionMaxLength ?? 150));
					setErr("");
				} catch (error) {
					setErr("读取失败：" + String(error instanceof Error ? error.message : error));
				}
			}, []);
			React.useEffect(() => {
				refresh();
			}, [refresh]);
			// 忙状态记到具体服务器：一台在重连时，别的服务器的档位胶囊仍可点
			const run = async (action, key = "*") => {
				setBusyKey(key);
				setMsg("");
				setErr("");
				try {
					return await action();
				} catch (error) {
					setErr("操作失败：" + String(error instanceof Error ? error.message : error));
					return null;
				} finally {
					setBusyKey(null);
				}
			};
			const setTier = (server, tier) =>
				run(async () => {
					await api.mcpUpsert({ name: server.name, tier });
					setMsg(server.name + " 已设为「" + TIER_LABEL[tier] + "」");
					refresh();
				}, server.name);
			const reload = (server) =>
				run(async () => {
					await api.mcpReload(server.name);
					setMsg(server.name + " 已重连");
					refresh();
				}, server.name);
			const remove = (server) =>
				run(async () => {
					// 删除会连带丢掉 notes / 工具白名单 / 空闲阈值，所以点两下才删
					if (confirmRemove !== server.name) {
						setConfirmRemove(server.name);
						setMsg("再点一次「确认删除」——会一并丢掉 " + server.name + " 的备注、工具白名单和空闲阈值");
						setTimeout(() => setConfirmRemove((cur) => (cur === server.name ? null : cur)), 4000);
						return;
					}
					setConfirmRemove(null);
					await api.mcpRemove(server.name);
					setMsg("已删除 " + server.name);
					refresh();
				}, server.name);
			const saveTools = (server, mode, names) =>
				run(async () => {
					const result = await api.mcpTools(server.name, mode, names);
					setMsg(
						server.name +
							" 工具过滤已保存：" +
							result.server.toolCount +
							" / " +
							result.server.rawToolCount +
							" 个对外可见"
					);
					refresh();
				}, server.name);
			const takeover = (server) =>
				run(async () => {
					const result = await api.mcpTakeover(server.name);
					setMsg(
						server.name +
							" 已接管（原生行 " +
							(result.rowId || "?") +
							(result.changed ? " 已禁用" : " 本来就是禁用") +
							"），重启 DSH 后由插件按需连接"
					);
					refresh();
				}, server.name);
			const saveSettings = () =>
				run(async () => {
					const result = await api.mcpSettings({
						idleTimeoutMinutes: Number(idle),
						toolDescriptionMaxLength: Number(trunc)
					});
					setMsg("空闲 " + result.idleTimeoutMinutes + " 分钟回收 · 描述截断 " + result.toolDescriptionMaxLength + " 字");
					refresh();
				});
			// 三档只讲状态：启用 / 按需启用 / 停用（内部值仍是 eager / on-demand / disabled）
			const TIER_LABEL = { eager: "启用", "on-demand": "按需启用", disabled: "停用" };
			const TIER_HINT = {
				eager: "连上就把每个工具都注册给模型，最省心但每轮都占 token",
				"on-demand": "只在目录里露名字和一句摘要，模型要用时再加载完整参数",
				disabled: "完全不连接、不暴露给模型"
			};
			const servers = data === null ? [] : data.servers ?? [];
			const connected = servers.filter((x) => x.status === "connected").length;
			// 只数真正空闲的：停用档不连接、错误档连过但失败，各有各的状态，不能冒充「未连接」
			const idleCount = servers.filter((x) => x.status === "idle").length;
			const errorCount = servers.filter((x) => x.status === "error").length;
			const toolTotal = servers.reduce((sum, x) => sum + (x.toolCount ?? 0), 0);
			const tierCount = (tier) => servers.filter((x) => x.tier === tier).length;
			const visibleServers = servers.filter((server) => {
				if (tierFilter !== "all" && server.tier !== tierFilter) return false;
				if (connFilter !== "all" && server.status !== connFilter) return false;
				const needle = serverQuery.trim().toLowerCase();
				if (needle === "") return true;
				return (server.name + " " + (server.notes ?? "")).toLowerCase().includes(needle);
			});
			/** 敏感值只露首尾，中间打点。 */
			const maskValue = (value) => {
				const text = String(value ?? "");
				if (text.length <= 6) return "\u2022".repeat(Math.max(4, text.length));
				return "\u2022".repeat(8) + text.slice(-4);
			};
			const copyValue = async (key, value) => {
				try {
					await navigator.clipboard.writeText(String(value ?? ""));
					setCopiedKey(key);
					setTimeout(() => setCopiedKey(""), 1200);
				} catch {
					setErr("复制失败：浏览器拒绝写入剪贴板");
				}
			};
			// 归 studio 管即视为已接管：studio 自建条目没有原生行可禁用，与原生行已禁用等价
			const owned = (server) => server.sourceRowId == null || server.nativeDisabled === true;
			const statusLabel = (status) =>
				status === "connected"
					? "已连接"
					: status === "error"
						? "连接错误"
						: status === "disabled"
							? "已停用（不连接）"
							: "空闲（未连接）";
			// 状态点 = 归属状态：绿＝由本插件全权加载，灰＝原生行仍常驻（未接管）
			const dot = (server) => ({
				width: "7px",
				height: "7px",
				borderRadius: "50%",
				display: "inline-block",
				flex: "0 0 auto",
				background: owned(server) ? "#4c9a63" : "#9a9a9a"
			});
			const field = {
				padding: "3px 6px",
				borderRadius: "6px",
				border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
				background: "transparent",
				color: "inherit",
				fontSize: "12px"
			};
			const stat = (value, label) =>
				h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "1px", minWidth: "52px" } },
					h("span", { style: { fontSize: "17px", fontWeight: 600, lineHeight: 1.1 } }, String(value)),
					h("span", { style: { fontSize: "11px", opacity: 0.65 } }, label)
				);
			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "12px", maxWidth: "820px", fontSize: "13px" } },
				h(
					"div",
					{ style: { display: "flex", alignItems: "baseline", gap: "8px" } },
					h("span", { style: { fontWeight: 600, fontSize: "14px" } }, "MCP 服务器"),
					h(
						"span",
						{ style: { fontSize: "11.5px", opacity: 0.6 } },
						"按需加载：目录只给名字和摘要，完整参数由 mcp_load 取"
					)
				),
				h(
					"div",
					{ style: { display: "flex", gap: "26px", alignItems: "flex-end" } },
					stat(servers.length, "服务器"),
					stat(connected, "已连接"),
					stat(toolTotal, "工具")
				),
				h(
					"div",
					{ style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", fontSize: "12px" } },
					h("input", {
						style: Object.assign({}, field, { flex: "1 1 170px", minWidth: "130px" }),
						placeholder: "筛选服务器名 / 备注",
						value: serverQuery,
						onChange: (event) => setServerQuery(event.target.value)
					}),
					h("span", { style: { opacity: 0.75 } }, "空闲"),
					h("input", {
						style: Object.assign({}, field, { width: "46px" }),
						value: idle,
						disabled: busy,
						onChange: (event) => setIdle(event.target.value)
					}),
					h("span", { style: { opacity: 0.75 } }, "分"),
					h("input", {
						style: Object.assign({}, field, { width: "50px", marginLeft: "6px" }),
						value: trunc,
						disabled: busy,
						onChange: (event) => setTrunc(event.target.value)
					}),
					h("span", { style: { opacity: 0.75 } }, "字截断"),
					h("button", { style: s.button, disabled: busy, onClick: saveSettings }, "保存"),
					h("button", { style: s.button, disabled: busy, onClick: refresh }, "刷新")
				),
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", flexWrap: "wrap" } },
					h("span", { style: { opacity: 0.45, fontSize: "11px" } }, "档位"),
					[
						["all", "全部", servers.length],
						["eager", "启用", tierCount("eager")],
						["on-demand", "按需", tierCount("on-demand")],
						["disabled", "停用", tierCount("disabled")]
					].map(([key, label, n]) =>
						h(
							"span",
							{
								key,
								onClick: () => setTierFilter(key),
								style: {
									padding: "1px 9px",
									borderRadius: "999px",
									cursor: "pointer",
									userSelect: "none",
									border: tierFilter === key ? "1px solid rgba(90,140,220,0.6)" : "1px solid transparent",
									background: tierFilter === key ? "rgba(90,140,220,0.12)" : "transparent",
									opacity: tierFilter === key ? 1 : 0.45
								}
							},
							label + " " + n
						)
					),
					h("span", { style: { opacity: 0.2, margin: "0 6px" } }, "│"),
					h("span", { style: { opacity: 0.45, fontSize: "11px" } }, "状态"),
					[
						["connected", "已连接", connected],
						["idle", "未连接", idleCount],
						["error", "错误", errorCount]
					].filter(([key, , n]) => key !== "error" || n > 0).map(([key, label, n]) =>
						h(
							"span",
							{
								key,
								onClick: () => setConnFilter(connFilter === key ? "all" : key),
								style: {
									padding: "1px 9px",
									borderRadius: "999px",
									cursor: "pointer",
									userSelect: "none",
									border: connFilter === key ? "1px solid rgba(90,140,220,0.6)" : "1px solid transparent",
									background: connFilter === key ? "rgba(90,140,220,0.12)" : "transparent",
									opacity: connFilter === key ? 1 : 0.45
								}
							},
							label + " " + n
						)
					)
				),
				err ? h("div", { style: { fontSize: "12px", color: "#b06a55" } }, err) : null,
				msg ? h("div", { style: { fontSize: "12px", opacity: 0.8 } }, msg) : null,
				servers.length === 0
					? h(
							"div",
							{
								style: {
									padding: "18px",
									borderRadius: "10px",
									border: "1px dashed color-mix(in srgb, currentColor 18%, transparent)",
									fontSize: "12px",
									opacity: 0.75,
									textAlign: "center"
								}
							},
							"还没有 MCP 服务器。在对话里用 mcp_register 添加——它会先试连、拉到工具列表才写入。"
					  )
					: visibleServers.length === 0
						? h("div", { style: { fontSize: "12px", opacity: 0.6, padding: "10px 2px" } }, "没有匹配的服务器。")
						: h(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: "6px" } },
							visibleServers.map((server) => [
								h(
									"div",
									{
										key: server.name,
										style: {
											display: "flex",
											alignItems: "center",
											gap: "10px",
											padding: "9px 11px",
											borderRadius: "9px",
											border: "1px solid color-mix(in srgb, currentColor 13%, transparent)",
											background: "color-mix(in srgb, currentColor 3%, transparent)"
										}
									},
									h("span", { style: dot(server), title: server.sourceRowId == null ? "由 studio 管理（无原生行）" : server.nativeDisabled === true ? "已接管（原生行已禁用）" : "未接管（原生行仍常驻）" }),
									h(
										"div",
										{ style: { flex: 1, minWidth: 0 } },
										h(
											"div",
											{ style: { display: "flex", alignItems: "center", gap: "7px" } },
											h("span", { style: { fontWeight: 600, fontSize: "12.5px" } }, server.name),
											["eager", "on-demand", "disabled"].map((tier) =>
												h(
													"span",
													{
														key: tier,
														title: TIER_HINT[tier],
														onClick: busyKey === server.name
															? undefined
															: () => {
																	if (server.tier === tier) {
																		setMsg(server.name + " 已经是「" + TIER_LABEL[tier] + "」");
																		return;
																	}
																	setTier(server, tier);
															  },
														style: {
															fontSize: "10.5px",
															padding: "1px 6px",
															borderRadius: "999px",
															cursor: busyKey === server.name ? "default" : "pointer",
															border:
																server.tier === tier
																	? "1px solid rgba(90,140,220,0.6)"
																	: "1px solid transparent",
																background:
																server.tier === tier ? "rgba(90,140,220,0.12)" : "transparent",
																opacity: server.tier === tier ? 1 : 0.4,
																fontWeight: server.tier === tier ? 600 : 400
															}
													},
													TIER_LABEL[tier]
												)
											)
										),
										h(
											"div",
											{ style: { fontSize: "11.5px", opacity: 0.7, marginTop: "2px" } },
											server.toolCount +
												" 个工具 · " +
												server.transport +
												(server.sourceRowId
													? server.nativeDisabled === true
														? " · 已接管（原生已禁用）"
														: " · 未接管（原生仍常驻）"
													: " · 由 studio 管理（无原生行）") +
												" · " +
												statusLabel(server.status) +
												(server.error ? " · " + server.error : "")
										),
										server.notes
											? h("div", { style: { fontSize: "11px", opacity: 0.6, marginTop: "2px" } }, server.notes)
											: null,
										Array.isArray(server.credentials) && server.credentials.length > 0
												? h(
													"div",
													{ style: { display: "flex", flexDirection: "column", gap: "1px", marginTop: "3px" } },
													server.credentials.map((cred) => {
														const id = server.name + "|" + cred.kind + "|" + cred.key;
														const shown = revealedCreds[id] === true;
														const text = cred.sensitive === true && !shown ? maskValue(cred.value) : cred.value;
														return h(
															"div",
															{ key: id, style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", flexWrap: "nowrap" } },
															h("span", { title: cred.kind + " · " + cred.key, style: { opacity: 0.55, minWidth: "96px", whiteSpace: "nowrap", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis" } }, cred.key),
															h("span", { style: { fontFamily: "ui-monospace, monospace", opacity: 0.8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 auto", minWidth: 0 } }, text),
															cred.sensitive === true
																? h("span", { title: shown ? "隐藏" : "显示明文", onClick: () => setRevealedCreds((prev) => Object.assign({}, prev, { [id]: prev[id] !== true })), style: { cursor: "pointer", opacity: 0.55, userSelect: "none", whiteSpace: "nowrap", flexShrink: 0 } }, shown ? "隐藏" : "显示")
																: null,
															h("span", { title: "复制完整值", onClick: () => copyValue(id, cred.value), style: { cursor: "pointer", opacity: 0.55, userSelect: "none", whiteSpace: "nowrap", flexShrink: 0 } }, copiedKey === id ? "已复制" : "复制")
														)
													})
												)
												: null
									),
									h(
									"button",
									{
										style: s.button,
										disabled: busyKey === server.name,
										onClick: () => {
											if (openTools === server.name) {
												setOpenTools(null);
												return;
											}
											setOpenTools(server.name);
											setToolQuery("");
											// 停用档不会预热，缓存是空的——点开时试连一次把工具清单拉下来
											if ((server.rawToolCount || 0) === 0) {
												run(async () => {
													const result = await api.mcpPrefetch(server.name);
													setMsg(server.name + " 拉到 " + result.toolCount + " 个工具（试连后已断开）");
													refresh();
												});
											}
										}
									},
									"工具 " + server.toolCount + "/" + (server.rawToolCount || server.toolCount)
								),
								server.sourceRowId && server.nativeDisabled !== true &&
									h("button", { style: s.button, disabled: busyKey === server.name, onClick: () => takeover(server) }, "接管"),
								h("button", { style: s.button, disabled: busyKey === server.name, onClick: () => reload(server) }, "重载"),
									h(
										"button",
										{
											style:
												confirmRemove === server.name
													? Object.assign({}, s.button, { color: "#b06a55", borderColor: "#b06a55" })
													: s.button,
											disabled: busyKey === server.name,
											onClick: () => remove(server)
										},
										confirmRemove === server.name ? "确认删除" : "删除"
									)
								),
							openTools === server.name
								? (() => {
										const cur = server;
										const names = new Set((cur.toolFilter && cur.toolFilter.names) || []);
										const mode = (cur.toolFilter && cur.toolFilter.mode) || "all";
										const q = toolQuery.trim().toLowerCase();
										const list = (cur.allTools || []).filter((t) => q === "" || (t.name + " " + t.description).toLowerCase().includes(q));
										return h(
											"div",
											{
													key: server.name + ":tools",
												style: {
													display: "flex",
													flexDirection: "column",
													gap: "8px",
													padding: "11px 13px",
													borderRadius: "9px",
													border: "1px solid rgba(90,140,220,0.4)",
													background: "rgba(90,140,220,0.05)"
												}
											},
											h(
												"div",
												{ style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", fontSize: "12px" } },
												h("span", { style: { fontWeight: 600 } }, cur.name + " 的工具"),
												h("span", { style: { opacity: 0.6 } }, "对外 " + cur.toolCount + " / 共 " + (cur.rawToolCount || cur.toolCount)),
												h("div", { style: { flex: 1 } }),
												["all", "allow", "deny"].map((m) =>
													h(
														"span",
														{
															key: m,
															onClick: busyKey === cur.name ? undefined : () => saveTools(cur, m, Array.from(names)),
															style: {
																fontSize: "10.5px",
																padding: "1px 7px",
																borderRadius: "999px",
																cursor: busyKey === cur.name ? "default" : "pointer",
																border: mode === m ? "1px solid rgba(90,140,220,0.6)" : "1px solid transparent",
																background: mode === m ? "rgba(90,140,220,0.12)" : "transparent",
																opacity: mode === m ? 1 : 0.45
															}
														},
														m === "all" ? "全部" : m === "allow" ? "只留勾选" : "去掉勾选"
													)
												)
											),
											h("input", {
												style: field,
												placeholder: "筛选工具名 / 描述",
												value: toolQuery,
												onChange: (e) => setToolQuery(e.target.value)
											}),
											h(
												"div",
												{ style: { maxHeight: "260px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "2px" } },
												list.map((t) =>
													h(
														"label",
														{ key: t.name, style: { display: "flex", alignItems: "center", gap: "7px", fontSize: "11.5px", padding: "2px 4px" } },
														h("input", {
															type: "checkbox",
															style: { margin: 0, accentColor: "#3b82f6" },
															checked: mode === "all" ? true : mode === "allow" ? names.has(t.name) : !names.has(t.name),
															disabled: busyKey === cur.name || mode === "all",
															onChange: (e) => {
																const next = new Set(names);
																if (e.target.checked) next.add(t.name);
																else next.delete(t.name);
																saveTools(cur, mode === "all" ? "allow" : mode, Array.from(next));
															}
														}),
														h("span", { style: { fontWeight: 600 } }, t.name),
														h(
															"span",
															{ style: { opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
															t.description || ""
														)
													)
												)
											)
										);
									})()
									: null
								])
					  )
			);
		}
		/** Skill extraction candidates panel (merged from dsh-skill-extractor). */
		function ExtractorPanel() {
			const [view, setView] = React.useState(null);
			const [enabled, setEnabled] = React.useState(true);
			const [intervalMinutes, setIntervalMinutes] = React.useState("1440");
			const [windowDays, setWindowDays] = React.useState("7");
			const [maxCandidatesPerRun, setMaxCandidatesPerRun] = React.useState("3");
			const [skillLanguage, setSkillLanguage] = React.useState("zh");
			const [llmBaseUrl, setLlmBaseUrl] = React.useState("");
			const [llmApiKey, setLlmApiKey] = React.useState("");
			const [modelChoice, setModelChoice] = React.useState("");
			const [mirrorDir, setMirrorDir] = React.useState("");
			const [agentSkillDir, setAgentSkillDir] = React.useState("");
			const [candidates, setCandidates] = React.useState([]);
			const [recent, setRecent] = React.useState([]);
			const [editingId, setEditingId] = React.useState(null);
			const [draft, setDraft] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [msg, setMsg] = React.useState("");
			const [err, setErr] = React.useState("");
			/** Assemble the full SKILL.md text for a candidate (frontmatter + body). */
			const assemble = (c) => {
				const front = "---\nname: " + c.name + "\ndescription: " + (c.description || "") + (c.group ? "\nmetadata:\n  group: " + c.group : "") + "\n---\n";
				const body = (c.body || "").startsWith("#") ? c.body : "# " + c.name + "\n\n" + (c.body || "");
				return front + "\n" + body + "\n";
			};
			const load = React.useCallback(async () => {
				try {
					const v = await api.extractStatus();
					setView(v);
					setEnabled(v.enabled !== false);
					setIntervalMinutes(String(v.intervalMinutes ?? "1440"));
					setWindowDays(String(v.windowDays ?? "7"));
					setMaxCandidatesPerRun(String(v.maxCandidatesPerRun ?? "3"));
					setSkillLanguage(v.skillLanguage || "zh");
					setLlmBaseUrl(v.llmBaseUrl || "");
					setModelChoice(v.provider && v.model ? v.provider + " " + v.model : "");
					setMirrorDir(v.mirrorDir || "");
					setAgentSkillDir(v.agentSkillDir || "");
					const c = await api.extractCandidates();
					setCandidates((c && c.candidates) || []);
					const rec = await api.extractRecent().catch(() => null);
					setRecent((rec && rec.skills) || []);
					setErr("");
				} catch (error) {
					setErr("读取提取状态失败: " + String(error instanceof Error ? error.message : error));
				}
			}, []);
			React.useEffect(() => {
				load();
			}, [load]);
			const run = async (action) => {
				setBusy(true);
				setMsg("");
				setErr("");
				try {
					return await action();
				} catch (error) {
					setErr("操作失败: " + String(error instanceof Error ? error.message : error));
					return null;
				} finally {
					setBusy(false);
				}
			};
			const saveConfig = () =>
				run(async () => {
					const patch = {
						enabled,
						intervalMinutes: Number(intervalMinutes) || 0,
						windowDays: Number(windowDays) || 7,
						maxCandidatesPerRun: Number(maxCandidatesPerRun) || 3,
						skillLanguage,
						llmBaseUrl: llmBaseUrl.trim(),
						provider: (modelChoice ? modelChoice.split(" ")[0] : "").trim(),
						model: (modelChoice ? modelChoice.split(" ")[1] || "" : "").trim(),
						mirrorDir: mirrorDir.trim()
					};
					if (llmApiKey.trim() !== "") patch.llmApiKey = llmApiKey.trim();
					await api.extractConfig(patch);
					setLlmApiKey("");
					setMsg("配置已保存。");
					await load();
				});
			const runExtract = () =>
				run(async () => {
					const r = await api.extractRun();
					setMsg(r.ok ? r.message : "提取失败: " + r.message);
					await load();
				});
			const openEdit = (c) => {
				setEditingId(c.id);
				setDraft(assemble(c));
				setMsg("编辑候选 " + c.name);
			};
			const saveDraft = () =>
				run(async () => {
					const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(draft);
					let name = "";
					let description = "";
					if (m) {
						const n = /^name\s*:\s*(.+)$/m.exec(m[1]);
						const d = /^description\s*:\s*(.+)$/m.exec(m[1]);
						if (n) name = n[1].trim();
						if (d) description = d[1].trim();
					}
					const body = m ? draft.slice(m[0].length).trim() : draft.trim();
					if (!name) {
						setErr("frontmatter 缺少 name，无法保存草稿。");
						return null;
					}
					const r = await api.extractCandidate(editingId, {
						name: name.replace(/\s+/g, "-").toLowerCase(),
						description,
						body
					});
					setMsg(r.ok ? "草稿已保存。" : "保存草稿失败。");
					setEditingId(null);
					await load();
				});
			const acceptCand = (c) =>
				run(async () => {
					const r = await api.extractAccept([c.id]);
					setMsg("已接受: " + ((r && r.written && r.written.length) ? r.written.join(", ") : "（无写入）"));
					await load();
				});
			const rejectCand = (c) =>
				run(async () => {
					await api.extractReject([c.id]);
					setMsg("已拒绝该候选。");
					await load();
				});
			const status = view
				? "插件" + (view.enabled ? "已启用" : "已禁用") +
					" · " + (view.intervalMinutes === 0 ? "已关闭定时" : "每 " + view.intervalMinutes + " 分钟") +
					" · 窗口 " + view.windowDays + " 天 · LLM " + (view.dshModel ? "走 DSH 模型" : view.configured ? "已配置" : "未配置") + (view.resolvedModel ? "（实际用 " + view.resolvedModel + "）" : "") +
					" · 待确认 " + (view.queued ?? 0) + " 个 · 上次 " + (view.lastRunAt ? new Date(view.lastRunAt).toLocaleString() : "未运行") +
					" · 默认存 agent 根" + (view.mirrorDir ? " · 额外镜像 " + view.mirrorDir : "（不存镜像）")
				: "加载中…";
			// 四组：开关 / 调度 / 输出位置 / 模型。每组一张小卡，一行一个字段。
			const group = (title, children) =>
				h(
					"div",
					{
						style: {
							display: "flex",
							flexDirection: "column",
							gap: "7px",
							padding: "11px 13px",
							borderRadius: "9px",
							border: "1px solid color-mix(in srgb, currentColor 11%, transparent)",
							background: "color-mix(in srgb, currentColor 2%, transparent)"
						}
					},
					h("span", { style: { fontSize: "11px", opacity: 0.55, letterSpacing: "0.04em" } }, title),
					...children.filter(Boolean)
				);
			const field = (label, control, hint) =>
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
					h("span", { style: { fontSize: "12px", opacity: 0.8, minWidth: "68px" } }, label),
					control,
					hint ? h("span", { style: { fontSize: "11px", opacity: 0.5 } }, hint) : null
				);
			const rowCard = {
				display: "flex",
				alignItems: "flex-start",
				gap: "8px",
				padding: "9px 11px",
				borderRadius: "9px",
				border: "1px solid color-mix(in srgb, currentColor 13%, transparent)",
				background: "color-mix(in srgb, currentColor 3%, transparent)"
			};
			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "10px" } },
				h("div", { style: { fontSize: "12px", opacity: 0.7, lineHeight: 1.6 } }, status),
				group("开关", [
					h(
						"label",
						{ style: { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12.5px" } },
						h("input", {
							type: "checkbox",
							style: { margin: 0, accentColor: "#3b82f6" },
							checked: enabled,
							onChange: (e) => setEnabled(e.target.checked)
						}),
						"自动提取"
					)
				]),
				group("调度", [
					field(
						"兜底间隔",
						h("input", {
							style: smallInput({ width: "84px" }),
							placeholder: "1440",
							value: intervalMinutes,
							onChange: (e) => setIntervalMinutes(e.target.value)
						}),
						"分钟 · 0 = 只靠每轮判断"
					),
					field(
						"扫描窗口",
						h("input", {
							style: smallInput({ width: "70px" }),
							value: windowDays,
							onChange: (e) => setWindowDays(e.target.value)
						}),
						"天"
					),
					field(
						"每次候选",
						h("input", {
							style: smallInput({ width: "70px" }),
							value: maxCandidatesPerRun,
							onChange: (e) => setMaxCandidatesPerRun(e.target.value)
						}),
						"条"
					),
					field(
						"正文语言",
						h(
							"select",
							{ style: smallInput({ width: "110px" }), value: skillLanguage, onChange: (e) => setSkillLanguage(e.target.value) },
							[
								h("option", { value: "auto", key: "auto" }, "跟随会话"),
								h("option", { value: "zh", key: "zh" }, "中文"),
								h("option", { value: "en", key: "en" }, "英文")
							]
						)
					)
				]),
				group("输出位置", [
					h(
						"div",
						{ style: { fontSize: "11.5px", opacity: 0.7, wordBreak: "break-all" } },
						"自动加载根：" + (agentSkillDir || "~/.agents/skills")
					),
					field(
						"额外镜像",
						h("input", {
							style: smallInput({ flex: "1 1 220px", minWidth: "180px" }),
							placeholder: "可选，留空 = 只存加载根",
							value: mirrorDir,
							onChange: (e) => setMirrorDir(e.target.value)
						})
					)
				]),
				group("模型", [
					h(
						"select",
						{ style: smallInput({ width: "100%" }), value: modelChoice, onChange: (e) => setModelChoice(e.target.value) },
						[
							h("option", { value: "", key: "auto" }, "自动（跟随当前会话）"),
							...((view && view.availableModels) || []).map((m) =>
								h("option", { value: m.provider + " " + m.model, key: m.label }, m.label)
							),
							modelChoice && !((view && view.availableModels) || []).some((m) => m.provider + " " + m.model === modelChoice)
								? h("option", { value: modelChoice, key: "custom" }, "自定义 " + modelChoice.split(" ").join(" / "))
								: null
						].filter(Boolean)
					),
					h(
						"div",
						{ style: { fontSize: "11px", opacity: 0.55 } },
						"留空 = 跟随触发这次提取的会话；提取是后台任务，不影响你当前对话用的模型。"
					)
				]),
				h(
					"div",
					{ style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
					h("button", { style: s.button, onClick: () => void saveConfig(), disabled: busy }, "保存配置"),
					h("button", { style: s.button, onClick: () => void runExtract(), disabled: busy }, "立即提取"),
					h("button", { style: s.button, onClick: () => void load(), disabled: busy }, "刷新")
				),
				err !== "" && h("div", { style: s.msgErr }, err),
				msg !== "" && h("div", { style: s.msg }, msg),
				h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "6px" } },
					h("span", { style: { fontSize: "12px", fontWeight: 600, marginTop: "4px" } }, "最近添加（" + recent.length + "）"),
					recent.length === 0
						? h("div", { style: { fontSize: "11.5px", opacity: 0.55 } }, "暂无记录。自动写入或手动保存的 skill 会出现在这里。")
						: null,
					recent.map((r) =>
						h("div", { key: r.path, style: rowCard }, [
							h(
								"div",
								{ style: { flex: 1, minWidth: 0 } },
								h("div", { style: { fontWeight: 600, fontSize: "12.5px" } }, r.name),
								h(
									"div",
									{ style: { fontSize: "11.5px", opacity: 0.7, marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
									r.description || ""
								),
								h("div", { style: { fontSize: "11px", opacity: 0.5, marginTop: "2px" } }, r.mtime ? new Date(r.mtime).toLocaleString() : "")
							)
						])
					)
				),
				h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "6px" } },
					h(
						"span",
						{ style: { fontSize: "12px", fontWeight: 600, marginTop: "4px" } },
						"待确认候选（" + candidates.length + "）"
					),
					candidates.length === 0
						? h(
								"div",
								{ style: { fontSize: "11.5px", opacity: 0.55 } },
								"暂无候选。点「立即提取」扫描近期会话，产出的候选会列在这里，可编辑后接受。"
							)
						: null,
					candidates.map((c) =>
						editingId === c.id
							? h("div", { key: c.id, style: { display: "flex", flexDirection: "column", gap: "6px" } }, [
									h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } }, h("span", { style: { fontWeight: 600, fontSize: "12.5px" } }, c.name), c.group ? h("span", { style: s.badge }, c.group) : null),
									h("textarea", { style: s.textarea, value: draft, spellCheck: false, onChange: (e) => setDraft(e.target.value) }),
									h("div", { style: { display: "flex", gap: "8px" } }, [
										h("button", { style: s.button, onClick: () => void saveDraft(), disabled: busy }, "保存草稿"),
										h("button", { style: s.button, onClick: () => setEditingId(null), disabled: busy }, "取消")
									])
								])
							: h("div", { key: c.id, style: rowCard }, [
									h("div", { style: { flex: 1, minWidth: 0 } }, [
										h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } }, h("span", { style: { fontWeight: 600, fontSize: "12.5px" } }, c.name), c.group ? h("span", { style: s.badge }, c.group) : null),
										h(
										"div",
										{ style: { fontSize: "11.5px", opacity: 0.7, marginTop: "2px" } },
										c.description || ""
										),
										c.rationale
											? h("div", { style: { fontSize: "11px", opacity: 0.5, marginTop: "2px" } }, "可复用：" + c.rationale)
											: null
									]),
									h("button", { style: s.button, onClick: () => openEdit(c), disabled: busy }, "编辑"),
									h("button", { style: s.button, onClick: () => void acceptCand(c), disabled: busy }, "接受"),
									h("button", { style: s.button, onClick: () => void rejectCand(c), disabled: busy }, "拒绝")
								])
					)
				)
			);
		}
		// ── 配置快照面板 ───────────────────────────────────────────────

		/** 一行快照。 */
		/** 每条通道要填哪些字段。secret=true 的用密码框。 */
		const SYNC_FIELDS = {
			git: [
				{ key: "remote", label: "仓库地址", placeholder: "https://github.com/you/dsh-config.git" },
				{ key: "workDir", label: "工作副本", placeholder: "留空 = ~/.dsh/dsh-studio/sync-work" }
			],
			webdav: [
				{ key: "url", label: "地址", placeholder: "https://dav.example.com/dsh" },
				{ key: "username", label: "用户名", placeholder: "" },
				{ key: "password", label: "密码", placeholder: "", secret: true }
			],
			gist: [
				{ key: "token", label: "GitHub token", placeholder: "ghp_…", secret: true },
				{ key: "gistId", label: "Gist id", placeholder: "留空则首次推送自动创建" }
			],
			s3: [
				{ key: "endpoint", label: "Endpoint", placeholder: "https://s3.us-east-1.amazonaws.com" },
				{ key: "bucket", label: "Bucket", placeholder: "" },
				{ key: "region", label: "Region", placeholder: "us-east-1" },
				{ key: "accessKey", label: "AccessKey", placeholder: "" },
				{ key: "secretKey", label: "SecretKey", placeholder: "", secret: true }
			]
		};
		/** 当前通道的字段列表。 */
		function SyncFields({ channel, config, busy, onChange }) {
			const inputStyle = { padding: "3px 6px", borderRadius: "6px", border: "1px solid color-mix(in srgb, currentColor 18%, transparent)", background: "transparent", color: "inherit", fontSize: "12px" };
			const fields = SYNC_FIELDS[channel] ?? [];
			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "5px" } },
				fields.map((f) =>
					h("div", { key: f.key, style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "12px" } },
						h("span", { style: { minWidth: "84px", opacity: 0.7, userSelect: "none" } }, f.label),
						h("input", {
							style: Object.assign({}, inputStyle, { flex: "1 1 220px" }),
							type: f.secret === true ? "password" : "text",
							placeholder: f.placeholder,
							value: String(config[f.key] ?? ""),
							disabled: busy,
							onChange: (event) => onChange(f.key, event.target.value)
						})
					)
				)
			);
		}

		function SnapshotRow({ item, busy, onPreview, onRestore, onDelete }) {
			const meta = item.fileCount + " 个文件 · " + (item.archiveBytes / 1024).toFixed(0) + " KB · " + new Date(item.at).toLocaleString();
			return h(
				"div",
				{
					style: {
						display: "flex",
						alignItems: "center",
						gap: "10px",
						padding: "9px 11px",
						borderRadius: "9px",
						border: "1px solid color-mix(in srgb, currentColor 13%, transparent)",
						background: "color-mix(in srgb, currentColor 3%, transparent)"
					}
				},
				h(
					"div",
					{ style: { flex: 1, minWidth: 0 } },
					h("div", { style: { fontWeight: 600, fontSize: "12.5px" } }, item.id),
					h("div", { style: { fontSize: "11px", opacity: 0.6, marginTop: "1px" } }, meta)
				),
				h("button", { style: s.button, disabled: busy, onClick: () => onPreview(item.id) }, "预览"),
				h("button", { style: s.button, disabled: busy, onClick: () => onRestore(item.id) }, "恢复"),
			h("button", { style: s.button, disabled: busy, onClick: () => onDelete(item.id) }, "删除")
			);
		}

		/** 恢复预览：只列会变的文件。 */
		function SnapshotPreview({ preview }) {
			const rows = (preview.plan ?? []).filter((p) => p.action !== "same").slice(0, 60);
			return h(
				"div",
				{
					style: {
						display: "flex",
						flexDirection: "column",
						gap: "3px",
						padding: "9px 11px",
						borderRadius: "9px",
						border: "1px solid color-mix(in srgb, currentColor 13%, transparent)",
						background: "color-mix(in srgb, currentColor 3%, transparent)",
						fontSize: "11.5px",
						maxHeight: "220px",
						overflow: "auto"
					}
				},
				h("div", { style: { fontWeight: 600 } }, "恢复预览 · " + preview.total + " 个文件，其中 " + rows.length + " 个会变"),
				rows.map((p) =>
					h(
						"div",
						{ key: p.rel, style: { display: "flex", gap: "8px" } },
						h("span", { style: { opacity: 0.6, minWidth: "62px" } }, p.action === "create" ? "新建" : "覆盖"),
						h("span", { style: { fontFamily: "ui-monospace, monospace" } }, p.rel)
					)
				)
			);
		}

		/** 配置快照：备份 / 恢复 / 导出导入。 */
		function SnapshotPanel() {
			const inputStyle = {
				padding: "3px 6px",
				borderRadius: "6px",
				border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
				background: "transparent",
				color: "inherit",
				fontSize: "12px"
			};
			const [data, setData] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [msg, setMsg] = React.useState("");
			const [err, setErr] = React.useState("");
			const [label, setLabel] = React.useState("");
			const [transferPath, setTransferPath] = React.useState("");
			const [preview, setPreview] = React.useState(null);
			const [schedule, setSchedule] = React.useState(null);
			const [sync, setSync] = React.useState(null);
			React.useEffect(() => {
				api.syncConfig().then((r) => setSync(r.sync)).catch(() => setSync(null));
			}, []);
			React.useEffect(() => {
				api.snapshotSchedule().then((r) => setSchedule(r.schedule)).catch(() => setSchedule(null));
			}, []);
			const refresh = React.useCallback(async () => {
				try {
					const r = await api.snapshotList();
					setData(r);
					setErr("");
				} catch (error) {
					setErr("读取失败：" + String(error instanceof Error ? error.message : error));
				}
			}, []);
			React.useEffect(() => {
				refresh();
			}, [refresh]);
			const run = async (fn) => {
				setBusy(true);
				setMsg("");
				setErr("");
				try {
					await fn();
				} catch (error) {
					setErr(String(error instanceof Error ? error.message : error));
				} finally {
					setBusy(false);
				}
			};
			const doBackup = () => run(async () => {
				const r = await api.snapshotCreate(label.trim() === "" ? "manual" : label.trim());
				setMsg("已建快照 " + r.snapshot.id + "：" + r.snapshot.files.length + " 个文件");
				setLabel("");
				await refresh();
			});
			const doRestore = (id) => run(async () => {
				const r = await api.snapshotRestore(id, false);
				setPreview(null);
				setMsg("已恢复 " + r.written + " 个文件" + (r.preSnapshot !== null ? "（恢复前快照 " + r.preSnapshot + "）" : ""));
				await refresh();
			});
			const doPreview = (id) => run(async () => {
				const r = await api.snapshotRestore(id, true);
				setPreview(r);
				setMsg("[预览] " + r.total + " 个文件：新建 " + r.create + "、覆盖 " + r.overwrite + "、相同 " + r.same);
			});
			const doDelete = (id) => {
				// 删快照不可逆，先问一句
				if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm("删除快照 " + id + "？删了就找不回来。")) return;
				return run(async () => {
					await api.snapshotDelete(id);
					setMsg("已删除快照 " + id);
					await refresh();
				});
			};
			const doPrune = () => run(async () => {
				const r = await api.snapshotPrune(10);
				setMsg("保留 " + r.kept + " 份，删掉 " + r.removed.length + " 份");
				await refresh();
			});
			const doTransfer = (action) => run(async () => {
				const path = transferPath.trim();
				if (path === "") throw new Error("先填文件路径");
				const latest = (data === null ? [] : data.snapshots ?? [])[0];
				if (action === "export") {
					if (latest === undefined) throw new Error("还没有快照可导出");
					const r = await api.snapshotTransfer({ action: "export", path, id: latest.id });
					setMsg("已导出到 " + r.path);
					return;
				}
				const r = await api.snapshotTransfer({ action: "import", path });
				setMsg("已导入为快照 " + r.snapshot.id);
				await refresh();
			});
			const snapshots = data === null ? [] : data.snapshots ?? [];
			const totalBytes = snapshots.reduce((n, x) => n + (x.archiveBytes ?? 0), 0);
			const stat = (value, text) =>
				h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "1px", minWidth: "64px" } },
					h("span", { style: { fontSize: "17px", fontWeight: 600, lineHeight: 1.1 } }, String(value)),
					h("span", { style: { fontSize: "11px", opacity: 0.65 } }, text)
				);
			const toolbar = h(
				"div",
				{ style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", fontSize: "12px" } },
				h("input", {
					style: Object.assign({}, inputStyle, { flex: "1 1 150px", minWidth: "120px" }),
					placeholder: "标签（可空，默认 manual）",
					value: label,
					onChange: (event) => setLabel(event.target.value)
				}),
				h("button", { style: s.button, disabled: busy, onClick: doBackup }, "立即备份"),
				h("button", { style: s.button, disabled: busy, onClick: doPrune }, "保留最近 10 份"),
				h("button", { style: s.button, disabled: busy, onClick: refresh }, "刷新")
			);
			const transferBar = h(
				"div",
				{ style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", fontSize: "12px" } },
				h("input", {
					style: Object.assign({}, inputStyle, { flex: "1 1 220px" }),
					placeholder: "导出 / 导入的绝对路径（.tar.gz）",
					value: transferPath,
					onChange: (event) => setTransferPath(event.target.value)
				}),
				h("button", { style: s.button, disabled: busy, onClick: () => doTransfer("export") }, "导出最新"),
				h("button", { style: s.button, disabled: busy, onClick: () => doTransfer("import") }, "导入")
			);
			const syncCfg = sync === null ? { channel: "git", git: {}, webdav: {}, gist: {}, s3: {} } : sync;
			const syncChannel = syncCfg.channel;
			const syncFields = syncCfg[syncChannel] ?? {};
			const saveSyncConfig = () => run(async () => {
				const r = await api.syncConfig({ channel: syncChannel, [syncChannel]: syncFields });
				setSync(r.sync);
				setMsg("同步配置已保存（通道：" + r.sync.channel + "）");
			});
			const doSyncPush = () => run(async () => {
				const latest = (data === null ? [] : data.snapshots ?? [])[0];
				if (latest === undefined) throw new Error("还没有快照可推送");
				await api.syncConfig({ channel: syncChannel, [syncChannel]: syncFields });
				const r = await api.syncPush(latest.id, syncChannel);
				setMsg(r.pushed === true ? "已推送 " + latest.id + " 到 " + r.channel : "远端已经是最新的");
			});
			const doSyncPull = () => run(async () => {
				await api.syncConfig({ channel: syncChannel, [syncChannel]: syncFields });
				const r = await api.syncPull(syncChannel, "pulled");
				setMsg("已从 " + r.channel + " 拉取为快照 " + r.id + "（" + r.files + " 个文件）");
				await refresh();
			});
			const syncBar = h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "6px", padding: "9px 11px", borderRadius: "9px", border: "1px solid color-mix(in srgb, currentColor 13%, transparent)", background: "color-mix(in srgb, currentColor 3%, transparent)" } },
				h(
					"div",
					{ style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", fontSize: "12px" } },
					h("span", { style: { opacity: 0.6, userSelect: "none" } }, "同步"),
					["git", "webdav", "gist", "s3"].map((name) => h("span", {
						key: name,
						onClick: () => setSync((prev) => ({ ...(prev ?? { git: {}, webdav: {}, gist: {}, s3: {} }), channel: name })),
						style: {
							padding: "1px 9px",
							borderRadius: "999px",
							cursor: "pointer",
							userSelect: "none",
							border: syncChannel === name ? "1px solid rgba(90,140,220,0.6)" : "1px solid transparent",
							background: syncChannel === name ? "rgba(90,140,220,0.12)" : "transparent",
							opacity: syncChannel === name ? 1 : 0.45
						}
					}, name)),
					h("div", { style: { flex: 1 } }),
					h("button", { style: s.button, disabled: busy, onClick: saveSyncConfig }, "保存"),
					h("button", { style: s.button, disabled: busy, onClick: doSyncPush }, "推送最新"),
					h("button", { style: s.button, disabled: busy, onClick: doSyncPull }, "从远端拉取")
				),
				h(SyncFields, {
					channel: syncChannel,
					config: syncFields,
					busy,
					onChange: (key, value) => setSync((prev) => {
						const base = prev === null ? { channel: "git", git: {}, webdav: {}, gist: {}, s3: {} } : prev;
						return { ...base, [base.channel]: { ...(base[base.channel] ?? {}), [key]: value } };
					})
				})
			);
			const sched = schedule === null ? { enabled: false, intervalHours: 24, keep: 10 } : schedule;
			const scheduleBar = h(
				"div",
				{ style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", fontSize: "12px" } },
				h("label", { style: { display: "inline-flex", alignItems: "center", gap: "5px", cursor: "pointer", userSelect: "none" } },
					h("input", {
						type: "checkbox",
						style: { margin: 0, accentColor: "#3b82f6" },
						checked: sched.enabled === true,
						disabled: busy,
						onChange: (event) => changeSchedule({ enabled: event.target.checked })
					}),
					"定时备份"
				),
				h("span", { style: { opacity: 0.7 } }, "每"),
				h("input", {
					style: Object.assign({}, inputStyle, { width: "52px" }),
					value: String(sched.intervalHours),
					disabled: busy || sched.enabled !== true,
					onChange: (event) => {
						const hours = Number(event.target.value);
						if (Number.isFinite(hours) && hours > 0) changeSchedule({ intervalHours: hours });
					}
				}),
				h("span", { style: { opacity: 0.7 } }, "小时，保留"),
				h("input", {
					style: Object.assign({}, inputStyle, { width: "46px" }),
					value: String(sched.keep),
					disabled: busy || sched.enabled !== true,
					onChange: (event) => {
						const keep = Number(event.target.value);
						if (Number.isFinite(keep) && keep > 0) changeSchedule({ keep });
					}
				}),
				h("span", { style: { opacity: 0.7 } }, "份")
			);
			const listPart = snapshots.length === 0
				? h("div", { style: { fontSize: "12px", opacity: 0.6 } }, "还没有快照。点「立即备份」建一份。")
				: h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "6px" } },
					snapshots.map((item) => h(SnapshotRow, { key: item.id, item, busy, onPreview: doPreview, onRestore: doRestore, onDelete: doDelete }))
				);
			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "12px", maxWidth: "820px", fontSize: "13px" } },
				h(
					"div",
					{ style: { display: "flex", alignItems: "baseline", gap: "8px" } },
					h("span", { style: { fontWeight: 600, fontSize: "14px" } }, "配置快照"),
					h("span", { style: { fontSize: "11.5px", opacity: 0.6 } }, "备份 ~/.dsh 的配置；密钥与会话日志永不包含")
				),
				h(
					"div",
					{ style: { display: "flex", gap: "26px", alignItems: "flex-end" } },
					stat(snapshots.length, "快照"),
					stat(data === null ? "…" : data.collected, "白名单文件"),
					stat((totalBytes / 1024 / 1024).toFixed(1) + " MB", "总占用")
				),
				toolbar,
				transferBar,
		scheduleBar,
		syncBar,
				err !== "" && h("div", { style: { fontSize: "12px", color: "#b06a55" } }, err),
				msg !== "" && h("div", { style: { fontSize: "12px", opacity: 0.8 } }, msg),
				preview !== null && h(SnapshotPreview, { preview }),
				listPart
			);
		}
		/** 回收站视图：按批次列，可整批或单项恢复 / 永久删除。 */
		function SkillTrashPanel({ trash, busy, onRestore, onPurge }) {
			if (trash === null) return h("div", { style: { fontSize: "12px", opacity: 0.6 } }, "读取中…");
			if (trash.length === 0) return h("div", { style: { fontSize: "12px", opacity: 0.6 } }, "回收站是空的。");
			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "10px" } },
				trash.map((batch) =>
					h(
						"div",
						{ key: batch.id, style: { display: "flex", flexDirection: "column", gap: "5px" } },
						h(
							"div",
							{ style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "12px" } },
							h("span", { style: { fontWeight: 600 } }, batch.id),
							h("span", { style: { opacity: 0.6 } }, batch.entries.length + " 项"),
							h("div", { style: { flex: 1 } }),
							h("button", { style: s.button, disabled: busy, onClick: () => onRestore(batch.id) }, "整批恢复"),
							h("button", { style: s.button, disabled: busy, onClick: () => onPurge(batch.id) }, "清空")
						),
						batch.entries.map((entry) =>
							h(
								"div",
								{
									key: entry.name,
									style: {
										display: "flex",
										alignItems: "center",
										gap: "8px",
										padding: "7px 10px",
										borderRadius: "8px",
										border: "1px solid color-mix(in srgb, currentColor 13%, transparent)",
										background: "color-mix(in srgb, currentColor 3%, transparent)"
									}
								},
								h(
									"div",
									{ style: { flex: 1, minWidth: 0 } },
									h("div", { style: { fontWeight: 600, fontSize: "12px" } }, entry.name),
									h(
										"div",
										{ style: { fontSize: "11px", opacity: 0.55, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
										entry.present === true ? entry.from : "（文件已不在）"
									)
								),
								h("button", { style: s.button, disabled: busy, onClick: () => onRestore(batch.id, entry.name) }, "恢复"),
								h("button", { style: s.button, disabled: busy, onClick: () => onPurge(batch.id, entry.name) }, "删除")
							)
						)
					)
				)
			);
		}
		/** The settings panel component. */
		function SkillManagerPanel() {
			const [skills, setSkills] = React.useState(null);
			const [cwd, setCwd] = React.useState("");
			const [selected, setSelected] = React.useState(null);
			const [draft, setDraft] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [msg, setMsg] = React.useState("");
			const [err, setErr] = React.useState("");
			// Grouping view: filter text, grouped vs flat layout, collapsed groups.
			const [page, setPage] = React.useState(0);
			const [pageInput, setPageInput] = React.useState("1");
			const [view, setView] = React.useState("skills");
			// 来源筛选：全部 / 用户自己装的 / 插件自带（只读）
			const [sourceFilter, setSourceFilter] = React.useState("all");
			// 启用状态筛选：全部 / 已启用 / 已停用（与行里那个勾选框同义）
			const [activeFilter, setActiveFilter] = React.useState("all");
			const [trash, setTrash] = React.useState(null);
			const [query, setQuery] = React.useState("");
			// 分类改成筛选维度后，列表固定平铺，不再有分组标题
			const groupView = false;
			const [groupFilter, setGroupFilter] = React.useState("all");
			const [collapsed, setCollapsed] = React.useState({});
			const refresh = React.useCallback(async () => {
				try {
					const result = await api.list();
					setSkills(result.skills ?? []);
					setCwd(result.cwd ?? "");
					setErr("");
				} catch (error) {
					setErr("读取 skill 列表失败: " + String(error instanceof Error ? error.message : error));
				}
			}, []);
			const refreshTrash = React.useCallback(async () => {
				try {
					const result = await api.trashList();
					setTrash(result.batches ?? []);
				} catch (error) {
					setErr("读取回收站失败: " + String(error instanceof Error ? error.message : error));
				}
			}, []);
			React.useEffect(() => {
				refresh();
			}, [refresh]);
			React.useEffect(() => {
				if (view === "trash") refreshTrash();
			}, [view, refreshTrash]);
			/** Run one async action with busy/message bookkeeping. */
			const run = async (action) => {
				setBusy(true);
				setMsg("");
				setErr("");
				try {
					return await action();
				} catch (error) {
					setErr("操作失败: " + String(error instanceof Error ? error.message : error));
					return null;
				} finally {
					setBusy(false);
				}
			};
			const open = (skill) => {
				run(async () => {
					const result = await api.get(skill.name);
					setSelected(result.skill);
					setDraft(result.skill ? result.skill.content : "");
					setMsg("已加载 " + skill.name);
				});
			};
			const back = () => {
				setSelected(null);
				setDraft("");
				setMsg("");
			};
			const reload = () => {
				if (!selected) return;
				run(async () => {
					const result = await api.get(selected.name);
					setSelected(result.skill);
					setDraft(result.skill ? result.skill.content : "");
					setMsg("已从磁盘重新加载");
				});
			};
			const save = () => {
				if (!selected) return;
				run(async () => {
					const result = await api.save(selected.name, draft);
					setMsg((result.ok ? "[ok] " : "[failed] ") + (result.message ?? ""));
					refresh();
				});
			};
			const toggle = (patch) => {
				if (!selected) return;
				run(async () => {
					const result = await api.setPolicy(selected.name, patch);
					if (!result.ok) return;
					// Optimistic local update, then a background refresh.
					const next = Object.assign({}, selected, {
						modelInvocable: result.modelInvocable,
						userInvocable: result.userInvocable
					});
					setSelected(next);
					setMsg("[ok] " + (result.message ?? ""));
					refresh();
				});
			};
			/**
			 * Group buckets for the list view. Group membership comes from each
			 * skill's SKILL.md frontmatter `metadata.group`; skills without one
			 * fall into a trailing 未分组 bucket. Flat mode returns one bucket.
			 */
			// 每页条数：419 条一次渲染会把面板拉得很长，分页后滚动条短很多
			const PAGE_SIZE = 6;
			const isBuiltin = (skill) => skill.source === "bundled" || skill.source === "runtime";
			const isEnabled = (skill) => skill.modelInvocable === true && skill.userInvocable === true;
			const counts = React.useMemo(() => {
				const list = skills ?? [];
				const builtin = list.filter(isBuiltin).length;
				const enabled = list.filter(isEnabled).length;
				const byGroup = new Map();
				for (const skill of list) {
					const g = typeof skill.group === "string" && skill.group !== "" ? skill.group : "其他";
					byGroup.set(g, (byGroup.get(g) ?? 0) + 1);
				}
				return { all: list.length, builtin, user: list.length - builtin, enabled, disabled: list.length - enabled, byGroup };
			}, [skills]);
			const filteredSkills = React.useMemo(() => {
				const list = skills ?? [];
				const bySource =
					sourceFilter === "all"
						? list
						: sourceFilter === "builtin"
							? list.filter(isBuiltin)
							: list.filter((skill) => !isBuiltin(skill));
				const byActive =
					activeFilter === "all"
						? bySource
						: activeFilter === "on"
							? bySource.filter(isEnabled)
							: bySource.filter((skill) => !isEnabled(skill));
				const byGroup =
					groupFilter === "all"
						? byActive
						: byActive.filter((skill) =>
								groupFilter === "其他"
									? !(typeof skill.group === "string" && skill.group !== "")
									: skill.group === groupFilter
							);
				const needle = query.trim().toLowerCase();
				if (needle === "") return byGroup;
				return byGroup.filter((skill) =>
					(skill.name + " " + (skill.description || "") + " " + (skill.group || "")).toLowerCase().includes(needle)
				);
			}, [skills, query, sourceFilter, activeFilter, groupFilter]);
			const pageCount = Math.max(1, Math.ceil(filteredSkills.length / PAGE_SIZE));
			const currentPage = Math.min(page, pageCount - 1);
			React.useEffect(() => {
				setPageInput(String(currentPage + 1));
			}, [currentPage]);
			const pageSkills = React.useMemo(
				() => filteredSkills.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE),
				[filteredSkills, currentPage]
			);
			const groups = React.useMemo(() => {
				if (!groupView) return [{ key: "__all__", label: "", items: pageSkills }];
				const buckets = new Map();
				for (const skill of pageSkills) {
					const key = typeof skill.group === "string" && skill.group !== "" ? skill.group : "未分组";
					if (!buckets.has(key)) buckets.set(key, []);
					buckets.get(key).push(skill);
				}
				const named = Array.from(buckets.keys())
					.filter((key) => key !== "未分组")
					.sort((a, b) => a.localeCompare(b));
				const order = buckets.has("未分组") ? named.concat(["未分组"]) : named;
				return order.map((key) => ({ key, label: key, items: buckets.get(key) }));
			}, [pageSkills, groupView]);
			const trashOne = (name) =>
				run(async () => {
					await api.trashSkill(name);
					setMsg(name + " 已移入回收站");
					refresh();
					refreshTrash();
				});
			const restoreOne = (batchId, name) =>
				run(async () => {
					await api.restoreTrash(batchId, name);
					setMsg((name ?? "整批") + " 已恢复");
					refreshTrash();
					refresh();
				});
			const purgeOne = (batchId, name) =>
				run(async () => {
					if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm("永久删除 " + (name ?? "整批") + "？不可恢复。")) return;
					await api.purgeTrash(batchId, name);
					setMsg((name ?? "整批") + " 已永久删除");
					refreshTrash();
				});
			const editable = Boolean(selected && selected.editable);
			const count = skills === null ? "…" : skills.length;
			const invocable = (skills ?? []).filter((x) => x.modelInvocable === true).length;
			const gcount = new Set(
				(skills ?? []).map((x) => x.group).filter((g) => typeof g === "string" && g !== "")
			).size;
			const statCell = (value, label) =>
				h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "1px", minWidth: "52px" } },
					h("span", { style: { fontSize: "17px", fontWeight: 600, lineHeight: 1.1 } }, String(value)),
					h("span", { style: { fontSize: "11px", opacity: 0.65 } }, label)
				);
			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "14px", maxWidth: "820px", fontSize: "13px" } },
				h(
					"details",
					{ key: "extract" },
					h(
						"summary",
						{
							style: {
								cursor: "pointer",
								fontSize: "12px",
								opacity: 0.7,
								userSelect: "none",
								outline: "none"
							}
						},
						"会话提取设置与候选"
					),
					h("div", { style: { marginTop: "10px" } }, h(ExtractorPanel, {}))
				),
				h(
					"div",
					{ style: { display: "flex", alignItems: "baseline", gap: "8px" } },
					h("span", { style: { fontWeight: 600, fontSize: "14px" } }, "Skill 工作台"),
					["skills", "trash"].map((key) =>
						h(
							"span",
							{
								key,
								onClick: () => {
									setView(key);
									setSelected(null);
								},
								style: {
									fontSize: "12px",
									padding: "1px 8px",
									userSelect: "none",
									borderRadius: "999px",
									cursor: "pointer",
									border: view === key ? "1px solid rgba(90,140,220,0.6)" : "1px solid transparent",
									background: view === key ? "rgba(90,140,220,0.12)" : "transparent",
									opacity: view === key ? 1 : 0.45
								}
							},
							key === "skills" ? "技能" : "回收站 " + (trash === null ? "" : trash.reduce((n, b) => n + b.entries.length, 0))
						)
					),
					h(
						"span",
						{ style: { fontSize: "11.5px", opacity: 0.6, wordBreak: "break-all" } },
						cwd ? cwd + " · 共 " + count + " 个" : "共 " + count + " 个"
					)
				),
				h(
					"div",
					{ style: { display: "flex", gap: "26px", alignItems: "flex-end" } },
					statCell(count, "技能"),
					statCell(invocable, "模型可调用"),
					statCell(gcount, "分组")
				),
				h(
					"div",
					{ style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
					h("input", {
						key: "q",
						type: "search",
						style: Object.assign({}, s.search, { flex: "1 1 240px", minWidth: "180px" }),
						placeholder: "筛选（名称 / 描述 / 分组）",
						value: query,
						onChange: (event) => {
							setQuery(event.target.value);
							setPage(0);
						}
					}),

					h("button", { key: "r", style: s.button, onClick: refresh, disabled: busy }, "刷新")
				),
							h(
								"div",
								{ style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" } },
								[
									["all", "全部", counts.all],
									["user", "用户", counts.user],
									["builtin", "内置", counts.builtin]
								].map(([key, label, n]) =>
									h(
										"span",
										{
											key,
											onClick: () => {
												setSourceFilter(key);
												setPage(0);
											},
											title: key === "builtin" ? "插件自带，只读" : key === "user" ? "自己装的（~/.agents/skills 等）" : "全部技能",
											style: {
												padding: "1px 9px",
											userSelect: "none",
												borderRadius: "999px",
												cursor: "pointer",
												border: sourceFilter === key ? "1px solid rgba(90,140,220,0.6)" : "1px solid transparent",
												background: sourceFilter === key ? "rgba(90,140,220,0.12)" : "transparent",
												opacity: sourceFilter === key ? 1 : 0.45
											}
										},
										label + " " + n
									)
								),
							h("span", { style: { opacity: 0.2, margin: "0 6px" } }, "│"),
							h("span", { style: { opacity: 0.45, fontSize: "11px" } }, "状态"),
							[
								["on", "已启用", counts.enabled],
								["off", "已停用", counts.disabled]
							].map(([key, label, n]) =>
								h(
									"span",
									{
										key,
										onClick: () => {
											// 再点一次已选中的那个就回到全部
											setActiveFilter(activeFilter === key ? "all" : key);
											setPage(0);
										},
										title: key === "on" ? "模型与用户都能调用（再点一次取消）" : "至少一侧被关掉（再点一次取消）",
										style: {
											padding: "1px 9px",
											userSelect: "none",
											borderRadius: "999px",
											cursor: "pointer",
											border: activeFilter === key ? "1px solid rgba(90,140,220,0.6)" : "1px solid transparent",
											background: activeFilter === key ? "rgba(90,140,220,0.12)" : "transparent",
											opacity: activeFilter === key ? 1 : 0.45
										}
									},
									label + " " + n
								)
							)
							),
						h(
							"div",
							{ style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", flexWrap: "wrap" } },
							h("span", { style: { opacity: 0.45, fontSize: "11px" } }, "分类"),
							[
								["逆向分析", "逆向", counts.byGroup.get("逆向分析") ?? 0],
								["安全测试", "安全", counts.byGroup.get("安全测试") ?? 0],
								["代码工程", "代码", counts.byGroup.get("代码工程") ?? 0],
								["文档写作", "文档", counts.byGroup.get("文档写作") ?? 0],
								["环境运维", "运维", counts.byGroup.get("环境运维") ?? 0],
								["数据检索", "数据", counts.byGroup.get("数据检索") ?? 0],
								["流程协作", "流程", counts.byGroup.get("流程协作") ?? 0],
								["其他", "其他", counts.byGroup.get("其他") ?? 0],
							].map(([key, label, n]) =>
								h(
									"span",
									{
										key,
										onClick: () => {
											setGroupFilter(groupFilter === key ? "all" : key);
											setPage(0);
										},
										style: {
											padding: "1px 9px",
											userSelect: "none",
											borderRadius: "999px",
											cursor: "pointer",
											whiteSpace: "nowrap",
											border: groupFilter === key ? "1px solid rgba(90,140,220,0.6)" : "1px solid transparent",
											background: groupFilter === key ? "rgba(90,140,220,0.12)" : "transparent",
											opacity: groupFilter === key ? 1 : 0.45
										}
									},
									label + " " + n
								)
							)
						),
				selected === null && view === "trash"
					? h(SkillTrashPanel, { trash, busy, onRestore: restoreOne, onPurge: purgeOne })
					: selected === null
					? h(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: "6px" } },

							query.trim() !== "" && groups.every((group) => group.items.length === 0)
								? h("p", { style: s.status, key: "none" }, "没有匹配的 skill。")
								: null,
							groups.map((group) =>
								h(
									"div",
									{ key: group.key, style: { display: "flex", flexDirection: "column", gap: "6px" } },
									// 「未分组」不配标题：它只是 metadata.group 的缺失态，列在最后就行
									groupView && group.key !== "未分组"
										? h(GroupHeader, {
												key: "header",
												label: group.label,
												count: group.items.length,
												open: collapsed[group.key] !== true,
												hint: group.key === "未分组" ? "metadata.group 未设置" : null,
												onToggle: () =>
													setCollapsed((prev) =>
														Object.assign({}, prev, { [group.key]: prev[group.key] !== true })
													)
											})
										: null,
									!groupView || collapsed[group.key] !== true
										? group.items.map((skill) =>
												h(SkillRow, {
													key: skill.name,
													skill,
													showGroup: !groupView,
													selected: false,
													onDelete: (row) => trashOne(row.name),
													onSelect: () => open(skill),
													onToggle: (patch) => {
														// List-level toggle without opening detail.
														run(async () => {
															const result = await api.setPolicy(skill.name, patch);
															if (!result.ok) return;
															setMsg("[ok] " + (result.message ?? ""));
															refresh();
														});
													}
												})
											)
										: null
								)
							),
							h(
								"div",
								{ style: { display: "flex", alignItems: "center", justifyContent: "center", gap: "12px", padding: "8px 0 2px", fontSize: "12px" } },
								h("button", { style: s.button, disabled: currentPage === 0, onClick: () => setPage(currentPage - 1) }, "上一页"),
								h("input", {
									type: "text",
									title: "输入页码后回车跳转",
									style: {"padding":"3px 6px","borderRadius":"6px","border":"1px solid color-mix(in srgb, currentColor 20%, transparent)","background":"transparent","color":"inherit","fontSize":"12px","width":"42px","textAlign":"center"},
									value: pageInput,
									onChange: (event) => setPageInput(event.target.value.replace(/[^0-9]/g, "")),
									onKeyDown: (event) => {
										if (event.key !== "Enter") return;
										const n = Number(pageInput);
										if (Number.isFinite(n) && n >= 1) setPage(Math.min(n - 1, pageCount - 1));
									},
									onBlur: () => setPageInput(String(currentPage + 1))
								}),
								h("span", { style: { opacity: 0.7 } }, "/ " + pageCount + " · 共 " + filteredSkills.length + " 个"),
								h("button", { style: s.button, disabled: currentPage >= pageCount - 1, onClick: () => setPage(currentPage + 1) }, "下一页")
							)
						)
					: h(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: "10px" } },
							h(
								"div",
								{ style: s.row },
								h(
									"button",
									{ style: s.button, onClick: back, disabled: busy },
									"← 返回列表"
								),
								h("span", { style: s.itemName }, selected.name),
								h(InvBadge, { ok: editable, key: "e" }, editable ? "可编辑" : "只读")
							),
							h(
								"p",
								{ style: s.meta },
								"来源: " + sourceLabel(selected.source) + "（" + selected.provider + "）\n路径: " + (selected.path || "（无文件，只读）") + (selected.nested ? "\n⚠ 嵌套 skill（位于 " + (selected.parent ?? "子目录") + "/ 下）：DSH 默认只自动发现顶层，如需自动加载请移动到 ~/.agents/skills 顶层或加入 customSkillDirs" : "")
							),
							h(PolicyRow, { skill: selected, disabled: !editable || busy, onToggle: toggle }),
							editable
								? h(
										"div",
										{ style: { display: "flex", flexDirection: "column", gap: "6px" } },
										h(
											"p",
											{ style: s.meta },
											"全文编辑（--- frontmatter --- + 正文，保存即写回文件；frontmatter 的 name 应与 skill 名一致）"
										),
										h("textarea", {
											style: s.textarea,
											value: draft,
											spellCheck: false,
											onChange: (event) => setDraft(event.target.value)
										}),
										h(
											"div",
											{ style: s.row },
											h(
												"button",
												{ style: s.button, onClick: save, disabled: busy || draft.trim() === "" },
												"保存"
											),
											h(
												"button",
												{ style: s.button, onClick: reload, disabled: busy },
												"重新加载"
											)
										)
									)
								: h(
										"p",
										{ style: s.statusWarn },
										"该 skill 来自内置/运行时提供方，无独立文件，只读。"
									)
						),
				err !== "" && h("div", { style: s.msgErr, key: "e" }, err),
				msg !== "" && h("div", { style: s.msg, key: "m" }, msg)
			);
		}
		//#endregion
		//#region src/client/index.ts
		/** Required services. */
		const inject = ["slots"];
		/**
		 * Register the Skill 管理器 settings page.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			try {
				ctx.slots.inject("settings.section", () =>
					ctx.slots.register(
						{
							name: "settings.section",
							id: "skill-manager",
							order: 300,
							label: () => "Skill 工作台"
						},
						SkillManagerPanel
					)
				);
			} catch (error) {
				console.warn("[dsh-studio] settings panel registration failed:", error);
			}
			try {
				ctx.slots.inject("settings.section", () =>
					ctx.slots.register(
						{
							name: "settings.section",
							id: "skill-mcp",
							order: 301,
							label: () => "MCP 服务器"
						},
						McpPanel
					)
				);
			} catch (error) {
				console.warn("[dsh-studio] MCP panel registration failed:", error);
			}
			try {
				ctx.slots.inject("settings.section", () =>
					ctx.slots.register(
						{
							name: "settings.section",
							id: "skill-snapshot",
							order: 302,
							label: () => "配置快照"
						},
						SnapshotPanel
					)
				);
			} catch (error) {
				console.warn("[dsh-studio] snapshot panel registration failed:", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
