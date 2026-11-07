// PULL-3 测试：伪 HOME 全矩阵。快照 → 恢复（真实产出 PENDING_PULLS.json）→ 一键拉取，
// 四种结局各一条，断言逐条状态、lock 落盘、清单消项与保留规则、二次运行只重试未完成条目。
// 实网小拉取由 DSH_STUDIO_LIVE=1 开启（默认跳过，常态跑测试不联网）。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

let fails = 0;
const ok = (cond, msg) => {
	if (cond) console.log("  ok   " + msg);
	else {
		console.log("  FAIL " + msg);
		fails += 1;
	}
};

const home = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-pull-"));
const run = spawnSync(process.execPath, [path.join(here, "fixtures", "pull-home.mjs")], {
	env: { ...process.env, USERPROFILE: home, HOME: home },
	encoding: "utf8",
});
if (run.status !== 0) {
	console.error(run.stderr || run.stdout);
	rmSync(home, { recursive: true, force: true });
	process.exit(1);
}
const out = JSON.parse(run.stdout);
const byName = (list) => Object.fromEntries(list.map((item) => [item.name, item]));

// ---- 1. 快照：大 skill 只记链接，内容不进包
{
	const names = out.externalNote.skills.map((s) => s.name);
	ok(names.length === 5 && ["pull-a", "pull-aa", "pull-b", "pull-c", "pull-d"].every((n) => names.includes(n)), "包内 EXTERNAL_SKILLS 记 5 条链接: " + names.join(","));
	ok(out.packedContentCount === 0, "被链接化的 skill 内容没进包（agents-skills/ 下 0 个文件）");
	ok(out.externalNote.thresholdBytes === 5 * 1024 * 1024, "链接化门槛 5 MB 原样记在包里");
}

// ---- 2. 恢复：清单是 restore 真实产出的，不是手写
{
	ok(out.restored.dryRun === false, "restore 真跑了一次（不是 dry-run）");
	ok(out.afterRestore.length === 5, "restore 写出 5 条待拉项: " + out.afterRestore.length);
	const a = byName(out.afterRestore)["pull-a"];
	ok(a !== undefined && typeof a.source === "string" && a.source === out.sources.a, "清单条目的 source 是 lock 里的本地 tarball 路径");
	ok(a !== undefined && a.ref === "" && a.subdir === "" && /^[0-9a-f]{64}$/.test(a.sha), "ref/subdir 字段形态稳定、sha 是 64 位内容哈希");
	ok(out.pendingFile === path.join(home, ".agents", "skills", "PENDING_PULLS.json"), "清单位置 = 外部 skill 根: " + out.pendingFile);
	ok(out.restored.pendingPulls.length === 5, "restore 的 summary 同步给出 pendingPulls");
}

// ---- 3. 逐条结局
{
	const first = out.first;
	const r = byName(first.results);
	ok(first.results.length === 5, "5 条全部处理（单条失败不中断其余条目）: " + first.results.map((x) => x.name + "=" + x.status).join(","));
	ok(r["pull-a"]?.status === "pulled", "pull-a 成功拉取（目标目录原本不存在）");
	ok(r["pull-a"]?.files === 2, "pull-a 落地 2 个文件: " + r["pull-a"]?.files);
	ok(out.dirs.aSkill && out.dirs.aBig, "pull-a 的 SKILL.md 与 big.bin 都在磁盘上");
	ok(r["pull-b"]?.status === "satisfied", "pull-b 已存在且内容一致 → satisfied");
	ok(r["pull-b"]?.relocked === false, "pull-b 的 lock 本来就对，不重写");
	ok(r["pull-c"]?.status === "conflict", "pull-c 同名异内容 → conflict");
	ok(r["pull-c"]?.lockedSha256 === "0".repeat(64) && r["pull-c"]?.incomingSha256 !== undefined, "conflict 同时给出锁里的与本次的 sha256");
	ok(out.dirs.cSkill.includes("上游 C v1"), "conflict 绝不覆盖：pull-c 仍是最初的内容");
	ok(r["pull-aa"]?.status === "failed" && /ENOENT|no such file/i.test(r["pull-aa"]?.reason ?? ""), "pull-aa 坏源 → failed（排在中间）");
	ok(r["pull-d"]?.status === "failed" && /ENOENT|no such file/i.test(r["pull-d"]?.reason ?? ""), "pull-d 坏源 → failed 并记下原因");
}

// ---- 4. 汇总计数
{
	const f = out.first;
	ok(f.ok === true && f.total === 5, "总条数 5");
	ok(f.pulled === 1 && f.satisfied === 1 && f.conflict === 1 && f.failed === 2, "计数 pulled1/satisfied1/conflict1/failed2");
	ok(f.remaining === 3, "剩余 3 条留在清单里");
	ok(typeof f.message === "string" && f.message.includes("3 条留在清单里"), "汇总文案: " + f.message);
}

// ---- 5. lock 落盘
{
	const a = out.lock["pull-a"];
	ok(a !== undefined && a.sha256 === out.hashes.a, "pull-a 的 lock 记下本次内容 sha256");
	ok(a !== undefined && a.source === out.sources.a && a.ref === "" && a.subPath === "", "lock 的 source/ref/subPath 形态与 U-3 一致");
	ok(out.lock["pull-b"]?.sha256 === out.hashes.b, "satisfied 的 pull-b 锁记录不变");
	ok(out.lock["pull-c"]?.sha256 === "0".repeat(64), "conflict 不改写 pull-c 的锁");
}

// ---- 6. 清单消项与保留规则
{
	ok(out.listAfterFirst.join(",") === "pull-aa,pull-c,pull-d", "成功与已满足的消项，冲突与失败保留: " + out.listAfterFirst.join(","));
	ok(out.leftovers.length === 0, "写回没有留下半截 .tmp 文件");
}

// ---- 7. 二次运行只重试未完成条目
{
	const s = out.second;
	ok(s.total === 3 && s.pulled === 0 && s.satisfied === 0 && s.conflict === 1 && s.failed === 2, "二次运行只处理剩下的 3 条");
	ok(out.listAfterSecond.join(",") === "pull-aa,pull-c,pull-d", "未完成的条目仍原样保留");
	ok(out.second.remaining === 3, "二次运行后剩余仍是 3");
}

// ---- 8. 清单不存在：空结果、不报错
{
	ok(out.empty.ok === true && out.empty.total === 0, "清单不存在时返回空结果");
	ok(String(out.empty.message).includes("无待拉项"), "空结果明示「无待拉项」: " + out.empty.message);
}

rmSync(home, { recursive: true, force: true });

// ---- 9. 实网小拉取（DSH_STUDIO_LIVE=1 才跑）
if (process.env.DSH_STUDIO_LIVE === "1") {
	console.log("\n[9] 实网小拉取 huashu-proofreading");
	const liveHome = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-live-"));
	const live = spawnSync(process.execPath, [path.join(here, "fixtures", "live-pull-home.mjs")], {
		env: { ...process.env, USERPROFILE: liveHome, HOME: liveHome },
		encoding: "utf8",
		timeout: 600_000
	});
	if (live.status !== 0) {
		console.log("  FAIL 实网 fixture 退出码 " + live.status + "：" + (live.stderr || live.stdout).slice(0, 800));
		fails += 1;
	} else {
		const l = JSON.parse(live.stdout);
		ok(l.result.pulled === 1 && l.result.total === 1, "实网条目 pulled=1");
		ok(l.landed === true, "huashu-proofreading 的 SKILL.md 落到磁盘");
		ok(l.lock?.source === "https://github.com/alchaincyf/huashu-skills", "lock 的 source 是仓库根: " + l.lock?.source);
		ok(l.lock?.ref === "master" && l.lock?.subPath === "huashu-proofreading", "lock 的 ref / subPath 结构化正确");
		ok(/^[0-9a-f]{64}$/.test(l.lock?.sha256 ?? ""), "lock 记下内容 sha256");
		ok(l.pendingExists === false, "拉取成功后清单清空（文件消失 = 无待拉项）");
		ok(l.head.some((line) => line.includes("name: huashu-proofreading")), "落地文件是正的 huashu-proofreading");
	}
	rmSync(liveHome, { recursive: true, force: true });
} else {
	console.log("\n[9] 跳过实网拉取（DSH_STUDIO_LIVE=1 才跑）");
}

console.log(fails === 0 ? "\n=== ALL PASS" : `\n=== ${fails} FAILED`);
process.exitCode = fails ? 1 : 0;
