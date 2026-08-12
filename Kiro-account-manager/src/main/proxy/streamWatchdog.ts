// Layer C · SSE 上游静默看门狗(stall watchdog)
//
// ## 治的病灶
// 上游 Kiro SSE 流在响应中途静默:TCP 连接还活着、也没 EOF 也没错误,字节就是不来了。
// 反代 parseEventStream 的 `reader.read()` 于是永久 pending —— 既不 onComplete 也不
// onError,客户端(Claude Code / Codex)死等。实测最长挂了 1h50m 才被人手工掐断。
// 本模块给上游原始字节流套一层计时:超时内掐断上游 fetch 并把可识别错误交给下游
// reader 抛出,让客户端能失败重试,而不是无限期挂着。
//
// ## 为什么按「上游原始字节」计时,而不是按 SSE 输出计时
// 生产教训(9router `open-sse/utils/streamHandler.js` pipeWithDisconnect 注释所载):
// 推理模型(Kiro 上的 Claude thinking)会长时间**零 SSE 输出**,同时 EventStream 分片
// 一直在到 —— 按 transform 后的输出计时会误判掐断正常的慢思考请求,并在下游产生
// "failed to pipe response"。所以计时点必须钉在原始上游 chunk 上。这也是本文件唯一
// 不可动的语义。
//
// ## 计时窗口 = 「正在等上游字节」,而不是「pull 之后」
// 计时器只在 awaitingUpstream 为真时武装。该状态是**显式**的,不从「pull 被调用过」
// 推断 —— 合法武装点只有两个,解除点只有一个:
//   · start():拿到响应头、开始等 body。此刻队列里必然空无一物,不存在可被误计的
//     背压时间,所以首字节窗口从这里起算是安全的。
//   · pull() 里发出 `r.read()` 之前:此刻确有一次 read 在飞。
//   · read 一落地(chunk / EOF / 报错)立刻解除。之后 chunk 躺在队列里等下游来读的
//     那段时间是**下游背压**,不是上游静默,绝不能计入。
// 旧写法在 enqueue 之后也武装了一次,于是「下游还没来读」被算成「上游不出字」——
// 一个已经拿到健康字节的响应被 40ms 背压掐死,下游只收到 error(回归用例 C8 / C9
// 钉住这一形态)。fireStall 里另有一道 awaitingUpstream 护栏:即使将来有人误在别处
// 武装计时器,也判不出静默。
//
// 附带边界(有意不管):下游既不读也不 cancel 地放弃流时,本模块不武装任何计时器 ——
// 那不是上游静默(客户端已经不在等我们了),不属 Layer C 职责。
//
// ## 为什么收 onStallAbort 回调而不是 AbortController
// 已核实(kiroApi.ts:1907 `callKiroApiStream`):该函数内部**没有** AbortController,
// 它的 `signal?: AbortSignal` 是调用方注入的**客户端取消**通道 —— 看门狗绝不能对它
// 调 `.abort()`(那等于伪造"客户端主动取消",会污染上游语义与统计)。留成回调,由接线
// 方传入一个 linked controller 的 abort。
//
// ## fail-open
// 看门狗自身内部异常一律降级为纯透传:少一道静默保护 < 弄坏一个本来能跑通的请求。

/** 上游静默的结构化错误。code 稳定,供上层按错误码识别与重试判定。 */
export class StallError extends Error {
  readonly code = 'upstream_stream_stall'
  readonly reason: 'first_chunk' | 'inter_chunk'
  readonly chunks: number
  readonly bytes: number
  readonly sinceLastMs: number

  constructor(
    reason: 'first_chunk' | 'inter_chunk',
    chunks: number,
    bytes: number,
    sinceLastMs: number
  ) {
    // message 必须自解释并带数字:部分调用方会把 err.message 直接透给用户看,
    // 不会去读 code/reason 字段。
    super(
      `upstream_stream_stall: no data for ${formatSeconds(sinceLastMs)} ` +
        `after ${chunks} chunk${chunks === 1 ? '' : 's'} (${formatBytes(bytes)}) ` +
        `[${reason}] — upstream aborted`
    )
    this.name = 'StallError'
    this.reason = reason
    this.chunks = chunks
    this.bytes = bytes
    this.sinceLastMs = sinceLastMs
  }
}

/** 正整数 env 覆盖,非法/缺失回落默认(与 9router runtimeConfig envMs 同口径)。 */
function envMs(name: string, def: number): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return def
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : def
}

/**
 * 首字节超时(prompt prefill / TTFT)。默认 200s。
 * env:KIRO_STREAM_FIRST_CHUNK_TIMEOUT_MS
 */
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs('KIRO_STREAM_FIRST_CHUNK_TIMEOUT_MS', 200_000)

/**
 * 出字后的 chunk 间静默超时。默认 360s —— 留足余量,慢推理模型不该被掐。
 * env:KIRO_STREAM_STALL_TIMEOUT_MS
 */
export const STREAM_STALL_TIMEOUT_MS = envMs('KIRO_STREAM_STALL_TIMEOUT_MS', 360_000)

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

function formatSeconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`
}

export interface StallDetectionOptions {
  /** HoldGate 已放行的请求不受首 chunk(TTFT)预算约束;首 chunk 后仍正常检测 inter-chunk 静默。 */
  skipFirstChunkTimeout?: boolean
  firstChunkTimeoutMs?: number
  stallTimeoutMs?: number
  /** 仅供日志观测;实现不得依赖其返回值,也不得让它改写抛出的 error。 */
  onStall?: (err: StallError) => void
}

/** 开发者禁用通道:KIRO_PROXY_LAYER_C=false → 完全直通,零计时器。 */
function isLayerCDisabled(): boolean {
  return (process.env.KIRO_PROXY_LAYER_C ?? '').trim().toLowerCase() === 'false'
}

/**
 * 给上游 SSE 原始字节流套静默看门狗。
 *
 * 语义:
 *  1. 按**原始上游 chunk** 记 lastChunkAt / chunkCount / totalBytes(不看 SSE 解析结果)。
 *  2. 首字节计时器:从本函数被调用起,到第一个 chunk 到达为止;超时 → reason='first_chunk'。
 *  3. 首字节之后:每次**向上游发出 read** 时武装静默计时器,read 一落地即解除;
 *     read 在飞期间超过 stallTimeoutMs → reason='inter_chunk'。
 *  4. 判定静默时本模块一次做完全部处置:建 StallError → onStall?.() → onStallAbort() →
 *     controller.error(err)(下游 reader 由此抛出该 error)→ 清所有计时器。只做一次。
 *  5. 正常 EOF / 下游 cancel / 上游报错 → 清所有计时器,绝不再触发静默。
 *  6. fail-open:看门狗自身内部异常 → 告警并降级为纯透传。
 *
 * 计时器只在**真正有一次 read 在飞**期间武装 —— chunk 已到手、躺在队列里等下游消费的
 * 那段时间(下游背压 / 反代写缓冲打满 / 客户端慢读)不计入静默,不会被误判掐断。
 *
 * @param upstreamBody 上游原始字节流(kiroApi 里即 `response.body`)
 * @param onStallAbort 判定静默后掐断上游 fetch 的动作。**不要**在这里对
 *        `callKiroApiStream` 的 `signal` 调 abort —— 那是调用方的客户端取消通道;
 *        接线方应传入一个 linked AbortController 的 abort。
 */
export function wrapStreamWithStallDetection(
  upstreamBody: ReadableStream<Uint8Array>,
  onStallAbort: () => void,
  options: StallDetectionOptions = {}
): ReadableStream<Uint8Array> {
  if (isLayerCDisabled()) return upstreamBody

  try {
    return buildWatchdogStream(upstreamBody, onStallAbort, options)
  } catch (e) {
    // fail-open 外层兜底:构建 ReadableStream 本身就失败(极少见)。
    // 此时 start() 未跑成、上游流未被锁定,可原样交出去继续跑。
    // 注意:构建成功之后的内部异常由 armWait 的就地自废分支处理 —— 那时上游流
    // 已被 getReader() 锁定,再返回它会让下游拿到 ERR_INVALID_STATE。
    console.warn(
      `[StreamWatchdog] disabled for this request (fail-open): ${e instanceof Error ? e.message : String(e)}`
    )
    return upstreamBody
  }
}

function buildWatchdogStream(
  upstreamBody: ReadableStream<Uint8Array>,
  onStallAbort: () => void,
  options: StallDetectionOptions
): ReadableStream<Uint8Array> {
  const firstChunkTimeoutMs = options.firstChunkTimeoutMs ?? STREAM_FIRST_CHUNK_TIMEOUT_MS
  const stallTimeoutMs = options.stallTimeoutMs ?? STREAM_STALL_TIMEOUT_MS

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null

  let firstChunkTimer: ReturnType<typeof setTimeout> | null = null
  let stallTimer: ReturnType<typeof setTimeout> | null = null

  let chunkCount = 0
  let totalBytes = 0
  let lastChunkAt = Date.now()
  let terminated = false
  /**
   * 「此刻确有一次 read 在飞,正在等上游字节」。
   *
   * 这是本模块判定静默的**唯一合法前提**,做成显式状态而非从 pull 时机推断:
   * 只有 armWait() 置真、disarmWait() 置假,两者严格夹住 `r.read()` 这一句。
   * chunk 已到手、躺在队列里等下游消费的时间不在窗口内 —— 那是背压,不是静默。
   */
  let awaitingUpstream = false
  /**
   * fail-open 落点:计时器机制不可用时,看门狗**就地自废**但继续泵字节。
   * 不能改为「把上游流原样返回」—— start() 里已经 getReader(),上游流已被锁定,
   * 交出去下游会拿到 ERR_INVALID_STATE(实测 C6 用例捕获)。少一道静默保护
   * < 弄坏一个本来能跑通的请求。
   */
  let watchdogDisabled = false

  /** 所有终止路径共用的清理:计时器绝不能在请求结束后残留(否则迟到的 abort 打断已完成的请求)。 */
  const clearTimers = (): void => {
    try {
      if (firstChunkTimer !== null) {
        clearTimeout(firstChunkTimer)
        firstChunkTimer = null
      }
      if (stallTimer !== null) {
        clearTimeout(stallTimer)
        stallTimer = null
      }
    } catch {
      firstChunkTimer = null
      stallTimer = null
    }
  }

  /** 静默判定的唯一出口。幂等:重复调用只生效一次。 */
  const fireStall = (reason: 'first_chunk' | 'inter_chunk'): void => {
    if (terminated) return
    // 结构护栏:没有 read 在飞就不存在「上游静默」这回事。计时器已被 disarmWait 清掉,
    // 正常不会走到这里;留着是为了让「将来有人误在别处武装计时器」也判不出静默,
    // 而不是再退化成把下游背压当静默(本轮 C8 / C9 病灶)。
    if (!awaitingUpstream) return
    terminated = true
    awaitingUpstream = false
    clearTimers()

    const err = new StallError(reason, chunkCount, totalBytes, Date.now() - lastChunkAt)

    // onStall 只是观测通道:它抛错不得影响掐断与错误上抛。
    try {
      options.onStall?.(err)
    } catch {
      /* 观测失败不影响处置 */
    }
    console.warn(`[StreamWatchdog] ${err.message}`)

    // 先掐上游 fetch,再把 error 交给下游 reader —— 顺序反了会让上游连接漏着。
    try {
      onStallAbort()
    } catch (e) {
      console.warn(
        `[StreamWatchdog] onStallAbort threw: ${e instanceof Error ? e.message : String(e)}`
      )
    }
    try {
      controller?.error(err)
    } catch {
      /* 下游可能已经关了 */
    }
    // 掐断上游后主动取消 reader,避免 pending 的 read 把 socket 吊着
    reader?.cancel(err).catch(() => undefined)
  }

  /**
   * 进入「等上游字节」窗口并武装计时器。首字节前后用不同超时与 reason。
   * 只允许在两处调用:start()(开始等 body)与 pull() 里发出 read 之前。
   */
  const armWait = (): void => {
    if (terminated || watchdogDisabled) return
    try {
      clearTimers()
      awaitingUpstream = true
      if (chunkCount === 0 && !options.skipFirstChunkTimeout) {
        firstChunkTimer = setTimeout(() => {
          firstChunkTimer = null
          fireStall('first_chunk')
        }, firstChunkTimeoutMs)
      } else if (chunkCount > 0) {
        stallTimer = setTimeout(() => {
          stallTimer = null
          fireStall('inter_chunk')
        }, stallTimeoutMs)
      }
    } catch (e) {
      // fail-open:计时器不可用 → 永久自废看门狗,但流继续正常泵到底。
      watchdogDisabled = true
      awaitingUpstream = false
      clearTimers()
      console.warn(
        `[StreamWatchdog] stall detection disabled for this request (fail-open): ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
  }

  /**
   * 离开「等上游字节」窗口:read 一落地(chunk / EOF / 报错)就必须调,
   * 好让随后的排队等待时间不计入静默。
   */
  const disarmWait = (): void => {
    awaitingUpstream = false
    clearTimers()
  }

  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      reader = upstreamBody.getReader()
      lastChunkAt = Date.now()
      // 在 start 里武装:首字节超时要从「拿到响应头、开始等 body」起算,而不是等下游
      // 来消费才起算。
      //
      // 实测补注(2026-08-09):本 wrapper 自身默认 highWaterMark=1,平台在构造后会
      // **立刻**调用本 wrapper 的 pull 去填内部队列(不需要下游 getReader),于是
      // pull 处的 armWait 也会在 ~0ms 武装。也就是说这一行在当前平台行为下是**冗余
      // 的防御**,而非首字节计时的实现机制 —— 注掉它,首字节仍能在构造后按时开火
      // (实测:注掉后 C12 依旧通过,只有 C6 因构造期不再调 setTimeout 而红)。
      // 保留它的理由:不把「计时起点」这件事托付给平台的队列填充时机(受 wrapper
      // highWaterMark、上游实现、运行时差异影响),让起点在本文件里显式可见。
      // 此刻队列必然为空、且上游 read 即将/已经在飞,故不存在可被误计的背压时间。
      armWait()
    },

    async pull(c) {
      if (terminated) return
      const r = reader
      if (!r) return

      // 窗口开:确有一次 read 即将在飞。
      armWait()

      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await r.read()
      } catch (e) {
        // 上游报错(含被 fireStall 掐断后 read 抛出)→ 出窗、清计时器,原样上抛。
        disarmWait()
        if (terminated) return // 静默已处置完毕,error 已经给过下游了
        terminated = true
        throw e
      }

      // 窗口关:字节已到手(或 EOF)。此后的排队等待属下游背压,不得计入静默。
      disarmWait()

      if (terminated) return // 等待期间已判静默,丢弃迟到结果

      if (result.done) {
        // 正常 EOF:计时器已由 disarmWait 清掉,残留的 abort 不会在请求完成后开火。
        terminated = true
        c.close()
        return
      }

      const chunk = result.value
      chunkCount++
      totalBytes += chunk.byteLength
      lastChunkAt = Date.now()
      // 这里**不**再武装计时器:下一个静默窗口由下游下一次 pull 打开。
      // 旧版在此处武装,把「chunk 躺在队列里等下游来读」算成上游静默,
      // 于是一个已经拿到健康字节的响应被背压掐死(回归用例 C8 / C9)。
      c.enqueue(chunk)
    },

    cancel(reason) {
      // 下游主动取消(客户端断开等):出窗、清计时器,不算静默。
      terminated = true
      disarmWait()
      return reader?.cancel(reason)
    }
  })
}
