// 模拟 boot 加载测试 + 扫描器/合并/编辑逻辑单测（检查清单第 2 条）
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");
// Windows 上 import() 不接受裸盘符路径，必须转成 file:// URL
const modUrl = (rel) => pathToFileURL(path.join(pluginRoot, rel)).href;

// M-4：全程在临时 HOME 下跑 —— 预热轮询会写 registry-cache.json，
// 绝不能落到真实 ~/.dsh/dsh-studio/ 上去。必须在 import lib/index.js 之前设好。
const realHome = homedir();
const fakeHome = mkdtempSync(path.join(tmpdir(), "dsh-sm-home-"));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;

const m = await import(modUrl("lib/index.js"));
const scanner = await import(modUrl("lib/scanner.js"));

const { splitFrontmatter, applyPolicy, assembleFile, saveSkill, savePolicy, listSkills, getSkillDetail } = m;
const { parseSkillFile, scanSkills, findSkillByName } = scanner;

let failures = 0;
const assert = (cond, label) => {
  if (cond) console.log("  ✅", label);
  else { console.error("  ❌", label); failures++; }
};

// ---------- 1. frontmatter 解析与行编辑 ----------
console.log("\n[1] frontmatter 解析与行编辑");
{
  const p = parseSkillFile("---\ntype: skill\nname: demo-skill\ndescription: 演示\n# 注释\n---\n# 正文\n内容");
  assert(p.fields.name === "demo-skill", "解析 name");
  assert(p.fields.description === "演示", "解析 description");
  assert(p.body.startsWith("# 正文"), "正文分离");
  assert(p.fields.disableModelInvocation === null && p.fields.userInvocable === null, "默认策略为空");
}
{
  const p = parseSkillFile("---\nname: x\nuser-invocable: false\ndisable-model-invocation: true\n---\nbody");
  assert(p.fields.userInvocable === false && p.fields.disableModelInvocation === true, "解析调用策略布尔");
}
{
  const p = parseSkillFile("---\ndescription: |\n  多行\n  描述\nname: block-skill\n---\nbody");
  assert(p.fields.description === "多行\n描述", "解析块值描述: " + JSON.stringify(p.fields.description));
}
{
  const p = parseSkillFile("---\nname: g\nmetadata:\n  group: 内容创作\n  tags: [a, b]\nuser-invocable: false\n---\nbody");
  assert(p.fields.metadata && p.fields.metadata.group === "内容创作", "解析嵌套 metadata.group");
  assert(p.fields.metadata.tags.join(",") === "a,b", "解析嵌套 metadata.tags（内联数组）");
  assert(p.fields.userInvocable === false, "嵌套块结束后继续解析顶层键");
}
{
  const p = parseSkillFile("---\nname: g2\nmetadata:\n  tags:\n    - 一\n    - 二\nuser-invocable: false\n---\nbody");
  assert(p.fields.metadata.tags.join(",") === "一,二", "解析嵌套 metadata.tags（多行列表）");
  assert(p.fields.userInvocable === false, "多行列表后继续解析顶层键");
}
{
  const p = parseSkillFile("---\nname: g3\n---\nbody");
  assert(p.fields.metadata === null, "无 metadata 时为 null");
}
{
  const src = "---\ntype: skill\nname: demo-skill\ndescription: 演示\n# 用户注释\n---\n# 正文\n内容";
  const fm = splitFrontmatter(src).frontmatter;
  const out = assembleFile(src, applyPolicy(fm, { modelInvocable: false, userInvocable: false }));
  assert(out.includes("disable-model-invocation: true") && out.includes("user-invocable: false"), "禁用 → 写入两个键");
  assert(out.includes("# 用户注释") && out.includes("type: skill"), "其他行保留");
  const out2 = assembleFile(out, applyPolicy(splitFrontmatter(out).frontmatter, { modelInvocable: true, userInvocable: true }));
  assert(!out2.includes("disable-model-invocation") && !out2.includes("user-invocable"), "启用 → 移除两个键");
}
{
  const src = "# 平铺 skill";
  const out = assembleFile(src, applyPolicy(null, { userInvocable: false }));
  assert(out.startsWith("---\nuser-invocable: false\n---\n"), "无 frontmatter 时创建块");
}

// ---------- 2. 扫描器（临时目录：顶层 + 嵌套展开） ----------
console.log("\n[2] 扫描器");
const tmp = mkdtempSync(path.join(tmpdir(), "dsh-sm-test-"));
const agentsRoot = path.join(tmp, ".agents", "skills");
const projDshRoot = path.join(tmp, ".dsh", "skills");
// 顶层 skill（project-agents 源）
mkdirSync(path.join(agentsRoot, "demo-skill"), { recursive: true });
writeFileSync(path.join(agentsRoot, "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: 演示技能\n---\n# 正文\n你好", "utf8");
// 嵌套 skill（模拟 superpowers）
mkdirSync(path.join(agentsRoot, "superpowers", "brainstorming"), { recursive: true });
writeFileSync(path.join(agentsRoot, "superpowers", "brainstorming", "SKILL.md"), "---\nname: brainstorming\ndescription: 头脑风暴\n---\n# 风暴", "utf8");
mkdirSync(path.join(agentsRoot, "superpowers", "writing-plans"), { recursive: true });
writeFileSync(path.join(agentsRoot, "superpowers", "writing-plans", "SKILL.md"), "---\nname: writing-plans\ndescription: 写计划\n---\n# 计划", "utf8");
// 平铺 .md skill（project-dsh 源）
mkdirSync(projDshRoot, { recursive: true });
writeFileSync(path.join(projDshRoot, "flat-skill.md"), "---\nname: flat-skill\ndescription: 平铺\n---\n# 平铺", "utf8");
// 带分组元数据的 skill（metadata.group / metadata.tags）
mkdirSync(path.join(agentsRoot, "grouped-skill"), { recursive: true });
writeFileSync(
  path.join(agentsRoot, "grouped-skill", "SKILL.md"),
  "---\nname: grouped-skill\ndescription: 分组演示\nmetadata:\n  group: 内容创作\n  tags: [小红书, 配图]\n---\n# 分组",
  "utf8"
);

const scanned = await scanSkills(tmp);
const names = scanned.map((s) => s.name);
assert(names.includes("demo-skill"), "顶层 skill 被发现: " + names.join(","));
assert(names.includes("brainstorming") && names.includes("writing-plans"), "嵌套 skill 被发现");
const nested = scanned.find((s) => s.name === "brainstorming");
assert(nested && nested.nested === true && nested.parent === "superpowers", "嵌套标记 + parent 正确");
assert(scanned.find((s) => s.name === "flat-skill").source === "project-dsh", "平铺 .md 发现 + 来源 project-dsh");
// ---- 分组元数据（SKILL.md 的 metadata.group / metadata.tags） ----
const grouped = scanned.find((s) => s.name === "grouped-skill");
assert(grouped && grouped.group === "内容创作", "扫描器读出 metadata.group: " + JSON.stringify(grouped && grouped.group));
assert(grouped && grouped.tags.join(",") === "小红书,配图", "扫描器读出 metadata.tags: " + JSON.stringify(grouped && grouped.tags));
assert(grouped && grouped.metadata && grouped.metadata.group === "内容创作", "扫描器保留 metadata 对象");
assert(scanned.find((s) => s.name === "demo-skill").group === "", "无 metadata 的 skill 分组为空字符串");
assert(scanned.find((s) => s.name === "demo-skill").tags.length === 0, "无 metadata 的 skill tags 为空数组");
const found = await findSkillByName("brainstorming", tmp);
assert(found && found.path.endsWith(path.join("brainstorming", "SKILL.md")), "findSkillByName 命中嵌套");

// ---------- 3. 模拟 boot apply + 合并 ----------
console.log("\n[3] 模拟 boot apply + 合并");
const registered = { tools: [], routes: [], sections: [], defs: {} };
const ctx = {
  skills: {
    // registry 视角：一个 runtime skill；无 filesystem provider
    list: async () => [
      { name: "vision-tools", description: "视觉工具", whenToUse: null, source: "runtime", provider: "runtime",
        invocation: { modelInvocable: true, userInvocable: true } }
    ],
    get: async () => undefined
  },
  tools: { register: (t) => { registered.tools.push(t.name); registered.defs[t.name] = t; return () => {}; } },
  webServer: { register: (r) => { registered.routes.push(r.path); return () => {}; } },
  systemPrompt: { section: (s) => { registered.sections.push(s.name); return () => {}; } },
  effect: (fn) => { const d = fn(); return () => (typeof d === "function" ? d() : undefined); },
  get: () => null,
  logger: { info: () => {} },
  interval: () => () => {},

  on: () => () => {}
};
m.apply(ctx, {});
assert(registered.tools.length === 27 && registered.tools.slice(0, 4).join(",") === "skillmgr_list,skillmgr_get,skillmgr_save,skillmgr_policy", "27 个工具注册（22 skillmgr + 5 mcp），首四名不变");
assert(registered.tools.includes("skillmgr_extract_run") && registered.tools.includes("skillmgr_extract_accept"), "提取工具已注册");
assert(registered.tools.includes("skillmgr_update_check"), "只读上游检查工具已注册（U-2）");
assert(registered.tools.includes("skillmgr_quality"), "只读质量度量工具已注册（Q-2）");
assert(registered.tools.includes("skillmgr_pull_pending"), "消费待拉清单的工具已注册（PULL-2）");

// M-2：全库口径（含 SKILL.md 的目录 / 跟随符号链接 / 按真实路径去重）必须写进工具描述
const updateCheckDesc = String(registered.defs.skillmgr_update_check?.description ?? "");
assert(
  ["含 SKILL.md 的目录", "跟随符号链接", "按真实路径去重"].every((key) => updateCheckDesc.includes(key)),
  "update_check 描述注明全库口径"
);
console.log("  ℹ skillmgr_update_check.description（注册原文）= " + updateCheckDesc);
assert(registered.routes.length === 32, "32 条路由注册（16 基础 + 9 提取 + 7 MCP）");
assert(registered.sections.length === 1, "系统提示段落注册");

// runtime skill 走 registry 摘要缓存（index.js:381-415）：首次 listSkills 只触发后台预热，
// 结果下一次调用才可见，且不能依赖上次运行留下的磁盘缓存——这里显式等预热落地。
let merged = await listSkills(ctx, tmp);
for (let i = 0; i < 200 && !merged.some((s) => s.name === "vision-tools"); i++) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  merged = await listSkills(ctx, tmp);
}
const mergedNames = merged.map((s) => s.name);
assert(mergedNames.includes("demo-skill") && mergedNames.includes("brainstorming"), "合并含文件系统 skill");
assert(mergedNames.includes("vision-tools"), "合并含 runtime skill");
const vt = merged.find((s) => s.name === "vision-tools");
assert(vt && vt.editable === false && vt.provider === "runtime", "runtime skill 只读标记");
assert(merged.find((s) => s.name === "grouped-skill").group === "内容创作", "listSkills 透出分组（面板与工具可见）");
assert(merged.find((s) => s.name === "grouped-skill").tags.length === 2, "listSkills 透出标签");

// M-4：预热写出的 registry 缓存必须落在临时 HOME 里
const fakeCache = path.join(fakeHome, ".dsh", "dsh-studio", "registry-cache.json");
for (let i = 0; i < 200 && !existsSync(fakeCache); i++) await new Promise((resolve) => setTimeout(resolve, 10));
assert(fakeHome !== realHome, "临时 HOME 与真实 HOME 不是同一路径");
assert(existsSync(fakeCache), "registry 缓存写到临时 HOME: " + fakeCache);

// M-2 的输出口径：临时 HOME 下没有 skill 根，execute 不发任何 ls-remote
const emptyRoot = path.join(fakeHome, "empty-root");
mkdirSync(emptyRoot, { recursive: true });
const updateCheckRun = await registered.defs.skillmgr_update_check.execute({ root: emptyRoot });
assert(
  /含 SKILL\.md 的目录，跟随符号链接，按真实路径去重/.test(String(updateCheckRun.message)),
  "update_check 汇总带全库口径注脚: " + updateCheckRun.message
);

// ---------- 4. 真实文件读写（编辑 + 开关） ----------
console.log("\n[4] 真实文件读写");
const detail = await getSkillDetail(ctx, "demo-skill", tmp);
assert(detail && detail.editable === true && detail.content.includes("# 正文"), "getSkillDetail 返回正文 + editable");
const detailGrouped = await getSkillDetail(ctx, "grouped-skill", tmp);
assert(detailGrouped && detailGrouped.group === "内容创作" && detailGrouped.tags.length === 2, "getSkillDetail 带分组与标签");

const saved = await saveSkill(ctx, { name: "demo-skill", content: "---\nname: demo-skill\ndescription: 改过的描述\n---\n# 新正文" }, tmp);
assert(saved.ok && readFileSync(path.join(agentsRoot, "demo-skill", "SKILL.md"), "utf8").includes("# 新正文"), "saveSkill 写回文件");

const pol = await savePolicy(ctx, { name: "demo-skill", enabled: false }, tmp);
const after = readFileSync(path.join(agentsRoot, "demo-skill", "SKILL.md"), "utf8");
assert(pol.ok && pol.modelInvocable === false && after.includes("disable-model-invocation: true"), "savePolicy 禁用（模型侧）");

const pol2 = await savePolicy(ctx, { name: "demo-skill", enabled: true }, tmp);
const after2 = readFileSync(path.join(agentsRoot, "demo-skill", "SKILL.md"), "utf8");
assert(!after2.includes("disable-model-invocation") && !after2.includes("user-invocable"), "重新启用后键被移除");

const pol3 = await savePolicy(ctx, { name: "brainstorming", userInvocable: false }, tmp);
const after3 = readFileSync(path.join(agentsRoot, "superpowers", "brainstorming", "SKILL.md"), "utf8");
assert(pol3.ok && after3.includes("user-invocable: false"), "嵌套 skill 开关写入");

// 只读 skill（runtime）拒绝编辑
let threw = false;
try { await saveSkill(ctx, { name: "vision-tools", content: "x" }, tmp); } catch (e) { threw = true; }
assert(threw, "runtime 只读 skill 拒绝编辑");

// ---------- 5. 客户端面板分组渲染冒烟（fake React 驱动真实组件） ----------
console.log("\n[5] 客户端面板分组渲染");
{
  let captured = null;
  globalThis.window = { __ModuleLoader__: { load: (mod) => { captured = mod; } } };
  await import(modUrl("lib/client.js"));
  assert(captured && typeof captured.factory === "function", "client bundle 经 window.__ModuleLoader__.load 注册");

  const sampleSkills = [
    { name: "a-skill", description: "甲", group: "内容创作", tags: ["x"], source: "user-agents", provider: "filesystem", modelInvocable: true, userInvocable: true, editable: true },
    { name: "b-skill", description: "乙", group: "内容创作", tags: [], source: "user-agents", provider: "filesystem", modelInvocable: true, userInvocable: true, editable: true },
    { name: "c-skill", description: "丙", group: "", tags: [], source: "runtime", provider: "runtime", modelInvocable: true, userInvocable: true, editable: false }
  ];
  // 依次对应 SkillManagerPanel 的 16 个 useState（client.js:1954-1974）：
  // skills/cwd/selected/draft/busy/msg/err/page/pageInput/view/
  // sourceFilter/activeFilter/trash/query/groupFilter/collapsed
  const stateQueue = [sampleSkills, "/tmp/ws", null, "", false, "", "", 0, "1", "skills", "all", "all", null, "", "all", {}];
  let stateIndex = 0;
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (init) => [
      stateIndex < stateQueue.length ? stateQueue[stateIndex++] : typeof init === "function" ? init() : init,
      () => {}
    ],
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useEffect: () => {}
  };
  // 三个设置页都会注册（client.js:2484/2499/2514），按 meta.id 存，
  // 取面板按 id 而不是注册顺序——顺序取到的是最后注册的 SnapshotPanel。
  const panels = new Map();
  const clientExports = captured.factory((name) => (name === "react" ? fakeReact : undefined));
  clientExports.apply({
    slots: {
      inject: (_name, callback) => { callback(); return () => {}; },
      register: (meta, component) => { panels.set(meta.id, component); return () => {}; }
    }
  });
  const Panel = panels.get("skill-manager");
  assert(typeof Panel === "function", "面板组件注册到 settings.section");

  /** Walk a fake element tree and collect GroupHeader / SkillRow element props. */
  const collect = (tree) => {
    const found = { headers: [], rows: [] };
    const walk = (node) => {
      if (node === null || node === undefined || typeof node === "boolean") return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node !== "object") return;
      if (typeof node.type === "function") {
        if (node.type.name === "GroupHeader") found.headers.push(node.props);
        else if (node.type.name === "SkillRow") found.rows.push(node.props);
      }
      if (Array.isArray(node.children)) node.children.forEach(walk);
    };
    walk(tree);
    return found;
  };

  // 默认渲染：分类只是筛选维度，列表恒平铺（client.js:1971-1972），groups 恒为单个 __all__（:2116）
  const defaultView = collect(Panel());
  assert(defaultView.headers.length === 0, "默认渲染不渲染组标题: " + defaultView.headers.map((p) => p.label).join(","));
  assert(defaultView.rows.filter((p) => p.skill.group === "内容创作").length === 2, "「内容创作」的 2 个 skill 平铺成行");
  assert(defaultView.rows.filter((p) => p.skill.group === "").length === 1, "「未分组」的 1 个 skill 平铺成行");

  // 平铺视图（groupView=false 恒成立，见 client.js:1972）
  stateIndex = 0;
  const flatView = collect(Panel());
  assert(flatView.headers.length === 0, "平铺视图不渲染组标题");
  assert(flatView.rows.length === 3 && flatView.rows.every((p) => p.showGroup === true), "平铺视图给每行加分组徽章");

  // 折叠状态（collapsed 非空）：只有 groupView 才读 collapsed（client.js:2366），平铺下无效果
  stateIndex = 0;
  stateQueue[15] = { "内容创作": true };
  const foldedView = collect(Panel());
  assert(foldedView.headers.length === 0, "collapsed 非空时仍不渲染组标题");
  assert(foldedView.rows.length === 3, "collapsed 非空时行数不变");
}

rmSync(fakeHome, { recursive: true, force: true });
console.log(failures === 0 ? "\n🎉 全部通过" : `\n💥 ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
