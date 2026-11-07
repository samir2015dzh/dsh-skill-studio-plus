// Q-3 测试：伪 HOME fixture 断言聚合逐项吻合（含「字段缺失 → 指标报不可得」用例），并验证工具只读。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-quality-"));
const NOW = 1794016800000;

let fails = 0;
const ok = (cond, msg) => {
	if (cond) console.log("  ok   " + msg);
	else {
		console.log("  FAIL " + msg);
		fails += 1;
	}
};

const run = spawnSync(process.execPath, [path.join(here, "fixtures", "quality-home.mjs"), home, String(NOW)], {
	env: { ...process.env, USERPROFILE: home, HOME: home, DSH_AGENTS_HOME: "", DSH_SKILL_EXTRACTOR_CANDIDATES: "" },
	encoding: "utf8"
});
if (run.status !== 0) {
	console.error(run.stderr || run.stdout);
	rmSync(home, { recursive: true, force: true });
	process.exit(1);
}
const { full, partial, before1, after1, before2, after2 } = JSON.parse(run.stdout);

// ---- 1. 漏斗：全量按名字最新裁决计数 ----
ok(full.funnel.available === true, "provenance 存在时漏斗可用");
ok(full.funnel.all.save === 2 && full.funnel.all.fold === 1 && full.funnel.all.drop === 1, `全量 SAVE/FOLD/DROP = 2/1/1（实际 ${full.funnel.all.save}/${full.funnel.all.fold}/${full.funnel.all.drop}）`);
ok(full.funnel.all.total === 4 && full.funnel.all.other === 0, "全量文件 4 条，无未识别 action");

// ---- 2. 窗口：最近 30 天（beta 在 40 天前，被排除） ----
ok(full.funnel.window.days === 30, "窗口口径 = 最近 30 天");
ok(full.funnel.window.total === 3 && full.funnel.window.save === 1 && full.funnel.window.fold === 1 && full.funnel.window.drop === 1, `窗口内 3 条：SAVE 1 / FOLD 1 / DROP 1（实际 ${full.funnel.window.total}/${full.funnel.window.save}/${full.funnel.window.fold}/${full.funnel.window.drop}）`);

// ---- 3. cohort：SAVE 队列 ----
ok(full.cohort.n === 2, "cohort = 2（alpha、beta 两个 SAVE）");
ok(full.cohort.used.count === 1 && full.cohort.used.denominator === 2 && full.cohort.used.ratio === 0.5, `used 1/2 = 0.5（beta 缺 lastUsedAt 不计入，实际 ${full.cohort.used.count}/${full.cohort.used.denominator}）`);
ok(full.cohort.used.available === true, "lifecycle 存在时 used 可用（个别记录缺字段不算不可得）");
ok(full.cohort.active.count === 1 && full.cohort.active.denominator === 2 && full.cohort.active.ratio === 0.5, `active 1/2 = 0.5（只有 alpha 仍在 skill 根）`);
ok(full.cohort.archived.count === 1 && full.cohort.archived.denominator === 2 && full.cohort.archived.ratio === 0.5, `archived 1/2 = 0.5（beta 命中归档目录）`);

// ---- 4. 字段缺失 → 首次使用距入库不可得 ----
ok(full.cohort.medianDaysToFirstUse.available === false && full.cohort.medianDaysToFirstUse.value === null, "缺 firstUsedAt → 首次使用距入库中位数不可得");
ok(/firstUsedAt/.test(full.cohort.medianDaysToFirstUse.reason), "不可得带原因: " + full.cohort.medianDaysToFirstUse.reason);
ok(full.unavailable.some((u) => u.metric === "首次使用距入库中位数"), "不可得项进入 unavailable 清单");

// ---- 5. 候选积压：pending 3 条（accepted 被过滤），最老 2 天 ----
ok(full.backlog.available === true && full.backlog.pending === 3, `pending 3 条（1 条 accepted 被过滤，实际 ${full.backlog.pending}）`);
ok(full.backlog.oldestWaitDays === 2, `最老一条等待 2 天（缺 created 的条目不参与，实际 ${full.backlog.oldestWaitDays}）`);

// ---- 6. 摘要 ----
ok(typeof full.summary === "string" && full.summary.includes("漏斗") && full.summary.includes("cohort") && full.summary.includes("积压"), "一行摘要含漏斗 / cohort / 积压: " + full.summary);

// ---- 7. 文件整体缺失 → 指标报不可得 ----
ok(partial.funnel.available === false && /provenance/.test(partial.funnel.reason), "provenance 目录缺失 → 漏斗不可得");
ok(partial.cohort.n === 0, "provenance 缺失 → cohort 为 0");
ok(partial.cohort.used.available === false && /skill-lifecycle\.json/.test(partial.cohort.used.reason), "lifecycle 文件缺失 → used 不可得: " + partial.cohort.used.reason);
ok(partial.cohort.used.ratio === null, "不可得的比例是 null 而不是 0");
ok(partial.backlog.pending === 3, "candidates 仍在 → 积压照常可算");

// ---- 8. 只读：收集前后文件内容哈希完全一致 ----
ok(JSON.stringify(before1) === JSON.stringify(after1), "第一次聚合未改动伪 HOME 中任何文件");
ok(JSON.stringify(before2) === JSON.stringify(after2), "第二次聚合未改动伪 HOME 中任何文件");

// ---- 9. M-5：同一 skill 连续 SAVE→FOLD，按名文件留最终裁决、事件流水可按事件计数 ----
const historyHome = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-quality-history-"));
const historyRun = spawnSync(process.execPath, [path.join(here, "fixtures", "quality-history-home.mjs"), historyHome, String(NOW)], {
	env: { ...process.env, USERPROFILE: historyHome, HOME: historyHome, DSH_AGENTS_HOME: "", DSH_SKILL_EXTRACTOR_CANDIDATES: "" },
	encoding: "utf8"
});
if (historyRun.status !== 0) {
	console.error(historyRun.stderr || historyRun.stdout);
	rmSync(historyHome, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
	process.exit(1);
}
const history = JSON.parse(historyRun.stdout);
ok(history.byName.action === "FOLD_INTO" && history.byName.into === "host-skill", "按名文件保留最终裁决（FOLD_INTO → host-skill）");
ok(history.byName.rationale === "第二次裁决：FOLD", "按名文件保留最终那次裁决的理由");
ok(history.mergeMeEvents === 2, "同一 skill 的两次裁决都进了事件流水（实际 " + history.mergeMeEvents + " 条）");
ok(
	history.events.every((e) => ["at", "name", "action", "rationale"].every((key) => key in e)),
	"事件流水字段齐全：at/name/action/rationale"
);
ok(history.withEvents.funnel.source === "events", "有事件流水时漏斗按事件计数");
ok(
	history.withEvents.funnel.all.total === 3 && history.withEvents.funnel.all.save === 2 && history.withEvents.funnel.all.fold === 1,
	`按事件计 3 条：SAVE 2 / FOLD 1（实际 ${history.withEvents.funnel.all.total}/${history.withEvents.funnel.all.save}/${history.withEvents.funnel.all.fold}）`
);
ok(/按事件计数/.test(history.withEvents.funnel.all.note), "口径注脚写明按事件计数: " + history.withEvents.funnel.all.note);
ok(
	history.withoutEvents.funnel.source === "by-name" && history.withoutEvents.funnel.all.total === 2,
	`无流水时回退按名最新裁决（2 条文件，实际 ${history.withoutEvents.funnel.all.total}）`
);
ok(/按名字最新裁决/.test(history.withoutEvents.funnel.all.note), "回退口径的注脚保持原口径");
rmSync(historyHome, { recursive: true, force: true });

rmSync(home, { recursive: true, force: true });
console.log(fails === 0 ? "\n=== ALL PASS" : `\n=== ${fails} FAILED`);
process.exitCode = fails ? 1 : 0;
