/**
 * 技能回收站。
 *
 * 删技能不直接 rm：把整个技能目录 Move 到 `~/.dsh/dsh-studio/trash/<时间戳>-<名>/`，
 * 同目录写一份 manifest.json 记录原路径；恢复时按 manifest 搬回去。
 *
 * 一个「批次目录」可以装多个条目（批量删除），也可以只有一条（面板上删单个技能）。
 */
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { assertSnapshotId, isInside } from "./paths.js";
import { removeDirForcibly } from "./command.js";

export function trashRoot() {
	return resolve(homedir(), ".dsh", "dsh-studio", "trash");
}

/** 批次 id 带毫秒：同秒连删两个同名 skill 时不会互相覆盖（BUG-15）。 */
function stamp() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** 允许的 skill 根：回收站 manifest 里的 from 只能落在这些目录内。 */
function allowedSkillRoots() {
	const home = homedir();
	const roots = [join(home, ".dsh", "skills"), join(home, ".agents", "skills")];
	const extra = process.env.DSH_SKILL_MANAGER_SKILL_DIRS;
	if (typeof extra === "string" && extra !== "") {
		for (const dir of extra.split(":")) if (dir.trim() !== "") roots.push(dir.trim());
	}
	return roots;
}

/**
 * 校验一条 manifest 记录：`to` 必须在本批次目录内，`from` 必须落在某个 skill 根内。
 * manifest 是外部数据（可被手改），直接拿去 rm/move 等于把路径控制权交出去（S-06）。
 */
function assertRestorableEntry(item, batch) {
	const name = typeof item?.name === "string" ? item.name : "";
	if (name === "") throw new Error("回收站 manifest 缺 name");
	const to = typeof item?.to === "string" && item.to !== "" ? item.to : join(batch, name);
	if (!isInside(batch, to)) throw new Error(`回收站 manifest 的 to 越出批次目录：${to}`);
	const from = typeof item?.from === "string" ? item.from : "";
	if (from === "" || !allowedSkillRoots().some((root) => isInside(root, from))) {
		throw new Error(`回收站 manifest 的 from 不在 skill 根内：${from}`);
	}
	return { name, from, to };
}

async function pathExists(p) {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

/** 跨盘 rename 会 EXDEV，退化成 copy + rm。 */
async function moveDir(from, to) {
	try {
		await rename(from, to);
	} catch (error) {
		if (error?.code !== "EXDEV") throw error;
		await cp(from, to, { recursive: true });
		await rm(from, { recursive: true, force: true });
	}
}

/** 列出回收站里的全部批次。 */
export async function listTrash() {
	const root = trashRoot();
	let dirs;
	try {
		dirs = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const out = [];
	for (const entry of dirs) {
		if (!entry.isDirectory()) continue;
		const base = join(root, entry.name);
		let manifest;
		try {
			const parsed = JSON.parse(await readFile(join(base, "manifest.json"), "utf8"));
			manifest = Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			continue; // 没有 manifest 的目录不认
		}
		const items = [];
		for (const item of manifest) {
			if (typeof item?.name !== "string") continue;
			const to = item.to ?? join(base, item.name);
			items.push({
				name: item.name,
				from: item.from ?? "",
				present: await pathExists(to)
			});
		}
		if (items.length === 0) continue;
		out.push({ id: entry.name, path: base, entries: items });
	}
	return out.sort((a, b) => b.id.localeCompare(a.id));
}

/**
 * 把一个技能目录移进回收站。
 * @param {{name:string, dir:string}} skill 扫描结果里的条目
 */
export async function trashSkill(skill) {
	const from = skill.dir;
	if (typeof from !== "string" || from === "") throw new Error("这个技能没有实体目录，删不了");
	if ((await pathExists(from)) === false) throw new Error("目录不存在：" + from);
	const root = trashRoot();
	await mkdir(root, { recursive: true });
	const safeName = skill.name.replace(/[^\w.-]+/g, "_");
	const id = `${stamp()}-${safeName}`;
	const batch = join(root, id);
	await mkdir(batch, { recursive: true });
	const to = join(batch, basename(from));
	await moveDir(from, to);
	await writeFile(
		join(batch, "manifest.json"),
		JSON.stringify([{ name: skill.name, from, to, at: Date.now() }], null, 2),
		"utf8"
	);
	return { id, from, to };
}

/** 从回收站搬回原位置。name 省略时恢复整个批次。 */
export async function restoreTrash(id, name) {
	const batch = join(trashRoot(), assertSnapshotId(id));
	let manifest;
	try {
		const parsed = JSON.parse(await readFile(join(batch, "manifest.json"), "utf8"));
		manifest = Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		throw new Error("找不到批次：" + id);
	}
	const targets = name === undefined || name === "" ? manifest : manifest.filter((item) => item.name === name);
	if (targets.length === 0) throw new Error(`批次 ${id} 里没有 "${name}"`);
	const done = [];
	for (const item of targets) {
		const entry = assertRestorableEntry(item, batch);
		if ((await pathExists(entry.to)) === false) continue; // 已经被恢复或手动删了
		const parent = dirname(entry.from);
		if ((await pathExists(parent)) === false) throw new Error("原目录已不存在：" + parent);
		if (await pathExists(entry.from)) throw new Error("目标位置已有同名项：" + entry.from);
		await moveDir(entry.to, entry.from);
		done.push(entry.name);
	}
	// 批次空了就清掉，否则把剩下的写回去
	const remaining = manifest.filter((item) => !done.includes(item.name));
	if (remaining.length === 0) await removeDirForcibly(batch);
	else await writeFile(join(batch, "manifest.json"), JSON.stringify(remaining, null, 2), "utf8");
	return { id, restored: done };
}

/** 永久删除回收站里的条目（name 省略时删整个批次）。 */
export async function purgeTrash(id, name) {
	const batch = join(trashRoot(), assertSnapshotId(id));
	let manifest;
	try {
		const parsed = JSON.parse(await readFile(join(batch, "manifest.json"), "utf8"));
		manifest = Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		throw new Error("找不到批次：" + id);
	}
	if (name === undefined || name === "") {
		await removeDirForcibly(batch);
		return { id, purged: manifest.map((item) => item.name) };
	}
	const item = manifest.find((x) => x.name === name);
	if (item === undefined) throw new Error(`批次 ${id} 里没有 "${name}"`);
	const to = typeof item.to === "string" && item.to !== "" ? item.to : join(batch, item.name);
	// 只允许删批次目录里的东西：manifest 被改过也不能把 rm 指到外面（S-06）
	if (!isInside(batch, to)) throw new Error(`回收站 manifest 的 to 越出批次目录：${to}`);
	await removeDirForcibly(to);
	const remaining = manifest.filter((x) => x.name !== name);
	if (remaining.length === 0) await removeDirForcibly(batch);
	else await writeFile(join(batch, "manifest.json"), JSON.stringify(remaining, null, 2), "utf8");
	return { id, purged: [name] };
}
