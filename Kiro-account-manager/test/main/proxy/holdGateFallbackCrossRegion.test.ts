// 回归测试: RCA 2026-08-03 hold-gate-fallback-cross-region
//
// 用户澄清后的最终契约:
//   挂起 = 只对**账号级真不可用**触发(封禁/额度耗尽/账号未授权)
//   429/5xx/400/网络错 = 立即报错让客户端自处理(kiroApi 内部已 10 次重试)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type { ProxyAccount } from '@main/proxy/types'

const callKiroApiStreamMock = vi.fn()
vi.mock('@main/proxy/kiroApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/proxy/kiroApi')>()
  return { ...actual, callKiroApiStream: (...args: unknown[]) => callKiroApiStreamMock(...args) }
})

import { ProxyServer } from '@main/proxy/proxyServer'

function mkAccount(id: string, extra: Partial<ProxyAccount> = {}): ProxyAccount {
  return { id, email: `${id}@example.com`, accessToken: `t-${id}`, refreshToken: `r-${id}`, profileArn: `arn:aws:codewhisperer:us-east-1:0:profile/${id}`, isAvailable: true, ...extra }
}
function mkReq(body: object) {
  const r = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]) as Readable & { headers: Record<string, string> }
  r.headers = { 'content-type': 'application/json' }
  return r
}
function mkRes() {
  const writes: string[] = []
  const res = {
    writableEnded: false, headersSent: false, statusCode: 0, headers: {} as Record<string, unknown>,
    writeHead(s: number, h?: Record<string, unknown>) { res.statusCode = s; if (h) res.headers = h; res.headersSent = true; return res },
    write(c: string) { writes.push(c); return true },
    end(c?: string) { if (c) writes.push(c); res.writableEnded = true; return res },
    on() { return res }, once() { return res }, writes
  }
  return res
}
function mockPreBodyError(msg: string): void {
  callKiroApiStreamMock.mockImplementation(
    async (_a: unknown, _p: unknown, _oc: unknown, _oe: unknown, onError: (e: Error) => void) => { onError(new Error(msg)) }
  )
}

describe('decideHoldAction · B · 只对账号级不可用挂起(RCA 2026-08-03 用户澄清版)', () => {
  beforeEach(() => { callKiroApiStreamMock.mockReset() })

  function mkServer(): ProxyServer {
    const s = new ProxyServer({ holdWhenNoAccount: true, holdAutoResumeOnAvailable: true, holdPingIntervalMs: 1000, enableMultiAccount: false })
    s.getAccountPool().addAccount(mkAccount('SOLO'))
    return s
  }
  async function fire(server: ProxyServer) {
    const req = mkReq({ model: 'claude-sonnet-4.5', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const res = mkRes()
    void (server as any).handleClaudeMessages(req, res)
    await new Promise(r => setTimeout(r, 50))
    return res
  }

  // ========== 挂起分支(hold)==========

  it('✅ TEMPORARILY_SUSPENDED → 挂起(账号封禁 · 核心场景 1/3)', async () => {
    const server = mkServer()
    mockPreBodyError('Auth error 403: {"message":"Your User ID is temporarily suspended.","reason":"TEMPORARILY_SUSPENDED"}')
    const res = await fire(server)
    expect(server.getHeldRequestsCount()).toBe(1)
    expect(res.writableEnded).toBe(false)
    server.releaseHeldRequests()
  })

  it('✅ 额度耗尽 → 挂起(核心场景 2/3)', async () => {
    const server = new ProxyServer({ holdWhenNoAccount: true, holdAutoResumeOnAvailable: true, holdPingIntervalMs: 1000, enableMultiAccount: true })
    const pool = server.getAccountPool()
    pool.addAccount(mkAccount('A', { quotaExhaustedAt: Date.now(), quotaUsed: 100, quotaLimit: 100 }))
    pool.addAccount(mkAccount('B', { quotaExhaustedAt: Date.now(), quotaUsed: 100, quotaLimit: 100 }))
    const res = await fire(server)
    expect(server.getHeldRequestsCount()).toBe(1)
    expect(res.writableEnded).toBe(false)
    server.releaseHeldRequests()
  })

  it('✅ InvalidTokenException(账号未授权 · 密钥真吊销)→ 挂起(核心场景 3/3)', async () => {
    const server = mkServer()
    mockPreBodyError('HTTP 401: {"__type":"InvalidTokenException","message":"The bearer token was revoked."}')
    const res = await fire(server)
    expect(server.getHeldRequestsCount()).toBe(1)
    expect(res.writableEnded).toBe(false)
    server.releaseHeldRequests()
  })

  it('✅ UnauthorizedException → 挂起', async () => {
    const server = mkServer()
    mockPreBodyError('Auth error 403: {"__type":"UnauthorizedException","message":"Not authorized"}')
    const res = await fire(server)
    expect(server.getHeldRequestsCount()).toBe(1)
    expect(res.writableEnded).toBe(false)
    server.releaseHeldRequests()
  })

  // ========== 立即报错分支(giveup)==========

  it('🔴 429 撞爆("Rate limited after N retries")→ 立即报错(用户明说:429 不挂)', async () => {
    const server = mkServer()
    mockPreBodyError('Rate limited on KiroRuntime-EU after 10 retries')
    const res = await fire(server)
    expect(server.getHeldRequestsCount()).toBe(0)
    expect(res.writableEnded).toBe(true)
    server.releaseHeldRequests()
  })

  it('🔴 上游 503 → 立即报错(临时错误 · 挂起门闸不管这个)', async () => {
    const server = mkServer()
    mockPreBodyError('Kiro API error 503: Service Unavailable')
    const res = await fire(server)
    expect(server.getHeldRequestsCount()).toBe(0)
    expect(res.writableEnded).toBe(true)
    server.releaseHeldRequests()
  })

  it('🔴 400 Improperly formed request → 立即报错(请求本身错)', async () => {
    const server = mkServer()
    mockPreBodyError('Kiro API error 400: Improperly formed request')
    const res = await fire(server)
    expect(server.getHeldRequestsCount()).toBe(0)
    expect(res.writableEnded).toBe(true)
    server.releaseHeldRequests()
  })

  it('🔴 跨区认证裸 403 "Invalid token"(非明确异常类型)→ 立即报错', async () => {
    const server = mkServer()
    mockPreBodyError('Auth error 403: {"message":"The bearer token included in the request is invalid.","reason":null}')
    const res = await fire(server)
    expect(server.getHeldRequestsCount()).toBe(0)
    expect(res.writableEnded).toBe(true)
    server.releaseHeldRequests()
  })

  it('🔴 网络错(ECONNRESET · 无 HTTP 状态)→ 立即报错', async () => {
    const server = mkServer()
    mockPreBodyError('fetch failed: ECONNRESET')
    const res = await fire(server)
    expect(server.getHeldRequestsCount()).toBe(0)
    expect(res.writableEnded).toBe(true)
    server.releaseHeldRequests()
  })

  it('✅ 池空/根本没号可 attempt(无 pre-body error)→ 挂起等换号(核心场景 4/4)', async () => {
    // RCA 2026-08-03 · 用户实测现场:
    //   UI 里指定的账号 UUID 不在当前池里(账号被删/换 UUID/池未同步),
    //   getAvailableAccount 严格拒绝随机 fallback → 返 null,
    //   runWithHold 主循环 pickAccount 返 null → 从未 attempt 过 → preBodyErrorRef.current=null
    //   之前 decideHoldAction fallback 是 giveup → 用户看到"门闸开关没用"
    //   现修:无 pre-body error = 账号问题(池空/指定号不在池)→ hold
    const server = new ProxyServer({
      holdWhenNoAccount: true,
      holdAutoResumeOnAvailable: true,
      holdPingIntervalMs: 1000,
      enableMultiAccount: false
    })
    // 池是空的 · 或指定账号不在池里 —— 都会导致 pickAccount 返 null
    // 不加任何账号,直接触发请求

    const req = mkReq({ model: 'claude-sonnet-4.5', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const res = mkRes()
    void (server as any).handleClaudeMessages(req, res)
    await new Promise(r => setTimeout(r, 50))

    expect(server.getHeldRequestsCount()).toBe(1)   // 挂起等换号(不立即报错)
    expect(res.writableEnded).toBe(false)

    server.releaseHeldRequests()
  })
})
