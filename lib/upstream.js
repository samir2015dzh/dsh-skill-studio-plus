/**
 * skill 上游版本检查（U-1/U-2）。全程只读：只跑 `git ls-remote` 取远端 ref 快照，
 * 不 fetch、不 clone、不改任何仓库，也不写回 skill 或 lock。
 *
 * 上游来源按优先级判定：skill-lock.json 记录 > 目录内 .git 的 origin > .huashu-skill-meta.json。
 * 版本字段按同一顺序取第一个 40 位 commit sha —— lock 里的 sha256 是 tar 包内容哈希，
 * 与 commit sha 不同源，所以只由 lock 定源的 skill 会落到「仅知有上游、无法比对版本」。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { splitSourceUrl } from "./paths.js";
import { loadLock } from "./skillsrc.js";

const execFileAsync = promisify(execFile);
const COMMIT_RE = /^[0-9a-f]{40}$/;
/** repo\0ref → { at, sha }；只缓存 ls-remote 的结果，避免每轮都联一次网 */
const remoteCache = new Map();

/** 每轮联网上限：默认 3 次 ls-remote；缓存命中不计次。 */
export const DEFAULT_REMOTE_BUDGET = 3;

/**
 * 建一个「本轮」计数器给一批检查共用（darwin 每轮对话建一个）。
 * used 只由 lsRemoteSha 在真正联网前自增，所以缓存命中不会吃掉预算。
 */
export function createUpstreamBudget(max = DEFAULT_REMOTE_BUDGET) {
	return { max: Number.isFinite(max) ? Math.max(0, Math.floor(max)) : DEFAULT_REMOTE_BUDGET, used: 0 };
}

function readMeta(dir) {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(dir, ".huashu-skill-meta.json"), "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * 仓库地址归一：tree URL 取仓库根，`.git` 去掉，`owner/repo` 补成 GitHub URL。非远程地址返回空串。
 * allowPath 只给 .git origin 用 —— 本地 bare 仓库/内网镜像也是合法上游；lock/meta 里的本地路
 * 径是 tar 包路径，不算上游。
 */
function normalizeRepo(raw, { allowPath = false } = {}) {
	const text = String(raw ?? "").trim();
	if (text === "") return "";
	const repo = (splitSourceUrl(text).repo || text).replace(/\.git$/i, "");
	if (/^https?:\/\//i.test(repo) || /^file:\/\//i.test(repo)) return repo;
	if (/^git@[^:]+:.+/.test(repo)) return repo;
	if (/^[\w.-]+\/[\w.-]+$/.test(repo)) return "https://github.com/" + repo;
	if (allowPath && path.isAbsolute(repo)) return repo;
	return "";
}

/** 取第一个 40 位 commit sha（小写）；没有就空串。 */
function firstCommit(values) {
	for (const value of values) {
		const text = String(value ?? "").trim().toLowerCase();
		if (COMMIT_RE.test(text)) return text;
	}
	return "";
}

async function gitOut(dir, args) {
	try {
		const { stdout } = await execFileAsync("git", ["-C", dir, ...args], { timeout: 10_000, windowsHide: true });
		return String(stdout ?? "").trim();
	} catch {
		return "";
	}
}

/**
 * 判定一个 skill 目录的上游。
 * @returns {Promise<null | {via:"lock"|"git"|"meta", repo:string, ref:string, subPath:string, localSha:string}>}
 *   null = 没有任何上游线索；localSha 为空 = 只知道有上游、拿不到可比的本地 commit。
 */
export async function resolveUpstream(dir, { lock } = {}) {
	const table = lock ?? (await loadLock());
	const name = path.basename(dir);
	const candidates = [];

	const rec = table[name.toLowerCase()] ?? table[name];
	if (rec && typeof rec === "object" && typeof rec.source === "string" && rec.source.trim() !== "") {
		const split = splitSourceUrl(rec.source);
		const repo = normalizeRepo(split.repo);
		if (repo !== "") {
			candidates.push({
				via: "lock",
				repo,
				ref: String(rec.ref ?? "").trim() || split.ref,
				subPath: String(rec.subPath ?? "").trim().replace(/^\/+|\/+$/g, "") || split.subdir,
				// lock 只可能带 sha256（tar 包内容哈希）；显式写过 commit sha 的才拿来比
				localSha: firstCommit([rec.commit, rec.commitSha])
			});
		}
	}

	if (fs.existsSync(path.join(dir, ".git"))) {
		const repo = normalizeRepo(await gitOut(dir, ["remote", "get-url", "origin"]), { allowPath: true });
		const head = (await gitOut(dir, ["rev-parse", "HEAD"])).toLowerCase();
		if (repo !== "") {
			candidates.push({ via: "git", repo, ref: "", subPath: "", localSha: COMMIT_RE.test(head) ? head : "" });
		}
	}

	const meta = readMeta(dir);
	if (meta !== null) {
		// meta 是显式声明的上游，本地镜像/bare 路径同样算数
		const repo = normalizeRepo(meta.repo, { allowPath: true });
		if (repo !== "") {
			candidates.push({
				via: "meta",
				repo,
				ref: String(meta.ref ?? "").trim(),
				subPath: String(meta.subdir ?? "").trim().replace(/^\/+|\/+$/g, ""),
				localSha: firstCommit([meta.commit])
			});
		}
	}

	if (candidates.length === 0) return null;
	const primary = candidates[0];
	// 版本字段：按优先级顺序找第一个能对齐的 commit sha —— lock 的 sha256 是包内容哈希，
	// 对不齐就继续看 .git HEAD 与 meta.commit；三处都没有才是「仅知有上游、无法比对版本」。
	const localSha = candidates.find((c) => c.localSha !== "")?.localSha ?? "";
	return { via: primary.via, repo: primary.repo, ref: primary.ref, subPath: primary.subPath, localSha };
}

function pickSha(stdout, refName) {
	for (const line of String(stdout ?? "").split(/\r?\n/)) {
		const [sha, name] = line.trim().split(/\s+/);
		if (name === refName && COMMIT_RE.test(sha)) return sha;
	}
	return "";
}

async function lsRemoteUncached(repo, wanted, timeoutMs) {
	const opts = { timeout: timeoutMs, windowsHide: true };
	if (wanted === "" || wanted === "HEAD") {
		const { stdout } = await execFileAsync("git", ["ls-remote", repo, "HEAD"], opts);
		const sha = pickSha(stdout, "HEAD");
		if (sha === "") throw new Error(`上游没有可读的 HEAD：${repo}`);
		return sha;
	}
	const heads = await execFileAsync("git", ["ls-remote", "--heads", repo, wanted], opts);
	const sha = pickSha(heads.stdout, "refs/heads/" + wanted);
	if (sha !== "") return sha;
	// ref 可能已过时（默认分支改名）：退回该仓库的 HEAD，别把「查不到这个 ref」当成检查失败
	const { stdout } = await execFileAsync("git", ["ls-remote", repo, "HEAD"], opts);
	const head = pickSha(stdout, "HEAD");
	if (head === "") throw new Error(`上游没有可读的 ref：${repo}#${wanted}`);
	return head;
}

/** 取远端 ref 的 sha。失败（网络、认证、仓库不存在）直接抛，由调用方决定怎么标注。 */
export async function lsRemoteSha(repo, ref = "", { timeoutMs = 8000, ttlMs = 0, budget = null } = {}) {
	const wanted = String(ref ?? "").trim();
	const key = repo + "\u0000" + wanted;
	const now = Date.now();
	const hit = remoteCache.get(key);
	if (ttlMs > 0 && hit !== undefined && now - hit.at < ttlMs) return hit.sha;
	// 预算判断与自增都在第一个 await 之前完成：并发的一轮里也不会有两个请求同时看到同一个 used。
	if (budget !== null) {
		if (budget.used >= budget.max) throw new Error(`本轮上游检查已达上限（${budget.max} 次），本次静默跳过`);
		budget.used += 1;
	}
	const sha = await lsRemoteUncached(repo, wanted, timeoutMs);
	if (ttlMs > 0) remoteCache.set(key, { at: now, sha });
	return sha;
}

/**
 * 检查一个 skill 的版本状态。
 * status: latest（最新）/ behind（有新版）/ unknown-version（仅知有上游、无法比对）/ failed（检查失败）/ no-upstream
 */
export async function checkUpstream(dir, opts = {}) {
	const name = path.basename(dir).toLowerCase();
	const up = await resolveUpstream(dir, opts);
	const base = { name, dir, via: "", repo: "", ref: "", subPath: "", localSha: "", upstreamSha: "" };
	if (up === null) return { ...base, status: "no-upstream" };
	const meta = { ...base, ...up };
	if (up.localSha === "") return { ...meta, status: "unknown-version" };
	try {
		const sha = await lsRemoteSha(up.repo, up.ref, opts);
		return { ...meta, upstreamSha: sha, status: sha === up.localSha ? "latest" : "behind" };
	} catch (error) {
		return { ...meta, status: "failed", note: String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 200) };
	}
}

/**
 * U-1 用的一行提示：上游有新提交时返回提示文本，其余情形（无上游 / 网络失败 / 本轮超预算 / 无差异）返回空串。
 * 绝不抛错 —— 上游检查不能阻断优化主流程。budget 用 createUpstreamBudget() 建的每轮计数器。
 */
export async function upstreamHint(dir, opts = {}) {
	try {
		const result = await checkUpstream(dir, opts);
		if (result.status !== "behind") return "";
		return `上游已有新版（${result.upstreamSha.slice(0, 7)}），本次优化仍基于本地版本`;
	} catch {
		return "";
	}
}

/**
 * 列出若干 skill 根下的 skill 目录（含 SKILL.md 的那层）。
 * 跟随符号链接（~/.dsh/skills 里有指到 agent 根的链接），按真实路径去重 —— 同一个 skill 只算一次。
 */
export function listSkillDirs(roots, maxDepth = 3) {
	const out = [];
	const seen = new Set();

	const push = (dir) => {
		let real = dir;
		try {
			real = fs.realpathSync(dir);
		} catch {
			/* 拿不到真实路径就用原路径去重 */
		}
		const key = real.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ name: path.basename(dir).toLowerCase(), dir });
	};

	const walk = (dir, depth) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		if (entries.some((entry) => entry.isFile() && /^SKILL\.md$/i.test(entry.name))) push(dir);
		if (depth >= maxDepth) return;
		for (const entry of entries) {
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const full = path.join(dir, entry.name);
			const isDir = entry.isDirectory() || (entry.isSymbolicLink() && isDirSync(full));
			if (isDir) walk(full, depth + 1);
		}
	};

	for (const root of roots) {
		if (typeof root === "string" && root !== "") walk(root, 0);
	}
	return out;
}

function isDirSync(target) {
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}
