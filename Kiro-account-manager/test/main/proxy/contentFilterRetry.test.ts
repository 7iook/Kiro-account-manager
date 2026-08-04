// 回归测试:CONTENT_FILTERED 且零输出 → 透明重试
//
// RCA: .agent-workspace/.archive/2026-08-05/content-filter-empty-retry/
//
// 现场(2026-08-05,用户看到请求日志里穿插 500):UTC 19:13-19:17 四分钟内
// CONTENT_FILTERED 爆发 16 次,**16/16 全部 `outChars=0 toolsDone=0 semanticOutput=false`**
// —— 上游一个字都没吐就返回内容过滤。同期 421 次 TOOL_USE 正常,形态是上游过滤器
// 的瞬时/概率性行为,不是「这个 prompt 内容违规」(真违规重试也会失败,代价只多一次)。
//
// 此前行为:filtered 一律 shouldFail → 非流式 `callKiroApi` reject → 上层 500;
// 用户/客户端只能重发整轮对话。
//
// 零输出使重试**完全安全**:客户端还没收到任何内容,且流式路径的 `message_start`
// 是惰性发送(要等首个语义正文,见 proxyServer ADR-0001 边界 1),所以重发不会
// 造成内容重复或 SSE 协议错乱。
//
// 本文件锁三件事:
//   1. filtered + 零输出 → 原地重试,成功后客户端只看到成功(完全透明)
//   2. filtered + **吐过正文** → 绝不重试(会让客户端看到重复输出)
//   3. 重试有界,持续 filtered 最终仍以失败收场,不无限打上游
import { describe, it, expect, vi, afterEach } from 'vitest'

const undiciFetchMock = vi.fn()
vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => undiciFetchMock(...args),
  ProxyAgent: class {},
  Agent: class {}
}))
vi.mock('@main/proxy/systemProxy', () => ({
  getSystemProxy: () => null,
  safeCreateProxyAgent: () => undefined
}))

import { callKiroApiStream } from '@main/proxy/kiroApi'
import { isUpstreamTerminalFailure, ProxyServer } from '@main/proxy/proxyServer'
import type { KiroPayload, KiroUsage } from '@main/proxy/types'

/**
 * 构造一帧 AWS Event Stream。
 *
 * 生产解析器(`parseEventStream`)**不校验 CRC**(源码注释:「prelude 无 CRC 校验」),
 * 只读长度字段并跳过 CRC 位,所以两处 CRC 填 0 即可被正常解析。
 *
 *   [4B totalLength][4B headersLength][4B preludeCRC]
 *   [headers: 1B nameLen | name | 1B valueType=7 | 2B valueLen | value]
 *   [payload JSON][4B messageCRC]
 */
function frame(eventType: string, payload: unknown): Uint8Array {
  const nameBytes = new TextEncoder().encode(':event-type')
  const typeBytes = new TextEncoder().encode(eventType)
  const headersLen = 1 + nameBytes.length + 1 + 2 + typeBytes.length
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload))
  const total = 12 + headersLen + payloadBytes.length + 4
  const buf = new Uint8Array(total)
  const dv = new DataView(buf.buffer)
  dv.setUint32(0, total, false)
  dv.setUint32(4, headersLen, false)
  dv.setUint32(8, 0, false) // prelude CRC:不校验
  let o = 12
  buf[o++] = nameBytes.length
  buf.set(nameBytes, o)
  o += nameBytes.length
  buf[o++] = 7 // value type: string
  buf[o++] = (typeBytes.length >> 8) & 0xff
  buf[o++] = typeBytes.length & 0xff
  buf.set(typeBytes, o)
  o += typeBytes.length
  buf.set(payloadBytes, o)
  dv.setUint32(total - 4, 0, false) // message CRC:不校验
  return buf
}

function streamOf(frames: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(f)
      controller.close()
    }
  })
}

function res(frames: Uint8Array[]): Response {
  return new Response(streamOf(frames), { status: 200 }) as Response
}

/** 零输出的 CONTENT_FILTERED —— 实测形态:没有任何 assistantResponseEvent */
const FILTERED_EMPTY = (): Uint8Array[] => [frame('metadataEvent', { stopReason: 'CONTENT_FILTERED' })]

/** 吐过正文之后才被过滤 —— 重试会导致内容重复,必须直接失败 */
const FILTERED_WITH_TEXT = (): Uint8Array[] => [
  frame('assistantResponseEvent', { content: '已经吐出来的内容' }),
  frame('metadataEvent', { stopReason: 'CONTENT_FILTERED' })
]

const OK_TEXT = (): Uint8Array[] => [
  frame('assistantResponseEvent', { content: '重试后的正常回答' }),
  frame('metadataEvent', { stopReason: 'END_TURN' })
]

function makeAccount() {
  return {
    id: 'acc-cf',
    email: 'cf@example.com',
    accessToken: 't',
    refreshToken: 'r',
    region: 'us-east-1',
    provider: 'Google',
    authMethod: 'social',
    isAvailable: true
  } as never
}

function makePayload(): KiroPayload {
  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: 'c1',
      currentMessage: {
        userInputMessage: { content: 'go', modelId: 'claude-opus-5', origin: 'AI_EDITOR' }
      },
      history: []
    }
  } as unknown as KiroPayload
}

/** 按顺序返回预设响应;用完后重复最后一个 */
function stubSequence(seq: (() => Uint8Array[])[]): { get calls(): number } {
  let calls = 0
  const impl = async (): Promise<Response> => {
    const pick = seq[Math.min(calls, seq.length - 1)]
    calls++
    if (calls > 30) throw new Error('INFINITE_LOOP_GUARD')
    return res(pick())
  }
  undiciFetchMock.mockImplementation(impl)
  vi.stubGlobal('fetch', vi.fn(impl))
  return { get calls() { return calls } }
}

afterEach(() => {
  vi.unstubAllGlobals()
  undiciFetchMock.mockReset()
})

describe('CONTENT_FILTERED · 零输出可透明重试', () => {
  it('零输出被过滤 → 原地重试,成功后客户端只看到成功(完全透明)', async () => {
    const counter = stubSequence([FILTERED_EMPTY, OK_TEXT])
    const chunks: string[] = []
    const onComplete = vi.fn()
    const onError = vi.fn()

    await callKiroApiStream(
      makeAccount(),
      makePayload(),
      (text) => { if (text) chunks.push(text) },
      onComplete,
      onError
    )

    // 重试发生了
    expect(counter.calls).toBe(2)
    // 客户端拿到的是成功结果,完全不知道中间失败过
    expect(onError).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledTimes(1)
    const usage = onComplete.mock.calls[0][0] as KiroUsage
    expect(usage.terminal?.disposition).toBe('complete')
    expect(usage.terminal?.shouldFail).toBe(false)
    expect(chunks.join('')).toContain('重试后的正常回答')
  }, 20000)

  it('🔴 已吐过正文才被过滤 → 绝不重试(重试会让客户端看到重复输出)', async () => {
    const counter = stubSequence([FILTERED_WITH_TEXT, OK_TEXT])
    const chunks: string[] = []
    const onComplete = vi.fn()
    const onError = vi.fn()

    await callKiroApiStream(
      makeAccount(),
      makePayload(),
      (text) => { if (text) chunks.push(text) },
      onComplete,
      onError
    )

    // 只发一次请求 —— 这是本修复最重要的边界
    expect(counter.calls).toBe(1)
    // 已吐正文 ⇒ 如实上报 filtered,让转发层按协议发 SSE error
    expect(onComplete).toHaveBeenCalledTimes(1)
    const usage = onComplete.mock.calls[0][0] as KiroUsage
    expect(usage.terminal?.disposition).toBe('filtered')
    expect(usage.terminal?.shouldFail).toBe(true)
    expect(usage.terminal?.emptyOutput).toBeFalsy()
    // 已经吐出去的内容不会被吞
    expect(chunks.join('')).toContain('已经吐出来的内容')
  }, 20000)

  it('持续零输出被过滤 → 重试有界,最终仍以 filtered 收场(不无限打上游)', async () => {
    const counter = stubSequence([FILTERED_EMPTY])
    const onComplete = vi.fn()
    const onError = vi.fn()

    await callKiroApiStream(makeAccount(), makePayload(), () => {}, onComplete, onError)

    // 有重试(>1)但有界
    expect(counter.calls).toBeGreaterThan(1)
    expect(counter.calls).toBeLessThanOrEqual(6)
    // 重试耗尽后必须如实失败,不能静默当成功
    expect(onComplete).toHaveBeenCalledTimes(1)
    const usage = onComplete.mock.calls[0][0] as KiroUsage
    expect(usage.terminal?.disposition).toBe('filtered')
    expect(usage.terminal?.shouldFail).toBe(true)
    expect(usage.terminal?.emptyOutput).toBe(true)
  }, 20000)

  it('正常响应不受影响:一次成功不触发任何重试', async () => {
    const counter = stubSequence([OK_TEXT])
    const onComplete = vi.fn()
    const onError = vi.fn()

    await callKiroApiStream(makeAccount(), makePayload(), () => {}, onComplete, onError)

    expect(counter.calls).toBe(1)
    expect(onError).not.toHaveBeenCalled()
    const usage = onComplete.mock.calls[0][0] as KiroUsage
    expect(usage.terminal?.disposition).toBe('complete')
    expect(usage.terminal?.emptyOutput).toBeFalsy()
  }, 20000)

  it('emptyOutput 由实际输出决定,不由 stopReason 推断', async () => {
    // 正常 END_TURN 但零输出 —— emptyOutput 该为 true(它是观测事实,与 disposition 无关)
    const counter = stubSequence([() => [frame('metadataEvent', { stopReason: 'END_TURN' })]])
    const onComplete = vi.fn()

    await callKiroApiStream(makeAccount(), makePayload(), () => {}, onComplete, vi.fn())

    expect(counter.calls).toBe(1) // complete 不触发重试
    const usage = onComplete.mock.calls[0][0] as KiroUsage
    expect(usage.terminal?.disposition).toBe('complete')
    expect(usage.terminal?.emptyOutput).toBe(true)
  }, 20000)
})

describe('isUpstreamTerminalFailure · 上游终止类失败的判据(B+C 的单一真源)', () => {
  // 命中这个判据的错误会被三处特殊处置:502 而非 500、不记账号错误计数、
  // 日志带 model/responseTime。判据错了三处一起错,所以它必须自己有门。
  it('命中 kiroApi 抛出的两条上游终止文案', () => {
    expect(
      isUpstreamTerminalFailure(
        'Upstream content filter truncated the response (stopReason: CONTENT_FILTERED). 输出不完整,请重试或调整措辞。'
      )
    ).toBe(true)
    expect(
      isUpstreamTerminalFailure(
        'Upstream terminated abnormally (stopReason: CANCELLED). 响应不完整,请重试。'
      )
    ).toBe(true)
  })

  it('账号级 / 请求级错误绝不命中(它们必须照常记账号错误计数并用原状态码)', () => {
    expect(isUpstreamTerminalFailure('Auth error 401: expired')).toBe(false)
    expect(isUpstreamTerminalFailure('Auth error 403: AccessDenied')).toBe(false)
    expect(isUpstreamTerminalFailure('API error 400: Improperly formed request')).toBe(false)
    expect(isUpstreamTerminalFailure('API error 429: ThrottlingException')).toBe(false)
    expect(isUpstreamTerminalFailure('API error 402: quota exhausted')).toBe(false)
    expect(isUpstreamTerminalFailure('fetch failed')).toBe(false)
    expect(isUpstreamTerminalFailure('Rate limited on KiroRuntime-EU after 10 retries')).toBe(false)
  })

  it('空值不炸', () => {
    expect(isUpstreamTerminalFailure('')).toBe(false)
    expect(isUpstreamTerminalFailure(undefined as unknown as string)).toBe(false)
  })

  it('大小写不敏感(上游文案若被改成大写仍要命中)', () => {
    expect(isUpstreamTerminalFailure('UPSTREAM CONTENT FILTER TRUNCATED the response')).toBe(true)
  })
})

describe('handleApiError · 上游终止类失败的三处处置(B+C 接线)', () => {
  /** 最小 ServerResponse 替身 —— 只需要 handleApiError 用到的那几个成员 */
  function mkRes(): {
    writableEnded: boolean
    headersSent: boolean
    statusCode: number
    writes: string[]
    writeHead: (s: number, h?: Record<string, unknown>) => unknown
    write: (c: string) => boolean
    end: (c?: string) => unknown
    on: () => unknown
    once: () => unknown
  } {
    const writes: string[] = []
    const res = {
      writableEnded: false,
      headersSent: false,
      statusCode: 0,
      writes,
      writeHead(s: number) {
        res.statusCode = s
        res.headersSent = true
        return res
      },
      write(c: string) {
        writes.push(c)
        return true
      },
      end(c?: string) {
        if (c) writes.push(c)
        res.writableEnded = true
        return res
      },
      on: () => res,
      once: () => res
    }
    return res
  }

  function mkAccount(id: string): never {
    return {
      id,
      email: `${id}@example.com`,
      accessToken: 't',
      refreshToken: 'r',
      isAvailable: true
    } as never
  }

  const FILTERED_MSG =
    'Upstream content filter truncated the response (stopReason: CONTENT_FILTERED). 输出不完整,请重试或调整措辞。'

  it('内容过滤 → 502 而非 500(500 会让人以为反代自己炸了)', () => {
    const onResponse = vi.fn()
    const server = new ProxyServer({}, { onResponse })
    server.getAccountPool().addAccount(mkAccount('A'))

    const res = mkRes()
    ;(server as unknown as {
      handleApiError: (...a: unknown[]) => void
    }).handleApiError(res, { id: 'A' }, new Error(FILTERED_MSG), '/v1/messages', 'claude-opus-5', Date.now() - 1234)

    expect(onResponse).toHaveBeenCalledTimes(1)
    expect(onResponse.mock.calls[0][0]).toMatchObject({ status: 502 })
  })

  it('内容过滤的日志必须带 model 与 responseTime(否则 UI 上只剩一行 `-`)', () => {
    const onResponse = vi.fn()
    const server = new ProxyServer({}, { onResponse })
    server.getAccountPool().addAccount(mkAccount('A'))

    const res = mkRes()
    ;(server as unknown as {
      handleApiError: (...a: unknown[]) => void
    }).handleApiError(res, { id: 'A' }, new Error(FILTERED_MSG), '/v1/messages', 'claude-opus-5', Date.now() - 1234)

    const info = onResponse.mock.calls[0][0] as { model?: string; responseTime?: number }
    expect(info.model).toBe('claude-opus-5')
    expect(typeof info.responseTime).toBe('number')
    expect(info.responseTime).toBeGreaterThan(0)
  })

  it('🔴 内容过滤不得记进账号错误计数(换号一样被拦,记了只会让正常号被打入退避)', () => {
    const server = new ProxyServer({}, {})
    const pool = server.getAccountPool()
    pool.addAccount(mkAccount('A'))
    // 必须 spy 到 recordError 本身,不能拿 errorCount 当判据 ——
    // classifyError(500)=FATAL 而 recordError 对 FATAL 直接 return 不累加,
    // 用 errorCount 断言会在「调了但被 FATAL 拦」与「根本没调」两种情况下同样绿 = 假门。
    const spy = vi.spyOn(pool, 'recordError')

    const res = mkRes()
    ;(server as unknown as {
      handleApiError: (...a: unknown[]) => void
    }).handleApiError(res, { id: 'A' }, new Error(FILTERED_MSG), '/v1/messages', 'claude-opus-5', Date.now())

    expect(spy).not.toHaveBeenCalled()
  })

  it('普通上游错误照旧记账号错误计数(不能因为修内容过滤把熔断一起关掉)', () => {
    const server = new ProxyServer({}, {})
    const pool = server.getAccountPool()
    pool.addAccount(mkAccount('A'))
    const spy = vi.spyOn(pool, 'recordError')

    const res = mkRes()
    ;(server as unknown as {
      handleApiError: (...a: unknown[]) => void
    }).handleApiError(res, { id: 'A' }, new Error('API error 429: ThrottlingException'), '/v1/messages', 'claude-opus-5', Date.now())

    expect(spy).toHaveBeenCalledTimes(1)
    // 且确实累加了计数(429 是 RECOVERABLE,不会被 FATAL 分支拦住)
    expect(pool.getAccount('A')!.errorCount ?? 0).toBeGreaterThan(0)
  })
})
