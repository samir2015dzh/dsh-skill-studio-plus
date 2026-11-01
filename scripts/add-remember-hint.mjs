/**
 * 给 shouldExtract 加「用户明确要求记住」的关键词短路：
 * 说「记住 X」时不再问模型值不值得，直接放行提取。
 * 同时把摘要窗口从 10 条放宽到 20 条，覆盖稍早的「记住」指令。
 */
import fs from 'node:fs'

const P = 'D:/dsh-plugins/dsh-skill-studio/lib/extractor.js'
let t = fs.readFileSync(P, 'utf8')
const log = []

// 1) 摘要窗口 10 → 20
if (t.includes('buildDigest(digs[0].log, 10, 400)')) {
  t = t.replace('buildDigest(digs[0].log, 10, 400)', 'buildDigest(digs[0].log, 20, 400)')
  log.push('摘要窗口 10 → 20 条')
}

// 2) 关键词常量
if (!t.includes('REMEMBER_HINT')) {
  const line = 'const REMEMBER_HINT = /(记住|记一下|记下来|以后都用|以后都按|下次也这|下次也按|按这个来|别忘了|不要忘)/;'
  const anchor = 'const VERDICT_SYSTEM'
  if (t.includes(anchor)) {
    const comment = '/** 用户明确要求记住的说法 —— 命中就跳过判定，避免「说了记住却没记」 */'
    t = t.replace(anchor, [comment, line, '', anchor].join('\n'))
    log.push('已插入 REMEMBER_HINT 常量')
  } else {
    log.push('⚠ VERDICT_SYSTEM 未找到')
  }
}

// 3) 判定前短路
if (!t.includes('REMEMBER_HINT.test(digest)')) {
  const start = t.indexOf('export async function shouldExtract')
  const pos = start > 0 ? t.indexOf('const prompt = [', start) : -1
  if (pos > 0) {
    t = t.slice(0, pos) + 'if (REMEMBER_HINT.test(digest)) return true;\n\t\t' + t.slice(pos)
    log.push('已插入判定前短路')
  } else {
    log.push('⚠ shouldExtract 内的 prompt 锚点未找到')
  }
}

fs.writeFileSync(P, t, 'utf8')
console.log(log.join('\n'))
