// F-4 fixture：把「经注册层取 schema + 宿主同一校验器校验真实返回体」推广到全部 27 个工具。
//
// 与 F-2/F-3 的差别只有两点：
//   1. 工具定义一律来自 ctx.tools.register（apply 之后的注册表），不直调 lib 层函数；
//   2. 每一个工具都真跑一次——写类工具用各自的最小场景（建快照→恢复、trash→restore→purge、
//      候选→接受/拒绝、本地 bare 仓库当 git 远端、mock stdio MCP 当对端），不靠源码目测。
//
// 依赖全部本地顶替：LLM 是内存里的假 provider，MCP 对端是同目录的 mock-mcp-server.mjs，
// git 远端是伪 HOME 里的 bare 仓库。全程不联网、不写真实 ~/.dsh。
//
// 用法：由父测试用 USERPROFILE/HOME/DSH_HOME 指向 mkdtemp 出来的伪 HOME 后执行
//（node tests/fixtures/all-tools-home.mjs），结果以 JSON 打到 stdout。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const home = process.env.USERPROFILE ?? process.env.HOME;
const pluginRoot = path.resolve(import.meta.dirname, "..", "..");
const lib = (name) => import(pathToFileURL(path.join(pluginRoot, "lib", name)).href);

const dshHome = path.join(home, ".dsh");
// index.js 的 profile 扫描优先读 DSH_HOME：钉到伪 HOME，绝不落到真机
process.env.DSH_HOME = dshHome;
const agentRoot = path.join(home, ".agents", "skills");
const diskRoot = path.join(dshHome, "skills");
const mockServer = path.join(import.meta.dirname, "mock-mcp-server.mjs");

const writeSkill = (dir, name, description) => {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody ${description}\n`);
};

// ---- 伪 HOME 地基：两棵 skill 根、extractor 配置、一份含原生 MCP 行的 profile patch
writeSkill(path.join(diskRoot, "disk-skill"), "disk-skill", "用户 skill 根里的样例");
writeSkill(path.join(agentRoot, "agent-skill"), "agent-skill", "agent 根里的样例，用来走 trash");
fs.mkdirSync(path.join(dshHome, "dsh-studio"), { recursive: true });
fs.writeFileSync(path.join(dshHome, "AGENTS.md"), "# 伪 HOME\n");
fs.writeFileSync(
	path.join(dshHome, "dsh-studio", "extractor.json"),
	JSON.stringify({ agentSkillDir: agentRoot, mirrorDir: "" }, null, 2) + "\n"
);
const profileDir = path.join(dshHome, "profiles", "desktop");
fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(
	path.join(profileDir, "cordis.patch.yml"),
	[
		"# F-4 fixture：只为让 mcp_takeover 有原生行可接管",
		"- insert:",
		"    - id: mcp-native-one",
		"      name: '@deepseek-ai/dsh-mcp-client'",
		"      config:",
		"        serverName: native-one",
		"        transport: stdio",
		"        command: node",
		"        args: [\"-e\", \"0\"]",
		""
	].join("\n")
);

// ---- 本地 git 远端（离线），给 skillmgr_sync 的 push/pull 用
const remoteRepo = path.join(home, "remote.git");
const syncWork = path.join(home, "sync-work");
execFileSync("git", ["init", "--bare", "-b", "main", remoteRepo], { stdio: "pipe" });

// ---- 假 LLM：只提供 provider/model 与一个空流；伪 HOME 没有会话日志，实际上不会被调用
const fakeLlm = {
	listProviders: () => [{ id: "fixture" }],
	listModels: async () => ["fixture-model"],
	prepareCall: async (config) => ({
		config,
		stream: async function* () {
			yield { type: "text-delta", text: "[]" };
			yield { type: "finish", reason: { kind: "ok" } };
		}
	})
};

// ---- apply 插件，拿注册表里的 27 个工具
const tools = new Map();
const studio = await lib("index.js");
studio.apply(
	{
		skills: { list: async () => [], get: async () => undefined },
		tools: { register: (t) => { tools.set(t.name, t); return () => {}; } },
		webServer: { register: () => () => {} },
		systemPrompt: { section: () => () => {} },
		effect: (fn) => { const d = fn(); return () => (typeof d === "function" ? d() : undefined); },
		get: () => null,
		logger: { info: () => {}, warn: () => {} },
		interval: () => () => {},
		on: () => () => {},
		llm: fakeLlm
	},
	{}
);

const { validateJsonSchemaValue, assertSupportedJsonSchema } = await import("@deepseek-ai/dsh-tools");
const { saveCandidates } = await lib("extractor.js");

const waitFor = async (predicate, timeoutMs = 10000) => {
	const started = Date.now();
	for (;;) {
		if (await predicate()) return true;
		if (Date.now() - started > timeoutMs) return false;
		await new Promise((r) => setTimeout(r, 50));
	}
};

// bootMcp 是 void 的异步：等它把 profile 里的原生 MCP 抄进注册表
const profileImported = await waitFor(() => fs.existsSync(path.join(dshHome, "dsh-studio", "mcp.json")));

const checks = [];
const schemaChecks = [];
const record = async (name, args) => {
	const tool = tools.get(name);
	if (tool === undefined) {
		checks.push({ name, mode: "missing", reason: "注册表里没有这个工具" });
		return;
	}
	try {
		const value = await tool.execute(args ?? {});
		const violations = validateJsonSchemaValue(tool.output.schema, value, "value");
		checks.push({ name, mode: "live", keys: Object.keys(value).sort(), violations: violations.slice(0, 5), violationCount: violations.length });
		return value;
	} catch (error) {
		checks.push({ name, mode: "live", error: String(error?.message ?? error) });
		return undefined;
	}
};

// 27 个工具声明的 schema 先过一遍宿主 assertSupportedJsonSchema（写法子集校验）
for (const [name, tool] of tools) {
	try {
		assertSupportedJsonSchema(tool.output.schema);
		schemaChecks.push({ name, ok: true });
	} catch (error) {
		schemaChecks.push({ name, ok: false, reason: String(error?.message ?? error) });
	}
}

// ---- 1-4：读 / 详情 / 保存 / 策略
await record("skillmgr_list", {});
await record("skillmgr_get", { name: "disk-skill" });
await record("skillmgr_save", { name: "disk-skill", content: "---\nname: disk-skill\ndescription: 改过的正文\n---\nbody v2\n" });
await record("skillmgr_policy", { name: "disk-skill", enabled: false });

// ---- 5-9：回收站三件套 + 永久删除
const trashed = await record("skillmgr_trash", { name: "agent-skill" });
await record("skillmgr_trash_list", {});
if (trashed?.id !== undefined) await record("skillmgr_restore", { id: trashed.id });
const trashedAgain = await record("skillmgr_trash", { name: "agent-skill" });
if (trashedAgain?.id !== undefined) await record("skillmgr_purge", { id: trashedAgain.id });

// ---- 10-16：快照 / 恢复 / 待拉清单 / 导出导入
const snap = await record("skillmgr_snapshot", { label: "f4-all-tools" });
await record("skillmgr_snapshot_list", {});
if (snap?.id !== undefined) {
	// dry-run 与真恢复都带 pendingPulls —— F-4 的红点就在这里
	await record("skillmgr_snapshot_restore", { id: snap.id, dryRun: true });
	await record("skillmgr_snapshot_restore", { id: snap.id });
}
await record("skillmgr_pull_pending", {});
const exported = path.join(home, "exported-snapshot.tar.gz");
if (snap?.id !== undefined) await record("skillmgr_snapshot_transfer", { action: "export", id: snap.id, path: exported });
await record("skillmgr_snapshot_transfer", { action: "import", path: exported, label: "imported" });

// ---- 17-21：同步通道（本地 bare 仓库当远端，全程离线）与上游检查
await record("skillmgr_sync", { action: "config" });
if (snap?.id !== undefined) {
	await record("skillmgr_sync", {
		action: "config",
		channel: "git",
		settings: JSON.stringify({ git: { remote: remoteRepo, workDir: syncWork } })
	});
	await record("skillmgr_sync", { action: "push", channel: "git", snapshotId: snap.id });
	await record("skillmgr_sync", { action: "pull", channel: "git" });
}
await record("skillmgr_update_check", { root: agentRoot, timeoutMs: 3000 });

// ---- 22-28：提取配置 / 提取 / 候选接受与拒绝 / 质量度量
await record("skillmgr_extract_status", {});
await record("skillmgr_extract_config", { enabled: true, windowDays: 7 });
await record("skillmgr_extract_run", {});
await record("skillmgr_extract_list", {});
await saveCandidates([
	{ id: "f4-accept", status: "pending", created: Date.now(), name: "f4-accepted", description: "接受演示", rationale: "r", body: "正文" },
	{ id: "f4-reject", status: "pending", created: Date.now(), name: "f4-rejected", description: "拒绝演示", rationale: "r", body: "正文" }
]);
await record("skillmgr_extract_accept", { ids: ["f4-accept"] });
await record("skillmgr_extract_reject", { ids: ["f4-reject"] });
await record("skillmgr_quality", {});

// ---- 29-33：MCP 五件套（mock stdio 对端，真连真调）
await record("mcp_list", {});
await record("mcp_register", { name: "fixture-mcp", command: process.execPath, args: [mockServer], tier: "on-demand" });
await record("mcp_load", { name: "fixture-mcp" });
await record("mcp_call", { name: "fixture-mcp", tool: "echo", args: { text: "hi" } });
await record("mcp_takeover", { name: "native-one" });

process.stdout.write(
	JSON.stringify({
		toolNames: [...tools.keys()].sort(),
		count: tools.size,
		profileImported,
		checks,
		schemaChecks
	}),
	// MCP 连接还挂着一个子进程句柄；结果写完后直接收工，别让父测试等 EOF
	() => process.exit(0)
);
