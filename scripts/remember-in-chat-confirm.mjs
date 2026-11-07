/**
 * 「用户说记住」改成对话内二次确认：
 *  - shouldExtract 带回用户原话
 *  - 命中时不提取，写一条 pending
 *  - 下一轮 system-prompt 注入确认请求，模型主动开口问
 *  - 注入后立即清空，避免反复追问
 */
import fs from 'node:fs'

const EX = fileURLToPath(new URL("../lib/extractor.js", import.meta.url))
const IX = fileURLToPath(new URL("../lib/index.js", import.meta.url))
const log = []

// ---------- 1. extractor：带回用户原话 ----------
let e = fs.readFileSync(EX, 'utf8')
const OLD_LINE = '\t\tif (REMEMBER_HINT.test(userLines)) return { worth: true, remember: true };'
const NEW_LINES = [
  '\t\tconst rememberLine = userLines.split("\\n").find((l) => REMEMBER_HINT.test(l));',
  '\t\tif (rememberLine !== undefined) {',
  '\t\t\treturn { worth: true, remember: true, rememberText: rememberLine.replace(/^- 用户：/, "").trim() };',
  '\t\t}',
].join('\r\n')

if (e.includes(OLD_LINE)) {
  e = e.replace(OLD_LINE, NEW_LINES)
  log.push('extractor: shouldExtract 带回 rememberText')
} else {
  log.push('⚠ extractor: shouldExtract 锚点未找到')
}
fs.writeFileSync(EX, e, 'utf8')

// ---------- 2. index：pending 文件 + assemble 注入 ----------
let i = fs.readFileSync(IX, 'utf8')

// 2a. import homedir（如果还没有）
if (!i.includes('from "node:os"')) {
  i = i.replace('import { resolve } from "node:path";', 'import { resolve } from "node:path";\r\nimport { homedir } from "node:os";')
  log.push('index: 补 homedir import')
}

// 2b. pending 读写函数（插在 resolveSettingsReader 之前）
const ANCHOR_FN = '/** 读 DSH settings（新宿主用 describe()，老宿主用 get(ns)）。 */'
const PENDING_FNS = [
  '/** 用户说「记住」时挂起的确认请求；注入一次 system-prompt 后清空。 */',
  'const PENDING_REMEMBER_FILE = () => resolve(homedir(), ".dsh", "dsh-skill-studio", "pending-remember.json");',
  'async function savePendingRemember(text) {',
  '	try {',
  '		await writeFile(PENDING_REMEMBER_FILE(), JSON.stringify({ text, at: Date.now() }), "utf8");',
  '		return true;',
  '	} catch {',
  '		return false;',
  '	}',
  '}',
  'async function takePendingRemember() {',
  '	try {',
  '		const raw = await readFile(PENDING_REMEMBER_FILE(), "utf8");',
  '		await writeFile(PENDING_REMEMBER_FILE(), "{}", "utf8");',
  '		const j = JSON.parse(raw);',
  '		if (j && typeof j.text === "string" && j.text !== "") return j;',
  '	} catch {',
  '		/* 没有挂起请求 */',
  '	}',
  '	return null;',
  '}',
  '',
  ANCHOR_FN,
].join('\r\n')

if (!i.includes('PENDING_REMEMBER_FILE')) {
  if (i.includes(ANCHOR_FN)) {
    i = i.replace(ANCHOR_FN, PENDING_FNS)
    log.push('index: 插入 pending 读写函数')
  } else {
    log.push('⚠ index: pending 函数锚点未找到')
  }
} else {
  log.push('index: pending 函数已存在')
}

// 2c. 命中时改为挂起 + 不提取
const OLD_JUDGE = '\t\t\tif (!verdict.worth) return;'
const NEW_JUDGE = [
  '\t\t\tif (!verdict.worth) return;',
  '\t\t\tif (verdict.remember) {',
  '\t\t\t\t// 用户点名要求记住：不在后台静默生成，挂起一条确认请求，下一轮直接问',
  '\t\t\t\tconst ok = await savePendingRemember(verdict.rememberText ?? "（未捕获原话）");',
  '\t\t\t\tctx.logger?.info?.("[dsh-skill-studio] remember request pending confirmation: " + String(verdict.rememberText ?? "").slice(0, 60) + (ok ? "" : " (写入失败)"));',
  '\t\t\t\treturn;',
  '\t\t\t}',
].join('\r\n')

if (i.includes(OLD_JUDGE) && !i.includes('remember request pending confirmation')) {
  i = i.replace(OLD_JUDGE, NEW_JUDGE)
  log.push('index: 命中「记住」改为挂起确认')
} else if (i.includes('remember request pending confirmation')) {
  log.push('index: 挂起逻辑已存在')
} else {
  log.push('⚠ index: judgeThenExtract 锚点未找到')
}

// 2d. assemble 注入（加在 apply 开头的 lastAgent 附近）
const ANCHOR_APPLY = '\tlet lastAgent = null;'
const ASSEMBLE_HOOK = [
  '\t// 下一轮开头主动确认「记住」请求：注入一次即清空，不反复追问',
  '\tif (typeof ctx.on === "function") {',
  '\t\tctx.on("system-prompt/assemble", async (assembly, _context, next) => {',
  '\t\t\tconst out = await next();',
  '\t\t\ttry {',
  '\t\t\t\tconst pending = await takePendingRemember();',
  '\t\t\t\tif (pending === null) return out;',
  '\t\t\t\tconst text = [',
  '\t\t\t\t\t"## 待确认的「记住」请求",',
  '\t\t\t\t\t"",',
  '\t\t\t\t\t"用户上一轮说过：「" + pending.text + "」。",',
  '\t\t\t\t\t"",',
  '\t\t\t\t\t"在继续其它工作之前，先用一句话问用户：这条要写成独立 skill（以后自动生效），还是只作为本次对话的临时约定？",',
  '\t\t\t\t\t"- 用户说要 → 调 skillmgr_extract_run 提取一次",',
  '\t\t\t\t\t"- 用户说不用 → 忽略，不要反复追问",',
  '\t\t\t\t].join("\\n");',
  '\t\t\t\treturn { ...out, sections: [...(out.sections ?? []), { name: "plugin:dsh-skill-studio:remember", text }] };',
  '\t\t\t} catch {',
  '\t\t\t\treturn out;',
  '\t\t\t}',
  '\t\t});',
  '\t}',
  '',
  ANCHOR_APPLY,
].join('\r\n')

if (!i.includes('plugin:dsh-skill-studio:remember')) {
  if (i.includes(ANCHOR_APPLY)) {
    i = i.replace(ANCHOR_APPLY, ASSEMBLE_HOOK)
    log.push('index: 插入 assemble 注入')
  } else {
    log.push('⚠ index: apply 锚点未找到')
  }
} else {
  log.push('index: assemble 注入已存在')
}

fs.writeFileSync(IX, i, 'utf8')
console.log(log.join('\n'))
