// darwin 调度器冒烟测试：同族折叠、静默闸、扫描隔离
// 每个场景独立的 stateFile，避免 mtime 基线互相串扰。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyDarwin } from "../lib/darwin.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "darwin-test-"));
const skills = path.join(root, "skills");

const HOST = "parallel-subagent-file-ownership";
const MEMBERS = [
	"parallel-fix-file-ownership",
	"parallel-port-file-ownership",
	"exclusive-file-partition-parallel-port",
	"scoped-subagent-delegation",
	"parallel-agent-build-isolation",
];

for (const name of [HOST, ...MEMBERS]) {
	fs.mkdirSync(path.join(skills, name), { recursive: true });
	fs.writeFileSync(path.join(skills, name, "SKILL.md"), `---\nname: ${name}\ndescription: 同一个职责\n---\nbody`);
}

let fails = 0;
const ok = (cond, msg) => {
	if (cond) console.log("  ok   " + msg);
	else {
		console.log("  FAIL " + msg);
		fails += 1;
	}
};

let seq = 0;
const scene = (cfg = {}) => {
	seq += 1;
	const h = new Map();
	const ctx = { on: (ev, fn) => h.set(ev, fn), logger: { info: () => {}, warn: () => {} } };
	const stateFile = path.join(root, `state-${seq}.json`);
	const familyFile = path.join(root, `families-${seq}.json`);
	// 预设 lastSweep：否则首次挂载会立刻跑一轮巡检，把 stale 项塞进输出，干扰断言
	fs.writeFileSync(stateFile, JSON.stringify({ scores: {}, lastSweep: Date.now() }));
	applyDarwin(ctx, { roots: [skills], stateFile, familyFile, familyRefreshDays: 0, sweepHours: 999, ...cfg }, {});
	return { h, stateFile, familyFile };
};

const writeSkill = (h, name) =>
	h.get("tools/post-execute")({ name: "write", arguments: { file_path: path.join(skills, name, "SKILL.md") } }, {}, async () => {});

const sectionText = async (h) => {
	const out = await h.get("system-prompt/assemble")({}, {}, async () => ({ sections: [] }));
	const sec = (out.sections ?? []).find((s) => s.name === "darwin");
	return sec ? sec.text : "";
};

/** 只取「待评估清单」那一段，避开折叠行里的同名路径。 */
const pendingBlock = (text) => {
	const i = text.indexOf("本轮检测到下列 skill 文件被改写");
	if (i < 0) return "";
	const j = text.indexOf("步骤：", i);
	return text.slice(i, j < 0 ? undefined : j);
};

// ---- 1. 没有 families.json：全部进体检
{
	const { h } = scene();
	ok(h.has("tools/post-execute") && h.has("system-prompt/assemble"), "两个事件都注册");
	for (const n of [HOST, ...MEMBERS]) await writeSkill(h, n);
	const text = await sectionText(h);
	const block = pendingBlock(text);
	ok(MEMBERS.every((m) => block.includes(m)), "无 families.json 时成员全部进体检");
	ok(block.includes(HOST), "宿主也进体检");
	ok(text.includes("9 维 rubric"), "提示文本完整");
}

// ---- 2. 有 families.json：成员折叠，只留宿主
{
	const { h, stateFile, familyFile } = scene();
	fs.writeFileSync(
		familyFile,
		JSON.stringify({
			version: 1,
			updatedAt: new Date().toISOString().slice(0, 10),
			families: [{ id: "fam", host: HOST, members: MEMBERS, reason: "test" }],
		}),
	);
	for (const n of [HOST, ...MEMBERS]) await writeSkill(h, n);
	const text = await sectionText(h);
	const block = pendingBlock(text);
	ok(block.includes(HOST), "有 families.json 时宿主仍进体检");
	ok(MEMBERS.every((m) => !block.includes(m)), "成员不进待评估清单");
	ok(text.includes("已按 families.json 折叠"), "输出标明已折叠");
	const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
	const key = (m) => path.resolve(path.join(skills, m, "SKILL.md")).toLowerCase();
	ok(MEMBERS.every((m) => st.scores[key(m)] > 0), "成员记入 scores，下轮不重送");
	ok(!(st.scores[key(HOST)] > 0), "宿主未被标记为已处理");
}

// ---- 3. 加载 darwin-skill 后静默
{
	const { h } = scene();
	await writeSkill(h, HOST);
	await h.get("tools/post-execute")({ name: "skill", arguments: { name: "darwin-skill" } }, {}, async () => {});
	ok((await sectionText(h)) === "", "加载 darwin-skill 后进入静默期");
}

// ---- 4. roots 外的 SKILL.md 不触发
{
	const { h } = scene();
	await h.get("tools/post-execute")(
		{ name: "write", arguments: { file_path: path.join(root, "other", "SKILL.md") } },
		{},
		async () => {},
	);
	ok((await sectionText(h)) === "", "roots 外的 SKILL.md 不触发");
}

// ---- 5. enabled:false 完全不挂
{
	seq += 1;
	const h = new Map();
	const ctx = { on: (ev, fn) => h.set(ev, fn), logger: { info: () => {}, warn: () => {} } };
	applyDarwin(ctx, { enabled: false, roots: [skills] }, {});
	ok(h.size === 0, "enabled:false 时不注册任何事件");
}

fs.rmSync(root, { recursive: true, force: true });
console.log(fails === 0 ? "\n=== ALL PASS" : `\n=== ${fails} FAILED`);
process.exitCode = fails ? 1 : 0;
