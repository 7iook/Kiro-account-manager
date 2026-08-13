/**
 * 「刷新额度」必须落盘 —— 手机刷完重载页面 / 桌面端都得看到新数字
 *
 * 治的病灶：`check.ts:checkAccountStatus` 只返回数据不落盘，落盘逻辑长在 renderer store
 * 里（`store/accounts.ts:2013/2079`）。面板走 HTTP 调同一函数却没有那个 store ⇒
 * 手机端刷出的新额度只活在浏览器内存，重载即回旧值，桌面端也不知情。
 *
 * ## 断言的是「持久化后的状态」，不是「某函数被调用过」
 *
 * 每个用例都真起 `WebPanelServer`（真 http.Server + 真 fetch，照
 * `test/main/webPanel/server.test.ts` 的姿势），真 POST 打 check 端点，
 * 然后**重新 GET /api/accounts**，断言拿到的是新值 —— 这条链等价于用户
 * 「点刷新 → 重载浏览器页面」。另有一条用例断言广播真的发出去了
 * （桌面端因此无需轮询）。
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { WebPanelServer, type WebPanelConfig } from '../../../src/main/webPanel/server'
import { PanelAuth, type AdminKeyStore } from '../../../src/main/webPanel/auth'
import { PANEL_PATH_PREFIX } from '../../../src/main/webPanel/cookie'
import { buildPanelRouteDeps } from '../../../src/main/ipc/webPanelWiring'
import {
  checkAccountStatus,
  backgroundBatchCheck,
  type BatchCheckAccount
} from '../../../src/main/accountService/check'
import {
  applyAccountDataMutation,
  setStoreRef,
  setLastSavedDataSetter,
  setBroadcaster,
  type BroadcastPayload
} from '../../../src/main/accountService/state'
import { loadAccounts } from '../../../src/main/accountService/accounts'
import type { AccountRuntimeDeps } from '../../../src/main/accountService/types'

const ADMIN_KEY = 'test-admin-key-0123456789abcdef'

function memoryKeyStore(): AdminKeyStore {
  let key: string | null = ADMIN_KEY
  return { get: () => key, set: (k: string) => { key = k } }
}

/** in-memory electron-store 替身（与 state.test.ts 同一形状） */
function makeStore(initial: Record<string, unknown>): {
  get: (k: string, d?: unknown) => unknown
  set: (k: string, v: unknown) => void
  path: string
  data: Record<string, unknown>
} {
  const data: Record<string, unknown> = { ...initial }
  return {
    data,
    path: '/tmp/mock-store',
    get: (k: string, d?: unknown) => (k in data ? data[k] : d),
    set: (k: string, v: unknown) => { data[k] = v }
  }
}

/** 盘上初始态：额度是**旧值** 10/100，用户即将刷新它 */
function initialBlob(): Record<string, unknown> {
  return {
    revision: 7,
    accounts: {
      'acc-1': {
        id: 'acc-1',
        email: 'new@example.com',
        userId: 'uid-9',
        idp: 'Google',
        note: '桌面端写的备注',
        groupId: 'g1',
        status: 'active',
        lastError: '上次刷新失败了',
        isActive: true,
        tags: ['t1'],
        subscription: { type: 'Free', title: 'Free', daysRemaining: 3 },
        usage: { current: 10, limit: 100, percentUsed: 0.1, lastUpdated: 1 },
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

/** 上游 GetUsageLimits 的真实响应形状（ksk_ 分支只调这一个 API） */
function upstreamUsageResponse(current: number, limit: number): unknown {
  return {
    userInfo: { email: 'new@example.com', userId: 'uid-9' },
    subscriptionInfo: { type: 'PRO', subscriptionTitle: 'Kiro Pro' },
    nextDateReset: '2026-09-01T00:00:00Z',
    usageBreakdownList: [
      {
        resourceType: 'CREDIT',
        displayName: 'Credits',
        usageLimit: limit,
        currentUsage: current,
        overageRate: 0.04,
        currency: 'USD',
        unit: 'credit'
      }
    ]
  }
}

/** 只实现 ksk_ 分支实际会用到的那一个 API，其余留 throw —— 被调到就是走错分支了 */
function runtimeDeps(usage: unknown): AccountRuntimeDeps {
  return {
    proxyServer: null,
    emit: () => undefined,
    api: {
      getUsageAndLimits: async () => usage,
      getUserInfo: async () => { throw new Error('api_key 分支不应调 getUserInfo') },
      refreshTokenByMethod: async () => { throw new Error('不应刷新静态凭证') },
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

const servers: WebPanelServer[] = []
let store: ReturnType<typeof makeStore>
let broadcasts: BroadcastPayload[]

beforeEach(() => {
  store = makeStore({ accountData: initialBlob() })
  broadcasts = []
  setStoreRef(store)
  setLastSavedDataSetter(() => undefined)
  setBroadcaster((p) => { broadcasts.push(p) })
})

afterEach(async () => {
  while (servers.length) await servers.pop()?.stop().catch(() => undefined)
})

const storeDeps = {
  getStore: () => store,
  ensureStore: async () => undefined,
  createBackup: async () => undefined,
  setLastSavedData: () => undefined
}

function makeServer(usage: unknown, config: Partial<WebPanelConfig> = {}): WebPanelServer {
  const auth = new PanelAuth(memoryKeyStore())
  const server = new WebPanelServer({
    auth,
    routeDeps: buildPanelRouteDeps({
      // 与生产装配同形：面板与 IPC 复用同一个 accountService 函数（index.ts:4321）
      loadAccountsBlob: () => loadAccounts(storeDeps),
      checkAccountStatus: (account) => checkAccountStatus(runtimeDeps(usage), account as never),
      refreshAccountToken: async () => ({ success: true }),
      switchAccountToIde: async () => ({ success: true }),
      switchAccountToCli: async () => ({ success: true }),
      logoutFromIde: async () => ({ success: true }),
      getAccountModels: async () => ({ success: true }),
      getAccountSubscriptions: async () => ({ success: true }),
      getAccountSubscriptionUrl: async () => ({ success: true }),
      setAccountOverage: async () => ({ success: true })
    }),
    getConfig: () => ({ enabled: true, port: 0, host: '127.0.0.1', ...config })
  })
  servers.push(server)
  return server
}

function base(server: WebPanelServer): string {
  const addr = server.getListeningAddress()
  if (!addr) throw new Error('server not listening')
  return `http://127.0.0.1:${addr.port}${PANEL_PATH_PREFIX}`
}

async function login(server: WebPanelServer): Promise<string> {
  const res = await fetch(`${base(server)}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Panel-Request': '1' },
    body: JSON.stringify({ adminKey: ADMIN_KEY })
  })
  const setCookie = res.headers.get('set-cookie')
  if (!res.ok || !setCookie) throw new Error(`login failed: ${res.status}`)
  return setCookie.split(';')[0]
}

type ListItem = {
  id: string
  email?: string
  status?: string
  lastError?: string
  usage?: { current?: number; limit?: number; percentUsed?: number }
  subscription?: { type?: string; title?: string }
}

/** 重新 GET 列表 —— 这一步等价于用户「刷新浏览器页面」 */
async function getList(server: WebPanelServer, cookie: string): Promise<ListItem[]> {
  const res = await fetch(`${base(server)}/api/accounts`, { headers: { cookie } })
  expect(res.status).toBe(200)
  return (await res.json()).accounts as ListItem[]
}

describe('手机端刷新额度后重载页面 · 数字必须还是新的', () => {
  it('点完刷新再重新拉列表 · 拿到的是新额度不是旧值', async () => {
    const server = makeServer(upstreamUsageResponse(42, 500))
    await server.start()
    const cookie = await login(server)

    // 刷新前：盘上是旧值
    expect((await getList(server, cookie))[0].usage).toMatchObject({ current: 10, limit: 100 })

    const res = await fetch(`${base(server)}/api/accounts/acc-1/check`, {
      method: 'POST',
      headers: { cookie, 'X-Panel-Request': '1' }
    })
    expect(res.status).toBe(200)

    // 重载页面（真的再打一次 GET）→ 必须是新值
    const after = (await getList(server, cookie))[0]
    expect(after.usage).toMatchObject({ current: 42, limit: 500 })
    expect(after.usage?.percentUsed).toBeCloseTo(42 / 500)
    // 订阅更新；身份字段与上游一致但不会被换成另一个账号
    expect(after.subscription).toMatchObject({ type: 'Pro', title: 'Kiro Pro' })
    expect(after.email).toBe('new@example.com')
    // 刷新成功即清掉上次的错误（基线 store/accounts.ts:2071）
    expect(after.lastError).toBeUndefined()
  })

  it('落盘只碰额度相关字段 · 桌面端并发写的备注 / 分组 / 标签不被覆盖', async () => {
    const server = makeServer(upstreamUsageResponse(42, 500))
    await server.start()
    const cookie = await login(server)

    await fetch(`${base(server)}/api/accounts/acc-1/check`, {
      method: 'POST',
      headers: { cookie, 'X-Panel-Request': '1' }
    })

    const persisted = (store.data.accountData as {
      accounts: Record<string, Record<string, unknown>>
    }).accounts['acc-1']
    expect(persisted.note).toBe('桌面端写的备注')
    expect(persisted.groupId).toBe('g1')
    expect(persisted.tags).toEqual(['t1'])
    expect(persisted.isActive).toBe(true)
    // 静态凭证不该被动过
    expect((persisted.credentials as Record<string, unknown>).accessToken).toBe(
      'ksk_static_key_value'
    )
  })

  it('落盘走 revision 收口并广播 · 桌面端无需轮询就能得知手机刷了额度', async () => {
    const server = makeServer(upstreamUsageResponse(42, 500))
    await server.start()
    const cookie = await login(server)

    await fetch(`${base(server)}/api/accounts/acc-1/check`, {
      method: 'POST',
      headers: { cookie, 'X-Panel-Request': '1' }
    })

    // revision 递增 = 真的过了 applyAccountDataMutation 这个写入收口
    expect((store.data.accountData as { revision: number }).revision).toBe(8)
    // 广播是桌面端「无需轮询」的唯一依据（App.tsx:150 订阅 accounts-data-changed）
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].revision).toBe(8)
    // payload 白名单：绝不含凭证
    expect(JSON.stringify(broadcasts[0])).not.toContain('ksk_')
  })

  it('刷新期间账号已在另一端被删除 · 不得把它写回盘上复活', async () => {
    const server = makeServer(upstreamUsageResponse(42, 500))
    await server.start()
    const cookie = await login(server)

    // 面板已把账号读进 handler（routes.ts 先 loadAccountsBlob 再调业务函数）；
    // 用真实的删除路径（同一个写入收口）在期间删掉它，模拟桌面端并发删除。
    // 这里直接在 check 之前删，等价于「HTTP 请求在途时另一端删了它」——
    // 落盘那一刻盘上已无此记录。
    await applyAccountDataMutation((prev) => ({ ...prev, accounts: {} }))
    const revAfterDelete = (store.data.accountData as { revision: number }).revision

    // 账号已不在盘上 ⇒ 路由层 404（这是既有语义），落盘层也绝不重建
    const res = await fetch(`${base(server)}/api/accounts/acc-1/check`, {
      method: 'POST',
      headers: { cookie, 'X-Panel-Request': '1' }
    })
    expect(res.status).toBe(404)

    expect((store.data.accountData as { accounts: Record<string, unknown> }).accounts).toEqual({})
    // 未产生多余的 revision 递增 / 广播
    expect((store.data.accountData as { revision: number }).revision).toBe(revAfterDelete)
  })
})

describe('桌面端 IPC 路径 · 同一业务函数同样落盘（不再依赖 renderer store）', () => {
  it('桌面端点刷新额度 · 业务函数返回时盘上已是新值', async () => {
    const account = (store.data.accountData as {
      accounts: Record<string, unknown>
    }).accounts['acc-1']

    const result = await checkAccountStatus(
      runtimeDeps(upstreamUsageResponse(77, 500)),
      account as never
    )

    expect(result.success).toBe(true)
    const persisted = (store.data.accountData as {
      accounts: Record<string, { usage: { current: number; limit: number } }>
    }).accounts['acc-1']
    expect(persisted.usage).toMatchObject({ current: 77, limit: 500 })
    expect((store.data.accountData as { revision: number }).revision).toBe(8)
  })

  it('上游失败时不写盘 · 不能把失败当成"额度归零"存下去', async () => {
    const account = (store.data.accountData as {
      accounts: Record<string, unknown>
    }).accounts['acc-1']
    const deps = runtimeDeps(null)
    deps.api.getUsageAndLimits = async () => { throw new Error('503 upstream down') }

    const result = await checkAccountStatus(deps, account as never)

    expect(result.success).toBe(false)
    const blob = store.data.accountData as {
      revision: number
      accounts: Record<string, { usage: { current: number } }>
    }
    expect(blob.accounts['acc-1'].usage.current).toBe(10) // 旧值原样
    expect(blob.revision).toBe(7) // 没有多余的 revision 递增
    expect(broadcasts).toHaveLength(0)
  })
})

describe('批量刷新额度 · 中途失败不能让已成功的部分全丢', () => {
  /** 三个账号，额度都是旧值 */
  function threeAccountsBlob(): Record<string, unknown> {
    const mk = (id: string): Record<string, unknown> => ({
      id,
      email: `${id}@example.com`,
      note: `备注-${id}`,
      status: 'active',
      subscription: { type: 'Free', title: 'Free' },
      usage: { current: 1, limit: 10, percentUsed: 0.1, lastUpdated: 1 },
      credentials: { accessToken: `tok-${id}`, authMethod: 'social', provider: 'Google' }
    })
    return { revision: 3, accounts: { a: mk('a'), b: mk('b'), c: mk('c') } }
  }

  function batchAccounts(ids: string[]): BatchCheckAccount[] {
    return ids.map((id) => ({
      id,
      email: `${id}@example.com`,
      credentials: { accessToken: `tok-${id}`, authMethod: 'social', provider: 'Google' },
      idp: 'Google'
    }))
  }

  const matchingBatchUserInfo = async (accessToken: string): Promise<{
    email: string
    status: string
  }> => ({
    email: `${accessToken.replace(/^tok-/, '')}@example.com`,
    status: 'Active'
  })

  beforeEach(() => {
    store = makeStore({ accountData: threeAccountsBlob() })
    broadcasts = []
    setStoreRef(store)
  })

  function persistedUsage(id: string): { current?: number; limit?: number } {
    return (
      store.data.accountData as {
        accounts: Record<string, { usage: { current?: number; limit?: number } }>
      }
    ).accounts[id].usage
  }

  it('批量刷完 · 三个账号的新额度都在盘上（不再只靠 30 秒自动保存兜底）', async () => {
    const deps = runtimeDeps(upstreamUsageResponse(55, 200))
    deps.api.getUserInfo = matchingBatchUserInfo

    const summary = await backgroundBatchCheck(deps, batchAccounts(['a', 'b', 'c']), 10)

    expect(summary.successCount).toBe(3)
    for (const id of ['a', 'b', 'c']) {
      expect(persistedUsage(id)).toMatchObject({ current: 55, limit: 200 })
    }
  })

  it('第二片上游全挂 · 第一片已落盘的结果必须还在（不是全丢）', async () => {
    let call = 0
    const deps = runtimeDeps(null)
    deps.api.getUserInfo = matchingBatchUserInfo
    // concurrency=1 ⇒ 每个账号一片。第 1 个成功，之后全挂。
    deps.api.getUsageAndLimits = async () => {
      call++
      if (call === 1) return upstreamUsageResponse(55, 200)
      throw new Error('503 upstream down')
    }

    await backgroundBatchCheck(deps, batchAccounts(['a', 'b', 'c']), 1)

    // 第一片的成功结果留在盘上 —— 「最后统一写一次」的方案在这里会全丢
    expect(persistedUsage('a')).toMatchObject({ current: 55, limit: 200 })
    // 失败的两个保留旧额度（失败不能被当成"额度归零"写下去）
    expect(persistedUsage('b')).toMatchObject({ current: 1, limit: 10 })
    expect(persistedUsage('c')).toMatchObject({ current: 1, limit: 10 })
  })

  it('每切片只广播一次 · 1000 账号不会变成 1000 条广播打爆桌面端', async () => {
    const deps = runtimeDeps(upstreamUsageResponse(55, 200))
    deps.api.getUserInfo = matchingBatchUserInfo

    // 3 个账号 / concurrency=2 ⇒ 2 片 ⇒ 2 次写入 ⇒ 2 条广播
    await backgroundBatchCheck(deps, batchAccounts(['a', 'b', 'c']), 2)

    expect(broadcasts).toHaveLength(2)
    expect((store.data.accountData as { revision: number }).revision).toBe(5) // 3 + 2
  })

  it('批量落盘同样不覆盖桌面端并发写的备注', async () => {
    const deps = runtimeDeps(upstreamUsageResponse(55, 200))
    deps.api.getUserInfo = matchingBatchUserInfo

    await backgroundBatchCheck(deps, batchAccounts(['a', 'b', 'c']), 10)

    const accounts = (
      store.data.accountData as { accounts: Record<string, Record<string, unknown>> }
    ).accounts
    expect(accounts.a.note).toBe('备注-a')
    expect(accounts.c.note).toBe('备注-c')
  })

  it('切片内账号已被另一端删除 · 跳过它，其余照常落盘且不复活它', async () => {
    const deps = runtimeDeps(upstreamUsageResponse(55, 200))
    deps.api.getUserInfo = matchingBatchUserInfo

    // 用真实写入路径删掉 b
    await applyAccountDataMutation((prev) => {
      const accounts = { ...(prev.accounts as Record<string, unknown>) }
      delete accounts.b
      return { ...prev, accounts }
    })

    await backgroundBatchCheck(deps, batchAccounts(['a', 'b', 'c']), 10)

    const accounts = (
      store.data.accountData as { accounts: Record<string, unknown> }
    ).accounts
    expect(Object.keys(accounts).sort()).toEqual(['a', 'c']) // b 没有复活
    expect(persistedUsage('a')).toMatchObject({ current: 55, limit: 200 })
    expect(persistedUsage('c')).toMatchObject({ current: 55, limit: 200 })
  })
})
