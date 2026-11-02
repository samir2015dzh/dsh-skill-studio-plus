/**
 * dsh-skill-studio — 最小 MCP 客户端（零外部依赖）。
 *
 * 只做按需加载需要的四件事：握手、列工具、调工具、断开。不桥接 resources /
 * prompts / sampling，和 DSH 自带的 mcp-client 口径一致。
 *
 * 两种传输：
 *   - stdio：spawn 子进程，stdout 按行切 JSON-RPC，stderr 留最近若干行做报错上下文。
 *   - streamable-http：POST 单条 JSON-RPC，响应可能是 application/json，也可能是
 *     text/event-stream（逐条 data: 行）；服务端给的 Mcp-Session-Id 会带回后续请求。
 *
 * 协议版本固定在 PROTOCOL_VERSION：老服务端会回它自己的版本，握手照样成立。
 */
import { spawn } from "node:child_process";
import dns from "node:dns";

// 某些网络下 Node 的 happy-eyeballs 会先去试不通的 IPv6，fetch 直接报
// UND_ERR_CONNECT_TIMEOUT（同一个地址 PowerShell 却连得上）。钉成 IPv4 优先。
dns.setDefaultResultOrder("ipv4first");

export const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "dsh-skill-studio", version: "0.6.0" };
const STDERR_TAIL = 20;
const MAX_BUFFER = 16 * 1024 * 1024;

/** JSON-RPC 错误 → Error，保留 code / data 便于排查。 */
class McpError extends Error {
	constructor(message, code, data) {
		super(message);
		this.name = "McpError";
		this.code = code;
		this.data = data;
	}
}

function toError(payload) {
	const message = typeof payload?.message === "string" ? payload.message : "MCP 请求失败";
	return new McpError(message, payload?.code, payload?.data);
}

/**
 * 一行一条 JSON-RPC 的读写通道。stdio 与 HTTP 都归一到同一组回调上，
 * 上层（McpConnection）不关心底下是管道还是 HTTP。
 */
class Channel {
	constructor() {
		this.onMessage = () => {};
		this.onClose = () => {};
		this.closed = false;
	}
	markClosed(reason) {
		if (this.closed) return;
		this.closed = true;
		this.onClose(reason instanceof Error ? reason : new Error(String(reason ?? "连接已关闭")));
	}
}

class StdioChannel extends Channel {
	constructor(spec) {
		super();
		this.stderrTail = [];
		this.child = spawn(spec.command, Array.isArray(spec.args) ? spec.args : [], {
			cwd: spec.cwd && spec.cwd !== "" ? spec.cwd : undefined,
			env: { ...process.env, ...(spec.env ?? {}) },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true
		});
		this.child.on("error", (error) => this.markClosed(error));
		this.child.on("exit", (code, signal) => this.markClosed(`子进程退出（code=${code}, signal=${signal}）`));
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk) => {
			for (const line of String(chunk).split("\n")) {
				if (line.trim() === "") continue;
				this.stderrTail.push(line.trim());
				if (this.stderrTail.length > STDERR_TAIL) this.stderrTail.shift();
			}
		});
		let buffer = "";
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk) => {
			buffer += chunk;
			if (buffer.length > MAX_BUFFER) {
				buffer = "";
				this.markClosed("stdout 超过缓冲上限，判定为异常输出");
				return;
			}
			let nl;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (line === "") continue;
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					continue; // 非 JSON 的噪声行不影响协议
				}
				this.onMessage(message);
			}
		});
	}

	stderrHint() {
		return this.stderrTail.length === 0 ? "" : "；stderr: " + this.stderrTail.slice(-3).join(" | ");
	}

	send(payload) {
		if (this.closed) throw new Error("MCP 子进程已退出");
		this.child.stdin.write(JSON.stringify(payload) + "\n");
	}

	async close() {
		if (this.closed) return;
		this.closed = true;
		try {
			this.child.stdin.end();
		} catch {
			/* 管道可能已经断了 */
		}
		const exited = new Promise((resolveExit) => {
			this.child.once("exit", resolveExit);
		});
		this.child.kill();
		await Promise.race([exited, new Promise((r) => setTimeout(r, 3000).unref?.())]);
	}
}

class HttpChannel extends Channel {
	constructor(spec) {
		super();
		this.url = spec.url;
		this.headers = { ...(spec.headers ?? {}) };
		this.sessionId = undefined;
		this.abort = new AbortController();
	}

	async send(payload) {
		const headers = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...this.headers
		};
		if (this.sessionId !== undefined) headers["mcp-session-id"] = this.sessionId;
		const response = await fetch(this.url, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			signal: this.abort.signal
		});
		const session = response.headers.get("mcp-session-id");
		if (session !== null && session !== "") this.sessionId = session;
		if (response.status === 202 || response.status === 204) return;
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`HTTP ${response.status} ${response.statusText}${body === "" ? "" : "：" + body.slice(0, 300)}`);
		}
		const type = response.headers.get("content-type") ?? "";
		if (type.includes("text/event-stream")) {
			await this.consumeSse(response);
			return;
		}
		const body = await response.text();
		if (body.trim() === "") return;
		for (const line of body.split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			try {
				this.onMessage(JSON.parse(trimmed));
			} catch {
				/* 一行一条，坏行跳过 */
			}
		}
	}

	async consumeSse(response) {
		const reader = response.body?.getReader();
		if (reader === undefined) return;
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let nl;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (data === "") continue;
				try {
					this.onMessage(JSON.parse(data));
				} catch {
					/* 非 JSON 事件（心跳等）忽略 */
				}
			}
		}
	}

	async close() {
		if (this.closed) return;
		this.closed = true;
		this.abort.abort();
	}
}

/**
 * 一条 MCP 连接：握手 + 工具调用。一个实例只对应一个上游服务器。
 */
export class McpConnection {
	constructor(spec, options = {}) {
		this.spec = spec;
		this.timeoutMs = options.timeoutMs ?? 120000;
		this.callback = {
			onToolsChanged: options.onToolsChanged
		};
		this.nextId = 1;
		this.pending = new Map();
		this.serverInfo = undefined;
		this.capabilities = undefined;
		this.instructions = undefined;
		this.channel = spec.transport === "stdio" ? new StdioChannel(spec) : new HttpChannel(spec);
		this.channel.onMessage = (message) => this.dispatch(message);
		this.channel.onClose = (error) => this.failAll(error);
	}

	async connect() {
		const result = await this.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: CLIENT_INFO
		});
		this.serverInfo = result?.serverInfo;
		this.capabilities = result?.capabilities;
		this.instructions = typeof result?.instructions === "string" ? result.instructions : undefined;
		this.notify("notifications/initialized", {});
		return result;
	}

	dispatch(message) {
		if (message && typeof message.id !== "undefined" && ("result" in message || "error" in message)) {
			const waiter = this.pending.get(message.id);
			if (waiter === undefined) return;
			this.pending.delete(message.id);
			clearTimeout(waiter.timer);
			if (message.error !== undefined) waiter.reject(toError(message.error));
			else waiter.resolve(message.result);
			return;
		}
		if (message?.method === "notifications/tools/list_changed") {
			this.callback.onToolsChanged?.();
		}
	}

	failAll(error) {
		for (const waiter of this.pending.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.pending.clear();
	}

	request(method, params, timeoutMs = this.timeoutMs) {
		const id = this.nextId++;
		const payload = { jsonrpc: "2.0", id, method, params };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP 请求超时（${Math.round(timeoutMs / 1000)} 秒）：${method}`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
			const send = this.channel.send(payload);
			if (send instanceof Promise) send.catch((error) => {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error);
			});
		});
	}

	notify(method, params) {
		const payload = { jsonrpc: "2.0", method, params };
		const send = this.channel.send(payload);
		if (send instanceof Promise) send.catch(() => {});
	}

	async listTools() {
		const tools = [];
		let cursor;
		do {
			const page = await this.request("tools/list", cursor === undefined ? {} : { cursor });
			for (const tool of page?.tools ?? []) tools.push(tool);
			cursor = page?.nextCursor;
		} while (typeof cursor === "string" && cursor !== "");
		return tools;
	}

	async callTool(name, args) {
		return await this.request("tools/call", { name, arguments: args ?? {} });
	}

	async close() {
		this.failAll(new Error("连接已关闭"));
		await this.channel.close();
	}
}

/** transport 由 registry 条目推导；只有 streamable-http 需要 url。 */
export function transportSpec(entry) {
	if (entry.transport === "streamable-http") {
		return { transport: "streamable-http", url: entry.url, headers: entry.headers ?? {} };
	}
	const env = { ...(entry.env ?? {}) };
	// envPrefix 来自 cordis.patch.yml 里的 `!!js "'路径;...' + process.env.PATH"`：
	// 把字面量前缀拼到父进程同名变量前面，效果和原生 loader 求值一致。
	if (entry.envPrefix && typeof entry.envPrefix === "object") {
		for (const [key, prefix] of Object.entries(entry.envPrefix)) {
			if (typeof prefix !== "string") continue;
			const name = process.platform === "win32" ? key.toUpperCase() : key;
			const inherited = env[key] ?? process.env[key] ?? "";
			env[key] = inherited === "" ? prefix : `${prefix};${inherited}`;
			void name;
		}
	}
	return {
		transport: "stdio",
		command: entry.command,
		args: entry.args ?? [],
		env,
		cwd: entry.cwd ?? ""
	};
}
