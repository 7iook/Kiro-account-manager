// 回归测试:放行的可观测性与计数口径一致性
//
// 现场(2026-08-11 用户截图 + 生产日志对照):
//   界面「累计放行 14 次」,而同屏时间线里每一轮都写「0 次 / 尚未放行过」;
//   proxy-logs.json 里 **放行事件为零条**(只有 11 条「请求被挂起」)。
//   用户因此无法判断「放行到底有没有发生、有没有用」。
//
// 两个缺陷:
//   ① 计数口径不一致:`releaseAll('auto')` 的调用方先 `autoReleaseCount++`,
//      而 `recordRelease` 的第一行是 `if (released <= 0) return` ——
//      「本周期没有未认领条目可放」时计数照加、时间线不记 ⇒ 14 vs 0。
//      两个数字都对外可见(同一屏),口径必须统一:要么都算,要么都不算。
//   ② 放行完全无日志:holdGate 只更新内存计数,proxyLogger 一条不写。
//      RCA 2026-08-04 已就「holdGate.ts 零日志」批评过一次(挂起侧已补),
//      自动放行这条新路径又重犯 —— 用户报「放行没用」时后端仍无现场可查。
//
// 本文件锁三件事:
//   1. 每次自动放行周期都有可观测记录(哪怕放了 0 条,也要能看出「触发了但无事可放」)
//   2. autoReleaseCount 与时间线 releases 的条数口径一致
//   3. 放行动作有日志出口(logger sink 被调用),不再只存在于内存
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HoldGate, type HoldClock, type HoldGateRuntimeConfig } from '@main/proxy/holdGate'

/** 可控时钟:手动推进,不依赖真实定时器 */
function makeFakeClock() {
  let now = 1_000_000
  const timers: { id: number; fn: () => void; at: number; every: number | null }[] = []
  let seq = 0
  const clock: HoldClock = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ id, fn, at: now + ms, every: null }); return id as never },
    clearTimeout: (h) => { const i = timers.findIndex(t => t.id === h); if (i >= 0) timers.splice(i, 1) },
    setInterval: (fn, ms) => { const id = ++seq; timers.push({ id, fn, at: now + ms, every: ms }); return id as never },
    clearInterval: (h) => { const i = timers.findIndex(t => t.id === h); if (i >= 0) timers.splice(i, 1) }
  }
  return {
    clock,
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        now = due.at
        if (due.every !== null) due.at = now + due.every
        else timers.splice(timers.indexOf(due), 1)
        due.fn()
      }
      now = target
    }
  }
}

function makeConfig(over: Partial<HoldGateRuntimeConfig> = {}): HoldGateRuntimeConfig {
  return {
    pingIntervalMs: 1000,
    maxWaitMs: 60_000,
    totalBudgetMs: 2580 * 60_000,
    graceMs: 5_000,
    timeoutAction: 'keep_blocking',
    autoReleaseEnabled: true,
    autoReleaseIntervalMs: 8 * 60_000,
    ...over
  } as HoldGateRuntimeConfig
}

function enter(gate: HoldGate, now: number, hooks: Partial<Record<string, () => void>> = {}) {
  return gate.enterHold({
    receivedAt: now,
    reason: 'account-blocked',
    detail: ['acc: quotaExhausted(12376/10000)'],
    hooks: {
      sendPing: hooks.sendPing ?? (() => {}),
      resume: hooks.resume ?? (() => {}),
      sendError: hooks.sendError ?? (() => {}),
      sendGracefulStop: hooks.sendGracefulStop ?? (() => {})
    }
  } as never)
}

describe('放行可观测性 · 计数口径一致 + 有日志出口', () => {
  let sink: ReturnType<typeof vi.fn>

  beforeEach(() => {
    sink = vi.fn()
  })

  it('自动放行周期触发时必须有日志出口(此前 holdGate 零日志)', () => {
    const { clock, advance } = makeFakeClock()
    const gate = new HoldGate({
      clock,
      isPoolAvailable: () => false,
      config: makeConfig({ autoReleaseIntervalMs: 60_000 }),
      onEvent: sink
    } as never)
    enter(gate, clock.now())
    advance(61_000)
    expect(gate.getAutoReleaseCount()).toBe(1)
    // 放行是用户可感知的强干预 → 必须留痕,否则「放行有没有用」无从判断
    expect(sink).toHaveBeenCalled()
    const kinds = sink.mock.calls.map(c => c[0]?.kind ?? c[0])
    expect(kinds.some((k: string) => String(k).includes('release'))).toBe(true)
  })

  it('放行 0 条时:计数与时间线口径必须一致(不能一个加、一个不记)', () => {
    const { clock, advance } = makeFakeClock()
    const gate = new HoldGate({
      clock,
      isPoolAvailable: () => false,
      config: makeConfig({ autoReleaseIntervalMs: 60_000 }),
      onEvent: sink
    } as never)
    // 进入挂起 → resume 回调什么都不做(模拟「放行后主循环仍拿不到号」)
    enter(gate, clock.now())
    advance(61_000)   // 第 1 次自动放行:集合被清空,released=1
    // 集合已空 → 调度器停表。再推进不应继续累加计数(否则计数虚高)
    const countAfterFirst = gate.getAutoReleaseCount()
    advance(300_000)
    expect(gate.getAutoReleaseCount(), '集合空后不得继续累加').toBe(countAfterFirst)

    const tl = gate.getTimeline()
    const totalAutoReleases = (tl.current?.totalAutoReleaseCount ?? 0)
      + tl.recent.reduce((s, e) => s + e.totalAutoReleaseCount, 0)
    // 核心判据:累计值必须来自 episode 的不可截断总数,不能再从展示明细长度推断。
    expect(totalAutoReleases, 'episode auto total 应与 autoReleaseCount 同口径').toBe(countAfterFirst)
  })

  it('挂起进入/放行/归档三个节点都有事件出口(供落盘与事后聚合)', () => {
    const { clock, advance } = makeFakeClock()
    const gate = new HoldGate({
      clock,
      isPoolAvailable: () => false,
      config: makeConfig({ autoReleaseIntervalMs: 60_000 }),
      onEvent: sink
    } as never)
    const id = enter(gate, clock.now())
    advance(61_000)
    gate.abort(id)
    const kinds = sink.mock.calls.map(c => String(c[0]?.kind ?? c[0]))
    expect(kinds.some(k => k.includes('hold')), '进入挂起要有事件').toBe(true)
    expect(kinds.some(k => k.includes('release')), '放行要有事件').toBe(true)
  })
})
