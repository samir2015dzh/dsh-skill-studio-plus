// M-3 fixture：codeload 下载的网络类重试。伪 HOME 里拿真实 tarball 字节喂 fetch 替身：
//   1) 首次抛 ECONNRESET、第二次成功 → 导入成功且恰好 2 次调用
//   2) 首次 503、第二次成功 → 5xx 也退避重试（同样 2 次）
//   3) 404 → 确定性错误，只调用 1 次即失败
// 由父测试用 USERPROFILE=<临时目录> 启动。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const home = process.env.USERPROFILE ?? process.env.HOME;
const pluginRoot = path.resolve(import.meta.dirname, "..", "..");
const { importSkill } = await import(pathToFileURL(path.join(pluginRoot, "lib", "skillsrc.js")).href);

// 与 GitHub codeload 同形状：顶层 <repo>-<ref>/，下面一层 skill 目录
const pkgRoot = path.join(home, "pkg");
const subDir = path.join(pkgRoot, "repo-main", "retry-skill");
fs.mkdirSync(subDir, { recursive: true });
fs.writeFileSync(path.join(subDir, "SKILL.md"), "---\nname: retry-skill\ndescription: 重试演示\n---\nbody");
const tgz = path.join(home, "retry.tgz");
execFileSync("tar", ["-czf", tgz, "-C", pkgRoot, "repo-main"], { stdio: "pipe" });
const bytes = fs.readFileSync(tgz);

const targetDir = path.join(home, ".agents", "skills");

// 1. 首次网络错 → 第二次成功
let flakyCalls = 0;
const flaky = async () => {
	flakyCalls += 1;
	if (flakyCalls === 1) {
		const error = new TypeError("fetch failed");
		error.cause = { code: "ECONNRESET" };
		throw error;
	}
	return new Response(bytes, { status: 200 });
};
const flakyResult = await importSkill({ source: "https://github.com/o/retry-one", targetDir, fetchImpl: flaky });

// 2. 首次 503 → 第二次成功
let serverCalls = 0;
const serverError = async () => {
	serverCalls += 1;
	if (serverCalls === 1) return new Response("upstream busy", { status: 503 });
	return new Response(bytes, { status: 200 });
};
const serverResult = await importSkill({ source: "https://github.com/o/retry-two", targetDir, fetchImpl: serverError });

// 3. 404 → 不重试
let missingCalls = 0;
const missing = async () => {
	missingCalls += 1;
	return new Response("nope", { status: 404 });
};
let missingMessage = "";
try {
	await importSkill({ source: "https://github.com/o/retry-three", targetDir, fetchImpl: missing });
} catch (error) {
	missingMessage = String(error?.message ?? error);
}

process.stdout.write(
	JSON.stringify({
		flakyResult,
		flakyCalls,
		serverResult,
		serverCalls,
		missingMessage,
		missingCalls,
		imported: fs.existsSync(path.join(targetDir, "retry-skill", "SKILL.md"))
	})
);
