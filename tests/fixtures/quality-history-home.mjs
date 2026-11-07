// M-5 fixture：同一 skill 连续两次裁决（SAVE → FOLD_INTO）。
// 给出四份可断言素材：按名文件（最终裁决）、事件流水行数、有流水时的漏斗计数、
// 去掉流水后回退「按名最新裁决」的漏斗计数（口径切换的对照）。
// 用法：node tests/fixtures/quality-history-home.mjs <fakeHome> <fixedNowMs>
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const home = process.argv[2];
const now = Number(process.argv[3]);
const DAY = 86_400_000;
const pluginRoot = path.resolve(import.meta.dirname, "..", "..");
const { writeProvenance, provenanceDir, provenanceEventsFile } = await import(
	pathToFileURL(path.join(pluginRoot, "lib", "extractor.js")).href
);
const { collectQualityMetrics } = await import(pathToFileURL(path.join(pluginRoot, "lib", "quality.js")).href);

// 同一 skill 两次裁决：先 SAVE 入库，后 FOLD_INTO 并进 host-skill
await writeProvenance({ name: "merge-me", action: "SAVE", at: now - 10 * DAY, rationale: "第一次裁决：SAVE" });
await writeProvenance({ name: "merge-me", action: "FOLD_INTO", into: "host-skill", at: now - 2 * DAY, rationale: "第二次裁决：FOLD" });
// 只 SAVE 一次的名字，给 cohort / 中位数用
await writeProvenance({ name: "kept-save", action: "SAVE", at: now - 8 * DAY, rationale: "入库" });

const byName = JSON.parse(readFileSync(path.join(provenanceDir(), "merge-me.json"), "utf8"));
const eventLines = readFileSync(provenanceEventsFile(), "utf8").split(/\r?\n/).filter((line) => line.trim() !== "");
const events = eventLines.map((line) => JSON.parse(line));

const withEvents = await collectQualityMetrics({ now });

// 对照：去掉事件流水，回退「按名最新裁决」
const rawEvents = readFileSync(provenanceEventsFile(), "utf8");
rmSync(provenanceEventsFile());
const withoutEvents = await collectQualityMetrics({ now });
writeFileSync(provenanceEventsFile(), rawEvents, "utf8");

process.stdout.write(
	JSON.stringify({
		byName,
		events,
		eventLines: eventLines.length,
		mergeMeEvents: events.filter((e) => e.name === "merge-me").length,
		withEvents,
		withoutEvents
	})
);
