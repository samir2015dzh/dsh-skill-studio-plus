// 按用途给技能分类（dry-run）。只读：扫描 SKILL.md 的 name/description，
// 用关键词打分归类，打印「名 → 建议分组（依据）」，不写任何文件。
//
// 用法：
//   node scripts/classify-skills.mjs              # 全部技能统计 + 明细
//   node scripts/classify-skills.mjs --limit 40   # 只列前 40 条明细
//   node scripts/classify-skills.mjs --only 未分组 # 只看某个建议分组
import { scanSkills } from '../lib/scanner.js'

const RULES = [
  {
    group: '逆向分析',
    kw: ['reverse', 'decompile', 'disassembl', 'apk', 'binary', 'ghidra', 'ida', 'jadx', 'frida', 'unpack', 'deobfusc', 'smali', 'ilspy', 'dnspy', 'dotnet', 'hook', 'exe', 'dll', 'pe32', 'elf', '逆向', '反编译', '脱壳', '混淆', '字节码', '加固', 'native', 'assembly', 'instruction']
  },
  {
    group: '安全测试',
    kw: ['security', 'pentest', 'vulnerab', 'exploit', 'xss', 'sqli', 'sql injection', 'ssrf', 'xxe', 'ssti', 'csrf', 'idor', 'waf', 'cve', 'red team', 'recon', 'attack', 'payload', 'privilege', 'scan', 'nmap', 'masscan', 'bypass', 'injection', 'lfi', 'rfi', 'path-traversal', 'fingerprint', 'authbypass', 'authentication', 'hack', 'ctf', 'strix', 'fuzz', 'brute', 'crack', 'hashcat', 'hash-crack', 'certificate', 'tls', '渗透', '漏洞', '攻击面', '提权', '内网', '横向', '爆破', '未授权', '凭据', '扫描', '绕过', '注入']
  },
  {
    group: '代码工程',
    kw: ['refactor', 'debug', 'test', 'build', 'compile', 'git', 'commit', 'code review', 'typescript', 'python', 'java', 'swing', 'jvm', '重构', '调试', '构建', '编译', '代码', '接口', '依赖', '重打包', '产物', '回归']
  },
  {
    group: '文档写作',
    kw: ['article', 'write', 'docs', 'docx', 'word', 'minutes', 'report', 'style', 'slide', 'pptx', 'xlsx', 'format', 'layout', 'font', '纪要', '文案', '公众号', '报告', '写作', '排版', '文稿', '文档', '表格', '演示']
  },
  {
    group: '环境运维',
    kw: ['windows', 'linux', 'server', 'proxy', 'tunnel', 'docker', 'install', 'provision', 'ssh', 'systemd', 'unraid', 'pve', 'tailscale', 'network', '维护', '部署', '安装', '代理', '隧道', '服务器', '网络', '清理', '回滚']
  },
  {
    group: '数据检索',
    kw: ['scrape', 'crawl', 'fetch', 'cdp', 'browser', 'search', 'playwright', 'puppeteer', 'html', 'website', 'url', 'http', 'corpus', '抓取', '爬虫', '检索', '查询', '语料', '采集', '网页', '截图']
  },
  {
    group: '流程协作',
    kw: ['handoff', 'delegat', 'subagent', 'workflow', 'review', 'plan', 'todo', 'goal', 'acceptance', 'delivery', '交接', '协作', '流程', '计划', '评审', '验收', '交付']
  }
]

function classify(skill) {
  const name = String(skill.name ?? '').toLowerCase()
  const desc = String(skill.description ?? '').toLowerCase()
  const scores = []
  for (const rule of RULES) {
    let score = 0
    const hits = []
    for (const k of rule.kw) {
      const tokens = name.split(/[^a-z0-9]+/).filter(Boolean)
      const inName = name.includes(k)
      const inToken = tokens.includes(k) || tokens.some((t) => t.startsWith(k) && k.length >= 3)
      const inDesc = desc.includes(k)
      if (inName || inDesc) {
        score += inToken ? 4 : inName ? 3 : 1
        hits.push(k)
      }
    }
    if (score > 0) scores.push({ group: rule.group, score, hits: hits.slice(0, 3) })
  }
  scores.sort((a, b) => b.score - a.score)
  if (scores.length === 0) return { group: '其他', score: 0, hits: [] }
  return scores[0]
}

const args = process.argv.slice(2)
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 30
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null

const skills = await scanSkills(process.cwd())
const buckets = new Map()
const rows = []
for (const skill of skills) {
  const verdict = classify(skill)
  rows.push({ name: skill.name, group: verdict.group, score: verdict.score, hits: verdict.hits, hasGroup: typeof skill.group === 'string' && skill.group !== '' })
  if (!buckets.has(verdict.group)) buckets.set(verdict.group, 0)
  buckets.set(verdict.group, buckets.get(verdict.group) + 1)
}

console.log(`共 ${skills.length} 个技能\n`)
console.log('=== 建议分组统计 ===')
for (const [group, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${group.padEnd(8)} ${String(n).padStart(4)}`)
}

const withGroup = rows.filter((r) => r.hasGroup).length
console.log(`\n已有 metadata.group：${withGroup} 个；需要写入：${rows.length - withGroup} 个`)

console.log(`\n=== 明细（前 ${limit} 条）===`)
const shown = rows.filter((r) => (only === null ? true : r.group === only)).slice(0, limit)
for (const r of shown) {
  const mark = r.hasGroup ? '已有' : '    '
  const why = r.hits.length > 0 ? `  ← ${r.hits.join(', ')}` : ''
  console.log(`${mark} ${r.name.padEnd(42)} ${r.group.padEnd(6)}${why}`)
}

if (only === null) {
  const low = rows.filter((r) => r.score <= 1)
  if (low.length > 0) {
    console.log(`\n=== 低置信度（${low.length} 个，建议人工过一眼）===`)
    for (const r of low.slice(0, 20)) console.log(`  ${r.name.padEnd(42)} ${r.group}`)
  }
}


// ── 写入模式 ────────────────────────────────────────────────────────────────
// node scripts/classify-skills.mjs --write [--dry]
// 只给「没有 metadata.group」且有实体文件的技能加三行；其他分类（其他）不写。
if (args.includes('--write')) {
  const { readFile, writeFile, copyFile } = await import('node:fs/promises')
  const dry = args.includes('--dry')
  let written = 0
  let skipped = 0
  const failed = []
  for (const skill of skills) {
    if (typeof skill.group === 'string' && skill.group !== '') { skipped += 1; continue }
    if (typeof skill.path !== 'string' || skill.path === '') { skipped += 1; continue }
    const verdict = classify(skill)
    if (verdict.group === '其他') { skipped += 1; continue }
    try {
      const text = await readFile(skill.path, 'utf8')
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
      if (m === null) { skipped += 1; continue }
      let fm = m[1]
      if (/^metadata:\s*$/m.test(fm)) {
        fm = fm.replace(/^(metadata:\s*)$/m, `$1\n  group: ${verdict.group}`)
      } else if (/^metadata:\s*\{/m.test(fm) || /^group:/m.test(fm)) {
        skipped += 1
        continue
      } else {
        fm = fm + `\nmetadata:\n  group: ${verdict.group}`
      }
      const next = text.replace(m[0], `---\n${fm}\n---`)
      if (!dry) {
        await copyFile(skill.path, skill.path + '.bak-group')
        await writeFile(skill.path, next, 'utf8')
      }
      written += 1
    } catch (error) {
      failed.push({ name: skill.name, error: String(error) })
    }
  }
  console.log(`\n${dry ? '[dry] ' : ''}写入 ${written} 个，跳过 ${skipped} 个，失败 ${failed.length} 个`)
  for (const f of failed.slice(0, 10)) console.log('  失败:', f.name, f.error)
}
