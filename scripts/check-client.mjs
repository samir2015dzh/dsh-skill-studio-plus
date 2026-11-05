// 客户端静态自检：抓两类只在运行时才炸的错误。
//
//   node scripts/check-client.mjs
//
// 1) 组件里的局部样式变量（inputStyle / field / stat …）是否在本函数内定义
// 2) 被调用的 api.xxx() 是否都在 Api 类里有定义
//
// 这两类问题 node --check 都发现不了：它只管括号，不管作用域。
import { readFileSync } from 'node:fs'

const file = new URL('../lib/client.js', import.meta.url)
const src = readFileSync(file, 'utf8')
const lines = src.split(/\r?\n/)
let problems = 0

// ── 1. 组件作用域 ──────────────────────────────────────────────────────
const starts = []
for (let i = 0; i < lines.length; i += 1) {
  const m = lines[i].match(/^\t\tfunction ([A-Z]\w+)\(/)
  if (m) starts.push({ name: m[1], line: i })
}
const LOCAL_STYLES = ['inputStyle', 'field', 'pill', 'stat', 'toolbar', 'transferBar', 'listPart', 'maskValue', 'copyValue']
for (let k = 0; k < starts.length; k += 1) {
  const start = starts[k].line
  const end = k + 1 < starts.length ? starts[k + 1].line : lines.length
  const body = lines.slice(start, end).join('\n')
  for (const name of LOCAL_STYLES) {
    if (!new RegExp(`\\b${name}\\b`).test(body)) continue
    if (new RegExp(`(const|let|var|function)\\s+${name}\\b`).test(body)) continue
    console.log(`[作用域] ${starts[k].name} 用了 ${name}，但本函数内没定义`)
    problems += 1
  }
}

// ── 2. Api 方法对账 ────────────────────────────────────────────────────
const apiStart = src.indexOf('var Api = class')
if (apiStart >= 0) {
  const apiEnd = src.indexOf('\n\t\t};', apiStart)
  const apiBody = src.slice(apiStart, apiEnd)
  const methods = new Set([...apiBody.matchAll(/async (\w+)\(/g)].map((m) => m[1]))
  const calls = new Set([...src.matchAll(/\bapi\.(\w+)\(/g)].map((m) => m[1]))
  for (const name of calls) {
    if (methods.has(name)) continue
    console.log(`[Api] 调用了 api.${name}()，但 Api 类里没有这个方法`)
    problems += 1
  }
} else {
  console.log('[Api] 找不到 Api 类，跳过对账')
  problems += 1
}

console.log(problems === 0 ? `通过：${starts.length} 个组件、Api 方法全部对得上` : `发现 ${problems} 处问题`)
process.exit(problems === 0 ? 0 : 1)
