// 回归测试:三端点全挂(传输层错误 / 5xx)后的整体退避重试
//
// 背景 RCA:.agent-workspace/.archive/2026-08-04/gpt-suppression-rollback-and-endpoint-retry/
// 现场(2026-08-04 16:40:17):CodeWhisperer / KiroRuntime-US / AmazonQ 在同几秒内全部
// ECONNRESET(全库 53 次端点故障有 50 次集中在 KiroRuntime-US 的一次抽风窗口),端点
// fallback 走完 → lastError 交上层 → decideHoldAction 判 giveup → 客户端直接断,零重试。
//
// 用户既定意图:网络类错误「只需要重试,绝不挂起」—— 重试 ≠ 挂起。
//
// 本文件锁三件事:
//   1. 传输层错误(ECONNRESET / TLS 断连 / fetch failed)三端点全挂后必须重走整条端点链
//   2. 重试轮数有界,绝不无限循环打爆上游
//   3. 4xx 请求类错误一律不整体重试 —— 重试 400/401 纯烧额度且永远不会成功
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'

// 同 contextOverflowRecovery.test.ts:必须拦住两条出站路径,否则会打到真实上游烧额度
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

import { callKiroApiStream, isTransientNetworkError } from '@main/proxy/kiroApi'
import type { KiroPayload } from '@main/proxy/types'

function makeAccount() {
  return {
    id: 'acc-test',
    email: 'test@example.com',
    accessToken: 'test-token',
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
      conversationId: 'conv-1',
      currentMessage: {
        userInputMessage: { content: 'go', modelId: 'claude-opus-5', origin: 'AI_EDITOR' }
      },
      history: []
    }
  } as unknown as KiroPayload
}

/** 让每次出站都抛指定错误,返回调用计数器 */
function stubThrow(makeErr: () => Error, guardAt = 40): { get calls(): number } {
  let calls = 0
  const impl = async (): Promise<Response> => {
    calls++
    if (calls > guardAt) throw new Error(`INFINITE_LOOP_GUARD: fetch called >${guardAt} times`)
    throw makeErr()
  }
  undiciFetchMock.mockImplementation(impl)
  vi.stubGlobal('fetch', vi.fn(impl))
  return { get calls() { return calls } }
}

/** 让每次出站都返回指定 HTTP 状态,返回调用计数器 */
function stubStatus(status: number, body = '{}', guardAt = 40): { get calls(): number } {
  let calls = 0
  const impl = async (): Promise<Response> => {
    calls++
    if (calls > guardAt) throw new Error(`INFINITE_LOOP_GUARD: fetch called >${guardAt} times`)
    return new Response(body, { status })
  }
  undiciFetchMock.mockImplementation(impl)
  vi.stubGlobal('fetch', vi.fn(impl))
  return { get calls() { return calls } }
}

/** undici 真实形状:message 恒为 "fetch failed",真因在 cause.code */
function makeEconnreset(): Error {
  const err = new TypeError('fetch failed') as Error & { cause?: unknown }
  err.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', errno: -4077, syscall: 'read' })
  return err
}

/** 测出「走完一轮端点链」的出站次数基线。用 4xx —— 它不触发任何重试分支。
 *  每个用例自己量一次,不走跨用例共享全局变量(否则单跑单个用例会碎)。 */
async function measureOneRound(): Promise<number> {
  const c = stubStatus(400, '{"message":"Improperly formed request"}')
  await callKiroApiStream(makeAccount(), makePayload(), () => {}, () => {}, () => {})
  const n = c.calls
  undiciFetchMock.mockReset()
  vi.unstubAllGlobals()
  return n
}

afterEach(() => {
  vi.unstubAllGlobals()
  undiciFetchMock.mockReset()
})

describe('isTransientNetworkError 判据', () => {
  it('传输层错误判为可重试(undici 的真因藏在 cause.code 里)', () => {
    expect(isTransientNetworkError(makeEconnreset())).toBe(true)
    const tls = new TypeError('fetch failed') as Error & { cause?: unknown }
    tls.cause = Object.assign(
      new Error('Client network socket disconnected before secure TLS connection was established'),
      { code: 'ECONNRESET' }
    )
    expect(isTransientNetworkError(tls)).toBe(true)
    expect(isTransientNetworkError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isTransientNetworkError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe(true)
  })

  it('上游 5xx 判为可重试,4xx 一律不可重试(重试请求类错误纯烧额度)', () => {
    expect(isTransientNetworkError(new Error('API error 500: internal'))).toBe(true)
    expect(isTransientNetworkError(new Error('API error 503: unavailable'))).toBe(true)
    expect(isTransientNetworkError(new Error('API error 400: Improperly formed request'))).toBe(false)
    expect(isTransientNetworkError(new Error('API error 404: no such model'))).toBe(false)
    expect(isTransientNetworkError(new Error('Auth error 401: expired'))).toBe(false)
    expect(isTransientNetworkError(new Error('Auth error 403: AccessDenied'))).toBe(false)
  })

  it('已有专属处置路径的错误不得被判为可重试(避免与既有恢复逻辑打架)', () => {
    // 这两类在 catch 里有各自的处置分支(本地裁剪 / 剥离 reasoningContent),
    // 若被判可重试会白白多跑两轮端点链。它们的 message 形状都是 API error 400。
    expect(isTransientNetworkError(new Error('API error 400: {"reason":"CONTENT_LENGTH_EXCEEDS_THRESHOLD"}'))).toBe(false)
    expect(isTransientNetworkError(new Error('API error 400: THINKING_SIGNATURE_INVALID'))).toBe(false)
  })

  it('空值不炸', () => {
    expect(isTransientNetworkError(null)).toBe(false)
    expect(isTransientNetworkError(undefined)).toBe(false)
  })
})

describe('三端点全挂后的整体退避重试', () => {
  beforeAll(async () => {
    // 预热:CodeWhisperer 端点首次会额外请求一次 ListAvailableModels 解析 catalog,
    // 之后走缓存。不预热的话「一轮端点链」的出站次数首次与后续不一致。
    await measureOneRound()
  }, 20000)

  it('4xx 请求类错误:走完一轮端点链就收手,不做整体重试', async () => {
    const oneRound = await measureOneRound()
    const counter = stubStatus(400, '{"message":"Improperly formed request"}')
    const onError = vi.fn()
    const t0 = Date.now()
    await callKiroApiStream(makeAccount(), makePayload(), () => {}, () => {}, onError)
    const elapsed = Date.now() - t0

    expect(onError).toHaveBeenCalledTimes(1)
    expect(counter.calls).toBe(oneRound)
    // 本质判据:没有退避。一旦误入整体重试至少多花 800ms。
    expect(elapsed).toBeLessThan(500)
  }, 20000)

  it('传输层错误全挂:必须重走整条端点链,且轮数有界', async () => {
    const oneRound = await measureOneRound()
    expect(oneRound).toBeGreaterThanOrEqual(1)

    const counter = stubThrow(makeEconnreset)
    const onError = vi.fn()
    await callKiroApiStream(makeAccount(), makePayload(), () => {}, () => {}, onError)

    // 必须以 onError 收场(错误交还客户端),不能静默吞掉
    expect(onError).toHaveBeenCalledTimes(1)
    // 严格锁重试轮数 = 初始 1 轮 + 2 次整体重试 = 3 轮
    expect(counter.calls).toBe(oneRound * 3)
  }, 20000)

  it('上游 5xx 全挂:同样重走端点链(上游服务端错误重试有意义)', async () => {
    const oneRound = await measureOneRound()
    const counter = stubStatus(503, '{"message":"unavailable"}')
    const onError = vi.fn()
    await callKiroApiStream(makeAccount(), makePayload(), () => {}, () => {}, onError)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(counter.calls).toBe(oneRound * 3)
  }, 20000)

  it('客户端已 abort 时不得继续退避重试(白等 2.8s 还烧一轮额度)', async () => {
    // 注意:不能用 stubThrow 拿 counter 再覆盖 mockImplementation —— 那会让计数器
    // 永远停在 0,断言恒真 = 假绿。计数必须就在实际生效的 impl 里。
    let calls = 0
    const ac = new AbortController()
    const impl = async (): Promise<Response> => {
      calls++
      if (calls > 40) throw new Error('INFINITE_LOOP_GUARD')
      ac.abort()
      throw makeEconnreset()
    }
    undiciFetchMock.mockImplementation(impl)
    vi.stubGlobal('fetch', vi.fn(impl))

    const onError = vi.fn()
    await callKiroApiStream(makeAccount(), makePayload(), () => {}, () => {}, onError, ac.signal)

    expect(onError).toHaveBeenCalledTimes(1)
    // abort 后必须立刻收场:不走剩余端点,也不进整体重试
    expect(calls).toBe(1)
  }, 20000)
})
