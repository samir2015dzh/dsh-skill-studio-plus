/**
 * 提取质量度量（Q-2）：只读聚合 provenance / candidates / lifecycle。
 *
 * 三份数据只有 skill 名字一个公共键（见 QUALITY-METRICS.md 的 Q-1 审计），所以全部按
 * normalizeName 归一后的名字 join；join 不上或字段缺失的指标返回 available:false + reason，
 * 不用估算补数。本模块只读，不写任何文件。
 */
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CANDIDATE_ARCHIVE_LIMIT, archivedNames, candidateArchiveFile, candidateFile, defaultAgentSkillDir, existingSkillNames, loadCandidateArchive, loadCandidates, normalizeName, provenanceDir, provenanceEventsFile } from "./extractor.js";
import { lifecyclePath, loadState as loadLifecycleState } from "./lifecycle.js";

/** 窗口：按 provenance.at 的最近 30 天（Q-1 审计裁定的唯一可恢复口径）。 */
export const WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

function ratio(count, denominator, { available = denominator > 0, reason = "" } = {}) {
	const ok = available && denominator > 0;
	return {
		count,
		denominator,
		ratio: ok ? Math.round((count / denominator) * 1000) / 1000 : null,
		available: ok,
		reason: ok ? "" : reason || "分母为 0（无样本），比例不可得"
	};
}

function median(nums) {
	const s = [...nums].sort((a, b) => a - b);
	const mid = s >> 1;
	return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 读全部 provenance 文件；目录不存在时如实报缺失，不返回空集冒充「没发生过」。 */
async function readProvenance() {
	const dir = provenanceDir();
	if (!existsSync(dir)) return { available: false, reason: "provenance 目录不存在：" + dir, records: [], skipped: 0 };
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		return { available: false, reason: "provenance 目录读不到：" + String(error), records: [], skipped: 0 };
	}
	const records = [];
	let skipped = 0;
	for (const e of entries) {
		if (!e.isFile() || !e.name.endsWith(".json")) continue;
		try {
			const r = JSON.parse(await readFile(join(dir, e.name), "utf8"));
			if (!r || typeof r.name !== "string" || r.name === "") throw new Error("no name");
			records.push({
				name: normalizeName(r.name),
				at: typeof r.at === "string" ? r.at : "",
				action: String(r.action ?? "").toUpperCase(),
				into: typeof r.into === "string" ? normalizeName(r.into) : null,
				rationale: typeof r.rationale === "string" ? r.rationale : ""
			});
		} catch {
			skipped += 1;
		}
	}
	return { available: true, reason: "", records, skipped };
}

function funnelOf(records) {
	const out = { save: 0, fold: 0, drop: 0, total: records.length };
	for (const r of records) {
		if (r.action === "SAVE") out.save += 1;
		else if (r.action === "FOLD_INTO") out.fold += 1;
		else if (r.action === "TOMBSTONE" || r.action === "DROP") out.drop += 1;
	}
	out.other = out.total - out.save - out.fold - out.drop;
	return out;
}

/**
 * 读 append-only 裁决事件流水（M-5）。有这份文件就能按事件计数、历史可复盘；
 * 没有（旧数据）返回 available:false，调用方回退「按名最新裁决」口径。
 */
async function readProvenanceEvents() {
	const file = provenanceEventsFile();
	if (!existsSync(file)) return { available: false, reason: "事件日志不存在：" + file, records: [], skipped: 0 };
	let text;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		return { available: false, reason: "事件日志读不到：" + String(error), records: [], skipped: 0 };
	}
	const records = [];
	let skipped = 0;
	for (const line of text.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		try {
			const r = JSON.parse(line);
			if (!r || typeof r.name !== "string" || r.name === "") throw new Error("no name");
			records.push({
				name: normalizeName(r.name),
				at: typeof r.at === "string" ? r.at : "",
				action: String(r.action ?? "").toUpperCase(),
				into: typeof r.into === "string" ? normalizeName(r.into) : null,
				rationale: typeof r.rationale === "string" ? r.rationale : ""
			});
		} catch {
			skipped += 1;
		}
	}
	return { available: true, reason: "", records, skipped };
}

/**
 * 聚合一次，返回结构化指标 + 一行摘要。
 * @param {{now?:number, windowDays?:number, skillRoots?:string[]}} options
 */
export async function collectQualityMetrics({ now = Date.now(), windowDays = WINDOW_DAYS, skillRoots = null } = {}) {
	const roots = (Array.isArray(skillRoots) ? skillRoots : []).filter((d) => typeof d === "string" && d !== "");
	const skillsRoots = roots.length > 0 ? roots : [defaultAgentSkillDir()];

	// (a) 漏斗：有 append-only 事件流水时按事件计数（M-5，历史裁决可复盘），否则回退按名最新裁决
	const prov = await readProvenance();
	const events = await readProvenanceEvents();
	const counted = events.available ? events : prov;
	const all = funnelOf(counted.records);
	const since = now - windowDays * DAY_MS;
	const window = funnelOf(counted.records.filter((r) => {
		const t = Date.parse(r.at);
		return Number.isFinite(t) && t >= since;
	}));

	// (b) 质量信号：SAVE 队列
	const cohortNames = prov.records.filter((r) => r.action === "SAVE").map((r) => r.name);
	const lcFile = lifecyclePath();
	const lcAvailable = existsSync(lcFile);
	const lc = lcAvailable ? await loadLifecycleState() : {};
	const inLibrary = new Set();
	for (const dir of skillsRoots) for (const n of await existingSkillNames(dir)) inLibrary.add(normalizeName(n));
	const tombstones = new Set([...(await archivedNames())].map((n) => normalizeName(n)));

	const used = cohortNames.filter((n) => Number.isFinite(lc[n]?.lastUsedAt));
	const active = cohortNames.filter((n) => inLibrary.has(n) && lc[n]?.status !== "archived");
	const archived = cohortNames.filter((n) => tombstones.has(n) || lc[n]?.status === "archived");

	// 首次使用距入库：入库时间取「最早一次 SAVE」的 at（事件流水优先，回退按名文件）
	const firstSaveAt = new Map();
	for (const r of counted.records) {
		if (r.action !== "SAVE") continue;
		const t = Date.parse(r.at);
		if (!Number.isFinite(t)) continue;
		const prev = firstSaveAt.get(r.name);
		if (prev === undefined || t < prev) firstSaveAt.set(r.name, t);
	}
	const firstUseDays = [];
	for (const [name, t0] of firstSaveAt) {
		const t1 = lc[name]?.firstUsedAt;
		if (Number.isFinite(t1) && t1 >= t0) firstUseDays.push((t1 - t0) / DAY_MS);
	}
	const medianDaysToFirstUse = firstUseDays.length > 0
		? { available: true, value: Math.round(median(firstUseDays) * 100) / 100, samples: firstUseDays.length, reason: "" }
		: { available: false, value: null, samples: 0, reason: "lifecycle 没有 firstUsedAt（只有 lastUsedAt），首次使用距入库不可得" };

	// (c) 候选积压
	const candFile = candidateFile();
	const candAvailable = existsSync(candFile);
	const queue = candAvailable ? await loadCandidates() : [];
	const pending = queue.filter((c) => c && c.status === "pending" && typeof c.name === "string");
	const created = pending.map((c) => c.created).filter((t) => Number.isFinite(t));
	const oldest = created.length > 0 ? Math.min(...created) : null;

	const funnel = {
		available: events.available || prov.available,
		reason: events.available || prov.available ? "" : prov.reason,
		source: events.available ? "events" : "by-name",
		eventsFile: provenanceEventsFile(),
		eventsSkipped: events.skipped ?? 0,
		skippedFiles: prov.skipped ?? 0,
		all: {
			...all,
			note: events.available
				? "按事件计数（provenance-events.jsonl 每行一条裁决，历史可复盘）"
				: "按名字最新裁决计数（同名文件被覆盖写，历史裁决不可恢复）"
		},
		window: { days: windowDays, since: new Date(since).toISOString(), ...window }
	};
	const usedRatio = lcAvailable
		? ratio(used.length, cohortNames.length)
		: ratio(used.length, cohortNames.length, { available: false, reason: "skill-lifecycle.json 不存在，使用追踪不可得：" + lcFile });
	const cohort = {
		n: cohortNames.length,
		used: usedRatio,
		active: ratio(active.length, cohortNames.length),
		archived: ratio(archived.length, cohortNames.length),
		medianDaysToFirstUse
	};
	const backlog = {
		available: candAvailable,
		reason: candAvailable ? "" : "candidates.json 不存在：" + candFile,
		pending: pending.length,
		oldestCreatedAt: oldest === null ? null : new Date(oldest).toISOString(),
		oldestWaitDays: oldest === null ? null : Math.round(((now - oldest) / DAY_MS) * 100) / 100
	};

	// (d) 历史接受/拒绝（M-6）：来自 candidates-archive.json，保留条数受滚动上限约束
	const archiveFile = candidateArchiveFile();
	const archiveAvailable = existsSync(archiveFile);
	const archive = archiveAvailable ? await loadCandidateArchive() : [];
	const history = {
		available: archiveAvailable,
		reason: archiveAvailable ? "" : "candidates-archive.json 不存在：" + archiveFile,
		accepted: archive.filter((e) => e?.decision === "accepted").length,
		rejected: archive.filter((e) => e?.decision === "rejected").length,
		total: archive.length,
		cap: CANDIDATE_ARCHIVE_LIMIT,
		atCap: archiveAvailable && archive.length >= CANDIDATE_ARCHIVE_LIMIT
	};

	const show = (r) => (r.available ? `${r.count}/${r.denominator}` : "不可得");
	const summary = [
		`漏斗 SAVE/FOLD/DROP ${funnel.available ? `${all.save}/${all.fold}/${all.drop}` : "不可得"}（全量 ${all.total} 条${events.available ? "事件" : "文件"}；近 ${windowDays} 天 ${window.total} 条）`,
		`cohort ${cohort.n}：used ${show(cohort.used)}、active ${show(cohort.active)}、归档 ${show(cohort.archived)}`,
		`积压 ${backlog.available ? `${backlog.pending} 条，最老 ${backlog.oldestWaitDays} 天` : "不可得"}`,
		`历史 接受/拒绝 ${history.available ? `${history.accepted}/${history.rejected}` : "不可得"}（归档上限 ${history.cap} 条${history.atCap ? "，已到上限、最旧已丢弃" : ""}）`
	].join("｜");

	const unavailable = [
		...(funnel.available ? [] : [{ metric: "提取漏斗", reason: funnel.reason }]),
		...(cohort.used.available ? [] : [{ metric: "cohort 使用比例", reason: cohort.used.reason }]),
		...(cohort.medianDaysToFirstUse.available ? [] : [{ metric: "首次使用距入库中位数", reason: cohort.medianDaysToFirstUse.reason }]),
		...(backlog.available ? [] : [{ metric: "候选积压", reason: backlog.reason }]),
		...(history.available ? [] : [{ metric: "历史接受/拒绝", reason: history.reason }])
	];

	return {
		summary,
		funnel,
		cohort,
		backlog,
		history,
		unavailable,
		sources: {
			provenanceDir: provenanceDir(),
			provenanceEventsPath: provenanceEventsFile(),
			candidatesPath: candFile,
			candidateArchivePath: archiveFile,
			lifecyclePath: lcFile,
			skillRoots: skillsRoots,
			windowDays
		}
	};
}
