// U-2 fixture：在伪 HOME 里准备三种上游来源（bare origin / lock / meta）+ 一例不可达上游，
// 跑一次只读检查，把工具返回值打成 JSON 交给 tests/upstream.test.mjs 断言。
// 由父测试用 USERPROFILE=<临时目录> 启动，这里不再改 HOME。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const home = process.env.USERPROFILE ?? process.env.HOME;
const pluginRoot = path.resolve(import.meta.dirname, "..", "..");
const agentRoot = path.join(home, ".agents", "skills");
const dshRoot = path.join(home, ".dsh", "skills");
const lockFile = path.join(home, ".dsh", "dsh-studio", "skill-lock.json");

const git = (args, cwd) =>
	execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], {
		cwd,
		encoding: "utf8",
		stdio: "pipe",
	}).trim();

const writeSkill = (dir, name) => {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\nbody`);
};

fs.mkdirSync(agentRoot, { recursive: true });
fs.mkdirSync(dshRoot, { recursive: true });

// ---- 1. .git 定源：本地 bare 仓库当 origin，克隆后往上游再推一个提交 → 应判「有新版」
const origin = path.join(home, "upstream.git");
git(["init", "--bare", "-b", "main", origin]);
const gitSkill = path.join(agentRoot, "git-behind");
writeSkill(gitSkill, "git-behind");
git(["init", "-b", "main"], gitSkill);
git(["add", "-A"], gitSkill);
git(["commit", "--no-verify", "-m", "init"], gitSkill);
git(["remote", "add", "origin", origin], gitSkill);
git(["push", "-u", "origin", "main"], gitSkill);
const otherClone = path.join(home, "clone-other");
git(["clone", origin, otherClone]);
fs.writeFileSync(path.join(otherClone, "NEW.md"), "upstream moved\n");
git(["add", "-A"], otherClone);
git(["commit", "--no-verify", "-m", "upstream new"], otherClone);
git(["push", "origin", "main"], otherClone);
const upstreamShort = git(["rev-parse", "HEAD"], otherClone).slice(0, 7);

// ---- 2. lock 定源（旧形态：完整 tree URL）：sha256 是包内容哈希，与 commit 不同源 → 「无法比对」
writeSkill(path.join(agentRoot, "lock-unknown"), "lock-unknown");

// ---- 3. meta 定源：本地 bare 仓库 + 对齐的 commit sha → 「最新」
const metaSkill = path.join(dshRoot, "meta-latest");
writeSkill(metaSkill, "meta-latest");
const metaOrigin = path.join(home, "meta-upstream.git");
const metaWork = path.join(home, "meta-work");
git(["init", "--bare", "-b", "main", metaOrigin]);
writeSkill(path.join(metaWork, "meta-latest"), "meta-latest");
git(["init", "-b", "main"], metaWork);
git(["add", "-A"], metaWork);
git(["commit", "--no-verify", "-m", "init"], metaWork);
git(["remote", "add", "origin", metaOrigin], metaWork);
git(["push", "-u", "origin", "main"], metaWork);
const metaHead = git(["rev-parse", "HEAD"], metaWork);
fs.writeFileSync(
	path.join(metaSkill, ".huashu-skill-meta.json"),
	JSON.stringify({ name: "meta-latest", repo: metaOrigin, subdir: "meta-latest", commit: metaHead, installed_at: "2026-01-01", last_checked: "2026-01-01" }),
);

// ---- 4. meta 定源但上游不存在 → 「检查失败」，且不能中断其余检查
const failedSkill = path.join(agentRoot, "meta-failed");
writeSkill(failedSkill, "meta-failed");
fs.writeFileSync(
	path.join(failedSkill, ".huashu-skill-meta.json"),
	JSON.stringify({ name: "meta-failed", repo: path.join(home, "missing.git"), subdir: "", commit: "b".repeat(40) }),
);

// ---- 5. 没有任何上游线索 → 不计入可判定
writeSkill(path.join(agentRoot, "plain"), "plain");

// ---- 6. 同一个 skill 挂在两棵树（符号链接）→ 全库计数只能算一次
let linked = false;
try {
	fs.symlinkSync(gitSkill, path.join(dshRoot, "git-behind"), "junction");
	linked = true;
} catch {
	/* 没有建链接的权限就跳过这项，去重断言由真实路径逻辑兜底 */
}

fs.mkdirSync(path.dirname(lockFile), { recursive: true });
fs.writeFileSync(
	lockFile,
	JSON.stringify({
		"lock-unknown": {
			source: "https://github.com/example-org/example-repo/tree/main/skills/lock-unknown",
			ref: "main",
			sha256: "a".repeat(64),
			at: "2026-01-01T00:00:00.000Z",
			subPath: "skills/lock-unknown",
		},
	}),
);

const { skillmgrUpdateCheckTool } = await import(pathToFileURL(path.join(pluginRoot, "lib", "index.js")).href);
const tool = skillmgrUpdateCheckTool({ view: async () => ({ agentSkillDir: agentRoot }) });
const result = await tool.execute({ timeoutMs: 8000 });

process.stdout.write(JSON.stringify({ result, upstreamShort, linked }));
