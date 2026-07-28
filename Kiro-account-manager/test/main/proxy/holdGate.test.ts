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
