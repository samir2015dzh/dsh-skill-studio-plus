// U-2 检查能力测试：伪 HOME 里三种上游来源（.git / lock / meta）各一例 + 一例不可达上游，
// 验证 structured 结果、强制双数字汇总，以及「失败不中断全量」。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-home-"));

let fails = 0;
const ok = (cond, msg) => {
	if (cond) console.log("  ok   " + msg);
	else {
		console.log("  FAIL " + msg);
		fails += 1;
	}
};

const run = spawnSync(process.execPath, [path.join(here, "fixtures", "update-check-home.mjs")], {
	env: { ...process.env, USERPROFILE: home, HOME: home },
	encoding: "utf8",
});
if (run.status !== 0) {
	console.error(run.stderr || run.stdout);
	rmSync(home, { recursive: true, force: true });
	process.exit(1);
}
const { result, upstreamShort, linked } = JSON.parse(run.stdout);
const byName = (name) => (result.skills ?? []).find((s) => s.name === name);

// ---- 汇总：强制双数字（已查 N / 全库 M，可判定 K）
ok(result.ok === true, "检查返回 ok");
ok(result.totals.total === 5, "全库 M = 5（同一 skill 挂两棵树只算一次）: " + result.totals.total + (linked ? "（junction 已建）" : "（junction 未建）"));
ok(result.totals.determinable === 4, "可判定 K = 4: " + result.totals.determinable);
ok(result.totals.checked === 4, "已查 N = 4: " + result.totals.checked);
ok(String(result.message).startsWith("已查 4 / 全库 5（可判定 4）"), "汇总行是双数字口径: " + result.message);

// ---- 三种来源各一例
const gitCase = byName("git-behind");
ok(gitCase?.via === "git", ".git origin 定源被识别: " + JSON.stringify(gitCase?.via));
ok(gitCase?.status === "behind", "上游推了新提交 → 判「有新版」: " + gitCase?.status);
ok(String(gitCase?.upstreamSha ?? "").startsWith(upstreamShort), "上游 sha 与远端一致: " + upstreamShort);
ok(String(gitCase?.localSha ?? "").length === 40 && gitCase.localSha !== gitCase.upstreamSha, "本地与上游 sha 不同");

const lockCase = byName("lock-unknown");
ok(lockCase?.via === "lock", "lock 记录定源被识别");
ok(lockCase?.status === "unknown-version", "lock 的 sha256 对不齐 commit → 「无法比对」");
ok(lockCase?.repo === "https://github.com/example-org/example-repo", "旧 tree URL 的 source 归一成仓库根: " + lockCase?.repo);
ok(lockCase?.ref === "main" && lockCase?.subPath === "skills/lock-unknown", "旧 tree URL 的 ref/subPath 仍能读出");

const metaCase = byName("meta-latest");
ok(metaCase?.via === "meta", ".huashu-skill-meta.json 定源被识别");
ok(metaCase?.status === "latest", "meta 的 commit 与上游一致 → 「最新」: " + metaCase?.status);

// ---- 失败逐条标注、不中断全量
const failedCase = byName("meta-failed");
ok(failedCase?.status === "failed", "不可达上游 → 「检查失败」");
ok(typeof failedCase?.note === "string" && failedCase.note !== "", "失败项带原因: " + failedCase?.note);
ok(gitCase?.status === "behind" && lockCase?.status === "unknown-version" && metaCase?.status === "latest", "一例失败不影响其余三例");

// ---- 无上游的不算可判定
ok(!(result.skills ?? []).some((s) => s.name === "plain"), "无上游线索的 skill 不进结果列表");
ok((result.skills ?? []).length === 4, "结果只列可判定的 4 个: " + (result.skills ?? []).length);

rmSync(home, { recursive: true, force: true });

// ---- M-1 每轮联网上限：4 个不同上游只发 3 次 ls-remote，第 4 个静默；缓存命中不计次
const budgetHome = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-budget-"));
const budgetRun = spawnSync(process.execPath, [path.join(here, "fixtures", "upstream-budget-home.mjs")], {
	env: { ...process.env, USERPROFILE: budgetHome, HOME: budgetHome },
	encoding: "utf8",
});
if (budgetRun.status !== 0) {
	console.error(budgetRun.stderr || budgetRun.stdout);
	rmSync(budgetHome, { recursive: true, force: true });
	process.exit(1);
}
const budget = JSON.parse(budgetRun.stdout);
ok(budget.seqUsed === 3, "4 个不同上游顺序检查只联网 3 次（budget.used = " + budget.seqUsed + "）");
ok(budget.seq.slice(0, 3).every((h) => h.includes("上游已有新版")), "前 3 个都给出上游提示");
ok(budget.seq[3] === "", "第 4 个被预算挡下 → 静默无提示: " + JSON.stringify(budget.seq[3]));
ok(budget.parUsed === 3, "并发（darwin 真实形态）下总量仍是 3 次联网（budget.used = " + budget.parUsed + "）");
ok(budget.par.filter((h) => h !== "").length === 3, "并发下恰好 3 个有提示、1 个静默");
ok(budget.cacheUsed === 0 && budget.cached.every((h) => h.includes("上游已有新版")), "10 分钟 TTL 缓存命中不计次（再次检查 3 个仓库仍出提示，budget.used = " + budget.cacheUsed + "）");
rmSync(budgetHome, { recursive: true, force: true });

console.log(fails === 0 ? "\n=== ALL PASS" : `\n=== ${fails} FAILED`);
process.exitCode = fails ? 1 : 0;
