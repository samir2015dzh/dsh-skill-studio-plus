// 数据地基 fixture（M-5 / M-6 / M-7）：在同一份伪 HOME 里
//   M-5  同一 skill 连续两次裁决（SAVE → FOLD_INTO）→ 按名文件留最终裁决 + 事件流水 2 行
//   M-6  走真实的接受/拒绝工具 → 主表清空、归档 2 条（带 decidedAt/decision）、quality 报历史 1/1
//   M-7  对同一 skill 标 3 次使用 → firstUsedAt 不变、useCount=3、中位数与平均次数可算
// 用法：node tests/fixtures/quality-history-home.mjs <fakeHome> <fixedNowMs>
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const home = process.argv[2];
const now = Number(process.argv[3]);
const DAY = 86_400_000;
const pluginRoot = path.resolve(import.meta.dirname, "..", "..");
const { writeProvenance, provenanceDir, provenanceEventsFile, saveCandidates, loadCandidates, loadCandidateArchive, archiveCandidates, CANDIDATE_ARCHIVE_LIMIT } =
	await import(pathToFileURL(path.join(pluginRoot, "lib", "extractor.js")).href);
const { collectQualityMetrics } = await import(pathToFileURL(path.join(pluginRoot, "lib", "quality.js")).href);
const studio = await import(pathToFileURL(path.join(pluginRoot, "lib", "index.js")).href);

// ---- M-5：同一 skill 两次裁决：先 SAVE 入库，后 FOLD_INTO 并进 host-skill
await writeProvenance({ name: "merge-me", action: "SAVE", at: now - 10 * DAY, rationale: "第一次裁决：SAVE" });
await writeProvenance({ name: "merge-me", action: "FOLD_INTO", into: "host-skill", at: now - 2 * DAY, rationale: "第二次裁决：FOLD" });
// 只 SAVE 一次的名字，给 cohort / 中位数用
await writeProvenance({ name: "kept-save", action: "SAVE", at: now - 8 * DAY, rationale: "入库" });

const byName = JSON.parse(readFileSync(path.join(provenanceDir(), "merge-me.json"), "utf8"));
const eventLines = readFileSync(provenanceEventsFile(), "utf8").split(/\r?\n/).filter((line) => line.trim() !== "");
const events = eventLines.map((line) => JSON.parse(line));

// ---- M-6：走一遍真实工具层的接受 + 拒绝
const tools = new Map();
studio.apply(
	{
		skills: { list: async () => [], get: async () => undefined },
		tools: { register: (t) => { tools.set(t.name, t); return () => {}; } },
		webServer: { register: () => () => {} },
		systemPrompt: { section: () => () => {} },
		effect: (fn) => { const d = fn(); return () => (typeof d === "function" ? d() : undefined); },
		get: () => null,
		logger: { info: () => {} },
		interval: () => () => {},
		on: () => () => {}
	},
	{}
);
await saveCandidates([
	{ id: "hist-a", status: "pending", created: now - DAY, name: "accepted-cand", description: "接受演示", rationale: "r-a", body: "正文" },
	{ id: "hist-r", status: "pending", created: now - DAY, name: "rejected-cand", description: "拒绝演示", rationale: "r-r", body: "正文" }
]);
const acceptResult = await tools.get("skillmgr_extract_accept").execute({ ids: ["hist-a"] });
const rejectResult = await tools.get("skillmgr_extract_reject").execute({ ids: ["hist-r"] });
const queueAfter = await loadCandidates();
const archive = await loadCandidateArchive();

// ---- M-7：先塞一条老格式 lifecycle 记录（没有 firstUsedAt / useCount），再对同一 skill 标 3 次使用
const { markSkillUsed, loadState, saveState } = await import(pathToFileURL(path.join(pluginRoot, "lib", "lifecycle.js")).href);
await saveState({ legacy: { lastUsedAt: now - 20 * DAY, status: "active", lastCheckAt: now - 20 * DAY } });
await markSkillUsed("kept-save", now - 5 * DAY);
const lifecycleAfterFirst = (await loadState())["kept-save"];
await markSkillUsed("kept-save", now - 3 * DAY);
await markSkillUsed("kept-save", now - 1 * DAY);
const lifecycle = (await loadState())["kept-save"];
const legacy = (await loadState()).legacy;

// ---- 聚合（事件流水在的时候）
const withEvents = await collectQualityMetrics({ now });

// ---- F-2：注册层 output schema 校验。宿主跑完工具就是这个口径：schema 里没声明的顶层键
// 会被整包打回（INVALID_TOOL_OUTPUT），所以这里直接拿注册表里的工具定义跑 handler，
// 再交给宿主同一份校验器。直调 lib 层（上面那些 collectQualityMetrics）过不了这一关。
const qualityTool = tools.get("skillmgr_quality");
const qualityValue = await qualityTool.execute({});
const { validateJsonSchemaValue } = await import("@deepseek-ai/dsh-tools").catch(() => ({}));
const schemaViolations =
	typeof validateJsonSchemaValue === "function"
		? validateJsonSchemaValue(qualityTool.output.schema, qualityValue, "value")
		: Object.keys(qualityValue)
				.filter((key) => !Object.hasOwn(qualityTool.output.schema.properties ?? {}, key))
				.map((key) => `"value.${key}" is not a declared property (additionalProperties: false)`);
const qualitySchema = {
	checker: typeof validateJsonSchemaValue === "function" ? "host:validateJsonSchemaValue" : "local:declared-keys",
	schemaKeys: Object.keys(qualityTool.output.schema.properties ?? {}).sort(),
	valueKeys: Object.keys(qualityValue).sort(),
	violations: schemaViolations,
	history: qualityValue.history,
	summary: qualityValue.summary
};
const toolShape = [...tools.values()].map((t) => ({
	name: t.name,
	hasSchema: typeof t.output?.schema === "object",
	schemaKeys: Object.keys(t.output?.schema?.properties ?? {}).length,
	strict: t.output?.schema?.additionalProperties === false
}));

// 只读工具能安全跑完，就一并过同一个校验器；会写盘 / 联网 / 动 MCP 的留源码核对。
const READONLY = ["skillmgr_list", "skillmgr_get", "skillmgr_trash_list", "skillmgr_snapshot_list", "skillmgr_pull_pending", "skillmgr_extract_status", "skillmgr_extract_list"];
const liveChecks = [];
for (const name of READONLY) {
	const tool = tools.get(name);
	try {
		const value = await tool.execute(name === "skillmgr_get" ? { name: "no-such-skill" } : {});
		const violations = typeof validateJsonSchemaValue === "function" ? validateJsonSchemaValue(tool.output.schema, value, "value") : [];
		liveChecks.push({ name, keys: Object.keys(value).length, violations: violations.slice(0, 5) });
	} catch (error) {
		liveChecks.push({ name, error: String(error?.message ?? error) });
	}
}

// 对照：去掉事件流水，回退「按名最新裁决」
const rawEvents = readFileSync(provenanceEventsFile(), "utf8");
rmSync(provenanceEventsFile());
const withoutEvents = await collectQualityMetrics({ now });
writeFileSync(provenanceEventsFile(), rawEvents, "utf8");

// ---- 滚动上限：再塞满一档，最旧的两条必须被丢掉
const fillers = Array.from({ length: CANDIDATE_ARCHIVE_LIMIT }, (_, i) => ({ id: "fill-" + i, name: "fill-" + i, status: "pending", body: "" }));
const capResult = await archiveCandidates(fillers, { decision: "rejected" });
const archiveAfterCap = await loadCandidateArchive();


process.stdout.write(
	JSON.stringify({
		byName,
		events,
		eventLines: eventLines.length,
		mergeMeEvents: events.filter((e) => e.name === "merge-me").length,
		withEvents,
		withoutEvents,
		acceptResult,
		rejectResult,
		queueAfter,
		archive,
		now,
		lifecycleAfterFirst,
		lifecycle,
		legacy,
		capResult,
		cap: CANDIDATE_ARCHIVE_LIMIT,
		archiveAfterCap: { length: archiveAfterCap.length, first: archiveAfterCap[0]?.name, last: archiveAfterCap[archiveAfterCap.length - 1]?.name },
		qualitySchema,
		toolShape,
		liveChecks
	})
);
