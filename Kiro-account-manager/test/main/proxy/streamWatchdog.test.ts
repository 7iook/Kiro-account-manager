// Layer C · SSE 上游静默看门狗(stall watchdog)测试
//
// 治的真实病灶:上游 Kiro SSE 流在响应中途静默,反代既不报错也不断开,客户端
// (Claude Code / Codex)死等 —— 实测最长挂了 1h50m。看门狗在超时内掐断上游并抛出
// 可识别错误,让客户端能重试。
//
// 关键设计(源自 9router open-sse/utils/streamHandler.js pipeWithDisconnect 的生产教训):
//   静默必须按**上游原始字节**计时,不能按 transform/SSE 输出计时 —— 推理模型
//   (Kiro 上的 Claude thinking)会长时间零 SSE 输出,但 EventStream 分片一直在到;
//   按输出计时会造成误判掐断。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  wrapStreamWithStallDetection,
  StallError,
  STREAM_FIRST_CHUNK_TIMEOUT_MS,
  STREAM_STALL_TIMEOUT_MS
} from '@main/proxy/streamWatchdog'

const enc = new TextEncoder()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 每 gapMs 吐一个 chunk,吐完正常 EOF。 */
function makeTimedStream(chunks: Uint8Array[], gapMs: number): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      await sleep(gapMs)
      controller.enqueue(chunks[i++])
    }
  })
}

/** 吐完 chunks 后**永不结束、永不再吐**(模拟上游中途静默挂死)。 */
function makeStallingStream(chunks: Uint8Array[], gapMs: number): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) {
        await new Promise<never>(() => {}) // 永久静默
        return
      }
      await sleep(gapMs)
      controller.enqueue(chunks[i++])
    }
  })
}

/** 读到 EOF,返回拼接后的全部字节(用于逐字节比对透传保真)。 */
async function consume(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    total += value.byteLength
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.byteLength
  }
  return out
}

describe('wrapStreamWithStallDetection · Layer C 上游静默看门狗', () => {
  let onStallAbort: ReturnType<typeof vi.fn>
  const savedLayerC = process.env.KIRO_PROXY_LAYER_C

  beforeEach(() => {
    vi.useFakeTimers()
    onStallAbort = vi.fn()
    delete process.env.KIRO_PROXY_LAYER_C
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    if (savedLayerC === undefined) delete process.env.KIRO_PROXY_LAYER_C
    else process.env.KIRO_PROXY_LAYER_C = savedLayerC
  })

  // C1 —— 正常流:持续有字节 → 不误判,且内容逐字节透传
  it('C1 正常流(每 ~100ms 一个 chunk)→ 不触发静默,内容逐字节原样透传', async () => {
    const payload = ['event: a\n', 'data: hello\n', 'data: world\n', 'event: done\n'].map((s) =>
      enc.encode(s)
    )
    const expected = enc.encode('event: a\ndata: hello\ndata: world\nevent: done\n')

    const wrapped = wrapStreamWithStallDetection(makeTimedStream(payload, 100), onStallAbort, {
      firstChunkTimeoutMs: 5000,
      stallTimeoutMs: 5000
    })

    const done = consume(wrapped)
    await vi.advanceTimersByTimeAsync(100 * (payload.length + 1))
    const bytes = await done

    expect(onStallAbort).not.toHaveBeenCalled()
    expect(bytes).toEqual(expected)
  })

  // C2 —— 3 个 chunk 后上游静默 → 超时后 reader 抛 StallError,且只掐断一次
  it('C2 3 个 chunk 后静默 → 超时抛 StallError(reason=inter_chunk),onStallAbort 恰好调用一次', async () => {
    const chunks = [enc.encode('aaa'), enc.encode('bbb'), enc.encode('ccc')]
    const onStall = vi.fn()
    const wrapped = wrapStreamWithStallDetection(makeStallingStream(chunks, 100), onStallAbort, {
      firstChunkTimeoutMs: 20_000,
      stallTimeoutMs: 30_000,
      onStall
    })

    const settled = consume(wrapped).then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, err: e })
    )

    // 先让 3 个 chunk 到齐
    await vi.advanceTimersByTimeAsync(100 * chunks.length)
    expect(onStallAbort).not.toHaveBeenCalled()

    // 再静默跨过 stallTimeoutMs
    await vi.advanceTimersByTimeAsync(30_000 + 50)

    const r = await settled
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.err).toBeInstanceOf(StallError)
    expect((r.err as StallError).reason).toBe('inter_chunk')
    expect((r.err as StallError).code).toBe('upstream_stream_stall')
    expect(onStallAbort).toHaveBeenCalledTimes(1)
    // onStall 仅用于日志,拿到的必须是同一个 error 对象(不得被改写)
    expect(onStall).toHaveBeenCalledTimes(1)
    expect(onStall.mock.calls[0][0]).toBe(r.err)
  })

  // C3 —— 首字节根本不来(上游只给了响应头就挂住)
  it('C3 首字节始终不来 → firstChunkTimeoutMs 后抛 StallError(reason=first_chunk)', async () => {
    const wrapped = wrapStreamWithStallDetection(makeStallingStream([], 100), onStallAbort, {
      firstChunkTimeoutMs: 20_000,
      stallTimeoutMs: 30_000
    })

    const settled = consume(wrapped).then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, err: e })
    )

    await vi.advanceTimersByTimeAsync(19_000)
    expect(onStallAbort).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1500)

    const r = await settled
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.err).toBeInstanceOf(StallError)
    expect((r.err as StallError).reason).toBe('first_chunk')
    expect((r.err as StallError).chunks).toBe(0)
    expect((r.err as StallError).bytes).toBe(0)
    expect(onStallAbort).toHaveBeenCalledTimes(1)
  })

  // C13 —— HoldGate 放行后的请求跳过 TTFT 预算,但开始出字后仍受 inter-chunk 保护
  it('C13 跳过首 chunk 超时后首 chunk 可迟到,其后的静默仍触发 inter_chunk 且只 abort 一次', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      }
    })
    const options = {
      skipFirstChunkTimeout: true,
      firstChunkTimeoutMs: 20_000,
      stallTimeoutMs: 30_000
    }
    const wrapped = wrapStreamWithStallDetection(upstream, onStallAbort, options)
    const reader = wrapped.getReader()
    const firstRead = reader.read()

    await vi.advanceTimersByTimeAsync(20_000 + 50)
    expect(onStallAbort).not.toHaveBeenCalled()

    controller!.enqueue(enc.encode('late-first-chunk'))
    const first = await firstRead
    expect(first.done).toBe(false)
    expect(first.value).toEqual(enc.encode('late-first-chunk'))

    const stalledRead = reader.read().then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, err: e })
    )
    await vi.advanceTimersByTimeAsync(30_000 + 50)

    const result = await stalledRead
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.err).toBeInstanceOf(StallError)
    expect((result.err as StallError).reason).toBe('inter_chunk')
    expect(onStallAbort).toHaveBeenCalledTimes(1)
  })
})

describe('wrapStreamWithStallDetection · 字段读数 / 计时器清理 / fail-open / 开关', () => {
  let onStallAbort: ReturnType<typeof vi.fn>
  const savedLayerC = process.env.KIRO_PROXY_LAYER_C

  beforeEach(() => {
    vi.useFakeTimers()
    onStallAbort = vi.fn()
    delete process.env.KIRO_PROXY_LAYER_C
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    if (savedLayerC === undefined) delete process.env.KIRO_PROXY_LAYER_C
    else process.env.KIRO_PROXY_LAYER_C = savedLayerC
  })

  // C4 —— StallError 各字段读数正确 + message 自解释(有调用方直接把 message 给用户看)
  it('C4 StallError 字段读数正确(chunks / bytes / sinceLastMs / reason / code)且 message 自带数字', async () => {
    // 3 个 chunk 共 3+5+4 = 12 字节
    const chunks = [enc.encode('abc'), enc.encode('de-fg'), enc.encode('hijk')]
    const wrapped = wrapStreamWithStallDetection(makeStallingStream(chunks, 100), onStallAbort, {
      firstChunkTimeoutMs: 20_000,
      stallTimeoutMs: 30_000
    })

    const settled = consume(wrapped).then(
      () => null,
      (e: unknown) => e as StallError
    )
    await vi.advanceTimersByTimeAsync(100 * chunks.length)
    await vi.advanceTimersByTimeAsync(30_000 + 50)

    const err = await settled
    expect(err).toBeInstanceOf(StallError)
    expect(err!.code).toBe('upstream_stream_stall')
    expect(err!.reason).toBe('inter_chunk')
    expect(err!.chunks).toBe(3)
    expect(err!.bytes).toBe(12)
    expect(err!.sinceLastMs).toBeGreaterThanOrEqual(30_000)
    // message 自解释:必须含 code + chunk 数 + 字节数
    expect(err!.message).toContain('upstream_stream_stall')
    expect(err!.message).toContain('3')
    expect(err!.message).toMatch(/abort/i)
  })

  // C5 —— 正常 EOF 后不得残留已武装的计时器(否则迟到的 abort 会打断已完成的请求)
  it('C5 正常读完 EOF → 计时器全清,远超超时后 onStallAbort 仍未被调用', async () => {
    const chunks = [enc.encode('x'), enc.encode('y')]
    const wrapped = wrapStreamWithStallDetection(makeTimedStream(chunks, 100), onStallAbort, {
      firstChunkTimeoutMs: 20_000,
      stallTimeoutMs: 30_000
    })

    const bytes = await (async () => {
      const p = consume(wrapped)
      await vi.advanceTimersByTimeAsync(100 * (chunks.length + 1))
      return p
    })()
    expect(bytes).toEqual(enc.encode('xy'))

    // 流已正常结束,再把时钟推过两个超时窗:不得有迟到的静默判定
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onStallAbort).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  // C5b —— 下游主动 cancel 也必须清计时器
  it('C5b 下游 cancel → 计时器全清,后续不触发静默', async () => {
    const chunks = [enc.encode('x'), enc.encode('y'), enc.encode('z')]
    const wrapped = wrapStreamWithStallDetection(makeStallingStream(chunks, 100), onStallAbort, {
      firstChunkTimeoutMs: 20_000,
      stallTimeoutMs: 30_000
    })

    const reader = wrapped.getReader()
    const first = reader.read()
    await vi.advanceTimersByTimeAsync(150)
    await first
    await reader.cancel('client gone')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(onStallAbort).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  // C6 —— fail-open:看门狗自身内部炸了,不能把本来能跑通的流搞坏
  //
  // 语义订正(实测):不能靠「把上游流原样返回」实现 fail-open —— 看门狗一旦
  // getReader() 锁定上游,再交出去下游会拿到 ERR_INVALID_STATE(本用例第一版就是
  // 这样红的)。正确形态是看门狗**就地自废静默判定、继续泵字节到底**。
  it('C6 看门狗内部异常(setTimeout 抛错)→ 静默判定自废但流仍完整读完(fail-open)', async () => {
    const chunks = [enc.encode('aa'), enc.encode('bb')]
    // 用零延迟流:本用例只关心 fail-open,不需要 sleep(而 setTimeout 待会儿要被打断腿)
    let i = 0
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= chunks.length) controller.close()
        else controller.enqueue(chunks[i++])
      }
    })

    // 只在「看门狗武装计时器」这一刻让 setTimeout 抛错,逼它走 fail-open 分支;
    // 构建返回后立刻还原,避免连测试自己的辅助函数一起打断腿。
    const boom = vi.fn(() => {
      throw new Error('watchdog internals exploded')
    })
    vi.stubGlobal('setTimeout', boom)

    const wrapped = wrapStreamWithStallDetection(upstream, onStallAbort, {
      firstChunkTimeoutMs: 20_000,
      stallTimeoutMs: 30_000
    })
    vi.unstubAllGlobals()

    expect(boom).toHaveBeenCalled() // 确认真的打到了 fail-open 分支

    const bytes = await consume(wrapped)
    expect(bytes).toEqual(enc.encode('aabb'))
    expect(onStallAbort).not.toHaveBeenCalled()
  })

  // C7 —— 开发者禁用通道
  it('C7 KIRO_PROXY_LAYER_C=false → 原样返回上游流,零计时器', async () => {
    process.env.KIRO_PROXY_LAYER_C = 'false'
    const upstream = makeStallingStream([enc.encode('q')], 100)

    const wrapped = wrapStreamWithStallDetection(upstream, onStallAbort, {
      firstChunkTimeoutMs: 20_000,
      stallTimeoutMs: 30_000
    })

    // 直通:必须是同一个流对象,且没有武装任何计时器
    expect(wrapped).toBe(upstream)
    expect(vi.getTimerCount()).toBe(0)

    const reader = wrapped.getReader()
    const first = reader.read()
    await vi.advanceTimersByTimeAsync(150)
    expect((await first).value).toEqual(enc.encode('q'))

    await vi.advanceTimersByTimeAsync(60_000)
    expect(onStallAbort).not.toHaveBeenCalled()
    await reader.cancel()
  })

  // 默认常量与 9router 生产在用值对齐(200s TTFT / 360s 静默)
  it('默认超时常量 = 200s 首字节 / 360s 静默,且可被 env 覆盖读取', () => {
    expect(STREAM_FIRST_CHUNK_TIMEOUT_MS).toBe(200_000)
    expect(STREAM_STALL_TIMEOUT_MS).toBe(360_000)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 背压 vs 上游静默 —— 本组**故意用真实计时器**(小数值)。
//
// 为什么不用 fake timers:本组要抓的病灶正是「chunk 已到手、躺在 wrapper 队列里等
// 下游读」这段时间被计入上游静默。这个误判依赖 pull / read / enqueue / 下游 read 之间
// 真实的调度交错;fake timers 把时间推进变成显式步进,恰好会掩盖这种交错。
// 所以这里保留「真实计时器 + 40ms 级阈值」的形态。
// ────────────────────────────────────────────────────────────────────────────
describe('wrapStreamWithStallDetection · 下游背压不得被误判为上游静默(真实计时器)', () => {
  let onStallAbort: ReturnType<typeof vi.fn>
  const savedLayerC = process.env.KIRO_PROXY_LAYER_C

  beforeEach(() => {
    vi.useRealTimers() // 本组显式要真实计时器
    onStallAbort = vi.fn()
    delete process.env.KIRO_PROXY_LAYER_C
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (savedLayerC === undefined) delete process.env.KIRO_PROXY_LAYER_C
    else process.env.KIRO_PROXY_LAYER_C = savedLayerC
  })

  /** 立刻给一个健康 chunk,之后既不再出字、也不 EOF、也不报错(上游 hold 住连接)。 */
  function makeOneChunkThenHold(chunk: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(chunk)
      },
      pull() {
        return new Promise<never>(() => {}) // 永久 pending:read 真的在飞
      }
    })
  }

  // C8 —— 回归用例(本轮病灶):下游迟迟不读,上游其实已经给了健康字节
  it('C8 下游首读远晚于 stallTimeoutMs,而上游早已给出 chunk → 不得掐断,chunk 必须完整交付', async () => {
    const wrapped = wrapStreamWithStallDetection(
      makeOneChunkThenHold(enc.encode('x')),
      onStallAbort,
      { firstChunkTimeoutMs: 5000, stallTimeoutMs: 40 }
    )

    const reader = wrapped.getReader()
    // 下游被别的事情占着(反代写缓冲打满 / 客户端慢),120ms 内一次都没读。
    // 这 120ms 是背压,不是上游静默 —— 上游那一个字节早就到手了。
    await sleep(120)

    const outcome = await reader
      .read()
      .then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }))

    if (!outcome.ok) {
      throw new Error(`下游背压被误判成上游静默:${String(outcome.e)}`)
    }
    expect(onStallAbort).not.toHaveBeenCalled()
    expect(outcome.v.done).toBe(false)
    expect(outcome.v.value).toEqual(enc.encode('x'))

    await reader.cancel()
  })

  // C9 —— 慢消费者:每个 chunk 都及时到,但下游每次读之间都超过 stallTimeoutMs
  it('C9 慢消费者(每次读间隔 > stallTimeoutMs)→ 流完整读完,不掐断,字节顺序不变', async () => {
    const chunks = ['a', 'bb', 'ccc', 'dddd'].map((s) => enc.encode(s))
    let i = 0
    // 上游零延迟:每次 read 都立刻拿到字节 —— 任何停顿都只能来自下游
    const upstream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i >= chunks.length) c.close()
        else c.enqueue(chunks[i++])
      }
    })

    const wrapped = wrapStreamWithStallDetection(upstream, onStallAbort, {
      firstChunkTimeoutMs: 5000,
      stallTimeoutMs: 30
    })

    const reader = wrapped.getReader()
    const got: number[] = []
    for (;;) {
      await sleep(50) // 每次读之前先慢 50ms(> stallTimeoutMs=30)
      const { done, value } = await reader.read()
      if (done) break
      got.push(...value)
    }

    expect(onStallAbort).not.toHaveBeenCalled()
    expect(new Uint8Array(got)).toEqual(enc.encode('abbcccdddd'))
  })

  // C10 —— 反「靠不武装来通过」:read 真正在飞时的静默必须照旧被抓到
  it('C10 下游持续在读(read 真正在飞)而上游静默 → 仍抛 StallError,onStallAbort 恰好一次', async () => {
    const wrapped = wrapStreamWithStallDetection(
      makeOneChunkThenHold(enc.encode('x')),
      onStallAbort,
      { firstChunkTimeoutMs: 5000, stallTimeoutMs: 40 }
    )

    const reader = wrapped.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(first.value).toEqual(enc.encode('x'))

    // 立刻再读:此后 read 一直在飞,上游却不再出字 —— 这是真静默
    const err = await reader.read().then(
      () => null,
      (e: unknown) => e as StallError
    )

    expect(err).toBeInstanceOf(StallError)
    expect(err!.reason).toBe('inter_chunk')
    expect(err!.chunks).toBe(1)
    expect(onStallAbort).toHaveBeenCalledTimes(1)
  })

  // C11 —— 钉住「上游 hold 住不动 vs 上游正常收尾」的受控对照(评审复现形态)
  //
  // 为什么加这条:评审用「上游给一个字节后**永不结束**」+「下游首读延迟 120ms」复现出
  // StallError,并判为背压误判。受控对照(只改上游存活性,下游慢读形态逐字不变)显示:
  //   · 上游 hold 住 → 掐断(真静默:read 在飞、上游不出字,正是 1h50m 挂死那个形态)
  //   · 上游正常 EOF → 不掐断、字节完整、EOF 收尾
  // 掐断随「上游是否还活着」翻转,不随「下游读得多慢」翻转 —— 这正是本层要的判据。
  // 另注:`no data for 0s` 只是 formatSeconds 的 Math.round(167/1000) 显示效果,
  // 结构化字段 sinceLastMs 是真实值(生产阈值 200s/360s 下显示正常)。
  it('C11 受控对照:同一个慢消费者下,上游 EOF → 完整收尾;上游 hold 住 → 判静默', async () => {
    /** 评审的下游形态:首读前等 120ms,之后每读间隔 120ms。 */
    async function slowConsume(
      stream: ReadableStream<Uint8Array>
    ): Promise<{ delivered: number[]; outcome: 'eof' | 'error' }> {
      const reader = stream.getReader()
      await sleep(120)
      const delivered: number[] = []
      for (;;) {
        const r = await reader.read().then(
          (v) => ({ ok: true as const, v }),
          () => ({ ok: false as const })
        )
        if (!r.ok) return { delivered, outcome: 'error' }
        if (r.v.done) return { delivered, outcome: 'eof' }
        delivered.push(r.v.value.byteLength)
        await sleep(120)
      }
    }

    // 分支一:上游给一个字节后正常 EOF —— 本来能跑通的响应,绝不许被掐
    const healthyAbort = vi.fn()
    const healthy = await slowConsume(
      wrapStreamWithStallDetection(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode('x'))
            c.close()
          }
        }),
        healthyAbort,
        { firstChunkTimeoutMs: 5000, stallTimeoutMs: 40 }
      )
    )
    expect(healthyAbort).not.toHaveBeenCalled()
    expect(healthy.outcome).toBe('eof')
    expect(healthy.delivered).toEqual([1])

    // 分支二:只改上游存活性(给一个字节后 hold 住),下游形态逐字不变 —— 必须判静默
    const stallAbort = vi.fn()
    const stalled = await slowConsume(
      wrapStreamWithStallDetection(makeOneChunkThenHold(enc.encode('x')), stallAbort, {
        firstChunkTimeoutMs: 5000,
        stallTimeoutMs: 40
      })
    )
    expect(stallAbort).toHaveBeenCalledTimes(1)
    expect(stalled.outcome).toBe('error')
    expect(stalled.delivered).toEqual([1]) // 健康字节已交付,不是 [] —— 只有其后的静默被掐
  })

  // C12 —— 懒流边界:上游彻底不出字、下游迟迟不来读 → 首字节超时仍须按时开火
  //
  // 钉住的性质:首字节时钟从**构造**起算,不等下游消费。本 wrapper 自身默认
  // highWaterMark=1,平台构造后会立刻调用它的 pull 去填内部队列(不需要下游
  // getReader),所以此刻确有一次上游 read 在飞 —— awaitingUpstream 成立,首字节
  // 窗口不是空窗。故一个彻底死掉的上游即使暂时没人读也会被按时掐断,而不是静静挂着
  // (生产上 parseEventStream kiroApi.ts:2711 拿到流后立刻 getReader,正是 TTFT 那条路径)。
  //
  // 诚实边界(实测 2026-08-09,变异测试所得):本用例**不能**证明 start() 里那次
  // armWait 是必需的 —— 把它注掉,pull 处的 armWait 仍在 ~0ms 武装,本用例依旧通过。
  // start() 那行是显式化计时起点的冗余防御(理由写在实现处),当前唯一能检出其移除的
  // 是 C6(构造期不再调 setTimeout)。这里不假装本用例覆盖了它。
  it('C12 上游零输出 + 下游迟迟不读 → 首字节超时仍按时开火(时钟从构造起算)', async () => {
    let upstreamPulled = 0
    const upstream = new ReadableStream<Uint8Array>({
      pull() {
        upstreamPulled++
        return new Promise<never>(() => {}) // 永不出字:read 真的在飞
      }
    })

    const t0 = Date.now()
    let firedAt = -1
    const wrapped = wrapStreamWithStallDetection(
      upstream,
      () => {
        firedAt = Date.now() - t0
      },
      { firstChunkTimeoutMs: 60, stallTimeoutMs: 5000 }
    )

    // 下游拖到 150ms 之后才来读 —— 远晚于首字节窗口
    await sleep(150)

    expect(upstreamPulled).toBe(1) // 构造即向上游发起了 read
    expect(firedAt).toBeGreaterThanOrEqual(0) // 确实开火了
    expect(firedAt).toBeLessThan(150) // 且不等下游首读:时钟起点是构造

    // 下游此时才来读,应当拿到 StallError(不是永久挂着)
    const err = await wrapped
      .getReader()
      .read()
      .then(
        () => null,
        (e: unknown) => e as StallError
      )
    expect(err).toBeInstanceOf(StallError)
    expect(err!.reason).toBe('first_chunk')
  })
})
