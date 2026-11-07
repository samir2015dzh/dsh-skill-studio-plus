/**
 * 配置快照：把 `~/.dsh` 里该备份的配置文件收集起来，打成 tar.gz；
 * 恢复时先给当前状态打一份、再逐文件覆盖，SHA 不符的跳过并报告。
 *
 * 设计取舍：
 *   - tar.gz 而不是 zip：Node 只有 zlib，手写 tar 头 512 字节比写 ZIP 中央目录简单得多，
 *     解压也不依赖外部命令。
 *   - 白名单而不是黑名单：`~/.dsh` 里有 sessions（几百 MB）、node_modules、asar 缓存，
 *     按黑名单迟早漏；白名单列不全时最多是少备份，不会把会话日志塞进备份包。
 *   - 密钥永远不进去：`.credentials.yaml` 与它所在目录一律跳过，不看调用方参数；
 *     白名单目录里含密钥的 JSON（extractor.json 的 llmApiKey、mcp.json 的
 *     Authorization / env 密钥）在打包时按字段换成占位符，恢复时不覆盖目标机现值。
 */
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { CREDENTIAL_FILE_MODE, hardenPermissions } from "./fs-perms.js";
import { assertSnapshotId, isSafeEntryPath } from "./paths.js";
import { SENSITIVE_KEY } from "./redact.js";

/** DSH 根目录。 */
const dshHome = () => resolve(homedir(), ".dsh");
/** 快照仓库。 */
export const snapshotsDir = () => resolve(dshHome(), "dsh-studio", "snapshots");

/** 永远不进快照：密钥、会话日志、依赖、asar。 */
const ALWAYS_SKIP = [/\.credentials\.yaml$/i, /(^|[\\/])node_modules([\\/]|$)/, /(^|[\\/])sessions([\\/]|$)/, /\.asar(\.unpacked)?$/i];

/** 脱敏占位符：包内看到它就知道「这里原本有值，但不在这里」。恢复时不会写回。 */
export const REDACTED = "__dsh_studio_redacted__";

/** 会被字段级脱敏的配置文件（相对 `~/.dsh`）。 */
export const CREDENTIAL_FILES = new Set(["dsh-studio/extractor.json", "dsh-studio/mcp.json"]);

// 凭据键名与 mcp.js / index.js 共用 lib/redact.js 那一份（C-5），不再各写一遍

/** 包内脱敏说明文件；恢复时不写回 `~/.dsh`。 */
export const REDACTED_NOTE = "REDACTED.json";

/** 包内「被跳过的大文件」说明（C-2）；同样不写回 `~/.dsh`。 */
export const SKIPPED_NOTE = "SKIPPED.json";

/**
 * 把一份配置 JSON 里的凭据字段就地换成占位符，返回被脱敏的字段路径。
 * 只按**键名**判定，看不出来历的字符串不会被误伤；原本为空的值不算命中。
 */
export function redactCredentials(node, path = "") {
	const hits = [];
	if (Array.isArray(node)) {
		node.forEach((v, i) => hits.push(...redactCredentials(v, `${path}[${i}]`)));
		return hits;
	}
	if (node === null || typeof node !== "object") return hits;
	for (const [key, value] of Object.entries(node)) {
		const here = path === "" ? key : `${path}.${key}`;
		if (typeof value === "string" && value !== "" && SENSITIVE_KEY.test(key)) {
			node[key] = REDACTED;
			hits.push(here);
		} else hits.push(...redactCredentials(value, here));
	}
	return hits;
}

/**
 * 把包内 JSON 的占位符换回目标机现值；目标机也没有就不留这个键。
 * 数组按元素 `name` 对齐（mcp.json 的 servers 顺序可能不同），其余按索引。
 */
export function mergeRedacted(incoming, current) {
	if (incoming === REDACTED) return typeof current === "string" && current !== "" ? current : undefined;
	if (Array.isArray(incoming)) {
		const base = Array.isArray(current) ? current : [];
		const byName = new Map(
			base.filter((x) => x !== null && typeof x === "object" && typeof x.name === "string").map((x) => [x.name, x])
		);
		const out = [];
		incoming.forEach((value, i) => {
			const peer = value !== null && typeof value === "object" && typeof value.name === "string" && byName.has(value.name) ? byName.get(value.name) : base[i];
			const merged = mergeRedacted(value, peer);
			if (merged !== undefined) out.push(merged);
		});
		return out;
	}
	if (incoming !== null && typeof incoming === "object") {
		const base = current !== null && typeof current === "object" && !Array.isArray(current) ? current : {};
		const out = {};
		for (const [key, value] of Object.entries(incoming)) {
			const merged = mergeRedacted(value, base[key]);
			if (merged !== undefined) out[key] = merged;
		}
		return out;
	}
	return incoming;
}

/** 恢复时把包内凭据文件与目标机现值合并（占位符绝不写回）。 */
async function mergeCredentialFile(target, incoming) {
	let parsed;
	try {
		parsed = JSON.parse(incoming.toString("utf8"));
	} catch {
		return incoming; // 坏 JSON 原样写回：解析不了就没法判断哪些是占位符
	}
	let current = null;
	try {
		current = JSON.parse(await readFile(target, "utf8"));
	} catch {
		current = null;
	}
	return Buffer.from(JSON.stringify(mergeRedacted(parsed, current), null, 2) + "\n", "utf8");
}

/** 白名单：相对 `~/.dsh` 的路径。dir 表示整目录，profiles 表示只取两个文件。 */
const WHITELIST = [
	{ rel: "cordis.patch.yml", kind: "file" },
	{ rel: "AGENTS.md", kind: "file" },
	{ rel: "skills", kind: "dir" },
	{
		rel: "dsh-studio",
		kind: "dir",
		// snapshots 是快照自己（递归）、sync-work 是 git 工作副本（含 .git）、
		// sync.json 存 gist token / s3 secretKey 明文 —— 三者都不能进快照
		skip: ["snapshots", "sync-work", "sync.json"]
	},
	{ rel: "profiles", kind: "profiles" }
];

function shouldSkip(relPath) {
	const normalized = relPath.split(sep).join("/");
	return ALWAYS_SKIP.some((re) => re.test(normalized));
}

/**
 * 主 skill 库（extractor.json 的 agentSkillDir）可能落在 `~/.dsh` 之外 ——
 * 真机就是 `~/.agents/skills`。这类目录在快照里统一挂到 `agents-skills/` 前缀下，
 * 恢复时再落回原处，避免把 `..` 塞进 tar 让 isSafeEntryPath 拒收（WO-FIX-8）。
 */
const EXTERNAL_SKILL_PREFIX = "agents-skills/";
/** 外部 skill 库在用户 home 下的落点。 */
const externalSkillTarget = () => resolve(homedir(), ".agents", "skills");

/** 快照内路径 → 恢复目标绝对路径。外部前缀的落点由调用方传入（C-1）。 */
function restoreTarget(rel, dshRoot, externalRoot = externalSkillTarget()) {
	if (rel.startsWith(EXTERNAL_SKILL_PREFIX)) return join(externalRoot, rel.slice(EXTERNAL_SKILL_PREFIX.length));
	return join(dshRoot, rel);
}

/**
 * 恢复时外部 skill 库该落到哪（C-1）：跟着 extractor.json 的 agentSkillDir 走，
 * 不再写死 `~/.agents/skills`。配置缺失或指向 `~/.dsh` 内部时退回默认值。
 */
async function externalSkillTargetFromConfig(home) {
	let cfg;
	try {
		cfg = JSON.parse(await readFile(join(home, "dsh-studio", "extractor.json"), "utf8"));
	} catch {
		return null;
	}
	const dir = typeof cfg?.agentSkillDir === "string" ? cfg.agentSkillDir.trim() : "";
	if (dir === "") return null;
	const abs = resolve(dir);
	const rel = relative(home, abs);
	if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return null;
	return abs;
}

/**
 * 读 extractor.json 的 agentSkillDir，返回落在 `~/.dsh` 之外、且真实存在的目录。
 * 路径跟随配置值，不写死；`~/.dsh` 内的目录已由 `skills` 白名单覆盖，不重复打包。
 */
async function externalSkillDir(home) {
	let cfg;
	try {
		cfg = JSON.parse(await readFile(join(home, "dsh-studio", "extractor.json"), "utf8"));
	} catch {
		return null;
	}
	const dir = typeof cfg?.agentSkillDir === "string" ? cfg.agentSkillDir.trim() : "";
	if (dir === "") return null;
	const abs = resolve(dir);
	const rel = relative(home, abs);
	if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return null;
	return (await pathExists(abs)) ? abs : null;
}

async function pathExists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
async function isDir(path) {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** 递归收集一个目录下的普通文件，返回相对传入根的 POSIX 路径。 */
async function walkDir(root, base = root, out = []) {
	let entries;
	try {
		entries = await readdir(base, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(base, entry.name);
		const rel = relative(root, full);
		if (shouldSkip(join(root, rel))) continue;
		if (entry.isDirectory()) await walkDir(root, full, out);
		else if (entry.isFile()) out.push(rel.split(sep).join("/"));
	}
	return out;
}

/**
 * 按白名单收集要备份的文件。
 * @returns {Promise<Array<{rel: string, abs: string, bytes: number, sha: string}>>}
 */
export async function collectFiles(options = {}) {
	const home = dshHome();
	const found = [];
	// C-2：单文件上限只作用于两个 skill 根，配置/数据文件不受限；0 = 不过滤
	const maxSkillFileBytes = Number.isFinite(Number(options.maxSkillFileBytes)) ? Number(options.maxSkillFileBytes) : 0;
	const skipped = Array.isArray(options.skipped) ? options.skipped : null;
	const isSkillRel = (rel) => rel === "skills" || rel.startsWith("skills/") || rel.startsWith(EXTERNAL_SKILL_PREFIX);
	const add = async (absPath, relPath) => {
		if (shouldSkip(relPath)) return;
		if (!(await pathExists(absPath))) return;
		const info = await stat(absPath);
		if (!info.isFile()) return;
		const buf = await readFile(absPath);
		if (skipped !== null && maxSkillFileBytes > 0 && isSkillRel(relPath) && buf.length > maxSkillFileBytes) {
			skipped.push({ path: relPath, size: buf.length, sha: createHash("sha256").update(buf).digest("hex") });
			return;
		}
		found.push({
			rel: relPath,
			abs: absPath,
			bytes: buf.length,
			sha: createHash("sha256").update(buf).digest("hex"),
			// OPT-05：Buffer 一并带回去。createSnapshot 用这份数据打包，不再二次读盘，
			// manifest 里记的 sha 也就不会和包内容对不上（TOCTOU）。
			data: buf
		});
	};
	for (const entry of WHITELIST) {
		const abs = join(home, entry.rel);
		if (entry.kind === "file") {
			await add(abs, entry.rel);
			continue;
		}
		if (entry.kind === "dir") {
			if (!(await isDir(abs))) continue;
			const skip = new Set(entry.skip ?? []);
			for (const rel of await walkDir(abs)) {
				const top = rel.split("/")[0];
				if (skip.has(top)) continue;
				await add(join(abs, rel), join(entry.rel, rel).split(sep).join("/"));
			}
			continue;
		}
		if (entry.kind === "profiles") {
			let names = [];
			try {
				names = (await readdir(abs, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
			} catch {
				continue;
			}
			for (const name of names) {
				for (const file of ["package.json", "cordis.patch.yml"]) {
					await add(join(abs, name, file), `${entry.rel}/${name}/${file}`);
				}
			}
		}
	}
	// WO-FIX-8：主 skill 库在 ~/.dsh 之外时（真机是 ~/.agents/skills），单独挂到
	// agents-skills/ 前缀下，恢复时由 restoreTarget 落回原处。
	const external = await externalSkillDir(home);
	if (external !== null) {
		for (const rel of await walkDir(external)) {
			await add(join(external, rel), EXTERNAL_SKILL_PREFIX + rel);
		}
	}
	return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * 只数「会被打进快照的文件有多少个」（OPT-03）。
 * 面板的 GET /snapshot 原来为了一个数字调 collectFiles：把所有文件读一遍、算 sha、
 * 还把 Buffer 留在内存里。真机 1830 个文件、129 MB，一次列表就顶一次全量读盘。
 */
export async function countFiles() {
	const home = dshHome();
	let count = 0;
	const hit = (relPath) => {
		if (!shouldSkip(relPath)) count += 1;
	};
	for (const entry of WHITELIST) {
		const abs = join(home, entry.rel);
		if (entry.kind === "file") {
			if (await pathExists(abs)) hit(entry.rel);
			continue;
		}
		if (entry.kind === "dir") {
			if (!(await isDir(abs))) continue;
			const skip = new Set(entry.skip ?? []);
			for (const rel of await walkDir(abs)) {
				if (skip.has(rel.split("/")[0])) continue;
				hit(join(entry.rel, rel).split(sep).join("/"));
			}
			continue;
		}
		if (entry.kind === "profiles") {
			let names = [];
			try {
				names = (await readdir(abs, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
			} catch {
				continue;
			}
			for (const name of names) {
				for (const file of ["package.json", "cordis.patch.yml"]) {
					if (await pathExists(join(abs, name, file))) hit(`${entry.rel}/${name}/${file}`);
				}
			}
		}
	}
	const external = await externalSkillDir(home);
	if (external !== null) {
		for (const rel of await walkDir(external)) hit(EXTERNAL_SKILL_PREFIX + rel);
	}
	return count;
}

// ── 最小 tar 写入 / 读取（ustar + GNU longname，只处理普通文件） ────────────

/** GNU tar 的 longname 扩展头在 name 字段里的固定占位。 */
const GNU_LONGNAME = "././@LongLink";
/** 路径硬上限：超过就没法在 tar 里可靠表达，直接报错而不是写坏文件名。 */
const TAR_PATH_LIMIT = 4096;

/** 填 ustar 头的公共字段并算 checksum。 */
function sealHeader(header, size, mtimeSeconds, typeflag) {
	const octal = (value, width) => value.toString(8).padStart(width - 1, "0") + "\0";
	Buffer.from(octal(0o644, 8), "ascii").copy(header, 100); // mode
	Buffer.from(octal(0, 8), "ascii").copy(header, 108); // uid
	Buffer.from(octal(0, 8), "ascii").copy(header, 116); // gid
	Buffer.from(octal(size, 12), "ascii").copy(header, 124); // size
	Buffer.from(octal(mtimeSeconds, 12), "ascii").copy(header, 136); // mtime
	header.fill(32, 148, 156); // checksum 先填空格
	header[156] = typeflag;
	Buffer.from("ustar\0", "ascii").copy(header, 257);
	Buffer.from("00", "ascii").copy(header, 263);
	let sum = 0;
	for (let i = 0; i < 512; i += 1) sum += header[i];
	Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ", "ascii").copy(header, 148);
	return header;
}

/**
 * ustar 头。装得下就返回头，装不下返回 null，由调用方补 GNU longname 扩展头。
 *
 * prefix(155) + name(100) 必须**双向**满足：从右往左找第一个既能塞进 prefix、
 * 又能让剩余段塞进 name 的斜杠。旧实现只取 lastIndexOf(47, 155)，剩余段超过
 * 100 字节时 copy() 会静默截断，还可能截在 UTF-8 多字节中间（BUG-08）。
 */
function tarHeader(name, size, mtimeSeconds) {
	const header = Buffer.alloc(512, 0);
	const nameBuf = Buffer.from(name, "utf8");
	if (nameBuf.length <= 100) {
		nameBuf.copy(header, 0);
	} else {
		let split = -1;
		for (let i = Math.min(nameBuf.length - 1, 155); i > 0; i -= 1) {
			if (nameBuf[i] !== 47) continue; // '/'
			if (nameBuf.length - i - 1 <= 100) {
				split = i;
				break;
			}
		}
		if (split <= 0) return null;
		nameBuf.subarray(0, split).copy(header, 345);
		nameBuf.subarray(split + 1).copy(header, 0);
	}
	return sealHeader(header, size, mtimeSeconds, 0x30);
}

/** 把 {rel, data} 列表打成 tar.gz。ustar 装不下的长名走 GNU longname（'L'）扩展头。 */
export function packTarGz(entries) {
	const chunks = [];
	const now = Math.floor(Date.now() / 1000);
	for (const entry of entries) {
		const data = entry.data;
		if (Buffer.byteLength(entry.rel, "utf8") > TAR_PATH_LIMIT) {
			throw new Error(`路径超过 ${TAR_PATH_LIMIT} 字节，拒绝打包（写坏文件名比失败更糟）：${entry.rel.slice(0, 80)}…`);
		}
		let header = tarHeader(entry.rel, data.length, now);
		if (header === null) {
			// 先发一条 'L' 扩展头，正文是完整路径 + NUL；紧接着的真头里 name 只是占位
			const longName = Buffer.from(entry.rel + "\0", "utf8");
			const ext = Buffer.alloc(512, 0);
			Buffer.from(GNU_LONGNAME, "ascii").copy(ext, 0);
			chunks.push(sealHeader(ext, longName.length, now, 0x4c)); // 'L'
			chunks.push(longName);
			const extPad = (512 - (longName.length % 512)) % 512;
			if (extPad > 0) chunks.push(Buffer.alloc(extPad, 0));
			const placeholder = Buffer.alloc(512, 0);
			Buffer.from(entry.rel.split("/").pop() ?? "", "utf8").subarray(0, 100).copy(placeholder, 0);
			header = sealHeader(placeholder, data.length, now, 0x30);
		}
		chunks.push(header);
		chunks.push(data);
		const pad = (512 - (data.length % 512)) % 512;
		if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
	}
	chunks.push(Buffer.alloc(1024, 0)); // 两个空块结束
	return gzipSync(Buffer.concat(chunks), { level: 9 });
}

/** 解开 tar.gz，返回 {rel, data} 列表。识别 GNU longname（'L'）扩展头。 */
export function unpackTarGz(buffer) {
	const raw = gunzipSync(buffer);
	const out = [];
	let offset = 0;
	let pendingLongName = null;
	while (offset + 512 <= raw.length) {
		const header = raw.subarray(offset, offset + 512);
		if (header.every((b) => b === 0)) break;
		const readStr = (start, len) => {
			const slice = header.subarray(start, start + len);
			const end = slice.indexOf(0);
			return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
		};
		const name = readStr(0, 100);
		const prefix = readStr(345, 155);
		const size = parseInt(readStr(124, 12).trim() || "0", 8);
		const type = String.fromCharCode(header[156] || 0x30);
		offset += 512;
		if (type === "L") {
			pendingLongName = raw.subarray(offset, offset + size).toString("utf8").replace(/\0+$/, "");
			offset += Math.ceil(size / 512) * 512;
			continue;
		}
		const rel = pendingLongName !== null ? pendingLongName : prefix === "" ? name : `${prefix}/${name}`;
		pendingLongName = null;
		if (type === "0" || type === "\0") {
			const data = raw.subarray(offset, offset + size);
			out.push({ rel, data: Buffer.from(data) });
		}
		offset += Math.ceil(size / 512) * 512;
	}
	return out;
}

// ── 跨机路径重映射 ────────────────────────────────────────────────────────

/** 看起来是文本吗（有 NUL 或大量控制字符就当二进制，原样不动）。 */
export function isProbablyText(buf) {
	const sample = buf.subarray(0, Math.min(buf.length, 4096));
	if (sample.includes(0)) return false;
	let bad = 0;
	for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) bad += 1;
	return bad / Math.max(1, sample.length) < 0.05;
}

const escapeBackslashes = (s) => s.replace(/\\/g, "\\\\");

/**
 * 按 [{from, to}] 替换文本里的绝对路径前缀。
 * JSON 里的路径是双反斜杠（`C:\\Users\\a`），所以原样和转义两种写法都要替换。
 * @returns {{data: Buffer, changed: boolean}}
 */
export function remapText(buf, pathMap) {
	if (!Array.isArray(pathMap) || pathMap.length === 0) return { data: buf, changed: false };
	if (!isProbablyText(buf)) return { data: buf, changed: false };
	let text = buf.toString("utf8");
	let changed = false;
	for (const pair of pathMap) {
		const from = typeof pair?.from === "string" ? pair.from.trim() : "";
		// to 留空就当没填：替换成空串会把路径删掉，那是数据损坏，不是迁移
		const to = typeof pair?.to === "string" ? pair.to.trim() : "";
		if (from === "" || to === "") continue;
		for (const [source, target] of [
			[from, to],
			[escapeBackslashes(from), escapeBackslashes(to)]
		]) {
			if (!text.includes(source)) continue;
			text = text.split(source).join(target);
			changed = true;
		}
	}
	return { data: changed ? Buffer.from(text, "utf8") : buf, changed };
}

// ── 快照的建立 / 列举 / 恢复 / 清理 ────────────────────────────────────────
// id 与包内路径的闸门已抽到 lib/paths.js（WO-FIX-5），snapshot / trash / sync 共用一份。

function stamp() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	// 带毫秒：同一秒内连建两份不会撞 id（撞了就是后一份覆盖前一份）
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * 建一份快照。
 * @param {string} label 标签，会拼进目录名
 */
export async function createSnapshot(label = "manual") {
	const schedule = await loadSchedule().catch(() => ({ ...DEFAULT_SCHEDULE }));
	// C-2：skill 根下的超大文件不进包，改记进 SKIPPED.json（否则 ~/.agents/skills 里的 GIF/PNG 会把包撑到 100 MB+）
	const skipped = [];
	const files = await collectFiles({ skipped, maxSkillFileBytes: schedule.maxSkillFileBytes });
	if (files.length === 0) throw new Error("白名单里一个文件都没找到，检查 ~/.dsh 是否存在");
	const entries = [];
	const redacted = [];
	const excluded = [];
	for (const file of files) {
		let data = file.data ?? (await readFile(file.abs));
		// 白名单目录里的凭据文件按字段脱敏（WO-SEC-4）：包会被推到 git / gist /
		// webdav / s3，带上活密钥就等于把密钥交出去。只记字段路径，不记原值。
		if (CREDENTIAL_FILES.has(file.rel)) {
			try {
				const parsed = JSON.parse(data.toString("utf8"));
				const hits = redactCredentials(parsed);
				if (hits.length > 0) {
					data = Buffer.from(JSON.stringify(parsed, null, 2) + "\n", "utf8");
					redacted.push({ file: file.rel, fields: hits });
				}
			} catch (error) {
				// C-3：读不懂就没法字段级脱敏 —— 整份排除，不能把可能含明文的原样打进可外推的包
				excluded.push({ file: file.rel, reason: "JSON 解析失败：" + (error instanceof Error ? error.message : String(error)) });
				continue;
			}
		}
		entries.push({ rel: file.rel, data });
	}
	if (redacted.length > 0 || excluded.length > 0) {
		const note = {
			note: "本快照打包时对下列字段做了脱敏，值已替换为占位符；解析失败的文件整份排除。恢复时不会覆盖目标机已有凭据。",
			placeholder: REDACTED,
			redacted,
			excluded
		};
		entries.push({ rel: REDACTED_NOTE, data: Buffer.from(JSON.stringify(note, null, 2) + "\n", "utf8") });
	}
	if (skipped.length > 0) {
		const note = {
			note: "下列 skill 文件超过单文件上限，未打进本快照（可用 snapshot.json 的 maxSkillFileBytes 调整或设 0 关闭）。",
			maxSkillFileBytes: schedule.maxSkillFileBytes,
			skipped
		};
		entries.push({ rel: SKIPPED_NOTE, data: Buffer.from(JSON.stringify(note, null, 2) + "\n", "utf8") });
	}
	const archive = packTarGz(entries);
	// label 只用来拼目录名：清掉非 \w.- 的字符，再截 60 字符（Windows 路径 260 上限）
	const safeLabel = String(label).replace(/[^\w.-]+/g, "_").slice(0, 60) || "manual";
	const id = `${stamp()}-${safeLabel}`;
	const dir = join(snapshotsDir(), id);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "config.tar.gz"), archive);
	const manifest = {
		id,
		label,
		at: Date.now(),
		archiveBytes: archive.length,
		files: entries.map((e) => ({ rel: e.rel, bytes: e.data.length, sha: createHash("sha256").update(e.data).digest("hex") })),
		redacted,
		excluded,
		skipped
	};
	await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
	return manifest;
}

/** 列出所有快照（按时间倒序）。 */
export async function listSnapshots() {
	const root = snapshotsDir();
	let names = [];
	try {
		names = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
	} catch {
		return [];
	}
	const out = [];
	for (const name of names) {
		try {
			const manifest = JSON.parse(await readFile(join(root, name, "manifest.json"), "utf8"));
			out.push({
				id: manifest.id ?? name,
				label: manifest.label ?? "",
				at: manifest.at ?? 0,
				archiveBytes: manifest.archiveBytes ?? 0,
				fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0
			});
		} catch {
			continue;
		}
	}
	return out.sort((a, b) => b.at - a.at);
}

/**
 * 恢复一份快照。
 * @param {string} id 快照 id
 * @param {{dryRun?: boolean, pathMap?: Array<{from: string, to: string}>}} options
 *   dryRun 只算差异不写盘；pathMap 在写盘前把文本里的绝对路径前缀换掉（跨机迁移用）
 */
export async function restoreSnapshot(id, options = {}) {
	const safeId = assertSnapshotId(id);
	const dir = join(snapshotsDir(), safeId);
	const archive = await readFile(join(dir, "config.tar.gz"));
	const entries = unpackTarGz(archive);
	const pathMap = Array.isArray(options.pathMap) ? options.pathMap : [];
	const home = dshHome();
	const plan = [];
	const remapped = [];
	const rejected = [];
	// C-1：外部 skill 库落点跟随 extractor.json 的 agentSkillDir
	const externalRoot = (await externalSkillTargetFromConfig(home)) ?? externalSkillTarget();
	// 先把每个文件的重映射结果算出来，dry-run 与真恢复共用同一份
	const prepared = [];
	for (const entry of entries) {
		// 脱敏说明只是给人看的，不落到 ~/.dsh
		if (entry.rel === REDACTED_NOTE) continue;
		if (entry.rel === SKIPPED_NOTE) continue;
		// 包内路径越权（../ 或绝对路径）直接丢，不进 plan 也不写盘
		if (shouldSkip(entry.rel)) continue;
		if (!isSafeEntryPath(entry.rel)) {
			rejected.push(entry.rel);
			continue;
		}
		const mapped = remapText(entry.data, pathMap);
		if (mapped.changed) remapped.push(entry.rel);
		const data = CREDENTIAL_FILES.has(entry.rel)
			? await mergeCredentialFile(restoreTarget(entry.rel, home, externalRoot), mapped.data)
			: mapped.data;
		prepared.push({ rel: entry.rel, data });
	}
	for (const entry of prepared) {
		const target = restoreTarget(entry.rel, home, externalRoot);
		let current = null;
		try {
			current = await readFile(target);
		} catch {
			current = null;
		}
		const sha = createHash("sha256").update(entry.data).digest("hex");
		if (current === null) plan.push({ rel: entry.rel, action: "create", sha });
		else if (createHash("sha256").update(current).digest("hex") === sha) plan.push({ rel: entry.rel, action: "same", sha });
		else plan.push({ rel: entry.rel, action: "overwrite", sha });
	}
	const summary = {
		id: safeId,
		dryRun: options.dryRun === true,
		total: plan.length,
		create: plan.filter((p) => p.action === "create").length,
		overwrite: plan.filter((p) => p.action === "overwrite").length,
		same: plan.filter((p) => p.action === "same").length,
		remapped: remapped.length,
		rejected: rejected.length
	};
	if (options.dryRun === true) return { ...summary, plan, rejectedPaths: rejected };

	// 写盘前先给当前状态留一份，出问题能退回去；只留最近几份，不然每恢复一次就多 1.2 MB
	const pre = await createSnapshot("pre-restore").catch(() => null);
	await pruneByLabel("pre-restore", PRE_RESTORE_KEEP).catch(() => {});

	const written = [];
	const failed = [];
	for (const entry of prepared) {
		const target = restoreTarget(entry.rel, home, externalRoot);
		try {
			await mkdir(dirname(target), { recursive: true });
			// 恢复也是对同一批凭据文件落盘（WO-SEC-3 补遗）：新建时按 0600，
			// 已存在的写完再收紧一次；否则恢复到空机器上会按默认 0644 落盘。
			if (CREDENTIAL_FILES.has(entry.rel)) {
				await writeFile(target, entry.data, { mode: CREDENTIAL_FILE_MODE });
				await hardenPermissions(target);
			} else {
				await writeFile(target, entry.data);
			}
			written.push(entry.rel);
		} catch (error) {
			failed.push({ rel: entry.rel, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { ...summary, dryRun: false, written: written.length, failed, preSnapshot: pre?.id ?? null };
}

/** 删掉一份快照（连目录一起）。 */
export async function deleteSnapshot(id) {
	const target = join(snapshotsDir(), assertSnapshotId(id));
	if (!(await pathExists(target))) throw new Error(`快照不存在：${id}`);
	await rm(target, { recursive: true, force: true });
	return { id, deleted: true };
}

/** 只保留最近 keep 份，其余连目录一起删。 */
export async function pruneSnapshots(keep = 10) {
	const safeKeep = Number.isFinite(keep) && keep >= 0 ? Math.floor(keep) : 10;
	const list = await listSnapshots();
	const doomed = list.slice(Math.max(0, safeKeep));
	for (const item of doomed) {
		// manifest 里的 id 是外部数据（也可能被手改过），拼 rm 路径前必须过闸（BUG-14）
		await rm(join(snapshotsDir(), assertSnapshotId(item.id)), { recursive: true, force: true });
	}
	return { kept: Math.min(list.length, safeKeep), removed: doomed.map((d) => d.id) };
}

// ── 定时备份 ──────────────────────────────────────────────────────────────

const SCHEDULE_FILE = () => resolve(dshHome(), "dsh-studio", "snapshot.json");
/** C-2：skill 根下单文件默认上限 5 MB，超过就不进包（0 = 关闭过滤）。 */
const DEFAULT_MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_SCHEDULE = { enabled: false, intervalHours: 24, keep: 10, maxSkillFileBytes: DEFAULT_MAX_SKILL_FILE_BYTES };

/** 读定时备份配置（缺文件/坏 JSON 一律回默认：关、24 小时、留 10 份）。 */
export async function loadSchedule() {
	try {
		const parsed = JSON.parse(await readFile(SCHEDULE_FILE(), "utf8"));
		return {
			enabled: parsed?.enabled === true,
			intervalHours:
				Number.isFinite(parsed?.intervalHours) && parsed.intervalHours > 0
					? parsed.intervalHours
					: DEFAULT_SCHEDULE.intervalHours,
			keep: Number.isFinite(parsed?.keep) && parsed.keep > 0 ? Math.floor(parsed.keep) : DEFAULT_SCHEDULE.keep,
			maxSkillFileBytes:
				Number.isFinite(Number(parsed?.maxSkillFileBytes)) && Number(parsed.maxSkillFileBytes) >= 0
					? Number(parsed.maxSkillFileBytes)
					: DEFAULT_SCHEDULE.maxSkillFileBytes
		};
	} catch {
		return { ...DEFAULT_SCHEDULE };
	}
}

/** 改定时备份配置（只改传进来的字段）。 */
export async function saveSchedule(patch = {}) {
	const current = await loadSchedule();
	const next = {
		enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
		intervalHours:
			Number.isFinite(patch.intervalHours) && patch.intervalHours > 0 ? patch.intervalHours : current.intervalHours,
		keep: Number.isFinite(patch.keep) && patch.keep > 0 ? Math.floor(patch.keep) : current.keep,
		maxSkillFileBytes:
			Number.isFinite(Number(patch.maxSkillFileBytes)) && Number(patch.maxSkillFileBytes) >= 0
				? Number(patch.maxSkillFileBytes)
				: current.maxSkillFileBytes
	};
	await mkdir(dirname(SCHEDULE_FILE()), { recursive: true });
	await writeFile(SCHEDULE_FILE(), JSON.stringify(next, null, 2), "utf8");
	return next;
}

/** 上次定时备份的时间点（0 = 从没跑过）。 */
async function lastScheduledAt() {
	const list = await listSnapshots();
	const hit = list.find((s) => s.label === "scheduled");
	return hit?.at ?? 0;
}

/**
 * 只清理某个标签的旧快照。
 *
 * 定时备份与恢复前的保护快照都用它，不能调 pruneSnapshots —— 后者按时间排全部快照，
 * 把用户手动建的那几份一起算进「保留 N 份」里，实测会删掉 manual。
 */
async function pruneByLabel(label, keep) {
	const list = (await listSnapshots()).filter((item) => item.label === label);
	const doomed = list.slice(Math.max(0, keep));
	for (const item of doomed) {
		// manifest 里的 id 是外部数据（也可能被手改过），拼 rm 路径前必须过闸（BUG-14）
		await rm(join(snapshotsDir(), assertSnapshotId(item.id)), { recursive: true, force: true });
	}
	return { kept: Math.min(list.length, keep), removed: doomed.map((item) => item.id) };
}

/** 恢复前的保护快照留这么多份，再多就删最旧的。 */
const PRE_RESTORE_KEEP = 3;

/**
 * 到点就备份一次并清理旧快照。
 * 调用方（插件 apply 里的定时器）每半小时问一次，这里只判断「该不该跑」。
 */
export async function runScheduledBackup(now = Date.now()) {
	const cfg = await loadSchedule();
	if (!cfg.enabled) return { skipped: "disabled" };
	const last = await lastScheduledAt();
	const dueAt = last + cfg.intervalHours * 3600_000;
	if (now < dueAt) return { skipped: "not-due", dueAt };
	const snap = await createSnapshot("scheduled");
	const pruned = await pruneByLabel("scheduled", cfg.keep);
	return { created: snap.id, fileCount: snap.files.length, pruned };
}

/** 导出：把某份快照打成可携带的 .tar.gz 文件。 */
export async function exportSnapshot(id, targetPath) {
	const dir = join(snapshotsDir(), assertSnapshotId(id));
	const archive = await readFile(join(dir, "config.tar.gz"));
	await mkdir(dirname(resolve(targetPath)), { recursive: true });
	await writeFile(resolve(targetPath), archive);
	const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
	return { path: resolve(targetPath), bytes: archive.length, files: manifest.files?.length ?? 0 };
}

/**
 * 导入：把外部 .tar.gz 读成一份快照（不写配置）。
 *
 * 包可能来自别人，含 `../` 或绝对路径的条目在这里就报错，不留给后面的恢复去发现。
 */
export async function importSnapshot(sourcePath, label = "imported") {
	const archive = await readFile(resolve(sourcePath));
	const entries = unpackTarGz(archive);
	if (entries.length === 0) throw new Error("这个包里没有可读取的文件");
	const unsafe = entries.filter((entry) => !isSafeEntryPath(entry.rel)).map((entry) => entry.rel);
	if (unsafe.length > 0) {
		throw new Error(`包里有 ${unsafe.length} 条越权路径，已拒绝导入：${unsafe.slice(0, 3).join(", ")}`);
	}
	const id = `${stamp()}-${String(label).replace(/[^\w.-]+/g, "_") || "imported"}`;
	const dir = join(snapshotsDir(), id);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "config.tar.gz"), archive);
	const files = entries.map((entry) => ({
		rel: entry.rel,
		bytes: entry.data.length,
		sha: createHash("sha256").update(entry.data).digest("hex")
	}));
	const manifest = { id, label, at: Date.now(), archiveBytes: archive.length, files, imported: true };
	await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
	return manifest;
}
