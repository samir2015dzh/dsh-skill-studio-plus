/**
 * 从 profile 的 cordis.patch.yml 里认出「DSH 里已经有的 MCP」。
 *
 * 只做文本级解析，不做 YAML 求值：这些条目里有 `!!js` 表达式、行内注释、
 * 跨行字符串，任何通用 YAML 解析器都会把它们丢掉或改写。所以这里按行扫，
 * 只认 `@deepseek-ai/dsh-mcp-client` 的 insert 行，取值时跳过注释。
 *
 * 导入是「只读」的：把条目抄进 studio 注册表并放在停用档，不碰原文件。
 * 真要接管（禁用原生行、改由 studio 按需加载）走 setRowDisabled 的文本级插入，
 * 只加一行 `disabled: true`，config 一个字节都不动。
 */
import { readFile, writeFile } from "node:fs/promises";

function stripQuotes(value) {
	const v = String(value ?? "").trim();
	if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
		return v.slice(1, -1);
	}
	return v;
}

/** `[ "a", "b" ]` → ["a","b"]。 */
function parseFlowSeq(raw) {
	const inner = String(raw ?? "").replace(/^\s*\[/, "").replace(/\]\s*$/, "");
	const out = [];
	const re = /"([^"]*)"|'([^']*)'|([^,\s][^,]*)/g;
	let m;
	while ((m = re.exec(inner)) !== null) {
		const value = (m[1] ?? m[2] ?? m[3] ?? "").trim();
		if (value !== "") out.push(value);
	}
	return out;
}

/**
 * YAML 的行尾反斜杠续行先折叠成一行，否则 `!!js` 那种跨行表达式读不完整。
 */
function foldContinuations(lines) {
	const out = [];
	for (let i = 0; i < lines.length; i += 1) {
		let line = lines[i];
		while (line.endsWith("\\") && i + 1 < lines.length) {
			line = line.slice(0, -1) + lines[i + 1].trim();
			i += 1;
		}
		out.push(line);
	}
	return out;
}

/**
 * 扫出一份 patch 文本里所有 dsh-mcp-client 行。
 * @returns {{rowId:string,line:number,disabled:boolean,config:object,dynamic:string[]}[]}
 */
export function parseMcpRows(text) {
	const lines = foldContinuations(String(text ?? "").split(/\r?\n/));
	const rows = [];
	let cur = null;
	let inEnv = false;
	let inHeaders = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const idMatch = /^(\s*)- id:\s*(\S+)\s*$/.exec(line);
		if (idMatch !== null) {
			if (cur !== null) rows.push(cur);
			cur = {
				rowId: stripQuotes(idMatch[2]),
				line: i,
				indent: idMatch[1].length,
				isMcp: false,
				disabled: false,
				config: {},
				dynamic: []
			};
			inEnv = false;
			continue;
		}
		if (cur === null) continue;
		if (/^\s*name:\s*["']?@deepseek-ai\/dsh-mcp-client["']?\s*$/.test(line)) {
			cur.isMcp = true;
			continue;
		}
		if (/^\s*disabled:\s*true\s*$/.test(line)) {
			cur.disabled = true;
			continue;
		}
		const kv = /^(\s+)([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
		if (kv === null) continue;
		const indent = kv[1].length;
		const key = kv[2];
		const raw = kv[3].trim();
		if (raw.startsWith("#")) continue;
		const configIndent = cur.indent + 4;
		if (key === "env" && raw === "") {
			inEnv = true;
			inHeaders = false;
			continue;
		}
		if (key === "headers" && raw === "") {
			inHeaders = true;
			inEnv = false;
			cur.config.headers = cur.config.headers ?? {};
			continue;
		}
		// headers 是块式的，子项（Authorization 之类）要收进对象，否则连接时没鉴权
		if (inHeaders && indent > configIndent) {
			cur.config.headers = cur.config.headers ?? {};
			cur.config.headers[key] = stripQuotes(raw);
			continue;
		}
		if (inEnv && indent > configIndent) {
			cur.config.env = cur.config.env ?? {};
			if (raw.startsWith("!!js")) {
				// 典型写法：'D:/tools/x/bin;...' + process.env.PATH
				// 前缀是字面量，直接拿出来，运行时拼到父进程的同名变量前面。
				// `+` 后面常常换行，所以把下一行的 process.env.X 接上再匹配。
				let expr = raw;
				if (!/process\.env\./.test(expr) && i + 1 < lines.length && /^\s*process\.env\./.test(lines[i + 1])) {
					expr = `${expr} ${lines[i + 1].trim()}`;
				}
				const m = /^!!js\s*['"]([\s\S]*?)['"]\s*\+\s*process\.env\.([A-Za-z_][A-Za-z0-9_]*)\s*"?\s*$/.exec(expr);
				if (m !== null) {
					cur.config.envPrefix = cur.config.envPrefix ?? {};
					// 外层双引号里还套着 JS 的单引号，两端都剥掉
					cur.config.envPrefix[m[2]] = m[1].replace(/^['"]/, "").replace(/['"]$/, "");
				} else {
					// 别的动态表达式拿不到值，记下来让上层决定
					cur.dynamic.push(key);
					cur.config.env[key] = null;
				}
			} else {
				cur.config.env[key] = stripQuotes(raw);
			}
			continue;
		}
		inEnv = false;
		if (indent !== configIndent) continue;
		if (key === "args") {
			cur.config.args = parseFlowSeq(raw);
		} else if (key === "headers") {
			// 块式 headers 已在上面的分支收完；这里只剩少见的一行式写法，留给上层手填
		} else {
			cur.config[key] = stripQuotes(raw);
		}
	}
	if (cur !== null) rows.push(cur);
	return rows.filter((row) => row.isMcp && typeof row.config.serverName === "string" && row.config.serverName !== "");
}

export function profilePatchPath(dshHome, profile) {
	return `${dshHome}/profiles/${profile}/cordis.patch.yml`;
}

/**
 * 只读导入：把已有 MCP 抄进注册表，档位停在「停用」。
 * patchPaths 可以是单个路径或数组（profile 自己的 patch + 各 bundle 的 patch）。
 * 已经登记过的跳过；拿不到值的动态表达式跳过并报原因。
 */
export async function importProfileMcp(store, patchPaths, logger) {
	const paths = Array.isArray(patchPaths) ? patchPaths : [patchPaths];
	const rows = [];
	for (const patchPath of paths) {
		let text;
		try {
			text = await readFile(patchPath, "utf8");
		} catch {
			continue;
		}
		if (!text.includes("@deepseek-ai/dsh-mcp-client")) continue;
		try {
			for (const row of parseMcpRows(text)) {
				row.patchPath = patchPath;
				rows.push(row);
			}
		} catch (error) {
			logger?.warn?.(`[dsh-skill-studio] 解析 ${patchPath} 失败：${String(error)}`);
		}
	}
	const state = await store.load();
	const imported = [];
	const skipped = [];
	for (const row of rows) {
		const name = row.config.serverName;
		if (state.servers.some((entry) => entry.name === name)) continue;
		if (row.dynamic.length > 0) {
			skipped.push({ name, rowId: row.rowId, reason: `env 里有动态表达式：${row.dynamic.join(", ")}` });
			continue;
		}
		state.servers.push({
			name,
			tier: "disabled",
			transport: row.config.transport === "streamable-http" ? "streamable-http" : "stdio",
			command: row.config.command ?? "",
			args: row.config.args ?? [],
			env: row.config.env ?? {},
			envPrefix: row.config.envPrefix,
			cwd: row.config.cwd ?? "",
			url: row.config.url,
			headers: row.config.headers,
			toolCallTimeoutMs: Number(row.config.toolCallTimeoutMs) || undefined,
			notes: `来自 ${row.patchPath.includes("node_modules") ? "bundle" : "cordis.patch.yml"}（${row.rowId}）${row.disabled ? "，原生已禁用" : ""}`,
			source: { kind: "profile", rowId: row.rowId, patchPath: row.patchPath, nativeDisabled: row.disabled === true }
		});
		imported.push(name);
	}
	if (imported.length > 0) await store.save(state);
	return { imported, skipped, readonly: false };
}

/**
 * 给某一行加/去 `disabled: true`。文本级：只插一行，不动 config 内容，
 * 注释和 !!js 都原样留着。
 */
export function setRowDisabled(text, rowId, disabled) {
	const lines = String(text ?? "").split(/\r?\n/);
	const idx = lines.findIndex((line) => new RegExp(`^(\\s*)- id:\\s*"?${rowId}"?\\s*$`).test(line));
	if (idx < 0) return { text, changed: false };
	const indent = /^(\s*)/.exec(lines[idx])[1].length;
	const childIndent = " ".repeat(indent + 2);
	const next = lines[idx + 1];
	const has = next !== undefined && new RegExp(`^${childIndent}disabled:\\s*true\\s*$`).test(next);
	if (disabled === true && has === false) {
		lines.splice(idx + 1, 0, `${childIndent}disabled: true`);
		return { text: lines.join("\n"), changed: true };
	}
	if (disabled === false && has === true) {
		lines.splice(idx + 1, 1);
		return { text: lines.join("\n"), changed: true };
	}
	return { text, changed: false };
}

/** 接管：把原生行禁用掉（让 studio 成为唯一入口）。返回是否真的改了文件。 */
export async function disableNativeRow(patchPath, rowId, logger) {
	let text;
	try {
		text = await readFile(patchPath, "utf8");
	} catch {
		return false;
	}
	const result = setRowDisabled(text, rowId, true);
	if (result.changed === false) return false;
	try {
		await writeFile(patchPath, result.text, "utf8");
		return true;
	} catch (error) {
		logger?.warn?.(`[dsh-skill-studio] 写 ${patchPath} 失败：${String(error)}`);
		return false;
	}
}
