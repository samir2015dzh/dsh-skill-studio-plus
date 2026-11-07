// Q-3 fixture：在伪 HOME 里手工构造 provenance / lifecycle / candidates 三份数据（已知期望值），
// 输出 collectQualityMetrics 的聚合结果与「收集前后文件内容哈希」，供断言只读。
//
// 用法：node tests/fixtures/quality-home.mjs <fakeHome> <fixedNowMs>
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const home = process.argv[2];
const now = Number(process.argv[3]);
const DAY = 86_400_000;
const iso = (t) => new Date(t).toISOString();

function write(rel, text) {
	const p = join(home, rel);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, text, "utf8");
}

const prov = (name, at, action, extra = {}) =>
	JSON.stringify(
		{ name, at: iso(at), action, into: null, source: "session-extract", sessions: ["sess-1"], digest: "0123456789abcdef", rationale: name + " 的裁决理由", ...extra },
		null,
		2
	);

// provenance：4 个名字；beta 落在 30 天窗口外，gamma 是 FOLD_INTO，delta 是 tombstone（= DROP）
write(".dsh/dsh-studio/provenance/alpha.json", prov("alpha", now - 10 * DAY, "SAVE"));
write(".dsh/dsh-studio/provenance/beta.json", prov("beta", now - 40 * DAY, "SAVE"));
write(".dsh/dsh-studio/provenance/gamma.json", prov("gamma", now - 5 * DAY, "FOLD_INTO", { into: "alpha" }));
write(".dsh/dsh-studio/provenance/delta.json", prov("delta", now - 3 * DAY, "tombstone"));

// candidates：3 条 pending（其中 1 条缺 created）+ 1 条 accepted（应被过滤）
write(
	".dsh/dsh-studio/candidates.json",
	JSON.stringify(
		[
			{ id: "1-0", status: "pending", created: now - 2 * DAY, name: "cand-a", description: "a", rationale: "", body: "a" },
			{ id: "2-0", status: "pending", created: now - 6 * 3_600_000, name: "cand-b", description: "b", rationale: "", body: "b" },
			{ id: "3-0", status: "pending", name: "cand-c", description: "c", rationale: "", body: "c" },
			{ id: "4-0", status: "accepted", created: now - DAY, name: "cand-d", description: "d", rationale: "", body: "d" }
		],
		null,
		2
	)
);

// lifecycle：alpha 有 lastUsedAt（算 used）；beta 只有 status（字段缺失 → 不算 used，也不报不可得）
write(
	".dsh/dsh-studio/skill-lifecycle.json",
	JSON.stringify(
		{
			alpha: { lastUsedAt: now - DAY, status: "active", lastCheckAt: now - DAY },
			beta: { status: "archived", lastCheckAt: now - 2 * DAY }
		},
		null,
		2
	)
);

// 库内在库：alpha；归档目录：beta（archivedNames 口径）
write(".agents/skills/alpha/SKILL.md", "---\nname: alpha\ndescription: 甲\n---\n# alpha\n");
write(".dsh/skill-archive-fixture/beta/SKILL.md", "---\nname: beta\ndescription: 乙\n---\n# beta\n");

const { collectQualityMetrics } = await import(pathToFileURL(join(import.meta.dirname, "..", "..", "lib", "quality.js")).href);

/** 伪 HOME 下全部文件的内容哈希（相对路径 → sha256），用于证明工具没写过任何文件。 */
function snapshot() {
	const out = {};
	const walk = (dir) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else out[relative(home, p).split("\\").join("/")] = createHash("sha256").update(readFileSync(p)).digest("hex");
		}
	};
	walk(home);
	return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

const before1 = snapshot();
const full = await collectQualityMetrics({ now });
const after1 = snapshot();

// 制造「文件整体缺失」：删掉 lifecycle 与 provenance，再聚一次
rmSync(join(home, ".dsh", "dsh-studio", "skill-lifecycle.json"));
rmSync(join(home, ".dsh", "dsh-studio", "provenance"), { recursive: true, force: true });
const before2 = snapshot();
const partial = await collectQualityMetrics({ now });
const after2 = snapshot();

process.stdout.write(JSON.stringify({ full, partial, before1, after1, before2, after2 }));
