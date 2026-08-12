// hold-gate probe server —— 复刻 HoldGate 挂起态的线上行为，用真实 Claude Code 客户端测掐断点
// 行为：writeHead 200 + text/event-stream，然后只发 ping 心跳，永不发 message_start,永不结束。
// 与 proxyServer.ts:4027/4074 的挂起态逐字一致。
//
// 用法: node hold-probe.js [pingIntervalMs] [pingMode]
//   pingMode: event (默认, 同 Claude 端点 4074) | comment (同 OpenAI/Gemini 端点 3328) | none (对照组:完全静默)
const http = require('http')

const PING_MS = parseInt(process.argv[2] || '10000', 10)
const PING_MODE = process.argv[3] || 'event'
const t0 = Date.now()
const el = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(7)

const log = (...a) => console.log(`[${el()}s]`, ...a)

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let parsed = {}
    try { parsed = JSON.parse(body || '{}') } catch { /* ignore */ }
    log(`>>> ${req.method} ${req.url} · stream=${parsed.stream} · model=${parsed.model} · bodyBytes=${body.length}`)
    log(`    headers: ${JSON.stringify({
      'user-agent': req.headers['user-agent'],
      'x-app': req.headers['x-app'],
      'anthropic-version': req.headers['anthropic-version'],
      'anthropic-beta': (req.headers['anthropic-beta'] || '').slice(0, 80)
    })}`)

    // === 复刻挂起态:先建 SSE 连接,不发 message_start ===
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    log(`<<< writeHead 200 text/event-stream · 进入挂起态 · pingMode=${PING_MODE} · interval=${PING_MS}ms`)

    let n = 0
    const timer = PING_MODE === 'none' ? null : setInterval(() => {
      if (res.writableEnded || res.destroyed) return
      n++
      if (PING_MODE === 'event') res.write('event: ping\ndata: {"type":"ping"}\n\n')
      else res.write(': ping\n\n')
      log(`    ping #${n} sent (${PING_MODE})`)
    }, PING_MS)

    const done = (why) => {
      if (timer) clearInterval(timer)
      log(`!!! 连接终止 · 原因=${why} · 存活=${el()}s · 已发ping=${n}`)
      log(`!!! ===== 掐断点 = ${((Date.now() - t0) / 1000).toFixed(1)}s =====`)
    }
    req.on('aborted', () => done('req aborted (客户端主动断开)'))
    res.on('close', () => done('res close'))
    req.socket.on('error', (e) => log(`    socket error: ${e.code || e.message}`))
  })
})

server.listen(8788, '127.0.0.1', () => {
  log('probe server listening on http://127.0.0.1:8788')
  log(`config: pingMode=${PING_MODE} pingInterval=${PING_MS}ms`)
})
