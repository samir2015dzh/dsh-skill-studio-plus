/**
 * dsh-skill-studio — skill extraction core (merged from dsh-skill-extractor).
 *
 * Pure, no DSH-runtime dependency. Handles: extractor config store, session-log
 * scanning/digesting, LLM candidate extraction, the candidate queue, dedup, and
 * writing SKILL.md into the Obsidian personal skill library (2️⃣ AI/Skill/).
 */
import { readdir, readFile, writeFile, mkdir, stat, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname, delimiter } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_CONFIG_FILE = join(homedir(), ".dsh", "dsh-skill-studio", "extractor.json");
export const DEFAULT_CANDIDATE_FILE = join(homedir(), ".dsh", "dsh-skill-studio", "candidates.json");
export const DEFAULT_SESSIONS_ROOT = join(homedir(), ".dsh", "sessions");

/**
 * The canonical session-log names DSH has written across generations:
 * `session.jsonl[.zstd]` (v0), `session.v3.jsonl.zstd`, `session.v4.jsonl.zstd`, …
 * Mirrors the core's `CANONICAL_LOG_FILENAME` (`/^session(?:\.v([1-9][0-9]*))?\.jsonl$/`)
 * plus the optional `.zstd` suffix, so a version bump never blinds the scanner again.
 */
export const SESSION_LOG_NAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/;

/** Whether a directory entry names a session log of any generation. */
export function isSessionLogName(name) {
	return SESSION_LOG_NAME.test(name);
}

/**
 * Directories a Finder-launched desktop Host does not put on PATH (the Electron
 * app inherits launchd's `/usr/bin:/bin:/usr/sbin:/sbin`), so a bare `zstd`
 * spawn would ENOENT there and the scan would silently return nothing.
 */
function extraBinDirs() {
	return [
		process.env.DSH_EXTRA_BIN_DIRS ?? "",
		"/opt/homebrew/bin",
		"/usr/local/bin",
		join(homedir(), ".local", "bin"),
		"/usr/bin",
		"/bin"
	].filter((d) => d !== "");
}

/** Absolute path of `name` when it is findable, otherwise the bare name (fallback). */
export function resolveExecutable(name) {
	const suffixes = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
	const seen = new Set();
	for (const dir of [...(process.env.PATH ?? "").split(delimiter), ...extraBinDirs()]) {
		if (dir === "" || seen.has(dir)) continue;
		seen.add(dir);
		for (const suffix of suffixes) {
			const candidate = join(dir, name + suffix);
			if (existsSync(candidate)) return candidate;
		}
	}
	return name;
}
/**
 * Resolve the per-user agent skill root that DSH's model-facing registry auto-loads.
 * Honours DSH_AGENTS_HOME (when configured); defaults to ~/.agents/skills.
 * Never baked to a single user's path — portability across machines/users.
 */
export function defaultAgentSkillDir() {
	const agentsHome = process.env.DSH_AGENTS_HOME;
	return agentsHome ? join(agentsHome, "skills") : join(homedir(), ".agents", "skills");
}

/**
 * Extra per-user skill directories the panel should also scan on top of the
 * standard roots — currently the user-configured mirror dir (e.g. Obsidian).
 * Resolved from the extractor config, never baked to one user's path.
 */
export async function configuredExtraSkillDirs() {
	try {
		const cfg = await new ExtractorStore().load();
		return cfg.mirrorDir ? [cfg.mirrorDir] : [];
	} catch {
		return [];
	}
}

function configPath() {
	const o = process.env.DSH_SKILL_EXTRACTOR_CONFIG;
	return o !== void 0 && o !== "" ? o : DEFAULT_CONFIG_FILE;
}
function candidatePath() {
	const o = process.env.DSH_SKILL_EXTRACTOR_CANDIDATES;
	return o !== void 0 && o !== "" ? o : DEFAULT_CANDIDATE_FILE;
}
function sessionsRoot() {
	const o = process.env.DSH_SKILL_EXTRACTOR_SESSIONS;
	return o !== void 0 && o !== "" ? o : DEFAULT_SESSIONS_ROOT;
}

export function defaults() {
	return {
		enabled: true,
		intervalMinutes: 1440,
		windowDays: 7,
		maxCandidatesPerRun: 3,
		skillLanguage: "zh",
		llmBaseUrl: "",
		llmApiKey: "",
		llmModel: "",
		agentSkillDir: defaultAgentSkillDir(),
		mirrorDir: "",
		/** 提取后直接写入正式库，不进待确认队列（入队仅当写入失败） */
		autoAccept: false,
		/** 与既存 skill 的 name+description 相似度超过此值才尝试语义合并 */
		mergeThreshold: 0.2,
		/** 手动指定模型；留空则跟随当前会话 / DSH 默认 */
		provider: "",
		model: "",
		/** 每轮对话结束时先做轻量判定，值得才提取 */
		autoPerTurn: true,
		lastRunAt: "",
		lastRunSummary: ""
	};
}

function clampInt(v, min, max) {
	if (typeof v !== "number" || !Number.isFinite(v)) return null;
	return Math.min(max, Math.max(min, Math.floor(v)));
}

export function parse(raw) {
	const r = typeof raw === "object" && raw !== null ? raw : {};
	const num = (v, f, min, max) => clampInt(v, min, max) ?? f;
	const str = (v, f = "") => typeof v === "string" ? v : f;
	const bool = (v, f) => typeof v === "boolean" ? v : f;
	const d = defaults();
	const lang = str(r.skillLanguage, d.skillLanguage).toLowerCase();
	return {
		enabled: bool(r.enabled, d.enabled),
		intervalMinutes: num(r.intervalMinutes, d.intervalMinutes, 0, 10080),
		windowDays: num(r.windowDays, d.windowDays, 1, 365),
		maxCandidatesPerRun: num(r.maxCandidatesPerRun, d.maxCandidatesPerRun, 1, 20),
		skillLanguage: lang === "en" ? "en" : lang === "auto" ? "auto" : "zh",
		llmBaseUrl: str(r.llmBaseUrl, d.llmBaseUrl),
		llmApiKey: str(r.llmApiKey, d.llmApiKey),
		llmModel: str(r.llmModel, d.llmModel),
		agentSkillDir: str(r.agentSkillDir, d.agentSkillDir),
		mirrorDir: str(r.mirrorDir, d.mirrorDir),
		autoAccept: bool(r.autoAccept, d.autoAccept),
		mergeThreshold: Math.min(1, Math.max(0, typeof r.mergeThreshold === "number" ? r.mergeThreshold : d.mergeThreshold)),
		provider: str(r.provider, d.provider),
		model: str(r.model, d.model),
		autoPerTurn: bool(r.autoPerTurn, d.autoPerTurn),
		lastRunAt: str(r.lastRunAt, d.lastRunAt),
		lastRunSummary: str(r.lastRunSummary, d.lastRunSummary)
	};
}

/** File-backed extractor config store (mode 0600). */
export class ExtractorStore {
	/** 由 apply() 在挂载时写入：宿主是否提供 llm 服务（true 时面板显示「走 DSH 模型」）。 */
	dshAvailable = false;
	async load() {
		try {
			return parse(JSON.parse(await readFile(configPath(), "utf8")));
		} catch {
			return defaults();
		}
	}
	async save(cfg) {
		await mkdir(dirname(configPath()), { recursive: true });
		const tmp = configPath() + ".tmp";
		await writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
		await rename(tmp, configPath());
		return cfg;
	}
	async patch(args) {
		const cur = await this.load();
		const merged = { ...cur };
		if (args !== void 0 && typeof args === "object") {
			for (const k of Object.keys(merged)) {
				if (k in args) merged[k] = args[k];
			}
		}
		const view = parse(merged);
		await this.save(view);
		return view;
	}
	async view() {
		const v = await this.load();
		return {
			...v,
			llmKeyMasked: v.llmApiKey ? v.llmApiKey.slice(0, 2) + "…" + v.llmApiKey.slice(-2) : "",
			llmApiKey: "",
			configured: v.llmBaseUrl !== "" && v.llmApiKey !== "" && v.llmModel !== "",
			dshModel: this.dshAvailable === true,
			configPath: configPath(),
			candidatePath: candidatePath()
		};
	}
}

async function findSessionFiles(root) {
	const out = [];
	async function walk(dir) {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isDirectory()) await walk(p);
			else if (isSessionLogName(e.name)) out.push(p);
		}
	}
	await walk(root);
	return out;
}

async function readSessionLog(file) {
	try {
		// Compressed generations shell out to a resolved `zstd`: a Finder-launched
		// desktop Host runs with launchd's minimal PATH, where a bare spawn is ENOENT
		// and the whole scan would silently come back empty. Plain `.jsonl` is read directly.
		const stdout = file.endsWith(".zstd")
			? (await execFileAsync(resolveExecutable("zstd"), ["-d", "-c", file], { maxBuffer: 512 * 1024 * 1024 })).stdout
			: await readFile(file, "utf8");
		const session = {};
		const msgs = [];
		let toolCalls = 0;
		let toolResults = 0;
		for (const l of stdout.split("\n")) {
			if (!l) continue;
			let o;
			try {
				o = JSON.parse(l);
			} catch {
				continue;
			}
			if (o === null || typeof o !== "object") continue;
			if (o.type === "session") {
				session.id = o.id;
				session.createdAt = o.createdAt;
				session.cwd = o.cwd;
			} else if (o.type === "agent/inbox/spliced") {
				const ins = o.data && o.data.inserted;
				if (Array.isArray(ins)) {
					for (const item of ins) {
						const role = item && item.role;
						const content = item && Array.isArray(item.content) ? item.content : [];
						const text = content.map((c) => (c && c.type === "text" ? c.text : "")).join(" ").trim();
						if (text) msgs.push({ role, text });
					}
				}
			} else if (o.type && o.type.startsWith("tool/")) {
				if (o.type === "tool/call") toolCalls++;
				else if (o.type === "tool/result") toolResults++;
			}
		}
		return { session, msgs, toolCalls, toolResults };
	} catch {
		return null;
	}
}

function truncate(s, n) {
	return s.length > n ? s.slice(0, n) + "…" : s;
}

export function buildDigest(log, maxMsgs = 20, maxMsgLen = 200) {
	const { session, msgs, toolCalls, toolResults } = log;
	const at = new Date(session.createdAt || Date.now());
	const title = session.cwd ? basename(session.cwd) : session.id || "unknown";
	const lines = [];
	lines.push(`## 会话「${title}」（${at.toISOString()}）`);
	if (session.cwd) lines.push(`工作区：${session.cwd}`);
	lines.push(`工具调用 ${toolCalls} 次 / 工具结果 ${toolResults} 次`);
	for (const m of msgs.slice(-maxMsgs)) {
		const role = m.role === "user" ? "用户" : "助手";
		lines.push(`- ${role}：${truncate(m.text, maxMsgLen)}`);
	}
	return lines.join("\n");
}

/** Collect recent session digests within `windowDays`, most recent first. */
export async function collectSessionDigests(root, windowDays, maxSessions = 12) {
	const files = await findSessionFiles(root);
	const cutoff = Date.now() - windowDays * 86400000;
	const found = [];
	for (const f of files) {
		let st;
		try {
			st = await stat(f);
		} catch {
			continue;
		}
		if (st.mtimeMs < cutoff) continue;
		const log = await readSessionLog(f);
		if (!log || log.msgs.length === 0) continue;
		found.push({ file: f, mtime: st.mtimeMs, log });
	}
	found.sort((a, b) => b.mtime - a.mtime);
	return found.slice(0, maxSessions);
}

export function buildPrompt(digestTexts, cfg) {
	const body = digestTexts.length ? digestTexts.join("\n\n") : "（没有近期会话）";
	const keepAsIs = "代码块、命令、路径、API 名、报错原文一律保持原样，不要翻译、不要改写。";
	const langLine =
		cfg.skillLanguage === "en"
			? `- 正文（body）用英文叙述；${keepAsIs} description 也用英文 Use when... 开头。`
			: cfg.skillLanguage === "auto"
				? `- 正文（body）跟随这段会话的主要语言叙述（会话是中文就中文，是英文就英文）；${keepAsIs} description 用英文 Use when... 开头。`
				: `- 正文（body）用中文叙述，但正文里出现的代码、命令、日志按原样保留；${keepAsIs} description 用英文 Use when... 开头（这是 agent 判断何时加载的依据）。`;
	return [
		"以下是从 DSH 会话日志里提取的摘要。请从中找出可复用的技术、模式、工作流或参考，把它们写成个人 skill。",
		"",
		"只考虑：跨项目、可复用、agent 以后能反复照做的内容。",
		"不考虑：一次性解决、项目专属约定、已被文档覆盖的标准做法、能用自动化替代的机械约束。",
		"",
		"每个 skill 给出：",
		"- name：kebab-case 英文名",
		"- description：一句话「何时使用」（用 Use when... 开头，不要概括流程）",
		"- rationale：为什么可复用（一句话）",
		"- body：markdown 正文（概述、何时用、核心模式、示例、常见错误），控制在 600–800 字，只写真正可复用的部分；不要写成某次解决过程的叙事，不要贴大段源码",
		langLine,
		"",
		`最多 ${cfg.maxCandidatesPerRun} 个。只输出 JSON（不要任何额外文字），格式：`,
		'{"candidates":[{"name":"","description":"","rationale":"","body":""}]}',
		"",
		"会话摘要：",
		body
	].join("\n");
}

/**
 * 解析要用的 provider/model：优先 cfg，其次当前 agent 的 route，最后回落到
 * DSH 已配置的第一个可用供应商。这样插件不需要自己存 API key / model。
 */
function pickRoute(agent, cfg) {
	if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model };
	const a = agent ?? {};
	for (const c of [a.route, a.config, a.options, a.defaultModel, a.model]) {
		if (c && typeof c === "object" && c.provider && c.model) return { provider: c.provider, model: c.model };
	}
	if (a.provider && a.model) return { provider: a.provider, model: a.model };
	return null;
}

async function resolveProviderModel(llm, agent, cfg) {
	const route = pickRoute(agent, cfg);
	if (route) return route;
	const providers = typeof llm.listProviders === "function" ? llm.listProviders() : [];
	if (!Array.isArray(providers) || providers.length === 0) throw new Error("DSH 未配置任何模型供应商");
	for (const p of providers) {
		const id = p.id ?? p.provider;
		if (!id) continue;
		try {
			const models = typeof llm.listModels === "function" ? await llm.listModels(id) : [];
			if (Array.isArray(models) && models.length > 0) {
				const first = models[0];
				const model = typeof first === "string" ? first : first.id ?? first.model;
				if (model) return { provider: id, model };
			}
		} catch {
			/* 该供应商不可用，继续下一个 */
		}
	}
	throw new Error("无法从 DSH 配置解析出可用模型（请在 DSH 里配置供应商/模型）");
}

/** 从一个 text 块流的 chunk 里取可见文本。 */
function chunkText(chunk) {
	if (!chunk || typeof chunk !== "object") return "";
	if (chunk.type === "text-delta") return typeof chunk.text === "string" ? chunk.text : typeof chunk.delta === "string" ? chunk.delta : "";
	if (chunk.type === "block-end" && chunk.block && chunk.block.type === "text" && typeof chunk.block.text === "string") return chunk.block.text;
	return "";
}

/**
 * 走 DSH 自己的 llm 服务（用户配置里的 provider/model，不额外存密钥）。
 * 返回纯文本；失败抛错由上层回退或报错。
 */
async function callViaDsh(llm, agent, cfg, prompt, { maxTokens = 4000, system = null } = {}) {
	const { provider, model } = await resolveProviderModel(llm, agent, cfg);
	runtimeState.lastRoute = { provider, model };
	const signal = AbortSignal.timeout(120000);
	// 提取是「读摘要 → 写条目」的机械活，用低思考强度更快更省；模型不支持就退回默认。
	const base = { provider, model, maxTokens };
	let prepared;
	try {
		prepared = await llm.prepareCall({ ...base, reasoningEffort: "low" }, signal);
	} catch {
		prepared = await llm.prepareCall(base, signal);
	}
	const options = {
		...prepared.config,
		system: system ?? "你从会话日志摘要中提取可复用的个人 skill。只输出 JSON。",
		messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
		signal
	};
	let text = "";
	let terminal;
	for await (const chunk of prepared.stream(options)) {
		const piece = chunkText(chunk);
		if (piece) text += piece;
		if (chunk.type === "finish") terminal = chunk.reason;
	}
	if (terminal && terminal.kind === "error") throw new Error("DSH 模型调用失败：" + (terminal.failure?.message ?? terminal.failure?.code ?? "unknown"));
	if (text.trim() === "") throw new Error("DSH 模型返回空内容");
	// 留一份原始输出，解析失败时不用猜模型到底返回了什么
	try {
		await writeFile(join(dirname(configPath()), "last-llm-raw.txt"), text, "utf8");
	} catch {
		/* 诊断文件写不进去不影响主流程 */
	}
	return text;
}

async function callViaHttp(cfg, prompt, { maxTokens = 4000, system = null } = {}) {
	const base = (cfg.llmBaseUrl || "").replace(/\/+$/, "");
	const res = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${cfg.llmApiKey}` },
		body: JSON.stringify({
			model: cfg.llmModel,
			messages: [
				{ role: "system", content: system ?? "你从会话日志摘要中提取可复用的个人 skill。只输出 JSON。" },
				{ role: "user", content: prompt }
			],
			temperature: 0.2,
			max_tokens: maxTokens,
			response_format: { type: "json_object" }
		}),
		signal: AbortSignal.timeout(120000)
	});
	if (!res.ok) throw new Error("LLM API responded " + res.status);
	const data = await res.json();
	const text =
		data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
	if (!text) throw new Error("LLM API empty completion");
	return text;
}

/**
 * 调模型。优先走 DSH 的 llm 服务（llm 由调用方从 ctx 传入），
 * 只有调用方没给 llm 或显式要求 HTTP 时才回退到自带的 baseUrl/apiKey。
 */
export async function callLLM(cfg, prompt, { maxTokens = 4000, llm = null, agent = null, system = null } = {}) {
	if (llm) return callViaDsh(llm, agent, cfg, prompt, { maxTokens, system });
	return callViaHttp(cfg, prompt, { maxTokens, system });
}

export function normalizeName(n) {
	return String(n)
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** 从任意文本里取出第一个括号配平的 JSON 对象（忽略字符串内的花括号与转义）。 */
function firstJsonObject(text) {
	const start = text.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') inStr = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

/** 去掉模型常带的 ```json 围栏。 */
function stripFence(text) {
	return String(text || "")
		.trim()
		.replace(/^```(?:json|JSON)?\s*\n?/, "")
		.replace(/\n?```\s*$/, "")
		.trim();
}

/** 模型输出被 maxTokens 截断时，逐个抢救 candidates 数组里已经完整的对象。 */
function salvageCandidates(text) {
	const key = text.indexOf('"candidates"');
	if (key < 0) return [];
	const arrStart = text.indexOf("[", key);
	if (arrStart < 0) return [];
	const out = [];
	let i = arrStart + 1;
	while (i < text.length) {
		const objStart = text.indexOf("{", i);
		if (objStart < 0) break;
		const obj = firstJsonObject(text.slice(objStart));
		if (obj === null) break;
		try {
			out.push(JSON.parse(obj));
		} catch {
			/* 这个对象本身就坏了，跳过继续 */
		}
		i = objStart + obj.length;
	}
	return out;
}

export function parseLlmCandidates(rawText) {
	const text = stripFence(rawText);
	let obj;
	try {
		obj = JSON.parse(text);
	} catch {
		const candidate = firstJsonObject(text);
		let parsed = null;
		if (candidate !== null) {
			try {
				parsed = JSON.parse(candidate);
			} catch {
				parsed = null;
			}
		}
		if (parsed !== null) obj = parsed;
		else {
			// 截断抢救：拿得到几个完整候选就用几个，不整批丢弃
			const salvaged = salvageCandidates(text);
			if (salvaged.length === 0) throw new Error("LLM response is not JSON");
			obj = { candidates: salvaged };
		}
	}
	const arr = Array.isArray(obj)
		? obj
		: obj && Array.isArray(obj.candidates)
			? obj.candidates
			: [];
	return arr
		.map((c) => ({
			name: normalizeName(String((c && c.name) || "")),
			description: String((c && c.description) || "").trim(),
			rationale: String((c && c.rationale) || "").trim(),
			body: String((c && c.body) || "").trim()
		}))
		.filter((c) => c.name && c.description && c.body);
}

export async function loadCandidates() {
	try {
		const arr = JSON.parse(await readFile(candidatePath(), "utf8"));
		return Array.isArray(arr) ? arr : [];
	} catch {
		return [];
	}
}

export async function saveCandidates(arr) {
	await mkdir(dirname(candidatePath()), { recursive: true });
	await writeFile(candidatePath(), JSON.stringify(arr, null, 2), { mode: 0o600 });
	return arr;
}

/**
 * Update one pending candidate's draft fields in the queue (by id). Accepts
 * `{ name, description, rationale, body }`; the name is re-normalized to
 * kebab-case. Returns the updated candidate or null when not found.
 */
export async function updateCandidate(id, patch) {
	const queue = await loadCandidates();
	const target = queue.find((c) => c.id === id && c.status === "pending");
	if (!target) return null;
	if (patch && typeof patch.body === "string") target.body = patch.body.trim();
	if (patch && typeof patch.rationale === "string") target.rationale = patch.rationale.trim();
	if (patch && typeof patch.description === "string") target.description = patch.description.trim();
	if (patch && typeof patch.name === "string") {
		const norm = normalizeName(patch.name);
		if (norm) target.name = norm;
	}
	await saveCandidates(queue);
	return target;
}

export async function existingSkillNames(targetDir) {
	try {
		const entries = await readdir(targetDir, { withFileTypes: true });
		const names = [];
		for (const e of entries) {
			if (e.isDirectory()) names.push(e.name);
			else if (e.name.endsWith(".md")) names.push(basename(e.name, ".md"));
		}
		return names;
	} catch {
		return [];
	}
}

export async function writeSkill(targetDir, cand, { force = false } = {}) {
	if (!cand || !cand.name) return { ok: false, message: "candidate 缺少 name" };
	const names = await existingSkillNames(targetDir);
	if (names.includes(cand.name) && !force) {
		return { ok: false, message: `已存在同名 skill ${cand.name}` };
	}
	const dir = join(targetDir, cand.name);
	await mkdir(dir, { recursive: true });
	const frontmatter = `---\nname: ${cand.name}\ndescription: ${JSON.stringify(String(cand.description ?? ""))}\n---\n`;
	const body = cand.body.startsWith("#") ? cand.body : `# ${cand.name}\n\n${cand.body}`;
	const file = join(dir, "SKILL.md");
	await writeFile(file, frontmatter + "\n" + body + "\n", { encoding: "utf8" });
	return { ok: true, message: `已写入 ${file}`, path: file };
}

/**
 * Write a candidate skill to the mandatory agent skill root (so DSH's
 * model-facing registry can load it) and, only when `mirrorDir` is set, to the
 * user-defined mirror dir. Each write dedups against its own dir; the result is
 * ok when at least one wrote.
 */
export async function writeSkillDual(agentDir, mirrorDir, cand, { force = false } = {}) {
	const results = [];
	if (agentDir) results.push({ dir: agentDir, ...(await writeSkill(agentDir, cand, { force })) });
	if (mirrorDir) results.push({ dir: mirrorDir, ...(await writeSkill(mirrorDir, cand, { force })) });
	const ok = results.some((r) => r.ok);
	return { ok, written: results.filter((r) => r.ok).map((r) => r.path), results };
}

export function shortenSummary(s) {
	return s.length > 400 ? s.slice(0, 400) + "…" : s;
}

/** Build the full SKILL.md text (frontmatter + body) for a candidate. */
export function assembleCandidateFile(cand) {
	const frontmatter = `---\nname: ${cand.name}\ndescription: ${JSON.stringify(String(cand.description ?? ""))}\n---\n`;
	const body = cand.body.startsWith("#") ? cand.body : `# ${cand.name}\n\n${cand.body}`;
	return frontmatter + "\n" + body + "\n";
}

/**
 * Run one extraction pass: scan recent logs, prompt the LLM, stage the fresh
 * candidates into the queue (dedup against existing skills and queued names).
 * Returns a result; caller persists lastRunAt/lastRunSummary.
 */
/** 类别别名：把同族前缀归到同一个类，供裁决与本地校验使用。 */
const CATEGORY_ALIASES = {
	desktop: "gui",
	gui: "gui",
	swing: "gui",
	electron: "gui",
	handoff: "handoff",
	session: "handoff",
	context: "handoff",
	cross: "handoff",
	project: "handoff",
	agent: "handoff",
	long: "handoff",
	decompiled: "decompile",
	decompile: "decompile",
	java: "java",
	"java-decompile": "decompile",
	"java-oom": "oom",
	"java-swing": "gui",
	"java-desktop": "portable",
	"java-legacy": "parity",
	jadx: "decompile",
	cfr: "decompile",
	portable: "portable",
	offline: "portable",
	remote: "portable",
	relocatable: "portable",
	windows: "portable",
	native: "parity",
	binary: "parity",
	apk: "android",
	android: "android",
	background: "bgjob",
	oom: "oom",
	heap: "oom",
	constrained: "oom",
	probe: "probe",
	isolated: "probe",
	readonly: "audit",
	asar: "audit",
	packaged: "audit",
	verify: "verify",
	skill: "skillmgmt",
	make: "skillmgmt",
	auto: "skillmgmt",
	overlapping: "skillmgmt",
	subagent: "subagent",
	delegated: "subagent",
	shared: "subagent",
	exclusive: "subagent",
	evidence: "subagent",
	acceptance: "subagent",
};

/** 从 skill 名字推导类别（前两段优先，其次首段）。 */
export function categoryOf(name) {
	const parts = String(name || "").toLowerCase().split("-").filter(Boolean);
	if (parts.length === 0) return "other";
	const two = parts.slice(0, 2).join("-");
	if (CATEGORY_ALIASES[two]) return CATEGORY_ALIASES[two];
	if (CATEGORY_ALIASES[parts[0]]) return CATEGORY_ALIASES[parts[0]];
	return parts[0];
}

/** 候选与某个既有 skill 的相似度（name + description 的 Jaccard）。 */
export function similarityOf(cand, skill) {
	const ta = tokensOf(`${cand.name ?? ""} ${cand.description ?? ""}`);
	const tb = tokensOf(`${skill.name ?? ""} ${skill.desc ?? skill.description ?? ""}`);
	return jaccard(ta, tb);
}

const STOP_WORDS = new Set(
	"a an the to of for and or in on with when you your it is are be as at by from this that use used using which what how not no i we they he she his her its our us also any all so if then than into over under out up down only just like such do does did will would can could should may might must have has had been being more most other some each both".split(" ")
);

/** 粗粒度 token 集合：英文词 + 中文 2-gram（中文整段当一个 token 会永不匹配）。 */
function tokensOf(text) {
	const s = String(text || "").toLowerCase();
	const out = new Set();
	for (const w of s.match(/[a-z][a-z0-9]{2,}/g) ?? []) if (!STOP_WORDS.has(w)) out.add(w);
	for (const seg of s.match(/[\u4e00-\u9fff]+/g) ?? []) {
		if (seg.length <= 2) out.add(seg);
		else for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
	}
	return out;
}

function jaccard(a, b) {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter++;
	return inter / (a.size + b.size - inter);
}

/**
 * 读目标目录下所有既有 skill 的 name/description/正文，建相似度索引。
 * 只统计目录版与单文件版两种布局（与 loader 一致）。
 */
export async function buildSkillIndex(dir) {
	const index = [];
	if (!dir) return index;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return index;
	}
	for (const e of entries) {
		const file = e.isDirectory() ? join(dir, e.name, "SKILL.md") : e.name.endsWith(".md") ? join(dir, e.name) : null;
		if (!file) continue;
		let text;
		try {
			text = await readFile(file, "utf8");
		} catch {
			continue;
		}
		const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		const block = fm ? fm[1] : "";
		const name = (block.match(/^name:\s*(.+)$/m)?.[1] ?? e.name.replace(/\.md$/, "")).trim().replace(/^["']|["']$/g, "");
		const descRaw = block.match(/^description:\s*(.+)$/m)?.[1] ?? "";
		const desc = descRaw.trim().replace(/^["']|["']$/g, "");
		const body = fm ? text.slice(fm[0].length) : text;
		index.push({ name, desc, body, path: file, category: categoryOf(name), tok: tokensOf(name + " " + desc) });
	}
	return index;
}

/** 取与候选最像的既存 skill（按 name+description 的 Jaccard 排序）。 */
export function bestMatches(index, cand, limit = 3) {
	const tok = tokensOf((cand.name ?? "") + " " + (cand.description ?? ""));
	return index
		.map((item) => ({ item, score: jaccard(tok, item.tok) }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);
}

/** 最近一次实际使用的模型路由，供面板显示「实际用哪个」。 */
export const runtimeState = { lastRoute: null };

const PLACEMENT_SYSTEM = [
	"你在维护一个 agent skill 库。给你【已有 skill 清单】和【新候选 skill】。",
	"清单每行是 `- [类别] 名字: 描述`。**先看类别**：候选与某条类别相同、且描述说的是同一类工作流，才算覆盖。",
	"类别不同就不要合并 —— 例如 [decompile] 的候选不要塞进 [java] 或 [parity] 的 skill。",
	"有覆盖 → FOLD_INTO: <已有 skill 名>；确实是新主题 → SAVE。",
	"宁可 SAVE 也不要强行合并：把不相关的东西塞进已有 skill，比多一个 skill 更糟。",
	'只输出 JSON：{"decisions":[{"candidate":"<候选名>","action":"FOLD_INTO","into":"<已有名>"}]}；SAVE 时 action 写 SAVE，不带 into。'
].join("\n");

/**
 * 把「整份既有 skill 清单 + 新候选」交给模型裁决归属。
 * 本地的 token 相似度抓不住措辞差异（实测同类 skill 只有 0.07–0.24），所以这一步是必需的。
 */
export async function judgePlacement(cfg, llm, agent, index, candidates) {
	if (index.length === 0 || candidates.length === 0) return new Map();
	const catalog = index.map((s) => `- [${s.category || categoryOf(s.name)}] ${s.name}: ${(s.desc || "").slice(0, 90)}`).join("\n");
	const list = candidates.map((c) => `- ${c.name}: ${(c.description || "").slice(0, 120)}`).join("\n");
	const prompt = ["【已有 skill 清单】", catalog, "", "【新候选】", list].join("\n");
	const raw = await callLLM(cfg, prompt, { llm, agent, maxTokens: 2000, system: PLACEMENT_SYSTEM });
	const json = firstJsonObject(stripFence(raw));
	if (!json) return new Map();
	const obj = JSON.parse(json);
	const out = new Map();
	for (const d of Array.isArray(obj?.decisions) ? obj.decisions : []) {
		if (d && typeof d.candidate === "string") out.set(d.candidate, d);
	}
	return out;
}

/** 最近改动过的 skill（按 mtime 倒序），供面板展示「最近添加」。 */
export async function recentSkills(dir, limit = 20) {
	if (!dir) return [];
	const index = await buildSkillIndex(dir);
	const withTime = [];
	for (const s of index) {
		try {
			const st = await stat(s.path);
			withTime.push({ name: s.name, description: s.desc, path: s.path, mtime: st.mtimeMs });
		} catch {
			/* 读不到跳过 */
		}
	}
	withTime.sort((a, b) => b.mtime - a.mtime);
	return withTime.slice(0, Math.max(1, limit)).map((s) => ({ ...s, added: new Date(s.mtime).toISOString() }));
}

/** 收集所有归档目录里出现过的 skill 名字 —— 这些名字以前被合并过，不许再新建。 */
export async function archivedNames() {
	const base = join(homedir(), ".dsh");
	const out = new Set();
	try {
		for (const e of await readdir(base, { withFileTypes: true })) {
			if (!e.isDirectory() || !e.name.startsWith("skill-archive")) continue;
			let names = [];
			try {
				names = await readdir(join(base, e.name));
			} catch {
				continue;
			}
			for (const n of names) out.add(n.replace(/-v\d+$/, "").replace(/\.orig$/, ""));
		}
	} catch {
		/* 读不到归档目录就当没有墓碑 */
	}
	return out;
}

const VERDICT_SYSTEM = "你判断一段 agent 会话是否值得沉淀成可复用的 skill。只回答 YES 或 NO。";

/**
 * 轻量判定：这一轮是否值得做完整提取。只发小 prompt、只要 YES/NO，
 * 让「每轮都判断」的成本可以接受。
 */
export async function shouldExtract(cfg, { llm = null, agent = null } = {}) {
	try {
		const digs = await collectSessionDigests(sessionsRoot(), 1, 1);
		if (digs.length === 0) return false;
		const digest = buildDigest(digs[0].log, 10, 400);
		const prompt = [
			"判断下面这段最近的 agent 会话里，是否出现了【值得沉淀成 skill】的内容：",
			"- 新技术 / 新工具链的可用做法",
			"- 踩过的坑与恢复路径（错误 → 怎么绕过）",
			"- 可复用的多步工作流",
			"不算：一次性问答、纯查询、skill 库里已覆盖的常规做法、没有结论的中断。",
			"也不算：关于工具/插件本身如何配置或实现的元讨论（例如「这个 skill 插件怎么装」）。",
			"只回答 YES 或 NO。",
			"",
			digest
		].join("\n");
		const raw = await callLLM(cfg, prompt, { llm, agent, maxTokens: 16, system: VERDICT_SYSTEM });
		return /^\s*YES\b/i.test(stripFence(raw));
	} catch {
		return false;
	}
}

const MERGE_SYSTEM = [
	"你在维护一份 agent skill 库。给你一个【既存 skill】的完整正文，和一个【新候选 skill】（来自最近的会话经验）。",
	"判断它们是否属于同一类工作流。",
	"如果是：把新候选里真正新增的经验（尤其是踩坑与恢复路径）合并进既存正文，保持原有的章节结构（# Title / ## 概述 / ## 何时用 / ## 核心模式 / ## 常见错误），不要为了改写而改写。",
	"如果不是：只回答 KEEP。",
	"",
	"只输出两种情况之一，不要其他文字：",
	"KEEP",
	"或：",
	"MERGE: <完整的更新后 SKILL.md 正文（不含 frontmatter）>"
].join("\n");

const MERGE_SYSTEM_FORCE = [
	"你在维护一份 agent skill 库。给你一个【既存 skill】的完整正文，和一个【新候选 skill】。",
	"这个候选的名字在过去已经被合并过一次，说明它属于同类工作流 —— 不要再新建同名 skill。",
	"把新候选里真正新增的经验（尤其是踩坑与恢复路径）并入既存正文，保持原有章节结构（# Title / ## 概述 / ## 何时用 / ## 核心模式 / ## 常见错误）。",
	"如果确实没有任何新内容，就原样返回既存正文。",
	"",
	"只输出一种格式，不要其他文字：",
	"MERGE: <完整的更新后 SKILL.md 正文（不含 frontmatter）>"
].join("\n");

/** 合并时模型有时会把整篇原文再抄一遍 —— 第二个同名二级标题起视为重复输出，截断。 */
function dedupeBody(body) {
	// 正文可能以 "## 概述" 开头（没有前导换行），补一个以便统一按 "\n## " 查找
	const b = body.startsWith("\n") ? body : "\n" + body;
	const first = b.indexOf("\n## ");
	if (first < 0) return body;
	const eol = b.indexOf("\n", first + 1);
	const marker = eol < 0 ? b.slice(first + 1) : b.slice(first + 1, eol);
	if (marker === "" || marker.length > 40) return body;
	const second = b.indexOf("\n" + marker, first + 1);
	if (second < 0) return body;
	return b.slice(1, second).trimEnd();
}

/** 合并时模型有时会把协议标记一起吐进正文 —— MERGE: / KEEP 出现在末尾就切掉。 */
function stripResidue(body) {
	const i = body.lastIndexOf("MERGE:");
	if (i >= 0 && body.length - i < 300) return body.slice(0, i).trimEnd();
	const j = body.lastIndexOf("KEEP");
	if (j >= 0 && body.length - j < 80) return body.slice(0, j).trimEnd();
	return body;
}

async function tryMerge(cfg, llm, agent, hit, cand, { force = false } = {}) {
	const prompt = [
		"【既存 skill】",
		`name: ${hit.name}`,
		`description: ${hit.desc}`,
		"",
		hit.body.slice(0, 12000),
		"",
		"【新候选 skill】",
		`name: ${cand.name}`,
		`description: ${cand.description}`,
		"",
		cand.body.slice(0, 8000)
	].join("\n");
	const raw = await callLLM(cfg, prompt, { llm, agent, maxTokens: 6000, system: force ? MERGE_SYSTEM_FORCE : MERGE_SYSTEM });
	const text = stripFence(raw);
	if (!force && /^KEEP\b/i.test(text)) return null;
	const m = text.match(/^MERGE:\s*([\s\S]+)$/i);
	if (!m) return null;
	const body = stripResidue(dedupeBody(m[1].trim()));
	if (body.length < (force ? 10 : 40)) return null;
	// 合并结果比原文短太多 → 视为模型截断，保留原文不动
	if (body.length < (hit.body?.length ?? 0) * 0.6) return null;
	return { hit, body };
}

/**
 * Run one extraction pass: scan recent logs, ask the LLM for candidates,
 * merge near-duplicates into existing skills, then either auto-accept straight
 * into the skill root or stage them for review.
 *
 * 走 DSH 自己的模型：传入 llm（由插件把 ctx.llm 递进来）即可，不需要
 * baseUrl/apiKey/model；三者只在没有 llm 时作为 HTTP 回退。
 */
export async function runExtraction(cfg, root = sessionsRoot(), { now = Date.now(), llm = null, agent = null } = {}) {
	if (!cfg.enabled) return { ok: false, message: "提取已禁用" };
	if (!llm && !(cfg.llmBaseUrl && cfg.llmApiKey && cfg.llmModel)) {
		return { ok: false, message: "没有可用的模型通道：DSH 侧未提供 llm 服务，且未配置 baseUrl/apiKey/model" };
	}
	const digs = await collectSessionDigests(root, cfg.windowDays);
	if (digs.length === 0) return { ok: true, message: "近期无会话可提取", candidates: [], digests: 0 };
	const digestsText = digs.map((d) => buildDigest(d.log));
	const raw = await callLLM(cfg, buildPrompt(digestsText, cfg), { llm, agent, maxTokens: 8000 });
	const cands = parseLlmCandidates(raw).slice(0, cfg.maxCandidatesPerRun);

	const index = await buildSkillIndex(cfg.agentSkillDir);
	const existing = new Set(index.map((s) => s.name));
	const queue = await loadCandidates();
	const queuedNames = new Set(queue.map((c) => c.name));
	const fresh = cands.filter((c) => !existing.has(c.name) && !queuedNames.has(c.name));

	// 全量裁决：本地相似度抓不住措辞差异，交给模型看整份清单
	let decisions = new Map();
	if (fresh.length > 0 && index.length > 0) {
		try {
			decisions = await judgePlacement(cfg, llm, agent, index, fresh);
		} catch {
			/* 裁决失败退回本地相似度兜底 */
		}
	}
	// 归档过的名字：模型会反复造同名 skill，命中就强制并入最接近的既有项
	const tombstone = await archivedNames();

	const merged = [];
	const dropped = [];
	const survivors = [];
	for (const c of fresh) {
		const d = decisions.get(c.name);
		let hit = null;
		let reason = "";
		let rejected = false;
		if (tombstone.has(c.name)) {
			const cat = categoryOf(c.name);
			const pool = bestMatches(index, c, 5).filter((x) => (x.item.category || categoryOf(x.item.name)) === cat);
			const list = pool.length > 0 ? pool : bestMatches(index, c, 3);
			if (list.length > 0) {
				// 同类里选正文最长的：主 skill 通常最全，避免内容摊到碎片上
				let best = list[0];
				for (const x of list) if ((x.item.body?.length ?? 0) > (best.item.body?.length ?? 0)) best = x;
				hit = best.item;
				reason = "tombstone";
			}
		}
		if (!hit && d && String(d.action).toUpperCase() === "FOLD_INTO" && typeof d.into === "string") {
			const target = index.find((s) => s.name === d.into) ?? null;
			if (target) {
				// 本地复核：类别不一致且相似度不足 → 改判 SAVE，避免把反编译的塞进探针对拍里
				const sameCat = categoryOf(c.name) === (target.category || categoryOf(target.name));
				const sim = similarityOf(c, target);
				// 同类直接放行；跨类别只在描述几乎一模一样时才允许（0.3 太松，会跨类污染）
				if (sameCat || sim >= 0.5) {
					hit = target;
					reason = "model";
				} else {
					reason = "rejected";
					rejected = true;
				}
			}
		}
		if (!hit && !rejected) {
			const h = bestMatches(index, c, 1)[0];
			if (h && h.score >= cfg.mergeThreshold * 2) {
				hit = h.item;
				reason = "local";
			}
		}
		if (!hit) {
			survivors.push(c);
			continue;
		}
		try {
			const decision = await tryMerge(cfg, llm, agent, hit, c, { force: reason === "tombstone" });
			if (decision) {
				await writeSkill(cfg.agentSkillDir, { name: decision.hit.name, description: decision.hit.desc, body: decision.body }, { force: true });
				if (cfg.mirrorDir) await writeSkill(cfg.mirrorDir, { name: decision.hit.name, description: decision.hit.desc, body: decision.body }, { force: true });
				merged.push({ into: decision.hit.name, from: c.name, by: reason || "unknown" });
				continue;
			}
		} catch {
			/* 合并失败按新 skill 处理，不丢候选 */
		}
		if (reason === "tombstone") {
			// 名字以前被合并过、这次又合不进去 → 丢弃，绝不再写一份重复
			dropped.push(c.name);
			continue;
		}
		survivors.push(c);
	}

	const staged = survivors.map((c, i) => ({
		id: `${now}-${i}`,
		status: "pending",
		created: now,
		sourceCount: digs.length,
		...c
	}));

	// autoAccept：直接写入正式库（dedup 由 writeSkillDual 负责）；写失败的才留在队列里
	let pendingStaged = staged;
	const accepted = [];
	if (cfg.autoAccept && cfg.agentSkillDir) {
		pendingStaged = [];
		for (const c of staged) {
			const r = await writeSkillDual(cfg.agentSkillDir, cfg.mirrorDir, c);
			if (r.written && r.written.length) accepted.push({ name: c.name, path: r.written[0] });
			else pendingStaged.push(c);
		}
	}

	const nextQueue = [...queue, ...pendingStaged];
	await saveCandidates(nextQueue);
	const acceptedNote = accepted.length > 0 ? `，直接写入 ${accepted.length} 个（${accepted.map((a) => a.name).join(", ")}）` : "";
	const mergedNote = merged.length > 0 ? `，合并 ${merged.length} 个（${merged.map((m) => `${m.from}→${m.into}`).join(", ")}）` : "";
	const droppedNote = dropped.length > 0 ? `，丢弃 ${dropped.length} 个已归档同名（${dropped.join(", ")}）` : "";
	const message = `扫描 ${digs.length} 个会话，产出 ${staged.length + merged.length} 个候选（跳过 ${cands.length - fresh.length} 个同名）${mergedNote}${droppedNote}${acceptedNote}`;
	return {
		ok: true,
		message,
		dropped,
		candidates: staged,
		accepted,
		merged,
		digests: digs.length,
		queued: nextQueue.length,
		site: { lastRunAt: new Date(now).toISOString(), lastRunSummary: shortenSummary(message) }
	};
}

export const _internal = { configPath, candidatePath, sessionsRoot };
