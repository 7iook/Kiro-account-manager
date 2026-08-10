// TDD:刷新额度落盘后,真实额度必须同时进账号池
//
// 决策卡: .agent-workspace/.archive/2026-08-09/quota-feed-to-pool/decision-card.md
//
// 病灶:`accountPool.updateQuota` 零生产调用方 ⇒ 池永远不知道账号的真实余量,
// 只能靠一个 402 失败请求才知道号用光了(「每次换号先赔一个失败请求」)。
//
// 为什么喂池的收口点是**落盘层**而不是 check.ts / 主进程 tick:
//   落盘层是「刚从上游拿到真实额度」的唯一汇聚点 —— 桌面单账号检查、面板 HTTP、
//   批量检查三条路都经它。挂在这里 ⇒ 恰好一个写者。挂在别处就会出现两个不同新鲜度的
//   写者互相覆盖,而赢错一次的代价是账号被钉死到 quotaResetAt。
//
// 本测试用**真实 AccountPool**(不是 mock)——断言的是池的真实状态,不是「某函数被调用过」。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AccountPool } from '@main/proxy/accountPool'
import { checkAccountStatus, backgroundBatchCheck } from '@main/accountService/check'
import type { AccountRuntimeDeps } from '@main/accountService/types'
import {
  setStoreRef,
  setLastSavedDataSetter,
  setBroadcaster
} from '@main/accountService/state'
import type { ProxyAccount } from '@main/proxy/types'

/** in-memory electron-store 替身 */
function makeStore(initial: Record<string, unknown>): {
  get: (k: string, d?: unknown) => unknown
  set: (k: string, v: unknown) => void
  path: string
} {
  const data: Record<string, unknown> = { ...initial }
  return {
    path: '/tmp/mock-store',
    get: (k: string, d?: unknown) => (k in data ? data[k] : d),
    set: (k: string, v: unknown) => {
      data[k] = v
    }
  }
}

function initialBlob(): Record<string, unknown> {
  return {
    revision: 3,
    accounts: {
      'acc-1': {
        id: 'acc-1',
        email: 'a@example.com',
        status: 'active',
        usage: { current: 1, limit: 100, percentUsed: 0.01, lastUpdated: 1 },
        credentials: {
          accessToken: 'ksk_static_key_value',
          authMethod: 'api_key',
          provider: 'ApiKey',
          region: 'us-east-1'
        }
      }
    }
  }
}

/** 上游 GetUsageLimits 真实响应形状(ksk_ 分支只调这一个 API) */
function upstreamUsage(
  current: number,
  limit: number,
  nextDateReset?: string
): unknown {
  return {
    userInfo: { email: 'a@example.com', userId: 'uid-1' },
    subscriptionInfo: { type: 'PRO', subscriptionTitle: 'Kiro Pro' },
    nextDateReset,
    usageBreakdownList: [
      {
        resourceType: 'CREDIT',
        displayName: 'Credits',
        usageLimit: limit,
        currentUsage: current,
        currency: 'USD',
        unit: 'credit'
      }
    ]
  }
}

function mkPoolAccount(id: string, extra: Partial<ProxyAccount> = {}): ProxyAccount {
  return {
    id,
    email: `${id}@example.com`,
    accessToken: 't-' + id,
    refreshToken: 'r-' + id,
    isAvailable: true,
    ...extra
  }
}

/** 只实现 ksk_ 分支会用到的那一个 API,其余被调到就是走错分支 */
function runtimeDeps(pool: AccountPool | null, usage: unknown): AccountRuntimeDeps {
  return {
    proxyServer: pool
      ? {
          getAccountPool: () => pool
        }
      : null,
    emit: () => undefined,
    api: {
      getUsageAndLimits: async () => usage,
      getUserInfo: async () => {
        throw new Error('api_key 分支不应调 getUserInfo')
      },
      refreshTokenByMethod: async () => {
        throw new Error('不应刷新静态凭证')
      },
      fetchEnterpriseProfileArn: async () => undefined,
      readKiroAuthTokenFile: async () => null,
      writeKiroAuthTokenFile: async () => undefined,
      resolveProfileArnForWrite: () => undefined
    },
    getLastSwitchedAccountId: () => null,
    setLastSwitchedAccountId: () => undefined,
    getLastWrittenTokenSignature: () => null,
    setLastWrittenTokenSignature: () => undefined,
    isProactiveRenewalEnabled: () => false,
    scheduleProactiveRenewal: () => undefined,
    refreshInFlightIds: new Set<string>()
  }
}

const account = {
  id: 'acc-1',
  email: 'a@example.com',
  credentials: {
    accessToken: 'ksk_static_key_value',
    authMethod: 'api_key',
    provider: 'ApiKey',
    region: 'us-east-1'
  }
}

beforeEach(() => {
  setStoreRef(makeStore({ accountData: initialBlob() }))
  setLastSavedDataSetter(() => undefined)
  setBroadcaster(() => undefined)
})

afterEach(() => {
  setBroadcaster(null)
})

describe('刷新额度 → 真实额度进池(单账号路径)', () => {
  let pool: AccountPool

  beforeEach(() => {
    pool = new AccountPool()
    pool.addAccount(mkPoolAccount('acc-1'))
  })

  it('刷新成功后池里必须有真实额度数据(此前恒为 undefined)', async () => {
    const res = await checkAccountStatus(runtimeDeps(pool, upstreamUsage(42, 500)), account)
    expect(res.success).toBe(true)

    const acc = pool.getAccount('acc-1')!
    expect(acc.quotaUsed).toBe(42)
    expect(acc.quotaLimit).toBe(500)
  })

  it('额度真的用光时,池在下一个请求打过去之前就已经知道', async () => {
    // 这是本轮的用户可感知收益:此前池只能靠一个 402 失败请求才知道。
    expect(pool.availableCount).toBe(1)

    await checkAccountStatus(runtimeDeps(pool, upstreamUsage(500, 500)), account)

    expect(pool.isQuotaExhausted(pool.getAccount('acc-1')!)).toBe(true)
    expect(pool.availableCount).toBe(0)
    // 日志能自证结论基于真实额度数据,而不是一个可能误标的标记
    expect(pool.describeBlockedAccounts()[0]).toContain('quotaUsed=500/500')
  })

  it('上游给了下次重置时刻 → 按 epoch ms 进池(盘上是 ISO string)', async () => {
    const iso = '2026-09-01T00:00:00.000Z'
    await checkAccountStatus(runtimeDeps(pool, upstreamUsage(500, 500, iso)), account)

    expect(pool.getAccount('acc-1')!.quotaResetAt).toBe(new Date(iso).getTime())
  })

  it('上游没给重置时刻 → 不得抹掉池里既有的值', async () => {
    pool.updateQuota('acc-1', 10, 100, 4_000_000_000_000)
    await checkAccountStatus(runtimeDeps(pool, upstreamUsage(50, 100)), account)

    expect(pool.getAccount('acc-1')!.quotaResetAt).toBe(4_000_000_000_000)
  })

  it('反代未运行(proxyServer=null)时刷新照旧成功,不得抛错', async () => {
    const res = await checkAccountStatus(runtimeDeps(null, upstreamUsage(42, 500)), account)
    expect(res.success).toBe(true)
  })

  it('账号不在池里(未启用多账号 / 已被移出)时刷新照旧成功', async () => {
    const empty = new AccountPool()
    const res = await checkAccountStatus(runtimeDeps(empty, upstreamUsage(42, 500)), account)
    expect(res.success).toBe(true)
    expect(empty.getAccount('acc-1')).toBeNull()
  })

  it('喂池抛异常不得让「刷新额度」失败(额度已落盘是既成事实)', async () => {
    const throwing = new AccountPool()
    throwing.addAccount(mkPoolAccount('acc-1'))
    throwing.updateQuota = () => {
      throw new Error('boom')
    }

    const res = await checkAccountStatus(runtimeDeps(throwing, upstreamUsage(42, 500)), account)
    expect(res.success).toBe(true)
  })
})

describe('批量刷新额度 → 真实额度同样进池', () => {
  let pool: AccountPool

  beforeEach(() => {
    pool = new AccountPool()
    pool.addAccount(mkPoolAccount('acc-1'))
  })

  it('批量路径漏了喂池会表现成「单个刷新有效、批量刷新无效」的诡异不一致', async () => {
    await backgroundBatchCheck(runtimeDeps(pool, upstreamUsage(77, 500)), [
      {
        id: 'acc-1',
        email: 'a@example.com',
        credentials: {
          accessToken: 'ksk_static_key_value',
          authMethod: 'api_key',
          provider: 'ApiKey',
          region: 'us-east-1'
        }
      }
    ] as never)

    const acc = pool.getAccount('acc-1')!
    expect(acc.quotaUsed).toBe(77)
    expect(acc.quotaLimit).toBe(500)
  })
})
