// TDD:观测版本的**铸造**层(既有池测试只验「给了 t1/t2 时比较对不对」,
// 没有任何测试验「生产真的产出有意义、可区分、顺序正确的版本值」)。
//
// 决策卡 T-9: .agent-workspace/.archive/2026-08-09/quota-feed-to-pool/decision-card.md
//
// 为什么这一层必须单独测:池侧仲裁是「比较两个数」,喂它两个手写常量永远能绿 ——
// 于是「生产铸造出的值全都相等」或「时钟回跳导致后发出的值更小」这两类缺陷
// 在池测试里完全不可见。那正是本轮修的缺陷能长期存在的原因。
import { describe, it, expect } from 'vitest'
import { nextObservationVersion } from '@main/utils/observationClock'

describe('观测版本铸造 · 生产真的产出可区分且有序的值', () => {
  it('连续铸造严格单调递增(同毫秒并发也不得相等)', () => {
    // 同毫秒内的多次观测:注入同一个墙钟读数模拟「Date.now() 分辨率不足」。
    // 若实现直接返回 now,这些值会全部相等 ⇒ 顺序信息丢失,仲裁的「相等即放行」
    // 会让任意一个赢,退化成完成顺序。
    const fixedNow = 1_800_000_000_000
    const versions = [
      nextObservationVersion(fixedNow),
      nextObservationVersion(fixedNow),
      nextObservationVersion(fixedNow)
    ]

    expect(new Set(versions).size).toBe(3)
    expect(versions[1]).toBeGreaterThan(versions[0])
    expect(versions[2]).toBeGreaterThan(versions[1])
  })

  it('系统时钟回跳(NTP 校正 / 用户改表)后仍严格递增', () => {
    // 这是不能直接用 Date.now() 的核心理由:墙钟会往回跳。
    // 回跳后若照抄 now,后发出的观测会拿到更小的值 → 被当成「迟到的旧响应」丢弃,
    // 于是新数据永远写不进去 —— 恰好是仲裁本该防止的后果。
    const t = 1_900_000_000_000
    const before = nextObservationVersion(t)
    const afterJumpBack = nextObservationVersion(t - 60_000)

    expect(afterJumpBack).toBeGreaterThan(before)
  })

  it('墙钟正常前进时跟随墙钟(保持与迁移来的旧基线同量级)', () => {
    // 不能用纯计数器的理由:`quotaUpdatedAt` 会跨整池重建被迁移
    // (accountPool.mergeRuntimeState),池内可能已存在墙钟量级的旧基线。
    // 从 1 开始的计数器永远小于它 ⇒ 所有新观测被判迟到而静默全丢。
    //
    // 注:模块内的 last 是进程级的,前面的用例已把它推高。这里取「当前基线之上」的
    // 一个墙钟读数,断言实现**直接采用墙钟值本身**(而不是在旧值上 +1)。
    const baseline = nextObservationVersion()
    const future = baseline + 10_000_000
    const v = nextObservationVersion(future)

    expect(v).toBe(future)
  })
})

describe('观测版本进入池后 · 顺序判据由铸造值决定', () => {
  it('铸造顺序 = 仲裁胜负顺序(先铸造的输给后铸造的,与写入顺序无关)', async () => {
    const { AccountPool } = await import('@main/proxy/accountPool')
    const pool = new AccountPool()
    pool.addAccount({
      id: 'V',
      email: 'v@example.com',
      accessToken: 't',
      refreshToken: 'r',
      isAvailable: true
    })

    // 模拟生产的真实形态:两次观测**按发起顺序**铸造版本,
    // 然后**按相反顺序**写入池(先发出的那个后写入 —— 慢响应)。
    const vFirstIssued = nextObservationVersion()
    const vSecondIssued = nextObservationVersion()

    pool.updateQuota('V', 10, 100, undefined, vSecondIssued) // 后发出的先写
    pool.updateQuota('V', 90, 100, undefined, vFirstIssued) // 先发出的后写(迟到)

    // 后发出的观测必须留在池里 —— 迟到的旧观测被丢弃
    expect(pool.getAccount('V')!.quotaUsed).toBe(10)
    expect(pool.getAccount('V')!.quotaUpdatedAt).toBe(vSecondIssued)
  })
})
