/**
 * 端到端预演：临时目录 + 假模型，验证
 *   extract → placement（含类别标签）→ 误合并被拒 → merge → autoAccept
 * 全程不碰真实 ~/.agents/skills。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse, runExtraction } from '../lib/extractor.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-e2e-'))
process.env.DSH_SKILL_EXTRACTOR_CANDIDATES = path.join(tmp, 'candidates.json')
process.env.DSH_SKILL_EXTRACTOR_CONFIG = path.join(tmp, 'extractor.json')
const skillDir = path.join(tmp, 'skills')
fs.mkdirSync(skillDir, { recursive: true })

function seed(name, description) {
  fs.mkdirSync(path.join(skillDir, name), { recursive: true })
  fs.writeFileSync(
    path.join(skillDir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n## 概述\n既有内容。\n`
  )
}
seed('handoff', 'Use when 上下文快满、要写交接文档给新会话继续')
seed('java-legacy-parity-probe', 'Use when comparing a reimplemented legacy Java class against the original')

const cfg = parse({
  enabled: true,
  windowDays: 7,
  maxCandidatesPerRun: 3,
  agentSkillDir: skillDir,
  mirrorDir: '',
  autoAccept: true,
  mergeThreshold: 0.2,
})

const calls = []
const CANDIDATES = {
  candidates: [
    { name: 'handoff-doc-write', description: 'Use when 上下文快满，要写交接文档给新会话', rationale: '同属交接流程', body: '## 概述\n新经验。' },
    { name: 'decompiled-java-semantic-check', description: 'Use when verifying a reimplemented Java class from decompiled sources', rationale: '反编译类', body: '## 概述\n反编译验证。' },
    { name: 'brand-new-skill', description: 'Use when 需要给日志打颜色分级', rationale: '全新主题', body: '## 概述\n全新内容。' },
  ],
}
// 故意把 decompile 类候选指到 java 类 skill 上 —— 本地复核应当改判 SAVE
const PLACEMENT = {
  decisions: [
    { candidate: 'handoff-doc-write', action: 'FOLD_INTO', into: 'handoff' },
    { candidate: 'decompiled-java-semantic-check', action: 'FOLD_INTO', into: 'java-legacy-parity-probe' },
    { candidate: 'brand-new-skill', action: 'SAVE' },
  ],
}
const MERGED = `MERGE: ## 概述
既有内容。

## 核心模式
1. 交接前先把文档里的命令自己跑一遍。
2. 已证伪的路径要写明原因。

## 常见错误
只写「继续」不写状态。`

const fakeLlm = {
  listProviders: () => [{ id: 'magpie' }],
  listModels: async () => [{ id: 'group/deepseek-v4.1' }],
  prepareCall: async (c) => ({
    config: { provider: c.provider, model: c.model, maxTokens: c.maxTokens },
    stream: (opts) => {
      const text = JSON.stringify(opts?.messages ?? '')
      let body
      if (text.includes('【已有 skill 清单】')) {
        calls.push('placement')
        body = JSON.stringify(PLACEMENT)
      } else if (text.includes('【既存 skill】')) {
        calls.push('merge')
        body = MERGED
      } else {
        calls.push('extract')
        body = '```json\n' + JSON.stringify(CANDIDATES) + '\n```\n\n以上为候选，请审核。'
      }
      return (async function* () {
        yield { type: 'text-delta', text: body.slice(0, 20) }
        yield { type: 'text-delta', text: body.slice(20) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }),
}

const result = await runExtraction(cfg, path.join(os.homedir(), '.dsh', 'sessions'), { llm: fakeLlm, agent: null })

const accepted = (result.accepted ?? []).map((a) => a.name)
const merged = result.merged ?? []
const handoffBody = fs.readFileSync(path.join(skillDir, 'handoff', 'SKILL.md'), 'utf8')
const javaBody = fs.readFileSync(path.join(skillDir, 'java-legacy-parity-probe', 'SKILL.md'), 'utf8')

console.log('调用序列 =', calls.join(' → '))
console.log('merged   =', JSON.stringify(merged))
console.log('accepted =', JSON.stringify(accepted))
const checks = [
  ['同类别 → 合并成功', merged.some((m) => m.from === 'handoff-doc-write' && m.into === 'handoff' && m.by === 'model')],
  ['主 skill 被改写', handoffBody.includes('已证伪的路径要写明原因')],
  ['跨类别被拒 → 当新 skill 落盘', accepted.includes('decompiled-java-semantic-check')],
  ['java skill 未被误写', !javaBody.includes('反编译验证')],
  ['全新主题落盘', accepted.includes('brand-new-skill')],
  ['被合并的候选不在队列', !(result.candidates ?? []).some((c) => c.name === 'handoff-doc-write')],
]
for (const [label, ok] of checks) console.log(ok ? '  ✅' : '  ❌', label)
console.log(checks.every(([, ok]) => ok) ? '\n全部通过' : '\n有失败项')

fs.rmSync(tmp, { recursive: true, force: true })
