// HoldGate —— 无可用账号时冻结请求的"请求挂起门闸"(纯编排逻辑,不接线 proxyServer 主流程)
//
// 方案:.agent-workspace/.archive/2026-07-28/hold-gate-blocking/hold-gate-blocking-design.md §1/§5
//
// 设计要点(方案 Invariants):
//  2. 恢复 = 每请求一次性原子认领:releaseAll / tryResume / 超时 / abort 四入口竞争同一 CAS 状态位,
//     只有第一个认领成功者驱动状态迁移,其余 no-op。竞争优先级由"先到先得 + abort 直接作废"实现。
//  3. 单请求总时长受绝对 deadline 硬约束:deadline 从 receivedAt 起算 totalBudgetMs,多次挂起循环不重置;
//     单次挂起 timer 受 min(maxWaitMs, deadline剩余) 截断(此处仅约束 deadline 收尾,单次上限接线时使用)。
//  4. 超时收尾三态:keep_blocking(继续发 ping,不主动结束) / error(发 SSE error) / graceful_stop(提示+message_stop)。
//
// 依赖全部注入(时钟/timer、ping 回调、池可用性查询),不耦合 http / 真实定时器,保证可测。

/** 超时收尾策略(触及绝对 deadline 时)。 */
export type HoldTimeoutAction = 'keep_blocking' | 'error' | 'graceful_stop'

/**
 * 可注入的时钟抽象。生产环境用 realClock(见文件尾),测试注入 FakeClock。
 * 提供 now + setTimeout/setInterval 族,使 HoldGate 完全不触碰全局定时器。
 */
export interface HoldClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

/**
 * per-request 的副作用回调抽象。HoldGate 只调用这些回调,不直接依赖 http.ServerResponse。
 * 接线任务负责把它们实现为对真实 SSE 连接的写入。
 */
export interface HeldRequestHooks {
  /** 发一次 SSE ping 心跳(保活客户端 watchdog)。 */
  sendPing: () => void
  /** 放行:用新号重试该请求(仅在未吐正文时安全,接线方保证)。 */
  resume: () => void
  /** 超时收尾 - error:发 SSE error 事件(type=overloaded_error),客户端识别为可重试失败。 */
  sendError: () => void
  /** 超时收尾 - graceful_stop:发一句提示文本 + message_stop 干净收尾。 */
  sendGracefulStop: () => void
}

/** HoldGate 归一化后的运行配置(clamp/校验在 config SSOT 处完成,这里假定已合法)。 */
export interface HoldGateRuntimeConfig {
  pingIntervalMs: number
  maxWaitMs: number
  totalBudgetMs: number
  graceMs: number
  timeoutAction: HoldTimeoutAction
  /**
   * 自动定时放行开关(决策卡 hold-gate-auto-release · 默认 true)。
   *
   * 为什么需要它:客户端(Claude Code / SUB)的 idle watchdog 在 ~10min 处掐断静默请求,
   * ping 心跳不算语义正文挡不住它(holdConfig.ts BUDGET_MAX 注释处有实测记录)。
   * 用户实测:账号**仍处受限状态**时,在窗口到点前手动点一次「放行」,那 10min 计时被重置。
   * 本调度器 = 把该手动动作自动化。
   */
  autoReleaseEnabled: boolean
  /** 自动放行周期 ms(默认 480000=8min · clamp 收口在 holdConfig.ts)。 */
  autoReleaseIntervalMs: number
}

export interface HoldGateDeps {
  clock: HoldClock
  /** 查询账号池当前是否有可用号(SSOT 出口,tryResume 只依赖它)。 */
  isPoolAvailable: () => boolean
  config: HoldGateRuntimeConfig
  /**
   * 可观测事件出口(可选)。装配层注入,把门闸内部动作转成日志/落盘。
   *
   * ## 为什么用回调而不在这里 import logger
   * 门闸是叶子模块(不认识账号池、不认识 logger),保持零外部依赖才能被纯单测驱动。
   * 装配权归 `ProxyServer`(与 `isPoolAvailable` 同形态)。
   *
   * ## 为什么必须有它(RCA 2026-08-12)
   * 用户截图「累计放行 14 次」而同屏时间线全是「0 次 / 尚未放行过」,且 proxy-logs.json
   * 里放行事件**零条** —— 放行此前只更新内存计数,外部无从判断「放行有没有发生、有没有用」。
   * RCA 2026-08-04 已就「holdGate.ts 零日志」补过挂起侧,自动放行这条新路径又重犯。
   * 观测失败绝不影响主流程(实现里整体 try/catch,同 I1)。
   */
  onEvent?: (event: HoldGateEvent) => void
}

/** 门闸对外事件(供装配层落日志/落盘)。 */
export type HoldGateEvent =
  | {
      kind: 'hold-entered'
      at: number
      /** 挂起条目 id */
      id: number
      reason: HoldReason
      detail: string[]
      /** 本次挂起进入后集合内条目数 */
      heldCount: number
    }
  | {
      kind: 'release'
      at: number
      trigger: HoldRelease['trigger']
      /** 实际被认领并 resume 的条目数;**0 表示本周期触发了但无事可放** */
      released: number
      /** 本实例累计自动放行周期数(与界面「累计放行」同源) */
      autoReleaseCount: number
      heldCountAfter: number
    }
  | {
      kind: 'episode-ended'
      at: number
      startedAt: number
      reason: HoldReason
      /** 本轮内记录到的放行次数(与界面时间线同源) */
      releaseCount: number
      durationMs: number
    }

/** enterHold 入参。receivedAt = 请求 RECEIVED 时刻(绝对 deadline 起算点,跨多次挂起不变)。 */
export interface EnterHoldParams {
  receivedAt: number
  hooks: HeldRequestHooks
  /**
   * 本次挂起的触发原因(可观测性 · 决策卡 hold-gate-observability)。
   *
   * **由 `ProxyServer` 传入,门闸不自行推断** —— 门闸不认识账号池,分类逻辑的权威源是
   * `proxyServer.decideHoldAction` / `shouldHoldForNoAccount` / `isAccountLevelAuthFailure`。
   * (同「autoReleaseEnabled 生效值」那次的教训:门闸不知 holdWhenNoAccount,故计算层归 ProxyServer。)
   * 缺省回落 `'pool-empty'` —— 界面不显示"未知",那等于没观测。
   */
  reason?: HoldReason
  /** 原因细节,直接来自 `accountPool.describeBlockedAccounts()`;可空数组。 */
  detail?: string[]
}

/**
 * 挂起触发原因。枚举照 `proxyServer` 现有决策分类,不自造第二套口径。
 */
export type HoldReason =
  /** 池内有号被封禁 / 额度耗尽(shouldHoldForNoAccount) */
  | 'account-blocked'
  /** 最近的 pre-body 错误是账号级授权失效(isAccountLevelAuthFailure) */
  | 'account-auth-failure'
  /** 无 pre-body 错误:池空 / UI 指定号不在池 / 池未同步 */
  | 'pool-empty'

/**
 * 一次放行之后**究竟发生了什么** —— 本轮可观测性的承重字段。
 *
 * 为什么必须有它:`autoReleaseCount`(放行了几次)单独存在时,无法区分两个结果完全相反的世界:
 *   - `resumed-and-served`:放行拿到号 → 真吐语义正文 → 客户端 idle watchdog 计时**被重置** → 功能有效
 *   - `re-held`:放行仍无号 → 重新 enterHold → 全程只有 ping → 计时**未重置** → 「放行 N 次还是断了」
 * 2026-08-06 RCA §2.1 已 🟢 证实 watchdog 只认语义正文字节、ping 不重置它;而
 * hold-gate-auto-release 决策卡 §1 自标「放行为何能重置客户端计时未逐字节取证」。
 * 这个字段就是那个未取证假设的判据 —— 用户在真实使用中看一眼就能分辨,不必专门复现。
 */
export type ReleaseOutcome = 'pending' | 'resumed-and-served' | 're-held' | 'ended'

/** 一次放行动作的记录。口径 = **周期动作**,一次 releaseAll 放 N 条也只记一条。 */
export interface HoldRelease {
  /** 放行时刻(注入时钟,与 nextAutoReleaseAt 同源)。 */
  at: number
  /** 谁放的:定时自动 / 手动点按钮 / 池恢复事件 / 兜底轮询。 */
  trigger: 'auto' | 'manual' | 'pool-available' | 'poll'
  outcome: ReleaseOutcome
  /** 结局落定时刻;null = 主循环尚未回填。 */
  outcomeAt: number | null
}

/**
 * 一轮挂起(episode)= 从「集合由空变非空」到「集合再次变空」。
 *
 * 注意它是**一轮**而非**一个请求**:并发多个请求同时挂起时共享一个 episode,
 * 起始时刻与原因取第一个触发者。理由 = 2026-08-06 RCA §1.6 的教训:
 * 挂起/放行日志无请求 ID 且 releaseAll 是批量的,按请求配对时长必然算错(那次算出 4172s 假读数)。
 * 以「轮」为单位统计则不需要配对,天然免疫该仪器错误。
 */
export interface HoldEpisode {
  /** 单调递增,全实例不复用。 */
  id: number
  reason: HoldReason
  detail: string[]
  startedAt: number
  /** null = 仍在挂起中。 */
  endedAt: number | null
  releases: HoldRelease[]
}

/** 时间线读数上限(Must NOT #2:不得无限增长)。 */
const MAX_EPISODES = 20
const MAX_RELEASES_PER_EPISODE = 50

/** 被挂起请求的内部条目(含一次性认领位)。 */
interface HeldEntry {
  id: number
  receivedAt: number
  hooks: HeldRequestHooks
  /** 一次性 CAS 认领位:一旦置 true,任何入口的后续驱动都是 no-op(Invariant 2)。 */
  claimed: boolean
  pingHandle: unknown
  deadlineHandle: unknown
}

/**
 * 请求挂起门闸。持有 heldRequests 集合 + 每请求心跳 + 绝对 deadline + 一次性原子认领。
 * proxyServer 只在错误汇合点调用 enterHold / 在可用性变化时调用 tryResume / 在放行指令时调用 releaseAll,
 * 不把挂起状态散落进流式主体(SSOT)。
 */
export class HoldGate {
  private readonly clock: HoldClock
  private readonly isPoolAvailable: () => boolean
  private readonly config: HoldGateRuntimeConfig
  private readonly held: Map<number, HeldEntry> = new Map()
  private seq = 0
  // 兜底轮询句柄(方案 §5 A4):配额时间衰减恢复(quotaResetAt 到点)是纯被动、无写方法可挂
  // availabilityListener 的事件盲区。故有挂起请求期间跑一个低频轮询周期性 tryResume 兜底。
  // 轮询周期复用 maxWaitMs(单次挂起上限即"多久没被唤醒就主动复查一次池"的节奏)。
  private pollHandle: unknown = null
  // 自动定时放行句柄(决策卡 hold-gate-auto-release · D3 与兜底轮询并列不合并)。
  // 为什么是**独立的第二个 timer**、而不是在兜底轮询里加个判断:
  //   兜底轮询走 tryResume() —— 只在**池有可用号**时才放,代价是一次必然成功的转发;
  //   自动放行**刻意不看池状态** —— 放行本身就是目的(让客户端 idle watchdog 的 10min 计时重置),
  //   代价是一次很可能再次失败、随后重新 enterHold 的转发。两个语义代价差一个数量级,
  //   合并就得靠布尔参数区分,而那正是 RCA 2026-08-02 病灶原型(换号判据与挂起判据混用 →
  //   正常请求被挂 600s,proxyServer.ts 那条注释记着这个教训)。故并列两个 timer。
  private autoReleaseHandle: unknown = null
  /** 下次自动放行的绝对 epoch ms。null = **没有下一次**(关闭 / 无挂起条目);禁用 0 表达"无"(0 是合法 epoch)。 */
  private autoReleaseNextAt: number | null = null
  // 口径:一次 timer 触发 = +1,与该次实际放行了几个条目无关(0 个也计数,代表"调度器确实在跑");
  // 手动 releaseAll() 不计入(计数器只在 timer 回调里自增,不在 releaseAll 内部)。
  // 生命周期 = 一次服务会话(启动服务 → 停止服务),由 ProxyServer 在两个会话边界调
  // resetSessionState() 归零。**注意本实例不随 stop/start 重建**(门闸在 ProxyServer 构造函数里
  // 建一次),故归零必须显式做 —— 早期注释误写作"反代 stop/start 即新实例",那正是本缺陷的来源。
  private autoReleaseCount = 0
  // ===== 可观测性时间线(决策卡 hold-gate-observability)=====
  // I1 旁路:所有写入点都包 try-catch,时间线坏了不得影响放行本身。
  /** 当前进行中的一轮挂起;null = 集合为空。 */
  private currentEpisode: HoldEpisode | null = null
  /** 已结束的 episode,最新在前,上限 MAX_EPISODES。 */
  private recentEpisodes: HoldEpisode[] = []
  private episodeSeq = 0

  constructor(deps: HoldGateDeps) {
    this.clock = deps.clock
    this.isPoolAvailable = deps.isPoolAvailable
    this.config = deps.config
    this.onEvent = deps.onEvent
  }

  /** 事件出口(可选)。发射失败绝不影响主流程(I1)。 */
  private onEvent?: (event: HoldGateEvent) => void
  private emit(event: HoldGateEvent): void {
    try {
      this.onEvent?.(event)
    } catch {
      /* I1:观测失败不影响主流程 */
    }
  }

  /**
   * 时间线读数(桌面/手机面板消费)。返回**深拷贝**:调用方(IPC 序列化 / 前端)拿到的是快照,
   * 不能反手改到门闸内部状态上。
   */
  getTimeline(): { current: HoldEpisode | null; recent: HoldEpisode[] } {
    const clone = (ep: HoldEpisode): HoldEpisode => ({
      ...ep,
      detail: [...ep.detail],
      releases: ep.releases.map((r) => ({ ...r }))
    })
    return {
      current: this.currentEpisode ? clone(this.currentEpisode) : null,
      recent: this.recentEpisodes.map(clone)
    }
  }

  /**
   * 回填最近一条放行的结局(由 `ProxyServer` 主循环在拿号成功/失败/终态三处调用)。
   *
   * 这是「放行到底有没有让客户端看到字节」的唯一记录点 —— 见 {@link ReleaseOutcome} 的说明。
   * 无进行中 episode / 无 pending 记录时是 no-op(不抛错:回填点在主循环里,不能因观测而崩)。
   */
  settleLastRelease(outcome: Exclude<ReleaseOutcome, 'pending'>): void {
    try {
      const ep = this.currentEpisode
      if (!ep) return
      const last = ep.releases[ep.releases.length - 1]
      if (last && last.outcome === 'pending') {
        last.outcome = outcome
        last.outcomeAt = this.clock.now()
      }
      // 结局已定 → 这一轮真的结束了(拿到号服务完 / 终态)则归档;
      // 're-held' 是同一轮的延续,不归档。
      if (outcome !== 're-held') this.finalizeEpisode()
    } catch {
      /* I1:观测失败不影响主流程 */
    }
  }

  /**
   * 开一轮 episode。已有进行中的则并入,不覆盖起始时刻与原因。
   *
   * 注意本方法在 `held.set` **之前**被调,故此时 `held.size` 对「上一轮是否已结束」
   * 没有区分力(re-held 延续与全新一轮都是 0)。故归档完全交由
   * {@link settleLastRelease} / {@link onTimeout} / {@link abort} 按**显式结局**驱动,
   * 这里不做任何推断 —— 靠集合大小猜意图正是上一版把 re-held 切碎的原因。
   */
  private openEpisodeIfNeeded(params: EnterHoldParams): void {
    try {
      if (this.currentEpisode) return
      this.currentEpisode = {
        id: ++this.episodeSeq,
        reason: params.reason ?? 'pool-empty',
        detail: params.detail ? [...params.detail] : [],
        startedAt: this.clock.now(),
        endedAt: null,
        releases: []
      }
    } catch {
      /* I1 */
    }
  }

  /**
   * 关闭当前 episode 并归档(集合变空时)。
   *
   * ⚠️ **不在 `claim()` 里立刻调** —— 那会把「一轮挂起」切碎。放行的正常形态是:
   * `releaseAll` 清空集合 → 主循环拿号 → **拿不到又立刻 enterHold**。若在 claim 时就归档,
   * 这一轮会被切成 N 个只有一条放行记录的 episode,而用户问的是「这次挂起从几点开始、放了几次」,
   * 切碎后这个问题就无法回答了(每个碎片都显示"放了 1 次")。
   *
   * 故归档改由 {@link finalizeEpisodeIfSettled} 在**结局确定**时做:
   *   - `resumed-and-served` / `ended` → 这一轮真的结束了 → 归档
   *   - `re-held` → 请求又挂回去了 → 同一轮延续 → 不归档
   * 无人回填时(abort / 手动放行后调用方不关心结局)由 `enterHold` 的下一轮开始或
   * `resetSessionState` 收尾,不会永久悬挂。
   */
  private finalizeEpisode(): void {
    try {
      const ep = this.currentEpisode
      if (!ep || this.held.size > 0) return
      ep.endedAt = this.clock.now()
      this.recentEpisodes.unshift(ep)
      if (this.recentEpisodes.length > MAX_EPISODES) {
        this.recentEpisodes.length = MAX_EPISODES
      }
      this.currentEpisode = null
      this.emit({
        kind: 'episode-ended',
        at: ep.endedAt,
        startedAt: ep.startedAt,
        reason: ep.reason,
        releaseCount: ep.releases.length,
        durationMs: ep.endedAt - ep.startedAt
      })
    } catch {
      /* I1 */
    }
  }

  /**
   * 记一次放行动作。**口径 = 周期动作**:一次 releaseAll 放 N 条也只记一条,
   * 与 `autoReleaseCount` 口径一致(否则界面次数会随并发请求数虚高)。
   *
   * ## 为什么「放行 0 条」也要记(RCA 2026-08-12 修正)
   * 旧实现 `if (released <= 0) return` 直接丢弃,而调用方 `releaseAll('auto')` 的上游
   * 已经 `autoReleaseCount++` 了 ⇒ 界面「累计放行 14 次」与时间线「0 次」同屏矛盾,
   * 用户无法判断放行是否真的发生。两个数字都对外可见,口径必须统一。
   *
   * 而且「触发了但无事可放」本身是有信息量的事实:它说明上一次放行后请求已被别的
   * 终态(abort/超时)带走,或集合恰好为空 —— 与「放行了但没吐字节」是不同的世界。
   * 故照记,并用 `released` 字段区分,由消费方决定怎么显示。
   */
  private recordRelease(trigger: HoldRelease['trigger'], released: number): void {
    try {
      const ep = this.currentEpisode
      if (ep) {
        ep.releases.push({ at: this.clock.now(), trigger, outcome: 'pending', outcomeAt: null })
        if (ep.releases.length > MAX_RELEASES_PER_EPISODE) {
          ep.releases.splice(0, ep.releases.length - MAX_RELEASES_PER_EPISODE)
        }
      }
      // 事件出口独立于 episode 是否存在:放行动作本身发生了就该可见,
      // 不能因为「恰好没有进行中的 episode」而在日志里也消失(那正是旧缺陷的形态)。
      this.emit({
        kind: 'release',
        at: this.clock.now(),
        trigger,
        released,
        autoReleaseCount: this.autoReleaseCount,
        heldCountAfter: this.held.size
      })
    } catch {
      /* I1 */
    }
  }

  /** 有挂起请求且轮询未启动时,启动低频兜底轮询(周期 = maxWaitMs)。 */
  private startPollingIfNeeded(): void {
    if (this.pollHandle !== null) return
    if (this.held.size === 0) return
    // 轮询周期下限保护:maxWaitMs 理论上已被 config 归一化 clamp,这里再兜一道防 0/负值死循环。
    const periodMs = Math.max(1000, this.config.maxWaitMs)
    this.pollHandle = this.clock.setInterval(() => {
      // 周期性复查池:配额到点恢复等"无事件"恢复场景由此兜底放行。
      this.tryResume('poll')
      this.stopPollingIfIdle()
    }, periodMs)
  }

  /** 无挂起请求时停止轮询,避免空转 timer 泄漏。 */
  private stopPollingIfIdle(): void {
    if (this.pollHandle !== null && this.held.size === 0) {
      this.clock.clearInterval(this.pollHandle)
      this.pollHandle = null
    }
  }

  /**
   * 有挂起请求 + 开关开 + 调度器未启动时,启动自动放行 timer(周期 = autoReleaseIntervalMs)。
   * 生命周期跟随挂起集合(非空启动 / 空则停表),与兜底轮询同形态(I3)。
   */
  private startAutoReleaseIfNeeded(): void {
    if (this.autoReleaseHandle !== null) return
    if (!this.config.autoReleaseEnabled) return
    if (this.held.size === 0) return
    // 周期下限保护:间隔已被 holdConfig SSOT clamp,这里再兜一道防 0/负值把 FakeClock/Node 拖进死循环。
    const periodMs = Math.max(1000, this.config.autoReleaseIntervalMs)
    // 先算下次时刻再挂 timer:getNextAutoReleaseAt() 在任何时刻都能读到非 null(字段语义纪律)。
    this.autoReleaseNextAt = this.clock.now() + periodMs
    this.autoReleaseHandle = this.clock.setInterval(() => {
      // 关键:**不查 isPoolAvailable()**。这与 tryResume 的语义差别正是本功能存在的理由 ——
      // 池仍无可用号时才是最需要放行的场景:放行让上游重跑,产生客户端可见的流活动,
      // 客户端 idle watchdog 的 ~10min 计时随之重置(用户 2026-08-09 实测确立)。
      // 若这里加了池可用性判断,恰好在"账号一直受限"这个目标场景下永不触发 = 功能等于没做。
      this.autoReleaseCount++
      // 已认领条目(超时/abort/已放行)在 releaseAll 内部走 claim() 的一次性 CAS,自然 no-op(Invariant 2)。
      this.releaseAll('auto')
      if (this.held.size === 0) {
        // 集合已空 → 停表,不留空转 interval(Must NOT #3)。
        this.stopAutoRelease()
      } else {
        // 仍有未认领条目(如 keep_blocking 下超时留存者被 resume 后又被重新 enterHold 的场景之外,
        // 还包括 resume 回调内同步重新入集合)→ 推进下次时刻,倒计时继续。
        this.autoReleaseNextAt = this.clock.now() + periodMs
      }
    }, periodMs)
  }

  /** 停表并清空下次时刻(null = 没有下一次)。 */
  private stopAutoRelease(): void {
    if (this.autoReleaseHandle !== null) {
      this.clock.clearInterval(this.autoReleaseHandle)
      this.autoReleaseHandle = null
    }
    this.autoReleaseNextAt = null
  }

  /** 挂起集合空了就停表(与 stopPollingIfIdle 同调用点)。 */
  private stopAutoReleaseIfIdle(): void {
    if (this.autoReleaseHandle !== null && this.held.size === 0) {
      this.stopAutoRelease()
    }
  }

  /**
   * 热更新自动放行配置(D1 裁决:**重建 timer**,不继承"当轮周期启动时一次算好"的语义)。
   *
   * 为什么必须重建:兜底轮询的周期是启动时定下的,沿用那个语义会让用户「改了间隔没反应」,
   * 只能靠重启反代碰运气;而现有 hold 控件是刻意支持热生效的。重建代价极小。
   *
   * 原子性:先算新的 nextAt 再赋值 —— 重建瞬间 getNextAutoReleaseAt() 不得短暂返回 null,
   * 否则前端倒计时会闪一下「无」。
   */
  applyAutoReleaseConfig(next: { enabled: boolean; intervalMs: number }): void {
    this.config.autoReleaseEnabled = next.enabled
    this.config.autoReleaseIntervalMs = next.intervalMs
    // 停掉旧 timer(clearInterval 不影响读数字段),随后按新值重建;
    // startAutoReleaseIfNeeded 内部会先算 nextAt 再挂 timer,故读数不出现中间 null。
    if (this.autoReleaseHandle !== null) {
      this.clock.clearInterval(this.autoReleaseHandle)
      this.autoReleaseHandle = null
    }
    if (!next.enabled || this.held.size === 0) {
      this.autoReleaseNextAt = null
      return
    }
    this.startAutoReleaseIfNeeded()
  }

  /**
   * 服务会话复位:清空挂起条目 + 停掉本门闸的**所有** timer + 自动放行计数归零。
   *
   * 由 `ProxyServer` 在「启动服务 / 停止服务」这两个会话边界调用(它重置 sessionStats 的同一处)。
   * 为什么需要它:门闸实例是在 `ProxyServer` **构造函数**里建一次的,不是每次 start 建一次。
   * 计数器若只挂在实例上,stop→start 后会继承上一会话的累计值 —— 而契约(决策卡 §3)与
   * 用户口径都是「本次启动服务到停止服务之间累计,停止归零」,与既有 sessionStats 同生命周期。
   *
   * 语义(与 `abort` 同类,不与 `releaseAll` 同类):**作废,不驱动**。
   * 不调用任何 hooks —— 不 resume(服务都停了,重试无处可去)、不发 error/graceful_stop
   * (停服收尾由 `ProxyServer` 对 `activeRequests` 的 abort 负责,门闸不越权替它给客户端发信号)。
   *
   * `seq` **刻意不重置**:条目 id 全实例单调。上一会话残留的 abort 监听器若迟到触发,
   * 拿着旧 id 打进来必须打空,绝不能命中新会话刚建的条目。
   */
  resetSessionState(): void {
    for (const entry of [...this.held.values()]) {
      // 认领位置 true:任何迟到的入口(旧 abort 监听器 / 已排队的 timer 回调)后续都是 no-op。
      entry.claimed = true
      this.stopTimers(entry)
    }
    this.held.clear()
    // 集合已空 → 兜底轮询与自动放行调度器都必须停表,否则会留下一个对着「已停的服务」空转的 interval。
    this.stopPollingIfIdle()
    this.stopAutoRelease()
    this.autoReleaseCount = 0
    // 时间线与计数同生命周期(决策卡 I2):会话复位则整体归零,不留上一会话的 episode。
    this.currentEpisode = null
    this.recentEpisodes = []
  }

  /** 下次自动放行的绝对 epoch ms;null = 没有下一次(关闭 / 无挂起条目)。前端本地自减渲染倒计时。 */
  getNextAutoReleaseAt(): number | null {
    return this.autoReleaseNextAt
  }

  /** 本实例(= 本次反代启动)以来自动放行的**周期次数**,非条目数;手动放行不计入。 */
  getAutoReleaseCount(): number {
    return this.autoReleaseCount
  }

  /**
   * 让一个请求进入 HELD 状态:登记条目、启动心跳、按绝对 deadline 安排超时收尾。
   * @returns 该挂起条目的 id(供 abort 使用)。
   */
  enterHold(params: EnterHoldParams): number {
    const id = ++this.seq
    const entry: HeldEntry = {
      id,
      receivedAt: params.receivedAt,
      hooks: params.hooks,
      claimed: false,
      pingHandle: null,
      deadlineHandle: null
    }
    // 心跳:周期性发 ping
    entry.pingHandle = this.clock.setInterval(() => {
      if (entry.claimed) return
      entry.hooks.sendPing()
    }, this.config.pingIntervalMs)

    // 绝对 deadline:从 receivedAt 起算 totalBudgetMs,剩余不足 graceMs 即触发收尾。
    // 多次挂起循环共享同一 receivedAt → deadline 不重置(Invariant 3)。
    const deadlineAt = params.receivedAt + this.config.totalBudgetMs
    const triggerAt = deadlineAt - this.config.graceMs
    const delay = Math.max(0, triggerAt - this.clock.now())
    entry.deadlineHandle = this.clock.setTimeout(() => {
      this.onTimeout(entry)
    }, delay)

    // 时间线:集合由空变非空 → 开一轮 episode;已有进行中的则并入,不覆盖起始时刻与原因。
    this.openEpisodeIfNeeded(params)
    this.held.set(id, entry)
    // 有挂起请求 → 确保兜底轮询在跑(覆盖配额时间衰减等无事件恢复,方案 §5 A4)。
    this.startPollingIfNeeded()
    // 同上,自动放行调度器也在集合首次非空时起表(开关关闭时内部直接 return)。
    this.startAutoReleaseIfNeeded()
    this.emit({
      kind: 'hold-entered',
      at: this.clock.now(),
      id,
      reason: params.reason ?? 'pool-empty',
      detail: params.detail ?? [],
      heldCount: this.held.size
    })
    return id
  }

  /**
   * 一次性原子认领 + 清理该条目的 timer。返回是否认领成功(首个胜出者 true,其余 no-op false)。
   * 所有终态入口(resume / timeout-error / timeout-graceful / abort)先过这里(Invariant 2)。
   */
  private claim(entry: HeldEntry): boolean {
    if (entry.claimed) return false
    entry.claimed = true
    this.stopTimers(entry)
    this.held.delete(entry.id)
    // 挂起集合可能已空 → 停止兜底轮询,避免空转 timer 泄漏。
    this.stopPollingIfIdle()
    // 同上:最后一个条目被认领(放行/超时/abort)后自动放行调度器停表。
    this.stopAutoReleaseIfIdle()
    // 时间线:此处**不归档** —— 放行后主循环很可能立即重新 enterHold(池仍无号),
    // 那仍是同一轮挂起。归档时机见 finalizeEpisode 的说明。
    return true
  }

  private stopTimers(entry: HeldEntry): void {
    if (entry.pingHandle !== null) {
      this.clock.clearInterval(entry.pingHandle)
      entry.pingHandle = null
    }
    if (entry.deadlineHandle !== null) {
      this.clock.clearTimeout(entry.deadlineHandle)
      entry.deadlineHandle = null
    }
  }

  /** 绝对 deadline 到期收尾,按 timeoutAction 三态处理。 */
  private onTimeout(entry: HeldEntry): void {
    if (entry.claimed) return
    switch (this.config.timeoutAction) {
      case 'error':
        if (this.claim(entry)) {
          entry.hooks.sendError()
          // 终态:这一轮挂起到此结束(若有 pending 放行记录则一并标 ended)。
          this.settleLastRelease('ended')
          this.finalizeEpisode()
        }
        return
      case 'graceful_stop':
        if (this.claim(entry)) {
          entry.hooks.sendGracefulStop()
          this.settleLastRelease('ended')
          this.finalizeEpisode()
        }
        return
      case 'keep_blocking':
      default:
        // 不认领、不结束:请求继续 HELD,心跳继续,直到客户端自身硬顶断开(abort)。
        return
    }
  }

  /**
   * 池可用性变化时尝试自动放行:仅当池确有可用号时,认领并 resume 所有未认领的 HELD 请求。
   * 幂等:已认领请求是 no-op,绝不重复 resume(测试 3)。
   */
  tryResume(trigger: 'pool-available' | 'poll' = 'pool-available'): void {
    if (!this.isPoolAvailable()) return
    let released = 0
    for (const entry of [...this.held.values()]) {
      if (this.claim(entry)) {
        entry.hooks.resume()
        released++
      }
    }
    this.recordRelease(trigger, released)
    // 池恢复/轮询放行后主循环会拿到号(这正是 tryResume 的前提)→ 由它回填
    // 'resumed-and-served' 并归档;万一又没拿到 → 回填 're-held' 继续同一轮。此处不预判。
  }

  /**
   * 手动放行:认领并 resume 所有当前未认领的 HELD 请求(前端"放行"按钮 → IPC)。
   * @returns 实际被放行(认领成功)的请求数;无挂起请求时返回 0(幂等)。
   */
  releaseAll(trigger: HoldRelease['trigger'] = 'manual'): number {
    let released = 0
    for (const entry of [...this.held.values()]) {
      if (this.claim(entry)) {
        entry.hooks.resume()
        released++
      }
    }
    this.recordRelease(trigger, released)
    // 手动放行是一个**终结动作**:调用方(IPC / 面板按钮)不会回填结局,故就地归档,
    // 否则 episode 永远挂在 current 上。自动/轮询/池恢复三种由主循环回填,不在此归档。
    if (trigger === 'manual') this.finalizeEpisode()
    return released
  }

  /**
   * 客户端断开:作废该请求的认领位、停心跳清 timer、移出集合。不触发任何 resume/error/stop。
   * abort 优先级最高:一旦 abort,resume/timeout 都无法再驱动它(Invariant 2)。
   */
  abort(id: number): void {
    const entry = this.held.get(id)
    if (!entry) return
    // 直接认领作废(不调用任何 hooks),后续入口皆 no-op。
    this.claim(entry)
    // 客户端走了 → 这一轮挂起结束(集合空时),归档供事后查看。
    this.finalizeEpisode()
  }

  /** 当前挂起中的请求数(UI 展示 + 放行按钮启用条件)。 */
  getHeldCount(): number {
    return this.held.size
  }

  /** 当前所有挂起请求的 id 列表(供测试/接线遍历)。 */
  listHeldIds(): number[] {
    return [...this.held.keys()]
  }
}

/** 生产环境真实时钟(接线任务注入)。测试注入 FakeClock。 */
export const realClock: HoldClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>)
}
