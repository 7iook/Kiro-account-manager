// TDD:额度观测的版本戳必须表示**因果顺序**(请求发出的先后),而不是完成顺序
//
// 决策卡 T-9: .agent-workspace/.archive/2026-08-09/quota-feed-to-pool/decision-card.md
//
// 病灶:`persistCheckResult` 在**落盘时刻**才 `Date.now()` 取 observedAt,把它当作
// 「这份数据的观测时刻」喂给池。于是:
//
//   请求 A 先发出(拿到的是那一刻的额度) → 上游慢,很久才回
//   请求 B 后发出(拿到的是更新的额度)   → 上游快,先回,先落盘
//   A 最终回来时 Date.now() 更大 ⇒ 池侧仲裁认为 A「更新」⇒ 用 A 的旧数字覆盖 B 的新数字
//
// 池侧的仲裁本身是对的(`accountPool.ts:651` 比较逻辑无误)—— 错的是被比较的那个值
// 在错误的层、错误的时刻产生。
//
// 用户可感知后果:陈旧数据可以把一个还能用的号判成耗尽(→ availableCount 归零 →
// isPoolAvailable → 挂起门闸冻结请求),或者把一个真的耗尽的号复活成可用。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AccountPool } from '@main/proxy/accountPool'
import { checkAccountStatus, backgroundBatchCheck } from '@main/accountService/check'
import type { AccountRuntimeDeps } from '@main/accountService/types'
import { setStoreRef, setLastSavedDataSetter, setBroadcaster } from '@main/accountService/state'
import type { ProxyAccount } from '@main/proxy/types'

/** 手动控制解析时机的 promise —— 用来构造「先发出的后回来」 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

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

function initialBlob(ids: string[]): Record<string, unknown> {
  const accounts: Record<string, unknown> = {}
  for (const id of ids) {
    accounts[id] = {
      id,
      email: `${id}@example.com`,
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
  return { revision: 3, accounts }
}

/** 上游 GetUsageLimits 真实响应形状(ksk_ 分支只调这一个 API) */
function upstreamUsage(current: number, limit: number): unknown {
  return {
    userInfo: { email: 'a@example.com', userId: 'uid-1' },
    subscriptionInfo: { type: 'PRO', subscriptionTitle: 'Kiro Pro' },
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

function mkPoolAccount(id: string): ProxyAccount {
  return {
    id,
    email: `${id}@example.com`,
    accessToken: 't-' + id,
    refreshToken: 'r-' + id,
    isAvailable: true
  }
}

/**
 * deps 的 getUsageAndLimits 按**调用顺序**从队列取 promise ——
 * 于是「谁先发出」由调用顺序决定,「谁先回来」由测试 resolve 的顺序决定,两者可以相反。
 */
function queuedDeps(pool: AccountPool, queue: Array<Promise<unknown>>): AccountRuntimeDeps {
  return {
    proxyServer: { getAccountPool: () => pool },
    emit: () => undefined,
    api: {
      getUsageAndLimits: () => {
        const next = queue.shift()
        if (!next) throw new Error('测试队列耗尽:上游被调用的次数超出预期')
        return next
      },
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
  } as unknown as AccountRuntimeDeps
}

function accountRecord(id: string): unknown {
  return {
    id,
    email: `${id}@example.com`,
    credentials: {
      accessToken: 'ksk_static_key_value',
      authMethod: 'api_key',
      provider: 'ApiKey',
      region: 'us-east-1'
    }
  }
}

afterEach(() => {
  setBroadcaster(null)
})

describe('额度观测版本 = 因果顺序(单账号路径)', () => {
  let pool: AccountPool

  beforeEach(() => {
    setStoreRef(makeStore({ accountData: initialBlob(['acc-1']) }))
    setLastSavedDataSetter(() => undefined)
    setBroadcaster(() => undefined)
    pool = new AccountPool()
    pool.addAccount(mkPoolAccount('acc-1'))
  })

  it('先发出的慢响应不得覆盖后发出的快响应', async () => {
    // 这是缺陷的因果形态:A 先发出但慢,B 后发出但快。
    // B 拿到的是**更新**的额度事实,必须赢 —— 与谁先落盘无关。
    const dA = deferred<unknown>()
    const dB = deferred<unknown>()
    const deps = queuedDeps(pool, [dA.promise, dB.promise])

    // 发出顺序:A 先,B 后(同步调用,顺序确定)
    const pA = checkAccountStatus(deps, accountRecord('acc-1') as never)
    const pB = checkAccountStatus(deps, accountRecord('acc-1') as never)

    // 完成顺序:反过来 —— B 先回(说还剩很多),A 后回(说快用光了,但那是更早的事实)
    dB.resolve(upstreamUsage(10, 100))
    await pB
    dA.resolve(upstreamUsage(90, 100))
    await pA

    const acc = pool.getAccount('acc-1')!
    // 后发出的 B(10/100)才是较新的事实;A(90/100)是它之前的旧观测
    expect(acc.quotaUsed).toBe(10)
  })

  it('陈旧观测不得把还能用的号判成耗尽(用户可感知形态)', async () => {
    // A 先发出、上游那一刻确实是满的(100/100);B 后发出、额度已重置(0/100)。
    // A 迟到回来若能覆盖 B,这个还能用的号就被判耗尽 → availableCount 归零 →
    // isPoolAvailable false → 挂起门闸冻结请求(RCA 2026-08-04 的用户原话:
    // 「账号明明正常却被拦住」)。
    const dA = deferred<unknown>()
    const dB = deferred<unknown>()
    const deps = queuedDeps(pool, [dA.promise, dB.promise])

    const pA = checkAccountStatus(deps, accountRecord('acc-1') as never)
    const pB = checkAccountStatus(deps, accountRecord('acc-1') as never)

    dB.resolve(upstreamUsage(0, 100))
    await pB
    expect(pool.availableCount).toBe(1)

    dA.resolve(upstreamUsage(100, 100))
    await pA

    expect(pool.isQuotaExhausted(pool.getAccount('acc-1')!)).toBe(false)
    expect(pool.availableCount).toBe(1)
  })
})

describe('额度观测版本 = 因果顺序(批量路径)', () => {
  let pool: AccountPool

  beforeEach(() => {
    setStoreRef(makeStore({ accountData: initialBlob(['acc-1']) }))
    setLastSavedDataSetter(() => undefined)
    setBroadcaster(() => undefined)
    pool = new AccountPool()
    pool.addAccount(mkPoolAccount('acc-1'))
  })

  it('上一轮批量的慢响应不得覆盖下一轮批量的新数据', async () => {
    // 批量与单账号必须同源:漏了会表现成「单个刷新有序、批量刷新乱序」的诡异不一致。
    const dOld = deferred<unknown>()
    const dNew = deferred<unknown>()
    const deps = queuedDeps(pool, [dOld.promise, dNew.promise])

    // 第一轮批量先发出(慢)
    const first = backgroundBatchCheck(deps, [accountRecord('acc-1')] as never)
    // 第二轮批量后发出(快)
    const second = backgroundBatchCheck(deps, [accountRecord('acc-1')] as never)

    dNew.resolve(upstreamUsage(10, 100))
    await second
    dOld.resolve(upstreamUsage(90, 100))
    await first

    expect(pool.getAccount('acc-1')!.quotaUsed).toBe(10)
  })
})
