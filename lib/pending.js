/**
 * 消费恢复端待拉清单（PENDING_PULLS.json，PULL-2）。
 *
 * 口径：快照恢复（lib/snapshot.js 的 restoreSnapshot）只写清单、不联网；
 * 要不要真拉，由恢复端这个显式动作决定 —— 本模块就是那个动作。
 *
 * 逐条独立成败，单条失败只记状态与原因、不中断其余条目。四种结局：
 *   pulled     目标目录不存在 → 走既有 importSkill 拉取并写 lock
 *   satisfied  目标目录已存在且内容与源逐字节一致 → 跳过（必要时补 lock）
 *   conflict   已存在同名但内容不一致 → **绝不覆盖**，留给人处理
 *   failed     来源不可用（解析、下载、包内没有 SKILL.md）
 *
 * 清单写回只在所有条目处理完后做一次原子替换：中途崩溃时原清单原封不动，
 * 未完成条目不会丢（已成功的条目下次会因 satisfied 再被判一次，不会重复破坏）。
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PENDING_PULLS_FILE, externalSkillRoot } from "./snapshot.js";
import { importSkill, loadLock, lockRecordFor, resolveSkillPackage, saveLock } from "./skillsrc.js";

/** 待拉清单的默认位置：与 restore 的落点同一套规则（PULL-1）。 */
export async function pendingPullsPath(root) {
	return join(root ?? (await externalSkillRoot()), PENDING_PULLS_FILE);
}

/** 错误值转一行文字（与 lib/index.js 的 ErrorMsg 同口径，不跨层引用）。 */
const errText = (error) => (error instanceof Error ? error.message : String(error));

async function isDir(path) {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * 读清单。文件不存在或读不懂都按「没有待拉项」处理，不抛错（R-2a）。
 * @returns {Promise<{file:string, exists:boolean, note:string, at:string, pulls:Array<object>}>}
 */
export async function loadPendingPulls({ root } = {}) {
	const file = await pendingPullsPath(root);
	let parsed;
	try {
		parsed = JSON.parse(await readFile(file, "utf8"));
	} catch {
		return { file, exists: false, raw: {}, note: "", at: "", pulls: [] };
	}
	return {
		file,
		exists: true,
		raw: parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {},
		note: typeof parsed?.note === "string" ? parsed.note : "",
		at: typeof parsed?.at === "string" ? parsed.at : "",
		pulls: Array.isArray(parsed?.pulls) ? parsed.pulls : []
	};
}

/**
 * 清单条目 → parseSkillSource 认得的来源串。
 *
 * 清单里的 `source` 已是仓库根 URL（或本地 tarball 路径），子目录与 ref 各自结构化，
 * 所以 github 仓库要拼回 `<root>/tree/<ref>/<subdir>` 才能复用既有导入路径。
 * ref 为空而 sha 是 40 位 commit 时用 sha 钉版本（lock 来源的 sha 是 tar.gz 内容哈希，
 * 64 位，不能当 ref —— 见 PENDING-PULLS.md §4）。
 */
export function entrySource(entry) {
	const source = String(entry?.source ?? entry?.repo ?? "").trim();
	if (source === "") return "";
	const subdir = String(entry?.subdir ?? entry?.subPath ?? "")
		.trim()
		.replace(/^\/+|\/+$/g, "");
	// 本地 tarball、或已经带 tree 段的地址：原样交给 parseSkillSource
	if (!/^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+$/i.test(source)) return source;
	const ref = pickRef(entry);
	if (ref === "" && subdir === "") return source;
	return `${source}/tree/${encodeURIComponent(ref === "" ? "HEAD" : ref)}${subdir === "" ? "" : "/" + subdir}`;
}

function pickRef(entry) {
	const ref = typeof entry?.ref === "string" ? entry.ref.trim() : "";
	if (ref !== "") return ref;
	const sha = typeof entry?.sha === "string" ? entry.sha.trim() : "";
	return /^[0-9a-f]{40}$/i.test(sha) ? sha : "";
}

/** 目标目录里是否已经是这个包的内容（只比源里有的文件，多余文件不计）。 */
async function dirMatches(dest, files) {
	if (files.length === 0) return false;
	for (const file of files) {
		let current;
		try {
			current = await readFile(join(dest, file.rel));
		} catch {
			return false;
		}
		if (!current.equals(file.data)) return false;
	}
	return true;
}

/** satisfied 时把 lock 补齐（缺记录或记录不符），下次判定就不用再逐字节比。 */
async function relock(pkg, now) {
	const lock = await loadLock();
	const prev = lock[pkg.name];
	const sameLs = prev !== undefined && prev.sha256 === pkg.sha256 && String(prev.ref ?? "") === String(pkg.parsed.ref ?? "");
	if (sameLs) return false;
	lock[pkg.name] = lockRecordFor(pkg.parsed, { sha256: pkg.sha256, now });
	await saveLock(lock);
	return true;
}

/** 处理一条：先取包再判定，importSkill 只负责写盘与写锁。 */
async function pullOne(entry, { targetDir, now }) {
	const name = typeof entry?.name === "string" ? entry.name : "";
	const source = entrySource(entry);
	if (source === "") return { name, status: "failed", reason: "条目没有 source" };
	let pkg;
	try {
		pkg = await resolveSkillPackage(source);
	} catch (error) {
		return { name, status: "failed", reason: errText(error) };
	}
	const dest = join(resolve(targetDir), pkg.name);
	if (!(await isDir(dest))) {
		try {
			// force：锁里的记录可能来自快照恢复，而目标机这边确实没有内容 —— 不能因为锁说
			// 「同 ref 同内容」就跳过，否则恢复端会一直拿不到文件（PULL-3 实测踩到过）。
			const result = await importSkill({ source, targetDir, now, pkg, force: true });
			return { name: pkg.name, status: "pulled", sha256: pkg.sha256, files: result.files ?? 0, path: result.path ?? dest };
		} catch (error) {
			return { name: pkg.name, status: "failed", reason: errText(error) };
		}
	}
	if (await dirMatches(dest, pkg.found.files)) {
		return { name: pkg.name, status: "satisfied", sha256: pkg.sha256, relocked: await relock(pkg, now) };
	}
	const lock = await loadLock();
	const locked = lock[pkg.name]?.sha256;
	return {
		name: pkg.name,
		status: "conflict",
		reason:
			locked === undefined
				? "已存在同名 skill，lock 里没有它的记录，无法确认内容"
				: "已存在同名 skill，内容与 lock 记录的不一致",
		lockedSha256: typeof locked === "string" ? locked : "",
		incomingSha256: pkg.sha256,
		path: dest
	};
}

/**
 * 一键消费待拉清单（R-2）。
 * @param {{targetDir?:string, root?:string, now?:number}} options
 *   targetDir 是 skill 落点（extractor.json 的 agentSkillDir）；root 覆盖清单位置，只给测试用。
 * @returns {Promise<{ok:boolean, message:string, total:number, pulled:number, satisfied:number,
 *   conflict:number, failed:number, results:Array<object>, pendingFile:string, remaining:number}>}
 */
export async function pullPending({ targetDir, root, now = Date.now() } = {}) {
	const list = await loadPendingPulls({ root });
	const base = { pulled: 0, satisfied: 0, conflict: 0, failed: 0, results: [], pendingFile: list.file };
	if (list.pulls.length === 0) {
		return { ok: true, ...base, total: 0, remaining: 0, message: `无待拉项（${list.file}${list.exists ? " 没有条目" : " 不存在"}）` };
	}
	if (typeof targetDir !== "string" || targetDir === "") {
		return { ok: false, ...base, total: list.pulls.length, remaining: list.pulls.length, message: "没有可写的目标目录（agentSkillDir）" };
	}
	const results = [];
	for (const entry of list.pulls) {
		const result = await pullOne(entry, { targetDir, now });
		results.push({ ...result, entry });
	}
	const counts = { pulled: 0, satisfied: 0, conflict: 0, failed: 0 };
	for (const result of results) counts[result.status] += 1;
	// 成功与已满足的消项；失败与冲突留给下次重试
	const keep = results.filter((r) => r.status === "conflict" || r.status === "failed");
	await writeBack(list, keep);
	const summary = `共 ${results.length} 条：拉取 ${counts.pulled}、已满足 ${counts.satisfied}、冲突 ${counts.conflict}、失败 ${counts.failed}`;
	return {
		ok: true,
		...counts,
		total: results.length,
		remaining: keep.length,
		results: results.map(({ entry: _entry, ...rest }) => rest),
		pendingFile: list.file,
		message: keep.length === 0 ? `${summary}；清单已清空` : `${summary}；${keep.length} 条留在清单里待重试`
	};
}

/** 清单写回：还有条目就原子替换，清空就删文件（文件不存在 = 无待拉项）。 */
async function writeBack(list, keep) {
	if (!list.exists) return;
	if (keep.length === 0) {
		await rm(list.file, { force: true });
		return;
	}
	const payload = { ...list.raw, pulls: keep.map((r) => r.entry) };
	await mkdir(dirname(list.file), { recursive: true });
	const tmp = list.file + ".tmp";
	await writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
	await rename(tmp, list.file);
}
