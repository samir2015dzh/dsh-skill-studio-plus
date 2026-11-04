/**
 * dsh-studio — MCP 按需加载（host half）。
 *
 * 目标：MCP 工具不要全量塞进系统提示。会话开头只暴露「server 名 + 每个工具名和
 * 截断描述」，AI 真要用了再 mcp_load 取完整 schema、mcp_call 执行。
 *
 * 三档：
 *   - eager：连接后立刻把工具注册成 mcp__<server>__<tool>，行为和原生 mcp-client 一致。
 *   - on-demand：不注册工具，只在目录里留名字和描述（默认档）。
 *   - disabled：完全不碰。
 *
 * 单例 + 空闲回收：同一 server 全局只保持一条连接（桌面版单用户，按会话隔离的复杂度
 * 换不来实际收益），超过 idleTimeoutMinutes 没有任何工具调用就断开子进程 / 关 HTTP
 * 会话，但注册表和工具缓存留着——下次 mcp_call / eager 调用时透明重连。
 *
 * 存储：~/.dsh/dsh-studio/mcp.json，与 skill 提取的 pending-remember.json 同目录。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { McpConnection, transportSpec } from "./mcp-client.js";

const TIERS = new Set(["eager", "on-demand", "disabled"]);
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const DEFAULT_IDLE_MINUTES = 5;
const SWEEP_INTERVAL_MS = 30_000;
const MAX_TOOL_NAME = 64;
const HASH_LEN = 12;

/** 目录里每条工具描述最多留这么多字，太长就截断（省 token）。 */
export const DEFAULT_TOOL_DESCRIPTION_MAX = 150;

function storePath() {
	return resolve(homedir(), ".dsh", "dsh-studio", "mcp.json");
}

function storeDir() {
	return resolve(homedir(), ".dsh", "dsh-studio");
}

function clampText(value, max) {
	const s = typeof value === "string" ? value.trim() : "";
	if (s === "") return "";
	return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";
}

/** 深链进去的 server 名可能带空格等字符；统一成 DSH 认识的函数名。 */
export function publicToolName(serverName, toolName) {
	const raw = "mcp__" + serverName + "__" + toolName;
	const safe = raw.replace(/[^A-Za-z0-9_-]/g, "_");
	if (safe === raw && safe.length <= MAX_TOOL_NAME) return safe;
	const digest = createHash("sha256").update(serverName + "\u0000" + toolName).digest("hex").slice(0, HASH_LEN);
	return safe.slice(0, MAX_TOOL_NAME - HASH_LEN - 1) + "_" + digest;
}

function normalizeEntry(input, previous) {
	const entry = { ...(previous ?? {}) };
	const pick = (key) => {
		if (Object.prototype.hasOwnProperty.call(input, key)) entry[key] = input[key];
	};
	for (const key of ["tier", "transport", "command", "args", "env", "envPrefix", "cwd", "url", "headers", "notes", "idleTimeout", "tools", "source", "toolCallTimeoutMs", "toolFilter"]) pick(key);
	if (typeof input.name === "string") entry.name = input.name;
	if (entry.transport !== "streamable-http") entry.transport = "stdio";
	if (entry.tier === undefined) entry.tier = previous?.tier ?? "on-demand";
	if (!TIERS.has(entry.tier)) entry.tier = "on-demand";
	if (entry.transport === "stdio") {
		entry.command = typeof entry.command === "string" ? entry.command : "";
		entry.args = Array.isArray(entry.args) ? entry.args.map(String) : [];
		entry.env = entry.env && typeof entry.env === "object" ? { ...entry.env } : {};
		entry.cwd = typeof entry.cwd === "string" ? entry.cwd : "";
		delete entry.url;
		delete entry.headers;
	} else {
		entry.url = typeof entry.url === "string" ? entry.url : "";
		entry.headers = entry.headers && typeof entry.headers === "object" ? { ...entry.headers } : {};
		delete entry.command;
		delete entry.args;
		delete entry.env;
		delete entry.cwd;
	}
	entry.tools = Array.isArray(entry.tools) ? entry.tools.filter((t) => t && typeof t.name === "string") : [];
	return entry;
}

/**
 * 注册表：一份 JSON，全局共享（所有会话、所有工作区）。
 * 每次读盘不做缓存——写的人可能是 UI、可能是工具、也可能是外部编辑器。
 */
export class McpStore {
	constructor() {
		this.busy = false;
	}

	async load() {
		let raw;
		try {
			raw = await readFile(storePath(), "utf8");
		} catch {
			return { version: 1, idleTimeoutMinutes: DEFAULT_IDLE_MINUTES, toolDescriptionMaxLength: DEFAULT_TOOL_DESCRIPTION_MAX, servers: [] };
		}
		let parsed;
		try {
			parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
		} catch {
			return { version: 1, idleTimeoutMinutes: DEFAULT_IDLE_MINUTES, toolDescriptionMaxLength: DEFAULT_TOOL_DESCRIPTION_MAX, servers: [] };
		}
		const servers = Array.isArray(parsed?.servers) ? parsed.servers.filter((s) => s && typeof s.name === "string" && NAME_PATTERN.test(s.name)) : [];
		return {
			version: 1,
			idleTimeoutMinutes: Number.isFinite(Number(parsed?.idleTimeoutMinutes)) ? Number(parsed.idleTimeoutMinutes) : DEFAULT_IDLE_MINUTES,
			toolDescriptionMaxLength: Number.isFinite(Number(parsed?.toolDescriptionMaxLength)) ? Number(parsed.toolDescriptionMaxLength) : DEFAULT_TOOL_DESCRIPTION_MAX,
			servers: servers.map((s) => normalizeEntry(s, undefined))
		};
	}

	async save(state) {
		const body = {
			version: 1,
			idleTimeoutMinutes: state.idleTimeoutMinutes,
			toolDescriptionMaxLength: state.toolDescriptionMaxLength,
			servers: state.servers
		};
		await mkdir(storeDir(), { recursive: true });
		await writeFile(storePath(), JSON.stringify(body, null, 2) + "\n", "utf8");
		return body;
	}

	async upsert(input) {
		const state = await this.load();
		const index = state.servers.findIndex((s) => s.name === input.name);
		const entry = normalizeEntry(input, index >= 0 ? state.servers[index] : undefined);
		if (index >= 0) state.servers[index] = entry;
		else state.servers.push(entry);
		await this.save(state);
		return entry;
	}

	async remove(name) {
		const state = await this.load();
		const before = state.servers.length;
		state.servers = state.servers.filter((s) => s.name !== name);
		await this.save(state);
		return before !== state.servers.length;
	}

	async patchSetting(key, value) {
		const state = await this.load();
		if (key === "idleTimeoutMinutes") state.idleTimeoutMinutes = Number(value);
		if (key === "toolDescriptionMaxLength") state.toolDescriptionMaxLength = Number(value);
		await this.save(state);
		return state;
	}
}

/**
 * 运行时：每个 server 最多一条活连接，附带活跃时间与懒重连。
 */
export class McpRuntime {
	constructor(logger) {
		this.logger = logger;
		this.slots = new Map();
	}

	slot(name) {
		let slot = this.slots.get(name);
		if (slot === undefined) {
			slot = { conn: undefined, lastUsed: Date.now(), ensureP: undefined, tools: [], error: undefined };
			this.slots.set(name, slot);
		}
		return slot;
	}

	status(name) {
		const slot = this.slots.get(name);
		if (slot === undefined) return "idle";
		if (slot.error !== undefined && slot.conn === undefined) return "error";
		return slot.conn === undefined ? "idle" : "connected";
	}

	errorOf(name) {
		return this.slots.get(name)?.error;
	}

	/** 连上就复用；已断开就重连一次（并发调用共享同一次重连）。 */
	async ensure(entry, options = {}) {
		const slot = this.slot(entry.name);
		if (slot.conn !== undefined) return slot.conn;
		if (slot.ensureP === undefined) {
			slot.ensureP = (async () => {
				const conn = new McpConnection(transportSpec(entry), {
					timeoutMs: options.timeoutMs ?? entry.toolCallTimeoutMs ?? 120000,
					// 握手/列工具最多等 45s；工具本身的超时仍走 toolCallTimeoutMs
					connectTimeoutMs: Math.min(entry.toolCallTimeoutMs ?? 45000, 45000),
					onToolsChanged: () => {
						void this.refreshTools(entry, conn).catch(() => {});
					}
				});
				await conn.connect();
				const tools = await conn.listTools();
				slot.conn = conn;
				slot.tools = tools;
				slot.error = undefined;
				slot.lastUsed = Date.now();
				return conn;
			})().finally(() => {
				slot.ensureP = undefined;
			});
			slot.ensureP.catch((error) => {
				slot.error = error instanceof Error ? error.message : String(error);
				this.logger?.warn?.("[dsh-studio] MCP 连接失败 " + entry.name + "：" + slot.error);
			});
		}
		await slot.ensureP;
		const conn = slot.conn;
		if (conn === undefined) throw new Error(`MCP "${entry.name}" 未连接：${slot.error ?? "未知原因"}`);
		return conn;
	}

	async refreshTools(entry, conn) {
		const slot = this.slot(entry.name);
		if (slot.conn !== conn) return;
		slot.tools = await conn.listTools();
	}

	touch(name) {
		const slot = this.slots.get(name);
		if (slot !== undefined) slot.lastUsed = Date.now();
	}

	/** 只断开连接，保留 tools 缓存与注册表；下次 ensure 会自动重连。 */
	async reclaim(name) {
		const slot = this.slots.get(name);
		if (slot === undefined || slot.conn === undefined) return false;
		const conn = slot.conn;
		slot.conn = undefined;
		try {
			await conn.close();
		} catch {
			/* 关闭失败不阻塞回收 */
		}
		return true;
	}

	async call(entry, toolName, args) {
		const conn = await this.ensure(entry);
		this.touch(entry.name);
		const result = await conn.callTool(toolName, args);
		this.touch(entry.name);
		return result;
	}

	cachedTools(name) {
		return this.slots.get(name)?.tools ?? [];
	}

	/**
	 * 空闲扫描：超过 idleTimeoutMinutes 没被调用就断开。
	 * 返回这次回收掉的 server 名，便于日志与测试断言。
	 */
	async sweep(state) {
		const limit = Number.isFinite(Number(state.idleTimeoutMinutes)) ? Number(state.idleTimeoutMinutes) : DEFAULT_IDLE_MINUTES;
		if (limit <= 0) return [];
		const reclaimed = [];
		const now = Date.now();
		for (const entry of state.servers) {
			const perEntry = entry.idleTimeout === undefined ? limit : Number(entry.idleTimeout);
			if (!Number.isFinite(perEntry) || perEntry <= 0) continue;
			const slot = this.slots.get(entry.name);
			if (slot === undefined || slot.conn === undefined) continue;
			if (now - slot.lastUsed < perEntry * 60_000) continue;
			if (await this.reclaim(entry.name)) {
				reclaimed.push(entry.name);
				this.logger?.info?.(
					`[dsh-studio] MCP "${entry.name}" 空闲 ${perEntry} 分钟，已断开上游连接（工具缓存保留，下次调用自动重连）`
				);
			}
		}
		return reclaimed;
	}

	async closeAll() {
		for (const [name, slot] of this.slots) {
			if (slot.conn === undefined) continue;
			const conn = slot.conn;
			slot.conn = undefined;
			try {
				await conn.close();
			} catch {
				/* 卸载时尽量不抛 */
			}
			this.slots.delete(name);
		}
	}
}

/** MCP 的 tools/call 结果 → DSH 工具输出。 */
function projectResult(result, toolName) {
	if (result === undefined || result === null) return { content: [{ type: "text", text: `(${toolName} 没有返回内容)` }] };
	if (!Array.isArray(result.content)) {
		const fallback = typeof result.toolResult === "string" ? result.toolResult : JSON.stringify(result.toolResult ?? result);
		return { content: [{ type: "text", text: fallback }], ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }) };
	}
	return {
		content: result.content,
		...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent })
	};
}

function resultText(result) {
	const blocks = Array.isArray(result?.content) ? result.content : [];
	const parts = [];
	for (const block of blocks) {
		if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block && typeof block === "object" && block.type === "image") parts.push("[image: " + (block.mimeType ?? "unknown") + "]");
		else if (block && typeof block === "object" && block.type === "resource_link") parts.push("[resource_link: " + (block.name ?? "") + "]");
		else parts.push("[非文本内容]");
	}
	return parts.length === 0 ? "(空返回)" : parts.join("\n");
}

/** 统一的工具输出 schema：MCP 的 content 数组原样带出去。 */
function mcpOutputSchema(render) {
	return {
		schema: {
			type: "object",
			additionalProperties: true,
			properties: {
				content: { type: "array", required: true, items: { type: "json" } },
				structuredContent: { type: "json" }
			}
		},
		render
	};
}

/** DSH 的输出校验要求 lossless JSON：undefined / NaN 会直接判失败，这里统一洗一遍。 */
function clean(value) {
	return JSON.parse(
		JSON.stringify(value, (_key, v) => {
			if (typeof v === "number" && !Number.isFinite(v)) return null;
			return v;
		})
	);
}

/**
 * 某个条目实际暴露给模型的工具集合。
 *
 * 这就是原来 rea-mcp-filter 那层 proxy 干的事，搬进插件后：白名单存在注册表里，
 * 改完不用重启、不用重启上游，下一轮目录重建就生效；上游仍然把全部工具报上来，
 * 过滤只发生在「给模型看」这一层。
 *
 * toolFilter.mode: "all"（默认）| "allow"（只留 names）| "deny"（去掉 names）
 */
export function visibleTools(entry, runtime) {
	const cached = runtime.cachedTools(entry.name);
	const all = cached.length > 0 ? cached : entry.tools ?? [];
	const filter = entry.toolFilter;
	if (filter === undefined || filter === null) return all;
	if (filter.mode !== "allow" && filter.mode !== "deny") return all;
	if (!Array.isArray(filter.names) || filter.names.length === 0) return all;
	const set = new Set(filter.names);
	return filter.mode === "allow" ? all.filter((t) => set.has(t.name)) : all.filter((t) => !set.has(t.name));
}

function describeEntry(entry, runtime, state) {
	const tools = visibleTools(entry, runtime);
	const raw = runtime.cachedTools(entry.name).length > 0 ? runtime.cachedTools(entry.name) : entry.tools ?? [];
	return clean({
		name: entry.name,
		tier: entry.tier,
		transport: entry.transport,
		endpoint: entry.transport === "stdio" ? [entry.command, ...(entry.args ?? [])].join(" ") : entry.url,
		status: entry.tier === "disabled" ? "disabled" : runtime.status(entry.name),
		error: runtime.errorOf(entry.name),
		toolCount: tools.length,
		rawToolCount: raw.length,
		toolFilter: entry.toolFilter ?? { mode: "all", names: [] },
		// 接管状态：来自 cordis.patch.yml 且原生行已禁用 = 已接管，由本插件按需加载
		nativeDisabled: entry.source?.nativeDisabled === true,
		sourceRowId: entry.source?.rowId ?? null,
		tools: tools.map((t) => ({ name: t.name, description: clampText(t.description, state.toolDescriptionMaxLength) })),
		allTools: raw.map((t) => ({ name: t.name, description: clampText(t.description, 80) })),
		notes: entry.notes ?? "",
		idleTimeout: entry.idleTimeout
	});
}

/**
 * 四个模型工具：list / register / load / call。
 * 故意保持极小——它们本身每轮都在系统提示里，绝不能再胖。
 */
export function buildMcpTools(store, runtime, options = {}) {
	return [
		defineTool({
			name: "mcp_list",
			description: "列出全部 MCP 服务器：档位（eager/on-demand/disabled）、传输方式、连接状态、缓存的工具名与截断描述。要看完整参数用 mcp_load。",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						idleTimeoutMinutes: { type: "number" },
						servers: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: true,
								properties: {
									name: { type: "string" },
									tier: { type: "string" },
									transport: { type: "string" },
									endpoint: { type: "string" },
									status: { type: "string" },
									toolCount: { type: "number" },
									notes: { type: "string" }
								}
							}
						}
					}
				},
				render: (_args, value) => {
					const lines = (value.servers ?? []).map(
						(s) => "- " + s.name + " [" + s.tier + "/" + s.status + "] " + s.toolCount + " 个工具 · " + s.transport + " · " + s.endpoint
					);
					return [{ type: "text", text: "MCP 服务器 " + lines.length + " 个（空闲回收 " + value.idleTimeoutMinutes + " 分钟）：\n" + lines.join("\n") }];
				}
			},
			async execute() {
				const state = await store.load();
				return {
					ok: true,
					idleTimeoutMinutes: state.idleTimeoutMinutes,
					servers: state.servers.map((entry) => describeEntry(entry, runtime, state))
				};
			}
		}),
		defineTool({
			name: "mcp_register",
			description: "新增或修改一个 MCP 服务器。会先试连并拉一次工具列表校验配置，通过才写入注册表。tier: eager（注册成 mcp__name__tool）/on-demand（默认，只进目录）/disabled。",
			parameters: {
				name: { type: "string", description: "服务器名，1-32 位 [A-Za-z0-9_-]", required: true },
				tier: { type: "string", description: "eager | on-demand | disabled，默认 on-demand" },
				transport: { type: "string", description: "stdio 或 streamable-http，默认 stdio" },
				command: { type: "string", description: "stdio：启动命令" },
				args: { type: "array", items: { type: "string" }, description: "stdio：参数数组" },
				env: { type: "object", additionalProperties: true, description: "stdio：额外环境变量" },
				cwd: { type: "string", description: "stdio：工作目录" },
				url: { type: "string", description: "streamable-http：端点 URL" },
				headers: { type: "object", additionalProperties: true, description: "streamable-http：请求头" },
				notes: { type: "string", description: "给这个 MCP 写备注，会出现在目录里给模型看" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						name: { type: "string" },
						toolCount: { type: "number" },
						tools: { type: "array", items: { type: "string" } }
					}
				},
				render: (_args, value) => [
					{ type: "text", text: "MCP " + value.name + " 已登记，试连拿到 " + value.toolCount + " 个工具：\n- " + (value.tools ?? []).join("\n- ") }
				]
			},
			async execute(args) {
				const name = String(args.name ?? "").trim();
				if (!NAME_PATTERN.test(name)) throw new Error("服务器名需为 1-32 位 [A-Za-z0-9_-]：" + name);
				const entry = normalizeEntry({ ...args, name }, undefined);
				if (entry.transport === "stdio" && entry.command === "") throw new Error("stdio 传输必须给 command");
				if (entry.transport === "streamable-http" && entry.url === "") throw new Error("streamable-http 传输必须给 url");
				const previous = (await store.load()).servers.find((s) => s.name === name);
				const merged = previous === undefined ? entry : normalizeEntry({ ...previous, ...args, name }, previous);
				// 试连：换配置后旧连接一定不可信，先踢掉
				await runtime.reclaim(name);
				const conn = new McpConnection(transportSpec(merged), { timeoutMs: 30000 });
				let tools;
				try {
					await conn.connect();
					tools = await conn.listTools();
				} finally {
					await conn.close().catch(() => {});
				}
				const saved = await store.upsert({ ...merged, tools });
				runtime.slot(name).tools = tools;
				runtime.slot(name).error = undefined;
				options.onChange?.();
				return { ok: true, name: saved.name, toolCount: tools.length, tools: tools.map((t) => t.name) };
			}
		}),
		defineTool({
			name: "mcp_load",
			description: "加载（或热重载）一个 on-demand MCP：建立连接并返回完整工具定义（含 inputSchema）。同一服务器重复调用即重连重拉。",
			parameters: {
				name: { type: "string", description: "服务器名", required: true },
				peek: { type: "boolean", description: "true 时只返回已缓存的工具定义，不建立连接" },
				filter: {
					type: "string",
					description: "只返回名字或描述包含这个子串的工具（大小写不敏感）。工具多的服务器（上百个）先过滤再取"
				},
				limit: { type: "number", description: "最多返回多少个工具，默认 30，上限 100" }
			},
			output: mcpOutputSchema((_args, value) => [
				{ type: "text", text: value.summary }
			]),
			async execute(args) {
				const state = await store.load();
				const entry = state.servers.find((s) => s.name === String(args.name ?? ""));
				if (entry === undefined) throw new Error("未登记的 MCP：" + String(args.name ?? ""));
				if (entry.tier === "disabled") throw new Error("MCP \"" + entry.name + "\" 已禁用，先改档位再加载");
				let tools;
				if (args.peek === true) {
					if (runtime.cachedTools(entry.name).length === 0) {
						throw new Error("MCP \"" + entry.name + "\" 还没有缓存工具，先不带 peek 调一次 mcp_load");
					}
					tools = visibleTools(entry, runtime);
				} else {
					await runtime.reclaim(entry.name);
					await runtime.ensure(entry);
					await runtime.refreshTools(entry, await runtime.ensure(entry));
					tools = visibleTools(entry, runtime);
					// 上游工具集可能变了（换档位、服务器自己加了工具），把新清单落盘，
					// 否则重启后又读回旧缓存，面板数字和实际对不上。
					const fresh = runtime.cachedTools(entry.name);
					if (fresh.length > 0 && fresh.length !== (entry.tools ?? []).length) {
						await store.upsert({ ...entry, tools: fresh });
					}
				}
				const needle = String(args.filter ?? "").trim().toLowerCase();
				const cap = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
				const matched =
					needle === ""
						? tools
						: tools.filter((t) => (t.name + " " + (t.description ?? "")).toLowerCase().includes(needle));
				const shown = matched.slice(0, cap);
				const lines = shown.map(
					(t) => "- " + t.name + ": " + (t.description ?? "") + "\n  inputSchema: " + JSON.stringify(t.inputSchema ?? {})
				);
				const head =
					"MCP \"" +
					entry.name +
					"\"（" +
					entry.tier +
					"，" +
					entry.transport +
					"）" +
					(needle === "" ? "" : " · 过滤「" + needle + "」") +
					" · 共 " +
					tools.length +
					" 个工具" +
					(matched.length !== tools.length ? "，命中 " + matched.length : "") +
					(shown.length < matched.length ? "，只列前 " + shown.length + " 个（加 limit / 缩小 filter）" : "");
				const summary = [head, entry.notes ? "备注：" + entry.notes : "", ...lines].filter((l) => l !== "").join("\n");
				return clean({ content: [{ type: "text", text: summary }], summary });
			}
		}),
		defineTool({
			name: "mcp_call",
			description: "调用某个 MCP 的工具。on-demand 服务器会按需连接；空闲被回收过的会先自动重连再转发。",
			parameters: {
				name: { type: "string", description: "服务器名", required: true },
				tool: { type: "string", description: "该服务器上的工具名（不带 mcp__ 前缀）", required: true },
				args: { type: "object", additionalProperties: true, description: "工具参数对象" }
			},
			output: mcpOutputSchema((_args, value) => [{ type: "text", text: resultText(value) }]),
			async execute(args) {
				const state = await store.load();
				const entry = state.servers.find((s) => s.name === String(args.name ?? ""));
				if (entry === undefined) throw new Error("未登记的 MCP：" + String(args.name ?? ""));
				if (entry.tier === "disabled") throw new Error("MCP \"" + entry.name + "\" 已禁用");
				const toolName = String(args.tool ?? "");
				if (toolName === "") throw new Error("tool 不能为空");
				// 白名单只影响「看不看得见」是不够的：模型知道名字就能直接调，
				// 所以调用入口也按同一份可见集合拦一次。
				const visible = visibleTools(entry, runtime);
				if (visible.length > 0 && visible.some((t) => t.name === toolName) === false) {
					throw new Error(`工具 "${toolName}" 已被过滤规则排除，不在 "${entry.name}" 的可见集合里`);
				}
				const result = await runtime.call(entry, toolName, typeof args.args === "object" && args.args !== null ? args.args : {});
				if (result?.isError === true) throw new Error(resultText(result));
				return clean(projectResult(result, toolName));
			}
		}),
		defineTool({
			name: "mcp_takeover",
			description: "接管 profile 里已有的原生 MCP：禁用 cordis.patch.yml 里那条 dsh-mcp-client 行，改由本插件的按需加载接管。需要重启 DSH 才生效。",
			parameters: {
				name: { type: "string", description: "服务器名（mcp_list 里带「来自 cordis.patch.yml」的那些）", required: true }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						name: { type: "string" },
						rowId: { type: "string" },
						changed: { type: "boolean" },
						restartRequired: { type: "boolean" }
					}
				},
				render: (_args, value) => [
					{
						type: "text",
						text:
							"已接管 " +
							value.name +
							"（原生行 " +
							value.rowId +
							(value.changed ? " 已禁用" : " 本来就是禁用") +
							"）。重启 DSH 后由本插件按需连接。"
					}
				]
			},
			async execute(args) {
				if (typeof options.takeover !== "function") throw new Error("接管不可用：这个 profile 没有可写的 cordis.patch.yml");
				return clean(await options.takeover(String(args.name ?? "")));
			}
		})
	];
}

/** eager 档：把每个工具注册成 mcp__<server>__<tool>，execute 里懒重连。 */
export async function buildEagerTools(store, runtime) {
	const state = await store.load();
	const tools = [];
	for (const entry of state.servers) {
		if (entry.tier !== "eager") continue;
		let cached = visibleTools(entry, runtime);
		if (cached.length === 0) {
			try {
				await runtime.ensure(entry);
				cached = visibleTools(entry, runtime);
			} catch (error) {
				runtime.logger?.warn?.("[dsh-studio] eager MCP 连接失败 " + entry.name + "：" + String(error));
				continue;
			}
		}
		for (const tool of cached) {
			tools.push(
				defineTool({
					name: publicToolName(entry.name, tool.name),
					description: tool.description ?? "",
					parameters: tool.inputSchema?.properties ?? {},
					output: mcpOutputSchema((_args, value) => [{ type: "text", text: resultText(value) }]),
					async execute(args) {
						const latest = (await store.load()).servers.find((s) => s.name === entry.name);
						if (latest === undefined) throw new Error("MCP 已被删除：" + entry.name);
						const result = await runtime.call(latest, tool.name, typeof args === "object" && args !== null ? args : {});
						if (result?.isError === true) throw new Error(resultText(result));
						return clean(projectResult(result, tool.name));
					}
				})
			);
		}
	}
	return tools;
}

/** 系统提示里那段目录：只有名字 + 截断描述，绝不放 schema。 */
export async function buildMcpCatalog(store, runtime) {
	const state = await store.load();
	const active = state.servers.filter((entry) => entry.tier !== "disabled");
	if (active.length === 0) return null;
	const blocks = active.map((entry) => {
		const tools = visibleTools(entry, runtime);
		const head = "- `" + entry.name + "`（" + entry.tier + "，" + entry.transport + "）" + (entry.notes ? " · " + entry.notes : "");
		const lines = tools.map((t) => "  - " + t.name + ": " + clampText(t.description, state.toolDescriptionMaxLength));
		return [head, ...lines].join("\n");
	});
	return [
		"## MCP 服务器（按需加载）",
		"",
		"下列 MCP 服务器只在目录里暴露名字和工具摘要，完整参数要用工具取：",
		"",
		blocks.join("\n"),
		"",
		"用法：`mcp_load {name}` 拿工具名与完整参数；`mcp_call {name, tool, args}` 执行；`mcp_list` 看档位与连接状态。eager 档的工具已经直接注册成 `mcp__<server>__<tool>`，可以直接调。"
	].join("\n");
}

/**
 * 试连一次、把工具清单抄进缓存，然后断开。
 * 给 disabled 档用：不接管、不常驻，但你得能看到它有哪些工具（否则白名单没法勾）。
 */
export async function prefetchTools(store, runtime, name, logger) {
	const state = await store.load();
	const entry = state.servers.find((s) => s.name === name);
	if (entry === undefined) throw new Error("未登记的 MCP：" + name);
	const conn = new McpConnection(transportSpec(entry), { timeoutMs: 30000 });
	try {
		await conn.connect();
		const tools = await conn.listTools();
		runtime.slot(entry.name).tools = tools;
		runtime.slot(entry.name).error = undefined;
		await store.upsert({ ...entry, tools });
		return tools;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		runtime.slot(entry.name).error = message;
		logger?.warn?.(`[dsh-studio] 拉取 ${name} 的工具失败：${message}`);
		throw error;
	} finally {
		await conn.close().catch(() => {});
	}
}

/** 设置页与外部脚本用的 HTTP 面。onChange 在注册表变动后回调，供上层重挂 eager 工具与目录段。 */
export function buildMcpRoutes(store, runtime, options = {}) {
	const json = (res, status, body) => {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(JSON.stringify(body));
	};
	const readBody = async (req) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const raw = Buffer.concat(chunks).toString("utf8");
		if (raw.trim() === "") return {};
		return JSON.parse(raw);
	};
	const wrap = (fn) => async (req, res) => {
		try {
			await fn(req, res);
		} catch (error) {
			json(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	};
	return [
		{
			kind: "exact",
			path: "/api/dsh-studio/mcp",
			handler: wrap(async (req, res) => {
				const state = await store.load();
				if (req.method === "GET") {
					json(res, 200, {
						ok: true,
						idleTimeoutMinutes: state.idleTimeoutMinutes,
						toolDescriptionMaxLength: state.toolDescriptionMaxLength,
						servers: state.servers.map((entry) => describeEntry(entry, runtime, state))
					});
					return;
				}
				if (req.method === "POST") {
					const body = await readBody(req);
					if (typeof body.name !== "string") {
						json(res, 400, { error: "name is required" });
						return;
					}
					const entry = await store.upsert(body);
					await runtime.reclaim(entry.name);
					options.onChange?.();
					json(res, 200, { ok: true, server: describeEntry(entry, runtime, state) });
					return;
				}
				if (req.method === "DELETE") {
					const url = new URL(req.url ?? "/", "http://127.0.0.1");
					const name = url.searchParams.get("name") ?? "";
					await runtime.reclaim(name);
					const removed = await store.remove(name);
					options.onChange?.();
					json(res, 200, { ok: removed });
					return;
				}
				json(res, 405, { error: "method not allowed" });
			})
		},
		{
			kind: "exact",
			path: "/api/dsh-studio/mcp/settings",
			handler: wrap(async (req, res) => {
				if (req.method !== "POST") {
					json(res, 405, { error: "method not allowed" });
					return;
				}
				const body = await readBody(req);
				if (body.idleTimeoutMinutes !== undefined) await store.patchSetting("idleTimeoutMinutes", body.idleTimeoutMinutes);
				if (body.toolDescriptionMaxLength !== undefined) await store.patchSetting("toolDescriptionMaxLength", body.toolDescriptionMaxLength);
				const state = await store.load();
				json(res, 200, { ok: true, idleTimeoutMinutes: state.idleTimeoutMinutes, toolDescriptionMaxLength: state.toolDescriptionMaxLength });
			})
		},
		{
			kind: "exact",
			path: "/api/dsh-studio/mcp/takeover",
			handler: wrap(async (req, res) => {
				if (req.method !== "POST") {
					json(res, 405, { error: "method not allowed" });
					return;
				}
				if (typeof options.takeover !== "function") {
					json(res, 400, { error: "接管不可用：这个 profile 没有可写的 cordis.patch.yml" });
					return;
				}
				const body = await readBody(req);
				const name = typeof body.name === "string" ? body.name : "";
				json(res, 200, await options.takeover(name));
			})
		},
		{
			kind: "exact",
			path: "/api/dsh-studio/mcp/prefetch",
			handler: wrap(async (req, res) => {
				if (req.method !== "POST") {
					json(res, 405, { error: "method not allowed" });
					return;
				}
				const body = await readBody(req);
				const name = typeof body.name === "string" ? body.name : "";
				const tools = await prefetchTools(store, runtime, name, options.logger);
				const state = await store.load();
				const entry = state.servers.find((s) => s.name === name);
				json(res, 200, { ok: true, toolCount: tools.length, server: entry ? describeEntry(entry, runtime, state) : null });
			})
		},
		{
			kind: "exact",
			path: "/api/dsh-studio/mcp/tools",
			handler: wrap(async (req, res) => {
				if (req.method !== "POST") {
					json(res, 405, { error: "method not allowed" });
					return;
				}
				const body = await readBody(req);
				const name = typeof body.name === "string" ? body.name : "";
				const mode = typeof body.mode === "string" ? body.mode : "all";
				if (mode !== "all" && mode !== "allow" && mode !== "deny") {
					json(res, 400, { error: "mode 必须是 all / allow / deny" });
					return;
				}
				const names = Array.isArray(body.names) ? body.names.filter((x) => typeof x === "string") : [];
				const state = await store.load();
				const entry = state.servers.find((s) => s.name === name);
				if (entry === undefined) {
					json(res, 404, { error: "not found: " + name });
					return;
				}
				entry.toolFilter = { mode, names };
				await store.save(state);
				options.onChange?.();
				json(res, 200, { ok: true, server: describeEntry(entry, runtime, state) });
			})
		},
		{
			kind: "exact",
			path: "/api/dsh-studio/mcp/reload",
			handler: wrap(async (req, res) => {
				if (req.method !== "POST") {
					json(res, 405, { error: "method not allowed" });
					return;
				}
				const body = await readBody(req);
				const name = typeof body.name === "string" ? body.name : "";
				await runtime.reclaim(name);
				const state = await store.load();
				const entry = state.servers.find((s) => s.name === name);
				if (entry === undefined) {
					json(res, 404, { error: "not found: " + name });
					return;
				}
				await runtime.ensure(entry);
				json(res, 200, { ok: true, server: describeEntry(entry, runtime, state) });
			})
		}
	];
}

/** 启动后用一次试连把每个 on-demand/eager 条目的工具缓存补齐（不留连接）。 */
export async function warmCatalog(store, runtime, logger) {
	const state = await store.load();
	for (const entry of state.servers) {
		if (entry.tier === "disabled") continue;
		if (Array.isArray(entry.tools) && entry.tools.length > 0) {
			runtime.slot(entry.name).tools = entry.tools;
			continue;
		}
		const conn = new McpConnection(transportSpec(entry), { timeoutMs: 30000 });
		try {
			await conn.connect();
			const tools = await conn.listTools();
			runtime.slot(entry.name).tools = tools;
			await store.upsert({ ...entry, tools });
		} catch (error) {
			logger?.warn?.("[dsh-studio] MCP 预热失败 " + entry.name + "：" + String(error));
		} finally {
			await conn.close().catch(() => {});
		}
	}
}

export { SWEEP_INTERVAL_MS, storePath };
