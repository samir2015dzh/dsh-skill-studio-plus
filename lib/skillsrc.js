/**
 * 从 GitHub 仓库 / tarball 导入 skill（WO-BORROW-6）。
 *
 * 设计参考：
 * - functy23/dsh-mcp-studio 的 `repos.ts` / `repos.utils.ts` / `tar.ts`
 *   （仓库与 tarball 导入、目录内 SKILL.md 根自动探测）
 * - vercel-labs/skills（MIT）的 `src/local-lock.ts`（source + ref + 内容哈希锁文件）
 *   与 `src/agents.ts`（多 agent 目录探测表）
 * 两个仓库都不在本机、本次未取到源码，按需求自行实现，未移植其代码。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fetchWithTimeout } from "./http.js";
import { unpackTarGz } from "./snapshot.js";

/** 安装锁：记录每个导入 skill 的来源、ref 与内容哈希。 */
export function lockPath() {
	return resolve(homedir(), ".dsh", "dsh-studio", "skill-lock.json");
}

export async function loadLock(file = lockPath()) {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export async function saveLock(lock) {
	await mkdir(dirname(lockPath()), { recursive: true });
	const tmp = lockPath() + ".tmp";
	await writeFile(tmp, JSON.stringify(lock, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
	await rename(tmp, lockPath());
	return lock;
}

/**
 * 解析来源。
 * 支持 `https://github.com/<owner>/<repo>[/tree/<ref>[/<subPath>]]` 与本地 `.tar.gz` 路径。
 */
export function parseSkillSource(input) {
	const raw = String(input ?? "").trim();
	if (raw === "") throw new Error("来源不能为空");
	if (!/^https?:\/\//i.test(raw)) {
		if (!/\.(tar\.gz|tgz)$/i.test(raw)) throw new Error("本地来源只支持 .tar.gz / .tgz：" + raw);
		return { kind: "tarball", path: raw, ref: "", subPath: "" };
	}
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("看不懂的来源：" + raw);
	}
	if (!/(^|\.)github\.com$/i.test(url.hostname)) throw new Error("只支持 GitHub 仓库地址或本地 tarball");
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length < 2) throw new Error("GitHub 地址要带 owner/repo");
	const owner = parts[0];
	const repo = parts[1].replace(/\.git$/i, "");
	let ref = "HEAD";
	let subPath = "";
	if (parts[2] === "tree" && typeof parts[3] === "string" && parts[3] !== "") {
		ref = decodeURIComponent(parts[3]);
		subPath = parts.slice(4).map((p) => decodeURIComponent(p)).join("/");
	}
	return {
		kind: "github",
		owner,
		repo,
		ref,
		subPath,
		url: `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`
	};
}

async function loadSourceBytes(parsed) {
	if (parsed.kind === "tarball") return readFile(parsed.path);
	const response = await fetchWithTimeout(parsed.url, {}, 60_000);
	if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）：${parsed.url}`);
	return Buffer.from(await response.arrayBuffer());
}

/**
 * 在包内找 SKILL.md 的根。
 * tarball 顶层一般包一层 `<repo>-<ref>/`，先剥掉；再按 subPath 收窄，找不到就取第一个 SKILL.md。
 */
export function findSkillRoot(entries, subPath = "") {
	const list = Array.isArray(entries) ? entries : [];
	if (list.length === 0) return null;
	const firstSeg = list[0].rel.split("/")[0];
	const stripped = list.map((e) => ({
		rel: e.rel.startsWith(firstSeg + "/") ? e.rel.slice(firstSeg.length + 1) : e.rel,
		data: e.data
	}));
	const prefix = String(subPath ?? "").replace(/^\/+|\/+$/g, "");
	const inScope = prefix === "" ? stripped : stripped.filter((e) => e.rel === prefix || e.rel.startsWith(prefix + "/"));
	const pick = inScope.find((e) => e.rel === (prefix === "" ? "SKILL.md" : prefix + "/SKILL.md")) ?? inScope.find((e) => e.rel.endsWith("/SKILL.md") || e.rel === "SKILL.md");
	if (pick === undefined) return null;
	const rootRel = pick.rel === "SKILL.md" ? "" : pick.rel.slice(0, -"/SKILL.md".length);
	const files = inScope
		.filter((e) => (rootRel === "" ? true : e.rel.startsWith(rootRel + "/")))
		.map((e) => ({ rel: rootRel === "" ? e.rel : e.rel.slice(rootRel.length + 1), data: e.data }))
		.filter((e) => e.rel !== "");
	return { rootRel, files, skillText: pick.data.toString("utf8") };
}

/** 从 SKILL.md 正文里取 frontmatter name，取不到就用目录名。 */
export function skillNameOf(found) {
	const text = String(found?.skillText ?? "").replace(/^\uFEFF/, "");
	const name = text.match(/^---\r?\n[\s\S]*?^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
	const fallback = found?.rootRel ? basename(found.rootRel) : "";
	return (name && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ? name : fallback) || "imported-skill";
}

/**
 * 一条 lock 记录（U-3）：source 只存仓库根 URL，子目录单独结构化进 subPath，
 * 与快照导出（lib/snapshot.js 的 resolveSkillSource）用同一套字段口径。
 * 旧记录里 source 是完整 tree URL 也照样能读 —— 读侧用 lib/paths.js 的 splitSourceUrl 归一。
 */
export function lockRecordFor(parsed, { sha256, now = Date.now() }) {
	return {
		source: parsed?.kind === "tarball" ? String(parsed.path ?? "") : `https://github.com/${parsed.owner}/${parsed.repo}`,
		ref: parsed?.ref ?? "",
		sha256,
		at: new Date(now).toISOString(),
		subPath: parsed?.subPath ?? ""
	};
}

/**
 * 导入一个 skill。
 * @param {{source:string, targetDir:string, now?:number}} options
 * @returns {Promise<{ok:boolean,name:string,changed:boolean,sha256:string,files?:number}>}
 */
export async function importSkill({ source, targetDir, now = Date.now() }) {
	const parsed = parseSkillSource(source);
	if (typeof targetDir !== "string" || targetDir === "") throw new Error("没有可写的目标目录（agentSkillDir）");
	const bytes = await loadSourceBytes(parsed);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const found = findSkillRoot(unpackTarGz(bytes), parsed.subPath);
	if (found === null) throw new Error("这个包里没有 SKILL.md");
	const name = skillNameOf(found);
	const lock = await loadLock();
	const prev = lock[name];
	if (prev !== undefined && prev.sha256 === sha256 && String(prev.ref ?? "") === String(parsed.ref ?? "")) {
		return { ok: true, name, changed: false, sha256, message: "同 ref 内容没有变化，跳过" };
	}
	const dest = join(resolve(targetDir), name);
	for (const file of found.files) {
		const target = join(dest, file.rel);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, file.data);
	}
	lock[name] = lockRecordFor(parsed, { sha256, now });
	await saveLock(lock);
	return { ok: true, name, changed: true, sha256, files: found.files.length, path: dest };
}
