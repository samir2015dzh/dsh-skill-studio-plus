/**
 * 提取 prompt 加「用户明确要求记住的内容优先」：
 * 短路只保证跑一次提取，但模型的选题标准是「最像可复用技术」，
 * 会把用户点名叫记住的那件事挤掉。这里显式给优先级。
 */
import fs from 'node:fs'

const P = fileURLToPath(new URL("../lib/extractor.js", import.meta.url))
let t = fs.readFileSync(P, 'utf8')

const ANCHOR = '只考虑：跨项目、可复用、agent 以后能反复照做的内容。'
const INSERT = [
  '**第一优先级：用户明确要求记住的内容**（原话里出现「记住」「以后都按这个」「下次也这样」等）。',
  '遇到这类内容，必须单独写成一条 skill，正文以它为核心，不要和别的主题混在一条里；即使它看起来不像「技术」也要写。',
  '',
].join('\n')

if (t.includes('第一优先级：用户明确要求记住的内容')) {
  console.log('已存在，跳过')
} else if (!t.includes(ANCHOR)) {
  console.log('⚠ 锚点未找到')
} else {
  t = t.replace(ANCHOR, INSERT + ANCHOR)
  fs.writeFileSync(P, t, 'utf8')
  console.log('已插入「记住优先」指令')
}

// 复查
const i = t.indexOf('export function buildPrompt')
console.log('\n=== buildPrompt 片段')
console.log(t.slice(i, i + 760))
