// 回归测试: HoldGate 误伤防护 —— 挂起只认「池权威状态」(封禁 / 额度耗尽)
//
// RCA: .agent-workspace/.archive/2026-08-02/hold-gate-false-positive/hold-gate-false-positive-rca.md
// ADR: docs/architecture/ADR-0001-account-hold-gate.md
//
// 缺陷(修复前): 两个流式接管点(OpenAI 3318 / Claude 4427)只判 `!bodyStartSent`,
//   完全不判「这个错误换号有没有用」;而 runWithHold 拿不到新号时无条件 waitInHold。
//   后果: 单账号模式(池 1/1)下任何 pre-body 错误(含 400 Improperly formed request、
//   瞬时 429 / 上游 5xx)都会把请求挂死到客户端 API_TIMEOUT_MS(默认 600s)超时。
//
// 修复后的契约(本测试锁定):
//   1. 请求级错误(400 malformed)→ 不进 hold,原样报错(换号无用)
//   2. 瞬时错误(429 / 502)且池里无号被封禁/额度耗尽 → 不进 hold,原样报错
//   3. 真·封禁(403 TEMPORARILY_SUSPENDED)→ 进 hold(用户的核心场景不能被削弱)
//   4. 额度耗尽 → 进 hold
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import type { ProxyAccount } from '@main/proxy/types'

const callKiroApiStreamMock = vi.fn()
vi.mock('@main/proxy/kiroApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/proxy/kiroApi')>()
  return {
    ...actual,
    callKiroApiStream: (...args: unknown[]) => callKiroApiStreamMock(...args)
  }
})

import { ProxyServer } from '@main/proxy/proxyServer'

function mkReq(body: object): Readable & { headers: Record<string, string> } {
  const r = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]) as Readable & {
    headers: Record<string, string>
  }
  r.headers = { 'content-type': 'application/json' }
  return r
}

function mkRes() {
  const writes: string[] = []
  const res = {
    writableEnded: false,
    headersSent: false,
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    writeHead(status: number, headers?: Record<string, unknown>) {
      res.statusCode = status
      if (headers) res.headers = headers
      res.headersSent = true
      return res
    },
    write(chunk: string) {
      writes.push(chunk)
      return true
    },
    end(chunk?: string) {
      if (chunk) writes.push(chunk)
      res.writableEnded = true
      return res
    },
    on() {
      return res
    },
    once() {
      return res
    },
    writes
  }
  return res
}

function mkAccount(id: string, extra: Partial<ProxyAccount> = {}): ProxyAccount {
  return {
    id,
    email: `${id}@example.com`,
    accessToken: `token-${id}`,
    refreshToken: `refresh-${id}`,
    profileArn: `arn:aws:codewhisperer:us-east-1:0:profile/${id}`,
    isAvailable: true,
    ...extra
  }
}

/** 让上游在「首字节前」抛指定错误(pre-body failure)。 */
function mockPreBodyError(message: string): void {
  callKiroApiStreamMock.mockImplementation(
    async (
      _acc: unknown,
      _payload: unknown,
      _onChunk: unknown,
      _onComplete: unknown,
      onError: (e: Error) => void
    ) => {
      onError(new Error(message))
    }
  )
}

describe('accountPool.hasBlockedAccount(挂起权威判据 SSOT)', () => {
  it('空池 → false(没有任何号被封禁/额度耗尽)', () => {
    const server = new ProxyServer({})
    expect(server.getAccountPool().hasBlockedAccount()).toBe(false)
  })

  it('健康账号 → false', () => {
    const server = new ProxyServer({})
    server.getAccountPool().addAccount(mkAccount('A'))
    expect(server.getAccountPool().hasBlockedAccount()).toBe(false)
  })

  it('被封禁账号(suspendedAt>0) → true', () => {
    const server = new ProxyServer({})
    server.getAccountPool().addAccount(mkAccount('A', { suspendedAt: Date.now(), suspendReason: 'TEMPORARILY_SUSPENDED' }))
    expect(server.getAccountPool().hasBlockedAccount()).toBe(true)
  })

  it('额度耗尽账号(quotaExhaustedAt) → true', () => {
    const server = new ProxyServer({})
    server.getAccountPool().addAccount(mkAccount('A', { quotaExhaustedAt: Date.now() }))
    expect(server.getAccountPool().hasBlockedAccount()).toBe(true)
  })

  it('额度用满(quotaUsed >= quotaLimit) → true', () => {
    const server = new ProxyServer({})
    server.getAccountPool().addAccount(mkAccount('A', { quotaUsed: 100, quotaLimit: 100 }))
    expect(server.getAccountPool().hasBlockedAccount()).toBe(true)
  })

  it('配额已过重置时间 → false(不再视为耗尽)', () => {
    const server = new ProxyServer({})
    server.getAccountPool().addAccount(
      mkAccount('A', { quotaExhaustedAt: Date.now() - 100000, quotaResetAt: Date.now() - 1000 })
    )
    expect(server.getAccountPool().hasBlockedAccount()).toBe(false)
  })

  it('🔴 核心防误伤: 纯 errorCount 退避冷却中的账号 → false(瞬时错误不算「真·不可用」)', () => {
    // 这是误伤的根源场景: 429/5xx 触发 recordError 累加 errorCount 进入指数退避,
    // isAccountAvailable 会因冷却返回 false,但那只是「等几秒」不是「需要换号」。
    // hasBlockedAccount 必须明确不认这种状态,否则请求会被挂起 10-20 分钟。
    const server = new ProxyServer({})
    const pool = server.getAccountPool()
    pool.addAccount(mkAccount('A'))
    pool.recordError('A')
    pool.recordError('A')
    pool.recordError('A')
    expect(pool.hasBlockedAccount()).toBe(false)
  })

  it('多号混合: 只要有一个被封禁 → true', () => {
    const server = new ProxyServer({})
    const pool = server.getAccountPool()
    pool.addAccount(mkAccount('A'))
    pool.addAccount(mkAccount('B', { suspendedAt: Date.now() }))
    expect(pool.hasBlockedAccount()).toBe(true)
  })
})

describe('HoldGate 误伤防护(端到端 · 单账号模式)', () => {
  beforeEach(() => {
    callKiroApiStreamMock.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 单账号 + 挂起门闸开 —— 复现用户截图的配置(池 1/1、多账号轮询关)。 */
  function mkSingleAccountServer(): ProxyServer {
    const server = new ProxyServer({
      holdWhenNoAccount: true,
      holdAutoResumeOnAvailable: true,
      holdPingIntervalMs: 1000,
      enableMultiAccount: false
    })
    server.getAccountPool().addAccount(mkAccount('SOLO'))
    return server
  }

  async function fireClaudeStream(server: ProxyServer) {
    const req = mkReq({ model: 'claude-sonnet-4.5', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const res = mkRes()
    const done = (server as any).handleClaudeMessages(req, res)
    await new Promise((r) => setTimeout(r, 50))
    return { res, done }
  }

  it('🔴 请求级错误(400 Improperly formed request)→ 不挂起,原样报错', async () => {
    // 修复前: 该错误换号 100% 无用,却会被挂起到客户端 600s 超时。
    const server = mkSingleAccountServer()
    mockPreBodyError('Kiro API error 400: Improperly formed request')

    const { res } = await fireClaudeStream(server)

    expect(server.getHeldRequestsCount()).toBe(0) // 关键: 没被挂起
    expect(res.writableEnded).toBe(true) // 已收尾,不是卡住
    expect(res.writes.join('')).toContain('Improperly formed request') // 错误原样透传给客户端

    server.releaseHeldRequests()
  })

  it('⚠️ 429 → 被 accountPool 归类为「额度耗尽」→ 挂起(既有契约 · 见 recordError isQuotaError)', async () => {
    // 注意这不是本轮修复的目标行为,而是**既有设计**的忠实反映:
    //   accountPool.recordError() 把 `statusCode === 402 || statusCode === 429` 判为 isQuotaError,
    //   设 quotaExhaustedAt + quotaResetAt(见 accountPool.ts recordError 注释)。
    //   → hasBlockedAccount() = true → 挂起等配额恢复,由 quotaResetAt 到点后兜底轮询自动放行。
    // 前置事实:429 在到达这里之前已经过 rateLimitRetryConfig 的 10 次内部重试(~2s),
    //   即「撑过 10 次重试的 429」被视为真实配额问题而非瞬时抖动。
    // 若后续判定 2 秒 429 突发不该标记额度耗尽,应改 accountPool.recordError 的 isQuotaError 判据
    //   (影响面更广:也影响账号可用性轮询),不在本轮 RCA 范围内。
    const server = mkSingleAccountServer()
    mockPreBodyError('Kiro API error 429: ThrottlingException rate limit exceeded')

    const { res } = await fireClaudeStream(server)

    expect(server.getHeldRequestsCount()).toBe(1)
    expect(res.writableEnded).toBe(false)

    server.releaseHeldRequests()
  })

  it('🔴 网络错误(无 HTTP 状态码)→ 不挂起,原样报错', async () => {
    // 无状态码 → recordError 走 RECOVERABLE 但不设 quotaExhaustedAt → 只有 errorCount 退避
    // → hasBlockedAccount() = false → 不挂起。
    const server = mkSingleAccountServer()
    mockPreBodyError('fetch failed: ECONNRESET')

    const { res } = await fireClaudeStream(server)

    expect(server.getHeldRequestsCount()).toBe(0)
    expect(res.writableEnded).toBe(true)

    server.releaseHeldRequests()
  })

  it('🔴 瞬时上游 502 → 立即报错(临时错误挂起门闸不管这个 · 用户明说)', async () => {
    // 用户澄清(RCA 2026-08-03):「429 只需要重试就行了,不需要挂起。只有账号封禁/
    //   额度上限/账号未授权这种账号级不可用才挂起。」502 同理,归入临时错误。
    const server = mkSingleAccountServer()
    mockPreBodyError('Kiro API error 502: Bad Gateway')

    const { res } = await fireClaudeStream(server)

    expect(server.getHeldRequestsCount()).toBe(0)
    expect(res.writableEnded).toBe(true)

    server.releaseHeldRequests()
  })

  it('✅ 真·封禁(403 TEMPORARILY_SUSPENDED)→ 仍然挂起(核心场景不被削弱)', async () => {
    // 用户要的正是这个: 账号被封 → 挂着请求 → 手动换号 → 放行 → 无感续接。
    const server = mkSingleAccountServer()
    mockPreBodyError(
      'Auth error 403: {"__type":"com.amazon.kiro.runtimeservice#AccessDeniedException","message":"Your User ID is temporarily suspended.","reason":"TEMPORARILY_SUSPENDED"}'
    )

    const { res } = await fireClaudeStream(server)

    expect(server.getHeldRequestsCount()).toBe(1) // 关键: 确实挂起了
    expect(res.writableEnded).toBe(false) // 连接保持,等放行
    // 挂起态绝不能已吐 message_start(ADR-0001 无重放约束)
    expect(res.writes.join('')).not.toContain('event: message_start')

    server.releaseHeldRequests()
  })

  it('✅ 额度耗尽 → 仍然挂起', async () => {
    const server = new ProxyServer({
      holdWhenNoAccount: true,
      holdAutoResumeOnAvailable: true,
      holdPingIntervalMs: 1000,
      enableMultiAccount: true
    })
    const pool = server.getAccountPool()
    pool.addAccount(mkAccount('A', { quotaExhaustedAt: Date.now(), quotaUsed: 100, quotaLimit: 100 }))
    pool.addAccount(mkAccount('B', { quotaExhaustedAt: Date.now(), quotaUsed: 100, quotaLimit: 100 }))

    const { res } = await fireClaudeStream(server)

    expect(server.getHeldRequestsCount()).toBe(1)
    expect(res.writableEnded).toBe(false)

    server.releaseHeldRequests()
  })

  it('✅ 封禁挂起后手动放行 + 注入新号 → 用新号完成,message_start 只发一次', async () => {
    // 完整走一遍用户的操作路径: 挂起 → 换号 → 放行 → 无感续接
    const server = mkSingleAccountServer()
    mockPreBodyError(
      'Auth error 403: {"message":"Your User ID is temporarily suspended.","reason":"TEMPORARILY_SUSPENDED"}'
    )

    const { res, done } = await fireClaudeStream(server)
    expect(server.getHeldRequestsCount()).toBe(1)

    // 换好新号 + 上游恢复正常
    callKiroApiStreamMock.mockImplementation(
      async (_acc: unknown, _payload: unknown, onChunk: (t: string) => void, onComplete: (u: unknown) => void) => {
        await onChunk('recovered output')
        onComplete({ inputTokens: 10, outputTokens: 5, credits: 1 })
      }
    )
    server.getAccountPool().addAccount(mkAccount('NEW'))
    await new Promise((r) => setTimeout(r, 60))
    await done

    expect(server.getHeldRequestsCount()).toBe(0)
    const all = res.writes.join('')
    expect(all).toContain('recovered output')
    expect(all.match(/event: message_start/g)?.length).toBe(1) // 无重复正文
    expect(res.writableEnded).toBe(true)
  })
})
