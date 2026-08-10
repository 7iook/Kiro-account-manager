// 挂起门闸可观测性 —— 放行时间线(episode / release / outcome)
//
// 决策卡:.agent-workspace/.archive/2026-08-10/hold-gate-observability/decision-card.md
//
// 这些测试钉的是「用户能否在界面上回答三个问题」:
//   ① 这次挂起是什么原因触发的、几点开始   ② 下次放行还有多久(既有字段)
//   ③ 本轮放了几次、每次几点、放完之后请求是活了还是又挂回去了
//
// 第③项后半句(outcome)是本轮的承重字段:它是唯一能区分下面两个世界的读数 ——
//   甲 · 放行拿到号 → 真吐正文 → 客户端 600s 计时被重置 → 功能有效
//   乙 · 放行仍无号 → 重新 enterHold → 只发 ping → 计时未重置 → 「放行了 5 次还是断了」
// 2026-08-06 RCA §2.1 已 🟢 证实 watchdog 只认语义正文字节,ping 不重置它。
// 没有 outcome,「放行 N 次」这个数字无法区分甲乙,观测就白做了。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HoldGate } from '@main/proxy/holdGate'
import type { HoldClock, HoldTimeoutAction } from '@main/proxy/holdGate'

/** 与 holdGate.test.ts 同形态的注入式假时钟(刻意复制而非共享:测试文件间的耦合比重复更贵)。 */
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
  advance(ms: number): void {
    const target = this.t + ms
    let guard = 0
    for (;;) {
      const ready = this.timers.filter((x) => x.due <= target).sort((a, b) => a.due - b.due)[0]
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
  activeTimerCount(): number {
    return this.timers.length
  }
}

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
    autoReleaseEnabled: boolean
    autoReleaseIntervalMs: number
  }> = {},
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
      autoReleaseEnabled: true,
      autoReleaseIntervalMs: 480000,
      ...cfg
    }
  })
}

describe('HoldGate 时间线 · 触发原因与起始时刻', () => {
  let clock: FakeClock
  beforeEach(() => {
    clock = new FakeClock()
  })

  it('首次挂起时开一条episode_记录触发原因与起始时刻', () => {
    const gate = mkGate(clock)
    clock.advance(5000)
    gate.enterHold({
      receivedAt: 5000,
      hooks: makeHooks(),
      reason: 'account-blocked',
      detail: ['a@x.com 额度耗尽(重置于 12:00)']
    })

    const tl = gate.getTimeline()
    expect(tl.current).not.toBeNull()
    expect(tl.current!.reason).toBe('account-blocked')
    expect(tl.current!.detail).toEqual(['a@x.com 额度耗尽(重置于 12:00)'])
    expect(tl.current!.startedAt).toBe(5000)
    expect(tl.current!.endedAt).toBeNull()
    expect(tl.current!.releases).toEqual([])
    expect(tl.recent).toEqual([])
  })

  it('未传原因时回落pool_empty_不显示未知', () => {
    const gate = mkGate(clock)
    gate.enterHold({ receivedAt: 0, hooks: makeHooks() })
    expect(gate.getTimeline().current!.reason).toBe('pool-empty')
  })

  it('同一轮挂起里第二个请求进来_不新开episode而是并入当前', () => {
    const gate = mkGate(clock)
    gate.enterHold({ receivedAt: 0, hooks: makeHooks(), reason: 'account-blocked' })
    clock.advance(1000)
    gate.enterHold({ receivedAt: 1000, hooks: makeHooks(), reason: 'account-auth-failure' })

    const tl = gate.getTimeline()
    // episode 是「一轮挂起」而非「一个请求」:起始时刻与原因取第一个触发者,不被后来者覆盖。
    expect(tl.current!.startedAt).toBe(0)
    expect(tl.current!.reason).toBe('account-blocked')
    expect(tl.recent).toEqual([])
  })

  it('时间线时间戳与nextAutoReleaseAt同源_均来自注入时钟', () => {
    const gate = mkGate(clock, { autoReleaseIntervalMs: 60000 })
    clock.advance(7000)
    gate.enterHold({ receivedAt: 7000, hooks: makeHooks(), reason: 'account-blocked' })
    // 若 episode 用 Date.now() 而倒计时用注入时钟,这两个数会差好几个数量级(Must NOT #3)。
    expect(gate.getTimeline().current!.startedAt).toBe(7000)
    expect(gate.getNextAutoReleaseAt()).toBe(67000)
  })
})

describe('HoldGate 时间线 · 放行记录与结局回填', () => {
  let clock: FakeClock
  beforeEach(() => {
    clock = new FakeClock()
  })

  it('自动放行时追加一条release_trigger为auto且outcome初始为pending', () => {
    const gate = mkGate(clock, { autoReleaseIntervalMs: 60000 })
    gate.enterHold({ receivedAt: 0, hooks: makeHooks(), reason: 'account-blocked' })
    clock.advance(60000)

    const rel = gate.getTimeline().current!.releases
    expect(rel).toHaveLength(1)
    expect(rel[0].trigger).toBe('auto')
    expect(rel[0].at).toBe(60000)
    expect(rel[0].outcome).toBe('pending')
    expect(rel[0].outcomeAt).toBeNull()
  })

  it('放行后仍无号重新挂起_上一条release的outcome回填为re_held', () => {
    // 乙世界:这正是「放行了 N 次但请求还是断了」的形态 —— 界面必须能显示出来。
    const gate = mkGate(clock, { autoReleaseIntervalMs: 60000 })
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: 0, hooks, reason: 'account-blocked' })
    clock.advance(60000)
    expect(hooks.resume).toHaveBeenCalledTimes(1)

    // 主循环:拿不到号 → 回填 re-held → 重新入集合(同一 receivedAt,deadline 不重置)
    gate.settleLastRelease('re-held')
    gate.enterHold({ receivedAt: 0, hooks, reason: 'account-blocked' })

    const tl = gate.getTimeline()
    expect(tl.current!.releases).toHaveLength(1)
    expect(tl.current!.releases[0].outcome).toBe('re-held')
    expect(tl.current!.releases[0].outcomeAt).toBe(60000)
    // episode 未结束:请求还在挂,起始时刻仍是最初那次
    expect(tl.current!.startedAt).toBe(0)
    expect(tl.current!.endedAt).toBeNull()
  })

  it('放行后拿到号并完成_outcome回填为resumed_and_served且episode关闭', () => {
    // 甲世界(承重):用户手动实测成功的那次就是这个形态。
    const gate = mkGate(clock, { autoReleaseIntervalMs: 60000 })
    gate.enterHold({ receivedAt: 0, hooks: makeHooks(), reason: 'account-blocked' })
    clock.advance(60000)
    gate.settleLastRelease('resumed-and-served')

    const tl = gate.getTimeline()
    // 集合已空 → episode 关闭并归档
    expect(tl.current).toBeNull()
    expect(tl.recent).toHaveLength(1)
    expect(tl.recent[0].endedAt).toBe(60000)
    expect(tl.recent[0].releases[0].outcome).toBe('resumed-and-served')
  })

  it('一次放行同时放三条_只记一条release_与autoReleaseCount口径一致', () => {
    const gate = mkGate(clock, { autoReleaseIntervalMs: 60000 })
    for (let i = 0; i < 3; i++) gate.enterHold({ receivedAt: 0, hooks: makeHooks(), reason: 'account-blocked' })
    clock.advance(60000)

    // release 是「周期动作」不是「条目动作」——否则界面上的次数会随并发请求数虚高。
    // 自动放行后 episode 仍在 current(结局待主循环回填),此时尚未归档。
    expect(gate.getTimeline().current!.releases).toHaveLength(1)
    expect(gate.getAutoReleaseCount()).toBe(1)
  })

  it('手动放行记为manual_且不计入autoReleaseCount', () => {
    const gate = mkGate(clock, { autoReleaseIntervalMs: 600000 })
    gate.enterHold({ receivedAt: 0, hooks: makeHooks(), reason: 'account-blocked' })
    clock.advance(1000)
    gate.releaseAll()

    const ep = gate.getTimeline().recent[0]
    expect(ep.releases).toHaveLength(1)
    expect(ep.releases[0].trigger).toBe('manual')
    expect(ep.releases[0].at).toBe(1000)
    expect(gate.getAutoReleaseCount()).toBe(0)
  })

  it('池恢复导致的放行记为pool_available_与auto可区分', () => {
    let available = false
    const gate = mkGate(clock, {}, () => available)
    gate.enterHold({ receivedAt: 0, hooks: makeHooks(), reason: 'account-blocked' })
    clock.advance(1000)
    available = true
    gate.tryResume()

    // 池恢复放行同样由主循环回填结局,故此刻记录在 current。
    expect(gate.getTimeline().current!.releases[0].trigger).toBe('pool-available')
  })

  it('超时收尾为终态_outcome回填为ended', () => {
    const gate = mkGate(clock, {
      timeoutAction: 'error',
      totalBudgetMs: 100000,
      graceMs: 15000,
      autoReleaseIntervalMs: 60000
    })
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: 0, hooks, reason: 'account-blocked' })
    // 60000 自动放行一次(pending) → 但主循环还没回填就到了 85000 的 deadline
    clock.advance(60000)
    gate.settleLastRelease('re-held')
    gate.enterHold({ receivedAt: 0, hooks, reason: 'account-blocked' })
    clock.advance(30000) // → 90000 > 85000 触发 error 收尾
    expect(hooks.sendError).toHaveBeenCalledTimes(1)

    const tl = gate.getTimeline()
    expect(tl.current).toBeNull()
    expect(tl.recent[0].endedAt).not.toBeNull()
  })

  it('无进行中episode时回填是no_op_不抛错', () => {
    const gate = mkGate(clock)
    expect(() => gate.settleLastRelease('re-held')).not.toThrow()
    expect(gate.getTimeline().current).toBeNull()
  })
})

describe('HoldGate 时间线 · 上限与生命周期', () => {
  let clock: FakeClock
  beforeEach(() => {
    clock = new FakeClock()
  })

  it('episode数超过20_丢最旧不无限增长', () => {
    const gate = mkGate(clock, { autoReleaseIntervalMs: 600000 })
    for (let i = 0; i < 25; i++) {
      gate.enterHold({ receivedAt: clock.now(), hooks: makeHooks(), reason: 'account-blocked' })
      clock.advance(1000)
      gate.releaseAll() // 集合空 → episode 关闭归档
    }
    const tl = gate.getTimeline()
    expect(tl.recent).toHaveLength(20)
    // 最新在前:最后一轮的起始时刻最大
    expect(tl.recent[0].startedAt).toBeGreaterThan(tl.recent[19].startedAt)
  })

  it('单个episode的release超过50条_丢最旧', () => {
    const gate = mkGate(clock, { autoReleaseIntervalMs: 1000 })
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: 0, hooks, reason: 'account-blocked' })
    // 每次自动放行后立刻重新挂起,模拟「池一直不恢复」的长期循环
    for (let i = 0; i < 60; i++) {
      clock.advance(1000)
      gate.settleLastRelease('re-held')
      gate.enterHold({ receivedAt: 0, hooks, reason: 'account-blocked' })
    }
    expect(gate.getTimeline().current!.releases).toHaveLength(50)
  })

  it('resetSessionState清空时间线_与autoReleaseCount同步归零', () => {
    const gate = mkGate(clock, { autoReleaseIntervalMs: 60000 })
    gate.enterHold({ receivedAt: 0, hooks: makeHooks(), reason: 'account-blocked' })
    clock.advance(60000)
    expect(gate.getAutoReleaseCount()).toBe(1)

    gate.resetSessionState()
    const tl = gate.getTimeline()
    expect(tl.current).toBeNull()
    expect(tl.recent).toEqual([])
    expect(gate.getAutoReleaseCount()).toBe(0)
  })

  it('时间线写入抛异常时放行仍正常完成', () => {
    // I1 旁路隔离:观测设施坏了不能拖累主功能。
    const gate = mkGate(clock, { autoReleaseIntervalMs: 60000 })
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: 0, hooks, reason: 'account-blocked' })
    // 让 detail 数组在序列化/读取时炸(模拟埋点内部异常)
    const tl = gate.getTimeline()
    Object.defineProperty(tl.current!, 'releases', {
      get() {
        throw new Error('timeline exploded')
      }
    })
    expect(() => clock.advance(60000)).not.toThrow()
    expect(hooks.resume).toHaveBeenCalledTimes(1)
  })
})
