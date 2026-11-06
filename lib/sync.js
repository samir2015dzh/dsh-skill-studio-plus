/**
 * 同步通道：把最新快照推到远端，或从远端取回来。
 *
 * 四条通道统一两个动作：
 *   push(channel, config, snapshotId)  → 上传（{ channel, snapshotId, pushed }）
 *   pull(channel, config)              → 取回并落成一份本地快照
 *
 * 配置在 `~/.dsh/dsh-studio/sync.json`，结构：
 *   { channel: "git" | "webdav" | "gist" | "s3", git: {...}, webdav: {...}, ... }
 *
 * 凭据只从这份文件读，不进快照（collectFiles 的白名单里没有 sync.json）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, createHmac } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);
const dshHome = () => resolve(homedir(), ".dsh");
const syncFile = () => resolve(dshHome(), "dsh-studio", "sync.json");
const snapshotsDir = () => resolve(dshHome(), "dsh-studio", "snapshots");

const CHANNELS = ["git", "webdav", "gist", "s3"];
const DEFAULT_SYNC = { channel: "git", git: {}, webdav: {}, gist: {}, s3: {} };

async function pathExists(p) {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

export async function loadSync() {
	try {
		const parsed = JSON.parse(await readFile(syncFile(), "utf8"));
		const out = { ...DEFAULT_SYNC };
		out.channel = CHANNELS.includes(parsed?.channel) ? parsed.channel : "git";
		for (const name of CHANNELS) {
			out[name] = typeof parsed?.[name] === "object" && parsed[name] !== null ? parsed[name] : {};
		}
		return out;
	} catch {
		return { ...DEFAULT_SYNC };
	}
}

export async function saveSync(patch = {}) {
	const current = await loadSync();
	const next = { ...current };
	if (CHANNELS.includes(patch.channel)) next.channel = patch.channel;
	for (const name of CHANNELS) {
		if (typeof patch[name] === "object" && patch[name] !== null) next[name] = { ...current[name], ...patch[name] };
	}
	await mkdir(dirname(syncFile()), { recursive: true });
	await writeFile(syncFile(), JSON.stringify(next, null, 2), "utf8");
	return next;
}

/** 打一次超时上限，网络慢时不至于挂死。 */
const TIMEOUT_MS = 30_000;

async function httpJson(url, init = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		const text = await response.text();
		if (!response.ok) throw new Error(`HTTP ${response.status} · ${text.slice(0, 200)}`);
		return text === "" ? null : JSON.parse(text);
	} finally {
		clearTimeout(timer);
	}
}

// ── Git 通道 ──────────────────────────────────────────────────────────────

async function git(workDir, args) {
	const { stdout } = await execFileAsync("git", args, {
		cwd: workDir,
		timeout: 120_000,
		windowsHide: true,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
	});
	return String(stdout).trim();
}

async function gitSync(config) {
	const work = typeof config.workDir === "string" && config.workDir !== ""
		? resolve(config.workDir)
		: resolve(dshHome(), "dsh-studio", "sync-work");
	const remote = typeof config.remote === "string" ? config.remote.trim() : "";
	return { work, remote };
}

/**
 * 确保工作副本存在且指向远端的最新提交。
 *
 * 不用 `git clone`：空仓库（bare 但没有任何 commit）clone 出来没有 HEAD，
 * 之后的 `git pull --ff-only` 会报 "no tracking information"。改成
 * init → remote add → fetch → 有分支才 checkout，空仓库就停在未跟踪状态，
 * 等第一次 push 再建分支。
 */
async function gitEnsureWork(config) {
	const { work, remote } = await gitSync(config);
	const hasGit = await pathExists(join(work, ".git"));
	if (!hasGit) {
		if (remote === "") throw new Error("Git 通道需要 remote（仓库地址）");
		await rm(work, { recursive: true, force: true });
		await mkdir(work, { recursive: true });
		await git(work, ["init"]);
		await git(work, ["remote", "add", "origin", remote]);
	}

	// 远端可能连不上、也可能是空仓库，两种情况都不该让调用方炸
	const fetched = await git(work, ["fetch", "origin"])
		.then(() => true)
		.catch(() => false);
	if (!fetched) return work;

	// 远端有分支就跟上（优先 origin 的默认分支）
	let branch = await git(work, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])
		.then((out) => out.replace("origin/", "").trim())
		.catch(() => "");
	if (branch === "") {
		const remotes = await git(work, ["branch", "-r"]).catch(() => "");
		const line = remotes
			.split(/\r?\n/)
			.map((s) => s.trim())
			.find((s) => s.startsWith("origin/") && !s.endsWith("/HEAD"));
		branch = line === undefined ? "" : line.replace("origin/", "");
	}
	if (branch !== "") {
		await git(work, ["checkout", "-B", branch, `origin/${branch}`]).catch(() => {});
	}
	return work;
}

/** commit 兜底：机器上没配 user.name/email 时不让提交失败。 */
const COMMIT_IDENTITY = ["-c", "user.name=dsh-studio", "-c", "user.email=dsh-studio@local"];

async function gitPush(config, snapshotId) {
	const work = await gitEnsureWork(config);
	const src = join(snapshotsDir(), snapshotId);
	await cp(join(src, "config.tar.gz"), join(work, "config.tar.gz"));
	await cp(join(src, "manifest.json"), join(work, "manifest.json"));
	await writeFile(join(work, "LATEST"), snapshotId + "\n", "utf8");
	await git(work, ["add", "-A"]);
	const status = await git(work, ["status", "--porcelain"]);
	if (status === "") return { channel: "git", snapshotId, pushed: false, note: "远端已经是最新的" };
	await git(work, [...COMMIT_IDENTITY, "commit", "-m", `sync: ${snapshotId}`]);
	// 空仓库第一次 push 要带 -u 建上游，之后才能 pull --ff-only
	const branch = await git(work, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "master");
	await git(work, ["push", "-u", "origin", branch === "HEAD" ? "master" : branch]);
	return { channel: "git", snapshotId, pushed: true };
}

async function gitPull(config) {
	const work = await gitEnsureWork(config);
	const latest = (await readFile(join(work, "LATEST"), "utf8")).trim();
	return { archive: await readFile(join(work, "config.tar.gz")), manifest: JSON.parse(await readFile(join(work, "manifest.json"), "utf8")), remoteId: latest };
}

// ── Gist 通道 ─────────────────────────────────────────────────────────────

async function gistPush(config, snapshotId) {
	const token = typeof config.token === "string" ? config.token.trim() : "";
	if (token === "") throw new Error("Gist 通道需要 token");
	const src = join(snapshotsDir(), snapshotId);
	const archive = await readFile(join(src, "config.tar.gz"));
	const manifest = await readFile(join(src, "manifest.json"), "utf8");
	const files = {
		"config.tar.gz": { content: archive.toString("base64") },
		"manifest.json": { content: manifest },
		"LATEST": { content: snapshotId + "\n" }
	};
	const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };
	const existing = typeof config.gistId === "string" ? config.gistId.trim() : "";
	if (existing === "") {
		const created = await httpJson("https://api.github.com/gists", {
			method: "POST",
			headers,
			body: JSON.stringify({ description: `dsh-studio 配置快照 ${snapshotId}`, public: false, files })
		});
		return { channel: "gist", snapshotId, pushed: true, gistId: created.id, created: true };
	}
	await httpJson(`https://api.github.com/gists/${existing}`, {
		method: "PATCH",
		headers,
		body: JSON.stringify({ description: `dsh-studio 配置快照 ${snapshotId}`, files })
	});
	return { channel: "gist", snapshotId, pushed: true, gistId: existing, created: false };
}

/**
 * 从 Gist 元数据里读一个文件的**原文**。
 *
 * GitHub 的 Gist 只存文本：`files[].content` 是文件原文（不是 base64）。
 * 超过 ~900 KB 时 content 会被截断（`truncated: true`，实测 1.5 MB 的文件 content 只给 921600 字符），
 * 这时要走 `raw_url` —— 它返回的也是**原文文本**（content-type: text/plain），不是二进制。
 */
async function readGistText(meta, name, token) {
	const file = meta?.files?.[name];
	if (file === undefined) throw new Error(`这个 Gist 里没有 ${name}`);
	if (file.truncated === true && typeof file.raw_url === "string") {
		const response = await fetch(file.raw_url, { headers: { Authorization: `Bearer ${token}` } });
		if (!response.ok) throw new Error(`读取 ${name} 的 raw_url 失败（HTTP ${response.status}）`);
		return await response.text();
	}
	return String(file.content ?? "");
}

async function gistPull(config) {
	const token = typeof config.token === "string" ? config.token.trim() : "";
	const gistId = typeof config.gistId === "string" ? config.gistId.trim() : "";
	if (token === "" || gistId === "") throw new Error("Gist 通道需要 token 与 gistId");
	const meta = await httpJson(`https://api.github.com/gists/${gistId}`, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
	});
	// config.tar.gz 是二进制，push 时编成了 base64 存进去，读回来要解回去
	const archiveB64 = await readGistText(meta, "config.tar.gz", token);
	const archive = Buffer.from(archiveB64, "base64");
	// manifest.json 与 LATEST 是纯文本，直接读，不做 base64 解码
	const manifestRaw = await readGistText(meta, "manifest.json", token);
	let manifest;
	try {
		manifest = JSON.parse(manifestRaw);
	} catch {
		throw new Error("Gist 里的 manifest.json 不是合法 JSON（可能是空文件或损坏）");
	}
	const remoteId = (await readGistText(meta, "LATEST", token)).trim();
	return { archive, manifest, remoteId };
}

// ── WebDAV 通道 ───────────────────────────────────────────────────────────

function webdavHeaders(config) {
	const headers = {};
	if (typeof config.username === "string" && config.username !== "") {
		const pair = `${config.username}:${config.password ?? ""}`;
		headers.Authorization = "Basic " + Buffer.from(pair, "utf8").toString("base64");
	}
	return headers;
}

async function webdavBase(config) {
	const base = typeof config.url === "string" ? config.url.trim().replace(/\/+$/, "") : "";
	if (base === "") throw new Error("WebDAV 通道需要 url（例如 https://dav.example.com/dsh）");
	return base;
}

async function webdavPush(config, snapshotId) {
	const base = await webdavBase(config);
	const headers = webdavHeaders(config);
	const src = join(snapshotsDir(), snapshotId);
	for (const name of ["config.tar.gz", "manifest.json"]) {
		const data = await readFile(join(src, name));
		const response = await fetch(`${base}/${name}`, {
			method: "PUT",
			headers: { ...headers, "Content-Type": "application/octet-stream" },
			body: data
		});
		if (!response.ok) throw new Error(`PUT ${name} → HTTP ${response.status}`);
	}
	await fetch(`${base}/LATEST`, { method: "PUT", headers, body: snapshotId + "\n" });
	return { channel: "webdav", snapshotId, pushed: true };
}

async function webdavPull(config) {
	const base = await webdavBase(config);
	const headers = webdavHeaders(config);
	const latestRes = await fetch(`${base}/LATEST`, { headers });
	if (!latestRes.ok) throw new Error(`远端没有 LATEST（HTTP ${latestRes.status}）`);
	const remoteId = (await latestRes.text()).trim();
	const archiveRes = await fetch(`${base}/config.tar.gz`, { headers });
	if (!archiveRes.ok) throw new Error(`读取 config.tar.gz 失败（HTTP ${archiveRes.status}）`);
	const manifestRes = await fetch(`${base}/manifest.json`, { headers });
	const manifest = manifestRes.ok ? JSON.parse(await manifestRes.text()) : { files: [] };
	return { archive: Buffer.from(await archiveRes.arrayBuffer()), manifest, remoteId };
}

// ── S3 通道（SigV4，path-style） ──────────────────────────────────────────

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** S3 要求的键路径编码：保留 `/`，其余按 RFC 3986 编码。 */
const encodeKey = (key) => key.split("/").map((seg) => encodeURIComponent(seg)).join("/");

function s3Endpoint(config) {
	const endpoint = typeof config.endpoint === "string" ? config.endpoint.trim().replace(/\/+$/, "") : "";
	const bucket = typeof config.bucket === "string" ? config.bucket.trim() : "";
	if (endpoint === "" || bucket === "") throw new Error("S3 通道需要 endpoint 与 bucket");
	return { endpoint, bucket };
}

/**
 * 生成 SigV4 签名的请求头。
 * 只实现 PUT/GET 两种方法 + 无 query 的 path-style 请求，够本插件用。
 */
function s3SignedHeaders(config, method, key, body, region) {
	const { endpoint, bucket } = s3Endpoint(config);
	const accessKey = String(config.accessKey ?? "");
	const secretKey = String(config.secretKey ?? "");
	if (accessKey === "" || secretKey === "") throw new Error("S3 通道需要 accessKey 与 secretKey");

	const url = new URL(`${endpoint}/${bucket}/${encodeKey(key)}`);
	const host = url.host;
	const path = url.pathname;
	const now = new Date();
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
	const dateStamp = amzDate.slice(0, 8);
	const payloadHash = sha256Hex(body ?? Buffer.alloc(0));

	const headers = {
		host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date": amzDate
	};
	const sortedKeys = Object.keys(headers).sort();
	const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join("");
	const signedHeaders = sortedKeys.join(";");
	const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
	const scope = `${dateStamp}/${region}/s3/aws4_request`;
	const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
	const kDate = hmac("AWS4" + secretKey, dateStamp);
	const kRegion = hmac(kDate, region);
	const kService = hmac(kRegion, "s3");
	const kSigning = hmac(kService, "aws4_request");
	const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

	return {
		url: url.toString(),
		headers: {
			...headers,
			Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
		}
	};
}

async function s3Request(config, method, key, body) {
	const region = typeof config.region === "string" && config.region !== "" ? config.region : "us-east-1";
	const signed = s3SignedHeaders(config, method, key, body, region);
	const response = await fetch(signed.url, { method, headers: signed.headers, body });
	return response;
}

async function s3Push(config, snapshotId) {
	const src = join(snapshotsDir(), snapshotId);
	for (const name of ["config.tar.gz", "manifest.json"]) {
		const data = await readFile(join(src, name));
		const response = await s3Request(config, "PUT", name, data);
		if (!response.ok) throw new Error(`PUT ${name} → HTTP ${response.status} · ${(await response.text()).slice(0, 160)}`);
	}
	await s3Request(config, "PUT", "LATEST", Buffer.from(snapshotId + "\n", "utf8"));
	return { channel: "s3", snapshotId, pushed: true };
}

async function s3Pull(config) {
	const latestRes = await s3Request(config, "GET", "LATEST");
	if (!latestRes.ok) throw new Error(`远端没有 LATEST（HTTP ${latestRes.status}）`);
	const remoteId = (await latestRes.text()).trim();
	const archiveRes = await s3Request(config, "GET", "config.tar.gz");
	if (!archiveRes.ok) throw new Error(`读取 config.tar.gz 失败（HTTP ${archiveRes.status}）`);
	const manifestRes = await s3Request(config, "GET", "manifest.json");
	const manifest = manifestRes.ok ? JSON.parse(await manifestRes.text()) : { files: [] };
	return { archive: Buffer.from(await archiveRes.arrayBuffer()), manifest, remoteId };
}

// ── 统一入口 ──────────────────────────────────────────────────────────────

/** 把一份本地快照推到当前通道。 */
export async function pushSnapshot(channel, config, snapshotId) {
	if (!CHANNELS.includes(channel)) throw new Error(`未知通道：${channel}`);
	if (!(await pathExists(join(snapshotsDir(), snapshotId, "config.tar.gz")))) throw new Error(`快照不存在：${snapshotId}`);
	if (channel === "git") return gitPush(config, snapshotId);
	if (channel === "gist") return gistPush(config, snapshotId);
	if (channel === "webdav") return webdavPush(config, snapshotId);
	if (channel === "s3") return s3Push(config, snapshotId);
	throw new Error(`未知通道：${channel}`);
}

/** 从当前通道取回，落成一份本地快照（不写配置）。 */
export async function pullSnapshot(channel, config, label = "pulled") {
	if (!CHANNELS.includes(channel)) throw new Error(`未知通道：${channel}`);
	let result;
	if (channel === "git") result = await gitPull(config);
	else if (channel === "gist") result = await gistPull(config);
	else if (channel === "webdav") result = await webdavPull(config);
	else if (channel === "s3") result = await s3Pull(config);
	else throw new Error(`未知通道：${channel}`);

	const stamp = (() => {
		const d = new Date();
		const p = (n) => String(n).padStart(2, "0");
		return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, "0")}`;
	})();
	const safeLabel = String(label).replace(/[^\w.-]+/g, "_").slice(0, 60) || "pulled";
	const id = `${stamp}-${safeLabel}`;
	const dir = join(snapshotsDir(), id);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "config.tar.gz"), result.archive);
	const files = Array.isArray(result.manifest?.files) ? result.manifest.files : [];
	await writeFile(join(dir, "manifest.json"), JSON.stringify({ id, label, at: Date.now(), archiveBytes: result.archive.length, files, pulled: true }, null, 2), "utf8");
	return { channel, id, files: files.length, bytes: result.archive.length, remoteId: result.remoteId ?? "" };
}
