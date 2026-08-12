// TDD 守门员测试: HoldGate 真正接进 Claude 流式请求路径(task#3 收口)
//
// 方案: .agent-workspace/.archive/2026-07-28/hold-gate-blocking/hold-gate-blocking-design.md §4
// ADR: docs/architecture/ADR-0001-account-hold-gate.md
//
// 这是 "built-but-not-wired"(E-052)的守门员: 前面 task#1/#2/#4 把 HoldGate 类 / config /
// IPC / accountPool 通知出口全建好且单测绿, 但没有一条真实请求流经过它们。本测试证明:
// 流式请求 + 账号池全 suspended + holdWhenNoAccount=true → 请求进入 HELD(未发 message_start、
// 发了 ping)→ 注入可用账号触发 tryResume → 用新号完成、message_start 只发一次、无重复正文。
//
// 触发用依赖注入(mock 上游 callKiroApiStream + 注入预置 suspended 的池), 不新增 dev-only IPC(方案 §5 A8)。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import type { ProxyAccount } from '@main/proxy/types'

// mock 上游流式调用: 由每个用例注入具体行为
const callKiroApiStreamMock = vi.fn()
vi.mock('@main/proxy/kiroApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/proxy/kiroApi')>()
  return {
    ...actual,
    callKiroApiStream: (...args: unknown[]) => callKiroApiStreamMock(...args)
  }
})

import { ProxyServer } from '@main/proxy/proxyServer'

/** 造一个内存态 req: 携带 /v1/messages body 的可读流。 */
function mkReq(body: object): Readable & { headers: Record<string, string> } {
  const r = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]) as Readable & {
    headers: Record<string, string>
  }
  r.headers = { 'content-type': 'application/json' }
  return r
}

/** 记录所有 SSE 写入的 fake res。 */
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

/** 统计 SSE 事件类型出现次数(event: xxx 行)。 */
function countEvents(writes: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const w of writes) {
    const m = w.match(/event:\s*(\w+)/g)
    if (!m) continue
    for (const e of m) {
      const name = e.replace(/event:\s*/, '')
      counts[name] = (counts[name] || 0) + 1
    }
  }
  return counts
}

describe('HoldGate 流式接线(built-but-not-wired 守门员)', () => {
  beforeEach(() => {
    callKiroApiStreamMock.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('流式 + 池全 suspended + holdWhenNoAccount=true → 进入 HELD(未发 message_start、发了 ping)', async () => {
    const server = new ProxyServer({
      holdWhenNoAccount: true,
      holdPingIntervalMs: 1000,
      enableMultiAccount: true
    })
    // 多账号全配额耗尽 → getNextAccount 的 allExhausted 分支返回 null(真正的"无可用号"汇合点 A)。
    // 注: 全 suspended 时 getNextAccount 会返回"冷却最短"的 suspended 号(非 null), 走汇合点 B, 另有用例覆盖。
    const pool = server.getAccountPool()
    pool.addAccount(mkAccount('A', { quotaExhaustedAt: Date.now(), quotaUsed: 100, quotaLimit: 100 }))
    pool.addAccount(mkAccount('A2', { quotaExhaustedAt: Date.now(), quotaUsed: 100, quotaLimit: 100 }))

    const req = mkReq({ model: 'claude-sonnet-4.5', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const res = mkRes()

    // handleClaudeMessages 是 private, 用 as any 直调(集成测试合法访问)
    // 不 await: 挂起后 promise 不会 resolve, 我们只观察副作用
    void (server as any).handleClaudeMessages(req, res)
    // 等 body 读取 + 异步选号完成
    await new Promise((r) => setTimeout(r, 30))

    // 断言 1: 请求进入 HELD(挂起数为 1)
    expect(server.getHeldRequestsCount()).toBe(1)
    // 断言 2: 没有真实调上游(全池挂, 无号可发)
    expect(callKiroApiStreamMock).not.toHaveBeenCalled()
    // 断言 3: 没有发 503 错误(没走现状报错路径)
    expect(res.statusCode).not.toBe(503)
    // 断言 4: 绝没有发 message_start(挂起态不背负"已提交正文"包袱)
    const events = countEvents(res.writes)
    expect(events['message_start']).toBeUndefined()

    // 清理: 放行挂起请求防 timer 泄漏
    server.releaseHeldRequests()
  })

  it('HELD 中注入可用账号 → tryResume 用新号完成, message_start 只发一次, 无重复正文', async () => {
    const server = new ProxyServer({
      holdWhenNoAccount: true,
      holdAutoResumeOnAvailable: true,
      holdPingIntervalMs: 1000,
      enableMultiAccount: true
    })
    const pool = server.getAccountPool()
    pool.addAccount(mkAccount('A', { quotaExhaustedAt: Date.now(), quotaUsed: 100, quotaLimit: 100 }))
    pool.addAccount(mkAccount('A2', { quotaExhaustedAt: Date.now(), quotaUsed: 100, quotaLimit: 100 }))

    // 上游: 拿到号后正常吐一段文本再完成
    callKiroApiStreamMock.mockImplementation(
      async (_acc: unknown, _payload: unknown, onChunk: (t: string) => void, onComplete: (u: unknown) => void) => {
        await onChunk('Hello from new account')
        onComplete({ inputTokens: 10, outputTokens: 5, credits: 1 })
      }
    )

    const req = mkReq({ model: 'claude-sonnet-4.5', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const res = mkRes()
    const done = (server as any).handleClaudeMessages(req, res)
    await new Promise((r) => setTimeout(r, 30))

    // 确认已挂起
    expect(server.getHeldRequestsCount()).toBe(1)

    // 注入一个可用账号(模拟"后台换好新号") → 触发 availability 通知 → tryResume
    pool.addAccount(mkAccount('B'))
    // 等 resume 后的完整流式转发完成
    await new Promise((r) => setTimeout(r, 30))
    await done

    // 断言 1: 挂起已清空
    expect(server.getHeldRequestsCount()).toBe(0)
    // 断言 2: 真的用新号调了上游
    expect(callKiroApiStreamMock).toHaveBeenCalledTimes(1)
    const usedAccount = callKiroApiStreamMock.mock.calls[0][0] as ProxyAccount
    expect(usedAccount.id).toBe('B')
    // 断言 3: message_start 恰好发一次(不重复)
    const events = countEvents(res.writes)
    expect(events['message_start']).toBe(1)
    // 断言 4: 正文只出现一次(无重放重复输出)
    const bodyOccurrences = res.writes.filter((w) => w.includes('Hello from new account')).length
    expect(bodyOccurrences).toBe(1)
    // 断言 5: 正常收尾
    expect(events['message_stop']).toBe(1)
    expect(res.writableEnded).toBe(true)
  })

  it('单账号首字节前 403 suspended + holdWhenNoAccount=true → 挂起(未发 message_start), 注入新号后无缝续接', async () => {
    const server = new ProxyServer({
      holdWhenNoAccount: true,
      holdAutoResumeOnAvailable: true,
      holdPingIntervalMs: 1000,
      enableMultiAccount: true
    })
    const pool = server.getAccountPool()
    // 单个"看起来可用"的账号 → getNextAccount 返回它(单账号绕过可用性), 但上游首字节前返回 403 suspended
    pool.addAccount(mkAccount('A'))

    callKiroApiStreamMock.mockImplementation(
      async (acc: ProxyAccount, _payload: unknown, onChunk: (t: string) => void, onComplete: (u: unknown) => void, onError: (e: Error) => void) => {
        if (acc.id === 'A') {
          // 首字节前失败(未调 onChunk 就 onError)
          onError(new Error('API error 403: {"reason":"TEMPORARILY_SUSPENDED"}'))
          return
        }
        await onChunk('recovered on new account')
        onComplete({ inputTokens: 3, outputTokens: 2, credits: 0 })
      }
    )

    const req = mkReq({ model: 'claude-sonnet-4.5', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const res = mkRes()
    const done = (server as any).handleClaudeMessages(req, res)
    await new Promise((r) => setTimeout(r, 30))

    // A 首字节前失败 → 无号可切 → 挂起(不发 SSE error, 不发 message_start)
    expect(server.getHeldRequestsCount()).toBe(1)
    const initialAttempt = callKiroApiStreamMock.mock.calls.find((c) => (c[0] as ProxyAccount).id === 'A')
    expect(initialAttempt?.at(-1)).not.toEqual({ skipFirstChunkTimeout: true })
    let events = countEvents(res.writes)
    expect(events['message_start']).toBeUndefined()
    expect(events['error']).toBeUndefined()

    // 注入新号 B → resume → 用 B 完成
    pool.addAccount(mkAccount('B'))
    await new Promise((r) => setTimeout(r, 30))
    await done

    expect(server.getHeldRequestsCount()).toBe(0)
    const bIdCalls = callKiroApiStreamMock.mock.calls.filter((c) => (c[0] as ProxyAccount).id === 'B')
    expect(bIdCalls.length).toBe(1)
    expect(bIdCalls[0].at(-1)).toEqual({ skipFirstChunkTimeout: true })
    events = countEvents(res.writes)
    expect(events['message_start']).toBe(1)
    expect(res.writes.filter((w) => w.includes('recovered on new account')).length).toBe(1)
    expect(events['message_stop']).toBe(1)
  })

  it('holdWhenNoAccount=false(默认关)→ 池全挂时维持现状发 503, 不挂起', async () => {
    const server = new ProxyServer({
      holdWhenNoAccount: false,
      enableMultiAccount: true
    })
    const pool = server.getAccountPool()
    pool.addAccount(mkAccount('A', { quotaExhaustedAt: Date.now(), quotaUsed: 100, quotaLimit: 100 }))
    pool.addAccount(mkAccount('A2', { quotaExhaustedAt: Date.now(), quotaUsed: 100, quotaLimit: 100 }))

    const req = mkReq({ model: 'claude-sonnet-4.5', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const res = mkRes()
    await (server as any).handleClaudeMessages(req, res)

    // 断言: 没有挂起, 走现状 503 报错
    expect(server.getHeldRequestsCount()).toBe(0)
    expect(res.statusCode).toBe(503)
    expect(callKiroApiStreamMock).not.toHaveBeenCalled()
  })

  it('HELD 中客户端断开(abort)→ 认领作废、挂起清空, 不 resume/不发 error(生命周期清理)', async () => {
    const server = new ProxyServer({
      holdWhenNoAccount: true,
      holdPingIntervalMs: 1000,
      enableMultiAccount: true
    })
    const pool = server.getAccountPool()
    pool.addAccount(mkAccount('A', { quotaExhaustedAt: Date.now(), quotaUsed: 100, quotaLimit: 100 }))
    pool.addAccount(mkAccount('A2', { quotaExhaustedAt: Date.now(), quotaUsed: 100, quotaLimit: 100 }))

    const ac = new AbortController()
    const req = mkReq({ model: 'claude-sonnet-4.5', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const res = mkRes()
    const done = (server as any).handleClaudeMessages(req, res, ac.signal)
    await new Promise((r) => setTimeout(r, 30))

    expect(server.getHeldRequestsCount()).toBe(1)

    // 客户端断开
    ac.abort()
    await new Promise((r) => setTimeout(r, 20))
    await done.catch(() => {}) // handleClaudeMessages 可能因 abort reject, 吞掉不影响断言

    // 挂起清空, 且没有 resume(未调上游)、没发 SSE error
    expect(server.getHeldRequestsCount()).toBe(0)
    expect(callKiroApiStreamMock).not.toHaveBeenCalled()
    const events = countEvents(res.writes)
    expect(events['error']).toBeUndefined()
    expect(events['message_start']).toBeUndefined()
  })
})
