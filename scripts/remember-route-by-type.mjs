/**
 * 「记住」的确认请求改成先分类再问：
 * 方法→skill、偏好→AGENTS.md、事实→记忆库，三者的落点与生效方式不同。
 */
import fs from 'node:fs'

const P = 'D:/dsh-plugins/dsh-skill-studio/lib/index.js'
const lines = fs.readFileSync(P, 'utf8').split('\n')

const start = lines.findIndex((l) => l.includes('待确认的「记住」请求'))
if (start < 0) {
  console.log('未找到注入块')
  process.exit(1)
}
let end = start
while (end < lines.length && !lines[end].includes('用户说不用 → 忽略')) end++
if (end >= lines.length) {
  console.log('未找到结束行')
  process.exit(1)
}

console.log(`替换第 ${start + 1}–${end + 1} 行（${end - start + 1} 行）`)

const T = '\t\t\t\t\t'
const replacement = [
  `${T}"## 待确认的「记住」请求",`,
  `${T}"",`,
  `${T}"用户上一轮说过：「" + pending.text + "」。",`,
  `${T}"",`,
  `${T}"在继续其它工作之前，先判断这条属于哪类，再给用户一个明确落点：",`,
  `${T}"",`,
  `${T}"| 内容类型 | 放哪 | 生效方式 |",`,
  `${T}"|---|---|---|",`,
  `${T}"| 方法 / 流程（怎么做一件事，如「专题会该怎么写」） | skill | 提到相关场景时才加载 |",`,
  `${T}"| 偏好 / 规矩（以后都这样，如「回答先给结论」） | \`~/.dsh/AGENTS.md\` | 每轮常驻，不用触发 |",`,
  `${T}"| 事实 / 环境（这台机器、这个项目的事实） | 记忆库 retain | 检索时取回 |",`,
  `${T}"",`,
  `${T}"然后一句话问用户确认，例如：「这条我记成 skill（提专题会时自动加载），还是写进 AGENTS.md（每轮都生效）？」不要自己替用户选。",`,
  `${T}"- 用户选 skill → 调 skillmgr_extract_run，或直接写 \`~/.agents/skills/<name>/SKILL.md\`",`,
  `${T}"- 用户选 AGENTS.md → 直接编辑 \`~/.dsh/AGENTS.md\`",`,
  `${T}"- 用户选记忆 → 调 mcp__hindsight__retain",`,
  `${T}"- 用户说不用记 → 忽略，不要反复追问",`,
]

lines.splice(start, end - start + 1, ...replacement)
fs.writeFileSync(P, lines.join('\n'), 'utf8')
console.log('已替换')

// 复查
const t = fs.readFileSync(P, 'utf8')
const i = t.indexOf('待确认的「记住」请求')
console.log('\n=== 复查')
console.log(t.slice(i - 60, i + 900).replace(/\r\n/g, '\n'))
