// TDD 守门员测试(task#5): HoldGate 接进「所有剩余转发路径」—— Claude 非流式 / OpenAI chat 流式+非流式 /
// OpenAI responses 流式+非流式 / Gemini 流式+非流式。
//
// 方案「🔴 重大修正」节: 真机验证暴露原「仅 Claude 流式」边界错了, 用户真实流量走 OpenAI 兼容/非流式,
// 完全没被挂起覆盖。本测试是这些新路径的 built-but-not-wired(E-052)守门员: 证明每条路径真调了通用挂起包装
// (runWithHold / runJsonRequestWithHold), 非死代码 —— 无号→挂起→注入号 resume→用新号完成, 无重复输出;
// 且开关关时行为与现状一致(维持 503 / 不挂起)。
//
// 触发用依赖注入(mock 上游 callKiroApi / callKiroApiStream + 预置全 quota 耗尽的池), 不新增 dev-only IPC(方案 §5 A8)。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import type { ProxyAccount } from '@main/proxy/types'

const callKiroApiStreamMock = vi.fn()
const callKiroApiMock = vi.fn()
vi.mock('@main/proxy/kiroApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/proxy/kiroApi')>()
  return {
    ...actual,
    callKiroApiStream: (...args: unknown[]) => callKiroApiStreamMock(...args),
    callKiroApi: (...args: unknown[]) => callKiroApiMock(...args)
  }
})

import { ProxyServer } from '@main/proxy/proxyServer'

function mkReq(body: object, path = ''): Readable & { headers: Record<string, string>; url?: string } {
  const r = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]) as Readable & {
    headers: Record<string, string>
    url?: string
  }
  r.headers = { 'content-type': 'application/json' }
  if (path) r.url = path
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
    write(chunk: string) { writes.push(chunk); return true },
    end(chunk?: string) { if (chunk) writes.push(chunk); res.writableEnded = true; return res },
    on() { return res },
    once() { return res },
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

/** 全 quota 耗尽的两个号(→ getNextAccount allExhausted 返回 null, 触发汇合点 A)。 */
function seedExhausted(server: ProxyServer) {
  const pool = server.getAccountPool()
  pool.addAccount(mkAccount('A', { quotaExhaustedAt: Date.now(), quotaUsed: 100, quotaLimit: 100 }))
  pool.addAccount(mkAccount('A2', { quotaExhaustedAt: Date.now(), quotaUsed: 100, quotaLimit: 100 }))
  return pool
}

describe('HoldGate 多路径接线(task#5 · built-but-not-wired 守门员)', () => {
  beforeEach(() => {
    callKiroApiStreamMock.mockReset()
    callKiroApiMock.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // ============ Claude /v1/messages 非流式 ============
  it('Claude 非流式 + 全 quota 耗尽 + 开关开 → 挂起 → 注入号 → 用新号完成 JSON(无重复)', async () => {
    const server = new ProxyServer({ holdWhenNoAccount: true, holdAutoResumeOnAvailable: true, enableMultiAccount: true })
    const pool = seedExhausted(server)
    callKiroApiMock.mockImplementation(async () => ({
      content: 'claude-nonstream-ok', toolUses: [], usage: { inputTokens: 5, outputTokens: 3, credits: 1 }, reasoningContent: undefined
    }))

    const req = mkReq({ model: 'claude-sonnet-4.5', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    const res = mkRes()
    const done = (server as any).handleClaudeMessages(req, res)
    await new Promise((r) => setTimeout(r, 30))

    expect(server.getHeldRequestsCount()).toBe(1)      // 进挂起, 非直接 503
    expect(res.statusCode).not.toBe(503)
    expect(callKiroApiMock).not.toHaveBeenCalled()      // 无号, 未调上游

    pool.addAccount(mkAccount('B'))                      // 注入新号 → 自动放行
    await new Promise((r) => setTimeout(r, 30))
    await done

    expect(server.getHeldRequestsCount()).toBe(0)
    expect(callKiroApiMock).toHaveBeenCalledTimes(1)     // 用新号跑完
    expect(callKiroApiMock.mock.calls[0].at(-1)).toEqual({ skipFirstChunkTimeout: true })
    expect(res.statusCode).toBe(200)
    const bodyCount = res.writes.filter((w) => w.includes('claude-nonstream-ok')).length
    expect(bodyCount).toBe(1)                            // 无重复输出
  })

  it('Claude 非流式 + 开关关(默认)→ 全挂时维持现状 503, 不挂起', async () => {
    const server = new ProxyServer({ holdWhenNoAccount: false, enableMultiAccount: true })
    seedExhausted(server)
    const req = mkReq({ model: 'claude-sonnet-4.5', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    const res = mkRes()
    await (server as any).handleClaudeMessages(req, res)

    expect(server.getHeldRequestsCount()).toBe(0)
    expect(res.statusCode).toBe(503)
    expect(callKiroApiMock).not.toHaveBeenCalled()
  })

  // ============ OpenAI /v1/chat/completions 非流式 ============
  it('OpenAI chat 非流式 + 全 quota 耗尽 + 开关开 → 挂起 → 注入号 → 用新号完成(无重复)', async () => {
    const server = new ProxyServer({ holdWhenNoAccount: true, holdAutoResumeOnAvailable: true, enableMultiAccount: true })
    const pool = seedExhausted(server)
    callKiroApiMock.mockImplementation(async () => ({
      content: 'openai-nonstream-ok', toolUses: [], usage: { inputTokens: 4, outputTokens: 2, credits: 0 }, reasoningContent: undefined
    }))

    const req = mkReq({ model: 'gpt-4o', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    const res = mkRes()
    const done = (server as any).handleOpenAIChat(req, res)
    await new Promise((r) => setTimeout(r, 30))

    expect(server.getHeldRequestsCount()).toBe(1)
    expect(res.statusCode).not.toBe(503)
    expect(callKiroApiMock).not.toHaveBeenCalled()

    pool.addAccount(mkAccount('B'))
    await new Promise((r) => setTimeout(r, 30))
    await done

    expect(server.getHeldRequestsCount()).toBe(0)
    expect(callKiroApiMock).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(200)
    expect(res.writes.filter((w) => w.includes('openai-nonstream-ok')).length).toBe(1)
  })

  it('OpenAI chat 非流式 + 开关关 → 维持现状 503, 不挂起', async () => {
    const server = new ProxyServer({ holdWhenNoAccount: false, enableMultiAccount: true })
    seedExhausted(server)
    const req = mkReq({ model: 'gpt-4o', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    const res = mkRes()
    await (server as any).handleOpenAIChat(req, res)

    expect(server.getHeldRequestsCount()).toBe(0)
    expect(res.statusCode).toBe(503)
  })

  // ============ OpenAI /v1/chat/completions 流式 ============
  it('OpenAI chat 流式 + 全 quota 耗尽 + 开关开 → 挂起(未吐 content chunk)→ 注入号 → 用新号完成(无重复)', async () => {
    const server = new ProxyServer({ holdWhenNoAccount: true, holdAutoResumeOnAvailable: true, holdPingIntervalMs: 1000, enableMultiAccount: true })
    const pool = seedExhausted(server)
    callKiroApiStreamMock.mockImplementation(
      async (_acc: unknown, _p: unknown, onChunk: (t: string) => void, onComplete: (u: unknown) => void) => {
        await onChunk('openai-stream-ok')
        onComplete({ inputTokens: 3, outputTokens: 2, credits: 0 })
      }
    )

    const req = mkReq({ model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const res = mkRes()
    const done = (server as any).handleOpenAIChat(req, res)
    await new Promise((r) => setTimeout(r, 30))

    expect(server.getHeldRequestsCount()).toBe(1)
    expect(callKiroApiStreamMock).not.toHaveBeenCalled()
    // 挂起态不得吐出 content(role:assistant 的 initial chunk 也延迟)
    expect(res.writes.some((w) => w.includes('openai-stream-ok'))).toBe(false)

    pool.addAccount(mkAccount('B'))
    await new Promise((r) => setTimeout(r, 30))
    await done

    expect(server.getHeldRequestsCount()).toBe(0)
    expect(callKiroApiStreamMock).toHaveBeenCalledTimes(1)
    expect(callKiroApiStreamMock.mock.calls[0].at(-1)).toEqual({ skipFirstChunkTimeout: true })
    expect(res.writes.filter((w) => w.includes('openai-stream-ok')).length).toBe(1)  // 无重复
    expect(res.writes.some((w) => w.includes('[DONE]'))).toBe(true)
  })
})

describe('HoldGate 多路径接线 · responses + Gemini(task#5)', () => {
  beforeEach(() => {
    callKiroApiStreamMock.mockReset()
    callKiroApiMock.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // ============ OpenAI /v1/responses 非流式 ============
  it('responses 非流式 + 全 quota 耗尽 + 开关开 → 挂起 → 注入号 → 用新号完成(无重复)', async () => {
    const server = new ProxyServer({ holdWhenNoAccount: true, holdAutoResumeOnAvailable: true, enableMultiAccount: true })
    const pool = seedExhausted(server)
    callKiroApiMock.mockImplementation(async () => ({
      content: 'responses-nonstream-ok', toolUses: [], usage: { inputTokens: 3, outputTokens: 2, credits: 0 }, reasoningContent: undefined
    }))

    const req = mkReq({ model: 'gpt-5.6-sol', stream: false, input: [{ type: 'message', role: 'user', content: 'hi' }] })
    const res = mkRes()
    const done = (server as any).handleOpenAIResponses(req, res)
    await new Promise((r) => setTimeout(r, 30))

    expect(server.getHeldRequestsCount()).toBe(1)
    expect(res.statusCode).not.toBe(503)
    expect(callKiroApiMock).not.toHaveBeenCalled()

    pool.addAccount(mkAccount('B'))
    await new Promise((r) => setTimeout(r, 30))
    await done

    expect(server.getHeldRequestsCount()).toBe(0)
    expect(callKiroApiMock).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(200)
    expect(res.writes.filter((w) => w.includes('responses-nonstream-ok')).length).toBe(1)
  })

  it('responses 非流式 + 开关关 → 维持现状 503, 不挂起', async () => {
    const server = new ProxyServer({ holdWhenNoAccount: false, enableMultiAccount: true })
    seedExhausted(server)
    const req = mkReq({ model: 'gpt-5.6-sol', stream: false, input: [{ type: 'message', role: 'user', content: 'hi' }] })
    const res = mkRes()
    await (server as any).handleOpenAIResponses(req, res)

    expect(server.getHeldRequestsCount()).toBe(0)
    expect(res.statusCode).toBe(503)
  })

  // ============ OpenAI /v1/responses 流式 ============
  it('responses 流式 + 全 quota 耗尽 + 开关开 → 挂起(未吐 response.created)→ 注入号 → 用新号完成', async () => {
    const server = new ProxyServer({ holdWhenNoAccount: true, holdAutoResumeOnAvailable: true, holdPingIntervalMs: 1000, enableMultiAccount: true })
    const pool = seedExhausted(server)
    callKiroApiMock.mockImplementation(async () => ({
      content: 'responses-stream-ok', toolUses: [], usage: { inputTokens: 3, outputTokens: 2, credits: 0 }, reasoningContent: undefined
    }))

    const req = mkReq({ model: 'gpt-5.6-sol', stream: true, input: [{ type: 'message', role: 'user', content: 'hi' }] })
    const res = mkRes()
    const done = (server as any).handleOpenAIResponses(req, res)
    await new Promise((r) => setTimeout(r, 30))

    expect(server.getHeldRequestsCount()).toBe(1)
    // 挂起态不得吐 response.created(首字节延迟到拿到结果)
    expect(res.writes.some((w) => w.includes('response.created'))).toBe(false)
    expect(callKiroApiMock).not.toHaveBeenCalled()

    pool.addAccount(mkAccount('B'))
    await new Promise((r) => setTimeout(r, 30))
    await done

    expect(server.getHeldRequestsCount()).toBe(0)
    expect(callKiroApiMock).toHaveBeenCalledTimes(1)
    // response.created 恰好一次 = 无重放重复(responses SSE 会在 delta/done/part 多个事件里带同一 text, 属协议正常, 不作为重复判据)
    expect(res.writes.filter((w) => w.includes('response.created')).length).toBe(1)
    expect(res.writes.some((w) => w.includes('response.completed'))).toBe(true)
    expect(res.writes.some((w) => w.includes('responses-stream-ok'))).toBe(true)
  })

  // ============ Gemini 非流式 ============
  it('Gemini generateContent + 全 quota 耗尽 + 开关开 → 挂起 → 注入号 → 用新号完成(无重复)', async () => {
    const server = new ProxyServer({ holdWhenNoAccount: true, holdAutoResumeOnAvailable: true, enableMultiAccount: true })
    const pool = seedExhausted(server)
    callKiroApiMock.mockImplementation(async () => ({
      content: 'gemini-nonstream-ok', toolUses: [], usage: { inputTokens: 3, outputTokens: 2, credits: 0 }, reasoningContent: undefined
    }))

    const req = mkReq({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    const res = mkRes()
    const done = (server as any).handleGeminiRequest(req, res, '/v1beta/models/gemini-pro:generateContent')
    await new Promise((r) => setTimeout(r, 30))

    expect(server.getHeldRequestsCount()).toBe(1)
    expect(res.statusCode).not.toBe(503)
    expect(callKiroApiMock).not.toHaveBeenCalled()

    pool.addAccount(mkAccount('B'))
    await new Promise((r) => setTimeout(r, 30))
    await done

    expect(server.getHeldRequestsCount()).toBe(0)
    expect(callKiroApiMock).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(200)
    expect(res.writes.filter((w) => w.includes('gemini-nonstream-ok')).length).toBe(1)
  })

  it('Gemini generateContent + 开关关 → 维持现状 503, 不挂起', async () => {
    const server = new ProxyServer({ holdWhenNoAccount: false, enableMultiAccount: true })
    seedExhausted(server)
    const req = mkReq({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    const res = mkRes()
    await (server as any).handleGeminiRequest(req, res, '/v1beta/models/gemini-pro:generateContent')

    expect(server.getHeldRequestsCount()).toBe(0)
    expect(res.statusCode).toBe(503)
  })

  // ============ Gemini 流式 ============
  it('Gemini streamGenerateContent + 全 quota 耗尽 + 开关开 → 挂起(未吐 candidates)→ 注入号 → 用新号完成', async () => {
    const server = new ProxyServer({ holdWhenNoAccount: true, holdAutoResumeOnAvailable: true, holdPingIntervalMs: 1000, enableMultiAccount: true })
    const pool = seedExhausted(server)
    callKiroApiStreamMock.mockImplementation(
      async (_acc: unknown, _p: unknown, onChunk: (t: string) => void, onComplete: (u: unknown) => void) => {
        await onChunk('gemini-stream-ok')
        onComplete({ inputTokens: 3, outputTokens: 2, credits: 0 })
      }
    )

    const req = mkReq({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    const res = mkRes()
    const done = (server as any).handleGeminiRequest(req, res, '/v1beta/models/gemini-pro:streamGenerateContent')
    await new Promise((r) => setTimeout(r, 30))

    expect(server.getHeldRequestsCount()).toBe(1)
    expect(res.writes.some((w) => w.includes('gemini-stream-ok'))).toBe(false)
    expect(callKiroApiStreamMock).not.toHaveBeenCalled()

    pool.addAccount(mkAccount('B'))
    await new Promise((r) => setTimeout(r, 30))
    await done

    expect(server.getHeldRequestsCount()).toBe(0)
    expect(callKiroApiStreamMock).toHaveBeenCalledTimes(1)
    expect(callKiroApiStreamMock.mock.calls[0].at(-1)).toEqual({ skipFirstChunkTimeout: true })
    expect(res.writes.filter((w) => w.includes('gemini-stream-ok')).length).toBe(1)
  })
})
