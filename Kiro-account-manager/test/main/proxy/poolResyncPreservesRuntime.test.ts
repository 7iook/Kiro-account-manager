// TDD:整池重建(clear→addAccount)不得抹掉运行期状态
//
// 决策卡 §5 T-5: .agent-workspace/.archive/2026-08-09/quota-feed-to-pool/decision-card.md
//
// ## 缺陷形态(与 quotaSurvivesResync.test.ts 的分工)
//
// 那个文件测的是**不清池**的重复 addAccount —— `prev ??` 保留法在那条路上成立。
// 但生产的四个全量重同步点走的是 `clear()` **然后** `addAccount()`:
//   index.ts:2902(自启动) · :3546(replace 热替换) · :6200(proxy-sync-accounts IPC)
//   panelProxyDeps.ts:169(面板 syncPool)
// `clear()`(accountPool.ts:755-759)把 `accounts` 整个清空 ⇒ addAccount 里的
// `this.accounts.get(id)` 必然是 undefined ⇒ `prev ??` 结构上已经无源可读。
//
// 用户可感知后果:面板点一次「同步池」/ 改一次配置 / 重启一次,
// 刚喂进池的真实额度与 402 打的耗尽标记一起消失 ⇒ 已耗尽的号重新进入轮询,
// 且挂起门闸的「池是不是空了」判据从一份被抹干净的状态上算出来。
//
// ## 为什么在这一层测
//
// 承重的那一格是 `syncPool`(panelProxyDeps.ts:161-172)—— 它是四个调用点里
// 唯一能在 vitest 里不拖 electron 跑起来的**真实生产代码**,注入的是真实
// `AccountPool` 而非替身。只测 pool 原语会得到「原语正确但生产路径没接上」(P-01 形态)。
import { describe, it, expect, beforeEach } from 'vitest'
import { AccountPool } from '@main/proxy/accountPool'
import { buildPanelProxyDeps, type ProxyServerRef } from '@main/ipc/panelProxyDeps'
import type { ProxyAccount, ProxyConfig } from '@main/proxy/types'

/** 盘上形状的账号记录(`accountData.accounts` 的一条) */
function storeRecord(id: string): Record<string, unknown> {
  return {
    id,
    email: `${id}@example.com`,
    status: 'active',
    credentials: { accessToken: 't-' + id, refreshToken: 'r-' + id, region: 'us-east-1' }
  }
}

/** 直接映射产物(给不经 store 的调用点用) */
function fromStore(id: string, extra: Partial<ProxyAccount> = {}): ProxyAccount {
  return { id, email: `${id}@example.com`, accessToken: 't-' + id, refreshToken: 'r-' + id, region: 'us-east-1', weight: 100, ...extra }
}

describe('整池重建(clear→add)必须迁移运行期状态', () => {
  let pool: AccountPool

  beforeEach(() => {
    pool = new AccountPool()
  })

  // ---- 生产路径:面板 syncPool(真实 buildPanelProxyDeps + 真实 AccountPool)----
  it('面板 syncPool 重建整池后,喂进去的真实额度仍在', async () => {
    const records = { A: storeRecord('A'), B: storeRecord('B') }
    const ref: ProxyServerRef = {
      isRunning: () => true,
      getAccountPool: () => pool,
      getConfig: () => ({ port: 5580, enableMultiAccount: true, selectedAccountIds: [] }) as unknown as ProxyConfig,
      updateConfig: () => undefined,
      invalidateSessionAffinity: () => 0,
      start: async () => undefined,
      stop: async () => undefined,
      getStats: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0 }),
      getHoldAutoReleaseState: () => ({ autoReleaseEnabled: false, nextAutoReleaseAt: null, autoReleaseCount: 0 }),
      getHeldRequestsInfo: () => ({ count: 0, autoReleaseEnabled: false, nextAutoReleaseAt: null, autoReleaseCount: 0, currentEpisode: null, recentEpisodes: [] }),
      releaseHeldRequests: () => 0
    }
    const deps = buildPanelProxyDeps({
      getProxyServer: () => ref,
      initProxyServer: () => ref,
      loadAccountData: () => ({ accounts: records }),
      persistProxyConfig: () => undefined
    })

    // 首次同步入池,然后喂真实额度(模拟 persistCheckResult 的落盘收口)
    await deps.proxySyncPool()
    pool.updateQuota('A', 480, 500)
    pool.updateQuota('B', 500, 500)
    expect(pool.getAccount('B')!.quotaLimit).toBe(500)

    // 用户在面板上再点一次「同步池」—— 盘上记录不带任何 quota 字段
    await deps.proxySyncPool()

    const a = pool.getAccount('A')!
    expect(a.quotaUsed).toBe(480)
    expect(a.quotaLimit).toBe(500)
    // 承重判据:已耗尽的号重建后仍判为耗尽,否则它会重新进入轮询
    expect(pool.isQuotaExhausted(pool.getAccount('B')!)).toBe(true)
  })

  it('面板 syncPool 重建后,402 打的耗尽标记与恢复时刻仍在', async () => {
    const records = { C: storeRecord('C') }
    const ref = {
      isRunning: () => true,
      getAccountPool: () => pool,
      getConfig: () => ({ port: 5580, selectedAccountIds: [] }) as unknown as ProxyConfig,
      updateConfig: () => undefined,
      invalidateSessionAffinity: () => 0,
      start: async () => undefined,
      stop: async () => undefined,
      getStats: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0 }),
      getHoldAutoReleaseState: () => ({ autoReleaseEnabled: false, nextAutoReleaseAt: null, autoReleaseCount: 0 }),
      getHeldRequestsInfo: () => ({ count: 0, autoReleaseEnabled: false, nextAutoReleaseAt: null, autoReleaseCount: 0, currentEpisode: null, recentEpisodes: [] }),
      releaseHeldRequests: () => 0
    } as ProxyServerRef
    const deps = buildPanelProxyDeps({
      getProxyServer: () => ref,
      initProxyServer: () => ref,
      loadAccountData: () => ({ accounts: records }),
      persistProxyConfig: () => undefined
    })

    await deps.proxySyncPool()
    pool.recordError('C', 0 as never, 402)
    const marked = pool.getAccount('C')!.quotaExhaustedAt
    const resetAt = pool.getAccount('C')!.quotaResetAt
    expect(marked).toBeGreaterThan(0)

    await deps.proxySyncPool()

    expect(pool.getAccount('C')!.quotaExhaustedAt).toBe(marked)
    // quotaResetAt 是唯一的自动恢复时刻,抹掉它 = 该号到点永不自愈
    expect(pool.getAccount('C')!.quotaResetAt).toBe(resetAt)
  })

  // ---- 池原语:replaceAll 的语义(四个调用点共用的收口)----
  it('replaceAll 迁移额度状态,不需要调用方各自记得保留', () => {
    pool.addAccount(fromStore('A'))
    pool.updateQuota('A', 480, 500, Date.now() + 3_600_000, Date.now() - 1000)
    const before = pool.getAccount('A')!

    pool.replaceAll([fromStore('A'), fromStore('B')])

    const a = pool.getAccount('A')!
    expect(a.quotaUsed).toBe(480)
    expect(a.quotaLimit).toBe(500)
    expect(a.quotaResetAt).toBe(before.quotaResetAt)
    expect(a.quotaUpdatedAt).toBe(before.quotaUpdatedAt)
    expect(pool.size).toBe(2)
  })

  it('replaceAll 不得静默解除运行期风控挂起(hot-swap 危害不得重开)', () => {
    // RCA §4.2b(.archive/2026-07-28/proxy-hot-switch-single-account/):
    // 重置式入池会按入参重算 isAvailable,而盘上映射不带 suspendedAt ⇒ 算出 true,
    // 于是「同步一下池」就把需要人工解封的号放回轮询。
    pool.addAccount(fromStore('S'))
    pool.markSuspended('S', 'TEMPORARILY_SUSPENDED', '联系 AWS Support')
    expect(pool.availableCount).toBe(0)

    pool.replaceAll([fromStore('S')])

    const s = pool.getAccount('S')!
    expect(s.suspendedAt).toBe(pool.isSuspended(s) ? s.suspendedAt : -1)
    expect(pool.isSuspended(s)).toBe(true)
    expect(s.suspendReason).toBe('TEMPORARILY_SUSPENDED')
    expect(s.isAvailable).toBe(false)
    expect(pool.availableCount).toBe(0)
  })

  it('replaceAll 迁移断路器计数与冷却(否则重同步 = 免费清零重试预算)', () => {
    pool.addAccount(fromStore('E'))
    pool.recordError('E', 0 as never, 500)
    pool.recordError('E', 0 as never, 500)
    const before = pool.getAccount('E')!
    expect(before.errorCount).toBe(2)

    pool.replaceAll([fromStore('E')])

    const e = pool.getAccount('E')!
    expect(e.errorCount).toBe(2)
    expect(e.lastUsed).toBe(before.lastUsed)
  })

  it('replaceAll 以入参为准做增删:不在新名单里的号必须离池', () => {
    pool.addAccount(fromStore('A'))
    pool.addAccount(fromStore('B'))
    pool.updateQuota('A', 10, 500)

    pool.replaceAll([fromStore('A'), fromStore('C')])

    expect(pool.getAccount('B')).toBeNull()
    expect(pool.getAccount('C')).not.toBeNull()
    expect(pool.getAccount('A')!.quotaUsed).toBe(10)
    expect(pool.size).toBe(2)
  })

  it('replaceAll 入参自带 quota 时以入参为准(盘上权威值不被旧值吃掉)', () => {
    pool.addAccount(fromStore('A'))
    pool.updateQuota('A', 480, 500)

    // 启动复原:入参自带盘上的权威额度
    pool.replaceAll([fromStore('A', { quotaUsed: 7, quotaLimit: 100 })])

    const a = pool.getAccount('A')!
    expect(a.quotaUsed).toBe(7)
    expect(a.quotaLimit).toBe(100)
  })

  it('replaceAll 让池从全挂→有可用号时,通知挂起门闸', () => {
    let notified = 0
    pool.addAccount(fromStore('X'))
    pool.updateQuota('X', 500, 500) // 全池耗尽
    expect(pool.availableCount).toBe(0)
    pool.setAvailabilityListener(() => { notified++ })

    // 新号入池 ⇒ 0→1,必须唤醒门闸(否则挂起的请求要等到下一次请求才被放行)
    pool.replaceAll([fromStore('X'), fromStore('FRESH')])

    expect(pool.availableCount).toBe(1)
    expect(notified).toBe(1)
  })
})
