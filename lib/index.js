/**
 * dsh-studio — skill (技能) 可视化与编辑器. Host half.
 *
 * Mounts the skillmgr_* tools, the /api/dsh-studio route family the
 * web settings panel talks to, and a system-prompt announcement.
 *
 * The panel shows TWO merged catalogs:
 *   1. Filesystem skills — scanned directly by ./scanner.js from the standard
 *      roots (project .dsh/skills & .agents/skills, user ~/.dsh/skills &
 *      ~/.agents/skills), including one level of nested bundles such as
 *      ~/.agents/skills/superpowers/<name>. This is necessary because on the
 *      web host plane the registry's filesystem provider is disabled by
 *      design (per-agent presets own local discovery), so `ctx.skills` alone
 *      would show only runtime/bundled skills.
 *   2. Registry skills — everything `ctx.skills.list()` reports that is not
 *      the filesystem provider (runtime contributions, bundled skills, other
 *      providers), so the panel stays consistent with what DSH actually
 *      loads.
 *
 * Editing and toggling write back to the underlying SKILL.md (or <name>.md)
 * file reported by the scanner / registry:
 *   - full-body edit: save the whole file verbatim (frontmatter + body)
 *   - enable/disable: line-level frontmatter surgery on the two invocation
 *     keys (`disable-model-invocation`, `user-invocable`), preserving every
 *     other line of the user's frontmatter untouched.
 *
 * The filesystem provider (where active) watches the skill roots and
 * invalidates itself on file changes, so a save is picked up by DSH without
 * a restart. The scanner itself re-reads the files on every request.
 *
 * Safety: this plugin never accepts an arbitrary file path. All writes are
 * resolved from the scanner / registry's own candidate; only skills that
 * carry a real `path` are editable — runtime / bundled skills are read-only.
 * All routes are loopback-only and same-origin checked.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { findSkillByName, parseSkillFile, scanSkills } from "./scanner.js";
import { listTrash, purgeTrash, restoreTrash, trashSkill } from "./trash.js";
import { collectFiles, countFiles, deleteSnapshot, createSnapshot, exportSnapshot, importSnapshot, listSnapshots, loadSchedule, pruneSnapshots, restoreSnapshot, runScheduledBackup, saveSchedule } from "./snapshot.js";
import { loadSync, pullSnapshot, pushSnapshot, saveSync } from "./sync.js";
import { applyDarwin } from "./darwin.js";
import { importProfileMcp, profilePatchPath, disableNativeRow } from "./profile-mcp.js";
import { SENSITIVE_KEY, maskSecret } from "./redact.js";
import { isLocalRequest } from "./guard.js";
import {
	buildEagerTools,
	buildMcpCatalog,
	buildMcpRoutes,
	buildMcpTools,
	McpRuntime,
	McpStore,
	SWEEP_INTERVAL_MS,
	warmCatalog
} from "./mcp.js";
import {
	defaults as extractorDefaults,
	ExtractorStore,
	loadCandidates,
	saveCandidates,
	updateCandidate,
	writeSkillDual,
	runExtraction,
	runtimeState,
	recentSkills,
	shouldExtract,
	assembleCandidateFile
} from "./extractor.js";

/**
 * 从「记住 X」的原话猜落点（WO-EVO-6）。
 *
 * 用户的既定原则是「优化类不要确认」，所以默认不提问：能判定唯一类别就直接落位并
 * 一句话告知，只有同时像两三类、确实分不清时才发问。返回 null 表示模糊。
 *   agents 偏好 / 规矩（以后都这样）
 *   memory 事实 / 环境（这台机器、这个项目的事实）
 *   skill  可复用的方法 / 流程（带模板、步骤、清单这类可固化产出物）
 */
const PREFERENCE_HINT = /(以后都|以后不|下次都|下次也|每次|一律|总是|永远|先给结论|先说结论|不要|别用|风格|语气|口吻|格式|回答时)/;
const FACT_HINT = /(这台机器|本机|这个项目|这个仓库|仓库是|端口|路径|版本是|jdk|node|python|配置是|地址是|装在)/;
const METHOD_HINT = /(怎么做|怎么写|该如何写|如何做|流程|步骤|方法|写法|模板|清单|套路|检查表)/;
const CRAFT_HINT = /(模板|清单|检查表|步骤|套路|流程)/;

export function guessRememberTarget(text) {
	const raw = String(text ?? "");
	if (raw.trim() === "") return null;
	const pref = PREFERENCE_HINT.test(raw);
	const fact = FACT_HINT.test(raw);
	const method = METHOD_HINT.test(raw);
	const hits = (pref ? 1 : 0) + (fact ? 1 : 0) + (method ? 1 : 0);
	// 0 类（看不出来）或 2 类以上（同时像几种）都算模糊，交给模型问一句
	if (hits !== 1) return null;
	if (pref) return "agents";
	if (fact) return "memory";
	// 只说了「怎么做」但没有可固化的产出物（模板/步骤/清单）→ 仍是模糊
	return CRAFT_HINT.test(raw) ? "skill" : null;
}

/** 用户说「记住」时挂起的确认请求；注入一次 system-prompt 后清空。 */
const PENDING_REMEMBER_FILE = () => resolve(homedir(), ".dsh", "dsh-studio", "pending-remember.json");
async function savePendingRemember(text, target = null) {
	try {
		await mkdir(dirname(PENDING_REMEMBER_FILE()), { recursive: true });
		await writeFile(PENDING_REMEMBER_FILE(), JSON.stringify({ text, at: Date.now(), target }), "utf8");
		return true;
	} catch {
		return false;
	}
}
async function takePendingRemember(logger) {
	let raw;
	try {
		raw = await readFile(PENDING_REMEMBER_FILE(), "utf8");
	} catch {
		return null; // 没有挂起请求
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		// 解析失败就不动文件：旧写法先把文件清成 `{}` 再解析，坏内容会被直接吞掉（OPT-08）
		logger?.warn?.("[dsh-studio] pending-remember.json 解析失败，保留原文件：" + (error instanceof Error ? error.message : String(error)));
		return null;
	}
	if (parsed && typeof parsed.text === "string" && parsed.text !== "") {
		await writeFile(PENDING_REMEMBER_FILE(), "{}", "utf8").catch(() => {});
		return parsed;
	}
	return null;
}

/** 读 DSH settings（新宿主用 describe()，老宿主用 get(ns)）。 */
function resolveSettingsReader(ctx) {
	let settings = null;
	try {
		settings = typeof ctx.get === "function" ? ctx.get("settings") : ctx.settings;
	} catch {
		settings = null;
	}
	if (!settings) return () => undefined;
	if (typeof settings.get === "function") {
		return (ns) => {
			try {
				return settings.get(ns);
			} catch {
				return undefined;
			}
		};
	}
	let table = null;
	return (ns) => {
		if (table === null) {
			table = new Map();
			try {
				const list = typeof settings.describe === "function" ? settings.describe() : [];
				if (Array.isArray(list)) for (const e of list) if (e && typeof e.ns === "string") table.set(e.ns, e.value);
			} catch {
				/* describe 失败就返回空表 */
			}
		}
		return table.get(ns);
	};
}

/** 列出 DSH 里已配置的 provider/model，供面板下拉选择。 */
function listAvailableModels(ctx) {
	const out = [];
	try {
		const providers = ctx.llm?.listConfigurableProviders?.() ?? [];
		const read = resolveSettingsReader(ctx);
		for (const p of providers) {
			const value = read(p.settingsNs);
			let profile = value;
			if (Array.isArray(p.settingsPath)) for (const key of p.settingsPath) profile = profile?.[key];
			const models = Array.isArray(profile?.models) ? profile.models : [];
			for (const m of models) {
				const id = typeof m === "string" ? m : m?.id;
				if (typeof id === "string" && id !== "") out.push({ provider: p.provider, model: id, label: p.provider + " / " + id });
			}
			const single = profile?.model;
			if (models.length === 0 && typeof single === "string" && single !== "") out.push({ provider: p.provider, model: single, label: p.provider + " / " + single });
		}
	} catch {
		/* 读不到就返回空清单，面板退化为「自动」 */
	}
	return out;
}

/** Stable cordis plugin name. */
const name = "skill-manager";
/** Services required before the skill manager surfaces can mount. */
const inject = ["skills", "tools", "systemPrompt", "webServer", "timer", "llm"];

/**
 * 模型通道的模块级句柄：模块级的工具/路由构造器拿不到 apply 的闭包，
 * 所以这里存一份，由 apply 在挂载时写入。
 */
let pluginLlm = null;
let pluginAgent = null;
/** 统一给 runExtraction 传模型通道（走 DSH 自己的 provider/model）。 */
const runExtract = (cfg, agent, extra = {}) => runExtraction(cfg, void 0, { llm: pluginLlm, agent: agent ?? pluginAgent, ...extra });
/** Route family prefix. */
const API = {
	list: "/api/dsh-studio/list",
	skill: "/api/dsh-studio/skill",
	policy: "/api/dsh-studio/policy",
	extractStatus: "/api/dsh-studio/extract-status",
	extractConfig: "/api/dsh-studio/extract-config",
	extractRun: "/api/dsh-studio/extract-run",
	extractCandidates: "/api/dsh-studio/extract-candidates",
	extractCandidate: "/api/dsh-studio/extract-candidate",
	extractAccept: "/api/dsh-studio/extract-accept",
	extractReject: "/api/dsh-studio/extract-reject",
	extractRecent: "/api/dsh-studio/extract-recent",
	trash: "/api/dsh-studio/trash",
	restore: "/api/dsh-studio/restore",
	purge: "/api/dsh-studio/purge",
	snapshotList: "/api/dsh-studio/snapshot",
	snapshotRestore: "/api/dsh-studio/snapshot/restore",
	snapshotPrune: "/api/dsh-studio/snapshot/prune",
	snapshotTransfer: "/api/dsh-studio/snapshot/transfer",
	snapshotSchedule: "/api/dsh-studio/snapshot/schedule",
	snapshotDelete: "/api/dsh-studio/snapshot/delete",
	syncConfig: "/api/dsh-studio/sync",
	syncPush: "/api/dsh-studio/sync/push",
	syncPull: "/api/dsh-studio/sync/pull"
};
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 150;
/** Cap on JSON request bodies (skill bodies can be long). */
const MAX_JSON_BODY_BYTES = 1024 * 1024;
/** Model-facing announcement: plugin presence and capabilities. */
const GUIDANCE = "本机已安装 dsh-studio 插件（skill 技能工作台）：可用 skillmgr_list 列出全部已发现 skill（名称/描述/来源/嵌套标记/模型与用户可调用状态/分组 metadata.group）、skillmgr_get 查看正文、skillmgr_save 保存全文编辑、skillmgr_policy 设置启用/禁用（modelInvocable / userInvocable）。也内置「会话提取」：skillmgr_extract_run 定时从会话日志用 LLM 提取候选 skill，skillmgr_extract_list 查看候选、skillmgr_extract_accept/reject 接受或拒绝、skillmgr_extract_config/status 配置与查看，确认后自动写入 agent skill 根（配置了 mirrorDir 时再镜像一份）。也可以在 Web 设置页「Skill 工作台」面板中可视化查看、编辑、开关 skill 与提取候选，并按分组（SKILL.md frontmatter 的 metadata.group）折叠筛选。用户提到「管理 skill / 技能 / skill 列表 / 查看技能 / 提取 skill」时即指本插件，请据此协作。";
/** Frontmatter block matcher: leading `---` fence pair. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
/** The two invocation keys this plugin toggles. */
const KEY_MODEL = "disable-model-invocation";
const KEY_USER = "user-invocable";
/** One text content block (the only render shape these tools emit). */
function text(value) {
	return [{
		type: "text",
		text: value
	}];
}
/** Normalize a thrown value to a printable string. */
function ErrorMsg(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
 * Split a skill file into { frontmatter, body }. `frontmatter` is the raw
 * YAML text between the fences (no fences), or null when there is no block.
 */
function splitFrontmatter(fileText) {
	const match = FRONTMATTER_RE.exec(fileText);
	if (!match) return { frontmatter: null, body: fileText };
	return { frontmatter: match[1], body: fileText.slice(match[0].length) };
}
/** Index of the first line whose key is `key:` (top-level YAML key), else -1. */
function findKeyLine(lines, key) {
	const re = new RegExp("^" + key + "\\s*:");
	for (let i = 0; i < lines.length; i++) {
		if (re.test(lines[i])) return i;
	}
	return -1;
}
/**
 * Apply invocation-policy changes to a frontmatter text (line-level surgery):
 * set → upsert the key line, unset → delete the key line. `changes` carries
 * only the keys that should change; everything else is preserved verbatim.
 * Returns the new frontmatter text (may be "" when all lines were removed).
 */
function applyPolicy(frontmatter, changes) {
	const lines = frontmatter === null ? [] : frontmatter.split("\n");
	const setKey = (key, value) => {
		const idx = findKeyLine(lines, key);
		if (idx >= 0) lines[idx] = key + ": " + value;
		else lines.push(key + ": " + value);
	};
	const unsetKey = (key) => {
		const idx = findKeyLine(lines, key);
		if (idx >= 0) lines.splice(idx, 1);
	};
	if (changes.modelInvocable === true) unsetKey(KEY_MODEL);
	else if (changes.modelInvocable === false) setKey(KEY_MODEL, "true");
	if (changes.userInvocable === true) unsetKey(KEY_USER);
	else if (changes.userInvocable === false) setKey(KEY_USER, "false");
	return lines.join("\n");
}
/**
 * Rebuild a skill file from its original text and an (optional) new frontmatter
 * text. Creates a frontmatter block only when the file had none and the new
 * frontmatter is non-empty; keeps the block when it already existed.
 */
function assembleFile(fileText, nextFrontmatter) {
	const parsed = splitFrontmatter(fileText);
	const fm = nextFrontmatter === null ? null : nextFrontmatter.trim();
	if (parsed.frontmatter === null) {
		if (fm) return "---\n" + fm + "\n---\n" + parsed.body;
		return parsed.body;
	}
	return "---\n" + (fm ?? "") + "\n---\n" + parsed.body;
}
/** Normalize a cwd query value (empty/undefined → undefined = process cwd). */
function resolveCwd(value) {
	const raw = typeof value === "string" ? value.trim() : "";
	if (!raw) return void 0;
	return resolve(raw);
}
/** Read `metadata.group` from a skill's metadata object ("" when absent). */
function metadataGroup(metadata) {
	if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return "";
	return typeof metadata.group === "string" ? metadata.group.trim() : "";
}
/** Read `metadata.tags` from a skill's metadata object ([] when absent). */
function metadataTags(metadata) {
	if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return [];
	if (!Array.isArray(metadata.tags)) return [];
	return metadata.tags.map((tag) => (typeof tag === "string" ? tag.trim() : "")).filter((tag) => tag !== "");
}
/** Project a filesystem-scanned skill to the plain summary shape. */
function fsToSummary(skill) {
	return {
		name: skill.name,
		description: skill.description,
		whenToUse: skill.whenToUse ?? "",
		source: skill.source,
		provider: skill.provider,
		modelInvocable: skill.modelInvocable === true,
		userInvocable: skill.userInvocable === true,
		editable: true,
		nested: skill.nested === true,
		parent: skill.parent ?? "",
		group: typeof skill.group === "string" ? skill.group : "",
		tags: Array.isArray(skill.tags) ? skill.tags : [],
		declaredName: skill.declaredName ?? "",
		nameValid: skill.nameValid !== false,
		dirName: skill.dirName ?? "",
		dir: skill.dir ?? "",
		shadowedBy: skill.shadowedBy ?? "",
		shadows: Array.isArray(skill.shadows) ? skill.shadows : []
	};
}
/** Project a registry summary to the plain summary shape (read-only here). */
function registryToSummary(skill) {
	return {
		name: skill.name,
		description: skill.description,
		whenToUse: typeof skill.whenToUse === "string" ? skill.whenToUse : "",
		source: skill.source,
		provider: skill.provider,
		modelInvocable: skill.invocation.modelInvocable === true,
		userInvocable: skill.invocation.userInvocable === true,
		editable: false,
		nested: false,
		parent: "",
		group: metadataGroup(skill.metadata),
		tags: metadataTags(skill.metadata)
	};
}
/**
 * List every visible skill for a workspace: filesystem scan (authoritative
 * for disk skills) merged with registry skills that are not the filesystem
 * provider (runtime / bundled / other providers).
 */
/**
 * registry 技能的摘要缓存。
 *
 * `ctx.skills.list()` 每次要几秒（它要问所有 provider），而 bundled/runtime
 * 那批技能几乎不变。所以：
 *   - 首次用磁盘缓存里的摘要立刻返回
 *   - 后台刷新，下次请求生效
 * 这样面板不再等那几秒。
 */
const REGISTRY_CACHE_FILE = () => resolve(homedir(), ".dsh", "dsh-studio", "registry-cache.json");
let registrySummaries = null;
let registryLoading = false;
async function loadRegistrySummaries() {
	if (registrySummaries !== null) return registrySummaries;
	try {
		const parsed = JSON.parse(await readFile(REGISTRY_CACHE_FILE(), "utf8"));
		if (Array.isArray(parsed?.summaries)) registrySummaries = parsed.summaries;
	} catch {
		/* 没有缓存，第一次为空 */
	}
	return registrySummaries ?? [];
}
function warmRegistry(ctx, cwd) {
	if (registryLoading) return;
	registryLoading = true;
	ctx.skills
		.list({ cwd })
		.then(async (list) => {
			const summaries = list.filter((skill) => skill.provider !== "filesystem").map(registryToSummary);
			registrySummaries = summaries;
			try {
				await mkdir(dirname(REGISTRY_CACHE_FILE()), { recursive: true });
				await writeFile(REGISTRY_CACHE_FILE(), JSON.stringify({ at: Date.now(), summaries }), "utf8");
			} catch {
				/* 缓存写不进去不影响本次结果 */
			}
		})
		.catch(() => {
			/* 拿不到就用旧缓存 */
		})
		.finally(() => {
			registryLoading = false;
		});
}
async function listSkills(ctx, cwd) {
	const fsSkills = await scanSkills(cwd);
	const summaries = new Map();
	for (const skill of fsSkills) {
		const summary = fsToSummary(skill);
		summaries.set(summary.name, summary);
	}
	for (const summary of await loadRegistrySummaries()) {
		if (!summaries.has(summary.name)) summaries.set(summary.name, summary);
	}
	warmRegistry(ctx, cwd); // 后台刷新，不阻塞这次请求
	return [...summaries.values()].sort((a, b) => a.name.localeCompare(b.name));
}
/** Load one skill's full detail (body + path), or null. */
async function getSkillDetail(ctx, skillName, cwd) {
	// filesystem first (has real content + path)
	const fsSkill = await findSkillByName(skillName, cwd);
	if (fsSkill) {
		return {
			...fsToSummary(fsSkill),
			path: fsSkill.path,
			dir: fsSkill.dir ?? "",
			content: fsSkill.content,
			metadata: fsSkill.metadata ?? {}
		};
	}
	// registry fallback (runtime / bundled / other providers)
	const skill = await ctx.skills.get(skillName, { cwd });
	if (!skill) return null;
	return {
		...registryToSummary(skill),
		path: typeof skill.path === "string" ? skill.path : "",
		dir: "",
		editable: typeof skill.path === "string" && skill.path.length > 0,
		content: typeof skill.content === "string" ? skill.content : "",
		metadata: skill.metadata ?? {}
	};
}
/** Registry/scanner-backed, path-safe write guard: resolve the file for `name`. */
async function editableFile(ctx, skillName, cwd, action) {
	const fsSkill = await findSkillByName(skillName, cwd);
	if (fsSkill) return fsSkill;
	const skill = await ctx.skills.get(skillName, { cwd });
	if (!skill) throw new Error("skill 不存在: " + skillName);
	if (typeof skill.path !== "string" || !skill.path) {
		throw new Error("skill \"" + skillName + "\"（" + skill.source + "/" + skill.provider + "）没有可写文件，" + action + "不可用（内置/bundled 或运行时 skill 为只读）");
	}
	return { name: skill.name, path: skill.path, source: skill.source, provider: skill.provider };
}
/** Save a full file edit (frontmatter + body) for a skill. */
async function saveSkill(ctx, args, cwd) {
	const skill = await editableFile(ctx, args.name, cwd, "编辑");
	if (typeof args.content !== "string" || args.content.length === 0) {
		throw new Error("content 不能为空");
	}
	await writeFile(skill.path, args.content, "utf8");
	return {
		ok: true,
		message: "已保存 " + skill.name + "（" + skill.path + "）",
		path: skill.path,
		bytes: Buffer.byteLength(args.content, "utf8")
	};
}
/**
 * Apply an invocation-policy change to a skill's frontmatter.
 * `enabled: true/false` is the convenience master switch (both interfaces);
 * `modelInvocable` / `userInvocable` override one side independently.
 */
async function savePolicy(ctx, args, cwd) {
	const skill = await editableFile(ctx, args.name, cwd, "设置启用状态");
	const changes = {};
	if (args.enabled === true) {
		changes.modelInvocable = true;
		changes.userInvocable = true;
	} else if (args.enabled === false) {
		changes.modelInvocable = false;
		changes.userInvocable = false;
	}
	if (typeof args.modelInvocable === "boolean") changes.modelInvocable = args.modelInvocable;
	if (typeof args.userInvocable === "boolean") changes.userInvocable = args.userInvocable;
	if (Object.keys(changes).length === 0) {
		throw new Error("没有可应用的策略变更（请提供 enabled / modelInvocable / userInvocable 之一）");
	}
	const raw = await readFile(skill.path, "utf8");
	const parsed = splitFrontmatter(raw);
	const next = assembleFile(raw, applyPolicy(parsed.frontmatter, changes));
	await writeFile(skill.path, next, "utf8");
	const current = parseSkillFile(raw);
	return {
		ok: true,
		message: "已更新 " + skill.name + " 的调用策略",
		path: skill.path,
		modelInvocable: changes.modelInvocable ?? current.fields.disableModelInvocation !== true,
		userInvocable: changes.userInvocable ?? current.fields.userInvocable !== false
	};
}
/** The list tool. */
function skillmgrListTool(ctx) {
	return defineTool({
		name: "skillmgr_list",
		description: "列出当前工作区全部已发现的 skill（技能）：名称、描述、来源（user-agents/user-dsh/project-dsh/...）、嵌套标记、以及模型可调用与用户可调用状态。",
		parameters: {
			cwd: {
				type: "string",
				description: "可选：工作区目录（默认当前进程 cwd）；只影响项目级 skill 的发现范围"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					cwd: { type: "string" },
					skills: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string" },
								description: { type: "string" },
								whenToUse: { type: "string" },
								source: { type: "string" },
								provider: { type: "string" },
								modelInvocable: { type: "boolean" },
								userInvocable: { type: "boolean" },
								editable: { type: "boolean" },
								nested: { type: "boolean" },
								parent: { type: "string" },
								group: { type: "string" },
								tags: {
									type: "array",
									items: { type: "string" }
								},
								declaredName: { type: "string" },
								nameValid: { type: "boolean" },
								dirName: { type: "string" },
								dir: { type: "string" },
								shadowedBy: { type: "string" },
								shadows: {
									type: "array",
									items: { type: "string" }
								}
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const items = (value.skills ?? []).map((s) => {
					const flags = (s.modelInvocable ? "模型✓" : "模型✗") + "/" + (s.userInvocable ? "用户✓" : "用户✗");
					const nested = s.nested ? "（嵌套）" : "";
					const group = typeof s.group === "string" && s.group !== "" ? "【" + s.group + "】" : "";
					return "- " + group + s.name + nested + " [" + flags + "]（" + (s.source ?? "?") + "）: " + (s.description ?? "");
				});
				return text("[ok] 共 " + items.length + " 个 skill\n" + items.join("\n"));
			}
		},
		async execute(args) {
			return {
				ok: true,
				cwd: resolveCwd(args.cwd) ?? process.cwd(),
				skills: await listSkills(ctx, resolveCwd(args.cwd))
			};
		}
	});
}
/** The get-detail tool. */
function skillmgrGetTool(ctx) {
	return defineTool({
		name: "skillmgr_get",
		description: "查看一个 skill 的完整详情：描述、来源、模型/用户可调用状态、文件路径（有则说明可编辑）、以及正文全文（frontmatter + Markdown 内容）。",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "skill 名称（kebab-case，如 obsidian-project-kb；嵌套 skill 可用 parent/child 形式）"
			},
			cwd: {
				type: "string",
				description: "可选：工作区目录（默认当前进程 cwd）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					skill: {
						type: "object",
						additionalProperties: true,
						properties: {
							name: { type: "string" },
							description: { type: "string" },
							whenToUse: { type: "string" },
							source: { type: "string" },
							provider: { type: "string" },
							modelInvocable: { type: "boolean" },
							userInvocable: { type: "boolean" },
							editable: { type: "boolean" },
							nested: { type: "boolean" },
							path: { type: "string" },
							content: { type: "string" },
							metadata: { type: "object", additionalProperties: true }
						}
					}
				}
			},
			render: (_args, value) => {
				const s = value.skill;
				if (!s) return text("[failed] skill 不存在");
				const head = [
					s.name + (s.nested ? "（嵌套）" : "") + "（" + (s.source ?? "?") + "/" + (s.provider ?? "?") + "）",
					"调用策略: 模型" + (s.modelInvocable ? "✓" : "✗") + " / 用户" + (s.userInvocable ? "✓" : "✗"),
					"路径: " + (s.path ?? "（只读，无文件）"),
					"描述: " + (s.description ?? ""),
					"正文:"
				].join("\n");
				return text(head + "\n" + (s.content ?? ""));
			}
		},
		async execute(args) {
			const detail = await getSkillDetail(ctx, args.name, resolveCwd(args.cwd));
			return { ok: detail !== null, skill: detail };
		}
	});
}
/** The save-edit tool. */
function skillmgrSaveTool(ctx) {
	return defineTool({
		name: "skillmgr_save",
		description: "保存一个 skill 的全文编辑（frontmatter + 正文一起写回 SKILL.md 文件）。只对文件系统来源的 skill 可用（有 path）；保存后 DSH 会自动重新发现，无需重启。注意：frontmatter 的 name 需与 skill 名一致，格式错误可能导致该 skill 被跳过。",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "skill 名称（kebab-case）"
			},
			content: {
				type: "string",
				required: true,
				description: "新的完整文件内容（含 --- frontmatter --- 与正文）"
			},
			cwd: {
				type: "string",
				description: "可选：工作区目录（默认当前进程 cwd）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: { type: "string" },
					path: { type: "string" },
					bytes: { type: "number" }
				}
			},
			render: (_args, value) => text((value.ok ? "[ok] " : "[failed] ") + (value.message ?? ""))
		},
		async execute(args) {
			return saveSkill(ctx, args, resolveCwd(args.cwd));
		}
	});
}
/** The enable/disable tool. */
function skillmgrPolicyTool(ctx) {
	return defineTool({
		name: "skillmgr_policy",
		description: "设置一个 skill 的启用/调用策略：enabled=true 启用（模型与用户都可调用，移除 frontmatter 的 disable-model-invocation / user-invocable 行），enabled=false 禁用（两者都关闭）；也可单独用 modelInvocable / userInvocable 只改一侧。修改写入 SKILL.md frontmatter，DSH 自动重新发现。",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "skill 名称（kebab-case）"
			},
			enabled: {
				type: "boolean",
				description: "总开关：true 同时启用模型与用户调用；false 同时禁用"
			},
			modelInvocable: {
				type: "boolean",
				description: "可选：单独设置模型是否可调用（true 启用 / false 禁用）"
			},
			userInvocable: {
				type: "boolean",
				description: "可选：单独设置用户是否可调用（true 启用 / false 禁用）"
			},
			cwd: {
				type: "string",
				description: "可选：工作区目录（默认当前进程 cwd）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: { type: "string" },
					path: { type: "string" },
					modelInvocable: { type: "boolean" },
					userInvocable: { type: "boolean" }
				}
			},
			render: (_args, value) => {
				if (!value.ok) return text("[failed] " + (value.message ?? ""));
				return text("[ok] " + value.message + "（模型" + (value.modelInvocable ? "✓" : "✗") + " / 用户" + (value.userInvocable ? "✓" : "✗") + "）");
			}
		},
		async execute(args) {
			return savePolicy(ctx, args, resolveCwd(args.cwd));
		}
	});
}
/** 删除到回收站：只移动，不真删。 */
function skillmgrTrashTool(ctx) {
	return defineTool({
		name: "skillmgr_trash",
		description: "把一个技能移进回收站（移动目录，不真删，可恢复）。只对文件系统里有实体目录的技能有效；运行时/内置技能删不了。",
		parameters: {
			name: { type: "string", description: "技能名（skillmgr_list 里的 name）", required: true },
			cwd: { type: "string", description: "工作区目录（默认当前 cwd）" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					name: { type: "string" },
					id: { type: "string" },
					from: { type: "string" },
					message: { type: "string" }
				}
			},
			render: (_args, value) =>
				text(value.ok ? `已移入回收站：${value.name}（批次 ${value.id}）` : `失败：${value.message ?? ""}`)
		},
		async execute(args) {
			const skill = await findSkillByName(String(args.name ?? ""), resolveCwd(args.cwd));
			if (skill === null) return { ok: false, name: String(args.name ?? ""), message: "找不到这个技能" };
			if (typeof skill.dir !== "string" || skill.dir === "") {
				return { ok: false, name: skill.name, message: "这个技能没有实体目录（运行时/内置），删不了" };
			}
			const result = await trashSkill({ name: skill.name, dir: skill.dir });
			return { ok: true, name: skill.name, id: result.id, from: result.from };
		}
	});
}
/** 看回收站里有什么。 */
function skillmgrTrashListTool() {
	return defineTool({
		name: "skillmgr_trash_list",
		description: "列出回收站里的批次与条目（名称、原路径、文件是否还在）。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					batches: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: true,
							properties: {
								id: { type: "string" },
								entries: { type: "array", items: { type: "object", additionalProperties: true } }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				if (value.batches.length === 0) return text("回收站是空的。");
				const lines = value.batches.map(
					(batch) =>
						`- ${batch.id}（${batch.entries.length} 项）\n` +
						batch.entries.map((entry) => `    ${entry.name} ← ${entry.from}`).join("\n")
				);
				return text("回收站 " + value.batches.length + " 个批次：\n" + lines.join("\n"));
			}
		},
		async execute() {
			return { ok: true, batches: await listTrash() };
		}
	});
}
/** 从回收站恢复。 */
function skillmgrRestoreTool() {
	return defineTool({
		name: "skillmgr_restore",
		description: "把回收站里的技能搬回原位置。name 省略时恢复整个批次。",
		parameters: {
			id: { type: "string", description: "批次 id（skillmgr_trash_list 里的 id）", required: true },
			name: { type: "string", description: "只恢复这一条；省略则整批恢复" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					id: { type: "string" },
					restored: { type: "array", items: { type: "string" } },
					message: { type: "string" }
				}
			},
			render: (_args, value) =>
				text(value.ok ? `已恢复 ${value.restored.length} 项：${value.restored.join(", ")}` : `失败：${value.message ?? ""}`)
		},
		async execute(args) {
			const id = String(args.id ?? "");
			try {
				return { ok: true, ...(await restoreTrash(id, args.name === undefined ? undefined : String(args.name))) };
			} catch (error) {
				return { ok: false, id, restored: [], message: ErrorMsg(error) };
			}
		}
	});
}
/** 永久删除回收站条目。不可恢复。 */
function skillmgrPurgeTool() {
	return defineTool({
		name: "skillmgr_purge",
		description: "永久删除回收站里的条目（不可恢复）。name 省略时删整个批次。",
		parameters: {
			id: { type: "string", description: "批次 id", required: true },
			name: { type: "string", description: "只删这一条；省略则删整批" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					id: { type: "string" },
					purged: { type: "array", items: { type: "string" } },
					message: { type: "string" }
				}
			},
			render: (_args, value) =>
				text(value.ok ? `已永久删除 ${value.purged.length} 项：${value.purged.join(", ")}` : `失败：${value.message ?? ""}`)
		},
		async execute(args) {
			const id = String(args.id ?? "");
			try {
				return { ok: true, ...(await purgeTrash(id, args.name === undefined ? undefined : String(args.name))) };
			} catch (error) {
				return { ok: false, id, purged: [], message: ErrorMsg(error) };
			}
		}
	});
}
/** 建一份配置快照。 */
function skillmgrSnapshotTool() {
	return defineTool({
		name: "skillmgr_snapshot",
		description: "把 ~/.dsh 的配置（cordis.patch.yml、AGENTS.md、skills/、dsh-studio/、各 profile 的 package.json 与 patch）打成一份快照存到 ~/.dsh/dsh-studio/snapshots。密钥与会话日志永不包含。",
		parameters: {
			label: { type: "string", description: "快照标签，会拼进目录名" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					id: { type: "string" },
					label: { type: "string" },
					fileCount: { type: "number" },
					archiveBytes: { type: "number" }
				}
			},
			render: (_a, v) => text(`已建快照 ${v.id}：${v.fileCount} 个文件，${(v.archiveBytes / 1024).toFixed(0)} KB`)
		},
		async execute(args) {
			const snap = await createSnapshot(typeof args.label === "string" && args.label !== "" ? args.label : "manual");
			return { ok: true, id: snap.id, label: snap.label, fileCount: snap.files.length, archiveBytes: snap.archiveBytes };
		}
	});
}
/** 列快照。 */
function skillmgrSnapshotListTool() {
	return defineTool({
		name: "skillmgr_snapshot_list",
		description: "列出配置快照（时间、标签、文件数、体积）。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					snapshots: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "string" },
								label: { type: "string" },
								at: { type: "number" },
								fileCount: { type: "number" },
								archiveBytes: { type: "number" }
							}
						}
					}
				}
			},
			render: (_a, v) => text(v.snapshots.length === 0 ? "还没有快照。" : v.snapshots.map((s) => `- ${s.id} · ${s.fileCount} 文件 · ${(s.archiveBytes / 1024).toFixed(0)} KB`).join("\n"))
		},
		async execute() {
			return { ok: true, snapshots: await listSnapshots() };
		}
	});
}
/** 恢复快照。 */
function skillmgrSnapshotRestoreTool() {
	return defineTool({
		name: "skillmgr_snapshot_restore",
		description: "把配置恢复到某份快照。dryRun 只算差异不写盘；真恢复前会自动打一份 pre-restore 快照。",
		parameters: {
			id: { type: "string", description: "快照 id", required: true },
			dryRun: { type: "boolean", description: "只预览差异" },
			pathMap: { type: "json", description: "跨机路径重映射：数组 [{from, to}]，或它的 JSON 字符串" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					id: { type: "string" },
					dryRun: { type: "boolean" },
					total: { type: "number" },
					create: { type: "number" },
					overwrite: { type: "number" },
					same: { type: "number" },
					written: { type: "number" },
					preSnapshot: { type: "string" },
					remapped: { type: "number" },
					rejected: { type: "number" },
					failed: { type: "array", items: { type: "json" } },
					plan: { type: "array", items: { type: "json" } },
					rejectedPaths: { type: "array", items: { type: "string" } }
				}
			},
			render: (_a, v) =>
				text(v.dryRun ? `[预览] ${v.total} 个文件：新建 ${v.create}、覆盖 ${v.overwrite}、相同 ${v.same}` : `已恢复 ${v.written} 个文件${v.preSnapshot ? `（恢复前快照 ${v.preSnapshot}）` : ""}`)
		},
		async execute(args) {
			const rawMap = args.pathMap;
			let pathMap;
			if (Array.isArray(rawMap)) pathMap = rawMap;
			else if (typeof rawMap === "string" && rawMap.trim() !== "") pathMap = JSON.parse(rawMap);
			const result = await restoreSnapshot(String(args.id ?? ""), { dryRun: args.dryRun === true, pathMap });
			return { ok: true, ...result };
		}
	});
}
/** 导出 / 导入快照文件。 */
function skillmgrSnapshotTransferTool() {
	return defineTool({
		name: "skillmgr_snapshot_transfer",
		description: "把某份快照导出成 .tar.gz 文件，或把外部 .tar.gz 导入成快照（导入不写配置，先落成快照再恢复）。",
		parameters: {
			action: { type: "string", description: "export 或 import", required: true },
			path: { type: "string", description: "文件绝对路径", required: true },
			id: { type: "string", description: "导出时的快照 id" },
			label: { type: "string", description: "导入后的标签" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					path: { type: "string" },
					bytes: { type: "number" },
					files: { type: "number" },
					id: { type: "string" }
				}
			},
			render: (_a, v) => text(v.id ? `已导入为快照 ${v.id}（${v.files} 个文件）` : `已导出到 ${v.path}（${(v.bytes / 1024).toFixed(0)} KB）`)
		},
		async execute(args) {
			const action = args.action === "import" ? "import" : "export";
			const path = String(args.path ?? "");
			if (action === "export") {
				const r = await exportSnapshot(String(args.id ?? ""), path);
				return { ok: true, path: r.path, bytes: r.bytes, files: r.files };
			}
				const snap = await importSnapshot(path, typeof args.label === "string" ? args.label : "imported");
			return { ok: true, id: snap.id, files: snap.files.length };
		}
	});
}
/** 通道配置的脱敏视图（WO-SEC-1）：凭据字段打码，其余字段原样透出。
 *  value 会进工具结果、面板 state 与日志，token / secretKey / password 不能跟着走。 */
function redactedChannelConfig(config) {
	const out = {};
	for (const [key, value] of Object.entries(config ?? {})) {
		if (typeof value === "string" && value !== "" && SENSITIVE_KEY.test(key)) out[key] = maskSecret(value);
		else out[key] = value;
	}
	return out;
}
/** 同步通道：看配置 / 推 / 拉。 */
function skillmgrSyncTool() {
	return defineTool({
		name: "skillmgr_sync",
		description: "配置快照的多机同步。action=config 读或改通道配置；action=push 把某份快照推到远端；action=pull 从远端取回并落成快照。通道：git / webdav / gist / s3。",
		parameters: {
			action: { type: "string", description: "config / push / pull", required: true },
			channel: { type: "string", description: "git / webdav / gist / s3，省略用配置里的当前通道" },
			snapshotId: { type: "string", description: "push 时的快照 id" },
			settings: { type: "string", description: "config 时要合并进去的配置（JSON 字符串）" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					action: { type: "string" },
					channel: { type: "string" },
					pushed: { type: "boolean" },
					id: { type: "string" },
					files: { type: "number" },
					bytes: { type: "number" },
					remoteId: { type: "string" },
					snapshotId: { type: "string" },
					note: { type: "string" },
					gistId: { type: "string" },
					created: { type: "boolean" },
					sync: { type: "string" }
				}
			},
			render: (_a, v) => text(
				v.pushed === true
					? `已推送 ${v.snapshotId ?? v.id ?? ""} 到 ${v.channel}${v.note !== void 0 ? "（" + v.note + "）" : ""}`
					: v.pushed === false
						? `远端已经是最新的（${v.channel}）`
						: v.id !== void 0
							? `已拉取为快照 ${v.id}（${v.files} 个文件，远端 ${v.remoteId ?? "?"}）`
							: `当前通道：${v.channel}`
			)
		},
		async execute(args) {
			const action = String(args.action ?? "config");
			const current = await loadSync();
			const channel = typeof args.channel === "string" && args.channel !== "" ? args.channel : current.channel;
			if (action === "push") {
				const result = await pushSnapshot(channel, current[channel] ?? {}, String(args.snapshotId ?? ""));
				return { ok: true, action, ...result };
			}
			if (action === "pull") {
				const result = await pullSnapshot(channel, current[channel] ?? {}, "pulled");
				return { ok: true, action, ...result };
			}
			if (typeof args.settings === "string" && args.settings !== "") {
				const patch = JSON.parse(args.settings);
				const next = await saveSync({ ...patch, channel });
				return { ok: true, action: "config", channel: next.channel, sync: JSON.stringify(redactedChannelConfig(next[channel])) };
			}
				return { ok: true, action: "config", channel: current.channel, sync: JSON.stringify(redactedChannelConfig(current[channel])) };
		}
	});
}
/** One JSON response. */
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"referrer-policy": "no-referrer"
	});
	res.end(payload);
}
/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > MAX_JSON_BODY_BYTES) return void 0;
		chunks.push(buffer);
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed : void 0;
	} catch {
		return;
	}
}
/** Read a query value from a request URL. */
function queryValue(req, key) {
	try {
		const url = new URL(req.url ?? "", "http://127.0.0.1");
		return url.searchParams.get(key) ?? void 0;
	} catch {
		return void 0;
	}
}
/** Wrap an async route handler with uniform error → JSON mapping. */
function handle(ctx, fn) {
	return async (req, res) => {
		try {
			await fn(req, res);
		} catch (error) {
			writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	};
}
//#region extractor (merged from dsh-skill-extractor)
/** Model-facing extraction tools. @returns an array of defineTool results. */
function buildExtractorTools(store) {
	return [
		defineTool({
			name: "skillmgr_extract_status",
			description: "查看会话提取插件状态：是否启用、定时提取间隔（分钟）、扫描窗口（天）、LLM 是否配置（baseUrl/apiKey/model）、目标 skill 库目录、最近一次提取结果与候选队列里的待确认 skill 数量。不会泄露任何密钥。",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						enabled: { type: "boolean" },
						intervalMinutes: { type: "number" },
						windowDays: { type: "number" },
						llmConfigured: { type: "boolean" },
						skillLanguage: { type: "string" },
						mirrorDir: { type: "string" },
						agentSkillDir: { type: "string" },
						autoAccept: { type: "boolean" },
						mergeThreshold: { type: "number" },
						lastRunAt: { type: "string" },
						lastRunSummary: { type: "string" },
						queued: { type: "number" }
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute() {
				try {
					const view = await store.view();
					const queue = await loadCandidates();
					const pending = queue.filter((c) => c.status === "pending").length;
					const interval = view.intervalMinutes === 0 ? "已关闭定时" : `每 ${view.intervalMinutes} 分钟`;
					return {
						ok: true,
						message:
							"插件" + (view.enabled ? "已启用" : "已禁用") + " · " + interval + " · 窗口 " + view.windowDays +
							" 天 · LLM " + (view.configured ? "已配置（" + view.llmModel + "）" : pluginLlm ? "走 DSH 模型" : "未配置") + " · 待确认 " + pending + " 个 · 上次 " + (view.lastRunAt ? new Date(view.lastRunAt).toLocaleString() : "未运行") +
							" · 默认存 agent 根（" + view.agentSkillDir + "）" + (view.mirrorDir ? " · 额外镜像 " + view.mirrorDir : "") + " · 自动接受 " + (view.autoAccept ? "开" : "关") + " · 合并阈值 " + view.mergeThreshold,
						enabled: view.enabled,
						intervalMinutes: view.intervalMinutes,
						windowDays: view.windowDays,
						llmConfigured: view.configured,
						skillLanguage: view.skillLanguage,
						mirrorDir: view.mirrorDir,
						agentSkillDir: view.agentSkillDir,
						lastRunAt: view.lastRunAt,
						lastRunSummary: view.lastRunSummary,
						queued: pending
					};
				} catch (error) {
					return { ok: false, message: String(ErrorMsg(error)) };
				}
			}
		}),
		defineTool({
			name: "skillmgr_extract_config",
			description: "配置会话提取：enabled（总开关）、intervalMinutes（每隔多少分钟自动提取一次，0=关闭）、windowDays（扫描最近几天会话）、maxCandidatesPerRun（每次最多候选数）、skillLanguage（正文语言 zh/en）、mirrorDir（可选额外镜像目录）、agentSkillDir（agent 自动加载根）、autoAccept（提取后直接入库，默认关）、mergeThreshold（语义合并阈值，默认 0.2）。**模型走 DSH 自己配置的 provider/model，不需要设置 baseUrl/apiKey/model**；llmBaseUrl/llmApiKey/llmModel 仅在 DSH 未提供 llm 服务时作为 HTTP 回退。持久化到 ~/.dsh/dsh-studio/extractor.json（0600）。传 reset: true 恢复默认。不会泄露 llmApiKey。",
			parameters: {
				enabled: { type: "boolean", description: "总开关" },
				intervalMinutes: { type: "number", description: "提取间隔（分钟），0 关闭" },
				windowDays: { type: "number", description: "扫描窗口（天）" },
				maxCandidatesPerRun: { type: "number", description: "每次最多候选数" },
				skillLanguage: { type: "string", enum: ["zh", "en"], description: "候选正文语言" },
				llmBaseUrl: { type: "string", description: "LLM Base URL（OpenAI 兼容）" },
				llmApiKey: { type: "string", description: "LLM API Key" },
				llmModel: { type: "string", description: "LLM 模型名" },
				mirrorDir: { type: "string", description: "可选额外镜像目录（默认关闭，留空=只存 agent 根）" },
				agentSkillDir: { type: "string", description: "agent 自动加载根（默认 ~/.agents/skills，必须，不用设置）" },
				autoAccept: { type: "boolean", description: "自动接受：提取后直接写入正式库，不进待确认队列（写失败的才入队）" },
				mergeThreshold: { type: "number", description: "语义合并阈值 0–1（默认 0.2）：name+description 相似度超过它才尝试并入既有 skill" },
				provider: { type: "string", description: "手动指定 provider（留空=跟随当前会话 / DSH 默认）" },
				model: { type: "string", description: "手动指定 model（留空=跟随当前会话 / DSH 默认）" },
				reset: { type: "boolean", description: "恢复默认配置" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						enabled: { type: "boolean" },
						intervalMinutes: { type: "number" },
						windowDays: { type: "number" },
						llmConfigured: { type: "boolean" },
						skillLanguage: { type: "string" },
						mirrorDir: { type: "string" },
						agentSkillDir: { type: "string" },
						autoAccept: { type: "boolean" },
						mergeThreshold: { type: "number" }
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				try {
					if (args !== void 0 && args.reset === true) await store.patch(extractorDefaults());
					else await store.patch(args);
					const view = await store.view();
					return {
						ok: true,
						message: "配置已保存：" + (view.enabled ? "启用" : "禁用") + " · " + (view.intervalMinutes === 0 ? "已关闭定时" : "每 " + view.intervalMinutes + " 分钟") + " · 窗口 " + view.windowDays + " 天 · 正文" + (view.skillLanguage === "en" ? "英文" : "中文") + " · LLM " + (view.configured ? "已配置" : pluginLlm ? "走 DSH 模型" : "未配置") + " · 默认存 agent 根" + (view.mirrorDir ? " · 额外镜像 " + view.mirrorDir : "") + " · 自动接受 " + (view.autoAccept ? "开" : "关") + " · 合并阈值 " + view.mergeThreshold,
						enabled: view.enabled,
						intervalMinutes: view.intervalMinutes,
						windowDays: view.windowDays,
						llmConfigured: view.configured,
						skillLanguage: view.skillLanguage,
						mirrorDir: view.mirrorDir,
						agentSkillDir: view.agentSkillDir
					};
				} catch (error) {
					return { ok: false, message: "配置失败：" + String(ErrorMsg(error)) };
				}
			}
		}),
		defineTool({
			name: "skillmgr_extract_run",
			description: "立即执行一次会话提取：扫描最近 windowDays 天的会话日志，调用 LLM 产出候选 skill 草稿，写入待确认队列（去重）。不会自动写入正式库，需 skillmgr_extract_accept 确认。",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						candidates: { type: "array", items: { type: "object", additionalProperties: true } },
						digests: { type: "number" },
						queued: { type: "number" }
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute() {
				try {
					const cfg = await store.load();
					const result = await runExtract(cfg);
					if (result.site) await store.patch(result.site);
					return {
						ok: result.ok,
						message: (result.ok ? "提取完成：" : "提取失败：") + result.message + "；候选：" + (result.candidates || []).map((c) => c.name).join(", ") || "无",
						candidates: result.candidates ?? [],
						digests: result.digests ?? 0,
						queued: result.queued ?? 0
					};
				} catch (error) {
					return { ok: false, message: "提取失败：" + String(ErrorMsg(error)) };
				}
			}
		}),
		defineTool({
			name: "skillmgr_extract_list",
			description: "列出待确认的候选 skill 草稿（id、name、description、rationale、来源会话数、创建时间）。接受用 skillmgr_extract_accept，拒绝用 skillmgr_extract_reject；候选可在 Web 面板中编辑后再接受。",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						candidates: { type: "array", items: { type: "object", additionalProperties: true } }
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute() {
				try {
					const queue = await loadCandidates();
					const pending = queue.filter((c) => c.status === "pending");
					if (pending.length === 0) return { ok: true, message: "候选队列为空", candidates: [] };
					return {
						ok: true,
						message: "候选 " + pending.length + " 个：\n" + pending.map((c) => `- ${c.name}（${c.id}）：${c.description}`).join("\n"),
						candidates: pending.map((c) => ({ id: c.id, name: c.name, description: c.description, rationale: c.rationale, sourceCount: c.sourceCount, created: c.created }))
					};
				} catch (error) {
					return { ok: false, message: String(ErrorMsg(error)) };
				}
			}
		}),
		defineTool({
			name: "skillmgr_extract_accept",
			description: "接受候选：把给定 id 的候选 skill 写入目标库（2️⃣ AI/Skill/<name>/SKILL.md，去重），并从待确认队列移除。参数 ids：候选 id 数组。",
			parameters: {
				ids: { type: "array", items: { type: "string" }, description: "要接受的候选 id 数组" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						written: { type: "array", items: { type: "string" } }
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				try {
					const ids = new Set(Array.isArray(args && args.ids) ? args.ids : []);
					if (ids.size === 0) return { ok: false, message: "请提供要接受的候选 id（ids）" };
					const cfg = await store.load();
					const queue = await loadCandidates();
					const written = [];
					const kept = [];
					for (const c of queue) {
						if (ids.has(c.id)) {
							const r = await writeSkillDual(cfg.agentSkillDir, cfg.mirrorDir, c);
							if (r.written && r.written.length) written.push(c.name);
							else kept.push(c);
						} else kept.push(c);
					}
					await saveCandidates(kept);
					return { ok: true, message: "已写入 " + written.length + " 个：" + (written.join(", ") || "无") + "；未写入 " + (kept.filter((c) => ids.has(c.id)).length) + " 个（可能已存在同名）", written };
				} catch (error) {
					return { ok: false, message: String(ErrorMsg(error)) };
				}
			}
		}),
		defineTool({
			name: "skillmgr_extract_reject",
			description: "拒绝候选：把给定 id 的候选从待确认队列移除，不写入正式库。参数 ids：候选 id 数组。",
			parameters: {
				ids: { type: "array", items: { type: "string" }, description: "要拒绝的候选 id 数组" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						removed: { type: "number" }
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				try {
					const ids = new Set(Array.isArray(args && args.ids) ? args.ids : []);
					if (ids.size === 0) return { ok: false, message: "请提供要拒绝的候选 id（ids）" };
					const queue = await loadCandidates();
					const kept = queue.filter((c) => !ids.has(c.id));
					await saveCandidates(kept);
					return { ok: true, message: "已移除 " + (queue.length - kept.length) + " 个候选", removed: queue.length - kept.length };
				} catch (error) {
					return { ok: false, message: String(ErrorMsg(error)) };
				}
			}
		})
	];
}

/** Build the /api/dsh-studio/extract-* routes. */
function buildExtractorRoutes(ctx, store) {
	const guard = (req, res, method) => {
		if (!isLocalRequest(req)) {
			writeJson(res, 403, { error: "forbidden: loopback-only" });
			return false;
		}
		if (req.method !== method) {
			writeJson(res, 405, { error: "method not allowed: " + req.method });
			return false;
		}
		return true;
	};
	return [
		{
			kind: "exact",
			path: API.extractStatus,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "GET")) return;
				const view = await store.view();
				const queue = await loadCandidates();
				writeJson(res, 200, {
					...view,
					queued: queue.filter((c) => c.status === "pending").length,
					availableModels: listAvailableModels(ctx),
					resolvedModel: runtimeState.lastRoute ? runtimeState.lastRoute.provider + " / " + runtimeState.lastRoute.model : ""
				});
			})
		},
		{
			kind: "exact",
			path: API.extractConfig,
			handler: handle(ctx, async (req, res) => {
				const method = req.method ?? "GET";
				if (method === "GET") {
					if (!guard(req, res, "GET")) return;
					writeJson(res, 200, await store.view());
					return;
				}
				if (method === "POST") {
					if (!guard(req, res, "POST")) return;
					const body = await readJsonBody(req);
					if (body === void 0) {
						writeJson(res, 400, { error: "invalid JSON body" });
						return;
					}
					if (body.reset === true) await store.patch(extractorDefaults());
					else await store.patch(body);
					writeJson(res, 200, await store.view());
					return;
				}
				writeJson(res, 405, { error: "method not allowed: " + method });
			})
		},
		{
			kind: "exact",
			path: API.extractRun,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					const cfg = await store.load();
					const result = await runExtract(cfg);
					if (result.site) await store.patch(result.site);
					writeJson(res, 200, result);
				} catch (error) {
					writeJson(res, 200, { ok: false, message: "提取失败：" + String(ErrorMsg(error)) });
				}
			})
		},
		{
			kind: "exact",
			path: API.extractCandidates,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "GET")) return;
				const queue = await loadCandidates();
				writeJson(res, 200, { ok: true, candidates: queue.filter((c) => c.status === "pending") });
			})
		},
		{
			kind: "exact",
			path: API.extractCandidate,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0 || typeof body.id !== "string") {
					writeJson(res, 400, { error: "invalid JSON body (id required)" });
					return;
				}
				const updated = await updateCandidate(body.id, body);
				if (updated === null) {
					writeJson(res, 404, { error: "候选不存在" });
					return;
				}
				writeJson(res, 200, { ok: true, candidate: updated });
			})
		},
		{
			kind: "exact",
			path: API.extractAccept,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const ids = new Set(body && Array.isArray(body.ids) ? body.ids : []);
				if (ids.size === 0) {
					writeJson(res, 200, { ok: false, message: "请提供要接受的候选 id（ids）" });
					return;
				}
				const cfg = await store.load();
				const queue = await loadCandidates();
				const written = [];
				const kept = [];
				for (const c of queue) {
					if (ids.has(c.id)) {
						const r = await writeSkillDual(cfg.agentSkillDir, cfg.mirrorDir, c);
						if (r.written && r.written.length) written.push(c.name);
						else kept.push(c);
					} else kept.push(c);
				}
				await saveCandidates(kept);
				writeJson(res, 200, { ok: true, written });
			})
		},
		{
			kind: "exact",
			path: API.extractReject,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const ids = new Set(body && Array.isArray(body.ids) ? body.ids : []);
				if (ids.size === 0) {
					writeJson(res, 200, { ok: false, message: "请提供要拒绝的候选 id（ids）" });
					return;
				}
				const queue = await loadCandidates();
				const kept = queue.filter((c) => !ids.has(c.id));
				await saveCandidates(kept);
				writeJson(res, 200, { ok: true, removed: queue.length - kept.length });
			})
		},
		{
			kind: "exact",
			path: API.extractRecent,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "GET")) return;
				const view = await store.view();
				const skills = await recentSkills(view.agentSkillDir, 20);
				writeJson(res, 200, { skills });
			})
		}
	];
}
//#endregion

/**
 * Build every /api/dsh-studio route (exact paths).
 * @param ctx - host plugin context.
 * @returns the route list.
 */
function makeRoutes(ctx) {
	const guard = (req, res, method) => {
		if (!isLocalRequest(req)) {
			writeJson(res, 403, { error: "forbidden: loopback-only" });
			return false;
		}
		if (req.method !== method) {
			writeJson(res, 405, { error: "method not allowed: " + req.method });
			return false;
		}
		return true;
	};
	return [
		{
			kind: "exact",
			path: API.list,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "GET")) return;
				const cwd = resolveCwd(queryValue(req, "cwd"));
				writeJson(res, 200, {
					ok: true,
					cwd: cwd ?? process.cwd(),
					skills: await listSkills(ctx, cwd)
				});
			})
		},
		{
			kind: "exact",
			path: API.trash,
			handler: handle(ctx, async (req, res) => {
				const method = req.method ?? "GET";
				if (method === "GET") {
					if (!guard(req, res, "GET")) return;
					writeJson(res, 200, { ok: true, batches: await listTrash() });
					return;
				}
				if (method === "POST") {
					if (!guard(req, res, "POST")) return;
					const body = await readJsonBody(req);
					if (body === void 0 || typeof body.name !== "string") {
						writeJson(res, 400, { error: "invalid JSON body (name required)" });
						return;
					}
					const skill = await findSkillByName(body.name, resolveCwd(typeof body.cwd === "string" ? body.cwd : void 0));
					if (skill === null) {
						writeJson(res, 404, { error: "skill not found: " + body.name });
						return;
					}
					if (typeof skill.dir !== "string" || skill.dir === "") {
						writeJson(res, 400, { error: "这个技能没有实体目录（运行时/内置），删不了" });
						return;
					}
					writeJson(res, 200, { ok: true, moved: await trashSkill({ name: skill.name, dir: skill.dir }) });
					return;
				}
				writeJson(res, 405, { error: "method not allowed: " + method });
			})
		},
		{
			kind: "exact",
			path: API.restore,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0 || typeof body.id !== "string") {
					writeJson(res, 400, { error: "invalid JSON body (id required)" });
					return;
				}
				writeJson(res, 200, { ok: true, ...(await restoreTrash(body.id, typeof body.name === "string" ? body.name : void 0)) });
			})
		},
		{
			kind: "exact",
			path: API.purge,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0 || typeof body.id !== "string") {
					writeJson(res, 400, { error: "invalid JSON body (id required)" });
					return;
				}
				writeJson(res, 200, { ok: true, ...(await purgeTrash(body.id, typeof body.name === "string" ? body.name : void 0)) });
			})
		},
		{
			kind: "exact",
			path: API.snapshotList,
			handler: handle(ctx, async (req, res) => {
				const method = req.method ?? "GET";
				if (method === "GET") {
					if (!guard(req, res, "GET")) return;
					writeJson(res, 200, { ok: true, snapshots: await listSnapshots(), collected: await countFiles() });
					return;
				}
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const label = typeof body?.label === "string" && body.label !== "" ? body.label : "manual";
				writeJson(res, 200, { ok: true, snapshot: await createSnapshot(label) });
			})
		},
		{
			kind: "exact",
			path: API.snapshotRestore,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (typeof body?.id !== "string" || body.id === "") {
					writeJson(res, 400, { error: "需要 id" });
					return;
				}
				writeJson(res, 200, { ok: true, ...(await restoreSnapshot(body.id, { dryRun: body.dryRun === true, pathMap: Array.isArray(body.pathMap) ? body.pathMap : void 0 })) });
			})
		},
		{
			kind: "exact",
			path: API.snapshotPrune,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const keep = Number(body?.keep);
				writeJson(res, 200, { ok: true, ...(await pruneSnapshots(Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : 10)) });
			})
		},
		{
			kind: "exact",
			path: API.snapshotDelete,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (typeof body?.id !== "string" || body.id === "") {
					writeJson(res, 400, { error: "需要 id" });
					return;
				}
				writeJson(res, 200, { ok: true, ...(await deleteSnapshot(body.id)) });
			})
		},
		{
			kind: "exact",
			path: API.snapshotTransfer,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const action = body?.action === "import" ? "import" : "export";
				if (typeof body?.path !== "string" || body.path === "") {
					writeJson(res, 400, { error: "需要 path" });
					return;
				}
				if (action === "export") {
					if (typeof body.id !== "string" || body.id === "") {
						writeJson(res, 400, { error: "导出需要 id" });
						return;
					}
					writeJson(res, 200, { ok: true, ...(await exportSnapshot(body.id, body.path)) });
					return;
				}
				writeJson(res, 200, { ok: true, snapshot: await importSnapshot(body.path, typeof body.label === "string" ? body.label : "imported") });
			})
		},
		{
			kind: "exact",
			path: API.snapshotSchedule,
			handler: handle(ctx, async (req, res) => {
				const method = req.method ?? "GET";
				if (method === "GET") {
					if (!guard(req, res, "GET")) return;
					writeJson(res, 200, { ok: true, schedule: await loadSchedule() });
					return;
				}
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 400, { error: "invalid JSON body" });
					return;
				}
				writeJson(res, 200, { ok: true, schedule: await saveSchedule(body) });
			})
		},
		{
			kind: "exact",
			path: API.syncConfig,
			handler: handle(ctx, async (req, res) => {
				const method = req.method ?? "GET";
				if (method === "GET") {
					if (!guard(req, res, "GET")) return;
					writeJson(res, 200, { ok: true, sync: await loadSync() });
					return;
				}
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 400, { error: "invalid JSON body" });
					return;
				}
				writeJson(res, 200, { ok: true, sync: await saveSync(body) });
			})
		},
		{
			kind: "exact",
			path: API.syncPush,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (typeof body?.snapshotId !== "string" || body.snapshotId === "") {
					writeJson(res, 400, { error: "需要 snapshotId" });
					return;
				}
				const config = await loadSync();
				const channel = typeof body.channel === "string" ? body.channel : config.channel;
				writeJson(res, 200, { ok: true, ...(await pushSnapshot(channel, config[channel] ?? {}, body.snapshotId)) });
			})
		},
		{
			kind: "exact",
			path: API.syncPull,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const config = await loadSync();
				const channel = typeof body?.channel === "string" ? body.channel : config.channel;
				writeJson(res, 200, { ok: true, ...(await pullSnapshot(channel, config[channel] ?? {}, typeof body?.label === "string" && body.label !== "" ? body.label : "pulled")) });
			})
		},
		{
			kind: "exact",
			path: API.skill,
			handler: handle(ctx, async (req, res) => {
				const method = req.method ?? "GET";
				if (method === "GET") {
					if (!guard(req, res, "GET")) return;
					const name = queryValue(req, "name");
					if (!name) {
						writeJson(res, 400, { error: "name query is required" });
						return;
					}
					const cwd = resolveCwd(queryValue(req, "cwd"));
					const detail = await getSkillDetail(ctx, name, cwd);
					if (!detail) {
						writeJson(res, 404, { error: "skill not found: " + name });
						return;
					}
					writeJson(res, 200, { ok: true, skill: detail });
					return;
				}
				if (method === "POST") {
					if (!guard(req, res, "POST")) return;
					const body = await readJsonBody(req);
					if (body === void 0 || typeof body.name !== "string") {
						writeJson(res, 400, { error: "invalid JSON body (name required)" });
						return;
					}
					writeJson(res, 200, await saveSkill(ctx, {
						name: body.name,
						content: body.content
					}, resolveCwd(typeof body.cwd === "string" ? body.cwd : void 0)));
					return;
				}
				writeJson(res, 405, { error: "method not allowed: " + method });
			})
		},
		{
			kind: "exact",
			path: API.policy,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0 || typeof body.name !== "string") {
					writeJson(res, 400, { error: "invalid JSON body (name required)" });
					return;
				}
				writeJson(res, 200, await savePolicy(ctx, {
					name: body.name,
					enabled: typeof body.enabled === "boolean" ? body.enabled : void 0,
					modelInvocable: typeof body.modelInvocable === "boolean" ? body.modelInvocable : void 0,
					userInvocable: typeof body.userInvocable === "boolean" ? body.userInvocable : void 0
				}, resolveCwd(typeof body.cwd === "string" ? body.cwd : void 0)));
			})
		}
	];
}
/**
 * Mount the skill-manager tools, routes, and announcement.
 * @param ctx - host plugin context carrying skills/tools/systemPrompt/webServer.
 * @param config - plugin config from the composition row.
 */
function apply(ctx, config) {
	const announceToAgent = config?.announceToAgent !== false;
	const enabled = config?.enabled !== false;
	const extractStore = new ExtractorStore();
	// MCP 按需加载：注册表 + 单例运行时（空闲回收见 lib/mcp.js）
	const mcpStore = new McpStore();
	const mcpRuntime = new McpRuntime(ctx.logger);
	let disposeTools;
	let disposeRoutes;
	let disposeSection;
	let disposeTimer;
	let disposeMcpEager;
	let disposeMcpCatalog;
	let disposeMcpSweep;
	let extractBusy = false;
	// 启动后预热 registry 摘要缓存，避免第一次打开面板时等 ctx.skills.list()
	setTimeout(() => {
		try {
			warmRegistry(ctx, process.cwd());
		} catch {
			/* 预热失败无所谓，请求时还会再试 */
		}
	}, 1500);
	// 定时备份：每 30 分钟问一次该不该跑，启动 1 分钟后先查一次
	let snapshotTimer;
	try {
		const tickSnapshot = () => {
			runScheduledBackup()
				.then((result) => {
					if (result?.created !== void 0) ctx.logger?.info?.(`[dsh-studio] 定时备份完成：${result.created}（${result.fileCount} 个文件）`);
				})
				.catch(() => {
					/* 定时备份失败不打断插件 */
				});
		};
		snapshotTimer = setInterval(tickSnapshot, 30 * 60 * 1000);
		snapshotTimer.unref?.();
		setTimeout(tickSnapshot, 60 * 1000).unref?.();
	} catch {
		/* 定时器起不来不影响手动备份 */
	}
	/**
	 * 最近活跃的 agent：提取时用它解析 provider/model，从而直接走用户在 DSH
	 * 里配置的模型，插件不再单独保存 API key。
	 */
	// 下一轮开头主动确认「记住」请求：注入一次即清空，不反复追问
	if (typeof ctx.on === "function") {
		ctx.on("system-prompt/assemble", async (assembly, _context, next) => {
			const out = await next();
			try {
				const pending = await takePendingRemember(ctx.logger);
				if (pending === null) return out;
				const target = typeof pending.target === "string" ? pending.target : null;
				const targetLabel =
					target === "agents" ? "偏好 / 规矩（写进 `~/.dsh/AGENTS.md`）" : target === "memory" ? "事实 / 环境（写进记忆库 retain）" : target === "skill" ? "方法 / 流程（落成 skill）" : null;
				const body = [
					"## 待处理的「记住」请求",
					"",
					"用户上一轮说过：「" + pending.text + "」。",
					"",
					"| 内容类型 | 放哪 | 生效方式 |",
					"|---|---|---|",
					"| 方法 / 流程（怎么做一件事） | skill | 提到相关场景时才加载 |",
					"| 偏好 / 规矩（以后都这样） | `~/.dsh/AGENTS.md` | 每轮常驻 |",
					"| 事实 / 环境（这台机器、这个项目的事实） | 记忆库 retain | 检索时取回 |",
					""
				];
				if (targetLabel !== null) {
					const example =
						target === "agents"
							? "记进 AGENTS.md 了：回答先给结论"
							: target === "memory"
								? "已存进记忆库：这台机器 JDK 是 8"
								: "已落成 skill：<name>，提相关场景时自动加载";
					body.push(
						`**已判定为${targetLabel}，直接落位，不要提问。** 落完用一句话告知用户即可，例如「${example}」。`,
						""
					);
				} else {
					body.push(
						"**这条同时像两类、或者分不出来，才问一句。** 一次只问这一句，例如「这条记成 skill（提专题会时自动加载），还是写进 AGENTS.md（每轮都生效）？」，不要自己替用户选。",
						""
					);
				}
				body.push(
					"落位动作：",
					"- skill → 调 skillmgr_extract_run，或直接写 `~/.agents/skills/<name>/SKILL.md`",
					"- AGENTS.md → 直接编辑 `~/.dsh/AGENTS.md`",
					"- 记忆 → 调 mcp__hindsight__retain",
					"- 用户说不用记 → 忽略，不要反复追问"
				);
				return { ...out, sections: [...(out.sections ?? []), { name: "plugin:dsh-studio:remember", text: body.join("\n") }] };
			} catch {
				return out;
			}
		});
	}

	let lastAgent = null;
	pluginLlm = ctx.llm ?? null;
	extractStore.dshAvailable = Boolean(pluginLlm);
	if (typeof ctx.on === "function") {
		ctx.on("agent/created", (agent) => {
			if (agent) {
				lastAgent = agent;
				pluginAgent = agent;
			}
		});
	}
	/** 到点就跑一次提取；intervalMinutes 同时充当冷却窗口。force=true 时绕过它（每轮判定已通过）。 */
	const extractIfDue = async (preferredAgent = null, force = false, extra = {}) => {
		if (extractBusy) return;
		extractBusy = true;
		try {
			const cfg = await extractStore.load();
			if (!cfg.enabled) return;
			const minutes = cfg.intervalMinutes;
			if (minutes <= 0 && !force) return;
			const now = Date.now();
			const last = cfg.lastRunAt !== "" ? new Date(cfg.lastRunAt).getTime() : 0;
			if (!force && last !== 0 && now - last < minutes * 60 * 1000) return;
			const result = await runExtract(cfg, preferredAgent, extra);
			if (result.site) await extractStore.patch(result.site);
			ctx.logger?.info?.("[dsh-studio] extract: " + result.message);
		} catch (error) {
			ctx.logger?.warn?.("[dsh-studio] extract failed: " + ErrorMsg(error));
		} finally {
			extractBusy = false;
		}
	};

	/**
	 * 每轮先轻量判定值不值得总结（小 prompt，只要 YES/NO）。
	 * 判定至少间隔 90 秒，判定通过后的提取至少间隔 5 分钟。
	 */
	let lastJudge = 0;
	let lastTurnExtract = 0;
	const judgeThenExtract = async (preferredAgent) => {
		const now = Date.now();
		if (now - lastJudge < 90_000) return;
		lastJudge = now;
		if (extractBusy) return;
		try {
			const cfg = await extractStore.load();
			if (!cfg.enabled || cfg.autoPerTurn === false) return;
			const verdict = await shouldExtract(cfg, { llm: pluginLlm, agent: preferredAgent });
			ctx.logger?.info?.("[dsh-studio] turn verdict: " + (verdict.worth ? "YES" : "NO") + (verdict.remember ? " (用户要求记住，转人工确认)" : ""));
			if (!verdict.worth) return;
			if (verdict.remember) {
				// 用户点名要求记住：不在这里静默生成，只挂起一条待处理请求；下一轮按
				// guessRememberTarget 的分类结果决定「直接落位」还是「问一句」（EVO-6）
				const rememberText = verdict.rememberText ?? "（未捕获原话）";
				const ok = await savePendingRemember(rememberText, guessRememberTarget(rememberText));
				ctx.logger?.info?.("[dsh-studio] remember request pending confirmation: " + String(verdict.rememberText ?? "").slice(0, 60) + (ok ? "" : " (写入失败)"));
				return;
			}
			if (Date.now() - lastTurnExtract < 300_000) return;
			lastTurnExtract = Date.now();
			await extractIfDue(preferredAgent, true);
		} catch (error) {
			ctx.logger?.warn?.("[dsh-studio] turn judge failed: " + ErrorMsg(error));
		}
	};
	/**
	 * MCP 的异步挂载：eager 工具、系统提示目录、空闲扫描。
	 * 注册表变了（UI 或 mcp_register）就整段重挂一次。
	 */
	const mountMcp = () => {
		if (disposeMcpEager !== void 0) {
			disposeMcpEager();
			disposeMcpEager = void 0;
		}
		if (disposeMcpCatalog !== void 0) {
			disposeMcpCatalog();
			disposeMcpCatalog = void 0;
		}
		if (disposeMcpSweep !== void 0) {
			disposeMcpSweep();
			disposeMcpSweep = void 0;
		}
		disposeMcpEager = ctx.effect(() => {
			let disposed = false;
			let disposers = [];
			void buildEagerTools(mcpStore, mcpRuntime)
				.then((eagerTools) => {
					if (disposed) return;
					disposers = eagerTools.map((tool) => ctx.tools.register(tool));
					if (eagerTools.length > 0) {
						ctx.logger?.info?.("[dsh-studio] 已注册 " + eagerTools.length + " 个 eager MCP 工具");
					}
				})
				.catch((error) => ctx.logger?.warn?.("[dsh-studio] eager MCP 挂载失败：" + ErrorMsg(error)));
			return () => {
				disposed = true;
				for (const dispose of disposers) dispose();
			};
		}, "dsh-studio: mcp eager");
		if (announceToAgent) {
			void buildMcpCatalog(mcpStore, mcpRuntime)
				.then((catalog) => {
					if (catalog === null) return;
					disposeMcpCatalog = ctx.systemPrompt.section({
						name: "plugin:dsh-studio:mcp",
						order: SECTION_ORDER + 1,
						text: catalog
					});
				})
				.catch(() => {});
		}
		disposeMcpSweep = ctx.interval(() => {
			void (async () => {
				try {
					await mcpRuntime.sweep(await mcpStore.load());
				} catch (error) {
					ctx.logger?.warn?.("[dsh-studio] MCP 空闲扫描失败：" + ErrorMsg(error));
				}
			})();
		}, SWEEP_INTERVAL_MS);
	};

	/** 当前 profile 名：配置优先，其次 --profile，最后按桌面版默认。 */
	const resolveProfileName = () => {
		if (typeof config?.profile === "string" && config.profile !== "") return config.profile;
		const argv = process.argv;
		const flag = argv.indexOf("--profile");
		if (flag !== -1 && flag + 1 < argv.length) return argv[flag + 1];
		return "desktop";
	};
	let mcpBooted = false;
	/**
	 * MCP 启动序列：先把 profile 里已有的 MCP 抄进注册表（只读、停用档），
	 * 再挂 eager 工具和目录段，最后预热工具缓存。
	 */
	const bootMcp = async () => {
		if (mcpBooted === false) {
			mcpBooted = true;
			try {
				const dshHome = process.env.DSH_HOME ?? homedir() + "/.dsh";
				const profileDir = `${dshHome}/profiles/${resolveProfileName()}`.replace(/\\/g, "/");
				// 三层 patch：DSH_HOME 根（全局层，REA 这类手工加的 MCP 写在这里）、
				// profile 自己的、每个 bundle 自带的（hindsight 就在 bundle 里）
				const patchPaths = [
					`${dshHome.replace(/\\/g, "/")}/cordis.patch.yml`,
					`${profileDir}/cordis.patch.yml`,
				];
				try {
					const pkg = JSON.parse(await readFile(`${profileDir}/package.json`, "utf8"));
					for (const bundle of pkg?.dsh?.profile?.bundles ?? []) {
						patchPaths.push(`${profileDir}/node_modules/${bundle}/cordis.patch.yml`);
					}
				} catch {
					/* 没有 package.json 就只扫 profile 自己的 */
				}
				const result = await importProfileMcp(mcpStore, patchPaths, ctx.logger);
				if (result.imported.length > 0) {
					ctx.logger?.info?.(
						"[dsh-studio] 从 cordis.patch.yml 导入 MCP：" +
							result.imported.join(", ") +
							"（停用档，切到「按需启用」才会接管）"
					);
				}
				for (const skip of result.skipped) {
					ctx.logger?.info?.("[dsh-studio] 跳过 MCP " + skip.name + "：" + skip.reason);
				}
			} catch (error) {
				ctx.logger?.warn?.("[dsh-studio] 扫描 profile MCP 失败：" + ErrorMsg(error));
			}
		}
		mountMcp();
		// 预热只补工具缓存，连接用完即断；失败不阻塞插件加载
		void warmCatalog(mcpStore, mcpRuntime, ctx.logger).catch(() => {});
	};

	const mcpPatchPath = () =>
		profilePatchPath(process.env.DSH_HOME ?? homedir() + "/.dsh", resolveProfileName()).replace(/\\/g, "/");
	/**
	 * 接管一个从 cordis.patch.yml 导入的 MCP：
	 * 给原生行加 `disabled: true`（文本级，不动 config），条目切到按需启用。
	 * 需要重启 DSH 才真正生效——原生行是在 loader 阶段读的。
	 */
	const takeoverMcp = async (name) => {
		const state = await mcpStore.load();
		const entry = state.servers.find((s) => s.name === name);
		if (entry === undefined) throw new Error("未登记的 MCP：" + name);
		const rowId = entry.source?.rowId;
		if (typeof rowId !== "string" || rowId === "") {
			throw new Error(`"${name}" 不是从 cordis.patch.yml 导入的，没有原生条目可接管`);
		}
		const changed = await disableNativeRow(entry.source?.patchPath ?? mcpPatchPath(), rowId, ctx.logger);
		entry.tier = "on-demand";
		entry.source = { ...(entry.source ?? {}), rowId, nativeDisabled: true };
		await mcpStore.upsert(entry);
		ctx.logger?.info?.(
			`[dsh-studio] 已接管 ${name}（原生行 ${rowId} ${changed ? "已禁用" : "本来就是禁用"}），重启 DSH 后由插件按需连接`
		);
		return { ok: true, name, rowId, changed, restartRequired: true };
	};

	const sync = () => {
		if (disposeTools !== void 0) {
			disposeTools();
			disposeTools = void 0;
		}
		if (disposeRoutes !== void 0) {
			disposeRoutes();
			disposeRoutes = void 0;
		}
		if (disposeSection !== void 0) {
			disposeSection();
			disposeSection = void 0;
		}
		if (disposeTimer !== void 0) {
			disposeTimer();
			disposeTimer = void 0;
		}
		if (disposeMcpEager !== void 0) {
			disposeMcpEager();
			disposeMcpEager = void 0;
		}
		if (disposeMcpCatalog !== void 0) {
			disposeMcpCatalog();
			disposeMcpCatalog = void 0;
		}
		if (disposeMcpSweep !== void 0) {
			disposeMcpSweep();
			disposeMcpSweep = void 0;
		}
		if (!enabled) return;
		const tools = [
			skillmgrListTool(ctx),
			skillmgrGetTool(ctx),
			skillmgrSaveTool(ctx),
			skillmgrPolicyTool(ctx),
			skillmgrTrashTool(ctx),
			skillmgrTrashListTool(),
			skillmgrRestoreTool(),
			skillmgrPurgeTool(),
			skillmgrSnapshotTool(),
			skillmgrSnapshotListTool(),
			skillmgrSnapshotRestoreTool(),
			skillmgrSnapshotTransferTool(),
			skillmgrSyncTool(),
			...buildExtractorTools(extractStore),
			...buildMcpTools(mcpStore, mcpRuntime, { onChange: () => mountMcp(), takeover: takeoverMcp })
		];
		disposeTools = ctx.effect(() => {
			const disposers = tools.map((tool) => ctx.tools.register(tool));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "dsh-studio: tools");
		disposeRoutes = ctx.effect(() => {
			const routes = [
				...makeRoutes(ctx),
				...buildExtractorRoutes(ctx, extractStore),
				...buildMcpRoutes(mcpStore, mcpRuntime, { onChange: mountMcp, takeover: takeoverMcp, logger: ctx.logger })
			];
			const disposers = routes.map((route) => ctx.webServer.register(route));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "dsh-studio: routes");
		void bootMcp();
		if (announceToAgent) disposeSection = ctx.systemPrompt.section({
			name: "plugin:dsh-studio",
			order: SECTION_ORDER,
			text: GUIDANCE
		});
		disposeTimer = ctx.interval(() => {
			void extractIfDue();
		}, 60 * 1000);
		// 回合结束也触发一次：交给 intervalMinutes 做冷却，避免每轮都调模型
		if (typeof ctx.on === "function") {
			ctx.on("agent/turn-stopping", (payload) => {
				const agent = payload && payload.agent ? payload.agent : null;
				const t = setTimeout(() => {
					void judgeThenExtract(agent);
				}, 3000);
				t.unref?.();
			});
		}
	};
	sync();
	// darwin 体检调度（原独立插件 dsh-darwin-auto 已并入）：写入 SKILL.md 后把
	// darwin-skill 推到模型面前，并按 families.json 折叠同族重复项。
	// WO-EVO-4：它同样受插件总开关约束 —— enabled:false 时连事件都不该挂，
	// 否则关掉插件却还在注入 darwin 段、跑巡检。darwin 自己的子开关语义不变。
	if (enabled) applyDarwin(ctx, config?.darwin ?? {}, { llm: pluginLlm });
}

export { API, GUIDANCE, apply, applyPolicy, assembleFile, buildExtractorRoutes, buildExtractorTools, getSkillDetail, inject, listSkills, makeRoutes, name, savePolicy, saveSkill, splitFrontmatter };
export { ExtractorStore, assembleCandidateFile, defaults as extractorDefaults, loadCandidates, runExtraction, saveCandidates, updateCandidate, writeSkill, writeSkillDual } from "./extractor.js";
