// F-4 fixture：最小的 stdio MCP 服务端，只为在伪 HOME 里把
// mcp_register / mcp_load / mcp_call 真跑起来（换成真实 MCP 对端也行，但没必要联网）。
//
// 只实现握手、tools/list、tools/call 三件事；按行收发 JSON-RPC，与 lib/mcp-client.js 的 framing 一致。
import { createInterface } from "node:readline";

const write = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");

const TOOLS = [
	{
		name: "echo",
		description: "原样回显 text 参数",
		inputSchema: { type: "object", properties: { text: { type: "string" } } }
	}
];

createInterface({ input: process.stdin }).on("line", (line) => {
	if (line.trim() === "") return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	// 通知（没有 id）不回包
	if (message.id === undefined) return;
	if (message.method === "initialize") {
		write({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "mock-mcp", version: "1.0.0" }
			}
		});
		return;
	}
	if (message.method === "tools/list") {
		write({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
		return;
	}
	if (message.method === "tools/call") {
		const args = message.params?.arguments ?? {};
		write({
			jsonrpc: "2.0",
			id: message.id,
			result: { content: [{ type: "text", text: "echo:" + String(args.text ?? "") }] }
		});
		return;
	}
	write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found: " + message.method } });
});
