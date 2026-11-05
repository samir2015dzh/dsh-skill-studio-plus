/**
 * 配置快照：把 `~/.dsh` 里该备份的配置文件收集起来，打成 tar.gz；
 * 恢复时先给当前状态打一份、再逐文件覆盖，SHA 不符的跳过并报告。
 *
 * 设计取舍：
 *   - tar.gz 而不是 zip：Node 只有 zlib，手写 tar 头 512 字节比写 ZIP 中央目录简单得多，
 *     解压也不依赖外部命令。
 *   - 白名单而不是黑名单：`~/.dsh` 里有 sessions（几百 MB）、node_modules、asar 缓存，
 *     按黑名单迟早漏；白名单列不全时最多是少备份，不会把会话日志塞进备份包。
 *   - 密钥永远不进去：`.credentials.yaml` 与它所在目录一律跳过，不看调用方参数。
 */
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

/** DSH 根目录。 */
const dshHome = () => resolve(homedir(), ".dsh");
/** 快照仓库。 */
export const snapshotsDir = () => resolve(dshHome(), "dsh-studio", "snapshots");

/** 永远不进快照：密钥、会话日志、依赖、asar。 */
const ALWAYS_SKIP = [/\.credentials\.yaml$/i, /(^|[\\/])node_modules([\\/]|$)/, /(^|[\\/])sessions([\\/]|$)/, /\.asar(\.unpacked)?$/i];

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
export async function collectFiles() {
	const home = dshHome();
	const found = [];
	const add = async (absPath, relPath) => {
		if (shouldSkip(relPath)) return;
		if (!(await pathExists(absPath))) return;
		const info = await stat(absPath);
		if (!info.isFile()) return;
		const buf = await readFile(absPath);
		found.push({
			rel: relPath,
			abs: absPath,
			bytes: buf.length,
			sha: createHash("sha256").update(buf).digest("hex")
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
	return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

// ── 最小 tar 写入 / 读取（ustar，只处理普通文件） ──────────────────────────

function tarHeader(name, size, mtimeSeconds) {
	const header = Buffer.alloc(512, 0);
	const nameBuf = Buffer.from(name, "utf8");
	if (nameBuf.length <= 100) {
		nameBuf.copy(header, 0);
	} else {
		// 长路径：用 ustar 的 prefix + name 拆分
		const slash = nameBuf.lastIndexOf(47, 155);
		if (slash > 0) {
			nameBuf.subarray(0, slash).copy(header, 345);
			nameBuf.subarray(slash + 1).copy(header, 0);
		} else {
			nameBuf.subarray(0, 100).copy(header, 0);
		}
	}
	const octal = (value, width) => value.toString(8).padStart(width - 1, "0") + "\0";
	Buffer.from(octal(0o644, 8), "ascii").copy(header, 100); // mode
	Buffer.from(octal(0, 8), "ascii").copy(header, 108); // uid
	Buffer.from(octal(0, 8), "ascii").copy(header, 116); // gid
	Buffer.from(octal(size, 12), "ascii").copy(header, 124); // size
	Buffer.from(octal(mtimeSeconds, 12), "ascii").copy(header, 136); // mtime
	header.fill(32, 148, 156); // checksum 先填空格
	header[156] = 0x30; // typeflag: '0' 普通文件
	Buffer.from("ustar\0", "ascii").copy(header, 257);
	Buffer.from("00", "ascii").copy(header, 263);
	let sum = 0;
	for (let i = 0; i < 512; i += 1) sum += header[i];
	Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ", "ascii").copy(header, 148);
	return header;
}

/** 把 {rel, data} 列表打成 tar.gz。 */
export function packTarGz(entries) {
	const chunks = [];
	const now = Math.floor(Date.now() / 1000);
	for (const entry of entries) {
		const data = entry.data;
		chunks.push(tarHeader(entry.rel, data.length, now));
		chunks.push(data);
		const pad = (512 - (data.length % 512)) % 512;
		if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
	}
	chunks.push(Buffer.alloc(1024, 0)); // 两个空块结束
	return gzipSync(Buffer.concat(chunks), { level: 9 });
}

/** 解开 tar.gz，返回 {rel, data} 列表。 */
export function unpackTarGz(buffer) {
	const raw = gunzipSync(buffer);
	const out = [];
	let offset = 0;
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
		const rel = prefix === "" ? name : `${prefix}/${name}`;
		offset += 512;
		if (type === "0" || type === "\0" || type === "0") {
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
		if (from === "") continue;
		const to = typeof pair?.to === "string" ? pair.to.trim() : "";
		for (const [source, target] of [
			[from, to],
			[escapeBackslashes(from), escapeBackslashes(to)]
		]) {
			if (source === "" || !text.includes(source)) continue;
			text = text.split(source).join(target);
			changed = true;
		}
	}
	return { data: changed ? Buffer.from(text, "utf8") : buf, changed };
}

// ── 快照的建立 / 列举 / 恢复 / 清理 ────────────────────────────────────────

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
	const files = await collectFiles();
	if (files.length === 0) throw new Error("白名单里一个文件都没找到，检查 ~/.dsh 是否存在");
	const entries = [];
	for (const file of files) entries.push({ rel: file.rel, data: await readFile(file.abs) });
	const archive = packTarGz(entries);
	const id = `${stamp()}-${String(label).replace(/[^\w.-]+/g, "_") || "manual"}`;
	const dir = join(snapshotsDir(), id);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "config.tar.gz"), archive);
	const manifest = {
		id,
		label,
		at: Date.now(),
		archiveBytes: archive.length,
		files: files.map((f) => ({ rel: f.rel, bytes: f.bytes, sha: f.sha }))
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
	const dir = join(snapshotsDir(), id);
	const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
	const archive = await readFile(join(dir, "config.tar.gz"));
	const entries = unpackTarGz(archive);
	const pathMap = Array.isArray(options.pathMap) ? options.pathMap : [];
	const home = dshHome();
	const plan = [];
	const remapped = [];
	// 先把每个文件的重映射结果算出来，dry-run 与真恢复共用同一份
	const prepared = entries.map((entry) => {
		const mapped = remapText(entry.data, pathMap);
		if (mapped.changed) remapped.push(entry.rel);
		return { rel: entry.rel, data: mapped.data };
	});
	for (const entry of prepared) {
		if (shouldSkip(entry.rel)) continue;
		const target = join(home, entry.rel);
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
		id,
		dryRun: options.dryRun === true,
		total: plan.length,
		create: plan.filter((p) => p.action === "create").length,
		overwrite: plan.filter((p) => p.action === "overwrite").length,
		same: plan.filter((p) => p.action === "same").length,
		remapped: remapped.length
	};
	if (options.dryRun === true) return { ...summary, plan };

	// 写盘前先给当前状态留一份，出问题能退回去；只留最近几份，不然每恢复一次就多 1.2 MB
	const pre = await createSnapshot("pre-restore").catch(() => null);
	await pruneByLabel("pre-restore", PRE_RESTORE_KEEP).catch(() => {});

	const written = [];
	const failed = [];
	for (const entry of prepared) {
		if (shouldSkip(entry.rel)) continue;
		const target = join(home, entry.rel);
		try {
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, entry.data);
			written.push(entry.rel);
		} catch (error) {
			failed.push({ rel: entry.rel, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { ...summary, dryRun: false, written: written.length, failed, preSnapshot: pre?.id ?? null };
}

/** 删掉一份快照（连目录一起）。 */
export async function deleteSnapshot(id) {
	const target = join(snapshotsDir(), id);
	if (!(await pathExists(target))) throw new Error(`快照不存在：${id}`);
	await rm(target, { recursive: true, force: true });
	return { id, deleted: true };
}

/** 只保留最近 keep 份，其余连目录一起删。 */
export async function pruneSnapshots(keep = 10) {
	const list = await listSnapshots();
	const doomed = list.slice(Math.max(0, keep));
	for (const item of doomed) await rm(join(snapshotsDir(), item.id), { recursive: true, force: true });
	return { kept: Math.min(list.length, keep), removed: doomed.map((d) => d.id) };
}

// ── 定时备份 ──────────────────────────────────────────────────────────────

const SCHEDULE_FILE = () => resolve(dshHome(), "dsh-studio", "snapshot.json");
const DEFAULT_SCHEDULE = { enabled: false, intervalHours: 24, keep: 10 };

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
			keep: Number.isFinite(parsed?.keep) && parsed.keep > 0 ? Math.floor(parsed.keep) : DEFAULT_SCHEDULE.keep
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
		keep: Number.isFinite(patch.keep) && patch.keep > 0 ? Math.floor(patch.keep) : current.keep
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
	for (const item of doomed) await rm(join(snapshotsDir(), item.id), { recursive: true, force: true });
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

export async function exportSnapshot(id, targetPath) {
	const dir = join(snapshotsDir(), id);
	const archive = await readFile(join(dir, "config.tar.gz"));
	await mkdir(dirname(resolve(targetPath)), { recursive: true });
	await writeFile(resolve(targetPath), archive);
	const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
	return { path: resolve(targetPath), bytes: archive.length, files: manifest.files?.length ?? 0 };
}

/** 导入：把外部 .tar.gz 读成一份快照（不写配置）。 */
export async function importSnapshot(sourcePath, label = "imported") {
	const archive = await readFile(resolve(sourcePath));
	const entries = unpackTarGz(archive); // 先验证能解开
	if (entries.length === 0) throw new Error("这个包里没有可读取的文件");
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
