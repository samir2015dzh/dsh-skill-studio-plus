/**
 * darwin 体检调度器 —— 从独立插件 dsh-darwin-auto 并入 dsh-skill-studio。
 *
 * 两个注入点与原插件一致：
 *   tools/post-execute     写入 SKILL.md → 记 pending；模型加载 darwin-skill → 静默
 *   system-prompt/assemble pending 非空 → 追加 section，模型下一轮必读
 *
 * 合并带来的增强：借用插件已有的 llm 服务自动生成同族去重表 families.json。
 * 原插件零 @deepseek-ai 依赖，装不了模型客户端，只能把聚类交给模型手工做。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { callLLM } from "./extractor.js";

const HOME = os.homedir();
// 沿用原插件目录：已有 state.json 的 seen / scores 直接复用，不会全量重扫
const STATE_DIR = path.join(HOME, ".dsh", "darwin-auto");
const STATE_FILE = path.join(STATE_DIR, "state.json");

const DEFAULTS = {
	enabled: true,
	/** 只在这几棵树下写的 SKILL.md 才触发 */
	roots: [path.join(HOME, ".agents", "skills"), path.join(HOME, ".dsh", "skills")],
	/** 加载 darwin-skill 后静默多久，防自激循环（它自己会改 SKILL.md） */
	suppressMs: 15 * 60_000,
	/** pending 项最长存活，超时丢弃 */
	pendingTtlMs: 6 * 60 * 60_000,
	/** 巡检间隔 */
	sweepHours: 24,
	/** 超过这么多天没记录的 skill 进巡检清单 */
	staleDays: 14,
	/** 巡检一次最多列几个 */
	sweepLimit: 5,
	/** 同族去重表；文件不存在则不做任何过滤 */
	familyFile: path.join(STATE_DIR, "families.json"),
	/** 状态文件；可覆盖以便测试隔离 */
	stateFile: STATE_FILE,
	/** families.json 超过这么多天就在下次有 pending 时用 LLM 重聚一次；0 = 关闭自动重聚 */
	familyRefreshDays: 7,
};

const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "write_file", "multi_edit"]);

/** Windows 路径大小写不敏感，统一小写比较。 */
function norm(p) {
	try {
		return path.resolve(p).replace(/\//g, path.sep).toLowerCase();
	} catch {
		return String(p).toLowerCase();
	}
}

function readState(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return { scores: {}, lastSweep: 0 };
	}
}

function writeState(file, state) {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(state, null, 2));
	} catch {
		/* 状态文件写不进去不影响主流程 */
	}
}

/** 递归列 SKILL.md，深度受限，跳过 .git / node_modules。 */
function listSkillFiles(root, out = [], depth = 0) {
	if (depth > 4) return out;
	let entries;
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry.name === ".git" || entry.name === "node_modules") continue;
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) listSkillFiles(full, out, depth + 1);
		else if (entry.isFile() && /^SKILL\.md$/i.test(entry.name)) out.push(full);
	}
	return out;
}

/** 从 SKILL.md 路径取 skill 名（父目录名）。 */
function skillNameOf(file) {
	return path.basename(path.dirname(file)).toLowerCase();
}

/** 读同族去重表，返回 Map<成员名, 宿主名>。 */
function loadFamilies(file) {
	const map = new Map();
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return map;
	}
	for (const fam of raw?.families ?? []) {
		const host = String(fam?.host ?? "").trim().toLowerCase();
		if (!host) continue;
		for (const m of fam?.members ?? []) {
			const name = String(m ?? "").trim().toLowerCase();
			if (name && name !== host) map.set(name, host);
		}
	}
	return map;
}

function readFamilyStamp(file) {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		const t = Date.parse(String(raw?.updatedAt ?? ""));
		return Number.isFinite(t) ? t : 0;
	} catch {
		return 0;
	}
}

/** 从模型回复里抠出第一个 JSON 对象。 */
function pickJson(text) {
	const raw = String(text ?? "");
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
}

const CLUSTER_SYSTEM = "你判断一组 agent skill 是否属于同一职责家族。只输出 JSON，不解释。";

/**
 * 用插件已有的 llm 服务按职责语义把 skill 分组，写回 families.json。
 * 判断依据是 description 的职责，不是名字字面相似度。
 */
async function clusterFamilies(llm, cfg, files) {
	const items = [];
	for (const file of files) {
		let text = "";
		try {
			text = fs.readFileSync(file, "utf8").slice(0, 1200);
		} catch {
			continue;
		}
		const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
		const body = fm ? fm[1] : "";
		const nameMatch = /^name:\s*(.+)$/m.exec(body);
		const descMatch = /^description:\s*(.+)$/m.exec(body);
		items.push({
			name: skillNameOf(file),
			description: (descMatch ? descMatch[1] : "").trim().slice(0, 300),
			declaredName: (nameMatch ? nameMatch[1] : "").trim().slice(0, 80),
		});
	}
	if (items.length < 2) return null;

	const prompt = [
		"下面是一批 agent skill 的 name + description。",
		"把属于同一职责家族的分到一起：判据是「能不能用同一句话概括它们负责什么」。",
		"只共享场景词（都提到 subagent、都提到 GUI）不算同族。",
		"每族选一个当 host：调用状态为启用、正文最完整、被其他人引用的优先。",
		"只输出 JSON，格式：",
		'{"families":[{"id":"short-id","host":"skill-name","members":["skill-name"],"reason":"一句话"}]}',
		"没有重复就输出 {\"families\":[]}。",
		"",
		...items.map((i) => `- ${i.name}${i.description ? " :: " + i.description : ""}`),
	].join("\n");

	const text = await callLLM({}, prompt, { maxTokens: 4000, llm, system: CLUSTER_SYSTEM });
	const parsed = pickJson(text);
	const families = [];
	const known = new Set(items.map((i) => i.name));
	for (const fam of parsed?.families ?? []) {
		const host = String(fam?.host ?? "").trim().toLowerCase();
		if (!known.has(host)) continue;
		const members = (fam?.members ?? [])
			.map((m) => String(m ?? "").trim().toLowerCase())
			.filter((m) => known.has(m) && m !== host);
		if (members.length === 0) continue;
		families.push({
			id: String(fam?.id ?? "").trim() || host,
			host,
			members,
			reason: String(fam?.reason ?? "").trim().slice(0, 300),
		});
	}

	const out = {
		version: 1,
		updatedAt: new Date().toISOString().slice(0, 10),
		note: "由 dsh-skill-studio 的 darwin 调度器自动生成。host 进评分队列，members 被折叠。",
		families,
	};
	fs.mkdirSync(path.dirname(cfg.familyFile), { recursive: true });
	fs.writeFileSync(cfg.familyFile, JSON.stringify(out, null, 2));
	return out;
}

/**
 * @param ctx   插件 ctx（需要 tools 事件与 systemPrompt）
 * @param config cordis.patch.yml 里 config.darwin 段
 * @param deps  { llm } —— ctx.llm，缺省则不自动聚类
 */
export function applyDarwin(ctx, config = {}, deps = {}) {
	const cfg = { ...DEFAULTS, ...config };
	if (!cfg.enabled) return;

	const pending = new Map();
	const roots = cfg.roots.map(norm);
	let suppressUntil = 0;
	let state = readState(cfg.stateFile);
	let clusterBusy = false;
	let lastScan = 0;

	const underRoots = (file) => {
		const f = norm(file);
		return roots.some((root) => f === root || f.startsWith(root + path.sep));
	};

	/**
	 * 有 pending 且表过期时，后台重聚一次。不 await —— 不阻塞本轮。
	 */
	const maybeCluster = () => {
		const llm = deps.llm;
		if (!llm || clusterBusy) return;
		if (!(cfg.familyRefreshDays > 0)) return;
		if (state.familiesPending !== true) return;
		const now = Date.now();
		if (now - (state.lastFamilyJudge ?? 0) < 12 * 3_600_000) return;
		if (now - readFamilyStamp(cfg.familyFile) < cfg.familyRefreshDays * 86_400_000) return;

		clusterBusy = true;
		state.lastFamilyJudge = now;
		writeState(cfg.stateFile, state);
		const files = [];
		for (const root of cfg.roots) files.push(...listSkillFiles(root));
		void clusterFamilies(llm, cfg, files)
			.then((out) => {
				if (out) {
					state.familiesPending = false;
					writeState(cfg.stateFile, state);
					ctx.logger?.info?.(`[dsh-skill-studio] darwin families: ${out.families.length} 族 / ${files.length} 个 skill`);
				}
			})
			.catch((err) => ctx.logger?.warn?.("[dsh-skill-studio] darwin families failed: " + (err?.message ?? err)))
			.finally(() => {
				clusterBusy = false;
			});
	};

	/** 扫 mtime，找被「非工具层」写入的文件（插件直接落盘）。首次只建基线。 */
	const scanChanged = () => {
		const changed = [];
		if (state.seen === undefined) {
			state.seen = {};
			for (const root of cfg.roots) {
				for (const file of listSkillFiles(root)) {
					try {
						state.seen[norm(file)] = fs.statSync(file).mtimeMs;
					} catch {
						/* 读不到就跳过 */
					}
				}
			}
			writeState(cfg.stateFile, state);
			return changed;
		}
		for (const root of cfg.roots) {
			for (const file of listSkillFiles(root)) {
				const key = norm(file);
				if (pending.has(key)) continue;
				let mtime = 0;
				try {
					mtime = fs.statSync(file).mtimeMs;
				} catch {
					continue;
				}
				if ((state.seen[key] ?? 0) < mtime) {
					state.seen[key] = mtime;
					changed.push({ key, file });
				}
				if (changed.length >= 3) break;
			}
			if (changed.length >= 3) break;
		}
		if (changed.length > 0) writeState(cfg.stateFile, state);
		return changed;
	};

	ctx.on("tools/post-execute", async (exec, result, next) => {
		try {
			const toolName = String(exec?.name ?? "");
			const args = exec?.arguments ?? {};
			const file =
				typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";

			if (file && /(^|[\\/])SKILL\.md$/i.test(file) && underRoots(file)) {
				pending.set(norm(file), { at: Date.now(), file });
				state.familiesPending = true;
			}

			// 模型读了 darwin-skill：关闸，避免「评分→改进→再触发」死循环
			if (toolName === "skill" && String(args.name ?? "") === "darwin-skill") {
				suppressUntil = Date.now() + cfg.suppressMs;
				for (const key of pending.keys()) state.scores[key] = Date.now();
				pending.clear();
				writeState(cfg.stateFile, state);
			}
		} catch (err) {
			ctx.logger?.warn?.(`darwin: ${err?.message ?? err}`);
		}
		return next();
	});

	ctx.on("system-prompt/assemble", async (assembly, context, next) => {
		const out = await next();
		try {
			if (Date.now() < suppressUntil) return out;

			const now = Date.now();
			if (now - lastScan > 60_000) {
				lastScan = now;
				for (const c of scanChanged()) {
					pending.set(c.key, { at: now, file: c.file });
					state.familiesPending = true;
				}
			}

			const editedRaw = [];
			for (const [key, meta] of pending) {
				if (now - meta.at > cfg.pendingTtlMs) {
					pending.delete(key);
					continue;
				}
				editedRaw.push(meta.file);
			}
			if (editedRaw.length > 0) maybeCluster();

			// 同族去重：成员折进宿主，成员的 scores 记为已处理，下轮不再重复送审
			const familyHost = loadFamilies(cfg.familyFile);
			const edited = [];
			const folded = [];
			for (const file of editedRaw) {
				const name = skillNameOf(file);
				const host = familyHost.get(name);
				if (host && host !== name) {
					folded.push({ file, host });
					state.scores[norm(file)] = now;
					pending.delete(norm(file));
				} else {
					edited.push(file);
				}
			}
			if (folded.length > 0) writeState(cfg.stateFile, state);

			// 巡检：只按间隔跑，且只在没有待办时补位
			const stale = [];
			if (edited.length === 0 && now - (state.lastSweep ?? 0) > cfg.sweepHours * 3_600_000) {
				state.lastSweep = now;
				const cutoff = now - cfg.staleDays * 86_400_000;
				for (const root of cfg.roots) {
					for (const file of listSkillFiles(root)) {
						if ((state.scores[norm(file)] ?? 0) < cutoff) stale.push(file);
						if (stale.length >= cfg.sweepLimit) break;
					}
					if (stale.length >= cfg.sweepLimit) break;
				}
				writeState(cfg.stateFile, state);
			}

			if (edited.length === 0 && stale.length === 0) return out;

			const lines = ["## skill 自动体检（darwin）"];
			if (folded.length > 0) {
				lines.push(
					`下列 ${folded.length} 个 skill 属同族重复，已按 families.json 折叠，本轮不单独评估：`,
					...folded.map((f) => `- ${f.file} → ${f.host}`),
					"",
				);
			}
			if (edited.length > 0) {
				lines.push(
					"本轮检测到下列 skill 文件被改写，必须在本轮结束前完成评估，不需要用户点名：",
					...edited.map((f) => `- ${f}`),
					"",
					"步骤：用 skill 工具加载 darwin-skill → 按 9 维 rubric 评分 → 分数低于 70 或命中 meta-skill 黑名单时直接落地改进（darwin 自带 git 回滚）→ 一句话汇报分数与改动。",
					"本次为无人值守模式：跳过 human-in-the-loop 确认，直接执行并在 git 分支上落地，回滚点由 darwin 自己保留。",
					"自激保护：加载 darwin-skill 后本提示自动关闭 15 分钟，期间的改写不再触发。",
				);
			}
			if (stale.length > 0) {
				lines.push(
					`下列 skill 已超过 ${cfg.staleDays} 天没有体检记录，本期巡检顺手评估：`,
					...stale.map((f) => `- ${f}`),
				);
			}

			return {
				...out,
				sections: [...(out.sections ?? []), { name: "darwin", text: lines.join("\n") }],
			};
		} catch (err) {
			ctx.logger?.warn?.(`darwin: ${err?.message ?? err}`);
			return out;
		}
	});
}
