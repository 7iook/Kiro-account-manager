/**
 * 主进程后台批量刷新 Token 必须**自己落盘** —— 服务器上没有渲染进程可以回流
 *
 * ## 治的病灶
 *
 * `index.ts:backgroundBatchRefresh` 刷新成功后只做一件事:
 * `mainWindow?.webContents.send('background-refresh-result', …)` —— 把新凭据推给渲染进程,
 * 由 `store/accounts.ts:applyBackgroundRefreshResults` 接收。而那个 reducer 只改 zustand
 * 内存,尾部**没有** `saveToStorage()`(与其余 25 个写入口不同)。
 *
 * 桌面端靠别的编辑顺带整表落盘、或靠 `refreshAccountToken` 单账号路径(已收口)补上;
 * **服务器形态上 `mainWindow` 是 undefined ⇒ send 是静默 no-op ⇒ 新签发的 refreshToken
 * 连内存都没进,更没上盘**。而 IdP 轮换时旧 refreshToken 一签发新的就当场作废 ⇒
 * 盘上留着死凭据 ⇒ 重启后全部账号失效,而日志里每分钟都在报"刷新成功"。
 *
 * ## 断言姿势
 *
 * 与 `refreshPersistence.test.ts` / `quotaFeedWiring.test.ts` 同一姿势:**读盘断言**,
 * 不断言"某函数被调用过"。断言 mock 被调用在这里会**对着坏代码也变绿** ——
 * 坏代码确实调了 refreshTokenByMethod,它只是没把结果写下去。
 *
 * `emit` 一律注入成 no-op(等价于生产里 `mainWindow` 不存在的服务器形态):
 * 于是每条用例都在"无渲染进程"前提下跑,盘上还有新 token 就只能是主进程自己写的。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { backgroundBatchRefresh } from '@main/accountService/backgroundRefresh'
import type { AccountRuntimeDeps, RefreshTokenResult } from '@main/accountService/types'
import {
  setStoreRef,
  setLastSavedDataSetter,
  setBroadcaster,
  type BroadcastPayload
} from '@main/accountService/state'

/** in-memory electron-store 替身（与 state.test.ts / refreshPersistence.test.ts 同一形状） */
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
    set: (k: string, v: unknown) => {
      data[k] = v
    }
  }
}

/** 盘上初始态：两个账号各持一个即将被 IdP 轮换掉的 refreshToken */
function initialBlob(): Record<string, unknown> {
  return {
    revision: 5,
    accounts: {
      'acc-1': {
        id: 'acc-1',
        email: 'a@example.com',
        idp: 'Google',
        note: '桌面端写的备注',
        groupId: 'g1',
        tags: ['t1'],
        status: 'error',
        lastError: '上次刷新失败了',
        usage: { current: 10, limit: 100, percentUsed: 0.1, lastUpdated: 1 },
        credentials: {
          accessToken: 'access-1-v1',
          refreshToken: 'refresh-1-v1',
          clientId: 'cid',
          clientSecret: 'csec',
          region: 'us-east-1',
          authMethod: 'social',
          provider: 'Google',
          expiresAt: 1_000
        }
      },
      'acc-2': {
        id: 'acc-2',
        email: 'b@example.com',
        idp: 'Google',
        status: 'active',
        usage: { current: 5, limit: 100, percentUsed: 0.05, lastUpdated: 1 },
        credentials: {
          accessToken: 'access-2-v1',
          refreshToken: 'refresh-2-v1',
          clientId: 'cid',
          clientSecret: 'csec',
          region: 'us-east-1',
          authMethod: 'social',
          provider: 'Google',
          expiresAt: 1_000
        }
      }
    }
  }
}

type Overrides = {
  /** 按 refreshToken 决定上游返回；缺省 → `<old>` 换成 `-v2` */
  refresh?: (oldToken: string) => RefreshTokenResult
  emit?: (channel: string, payload: unknown) => void
  usage?: unknown
  diskToken?: { refreshToken?: string } | null
  onWriteIde?: (input: unknown) => void
}

/**
 * 服务器形态的 deps：`emit` 是 no-op（生产里 `mainWindow` 为 undefined 时的等价物）。
 * 只实装 social 刷新分支会用到的 API，其余留 throw —— 被调到就是走错分支。
 */
function runtimeDeps(o: Overrides = {}): AccountRuntimeDeps {
  return {
    proxyServer: null,
    emit: o.emit ?? (() => undefined),
    api: {
      getUsageAndLimits: async () => o.usage ?? { usageBreakdownList: [] },
      getUserInfo: async () => ({ email: undefined, userId: undefined }),
      refreshTokenByMethod: async (token: string) =>
        o.refresh
          ? o.refresh(token)
          : {
              success: true,
              accessToken: token.replace('refresh', 'access').replace('-v1', '-v2'),
              refreshToken: token.replace('-v1', '-v2'),
              expiresIn: 3600
            },
      fetchEnterpriseProfileArn: async () => undefined,
      readKiroAuthTokenFile: async () => o.diskToken ?? null,
      writeKiroAuthTokenFile: async (input) => {
        o.onWriteIde?.(input)
        return undefined
      },
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

/** 一个账号的入参形状（镜像 index.ts 的 BackgroundRefreshAccount） */
function inputAccount(id: string, refreshToken: string): Parameters<typeof backgroundBatchRefresh>[1][number] {
  return {
    id,
    idp: 'Google',
    needsTokenRefresh: true,
    credentials: {
      refreshToken,
      clientId: 'cid',
      clientSecret: 'csec',
      region: 'us-east-1',
      authMethod: 'social',
      provider: 'Google',
      accessToken: refreshToken.replace('refresh', 'access')
    }
  }
}

let store: ReturnType<typeof makeStore>
let broadcasts: BroadcastPayload[]

beforeEach(() => {
  store = makeStore({ accountData: initialBlob() })
  broadcasts = []
  setStoreRef(store)
  setLastSavedDataSetter(() => undefined)
  setBroadcaster((p) => {
    broadcasts.push(p)
  })
})

/** 直接读盘上的账号记录 —— 断言的是持久化后的状态 */
function persisted(id: string): Record<string, unknown> {
  return (store.data.accountData as { accounts: Record<string, Record<string, unknown>> }).accounts[
    id
  ]
}

function persistedCred(id: string): Record<string, unknown> {
  return persisted(id).credentials as Record<string, unknown>
}

function revision(): number {
  return (store.data.accountData as { revision: number }).revision
}

describe('无渲染进程（服务器形态）· 后台批量刷新的新 token 必须落到盘上', () => {
  it('刷新成功 ⇒ 盘上的 refreshToken 是本次新签发的那个（这是本轮的核心断言）', async () => {
    expect(persistedCred('acc-1').refreshToken).toBe('refresh-1-v1')

    const summary = await backgroundBatchRefresh(
      runtimeDeps(),
      [inputAccount('acc-1', 'refresh-1-v1')],
      10,
      false
    )

    expect(summary.successCount).toBe(1)
    // 没有窗口、没有渲染进程 —— 盘上还有新值,只能是主进程自己写的
    expect(persistedCred('acc-1').refreshToken).toBe('refresh-1-v2')
    expect(persistedCred('acc-1').accessToken).toBe('access-1-v2')
    expect(persistedCred('acc-1').expiresAt as number).toBeGreaterThan(Date.now())
  })

  it('一次也没 emit 过（窗口不存在）· 盘上依然是新值 —— 落盘不依赖事件回流', async () => {
    const emitted: string[] = []

    await backgroundBatchRefresh(
      runtimeDeps({ emit: (channel) => emitted.push(channel) }),
      [inputAccount('acc-1', 'refresh-1-v1')],
      10,
      false
    )

    // 事件照旧发（桌面端 UI 响应性不回退），但落盘与它无关：
    // 下面这条断言即使 emit 全被丢掉也必须成立。
    expect(persistedCred('acc-1').refreshToken).toBe('refresh-1-v2')
    expect(emitted).toContain('background-refresh-result')
  })

  it('多账号一批 ⇒ 每个账号各自的新 token 都落盘，不串号', async () => {
    await backgroundBatchRefresh(
      runtimeDeps(),
      [inputAccount('acc-1', 'refresh-1-v1'), inputAccount('acc-2', 'refresh-2-v1')],
      10,
      false
    )

    expect(persistedCred('acc-1').refreshToken).toBe('refresh-1-v2')
    expect(persistedCred('acc-2').refreshToken).toBe('refresh-2-v2')
  })

  it('落盘走 revision 收口并广播 · 与其余写路径同一条持久化路径', async () => {
    await backgroundBatchRefresh(
      runtimeDeps(),
      [inputAccount('acc-1', 'refresh-1-v1'), inputAccount('acc-2', 'refresh-2-v1')],
      10,
      false
    )

    // 一个切片一次写入 ⇒ 一次 revision 递增 + 一条广播（不是每账号一条）
    expect(revision()).toBe(6)
    expect(broadcasts).toHaveLength(1)
    // payload 白名单：绝不含凭证
    expect(JSON.stringify(broadcasts[0])).not.toContain('refresh-1-v2')
  })

  it('刷新成功即清错误状态 · 与单账号路径基线一致', async () => {
    await backgroundBatchRefresh(
      runtimeDeps(),
      [inputAccount('acc-1', 'refresh-1-v1')],
      10,
      false
    )

    expect(persisted('acc-1').status).toBe('active')
    expect(persisted('acc-1').lastError).toBeUndefined()
    expect(typeof persisted('acc-1').lastCheckedAt).toBe('number')
  })

  it('落盘只碰凭据相关字段 · 桌面端并发写的备注 / 分组 / 标签不被覆盖', async () => {
    await backgroundBatchRefresh(
      runtimeDeps(),
      [inputAccount('acc-1', 'refresh-1-v1')],
      10,
      false
    )

    expect(persisted('acc-1').note).toBe('桌面端写的备注')
    expect(persisted('acc-1').groupId).toBe('g1')
    expect(persisted('acc-1').tags).toEqual(['t1'])
    // syncInfo=false ⇒ 不碰额度
    expect(persisted('acc-1').usage).toMatchObject({ current: 10, limit: 100 })
    // 非本次刷新的 OIDC 字段原样保留（字段级补丁，不是整条覆盖）
    expect(persistedCred('acc-1').clientId).toBe('cid')
    expect(persistedCred('acc-1').clientSecret).toBe('csec')
  })

  it('IdP 未返回新 refreshToken ⇒ 保留原值（`||` 回退语义，不得写成 undefined）', async () => {
    await backgroundBatchRefresh(
      runtimeDeps({
        refresh: () => ({ success: true, accessToken: 'access-1-v2', expiresIn: 3600 })
      }),
      [inputAccount('acc-1', 'refresh-1-v1')],
      10,
      false
    )

    expect(persistedCred('acc-1').refreshToken).toBe('refresh-1-v1')
    expect(persistedCred('acc-1').accessToken).toBe('access-1-v2')
  })
})

describe('失败与边界 · 不得把失败当成「凭据已更新」写下去', () => {
  it('上游刷新失败 ⇒ 凭据一个字都不动，只落错误状态', async () => {
    const summary = await backgroundBatchRefresh(
      runtimeDeps({ refresh: () => ({ success: false, error: 'invalid_grant' }) }),
      [inputAccount('acc-1', 'refresh-1-v1')],
      10,
      false
    )

    expect(summary.failedCount).toBe(1)
    // 失败绝不能被当成「凭据已更新」写下去
    expect(persistedCred('acc-1').refreshToken).toBe('refresh-1-v1')
    expect(persistedCred('acc-1').accessToken).toBe('access-1-v1')
    expect(persistedCred('acc-1').expiresAt).toBe(1_000)
    // 额度同样不动（失败 ≠ 额度归零）
    expect(persisted('acc-1').usage).toMatchObject({ current: 10, limit: 100 })
  })

  it('失败原因必须落盘 —— 主进程调度器的退避判据读的是盘上的 lastError', async () => {
    // 这不是"顺手多存一点":`index.ts:2659-2670` 的调度器每轮从**盘上**读 `acc.lastError`,
    // 用 isBannedAccountErrorMain / isPermanentCredentialError 决定是否跳过本轮刷新。
    // 失败原因不落盘 ⇒ 服务器上永远读不到 invalid_grant ⇒ 指数退避永不生效 ⇒
    // 对一个已作废的凭据每 60s 重刷一次,直到日志被刷爆。
    await backgroundBatchRefresh(
      runtimeDeps({ refresh: () => ({ success: false, error: 'invalid_grant' }) }),
      [inputAccount('acc-1', 'refresh-1-v1')],
      10,
      false
    )

    expect(persisted('acc-1').status).toBe('error')
    expect(persisted('acc-1').lastError).toBe('invalid_grant')
  })

  it('一批里一成一败 ⇒ 成功的落盘，失败的原样（不因同伴失败一起丢）', async () => {
    await backgroundBatchRefresh(
      runtimeDeps({
        refresh: (old) =>
          old === 'refresh-2-v1'
            ? { success: false, error: 'invalid_grant' }
            : { success: true, accessToken: 'access-1-v2', refreshToken: 'refresh-1-v2', expiresIn: 3600 }
      }),
      [inputAccount('acc-1', 'refresh-1-v1'), inputAccount('acc-2', 'refresh-2-v1')],
      10,
      false
    )

    expect(persistedCred('acc-1').refreshToken).toBe('refresh-1-v2')
    expect(persistedCred('acc-2').refreshToken).toBe('refresh-2-v1')
  })

  it('刷新期间账号已被另一端删除 ⇒ 不得把它写回盘上复活', async () => {
    // 账号不在盘上，但仍作为入参传进来（调用方快照来自删除之前）
    store.data.accountData = { revision: 9, accounts: {} }

    const summary = await backgroundBatchRefresh(
      runtimeDeps(),
      [inputAccount('acc-1', 'refresh-1-v1')],
      10,
      false
    )

    expect(summary.successCount).toBe(1) // 刷新本身成功
    expect(
      (store.data.accountData as { accounts: Record<string, unknown> }).accounts
    ).toEqual({})
    expect(revision()).toBe(9) // 无意义的 revision 递增也不该发生
  })

  it('同一账号已在途 ⇒ 跳过本次，不产生第二次刷新与落盘（去重集合共享）', async () => {
    const inFlight = new Set<string>(['acc-1'])
    const deps = { ...runtimeDeps(), refreshInFlightIds: inFlight }

    await backgroundBatchRefresh(deps, [inputAccount('acc-1', 'refresh-1-v1')], 10, false)

    expect(persistedCred('acc-1').refreshToken).toBe('refresh-1-v1')
    expect(revision()).toBe(5)
  })
})
