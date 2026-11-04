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

export function trashRoot() {
	return resolve(homedir(), ".dsh", "dsh-studio", "trash");
}

function stamp() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
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
	const batch = join(trashRoot(), id);
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
		const to = item.to ?? join(batch, item.name);
		if ((await pathExists(to)) === false) continue; // 已经被恢复或手动删了
		const parent = dirname(item.from);
		if ((await pathExists(parent)) === false) throw new Error("原目录已不存在：" + parent);
		if (await pathExists(item.from)) throw new Error("目标位置已有同名项：" + item.from);
		await moveDir(to, item.from);
		done.push(item.name);
	}
	// 批次空了就清掉，否则把剩下的写回去
	const remaining = manifest.filter((item) => !done.includes(item.name));
	if (remaining.length === 0) await rm(batch, { recursive: true, force: true });
	else await writeFile(join(batch, "manifest.json"), JSON.stringify(remaining, null, 2), "utf8");
	return { id, restored: done };
}

/** 永久删除回收站里的条目（name 省略时删整个批次）。 */
export async function purgeTrash(id, name) {
	const batch = join(trashRoot(), id);
	let manifest;
	try {
		const parsed = JSON.parse(await readFile(join(batch, "manifest.json"), "utf8"));
		manifest = Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		throw new Error("找不到批次：" + id);
	}
	if (name === undefined || name === "") {
		await rm(batch, { recursive: true, force: true });
		return { id, purged: manifest.map((item) => item.name) };
	}
	const item = manifest.find((x) => x.name === name);
	if (item === undefined) throw new Error(`批次 ${id} 里没有 "${name}"`);
	await rm(item.to ?? join(batch, item.name), { recursive: true, force: true });
	const remaining = manifest.filter((x) => x.name !== name);
	if (remaining.length === 0) await rm(batch, { recursive: true, force: true });
	else await writeFile(join(batch, "manifest.json"), JSON.stringify(remaining, null, 2), "utf8");
	return { id, purged: [name] };
}
