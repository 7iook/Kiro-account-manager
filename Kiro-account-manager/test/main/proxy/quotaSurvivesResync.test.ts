// TDD:全量重同步不得抹掉已喂进池的真实额度
//
// 决策卡 §5 T-5: .agent-workspace/.archive/2026-08-09/quota-feed-to-pool/decision-card.md
//
// 缺陷形态:`addAccount` 是**重置式**(:139-152 按入参重算),而入参映射
// `toProxyAccountShared` 完全不带 quota 字段(activation.ts:101-142)⇒ 每次全量重同步
// (启动 / 改配置 / 面板 syncPool / 热切换)都把喂进去的真实额度抹回 undefined。
//
// 为什么这一格承重:它是「本轮改完、下次重启就静默失效」的那种失效点 ——
// 测试全绿、代码看着接通了,但用户实际用的时候额度数据活不过一次同步。
// 已知的重置式入池调用点:index.ts:752 / :2885 / :3530 / :6157 / :6184 + panelProxyDeps.ts:157。
import { describe, it, expect, beforeEach } from 'vitest'
import { AccountPool } from '@main/proxy/accountPool'
import type { ProxyAccount } from '@main/proxy/types'

/** 模拟盘上映射的产物:`toProxyAccountShared` 不产出任何 quota 字段 */
function fromStore(id: string, extra: Partial<ProxyAccount> = {}): ProxyAccount {
  return {
    id,
    email: `${id}@example.com`,
    accessToken: 't-' + id,
    refreshToken: 'r-' + id,
    region: 'us-east-1',
    weight: 100,
    ...extra
  }
}

describe('AccountPool · 重同步不得抹掉运行期真实额度', () => {
  let pool: AccountPool

  beforeEach(() => {
    pool = new AccountPool()
  })

  it('已在池的账号被重复 addAccount(全量同步)时,真实额度必须保留', () => {
    pool.addAccount(fromStore('A'))
    pool.updateQuota('A', 480, 500)
    expect(pool.getAccount('A')!.quotaLimit).toBe(500)

    // 全量重同步:盘上映射不带 quota 字段,原封不动再入池一次
    pool.addAccount(fromStore('A'))

    const acc = pool.getAccount('A')!
    expect(acc.quotaUsed).toBe(480)
    expect(acc.quotaLimit).toBe(500)
  })

  it('重同步后「已耗尽」的判定必须仍然成立(否则耗尽的号会被重新选中)', () => {
    pool.addAccount(fromStore('B'))
    pool.updateQuota('B', 500, 500)
    expect(pool.availableCount).toBe(0)

    pool.addAccount(fromStore('B'))

    expect(pool.isQuotaExhausted(pool.getAccount('B')!)).toBe(true)
    expect(pool.availableCount).toBe(0)
  })

  it('重同步不得抹掉额度恢复时刻与观测时刻(时序仲裁依据)', () => {
    pool.addAccount(fromStore('C'))
    const resetAt = Date.now() + 3_600_000
    const observedAt = Date.now() - 1000
    pool.updateQuota('C', 500, 500, resetAt, observedAt)

    pool.addAccount(fromStore('C'))

    const acc = pool.getAccount('C')!
    expect(acc.quotaResetAt).toBe(resetAt)
    expect(acc.quotaUpdatedAt).toBe(observedAt)
  })

  it('402 打的耗尽标记同样不得被重同步抹掉(同族运行期状态)', () => {
    pool.addAccount(fromStore('D'))
    pool.recordError('D', 0 as never, 402)
    const marked = pool.getAccount('D')!.quotaExhaustedAt
    expect(marked).toBeGreaterThan(0)

    pool.addAccount(fromStore('D'))

    expect(pool.getAccount('D')!.quotaExhaustedAt).toBe(marked)
  })

  it('启动复原场景:入参自带 quota 字段时以入参为准(不得被"保留旧值"吃掉)', () => {
    // 反向对照,证明上面的保留不是"永不接受入参" ——
    // 池里没有该账号时,入参带的额度必须原样进池。
    pool.addAccount(fromStore('E', { quotaUsed: 7, quotaLimit: 100 }))

    const acc = pool.getAccount('E')!
    expect(acc.quotaUsed).toBe(7)
    expect(acc.quotaLimit).toBe(100)
  })

  it('生产的全量重同步走 replaceAll,额度必须跨整池重建存活', () => {
    // 原先这一格断言的是「clear() 后重建则不保留」,把缺陷冻成了预期行为:
    // 生产的四个重同步点(index.ts:2902/:3546/:6200 · panelProxyDeps.ts:169)
    // 走的正是 clear→addAccount,于是「额度活不过一次同步」被测试认证为正确。
    //
    // 真实语义分两层:`clear()` 本身仍是显式的「忘掉一切」(测试 / 显式清池),
    // 但**整池重建**不是忘掉一切,它是换名单 —— 名单里仍在的号必须带着
    // 运行期状态过去。收口在 `replaceAll`(accountPool.ts),
    // 详见 poolResyncPreservesRuntime.test.ts。
    pool.addAccount(fromStore('F'))
    pool.updateQuota('F', 500, 500)

    pool.replaceAll([fromStore('F')])

    expect(pool.getAccount('F')!.quotaUsed).toBe(500)
    expect(pool.isQuotaExhausted(pool.getAccount('F')!)).toBe(true)
  })

  it('clear() 是显式的「忘掉一切」,其语义不变(不是重同步该走的路)', () => {
    pool.addAccount(fromStore('G'))
    pool.updateQuota('G', 500, 500)

    pool.clear()

    expect(pool.getAccount('G')).toBeNull()
    expect(pool.size).toBe(0)
  })
})
