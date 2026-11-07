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

// ---- 10. M-6：接受/拒绝不再直接删，终局进归档；quality 报历史接受/拒绝 ----
ok(history.queueAfter.length === 0, `接受+拒绝后候选主表干净（实际 ${history.queueAfter.length} 条）`);
ok(history.acceptResult?.ok === true && history.rejectResult?.ok === true, "接受与拒绝各走通一次（工具层）");
ok(history.archive.length === 2, `归档 2 条（实际 ${history.archive.length}）`);
const acceptedEntry = history.archive.find((e) => e.name === "accepted-cand");
const rejectedEntry = history.archive.find((e) => e.name === "rejected-cand");
ok(acceptedEntry?.decision === "accepted" && rejectedEntry?.decision === "rejected", "归档记录裁决结果 accepted / rejected");
ok(
	[acceptedEntry, rejectedEntry].every((e) => typeof e?.decidedAt === "string" && e.decidedAt !== "" && typeof e?.id === "string"),
	"归档记录带 decidedAt 与原始 id"
);
ok(history.withEvents.history.available === true && history.withEvents.history.accepted === 1 && history.withEvents.history.rejected === 1, `quality 报出历史接受/拒绝 1/1（实际 ${history.withEvents.history.accepted}/${history.withEvents.history.rejected}）`);
ok(/历史 接受\/拒绝 1\/1/.test(history.withEvents.summary), "一行摘要含历史接受/拒绝: " + history.withEvents.summary);
ok(history.withEvents.history.cap === 500 && /归档上限 500 条/.test(history.withEvents.summary), "摘要注明归档上限 500 条");
ok(history.capResult.dropped === 2 && history.capResult.total === 500, `超过上限丢弃最旧 2 条（dropped=${history.capResult.dropped}, total=${history.capResult.total}）`);
ok(history.archiveAfterCap.length === 500 && history.archiveAfterCap.first === "fill-0", "归档只留最近 500 条，最旧的是新批次第一条");

// ---- 11. M-7：firstUsedAt 只写一次、useCount 每次 +1；中位数与平均使用次数解锁 ----
const DAY_MS = 86_400_000;
ok(history.lifecycle.useCount === 3, `同一 skill 标 3 次使用 → useCount=3（实际 ${history.lifecycle.useCount}）`);
ok(
	history.lifecycle.firstUsedAt === history.lifecycleAfterFirst.firstUsedAt && history.lifecycle.firstUsedAt === NOW - 5 * DAY_MS,
	"firstUsedAt 停在第一次使用，不被后两次覆盖"
);
ok(history.lifecycle.lastUsedAt === NOW - DAY_MS, "lastUsedAt 语义不变：跟着最后一次使用走");
ok(history.lifecycleAfterFirst.useCount === 1, "第一次用完 useCount 就是 1");
ok(history.legacy?.lastUsedAt === NOW - 20 * DAY_MS && history.legacy.firstUsedAt === undefined, "老格式 lifecycle 条目读入不报错、字段不被改写");
ok(
	history.withEvents.cohort.medianDaysToFirstUse.available === true && history.withEvents.cohort.medianDaysToFirstUse.value === 3,
	`首次使用距入库中位数可算 = 3 天（实际 ${history.withEvents.cohort.medianDaysToFirstUse.value}）`
);
ok(
	history.withEvents.cohort.avgUseCount.available === true && history.withEvents.cohort.avgUseCount.value === 3,
	`平均使用次数可算 = 3（实际 ${history.withEvents.cohort.avgUseCount.value}）`
);
ok(/首次使用距入库 3 天/.test(history.withEvents.summary) && /均用 3 次/.test(history.withEvents.summary), "一行摘要带中位数与平均使用次数");
ok(
	full.cohort.avgUseCount.available === false && /useCount/.test(full.cohort.avgUseCount.reason),
	"老数据没有 useCount → 平均使用次数报不可得: " + full.cohort.avgUseCount.reason
);
ok(full.unavailable.some((u) => u.metric === "平均使用次数"), "不可得的平均使用次数进入 unavailable 清单");

// ---- 12. F-2：注册层 output schema 与 handler 返回体必须一致（宿主口径，不是 lib 层口径） ----
const qs = history.qualitySchema;
ok(qs.violations.length === 0, `skillmgr_quality 返回体通过宿主 output schema 校验（校验器 ${qs.checker}；违规 ${qs.violations.length} 条：${qs.violations.join("; ") || "无"}）`);
ok(qs.schemaKeys.includes("history"), "注册 schema 声明了 history 键");
ok(qs.valueKeys.includes("history"), "handler 实际返回 history 键（修 schema，不删字段）");
ok(
	qs.valueKeys.every((key) => qs.schemaKeys.includes(key)),
	`返回体每个顶层键都被声明（返回 ${qs.valueKeys.length} 个 / 声明 ${qs.schemaKeys.length} 个；未声明：${qs.valueKeys.filter((k) => !qs.schemaKeys.includes(k)).join(", ") || "无"}）`
);
ok(qs.history?.accepted === 1 && qs.history?.rejected === 1, `经注册层调用拿到的 history 仍是真实数据 1/1（实际 ${qs.history?.accepted}/${qs.history?.rejected}）`);
ok(history.toolShape.length === 27, `注册表里共 ${history.toolShape.length} 个工具（期望 27）`);
ok(history.toolShape.every((t) => t.hasSchema), `全部工具都声明了 output schema（缺声明的：${history.toolShape.filter((t) => !t.hasSchema).map((t) => t.name).join(", ") || "无"}）`);
const bad = history.liveChecks.filter((c) => c.error !== undefined || c.violations.length > 0);
ok(
	bad.length === 0,
	`只读工具实跑并通过注册层 schema 校验（${history.liveChecks.length} 个：${history.liveChecks.map((c) => c.name.replace("skillmgr_", "")).join(", ")}；异常：${bad.map((c) => c.name + "→" + (c.error ?? c.violations.join("; "))).join(" | ") || "无"}）`
);

rmSync(historyHome, { recursive: true, force: true });

rmSync(home, { recursive: true, force: true });
console.log(fails === 0 ? "\n=== ALL PASS" : `\n=== ${fails} FAILED`);
process.exitCode = fails ? 1 : 0;
