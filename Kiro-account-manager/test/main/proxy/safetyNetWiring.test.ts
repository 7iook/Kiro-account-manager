// Layer B/C 接线守卫 —— 锁住「模块已存在且单测绿」之外的另一半:真的接进了生产路径,
// 且接线本身没有把既有恢复语义弄坏。
//
// 这些用例治的是本轮接线里最容易静默失效的四处:
//   1. StallError 掉进 isTransientNetworkError → 静默走整链重试(重复输出 + 用户再等几分钟)
//   2. 看门狗掐断误用调用方 signal → 伪造「客户端主动取消」
//   3. RTK 压缩跑在 token 裁剪之后 → 压的是已经被丢掉的内容,白做
//   4. parseEventStream 的静默保护漏在某个调用点 → 那条路径无保护

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// callKiroApiStream 可走 global fetch 或 undici.fetch；两条都必须隔离，避免测试误打真实上游。
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

import {
  isTransientNetworkError,
  buildKiroPayload,
  callKiroApiStream,
  setEnableProxyContextSafetyNet,
  getEnableProxyContextSafetyNet,
  setModelContextWindow,
  trimHistoryByTokens
} from '@main/proxy/kiroApi'
import { StallError, STREAM_FIRST_CHUNK_TIMEOUT_MS, STREAM_STALL_TIMEOUT_MS } from '@main/proxy/streamWatchdog'
import type { KiroHistoryMessage, KiroPayload, KiroToolWrapper } from '@main/proxy/types'

afterEach(() => {
  setEnableProxyContextSafetyNet(false)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  undiciFetchMock.mockReset()
  vi.restoreAllMocks()
})

function makeStreamAccount() {
  return {
    id: 'stall-wiring-test',
    email: 'stall-wiring@example.com',
    accessToken: 'test-token',
    refreshToken: 'test-refresh',
    region: 'us-east-1',
    provider: 'Google',
    authMethod: 'social',
    isAvailable: true
  } as never
}

function makeStreamPayload(): KiroPayload {
  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: 'stall-wiring-conversation',
      currentMessage: {
        userInputMessage: { content: 'go', modelId: 'claude-opus-5', origin: 'AI_EDITOR' }
      },
      history: []
    }
  } as unknown as KiroPayload
}

function stubStallingFetch(): {
  close: () => void
  enqueue: (chunk: Uint8Array) => void
  get signal(): AbortSignal | undefined
} {
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
  let fetchSignal: AbortSignal | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      bodyController = controller
    }
  })
  const impl = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    fetchSignal = init?.signal ?? undefined
    return new Response(body, { status: 200 })
  }
  undiciFetchMock.mockImplementation(impl)
  vi.stubGlobal('fetch', vi.fn(impl))
  return {
    close: () => bodyController?.close(),
    enqueue: (chunk) => bodyController?.enqueue(chunk),
    get signal() { return fetchSignal }
  }
}

describe('Layer C 接线 · 生产请求路径真的经过静默看门狗', () => {
  it('开关 ON:真实静默响应被掐断，错误交给客户端且不污染外部 signal', async () => {
    vi.useFakeTimers()
    setEnableProxyContextSafetyNet(true)
    const upstream = stubStallingFetch()
    const external = new AbortController()
    const onComplete = vi.fn()
    const onError = vi.fn()

    const request = callKiroApiStream(
      makeStreamAccount(), makeStreamPayload(), () => {}, onComplete, onError, external.signal
    )
    await vi.advanceTimersByTimeAsync(STREAM_FIRST_CHUNK_TIMEOUT_MS + 1)
    await request

    expect(onComplete).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toMatchObject({
      code: 'upstream_stream_stall',
      reason: 'first_chunk'
    })
    expect(upstream.signal?.aborted).toBe(true)
    expect(external.signal.aborted).toBe(false)
  })

  it('Hold 放行选项:跨过首 chunk 阈值不报错,首个原始 chunk 后静默仍报 inter_chunk', async () => {
    vi.useFakeTimers()
    setEnableProxyContextSafetyNet(true)
    const upstream = stubStallingFetch()
    const onError = vi.fn()

    const request = callKiroApiStream(
      makeStreamAccount(),
      makeStreamPayload(),
      () => {},
      () => {},
      onError,
      undefined,
      undefined,
      undefined,
      { skipFirstChunkTimeout: true }
    )
    await vi.advanceTimersByTimeAsync(STREAM_FIRST_CHUNK_TIMEOUT_MS + 1)
    expect(onError).not.toHaveBeenCalled()
    expect(upstream.signal?.aborted).toBe(false)

    upstream.enqueue(new Uint8Array([0]))
    await vi.advanceTimersByTimeAsync(STREAM_STALL_TIMEOUT_MS + 1)
    await request

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toMatchObject({
      code: 'upstream_stream_stall',
      reason: 'inter_chunk'
    })
    expect(upstream.signal?.aborted).toBe(true)
  })

  it('开关 OFF:跨过同一静默阈值仍纯透传，直到上游正常 EOF 才完成', async () => {
    vi.useFakeTimers()
    setEnableProxyContextSafetyNet(false)
    const upstream = stubStallingFetch()
    const onComplete = vi.fn()
    const onError = vi.fn()

    const request = callKiroApiStream(
      makeStreamAccount(), makeStreamPayload(), () => {}, onComplete, onError
    )
    await vi.advanceTimersByTimeAsync(STREAM_FIRST_CHUNK_TIMEOUT_MS + 1)

    expect(onError).not.toHaveBeenCalled()
    expect(upstream.signal).toBeUndefined()
    upstream.close()
    await request
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('开关 OFF:出站 fetch 必须收到 caller 的同一个 AbortSignal 对象', async () => {
    setEnableProxyContextSafetyNet(false)
    const upstream = stubStallingFetch()
    const caller = new AbortController()

    const request = callKiroApiStream(
      makeStreamAccount(), makeStreamPayload(), () => {}, () => {}, () => {}, caller.signal
    )
    upstream.close()
    await request

    expect(upstream.signal).toBe(caller.signal)
  })
})

const OVERFLOW_BODY = JSON.stringify({
  __type: 'com.amazon.kiro.runtimeservice#ValidationException',
  message: 'Input content length exceeds threshold.',
  reason: 'CONTENT_LENGTH_EXCEEDS_THRESHOLD'
})

function makeNonShrinkingOverflowPayload(): KiroPayload {
  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: 'overflow-non-shrinking',
      currentMessage: {
        userInputMessage: { content: 'z'.repeat(240_000), modelId: 'claude-opus-5', origin: 'AI_EDITOR' }
      },
      history: [
        { userInputMessage: { content: 'u1', modelId: 'claude-opus-5', origin: 'AI_EDITOR' } },
        { assistantResponseMessage: { content: 'a1' } },
        { userInputMessage: { content: 'u2', modelId: 'claude-opus-5', origin: 'AI_EDITOR' } },
        { assistantResponseMessage: { content: 'a2' } }
      ]
    }
  } as unknown as KiroPayload
}

describe('上下文溢出恢复 · 只有 token 真的收缩才重试', () => {
  it('占位符使 finalTokens 不降时必须 give-up，不能重发同一已知超限请求', async () => {
    const probe = makeNonShrinkingOverflowPayload()
    const beforeTokens = Math.ceil(Buffer.byteLength(JSON.stringify(probe), 'utf-8') / 3.5)
    const trimProbe = trimHistoryByTokens(probe, Math.floor(beforeTokens * 0.7))
    expect(trimProbe.trimmed).toBeGreaterThan(0)
    expect(trimProbe.finalTokens).toBeGreaterThanOrEqual(beforeTokens)

    let fetchCalls = 0
    const overflow = async (): Promise<Response> => {
      fetchCalls++
      return new Response(OVERFLOW_BODY, { status: 400 })
    }
    undiciFetchMock.mockImplementation(overflow)
    vi.stubGlobal('fetch', vi.fn(overflow))
    const onError = vi.fn()

    await callKiroApiStream(
      makeStreamAccount(), makeNonShrinkingOverflowPayload(), () => {}, () => {}, onError
    )

    expect(fetchCalls).toBe(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]?.message).toContain('CONTENT_LENGTH_EXCEEDS_THRESHOLD')
  })
})

describe('Layer C 接线 · StallError 绝不喂给端点整链重试', () => {
  // 本轮实测的真实陷阱:传输层 regex 命中 'fetch failed' / 'terminated' / UND_ERR_*,
  // 而被掐断的 fetch 恰好长这样 —— 所以「靠 message 不匹配」是侥幸,必须按 code 判定。
  it('inter_chunk 静默不算可重试瞬时故障', () => {
    expect(isTransientNetworkError(new StallError('inter_chunk', 3, 4096, 360_000))).toBe(false)
  })

  it('first_chunk 静默(一个字节都没来)同样不算可重试', () => {
    expect(isTransientNetworkError(new StallError('first_chunk', 0, 0, 200_000))).toBe(false)
  })

  it('即使 message 被改写成 undici 传输层措辞,仍按稳定 code 判定为不可重试', () => {
    // 回归守卫:StallError.message 将来若改词(或被 undici 包一层 cause),
    // 不得因此掉进重试链。判定必须锚在 code='upstream_stream_stall' 上。
    const disguised = new StallError('inter_chunk', 1, 10, 360_000)
    Object.defineProperty(disguised, 'message', { value: 'fetch failed', configurable: true })
    ;(disguised as unknown as { cause: unknown }).cause = {
      code: 'UND_ERR_SOCKET',
      message: 'other side closed'
    }
    // 对照:同样形状但没有 stall code 的错误,必须仍然判可重试(证明上面不是全都返回 false)
    const genuineTransport = Object.assign(new Error('fetch failed'), {
      cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' }
    })
    expect(isTransientNetworkError(genuineTransport)).toBe(true)
    expect(isTransientNetworkError(disguised)).toBe(false)
  })

  it('被掐断的 fetch 形态确实会命中重试判据 —— 证明上面的早退不是多余的', () => {
    // 这条用例存在的意义:如果哪天有人删掉 isTransientNetworkError 里的 stall 早退,
    // 上面三条会红。这条则证明「不早退就会掉进重试」这个前提本身是真的。
    const abortedFetch = Object.assign(new Error('fetch failed'), {
      cause: { code: 'UND_ERR_ABORTED', message: 'This operation was aborted' }
    })
    expect(isTransientNetworkError(abortedFetch)).toBe(true)
  })
})

describe('Layer C 接线 · 联动 AbortController 不污染调用方的取消通道', () => {
  // 四条契约都必须穿过 callKiroApiStream 的生产 createLinkedAbort；测试里不得复制实现。
  it('看门狗 abort 联动通道 → 出站 signal 已取消,外部 signal 仍未取消', async () => {
    vi.useFakeTimers()
    setEnableProxyContextSafetyNet(true)
    const upstream = stubStallingFetch()
    const external = new AbortController()

    const request = callKiroApiStream(
      makeStreamAccount(), makeStreamPayload(), () => {}, () => {}, () => {}, external.signal
    )
    await vi.advanceTimersByTimeAsync(STREAM_FIRST_CHUNK_TIMEOUT_MS + 1)
    await request

    expect(upstream.signal?.aborted).toBe(true)
    expect(external.signal.aborted).toBe(false)
  })

  it('外部取消 → 单向转发进联动通道(客户端断开仍能掐掉出站请求)', async () => {
    setEnableProxyContextSafetyNet(true)
    const upstream = stubStallingFetch()
    const external = new AbortController()
    const onError = vi.fn()

    const request = callKiroApiStream(
      makeStreamAccount(), makeStreamPayload(), () => {}, () => {}, onError, external.signal
    )
    external.abort(new Error('client gone'))

    expect(upstream.signal?.aborted).toBe(true)
    upstream.close()
    await request
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('外部 signal 进来时已取消 → 联动通道立刻同步,不发注定被丢弃的请求', async () => {
    setEnableProxyContextSafetyNet(true)
    const external = new AbortController()
    external.abort(new Error('already gone'))
    const fetchMock = vi.fn()
    undiciFetchMock.mockImplementation(fetchMock)
    vi.stubGlobal('fetch', fetchMock)
    const onError = vi.fn()

    await callKiroApiStream(
      makeStreamAccount(), makeStreamPayload(), () => {}, () => {}, onError, external.signal
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]?.message).toBe('already gone')
  })

  it('dispose 摘掉转发监听器 —— 重试轮数再多也不在外部 signal 上堆积', async () => {
    setEnableProxyContextSafetyNet(true)
    const external = new AbortController()
    const addSpy = vi.spyOn(external.signal, 'addEventListener')
    const removeSpy = vi.spyOn(external.signal, 'removeEventListener')
    const completedFetch = async (): Promise<Response> => new Response(
      new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
      { status: 200 }
    )
    undiciFetchMock.mockImplementation(completedFetch)
    vi.stubGlobal('fetch', vi.fn(completedFetch))

    for (let i = 0; i < 5; i++) {
      await callKiroApiStream(
        makeStreamAccount(), makeStreamPayload(), () => {}, () => {}, () => {}, external.signal
      )
    }

    // 请求链上会有多个 abort 监听器落到 external signal:createLinkedAbort 的 forwarder、
    // parseEventStream 的取消钩子等。计 total count 会被这些正常监听器污染,不是本用例
    // 要治的性质。真正要证的:createLinkedAbort 的 forwarder 是 { once: true } 注册的、
    // 且**每一次注册都有配对的 remove**(否则 5 次调用后就在 external.signal 上累加了)。
    //
    // once:true 的 forwarder 有一个身份特征:它对应的 add 调用带 `{ once: true }` options。
    // 遍历 add 中所有带 once:true 的 abort listener,断言它们**全部**出现在 remove 里
    // (身份相等,不是 toString 相等);即"注册的 forwarder 一个都没漏摘"。
    const addedForwarders = addSpy.mock.calls.filter(
      ([type, , opts]) =>
        type === 'abort' &&
        typeof opts === 'object' && opts !== null && (opts as { once?: boolean }).once === true
    )
    // 5 轮请求:安全网 ON 时每轮至少注册一次 forwarder(429/thinking 重试会重建 attempt,
    // 每次重建再多一次 add)。至少 5 次,不断言精确上限(重建路径未触发时正好 5 次)。
    expect(addedForwarders.length).toBeGreaterThanOrEqual(5)
    const removedListeners = removeSpy.mock.calls
      .filter(([type]) => type === 'abort')
      .map(([, listener]) => listener)
    for (const [, listener] of addedForwarders) {
      // 用严格身份相等(===)判定同一函数对象,而不是 toContainEqual(深比较)
      expect(removedListeners).toContain(listener)
    }
  })
})

describe('Layer B 接线 · RTK 压缩必须跑在 token 裁剪之前', () => {
  // 顺序反了的后果不是报错,而是「白做」:先裁剪就把内容丢了,再压缩等于压空气。
  // 这里用真实的 buildKiroPayload 走完整路径,断言可观察结果,而不是断言 mock 被调用过。

  /** 造一块 autodetect 会认成 git-diff、且大于 MIN_COMPRESS_SIZE(50KB) 的可压文本 */
  function makeCompressibleDiff(hunks: number): string {
    const parts = ['diff --git a/src/big.ts b/src/big.ts', '--- a/src/big.ts', '+++ b/src/big.ts']
    for (let h = 0; h < hunks; h++) {
      parts.push(`@@ -${h * 200 + 1},150 +${h * 200 + 1},150 @@ function block${h}()`)
      for (let i = 0; i < 150; i++) {
        parts.push(`+  const value${h}_${i} = compute(${i}) // padding to grow the payload substantially`)
      }
    }
    return parts.join('\n')
  }

  function historyWithBigToolResult(diff: string): KiroHistoryMessage[] {
    // toolResult 必须有配对的 toolUse:normalizeToolHistory 会把孤立 toolResult 整段剥掉
    // (防上游 400),剥掉后就没有可压的东西了 —— 这是造数据时的真实约束。
    return [
      { userInputMessage: { content: 'run the diff', modelId: 'm', origin: 'AI_EDITOR' } },
      {
        assistantResponseMessage: {
          content: 'here it is',
          toolUses: [{ toolUseId: 'tu-1', name: 'run_diff', input: { path: 'src/big.ts' } }]
        }
      },
      {
        userInputMessage: {
          content: 'tool output',
          modelId: 'm',
          origin: 'AI_EDITOR',
          userInputMessageContext: {
            toolResults: [
              { toolUseId: 'tu-1', status: 'success', content: [{ text: diff }] }
            ]
          }
        }
      },
      { assistantResponseMessage: { content: 'ack' } }
    ]
  }

  // toolUse 的名字必须在 tools 里声明,否则 normalizeToolHistory 判「未知工具」
  // → 把整段 toolUses/toolResults 摊平成 <tool_result> 内联文本,结构化 toolResults 消失,
  // RTK 就没有可压的对象了(它只压 toolResults[].content[].text)。这是真实约束,不是测试技巧。
  const TOOLS: KiroToolWrapper[] = [
    {
      toolSpecification: {
        name: 'run_diff',
        description: 'run a diff',
        inputSchema: { json: { type: 'object', properties: { path: { type: 'string' } } } }
      }
    }
  ]

  it('开关开启时:大 tool_result 被压缩并留下 [rtk-compressed:...] 标记', () => {
    setEnableProxyContextSafetyNet(true)
    const diff = makeCompressibleDiff(12)
    expect(Buffer.byteLength(diff, 'utf-8')).toBeGreaterThan(50 * 1024)

    const payload = buildKiroPayload(
      'go', 'claude-opus-5', 'AI_EDITOR', historyWithBigToolResult(diff), TOOLS
    )

    const text = JSON.stringify(payload)
    expect(text).toContain('[rtk-compressed:git-diff]')
  })

  it('压缩发生在裁剪之前:压完不超限 → 历史一条都不该被丢', () => {
    // ctx 设得刚好让「压缩后」能装下、「压缩前」装不下。
    // 若顺序反了(先裁后压),这条 history 会被丢掉 → 断言失败。
    setEnableProxyContextSafetyNet(true)
    const diff = makeCompressibleDiff(12)
    const history = historyWithBigToolResult(diff)
    const rawTokens = Math.ceil(Buffer.byteLength(JSON.stringify(history), 'utf-8') / 3.5)

    // effective limit = ctx - 20000 buffer;取 rawTokens 的一半 + buffer,
    // 使未压缩必然超限、压缩后(git-diff 压掉绝大部分正文)必然不超限
    setModelContextWindow('ordering-probe-model', Math.floor(rawTokens / 2) + 20_000)

    const payload = buildKiroPayload(
      'go', 'ordering-probe-model', 'AI_EDITOR', history, TOOLS
    )

    expect(JSON.stringify(payload)).toContain('[rtk-compressed:git-diff]')
    // 压缩已经把体积降到限内 → 不需要丢历史(裁剪会插入截断占位对,这里不该出现)
    expect(payload.conversationState.history!.length).toBe(history.length)
  })

  it('开关关闭(默认)时:payload 里不出现压缩标记 —— 默认零行为改变', () => {
    expect(getEnableProxyContextSafetyNet()).toBe(false)
    const diff = makeCompressibleDiff(12)
    const payload = buildKiroPayload(
      'go', 'claude-opus-5', 'AI_EDITOR', historyWithBigToolResult(diff), TOOLS
    )
    expect(JSON.stringify(payload)).not.toContain('[rtk-compressed:')
  })
})

describe('Layer B/C 接线 · 反空转对照与调用点覆盖', () => {
  /** 与上一组同构的可压 git diff */
  function makeCompressibleDiff(hunks: number): string {
    const parts = ['diff --git a/src/big.ts b/src/big.ts', '--- a/src/big.ts', '+++ b/src/big.ts']
    for (let h = 0; h < hunks; h++) {
      parts.push(`@@ -${h * 200 + 1},150 +${h * 200 + 1},150 @@ function block${h}()`)
      for (let i = 0; i < 150; i++) {
        parts.push(`+  const value${h}_${i} = compute(${i}) // padding to grow the payload substantially`)
      }
    }
    return parts.join('\n')
  }

  const TOOLS: KiroToolWrapper[] = [
    {
      toolSpecification: {
        name: 'run_diff',
        description: 'run a diff',
        inputSchema: { json: { type: 'object', properties: { path: { type: 'string' } } } }
      }
    }
  ]

  function historyWithBigToolResult(diff: string): KiroHistoryMessage[] {
    return [
      { userInputMessage: { content: 'run the diff', modelId: 'm', origin: 'AI_EDITOR' } },
      {
        assistantResponseMessage: {
          content: 'here it is',
          toolUses: [{ toolUseId: 'tu-1', name: 'run_diff', input: { path: 'src/big.ts' } }]
        }
      },
      {
        userInputMessage: {
          content: 'tool output',
          modelId: 'm',
          origin: 'AI_EDITOR',
          userInputMessageContext: {
            toolResults: [{ toolUseId: 'tu-1', status: 'success', content: [{ text: diff }] }]
          }
        }
      },
      { assistantResponseMessage: { content: 'ack' } }
    ]
  }

  it('对照:同样的 ctx 阈值,关掉压缩就真的会裁历史 —— 证明上一组不是空转', () => {
    // 这条是上一组「历史一条都没被丢」的反面对照。没有它,那条断言可能只是因为
    // 阈值根本没顶到(压根不会裁),而不是因为压缩救了它。
    const diff = makeCompressibleDiff(12)
    const history = historyWithBigToolResult(diff)
    const rawTokens = Math.ceil(Buffer.byteLength(JSON.stringify(history), 'utf-8') / 3.5)
    setModelContextWindow('ordering-control-model', Math.floor(rawTokens / 2) + 20_000)

    // 开关关闭 = 不压缩,同一个阈值
    setEnableProxyContextSafetyNet(false)
    const uncompressed = buildKiroPayload(
      'go', 'ordering-control-model', 'AI_EDITOR', history, TOOLS
    )
    // 未压缩必然超限 → 裁剪介入,history 结构被改动(丢消息或插入截断占位)
    const wasTrimmed =
      uncompressed.conversationState.history!.length !== history.length ||
      JSON.stringify(uncompressed).includes('truncated')
    expect(wasTrimmed).toBe(true)

    // 同一阈值下开启压缩 → 不再需要裁
    setEnableProxyContextSafetyNet(true)
    const compressed = buildKiroPayload(
      'go', 'ordering-control-model', 'AI_EDITOR', history, TOOLS
    )
    expect(JSON.stringify(compressed)).toContain('[rtk-compressed:git-diff]')
    expect(compressed.conversationState.history!.length).toBe(history.length)
  })
})

describe('接线闸门 · 生产调用点必须真实存在(反死代码)', () => {
  // 这一组不测行为,测「接线本身还在」。Layer B/C 的单测再绿,只要没有生产 caller 就是死代码
  // (本轮之前正是如此)。用源码级断言把接线钉住:将来有人重构掉调用点,这里会红。
  const kiroApiSrc = readFileSync(
    resolve(__dirname, '../../../src/main/proxy/kiroApi.ts'),
    'utf-8'
  )

  it('kiroApi.ts 真的 import 并调用了 compressToolResults', () => {
    expect(kiroApiSrc).toMatch(/import\s*\{[^}]*compressToolResults[^}]*\}\s*from\s*'\.\/rtk'/)
    expect(kiroApiSrc).toContain('compressToolResults(payload)')
  })

  it('RTK 压缩的插入点在 token 裁剪之前(源码顺序闸门)', () => {
    // 行为测试已经覆盖了效果;这条把「顺序」本身钉成结构约束,防止重构时被挪到后面。
    const rtkAt = kiroApiSrc.indexOf('compressToolResults(payload)')
    const trimAt = kiroApiSrc.indexOf('trimHistoryByTokens(payload, effectiveTokenLimit)')
    expect(rtkAt).toBeGreaterThan(-1)
    expect(trimAt).toBeGreaterThan(-1)
    expect(rtkAt).toBeLessThan(trimAt)
  })

  it('每一处 parseEventStream 调用都传了 stall abort 回调 —— 两条路径都被守住', () => {
    // 接线点选在 parseEventStream **内部**,故调用点的义务只剩「传 onStallAbort」。
    // 该参数是必填的,漏传编译不过;这条断言额外锁住「传的是 linked.abort 而不是外部 signal」。
    const callStarts = [...kiroApiSrc.matchAll(/await parseEventStream\(/g)].map((match) => match.index)
    // 今天两处:主路径 + THINKING_SIGNATURE_INVALID 重试
    expect(callStarts.length).toBe(2)
    for (const start of callStarts) {
      // 调用允许格式化成多行;只检查该调用附近的必填 abort 接线,避免单行源码正则误报。
      const callWindow = kiroApiSrc.slice(start, start + 600)
      expect(callWindow).toContain('linked.abort(')
      expect(callWindow).toContain('executionOptions')
    }
  })

  it('所有出站 fetch 统一走 attempt signal，OFF 保留 caller 身份、ON 才 linked', () => {
    const streamFn = kiroApiSrc.slice(
      kiroApiSrc.indexOf('export async function callKiroApiStream'),
      kiroApiSrc.indexOf('function extractEventType')
    )
    expect(streamFn.length).toBeGreaterThan(0)
    expect(streamFn).toMatch(/createAttemptAbort\s*=\s*\(\).*enableProxyContextSafetyNet[\s\S]*?createLinkedAbort\(signal\)[\s\S]*?\{ signal, abort:/)
    expect(streamFn).toContain('let linked = createAttemptAbort()')
    const attemptFetches = streamFn.match(/signal:\s*linked\.signal/g) ?? []
    expect(attemptFetches.length).toBeGreaterThanOrEqual(3)
  })
})
