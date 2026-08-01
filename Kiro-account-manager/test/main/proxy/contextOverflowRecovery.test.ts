// 回归测试:上下文溢出的响应式恢复(参考 Kiro IDE ContextOverflowHandler)
//
// 背景 RCA:.agent-workspace/.archive/2026-07-26/proxy-400-model-and-content-length/
// 关键设计:Kiro IDE 官方是**响应式**恢复(catch ContextWindowExceededError 后本地裁剪),
// 不预测阈值。反代照此实现:收到 CONTENT_LENGTH_EXCEEDS_THRESHOLD → 按递进比例裁掉最旧
// history → 重试同一端点(换端点无用,三端点共用同一后端限制)。
//
// 本文件锁两件事:
//   1. 溢出后确实发生裁剪并重试,而不是直接把 400 抛给客户端(否则 /compact 死锁无解)
//   2. **恢复次数有限,绝不无限循环** —— 实现用 `endpointIdx--` 重试同端点,
//      若恢复计数器失效会死循环打爆上游,这是必须锁住的风险

import { describe, it, expect, vi, afterEach } from 'vitest'

// 必须同时拦住两条出站路径:有代理时走 undici.fetch,无代理时走 global fetch。
// 只 stub global fetch 会导致测试打到**真实 Kiro 上游**(实测收到真 403 AccessDenied,
// 消耗真实额度)。这里 mock undici 的 fetch,并让 systemProxy 不返回 agent。
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

import { callKiroApiStream, setModelContextWindow } from '@main/proxy/kiroApi'
import type { KiroPayload, KiroHistoryMessage } from '@main/proxy/types'

const OVERFLOW_BODY = JSON.stringify({
  __type: 'com.amazon.kiro.runtimeservice#ValidationException',
  message: 'Input content length exceeds threshold.',
  reason: 'CONTENT_LENGTH_EXCEEDS_THRESHOLD'
})

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

function makePayload(pairs: number, chars: number): KiroPayload {
  const history: KiroHistoryMessage[] = []
  for (let i = 0; i < pairs; i++) {
    history.push({ userInputMessage: { content: `u${i}-${'x'.repeat(chars)}`, modelId: 'claude-opus-5', origin: 'AI_EDITOR' } })
    history.push({ assistantResponseMessage: { content: `a${i}-${'y'.repeat(chars)}` } })
  }
  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: 'conv-1',
      currentMessage: {
        userInputMessage: { content: 'go', modelId: 'claude-opus-5', origin: 'AI_EDITOR' }
      },
      history
    }
  } as unknown as KiroPayload
}

afterEach(() => {
  vi.unstubAllGlobals()
  undiciFetchMock.mockReset()
})

/** 同时喂两条出站路径(undici / global),返回计数器 */
function stubOverflow(guardAt = 60): { get calls(): number } {
  let calls = 0
  const impl = async (): Promise<Response> => {
    calls++
    if (calls > guardAt) throw new Error(`INFINITE_LOOP_GUARD: fetch called >${guardAt} times`)
    return new Response(OVERFLOW_BODY, { status: 400 })
  }
  undiciFetchMock.mockImplementation(impl)
  vi.stubGlobal('fetch', vi.fn(impl))
  return { get calls() { return calls } }
}

describe('上下文溢出响应式恢复', () => {
  it('持续溢出时必须有限次退出,绝不无限循环打爆上游', async () => {
    setModelContextWindow('claude-opus-5', 1000000)
    const counter = stubOverflow(60)

    const payload = makePayload(200, 3000)
    const onError = vi.fn()
    await callKiroApiStream(makeAccount(), payload, () => {}, () => {}, onError)

    // 必须以 onError 收场(把错误交还客户端),且调用次数有界
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0][0]?.message)).toContain('CONTENT_LENGTH_EXCEEDS_THRESHOLD')
    expect(counter.calls).toBeGreaterThan(1)   // 至少重试过 → 证明不是"直接抛给客户端"
    expect(counter.calls).toBeLessThanOrEqual(12) // 3 端点 × (1 + 3 次恢复) 的宽松上界
  })

  it('溢出后必须真的裁掉最旧 history(否则重试毫无意义)', async () => {
    setModelContextWindow('claude-opus-5', 1000000)
    stubOverflow()

    const payload = makePayload(200, 3000)
    const before = payload.conversationState.history!.length
    await callKiroApiStream(makeAccount(), payload, () => {}, () => {}, () => {})

    // 裁剪作用于外层 payload,调用结束后应显著变小
    expect(payload.conversationState.history!.length).toBeLessThan(before)
  })

  it('裁剪过程不得留下 orphan toolResult(会被上游判 400 Improperly formed request)', async () => {
    setModelContextWindow('claude-opus-5', 1000000)
    stubOverflow()

    const history: KiroHistoryMessage[] = []
    for (let i = 0; i < 60; i++) {
      history.push({ userInputMessage: { content: `q${i}-${'x'.repeat(3000)}`, modelId: 'claude-opus-5', origin: 'AI_EDITOR' } })
      history.push({ assistantResponseMessage: { content: '', toolUses: [{ toolUseId: `t${i}`, name: 'read', input: {} }] } })
      history.push({
        userInputMessage: {
          content: '', modelId: 'claude-opus-5', origin: 'AI_EDITOR',
          userInputMessageContext: { toolResults: [{ toolUseId: `t${i}`, status: 'success', content: [{ text: 'z'.repeat(3000) }] }] }
        }
      })
      history.push({ assistantResponseMessage: { content: `done${i}` } })
    }
    const payload = makePayload(0, 0)
    payload.conversationState.history = history

    await callKiroApiStream(makeAccount(), payload, () => {}, () => {}, () => {})

    const kept = payload.conversationState.history ?? []
    const useIds = new Set<string>()
    for (const m of kept) for (const u of m.assistantResponseMessage?.toolUses ?? []) useIds.add(u.toolUseId)
    const orphans: string[] = []
    for (const m of kept) {
      for (const r of m.userInputMessage?.userInputMessageContext?.toolResults ?? []) {
        if (!useIds.has(r.toolUseId)) orphans.push(r.toolUseId)
      }
    }
    expect(orphans).toEqual([])
  })
})
