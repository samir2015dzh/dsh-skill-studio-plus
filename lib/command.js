/**
 * 命令切分与强删除（WO-BORROW-5）。
 *
 * 设计参考 functy23/dsh-mcp-studio 的 `src/panel/host/service/mcp.utils.ts`（整行命令切分归一）
 * 与 `rmtree.ts`（删除前清只读属性），两者均为 MIT。该仓库不在本机、本次也未能取到源码，
 * 因此按需求描述自行实现，未移植其代码。
 */
import { chmod, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * 把一整行命令切成 argv。
 * 支持双引号 / 单引号包裹的空格，双引号内支持 \" \\ 转义；引号本身不留在结果里。
 * 空串或纯空白返回 []。
 */
export function splitCommandLine(line) {
	const text = typeof line === "string" ? line.trim() : "";
	const out = [];
	let cur = "";
	let quote = null;
	let filled = false;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (quote !== null) {
			// 双引号内只认 \" 与 \\ 两种转义：Windows 路径里的单独反斜杠必须原样保留
			if (ch === "\\" && quote === '"' && (text[i + 1] === '"' || text[i + 1] === "\\")) {
				cur += text[i + 1];
				i += 1;
				filled = true;
				continue;
			}
			if (ch === quote) {
				quote = null;
				filled = true; // 空引号 "" 也算一个参数
				continue;
			}
			cur += ch;
			filled = true;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			if (filled) {
				out.push(cur);
				cur = "";
				filled = false;
			}
			continue;
		}
		cur += ch;
		filled = true;
	}
	if (filled || cur !== "") out.push(cur);
	return out;
}

/** 递归清掉只读位（Windows 上只读文件会让 rm 直接 EPERM）。 */
async function clearReadOnly(target) {
	let info;
	try {
		info = await stat(target);
	} catch {
		return;
	}
	if (info.isDirectory()) {
		let names = [];
		try {
			names = await readdir(target);
		} catch {
			names = [];
		}
		for (const name of names) await clearReadOnly(join(target, name));
	}
	try {
		await chmod(target, 0o666);
	} catch {
		/* 没权限改就交给 rm 报错 */
	}
}

/**
 * 删除目录，遇到只读文件先清位再删。
 * 目标不存在时不报错（与 rm -f 语义一致）。
 */
export async function removeDirForcibly(target) {
	if (typeof target !== "string" || target === "") throw new Error("删除路径为空");
	await clearReadOnly(target);
	await rm(target, { recursive: true, force: true });
}
