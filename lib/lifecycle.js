/**
 * skill 生命周期：active → stale → archived，永不硬删（WO-BORROW-1）。
 *
 * 设计借用 hermes-agent（MIT）的 curator 分层 staleness 与 pinned 豁免。
 * 只借设计，未移植其代码（仓库不在本机，未取到源码）。
 *
 * 归档目录沿用既有墓碑机制：`~/.dsh/skill-archive-<stamp>/<name>/`。
 * extractor.archivedNames() 会把这类目录里的名字当成「以前合并过」的墓碑，
 * 所以归档后的名字不会被自动提取复活，也不需要额外记一份。
 */
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * 只读 skill 根下的 name / path / protected。
 * 不复用 extractor.buildSkillIndex：那会让 extractor 与 lifecycle 互相 import。
 */
async function listSkills(dir) {
	const out = [];
	if (typeof dir !== "string" || dir === "") return out;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const file = e.isDirectory() ? join(dir, e.name, "SKILL.md") : e.name.endsWith(".md") ? join(dir, e.name) : null;
		if (file === null) continue;
		let text;
		try {
			text = await readFile(file, "utf8");
		} catch {
			continue;
		}
		if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
		const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
		const name = (block.match(/^name:\s*(.+)$/m)?.[1] ?? e.name.replace(/\.md$/, "")).trim().replace(/^["']|["']$/g, "");
		const protectedSkill = /^\s*protected:\s*true\s*$/m.test(block) || (e.isDirectory() && await exists(join(dir, e.name, ".no-merge")));
		out.push({ name, path: file, protected: protectedSkill });
	}
	return out;
}

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** 默认：90 天没用标 stale，180 天没用归档。0 或负数 = 关闭该档。 */
export const DEFAULT_STALE_DAYS = 90;
export const DEFAULT_ARCHIVE_DAYS = 180;

/** 生命周期状态文件（与 candidates.json 同目录）。 */
export function lifecyclePath() {
	return resolve(homedir(), ".dsh", "dsh-studio", "skill-lifecycle.json");
}

/** 归档根：每次巡检一个目录，名字以 `skill-archive` 开头才被 archivedNames() 认。 */
export function archiveRoot(now = Date.now()) {
	return resolve(homedir(), ".dsh", `skill-archive-${stamp(now)}`);
}

function stamp(now) {
	const d = new Date(now);
	const p = (n, w = 2) => String(n).padStart(w, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

export async function loadState() {
	try {
		const parsed = JSON.parse(await readFile(lifecyclePath(), "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export async function saveState(state) {
	await mkdir(dirname(lifecyclePath()), { recursive: true });
	// tmp + rename：写一半崩掉不会留下坏 JSON
	const tmp = lifecyclePath() + ".tmp";
	await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
	await rename(tmp, lifecyclePath());
	return state;
}

/**
 * 记一次「用过」：自动提取落库、面板保存、darwin 回收结果时都算。
 * M-7：firstUsedAt 只在第一次写入（之后不覆盖），useCount 每次 +1；lastUsedAt 语义不变。
 */
export async function markSkillUsed(name, now = Date.now()) {
	if (typeof name !== "string" || name === "") return;
	const state = await loadState();
	const prev = state[name] ?? {};
	const firstUsedAt = Number.isFinite(prev.firstUsedAt) ? prev.firstUsedAt : now;
	const useCount = (Number.isFinite(prev.useCount) ? prev.useCount : 0) + 1;
	state[name] = { ...prev, firstUsedAt, useCount, lastUsedAt: now, status: "active", lastCheckAt: now };
	await saveState(state);
}

/**
 * 纯判定：按「距上次使用多少天」给出应处的档位。
 * 归档优先于 stale；阈值 <= 0 表示该档关闭。
 */
export function classifySkill({ ageDays, staleAfterDays = DEFAULT_STALE_DAYS, archiveAfterDays = DEFAULT_ARCHIVE_DAYS }) {
	if (!Number.isFinite(ageDays)) return "active";
	if (archiveAfterDays > 0 && ageDays >= archiveAfterDays) return "archive";
	if (staleAfterDays > 0 && ageDays >= staleAfterDays) return "stale";
	return "active";
}

async function mtimeOf(path) {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return Date.now();
	}
}

/**
 * 跑一轮巡检。
 * @param {object} cfg 提取配置（用 agentSkillDir / staleAfterDays / archiveAfterDays）
 * @param {{now?:number, apply?:boolean}} options apply=false 时只报告、不动文件
 * @returns {{stale:object[], archived:object[], skipped:object[]}}
 */
export async function scanLifecycle(cfg, { now = Date.now(), apply = true } = {}) {
	const dir = cfg?.agentSkillDir;
	const staleAfterDays = Number.isFinite(cfg?.staleAfterDays) ? cfg.staleAfterDays : DEFAULT_STALE_DAYS;
	const archiveAfterDays = Number.isFinite(cfg?.archiveAfterDays) ? cfg.archiveAfterDays : DEFAULT_ARCHIVE_DAYS;
	const index = await listSkills(dir);
	const state = (await loadState()) ?? {};
	const stale = [];
	const archived = [];
	const skipped = [];
	let root = null;
	for (const skill of index) {
		// pinned 豁免：protected（frontmatter）或 .no-merge 标记，视为人工维护
		if (skill.protected === true) {
			skipped.push({ name: skill.name, reason: "pinned" });
			continue;
		}
		const recorded = state[skill.name]?.lastUsedAt;
		const lastUsed = Number.isFinite(recorded) ? recorded : await mtimeOf(skill.path);
		const ageDays = (now - lastUsed) / 86_400_000;
		const verdict = classifySkill({ ageDays, staleAfterDays, archiveAfterDays });
		if (verdict === "active") continue;
		if (verdict === "stale") {
			stale.push({ name: skill.name, ageDays: Math.round(ageDays) });
			if (apply) state[skill.name] = { ...(state[skill.name] ?? {}), lastUsedAt: lastUsed, status: "stale", lastCheckAt: now };
			continue;
		}
		// archive：只归档目录版（单文件 skill 没有自己的目录，搬走会把整个 skill 根带走）
		const home = dirname(skill.path);
		if (dirname(home) === resolve(dir)) {
			if (apply) {
				if (root === null) root = archiveRoot(now);
				const to = join(root, skill.name);
				await mkdir(root, { recursive: true });
				await cp(home, to, { recursive: true });
				await rm(home, { recursive: true, force: true });
				state[skill.name] = { ...(state[skill.name] ?? {}), lastUsedAt: lastUsed, status: "archived", lastCheckAt: now };
				archived.push({ name: skill.name, path: to });
			} else {
				archived.push({ name: skill.name, path: null });
			}
			continue;
		}
		skipped.push({ name: skill.name, reason: "single-file" });
	}
	if (apply && (stale.length > 0 || archived.length > 0)) await saveState(state);
	return { stale, archived, skipped };
}

/** 归档目录里的条目（供面板列「已归档」）。 */
export async function listArchived() {
	const base = resolve(homedir(), ".dsh");
	const out = [];
	let entries;
	try {
		entries = await readdir(base, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (!e.isDirectory() || !e.name.startsWith("skill-archive")) continue;
		let names = [];
		try {
			names = await readdir(join(base, e.name));
		} catch {
			continue;
		}
		for (const name of names) out.push({ name, batch: e.name, path: join(base, e.name, name) });
	}
	return out;
}
