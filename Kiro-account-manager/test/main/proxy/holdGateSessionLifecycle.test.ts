// 回归测试:自动放行累计次数的**会话生命周期**(启动服务 → 停止服务 → 归零)
//
// 决策卡:.agent-workspace/.archive/2026-08-09/hold-gate-auto-release/decision-card.md
//   §3 字段契约 `autoReleaseCount` 一行:「本次反代启动以来…反代停止归零」
//   用户原话(2026-08-09):「类似于额度那个」—— 即与既有 sessionStats 同生命周期。
//
// 缺陷(修复前):计数器是 `HoldGate` 实例字段,而 `HoldGate` 在 `ProxyServer` **构造函数**里
//   建一次(proxyServer.ts:455),不是每次 start 建一次;而 start() 明确重置了 sessionStats
//   (proxyServer.ts:647「重置会话统计(每次 start 开启一个新会话)」)却没人重置门闸计数。
//   后果:同一 ProxyServer 实例 start → 放行 2 次 → stop → start,界面仍显示 2 而非 0。
//
// 本文件锁两层:
//   ① 门闸层:`resetSessionState()` 的语义(计数归零 / timer 停表 / 条目清空 / id 不复用)
//   ② 反代层:**同一实例** start→放行→stop→start 后读数为 0(真正的用户可见判据)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HoldGate } from '@main/proxy/holdGate'
import type { HoldClock, HoldTimeoutAction } from '@main/proxy/holdGate'
import { ProxyServer } from '@main/proxy/proxyServer'

/** 与 holdGate.test.ts 同形态的注入式假时钟(此处只需 advance + 存活 timer 计数)。 */
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
  return { sendPing: vi.fn(), resume: vi.fn(), sendError: vi.fn(), sendGracefulStop: vi.fn() }
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
  }> = {}
): HoldGate {
  return new HoldGate({
    clock,
    isPoolAvailable: () => false,
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

describe('HoldGate · 会话状态复位(resetSessionState)', () => {
  let clock: FakeClock
  beforeEach(() => {
    clock = new FakeClock()
  })

  it('复位后自动放行计数归零_下次时刻归null', () => {
    const gate = mkGate(clock)
    gate.enterHold({ receivedAt: clock.now(), hooks: makeHooks() })
    clock.advance(480000)
    expect(gate.getAutoReleaseCount()).toBe(1)

    gate.resetSessionState()
    expect(gate.getAutoReleaseCount()).toBe(0)
    expect(gate.getNextAutoReleaseAt()).toBeNull()
  })

  // 停止服务不得留下一个仍在对着「已停的服务」跑的调度器 / 兜底轮询 / 心跳。
  it('复位清空挂起条目与全部timer_不留空转调度器', () => {
    const gate = mkGate(clock)
    gate.enterHold({ receivedAt: clock.now(), hooks: makeHooks() })
    gate.enterHold({ receivedAt: clock.now(), hooks: makeHooks() })
    expect(gate.getHeldCount()).toBe(2)
    expect(clock.activeTimerCount()).toBeGreaterThan(0)

    gate.resetSessionState()
    expect(gate.getHeldCount()).toBe(0)
    expect(clock.activeTimerCount()).toBe(0)

    // 复位后继续推进时间:不该再有任何回调被触发(计数不涨)
    clock.advance(480000 * 3)
    expect(gate.getAutoReleaseCount()).toBe(0)
  })

  // 复位不调用任何 hooks(与 abort 同语义:作废,不 resume / 不发 error)——
  // 停服的收尾由 ProxyServer 的 activeRequests.abort() 负责,门闸不越权替它发信号。
  it('复位不触发resume_error_gracefulStop任何回调', () => {
    const gate = mkGate(clock)
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })
    gate.resetSessionState()
    expect(hooks.resume).not.toHaveBeenCalled()
    expect(hooks.sendError).not.toHaveBeenCalled()
    expect(hooks.sendGracefulStop).not.toHaveBeenCalled()
  })

  // 条目 id 单调不复用:上一会话残留的 abort 监听器若在复位后触发 abort(旧id),
  // 绝不能命中新会话刚建的条目(否则新请求被上一会话的清理动作误杀)。
  it('复位后条目id不复用_旧abort打不到新条目', () => {
    const gate = mkGate(clock)
    const oldId = gate.enterHold({ receivedAt: clock.now(), hooks: makeHooks() })
    gate.resetSessionState()

    const freshHooks = makeHooks()
    const newId = gate.enterHold({ receivedAt: clock.now(), hooks: freshHooks })
    expect(newId).not.toBe(oldId)

    // 上一会话残留监听器迟到触发
    gate.abort(oldId)
    expect(gate.getHeldCount()).toBe(1)
    clock.advance(480000)
    expect(freshHooks.resume).toHaveBeenCalledTimes(1)
  })
})

describe('ProxyServer · 自动放行累计次数随服务会话归零(同一实例 start→stop→start)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // 承重用例:决策卡 §3「反代停止归零」。修复前此处为 2,因为 HoldGate 在构造函数里建一次,
  // 而 start() 只重置了 sessionStats。
  it('放行2次后停止再启动_累计次数回到0', async () => {
    const server = new ProxyServer({
      host: '127.0.0.1',
      port: 0, // 让内核分配空闲端口,避免与本机真实反代/并发测试撞车
      holdWhenNoAccount: true,
      holdAutoReleaseEnabled: true,
      holdAutoReleaseIntervalMs: 60000
    })

    await server.start()
    expect(server.getHoldAutoReleaseState().autoReleaseCount).toBe(0)

    // 用假定时器驱动真实的 realClock 调度器(realClock 在调用点解析全局 timer,故被 vi 接管)。
    // 直接对门闸 enterHold:本用例验的是「计数的会话生命周期」,不是请求层接线(另有用例覆盖)。
    vi.useFakeTimers()
    const gate = server.getHoldGate()
    gate.enterHold({ receivedAt: Date.now(), hooks: makeHooks() })
    vi.advanceTimersByTime(60000)
    gate.enterHold({ receivedAt: Date.now(), hooks: makeHooks() })
    vi.advanceTimersByTime(60000)
    vi.useRealTimers()

    expect(server.getHoldAutoReleaseState().autoReleaseCount).toBe(2)

    await server.stop(0)
    await server.start()

    // 新会话 = 新计数(与 sessionStats 同口径)
    expect(server.getHoldAutoReleaseState().autoReleaseCount).toBe(0)
    expect(server.getHoldAutoReleaseState().nextAutoReleaseAt).toBeNull()

    await server.stop(0)
  })

  // 停止服务后不得留下仍在跑的调度器(对着一个已停的服务定时放行毫无意义,且是 timer 泄漏)。
  it('停止服务后调度器停表_挂起条目清空', async () => {
    const server = new ProxyServer({
      host: '127.0.0.1',
      port: 0,
      holdWhenNoAccount: true,
      holdAutoReleaseEnabled: true,
      holdAutoReleaseIntervalMs: 60000
    })
    await server.start()

    const gate = server.getHoldGate()
    gate.enterHold({ receivedAt: Date.now(), hooks: makeHooks() })
    expect(server.getHeldRequestsCount()).toBe(1)
    expect(server.getHoldAutoReleaseState().nextAutoReleaseAt).not.toBeNull()

    await server.stop(0)

    expect(server.getHeldRequestsCount()).toBe(0)
    expect(server.getHoldAutoReleaseState().nextAutoReleaseAt).toBeNull()
  })

  // 用户可见性:主进程内存里归零 ≠ 界面看到 0。桌面端只在挂载时拉一次 + 之后靠推送,
  // 故 start 必须推一次新会话读数,否则界面会一直显示上一会话的累计值直到下次挂起活动。
  it('启动服务时推送一次归零读数_界面不残留上一会话的累计值', async () => {
    const pushes: Array<{ count: number; autoReleaseCount: number }> = []
    const server = new ProxyServer(
      {
        host: '127.0.0.1',
        port: 0,
        holdWhenNoAccount: true,
        holdAutoReleaseEnabled: true,
        holdAutoReleaseIntervalMs: 60000
      },
      {
        onHeldRequestsChanged: (info) => {
          pushes.push({ count: info.count, autoReleaseCount: info.autoReleaseCount })
        }
      }
    )

    await server.start()
    expect(pushes.length).toBeGreaterThan(0)
    expect(pushes[pushes.length - 1]).toEqual({ count: 0, autoReleaseCount: 0 })

    await server.stop(0)
  })
})
