// TDD:updateQuota 不得抹掉既有的额度恢复时刻(quotaResetAt)
//
// 侦察: .agent-workspace/.archive/2026-08-09/headless-server-migration/recon-quota-feed-break.md §A3
//
// 缺陷形态(读码判定,由本用例证伪):
//   updateQuota 无条件写 `quotaResetAt: resetAt` —— 调用方拿不到上游 nextResetDate 时
//   按现签名调 updateQuota(id, used, limit) 就会把已有值抹成 undefined。
//
// 为什么这一格是承重的:
//   quotaResetAt 是 isQuotaExhausted 的**第一条**判据(accountPool.ts:410
//   「过了重置时间就不再算耗尽」,先于 quotaExhaustedAt / quotaUsed>=quotaLimit 求值),
//   也是 recordError 在 402 时按 quotaResetMs(1h)写入的**唯一自动恢复时刻**。
//   抹掉它 = 该账号退化成「只能靠 used<limit 或人工 reset 恢复」,时间到点永不自愈。
//
// 判定它是缺陷而非有意设计的同文件证据:
//   - recordSuccess(:507) 注释明写「quotaResetAt:上游给的真实配额重置时刻,**保留**
//     供 isQuotaExhausted 第一条判据用」,并刻意不动该字段;
//   - recordError(:578-581) 只在「没有更明确的重置时间,或已过期」时才顺延,同样不覆盖;
//   - updateAccount 的 AVAILABILITY_FIELDS(:182) 把 quotaResetAt 列为需保护的可用性字段。
//   → 无条件覆盖与同文件三处既定约定相矛盾。
import { describe, it, expect, beforeEach } from 'vitest'
import { AccountPool, ErrorType } from '@main/proxy/accountPool'
import type { ProxyAccount } from '@main/proxy/types'

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

describe('AccountPool.updateQuota · 不得抹掉额度恢复时刻', () => {
  let pool: AccountPool

  beforeEach(() => {
    pool = new AccountPool()
  })

  it('不传 resetAt 时必须保留 402 设好的自动恢复时刻', () => {
    pool.addAccount(mk('A'))
    // 走真实的 402 路径造出耗尽态 —— 这是生产中唯一点亮 quotaExhaustedAt 的入口
    pool.recordError('A', ErrorType.RECOVERABLE, 402)
    const resetAtBefore = pool.getAccount('A')!.quotaResetAt
    expect(resetAtBefore).toBeGreaterThan(Date.now())

    // 调用方只拿到 used/limit(上游 nextResetDate 缺失),按现签名调用
    pool.updateQuota('A', 100, 100)

    expect(pool.getAccount('A')!.quotaResetAt).toBe(resetAtBefore)
  })

  it('恢复时刻到点后账号必须自愈(抹掉 resetAt 会让它永久耗尽)', () => {
    pool.addAccount(mk('B'))
    pool.recordError('B', ErrorType.RECOVERABLE, 402)
    const resetAt = pool.getAccount('B')!.quotaResetAt!

    // 真实额度数据仍显示用尽 → quotaExhaustedAt 不被清除,只能靠第一条判据恢复
    pool.updateQuota('B', 100, 100)

    const acc = pool.getAccount('B')!
    expect(pool.isQuotaExhausted(acc, resetAt - 1)).toBe(true)
    // 过了恢复时刻 → 第一条判据放行。resetAt 被抹成 undefined 时这里会是 true
    expect(pool.isQuotaExhausted(acc, resetAt + 1)).toBe(false)
    // 挂起门闸(HoldGate)的权威判据同步自愈,否则用户看到「等了一小时还是被拦」
    expect(pool.hasBlockedAccount(resetAt + 1)).toBe(false)
  })

  it('显式传 resetAt 时必须以上游权威值为准(既有行为,不得回退)', () => {
    pool.addAccount(mk('C'))
    pool.recordError('C', ErrorType.RECOVERABLE, 402)
    const upstreamResetAt = Date.now() + 7_200_000 // 上游说 2 小时后重置

    pool.updateQuota('C', 100, 100, upstreamResetAt)

    expect(pool.getAccount('C')!.quotaResetAt).toBe(upstreamResetAt)
  })

  it('账号本无 resetAt 且调用方也不传 → 保持 undefined(不得凭空造值)', () => {
    pool.addAccount(mk('D'))
    pool.updateQuota('D', 10, 100)
    expect(pool.getAccount('D')!.quotaResetAt).toBeUndefined()
  })
})
