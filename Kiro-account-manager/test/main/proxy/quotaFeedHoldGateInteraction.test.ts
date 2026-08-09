// TDD:真实额度进池后,挂起门闸(HoldGate)的行为必须仍然合理
//
// 决策卡 §4 用例 8/9: .agent-workspace/.archive/2026-08-09/quota-feed-to-pool/decision-card.md
//
// 为什么这组是承重的:喂真实额度会让「已用光」的号从 availableCount 消失,而
// availableCount > 0 正是 HoldGate.tryResume 的放行判据(proxyServer.ts:457
// `isPoolAvailable: () => availableCount > 0` → holdGate.ts:314)。也就是说本轮改动
// **确实会改变挂起门闸何时认为池是空的** —— 这是用户可见的。
//
// 两次生产事故都是这条链上的误伤(RCA 2026-08-02 / 2026-08-04:「账号明明正常却被拦住」),
// 所以这里正反两面都钉住:
//   - 还有别的可用号 ⇒ 绝不冻结(防误伤)
//   - 真的全用光了 ⇒ 确实冻结,且不抖动、额度恢复后能自愈(这是有意的设计)
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AccountPool } from '@main/proxy/accountPool'
import { HoldGate, type HoldClock } from '@main/proxy/holdGate'
import type { ProxyAccount } from '@main/proxy/types'

/** 可控时钟(与 holdGate.test.ts 同形态,只保留本组需要的能力) */
class FakeClock implements HoldClock {
  private t = 1_000_000
  private timers: Array<{
    id: number
    due: number
    fn: () => void
    ms: number
    interval: boolean
  }> = []
  private seq = 0

  now(): number {
    return this.t
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq
    this.timers.push({ id, due: this.t + ms, fn, ms, interval: false })
    return id
  }
  clearTimeout(h: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== h)
  }
  setInterval(fn: () => void, ms: number): unknown {
    const id = ++this.seq
    this.timers.push({ id, due: this.t + ms, fn, ms, interval: true })
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
      if (++guard > 10000) throw new Error('FakeClock.advance loop guard')
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
}

function makeHooks() {
  return {
    sendPing: vi.fn(),
    resume: vi.fn(),
    sendError: vi.fn(),
    sendGracefulStop: vi.fn()
  }
}

function mk(id: string, extra: Partial<ProxyAccount> = {}): ProxyAccount {
  return {
    id,
    email: `${id}@example.com`,
    accessToken: 't-' + id,
    refreshToken: 'r-' + id,
    isAvailable: true,
    ...extra
  }
}

/** 按生产装配接线:isPoolAvailable 就是 availableCount > 0(proxyServer.ts:457) */
function wireGate(clock: FakeClock, pool: AccountPool): HoldGate {
  const gate = new HoldGate({
    clock,
    isPoolAvailable: () => pool.availableCount > 0,
    config: {
      pingIntervalMs: 10000,
      maxWaitMs: 600000,
      totalBudgetMs: 1680000,
      graceMs: 15000,
      timeoutAction: 'keep_blocking',
      autoReleaseEnabled: false,
      autoReleaseIntervalMs: 480000
    }
  })
  // 生产接线:池可用性变化 → tryResume(proxyServer.ts:462)
  pool.setAvailabilityListener(() => gate.tryResume())
  return gate
}

describe('真实额度进池 × 挂起门闸', () => {
  let clock: FakeClock
  let pool: AccountPool

  beforeEach(() => {
    clock = new FakeClock()
    pool = new AccountPool()
  })

  it('一个号额度用光但池里还有别的可用号 → 挂起中的请求立刻被放行', () => {
    // 防误伤的核心用例(RCA 2026-08-04 形态)。
    pool.addAccount(mk('A'))
    pool.addAccount(mk('B'))
    const gate = wireGate(clock, pool)
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })

    pool.updateQuota('A', 100, 100)

    // 池仍有可用号 ⇒ 放行判据成立
    expect(pool.availableCount).toBe(1)
    gate.tryResume()
    expect(hooks.resume).toHaveBeenCalledTimes(1)
  })

  it('整池额度用光 → 请求确实被冻结(设计预期,不是缺陷)', () => {
    pool.addAccount(mk('C'))
    const gate = wireGate(clock, pool)
    const hooks = makeHooks()

    pool.updateQuota('C', 100, 100)
    gate.enterHold({ receivedAt: clock.now(), hooks })
    gate.tryResume()

    expect(pool.availableCount).toBe(0)
    expect(hooks.resume).not.toHaveBeenCalled()
    expect(gate.getHeldCount()).toBe(1)
    gate.releaseAll() // 收尾,避免 timer 泄漏
  })

  it('整池用光期间反复复查不得抖动放行(不能一会儿放一会儿不放)', () => {
    pool.addAccount(mk('D1'))
    pool.addAccount(mk('D2'))
    pool.updateQuota('D1', 100, 100)
    pool.updateQuota('D2', 100, 100)
    const gate = wireGate(clock, pool)
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })

    // 兜底轮询周期性 tryResume(maxWaitMs 节奏)+ 手工复查若干次
    for (let i = 0; i < 20; i++) gate.tryResume()
    clock.advance(600000 * 2)

    expect(hooks.resume).not.toHaveBeenCalled()
    gate.releaseAll()
  })

  it('下一轮刷新发现额度已恢复 → 池自动唤醒挂起请求(无需轮询等待)', () => {
    // 这是喂池带来的正向收益:额度恢复的那一刻池就知道,监听器直接唤醒挂起请求。
    pool.addAccount(mk('E'))
    pool.updateQuota('E', 100, 100)
    const gate = wireGate(clock, pool)
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })
    expect(hooks.resume).not.toHaveBeenCalled()

    // 新一轮刷新额度:上游说还有余量
    pool.updateQuota('E', 5, 100, undefined, Date.now() + 1)

    expect(pool.availableCount).toBe(1)
    expect(hooks.resume).toHaveBeenCalledTimes(1)
  })

  it('未刷新过用量的账号(占位 0/0)绝不能让门闸误判池已空', () => {
    // 若把 limit=0 当"已用满",一池刚导入未刷新的账号会整池看起来耗尽 →
    // 门闸冻结所有请求 = 全新用户第一次用就卡住。
    pool.addAccount(mk('F1'))
    pool.addAccount(mk('F2'))
    pool.updateQuota('F1', 0, 0)
    pool.updateQuota('F2', 0, 0)
    const gate = wireGate(clock, pool)
    const hooks = makeHooks()
    gate.enterHold({ receivedAt: clock.now(), hooks })
    gate.tryResume()

    expect(pool.availableCount).toBe(2)
    expect(hooks.resume).toHaveBeenCalledTimes(1)
  })

  it('额度耗尽的挂起原因必须能自证是真实额度数据说的', () => {
    // 用户报「为什么被拦」时,后端要能答「这个号真实额度 100/100」,
    // 而不是只给一个可能误标的 markedAt。
    pool.addAccount(mk('G'))
    pool.updateQuota('G', 100, 100)

    const reasons = pool.describeBlockedAccounts()
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('quotaUsed=100/100')
  })
})
