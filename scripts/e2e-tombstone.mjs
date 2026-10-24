/**
 * 墓碑专项：候选名字在归档里出现过时，即使模型裁决说 SAVE，也必须并入最像的既有 skill。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse, runExtraction, archivedNames } from '../lib/extractor.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-tomb-'))
process.env.DSH_SKILL_EXTRACTOR_CANDIDATES = path.join(tmp, 'candidates.json')
process.env.DSH_SKILL_EXTRACTOR_CONFIG = path.join(tmp, 'extractor.json')
const skillDir = path.join(tmp, 'skills')
fs.mkdirSync(path.join(skillDir, 'handoff'), { recursive: true })
fs.writeFileSync(
  path.join(skillDir, 'handoff', 'SKILL.md'),
  `---\nname: handoff\ndescription: "Use when 上下文快满、要写交接文档给新会话"\n---\n\n## 概述\n既有内容。\n`
)

const cfg = parse({ enabled: true, windowDays: 7, maxCandidatesPerRun: 3, agentSkillDir: skillDir, autoAccept: true, mergeThreshold: 0.2 })
const tomb = await archivedNames()
const ghost = tomb.has('long-session-handoff-split') ? 'long-session-handoff-split' : [...tomb][0]
console.log('用归档名做候选 =', ghost, '| 墓碑数 =', tomb.size)

const calls = []
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
        // 故意让模型说 SAVE：墓碑必须压过它
        body = JSON.stringify({ decisions: [{ candidate: ghost, action: 'SAVE' }] })
      } else if (text.includes('【既存 skill】')) {
        calls.push('merge')
        body = 'MERGE: ## 概述\n既有内容。\n\n## 补充\n墓碑强制并入的新经验。'
      } else {
        calls.push('extract')
        body = JSON.stringify({ candidates: [{ name: ghost, description: 'Use when context is nearly full and work must continue in a fresh session', rationale: 'r', body: '## 概述\n新内容。' }] })
      }
      return (async function* () {
        yield { type: 'text-delta', text: body.slice(0, 20) }
        yield { type: 'text-delta', text: body.slice(20) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }),
}

const r = await runExtraction(cfg, path.join(os.homedir(), '.dsh', 'sessions'), { llm: fakeLlm, agent: null })
console.log('调用序列 =', calls.join(' → '))
console.log('merged   =', JSON.stringify(r.merged ?? []))
console.log('dropped  =', JSON.stringify(r.dropped ?? []))
console.log('accepted =', JSON.stringify((r.accepted ?? []).map((a) => a.name)))
const body = fs.readFileSync(path.join(skillDir, 'handoff', 'SKILL.md'), 'utf8')
console.log('新建了同名目录吗 =', fs.existsSync(path.join(skillDir, ghost)))
console.log('handoff 被写入 =', body.includes('墓碑强制并入的新经验'))
fs.rmSync(tmp, { recursive: true, force: true })
