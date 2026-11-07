// M-1 fixture：4 个不同上游仓库的待评估 skill，共用一个每轮计数器（默认上限 3 次 ls-remote）。
// 顺序与并发两种调用形态各跑一遍，再把已缓存的仓库重跑一遍 —— 缓存命中不计次。
// 计数探针就是 budget.used 本身：它只由 lsRemoteSha 在真正联网前自增。
// 由父测试用 USERPROFILE=<临时目录> 启动。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const home = process.env.USERPROFILE ?? process.env.HOME;
const pluginRoot = path.resolve(import.meta.dirname, "..", "..");
const { createUpstreamBudget, upstreamHint } = await import(pathToFileURL(path.join(pluginRoot, "lib", "upstream.js")).href);

const git = (args, cwd) =>
	execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], {
		cwd,
		encoding: "utf8",
		stdio: "pipe",
	}).trim();

const agentRoot = path.join(home, ".agents", "skills");
fs.mkdirSync(agentRoot, { recursive: true });

const skillDirs = [];
// 8 个仓库分两组：1–4 给顺序用例，5–8 给并发用例（避免前一组留下的 TTL 缓存掩盖计数）
for (let i = 1; i <= 8; i += 1) {
	const name = "probe-" + i;
	const work = path.join(home, "work-" + i);
	const bare = path.join(home, "upstream-" + i + ".git");
	fs.mkdirSync(work, { recursive: true });
	fs.writeFileSync(path.join(work, "SKILL.md"), `---\nname: ${name}\ndescription: 探针 ${i}\n---\nbody`);
	git(["init", "--bare", "-b", "main", bare]);
	git(["init", "-b", "main"], work);
	git(["add", "-A"], work);
	git(["commit", "--no-verify", "-m", "init"], work);
	git(["remote", "add", "origin", bare], work);
	git(["push", "-u", "origin", "main"], work);

	const dir = path.join(agentRoot, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: 探针 ${i}\n---\nbody`);
	// 本地记的 commit 与上游 HEAD 不同 → 每个 skill 本应都给出「上游已有新版」
	fs.writeFileSync(
		path.join(dir, ".huashu-skill-meta.json"),
		JSON.stringify({ name, repo: bare, ref: "", subdir: "", commit: "b".repeat(40) }),
	);
	skillDirs.push(dir);
}

const opts = { lock: {}, timeoutMs: 8000, ttlMs: 10 * 60_000 };
const seqDirs = skillDirs.slice(0, 4);
const parDirs = skillDirs.slice(4);

// 1. 顺序调用：前 3 个联网并给提示，第 4 个被预算挡下，静默返回空串
const seqBudget = createUpstreamBudget(3);
const seq = [];
for (const dir of seqDirs) seq.push(await upstreamHint(dir, { ...opts, budget: seqBudget }));

// 2. 并发调用（darwin 的真实形态）：换一组冷缓存的仓库，总量仍然只有 3 次联网
const parBudget = createUpstreamBudget(3);
const par = await Promise.all(parDirs.map((dir) => upstreamHint(dir, { ...opts, budget: parBudget })));

// 3. 缓存命中不计次：第 1 步里成功的 3 个仓库已在 TTL 缓存里，重跑不增预算
const cacheBudget = createUpstreamBudget(3);
const cached = [];
for (const dir of seqDirs.slice(0, 3)) cached.push(await upstreamHint(dir, { ...opts, budget: cacheBudget }));

process.stdout.write(JSON.stringify({ seq, seqUsed: seqBudget.used, par, parUsed: parBudget.used, cached, cacheUsed: cacheBudget.used }));
