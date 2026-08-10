// TDD: HoldGate —— 无可用账号时冻结请求的"请求挂起门闸"(纯编排逻辑)
//
// 方案:.agent-workspace/.archive/2026-07-28/hold-gate-blocking/hold-gate-blocking-design.md
// 关键设计(方案 §1 状态机 + Invariants):
//   - 每个被挂起请求一个条目:per-request 一次性原子认领位(CAS)+ 进入时间 + 绝对 deadline
//   - 心跳:HELD 期间按 pingIntervalMs 周期发 ping(注入回调,不依赖 http.ServerResponse)
//   - 绝对 deadline:从 RECEIVED 起算 totalBudgetMs,全程不重置;单次挂起受 min(maxWaitMs, 剩余) 截断
//   - 恢复 = 一次性认领:releaseAll / tryResume / 超时 / abort 四入口竞争同一 CAS 位,只有第一个胜出
//   - 超时收尾三态:keep_blocking / error / graceful_stop
//   - abort:停心跳、清 timer、认领位作废,不泄漏
//
// 用注入式 FakeClock 完全掌控时间与 timer(不依赖 vi.useFakeTimers 全局魔法),
// 断言 sendPing / resume / timeout / abort 回调的可观察行为。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HoldGate } from '@main/proxy/holdGate'
import type { HoldClock, HeldRequestHooks, HoldTimeoutAction } from '@main/proxy/holdGate'

/** 可注入的假时钟:掌控 now() + setTimeout/setInterval,按 due 顺序推进。 */
class FakeClock implements HoldClock {
  private t = 0
  private seq = 0
  private timers: Array<{ id: number; fn: () => void; due: number; ms: number; interval: boolean }> = []
  now(): number {
    return this.t
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq
    this.timers.push({ id, fn, due: this.t + ms, ms, interval: false })
    return id
  }
  clearTimeout(h: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== h)
  }
  setInterval(fn: () => void, ms: number): unknown {
    const id = ++this.seq
    this.timers.push({ id, fn, due: this.t + ms, ms, interval: true })
    return id
  }
  clearInterval(h: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== h)
  }
  /** 推进时间,按到期顺序执行所有到期 timer(interval 会重排下一次)。 */
  advance(ms: number): void {
    const target = this.t + ms
    // 防御:同一 tick 大量 interval 触发的死循环护栏
    let guard = 0
    for (;;) {
      const ready = this.timers
        .filter((x) => x.due <= target)
        .sort((a, b) => a.due - b.due)[0]
      if (!ready) break
      if (++guard > 100000) throw new Error('FakeClock.advance loop guard')
      this.t = ready.due
      if (ready.interval) {
        ready.due += ready.ms
        ready.fn()
      } else {
        this.timers = this.timers.filter((x) => x.id !== ready.id)
        ready.fn()
      }
    }
    this.t = target
  }
  /** 当前存活 timer 数(测试泄漏用)。 */
  activeTimerCount(): number {
    return this.timers.length
  }
}

/** 造一组被 spy 的 per-request hooks。 */
function makeHooks() {
  return {
    sendPing: vi.fn(),
    resume: vi.fn(),
    sendError: vi.fn(),
    sendGracefulStop: vi.fn()
  }
}

function mkGate(
  clock: FakeClock,
  cfg: Partial<{
    pingIntervalMs: number
    maxWaitMs: number
    totalBudgetMs: number
    graceMs: number
    timeoutAction: HoldTimeoutAction
  }>,
  poolAvailable: () => boolean = () => false
): HoldGate {
  return new HoldGate({
    clock,
    isPoolAvailable: poolAvailable,
    config: {
      pingIntervalMs: 10000,
      maxWaitMs: 600000,
      totalBudgetMs: 1680000,
      graceMs: 15000,
      timeoutAction: 'keep_blocking',
      ...cfg
    }
  })
}

describe('HoldGate · 进入挂起', () => {
  let clock: FakeClock
  beforeEach(() => {
    clock = new FakeClock()
  })

  it('无可用账号且开关开_请求进入HELD而非报错', () => {
    const gate = mkGate(clock, {})
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })
    expect(gate.getHeldCount()).toBe(1)
    // 进入挂起本身不触发任何结束/恢复动作
    expect(hooks.resume).not.toHaveBeenCalled()
    expect(hooks.sendError).not.toHaveBeenCalled()
    expect(hooks.sendGracefulStop).not.toHaveBeenCalled()
  })
})

describe('HoldGate · 心跳', () => {
  let clock: FakeClock
  beforeEach(() => {
    clock = new FakeClock()
  })

  it('HELD期间每pingIntervalMs发一次ping', () => {
    const gate = mkGate(clock, { pingIntervalMs: 10000 })
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })
    clock.advance(10000)
    expect(hooks.sendPing).toHaveBeenCalledTimes(1)
    clock.advance(10000)
    expect(hooks.sendPing).toHaveBeenCalledTimes(2)
    clock.advance(25000) // 又过去 2.5 个间隔 → +2
    expect(hooks.sendPing).toHaveBeenCalledTimes(4)
    gate.releaseAll() // 收尾,避免泄漏
  })
})

describe('HoldGate · 自动放行(池可用性变化)', () => {
  let clock: FakeClock
  beforeEach(() => {
    clock = new FakeClock()
  })

  it('HELD中池新增可用账号_自动放行且只触发一次', () => {
    let available = false
    const gate = mkGate(clock, {}, () => available)
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })
    // 池仍不可用 → tryResume 无效
    gate.tryResume()
    expect(hooks.resume).not.toHaveBeenCalled()
    // 池出现可用号 → 自动放行
    available = true
    gate.tryResume()
    expect(hooks.resume).toHaveBeenCalledTimes(1)
    // 再次触发(池仍可用) → 已认领,幂等 no-op,绝不重复 resume
    gate.tryResume()
    expect(hooks.resume).toHaveBeenCalledTimes(1)
    expect(gate.getHeldCount()).toBe(0)
  })
})

describe('HoldGate · 手动放行', () => {
  let clock: FakeClock
  beforeEach(() => {
    clock = new FakeClock()
  })

  it('HELD中收到手动放行_立即重试', () => {
    const gate = mkGate(clock, {})
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })
    const released = gate.releaseAll()
    expect(released).toBe(1)
    expect(hooks.resume).toHaveBeenCalledTimes(1)
    expect(gate.getHeldCount()).toBe(0)
    // 重复放行 → 幂等,已无挂起请求
    expect(gate.releaseAll()).toBe(0)
    expect(hooks.resume).toHaveBeenCalledTimes(1)
  })
})

describe('HoldGate · 超时收尾三态', () => {
  let clock: FakeClock
  beforeEach(() => {
    clock = new FakeClock()
  })

  it('keep_blocking_达deadline不发结束事件而是继续发ping', () => {
    const gate = mkGate(clock, {
      timeoutAction: 'keep_blocking',
      totalBudgetMs: 60000,
      graceMs: 15000,
      pingIntervalMs: 10000
    })
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })
    clock.advance(60000) // 越过 deadline
    expect(hooks.sendError).not.toHaveBeenCalled()
    expect(hooks.sendGracefulStop).not.toHaveBeenCalled()
    expect(hooks.resume).not.toHaveBeenCalled()
    // 仍在发 ping(持续卡住体验)
    expect(hooks.sendPing).toHaveBeenCalled()
    expect(gate.getHeldCount()).toBe(1)
    gate.abort(gate.listHeldIds()[0]) // 收尾
  })

  it('error_达deadline发SSE error事件且不发message_stop', () => {
    const gate = mkGate(clock, {
      timeoutAction: 'error',
      totalBudgetMs: 60000,
      graceMs: 15000
    })
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })
    clock.advance(60000)
    expect(hooks.sendError).toHaveBeenCalledTimes(1)
    expect(hooks.sendGracefulStop).not.toHaveBeenCalled()
    expect(hooks.resume).not.toHaveBeenCalled()
    expect(gate.getHeldCount()).toBe(0)
  })

  it('graceful_stop_达deadline发提示文本加message_stop', () => {
    const gate = mkGate(clock, {
      timeoutAction: 'graceful_stop',
      totalBudgetMs: 60000,
      graceMs: 15000
    })
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })
    clock.advance(60000)
    expect(hooks.sendGracefulStop).toHaveBeenCalledTimes(1)
    expect(hooks.sendError).not.toHaveBeenCalled()
    expect(gate.getHeldCount()).toBe(0)
  })
})

describe('HoldGate · 绝对 deadline 不重置', () => {
  let clock: FakeClock
  beforeEach(() => {
    clock = new FakeClock()
  })

  it('多次挂起循环后总时长仍受绝对deadline约束且deadline不重置', () => {
    // receivedAt=0, 预算 60s, grace 15s → 收尾触发点 = deadline - grace = 绝对时刻 45000(不重置)。
    // 第一次挂起 30s 后放行,再次挂起时收尾点仍锚在绝对 45000,
    // 而非从二次挂起时刻(30000)重新起算 → 那样触发点会是 30000+45000=75000。
    const gate = mkGate(clock, { timeoutAction: 'error', totalBudgetMs: 60000, graceMs: 15000 })
    const received = 0
    const hooks1 = makeHooks()
    gate.enterHold({ receivedAt: received, hooks: hooks1 })
    clock.advance(30000)
    gate.releaseAll() // now=30000
    expect(hooks1.resume).toHaveBeenCalledTimes(1)

    // 二次挂起(同一请求,同一 receivedAt) → 收尾点依旧锚在绝对 45000
    const hooks2 = makeHooks()
    gate.enterHold({ receivedAt: received, hooks: hooks2 })
    clock.advance(14000) // now=44000,还没到绝对触发点 45000
    expect(hooks2.sendError).not.toHaveBeenCalled()
    clock.advance(2000) // now=46000,越过绝对触发点 45000 → 收尾
    // 若 deadline 被二次挂起重置(触发点变 75000),此处将 not called → 测试能捕获重置 bug
    expect(hooks2.sendError).toHaveBeenCalledTimes(1)
    // 证明总时长锚在绝对预算内(而非 30s + 60s = 90s)
    expect(clock.now()).toBeLessThan(90000)
  })
})

describe('HoldGate · 一次性原子认领', () => {
  let clock: FakeClock
  beforeEach(() => {
    clock = new FakeClock()
  })

  it('手动放行与超时竞争_只有一方认领成功请求只被处理一次', () => {
    const gate = mkGate(clock, { timeoutAction: 'error', totalBudgetMs: 60000, graceMs: 15000 })
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })
    // 手动放行先认领
    gate.releaseAll()
    expect(hooks.resume).toHaveBeenCalledTimes(1)
    // 随后 deadline 到期 —— 已被认领,超时无法二次驱动
    clock.advance(60000)
    expect(hooks.sendError).not.toHaveBeenCalled()
    expect(hooks.resume).toHaveBeenCalledTimes(1) // 仍只 1 次
    expect(gate.getHeldCount()).toBe(0)
  })

  it('超时先认领_随后的手动放行是no_op', () => {
    const gate = mkGate(clock, { timeoutAction: 'error', totalBudgetMs: 60000, graceMs: 15000 })
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })
    clock.advance(60000) // 超时先认领
    expect(hooks.sendError).toHaveBeenCalledTimes(1)
    // 手动放行 → 已无挂起,no-op
    expect(gate.releaseAll()).toBe(0)
    expect(hooks.resume).not.toHaveBeenCalled()
  })

  it('abort优先于resume_已abort请求无法再被放行', () => {
    const gate = mkGate(clock, {})
    const hooks = makeHooks()
    const id = gate.enterHold({ receivedAt: clock.now(), hooks })
    gate.abort(id)
    expect(gate.getHeldCount()).toBe(0)
    // abort 后放行 → no-op
    expect(gate.releaseAll()).toBe(0)
    expect(hooks.resume).not.toHaveBeenCalled()
  })
})

describe('HoldGate · abort 清理不泄漏', () => {
  let clock: FakeClock
  beforeEach(() => {
    clock = new FakeClock()
  })

  it('客户端断开abort后停心跳清timer不泄漏', () => {
    const gate = mkGate(clock, { pingIntervalMs: 10000, totalBudgetMs: 60000 })
    const hooks = makeHooks()
    const id = gate.enterHold({ receivedAt: clock.now(), hooks })
    // 挂起中至少有 timer 存活(心跳 + deadline)
    expect(clock.activeTimerCount()).toBeGreaterThan(0)
    gate.abort(id)
    // abort 后无残留 timer,无残留请求
    expect(clock.activeTimerCount()).toBe(0)
    expect(gate.getHeldCount()).toBe(0)
    // 继续推进时间不再发 ping(心跳已停)
    const before = hooks.sendPing.mock.calls.length
    clock.advance(60000)
    expect(hooks.sendPing.mock.calls.length).toBe(before)
    expect(hooks.sendError).not.toHaveBeenCalled()
  })

  it('releaseAll与abort后所有timer都被清理', () => {
    const gate = mkGate(clock, {})
    gate.enterHold({ receivedAt: clock.now(), hooks: makeHooks() })
    gate.enterHold({ receivedAt: clock.now(), hooks: makeHooks() })
    expect(gate.getHeldCount()).toBe(2)
    gate.releaseAll()
    expect(gate.getHeldCount()).toBe(0)
    expect(clock.activeTimerCount()).toBe(0)
  })
})

describe('HoldGate · 多请求并发隔离', () => {
  let clock: FakeClock
  beforeEach(() => {
    clock = new FakeClock()
  })

  it('多个请求同时HELD_一次放行全部唤醒且各自隔离', () => {
    const gate = mkGate(clock, {})
    const hA = makeHooks()
    const hB = makeHooks()
    const hC = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks: hA })
    gate.enterHold({ receivedAt: clock.now(), hooks: hB })
    gate.enterHold({ receivedAt: clock.now(), hooks: hC })
    expect(gate.getHeldCount()).toBe(3)
    const released = gate.releaseAll()
    expect(released).toBe(3)
    // 每个请求各自的 resume 各触发一次(隔离,不串号)
    expect(hA.resume).toHaveBeenCalledTimes(1)
    expect(hB.resume).toHaveBeenCalledTimes(1)
    expect(hC.resume).toHaveBeenCalledTimes(1)
    expect(gate.getHeldCount()).toBe(0)
  })

  it('单个请求abort不影响其他HELD请求', () => {
    const gate = mkGate(clock, {})
    const hA = makeHooks()
    const hB = makeHooks()
    const idA = gate.enterHold({ receivedAt: clock.now(), hooks: hA })
    gate.enterHold({ receivedAt: clock.now(), hooks: hB })
    gate.abort(idA)
    expect(gate.getHeldCount()).toBe(1)
    gate.releaseAll()
    expect(hA.resume).not.toHaveBeenCalled() // A 已 abort
    expect(hB.resume).toHaveBeenCalledTimes(1) // B 正常放行
  })
})

describe('HoldGate · 兜底轮询(方案 §5 A4:覆盖配额时间衰减等无事件恢复)', () => {
  let clock: FakeClock
  beforeEach(() => {
    clock = new FakeClock()
  })

  it('池"无事件地"变可用(配额到点)→ 兜底轮询在 maxWaitMs 周期自动放行', () => {
    let poolUp = false
    const gate = mkGate(clock, { maxWaitMs: 30000 }, () => poolUp)
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })
    // 池仍不可用,轮询到期也不放行
    clock.advance(30000)
    expect(hooks.resume).not.toHaveBeenCalled()
    expect(gate.getHeldCount()).toBe(1)
    // 配额到点恢复(纯时间流逝,无任何写方法触发 availabilityListener 事件)
    poolUp = true
    // 下一个轮询周期到达 → 兜底 tryResume 放行
    clock.advance(30000)
    expect(hooks.resume).toHaveBeenCalledTimes(1)
    expect(gate.getHeldCount()).toBe(0)
  })

  it('所有挂起请求认领后 → 兜底轮询停止(不空转泄漏 timer)', () => {
    const gate = mkGate(clock, { maxWaitMs: 30000 }, () => false)
    const hooks = makeHooks()
    const before = clock.activeTimerCount()
    gate.enterHold({ receivedAt: clock.now(), hooks })
    // 进入挂起后有额外 timer(ping + deadline + poll)
    expect(clock.activeTimerCount()).toBeGreaterThan(before)
    gate.releaseAll()
    // 全部认领后所有 timer(含 poll)清理干净
    expect(clock.activeTimerCount()).toBe(before)
  })
})

describe('HoldGate · 自动定时放行(决策卡 hold-gate-auto-release)', () => {
  let clock: FakeClock
  beforeEach(() => {
    clock = new FakeClock()
  })

  // 承重场景:池「从头到尾无可用号」时仍到点放行 —— 与 tryResume 的语义差别所在。
  // tryResume 只在池有号时放;自动放行不看池状态,因为「放一次让客户端看守重置」是目的本身。
  it('开启自动放行_池仍无可用号也会到点放行挂起请求', () => {
    const gate = mkGate(clock, { autoReleaseEnabled: true, autoReleaseIntervalMs: 480000 }, () => false)
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })

    clock.advance(479000)
    expect(hooks.resume).not.toHaveBeenCalled()

    clock.advance(1000)
    expect(hooks.resume).toHaveBeenCalledTimes(1)
    expect(gate.getHeldCount()).toBe(0)
  })

  it('关闭自动放行_到点不放行', () => {
    const gate = mkGate(clock, { autoReleaseEnabled: false, autoReleaseIntervalMs: 480000 }, () => false)
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })

    clock.advance(480000 * 3)
    expect(hooks.resume).not.toHaveBeenCalled()
    expect(gate.getHeldCount()).toBe(1)
  })

  // timer 泄漏防线:空集合不该留下空转 interval(应用退出时会挂住 Node)。
  it('挂起集合为空时不启动自动放行timer_最后一个请求被认领后停表', () => {
    const gate = mkGate(clock, { autoReleaseEnabled: true, autoReleaseIntervalMs: 480000 }, () => false)
    const baseline = clock.activeTimerCount()
    expect(baseline).toBe(0)

    const hooks = makeHooks()
    const id = gate.enterHold({ receivedAt: clock.now(), hooks })
    expect(clock.activeTimerCount()).toBeGreaterThan(baseline)

    gate.abort(id)
    expect(gate.getHeldCount()).toBe(0)
    expect(clock.activeTimerCount()).toBe(0)
  })

  // Invariant 2(一次性 CAS 认领):abort 后的条目不得被自动放行再次驱动。
  it('已认领的条目不会被自动放行重复resume', () => {
    const gate = mkGate(clock, { autoReleaseEnabled: true, autoReleaseIntervalMs: 480000 }, () => false)
    const hooks = makeHooks()
    const id = gate.enterHold({ receivedAt: clock.now(), hooks })

    gate.abort(id)
    clock.advance(480000 * 2)
    expect(hooks.resume).not.toHaveBeenCalled()
  })

  // D1 裁决:改间隔必须重建 timer。继承「当轮周期已算好」的语义会表现为「改了没反应」。
  it('间隔配置变更后_下一次放行按新间隔', () => {
    const gate = mkGate(clock, { autoReleaseEnabled: true, autoReleaseIntervalMs: 480000 }, () => false)
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })

    clock.advance(60000)
    gate.applyAutoReleaseConfig({ enabled: true, intervalMs: 180000 })

    // 新间隔从改配置那一刻重新起算:再走 179s 不该放
    clock.advance(179000)
    expect(hooks.resume).not.toHaveBeenCalled()
    clock.advance(1000)
    expect(hooks.resume).toHaveBeenCalledTimes(1)
  })

  // 口径:一次 timer 触发 = +1(哪怕放了 0 个条目);手动放行不计入自动计数。
  it('累计放行次数随每次自动放行递增_手动放行不计入自动计数', () => {
    const gate = mkGate(clock, { autoReleaseEnabled: true, autoReleaseIntervalMs: 480000 }, () => false)
    expect(gate.getAutoReleaseCount()).toBe(0)

    gate.enterHold({ receivedAt: clock.now(), hooks: makeHooks() })
    clock.advance(480000)
    expect(gate.getAutoReleaseCount()).toBe(1)

    // 手动放行:不改自动计数
    gate.enterHold({ receivedAt: clock.now(), hooks: makeHooks() })
    gate.releaseAll()
    expect(gate.getAutoReleaseCount()).toBe(1)
  })

  // D2 展开:keep_blocking 下超时条目留在集合且未认领 → 自动放行仍能认领它。
  // 这正是「无限挂」成立的前提。
  it('预算耗尽的条目在keep_blocking下仍被自动放行认领', () => {
    const gate = mkGate(
      clock,
      {
        autoReleaseEnabled: true,
        autoReleaseIntervalMs: 100000,
        totalBudgetMs: 100000,
        graceMs: 15000,
        timeoutAction: 'keep_blocking'
      },
      () => false
    )
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })

    // 越过 deadline(85s 触发点)后仍在集合里
    clock.advance(90000)
    expect(gate.getHeldCount()).toBe(1)
    expect(hooks.sendError).not.toHaveBeenCalled()

    // 下一个自动放行周期(120s)仍能认领它
    clock.advance(10000)
    expect(hooks.resume).toHaveBeenCalledTimes(1)
  })

  // D2 展开的对照面:error/graceful_stop 下 onTimeout 已 claim 并移出集合 → 自动放行认领不到。
  it('timeoutAction为error时_预算到点后条目已被认领_自动放行认领不到', () => {
    const gate = mkGate(
      clock,
      {
        autoReleaseEnabled: true,
        autoReleaseIntervalMs: 100000,
        totalBudgetMs: 100000,
        graceMs: 15000,
        timeoutAction: 'error'
      },
      () => false
    )
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })

    clock.advance(90000)
    expect(hooks.sendError).toHaveBeenCalledTimes(1)
    expect(gate.getHeldCount()).toBe(0)

    clock.advance(60000)
    expect(hooks.resume).not.toHaveBeenCalled()
  })

  // 字段语义纪律:null = 没有下一次。禁用 0 表达「无」(0 是合法 epoch)。
  it('无挂起条目时nextAutoReleaseAt为null而非0', () => {
    const gate = mkGate(clock, { autoReleaseEnabled: true, autoReleaseIntervalMs: 480000 }, () => false)
    expect(gate.getNextAutoReleaseAt()).toBeNull()

    const id = gate.enterHold({ receivedAt: clock.now(), hooks: makeHooks() })
    expect(gate.getNextAutoReleaseAt()).toBe(clock.now() + 480000)

    gate.abort(id)
    expect(gate.getNextAutoReleaseAt()).toBeNull()
  })

  it('关闭自动放行时nextAutoReleaseAt为null', () => {
    const gate = mkGate(clock, { autoReleaseEnabled: false, autoReleaseIntervalMs: 480000 }, () => false)
    gate.enterHold({ receivedAt: clock.now(), hooks: makeHooks() })
    expect(gate.getNextAutoReleaseAt()).toBeNull()
  })

  // 重建瞬间的原子性:先算新值再赋值,不出现中间 null(否则前端倒计时会闪一下「无」)。
  it('间隔热改的瞬间nextAutoReleaseAt不出现中间null', () => {
    const gate = mkGate(clock, { autoReleaseEnabled: true, autoReleaseIntervalMs: 480000 }, () => false)
    gate.enterHold({ receivedAt: clock.now(), hooks: makeHooks() })

    clock.advance(60000)
    gate.applyAutoReleaseConfig({ enabled: true, intervalMs: 180000 })
    const after = gate.getNextAutoReleaseAt()
    expect(after).not.toBeNull()
    expect(after).toBe(clock.now() + 180000)
  })
})

describe('HoldGate · 两定时器同刻竞争(兜底轮询 vs 自动放行)', () => {
  let clock: FakeClock
  beforeEach(() => {
    clock = new FakeClock()
  })

  // ── 本组的时序前提(实测取证,非推理),写在这里免得后人重新踩 ──────────────
  // FakeClock.advance 用 `sort((a,b) => a.due - b.due)[0]` 挑下一个到期 timer。
  // V8 的 sort 是稳定排序 → 同 due 时**数组插入顺序**决定谁先跑。
  // 而插入顺序由生产代码 enterHold 钉死:先 startPollingIfNeeded() 再
  // startAutoReleaseIfNeeded() → **兜底轮询恒定排在自动放行之前**。
  // applyAutoReleaseConfig 重建 auto timer 只会把它挪到数组更后面,也换不了位。
  // 结论:同一 tick 上「轮询先跑」可构造;「自动放行先跑」**在本 harness 里造不出来**。
  //       后者改用「自动周期严格短于轮询周期」在不同 tick 上覆盖(见本组末两例)。

  // 同刻竞争 · 池不可用:轮询先跑但放不了(tryResume 看池),随后自动放行放它。
  // 无论谁先认领,条目都只能被 resume 一次 —— 这是统一 claim() 的 CAS 该保证的事。
  it('两定时器同刻到期_池不可用_条目只被放行一次', () => {
    const gate = mkGate(
      clock,
      { autoReleaseEnabled: true, autoReleaseIntervalMs: 100000, maxWaitMs: 100000 },
      () => false
    )
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })

    clock.advance(100000) // 轮询与自动放行同刻到期

    expect(hooks.resume).toHaveBeenCalledTimes(1)
    expect(gate.getHeldCount()).toBe(0)
    // 放行的是自动那一支(轮询因池不可用放不了)→ 计数 +1
    expect(gate.getAutoReleaseCount()).toBe(1)
    expect(clock.activeTimerCount()).toBe(0) // 集合空 → 两张表都停,不留空转
  })

  // 同刻竞争 · 池可用:轮询先抢到 claim(),集合随即空 →
  // claim() 内的 stopAutoReleaseIfIdle() 把自动 timer **在它触发之前就清掉了**。
  // 故这一支的正确口径是 count 保持 0 —— 「没跑过的周期不算一次」。
  //
  // ⚠️ 这一条与派单文档的断言相反(文档预期 +1,理由是「一次 timer 触发 = +1」)。
  // 两者其实不矛盾:文档那条口径管的是「回调真的跑了但放了 0 条」,而本场景里回调
  // **根本没跑**。区别不是措辞 —— 它决定用户屏幕上的数字含义:count 是「调度器真跑了
  // 几轮」,不是「本该跑几轮」。若将来有人把 stopAutoReleaseIfIdle() 挪到自增之后、
  // 或改成「清表前补记一次」,这条会红。
  it('两定时器同刻到期_池可用_轮询先认领_自动放行未触发故计数不涨', () => {
    const gate = mkGate(
      clock,
      { autoReleaseEnabled: true, autoReleaseIntervalMs: 100000, maxWaitMs: 100000 },
      () => true
    )
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })

    clock.advance(100000)

    expect(hooks.resume).toHaveBeenCalledTimes(1) // 仍然只放一次
    expect(gate.getHeldCount()).toBe(0)
    expect(gate.getAutoReleaseCount()).toBe(0) // 自动回调未触发 → 不计数
    expect(gate.getNextAutoReleaseAt()).toBeNull() // 停表后 null,不是 0
  })

  // 计数口径的可达半边:一次触发 = +1,与该次放了几条无关。
  // 防的是「改成按放行条目数累加」——那会让界面上「放行次数」在多请求场景下虚高。
  it('一次自动放行同时放三条_计数只加一(周期数而非条目数)', () => {
    const gate = mkGate(
      clock,
      { autoReleaseEnabled: true, autoReleaseIntervalMs: 100000, maxWaitMs: 600000 },
      () => false
    )
    const a = makeHooks()
    const b = makeHooks()
    const c = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks: a })
    gate.enterHold({ receivedAt: clock.now(), hooks: b })
    gate.enterHold({ receivedAt: clock.now(), hooks: c })

    clock.advance(100000)

    expect(a.resume).toHaveBeenCalledTimes(1)
    expect(b.resume).toHaveBeenCalledTimes(1)
    expect(c.resume).toHaveBeenCalledTimes(1)
    expect(gate.getAutoReleaseCount()).toBe(1) // 不是 3
  })

  // 反向:自动放行先认领(周期严格短于轮询)。之后轮询到点时已无事可做 ——
  // 不得重复 resume、不得抛错。同刻的这个方向本 harness 造不出(见组首说明),
  // 故用「自动周期 < 轮询周期」在不同 tick 上覆盖同一风险面。
  it('自动放行先认领_随后轮询到点无事可做_不重复放行不抛错', () => {
    const gate = mkGate(
      clock,
      { autoReleaseEnabled: true, autoReleaseIntervalMs: 60000, maxWaitMs: 150000 },
      () => true // 池可用:轮询若还能找到条目就会放,借此暴露重复放行
    )
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })

    expect(() => clock.advance(600000)).not.toThrow() // 跨过多个轮询周期

    expect(hooks.resume).toHaveBeenCalledTimes(1)
    expect(gate.getHeldCount()).toBe(0)
    expect(gate.getAutoReleaseCount()).toBe(1)
    expect(clock.activeTimerCount()).toBe(0)
  })

  // 生产里 resume 会走 runWithHold 主循环 continue → 仍无号则**同步重新 enterHold**。
  // 于是两张表都还活着,两支放行在后续 tick 上交替命中同一集合。
  // 锁两件事:① 每个条目各自只被 resume 一次(CAS 跨重入仍成立);
  //          ② 轮询那一支的放行**不计入** autoReleaseCount(口径不被另一支污染)。
  it('放行后同步重新挂起_两支交替命中_各条目只放一次且轮询放行不计入自动计数', () => {
    let poolUp = false
    const gate = mkGate(
      clock,
      { autoReleaseEnabled: true, autoReleaseIntervalMs: 60000, maxWaitMs: 150000 },
      () => poolUp
    )

    const seen: ReturnType<typeof makeHooks>[] = []
    // 首个条目被放行后,模拟主循环「仍无号 → 重新入集合」(同一 receivedAt,I1 不重置 deadline)。
    const first = makeHooks()
    first.resume.mockImplementation(() => {
      const next = makeHooks()
      seen.push(next)
      gate.enterHold({ receivedAt: 0, hooks: next })
    })
    seen.push(first)
    gate.enterHold({ receivedAt: 0, hooks: first })

    clock.advance(60000) // 自动放行到点 → 放 first,其 resume 同步重新挂起一个新条目
    expect(first.resume).toHaveBeenCalledTimes(1)
    expect(gate.getAutoReleaseCount()).toBe(1)
    expect(gate.getHeldCount()).toBe(1) // 新条目在集合里,两张表继续跑

    // 池恢复 → 轮询那一支把重入的条目放掉
    poolUp = true
    clock.advance(150000)

    // 每个条目各自恰好一次 resume,无重复驱动
    for (const h of seen) {
      expect(h.resume).toHaveBeenCalledTimes(1)
    }
    // 期间自动放行可能也触发过,但轮询的放行绝不能计入自动计数:
    // 计数只允许等于自动回调真实触发次数,而非总放行条目数。
    expect(gate.getAutoReleaseCount()).toBeLessThan(seen.length + 1)
    expect(gate.getHeldCount()).toBe(0)
    expect(clock.activeTimerCount()).toBe(0)
  })
})
