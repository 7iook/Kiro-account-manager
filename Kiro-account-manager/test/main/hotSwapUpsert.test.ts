// TDD 红灯:反代运行中切换账号(单账号模式)· RCA §7
// .agent-workspace/.archive/2026-07-28/proxy-hot-switch-single-account/
//
// 缺陷 1(RCA §4.2b):proxy-update-pool-members 的 add 分支无条件走 addAccount(重置式),
//   而 addAccount 按不含 suspendedAt 的入参重算 isAvailable=true 并清零 errorCount/统计
//   ⇒ 每次切换静默解除运行期风控封禁,且让 ACCOUNT_NOT_AVAILABLE 守卫永不触发。
// 缺陷 2(RCA §1.5 假设 D):显式换账号时不失效会话粘性 ⇒ 开了 sessionAffinity 的用户
//   即使接线正确仍需重启服务才生效。
import { describe, it, expect, beforeEach } from 'vitest'
import { AccountPool } from '@main/proxy/accountPool'
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

describe('AccountPool · upsertAccount(热切换入池不得洗掉运行期状态)', () => {
  let pool: AccountPool

  beforeEach(() => {
    pool = new AccountPool()
  })

  it('不在池 → 等价 addAccount,返回 added', () => {
    expect(pool.upsertAccount(mk('A'))).toBe('added')
    expect(pool.getAccount('A')?.accessToken).toBe('t-A')
    expect(pool.size).toBe(1)
  })

  it('已在池 → 只覆盖凭据,返回 updated', () => {
    pool.addAccount(mk('A'))
    expect(pool.upsertAccount(mk('A', { accessToken: 't-A-v2', refreshToken: 'r-A-v2' }))).toBe('updated')
    const acc = pool.getAccount('A')
    expect(acc?.accessToken).toBe('t-A-v2')
    expect(acc?.refreshToken).toBe('r-A-v2')
    expect(pool.size).toBe(1)
  })

  it('已在池且被封禁 → 保留 suspendedAt / isAvailable=false(不得静默解封)', () => {
    pool.addAccount(mk('A', { suspendedAt: 1700000000000, suspendReason: 'TEMPORARILY_SUSPENDED' }))
    expect(pool.getAccount('A')?.isAvailable).toBe(false)

    // 模拟前端 mapper:不携带 suspendedAt / isAvailable 字段
    pool.upsertAccount({
      id: 'A',
      email: 'A@example.com',
      accessToken: 't-A-v2',
      refreshToken: 'r-A-v2'
    } as ProxyAccount)

    const acc = pool.getAccount('A')
    expect(acc?.accessToken).toBe('t-A-v2')
    expect(acc?.suspendedAt).toBe(1700000000000)
    expect(acc?.suspendReason).toBe('TEMPORARILY_SUSPENDED')
    expect(acc?.isAvailable).toBe(false)
    expect(pool.isSuspended(acc!)).toBe(true)
  })

  it('已在池 → 保留 errorCount / requestCount / lastUsed(不清零断路器与统计)', () => {
    pool.addAccount(mk('A'))
    pool.recordSuccess('A', 100)
    pool.updateAccount('A', { errorCount: 3, requestCount: 7, lastUsed: 123456 })

    pool.upsertAccount(mk('A', { accessToken: 't-A-v2' }))

    const acc = pool.getAccount('A')
    expect(acc?.errorCount).toBe(3)
    expect(acc?.requestCount).toBe(7)
    expect(acc?.lastUsed).toBe(123456)
    // 统计也不得被清零
    expect(pool.getStats().accounts.get('A')?.requests).toBe(1)
  })
})
