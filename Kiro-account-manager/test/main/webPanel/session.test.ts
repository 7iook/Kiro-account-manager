/**
 * 会话过期机制（绝对 24h + 空闲 2h）。
 *
 * 断言的是**可观测行为**：`validate()` 返回值与 `activeCount`，
 * 而非「内部有没有调某个方法」。时钟注入让时间推进确定可控，不用真等 24 小时。
 */
import { describe, it, expect } from 'vitest'
import { PanelSessionStore, ABSOLUTE_TTL_MS, IDLE_TTL_MS } from '../../../src/main/webPanel/session'

/** 可推进的假时钟 */
function fakeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms: number) => void (t += ms) }
}

describe('会话过期', () => {
  it('新签发的会话立即可用', () => {
    const store = new PanelSessionStore()
    const sid = store.create()
    expect(store.validate(sid)).toBe(true)
  })

  it('不存在的 / 空的 sid 被拒', () => {
    const store = new PanelSessionStore()
    store.create()
    expect(store.validate('never-issued')).toBe(false)
    expect(store.validate(undefined)).toBe(false)
    expect(store.validate('')).toBe(false)
    expect(store.validate(null)).toBe(false)
  })

  it('会话 id 不可预测且互不相同（256 bit 随机，非 uuid 格式）', () => {
    const store = new PanelSessionStore()
    const ids = new Set<string>()
    for (let i = 0; i < 200; i++) ids.add(store.create())
    expect(ids.size).toBe(200)
    for (const id of ids) {
      // base64url 43 字符 = 32 字节；且不得是 uuid 的 8-4-4-4-12 形态
      expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(id).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
    }
  })

  it('空闲超过 2h 的会话被拒（即便未达绝对过期）', () => {
    const clock = fakeClock()
    const store = new PanelSessionStore({ now: clock.now })
    const sid = store.create()

    // 差 1ms 到空闲上限 → 仍有效
    clock.advance(IDLE_TTL_MS - 1)
    expect(store.validate(sid)).toBe(true)

    // 上一次 validate 已续期，再等满 2h → 空闲过期
    clock.advance(IDLE_TTL_MS)
    expect(store.validate(sid)).toBe(false)
  })

  it('持续活跃可无限续期，但绝对 24h 一到即被拒', () => {
    const clock = fakeClock()
    const store = new PanelSessionStore({ now: clock.now })
    const sid = store.create()

    // 每小时活跃一次，23 次 → 空闲永不触发，绝对期限未到
    for (let h = 1; h <= 23; h++) {
      clock.advance(60 * 60 * 1000)
      expect(store.validate(sid), `第 ${h} 小时应仍有效（滑动续期）`).toBe(true)
    }

    // 再过 1 小时 → 满 24h 绝对过期，尽管刚刚才活跃过
    clock.advance(60 * 60 * 1000)
    expect(store.validate(sid), '绝对过期不受活跃影响').toBe(false)
  })

  it('绝对过期基准是创建时刻，不被 validate 续期推后（1ms 精度）', () => {
    const clock = fakeClock()
    const store = new PanelSessionStore({ now: clock.now })
    const sid = store.create()

    // 每小时活跃一次到 23h —— 保证空闲计时器一直被重置，排除空闲过期这个干扰因素
    for (let h = 0; h < 23; h++) {
      clock.advance(60 * 60 * 1000)
      expect(store.validate(sid)).toBe(true)
    }
    // 再推进到距创建满 24h 差 1ms（空闲仅 1h 不到，不会触发空闲过期）
    clock.advance(60 * 60 * 1000 - 1)
    expect(store.validate(sid), '差 1ms 未满 24h 应仍有效').toBe(true)

    // 跨过那 1ms：绝对过期立刻生效，尽管刚刚才活跃过
    clock.advance(1)
    expect(store.validate(sid), '满 24h 即失效，续期不推后绝对期限').toBe(false)
  })

  it('过期会话被即时移除，不残留占位', () => {
    const clock = fakeClock()
    const store = new PanelSessionStore({ now: clock.now })
    const sid = store.create()
    expect(store.activeCount).toBe(1)
    clock.advance(IDLE_TTL_MS)
    expect(store.validate(sid)).toBe(false)
    expect(store.activeCount).toBe(0)
  })

  it('sweep 清掉过期会话、保留活跃会话', () => {
    const clock = fakeClock()
    const store = new PanelSessionStore({ now: clock.now })
    const stale = store.create()
    clock.advance(IDLE_TTL_MS + 1)
    const fresh = store.create()
    expect(store.activeCount).toBe(2)

    store.sweep()

    expect(store.activeCount).toBe(1)
    expect(store.validate(stale)).toBe(false)
    expect(store.validate(fresh)).toBe(true)
  })

  it('destroy 使该会话立即失效，且不影响其它会话', () => {
    const store = new PanelSessionStore()
    const a = store.create()
    const b = store.create()
    expect(store.destroy(a)).toBe(true)
    expect(store.validate(a)).toBe(false)
    expect(store.validate(b)).toBe(true)
    // 重复销毁不抛错，返回 false
    expect(store.destroy(a)).toBe(false)
  })

  it('周期清扫真的会清掉过期会话（timer 已接线，非空转）', async () => {
    const clock = fakeClock()
    const store = new PanelSessionStore({ now: clock.now })
    const sid = store.create()
    expect(store.activeCount).toBe(1)

    store.startSweeping(5)
    // 推进假时钟使会话过期，再等真实 timer 触发一次
    clock.advance(IDLE_TTL_MS + 1)
    await new Promise((r) => setTimeout(r, 40))
    store.stopSweeping()

    expect(store.activeCount, 'setInterval 应真的调到 sweep()').toBe(0)
    expect(store.validate(sid)).toBe(false)
  })

  it('清扫 timer 不阻塞 Node 退出（unref）且 startSweeping 幂等', () => {
    const store = new PanelSessionStore()
    store.startSweeping(1000)
    // 幂等：重复调用不叠加 timer（否则 stopSweeping 只清掉最后一个，前者泄漏）
    store.startSweeping(1000)
    store.stopSweeping()

    // 直接断言 unref 语义：unref 过的 timer 不计入 event loop ref 计数
    const probe = new PanelSessionStore()
    probe.startSweeping(1000)
    const timer = (probe as unknown as { sweepTimer: { hasRef?: () => boolean } }).sweepTimer
    expect(timer, 'startSweeping 后应存在 timer').toBeTruthy()
    // Node 的 Timeout.hasRef()：unref 后为 false
    expect(timer.hasRef?.(), 'timer 必须已 unref，否则应用退不出去').toBe(false)
    probe.stopSweeping()
  })
})
