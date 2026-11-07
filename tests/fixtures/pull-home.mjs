// PULL-3 fixture：在伪 HOME 里走完「建快照 → 恢复 → 一键拉取」全链，清单由 restore 真实产出，不手写。
//
// 四种结局各一条：pull-a 目标目录不存在（成功拉取）、pull-b 内容已一致（satisfied）、
// pull-c 同名异内容（conflict，绝不覆盖）、pull-d 源指向不存在的 tarball（failed）。
// 大 skill 的门槛（> 5 MB）用 6 MB 填充文件撑住，源一律是本地 tarball，全程离线。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const home = process.env.USERPROFILE ?? process.env.HOME;
const pluginRoot = path.resolve(import.meta.dirname, "..", "..");
const lib = (name) => import(pathToFileURL(path.join(pluginRoot, "lib", name)).href);
const snapshot = await lib("snapshot.js");
const skillsrc = await lib("skillsrc.js");
const pending = await lib("pending.js");

const dsh = path.join(home, ".dsh");
const external = path.join(home, ".agents", "skills");
fs.mkdirSync(path.join(dsh, "dsh-studio"), { recursive: true });
fs.mkdirSync(external, { recursive: true });
fs.writeFileSync(path.join(dsh, "AGENTS.md"), "# 伪 HOME\n");
fs.writeFileSync(path.join(dsh, "dsh-studio", "extractor.json"), JSON.stringify({ agentSkillDir: external }, null, 2) + "\n");

const BIG = Buffer.alloc(6 * 1024 * 1024, 0x61);
const skillFiles = (name, desc) => [
	{ rel: "SKILL.md", data: `---\nname: ${name}\ndescription: ${desc}\n---\nbody ${desc}\n` },
	{ rel: "big.bin", data: BIG }
];

function makeTgz(name, desc) {
	const file = path.join(home, `${name}.tgz`);
	const root = path.join(home, "stage-" + name, "repo-main", name);
	fs.mkdirSync(root, { recursive: true });
	for (const f of skillFiles(name, desc)) fs.writeFileSync(path.join(root, f.rel), f.data);
	execFileSync("tar", ["-czf", file, "-C", path.join(home, "stage-" + name), "repo-main"], { stdio: "pipe" });
	return file;
}

function layOut(name, desc) {
	const dir = path.join(external, name);
	for (const f of skillFiles(name, desc)) {
		const target = path.join(dir, f.rel);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, f.data);
	}
}

const shaOf = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const stamp = new Date().toISOString();

const srcA = makeTgz("pull-a", "上游 A");
const srcB = makeTgz("pull-b", "上游 B");
const srcC = makeTgz("pull-c", "上游 C v2");
const srcD = path.join(home, "missing-d.tgz");
const srcAA = path.join(home, "missing-aa.tgz");

// 本地"曾经装过"的形态：A 建好后在恢复前删掉（等拉）、B 与源逐字节一致（satisfied）、
// C 是旧版内容（conflict）、AA 与 D 的源都丢了（failed，其中 AA 排在中间用来证明不中断）
layOut("pull-a", "上游 A v0");
layOut("pull-aa", "上游 AA v0");
layOut("pull-b", "上游 B");
layOut("pull-c", "上游 C v1");
layOut("pull-d", "上游 D");

const lock = {
	"pull-a": { source: srcA, ref: "", sha256: shaOf(srcA), at: stamp, subPath: "" },
	"pull-aa": { source: srcAA, ref: "", sha256: "2".repeat(64), at: stamp, subPath: "" },
	"pull-b": { source: srcB, ref: "", sha256: shaOf(srcB), at: stamp, subPath: "" },
	"pull-c": { source: srcC, ref: "", sha256: "0".repeat(64), at: stamp, subPath: "" },
	"pull-d": { source: srcD, ref: "", sha256: "1".repeat(64), at: stamp, subPath: "" }
};
fs.writeFileSync(path.join(dsh, "dsh-studio", "skill-lock.json"), JSON.stringify(lock, null, 2) + "\n");

// ---- 1. 建快照：大 skill 只记链接
const snap = await snapshot.createSnapshot("pull-matrix");
const archive = fs.readFileSync(path.join(snapshot.snapshotsDir(), snap.id, "config.tar.gz"));
const inPack = snapshot
	.unpackTarGz(archive)
	.filter((e) => e.rel === "EXTERNAL_SKILLS.json")
	.map((e) => JSON.parse(e.data.toString("utf8")))[0];
const packedContent = snapshot.unpackTarGz(archive).filter((e) => e.rel.startsWith("agents-skills/"));

// ---- 2. 恢复：真实产出 PENDING_PULLS.json（恢复端不联网）
fs.rmSync(path.join(external, "pull-a"), { recursive: true, force: true });
const restored = await snapshot.restoreSnapshot(snap.id);
const pendingFile = await pending.pendingPullsPath();
const afterRestore = JSON.parse(fs.readFileSync(pendingFile, "utf8"));

// ---- 3. 一键拉取
const first = await pending.pullPending({ targetDir: external });
const listAfterFirst = JSON.parse(fs.readFileSync(pendingFile, "utf8"));
const leftovers = fs.readdirSync(external).filter((name) => name.endsWith(".tmp"));

// ---- 4. 二次运行：只重试未完成的
const second = await pending.pullPending({ targetDir: external });
const listAfterSecond = JSON.parse(fs.readFileSync(pendingFile, "utf8"));

// ---- 5. 清单不存在：空结果、不报错
fs.rmSync(pendingFile, { force: true });
const empty = await pending.pullPending({ targetDir: external });

process.stdout.write(
	JSON.stringify({
		snapId: snap.id,
		externalNote: inPack,
		packedContentCount: packedContent.length,
		restored: { pendingPulls: restored.pendingPulls, dryRun: restored.dryRun },
		pendingFile,
		afterRestore: afterRestore.pulls,
		first,
		listAfterFirst: listAfterFirst.pulls.map((p) => p.name),
		leftovers,
		second,
		listAfterSecond: listAfterSecond.pulls.map((p) => p.name),
		empty,
		lock: await skillsrc.loadLock(),
		sources: { a: srcA, b: srcB, c: srcC, d: srcD },
		hashes: { a: shaOf(srcA), b: shaOf(srcB) },
		dirs: {
			a: fs.existsSync(path.join(external, "pull-a")),
			aSkill: fs.existsSync(path.join(external, "pull-a", "SKILL.md")),
			aBig: fs.existsSync(path.join(external, "pull-a", "big.bin")),
			cSkill: fs.readFileSync(path.join(external, "pull-c", "SKILL.md"), "utf8")
		}
	})
);
