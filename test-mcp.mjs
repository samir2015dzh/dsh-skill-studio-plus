// 最小的 stdio MCP 服务器，只用来验证 dsh-mcp-manager 的空闲回收：
// 每次被拉起时往 _test-mcp.log 追加一行时间戳，回收后再调用应当出现新的一行。
// 不是给生产用的，验证完可以直接删。
import fs from 'node:fs'
import path from 'node:path'

const log = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), '_test-mcp.log')
fs.appendFileSync(log, `${new Date().toISOString()} start pid=${process.pid}\n`)

const TOOL = {
  name: 'echo',
  description: '原样返回 text 参数',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (line) handle(JSON.parse(line))
  }
})

function handle(msg) {
  if (msg.method === undefined) return
  if (msg.id === undefined) return // 通知不回包
  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'idle-probe', version: '0.0.0' },
        },
      })
      break
    case 'tools/list':
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [TOOL] } })
      break
    case 'tools/call':
      fs.appendFileSync(log, `${new Date().toISOString()} call ${msg.params?.name}\n`)
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: `echo: ${msg.params?.arguments?.text ?? ''}` }],
        },
      })
      break
    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unsupported: ${msg.method}` } })
  }
}
