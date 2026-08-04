/**
 * 「刷新 Token」必须落盘 —— 面板刷完，盘上的 refreshToken 就是本次新签发的那个
 *
 * 治的病灶：`refresh.ts:refreshAccountToken` 只**返回**新凭据，落盘长在 renderer store
 * 里（`store/accounts.ts:1843-1867`）。面板走 HTTP 调同一函数却没有那个 store ⇒
 * 新签发的 refreshToken 只出现在 HTTP 响应里、没落盘。而 IdP 轮换时旧 refreshToken
 * 一签发新的就当场作废 ⇒ 盘上留着一个**已失效**的凭据，下次续期失败，可能要重新登录。
 *
 * 与 `checkPersistence.test.ts` 同一姿势：真起 `WebPanelServer`、真 POST、
 * 再从盘上/列表读回，断言的是**持久化后的状态**，不是「某函数被调用过」。
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { WebPanelServer, type WebPanelConfig } from '../../../src/main/webPanel/server'
import { PanelAuth, type AdminKeyStore } from '../../../src/main/webPanel/auth'
import { PANEL_PATH_PREFIX } from '../../../src/main/webPanel/cookie'
import { buildPanelRouteDeps } from '../../../src/main/ipc/webPanelWiring'
import { refreshAccountToken } from '../../../src/main/accountService/refresh'
import {
  applyAccountDataMutation,
  setStoreRef,
  setLastSavedDataSetter,
  setBroadcaster,
  type BroadcastPayload
} from '../../../src/main/accountService/state'
import { loadAccounts } from '../../../src/main/accountService/accounts'
import type {
  AccountRuntimeDeps,
  RefreshTokenResult,
  WriteKiroTokenInput,
  KiroTokenFileLike
} from '../../../src/main/accountService/types'

const ADMIN_KEY = 'test-admin-key-0123456789abcdef'

function memoryKeyStore(): AdminKeyStore {
  let key: string | null = ADMIN_KEY
  return { get: () => key, set: (k: string) => { key = k } }
}

/** in-memory electron-store 替身（与 state.test.ts / checkPersistence.test.ts 同一形状） */
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

/** 盘上初始态：持有 refresh-v1（IdP 即将把它轮换掉） */
function initialBlob(): Record<string, unknown> {
  return {
    revision: 7,
    accounts: {
      'acc-1': {
        id: 'acc-1',
        email: 'user@example.com',
        idp: 'Google',
        note: '桌面端写的备注',
        groupId: 'g1',
        tags: ['t1'],
        isActive: true,
        status: 'error',
        lastError: '上次刷新失败了',
        usage: { current: 10, limit: 100, percentUsed: 0.1, lastUpdated: 1 },
        credentials: {
          accessToken: 'access-v1',
          refreshToken: 'refresh-v1',
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

type DepsOverrides = {
  refresh?: RefreshTokenResult
  diskToken?: KiroTokenFileLike | null
  lastSwitchedAccountId?: string | null
  enterpriseArn?: string
  onWriteIde?: (input: WriteKiroTokenInput) => void
  onScheduleRenewal?: (accountId: string, expiresAtMs: number) => void
  onSetSignature?: (sig: string | null) => void
  onSetLastSwitched?: (id: string | null) => void
}

/** 只实现 social 刷新分支实际会用到的 API，其余留 throw —— 被调到就是走错分支了 */
function runtimeDeps(o: DepsOverrides = {}): AccountRuntimeDeps {
  let lastSwitched = o.lastSwitchedAccountId ?? null
  return {
    proxyServer: null,
    emit: () => undefined,
    api: {
      getUsageAndLimits: async () => { throw new Error('刷新 Token 分支不应调 getUsageAndLimits') },
      getUserInfo: async () => { throw new Error('刷新 Token 分支不应调 getUserInfo') },
      refreshTokenByMethod: async () =>
        o.refresh ?? {
          success: true,
          accessToken: 'access-v2',
          refreshToken: 'refresh-v2',
          expiresIn: 3600
        },
      fetchEnterpriseProfileArn: async () => o.enterpriseArn,
      readKiroAuthTokenFile: async () => o.diskToken ?? null,
      writeKiroAuthTokenFile: async (input) => {
        o.onWriteIde?.(input as WriteKiroTokenInput)
        return undefined
      },
      resolveProfileArnForWrite: () => undefined
    },
    getLastSwitchedAccountId: () => lastSwitched,
    setLastSwitchedAccountId: (id) => {
      lastSwitched = id
      o.onSetLastSwitched?.(id)
    },
    getLastWrittenTokenSignature: () => null,
    setLastWrittenTokenSignature: (sig) => o.onSetSignature?.(sig),
    isProactiveRenewalEnabled: () => true,
    scheduleProactiveRenewal: (id, ms) => o.onScheduleRenewal?.(id, ms),
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

function makeServer(deps: AccountRuntimeDeps, config: Partial<WebPanelConfig> = {}): WebPanelServer {
  const auth = new PanelAuth(memoryKeyStore())
  const server = new WebPanelServer({
    auth,
    routeDeps: buildPanelRouteDeps({
      // 与生产装配同形：面板与 IPC 复用同一个 accountService 函数（index.ts:4358）
      loadAccountsBlob: () => loadAccounts(storeDeps),
      importApiKeys: async () => ({ success: true, imported: 0, results: [] }) as never,
      checkAccountStatus: async () => ({ success: true }),
      refreshAccountToken: (account) => refreshAccountToken(deps, account as never),
      switchAccountToIde: async () => ({ success: true }),
      switchAccountToCli: async () => ({ success: true }),
      logoutFromIde: async () => ({ success: true }),
      getAccountModels: async () => ({ success: true }),
      getAccountSubscriptions: async () => ({ success: true }),
      getAccountSubscriptionUrl: async () => ({ success: true }),
      setAccountOverage: async () => ({ success: true }),
      proxyGetStatus: async () => ({ success: true }),
      proxySyncPool: async () => ({ success: true }),
      proxyActivateAccount: async () => ({ success: true }),
      proxyStart: async () => ({ success: true }),
      proxyStop: async () => ({ success: true })
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

/** 直接读盘上的账号记录 —— 断言的是持久化后的状态 */
function persisted(id = 'acc-1'): Record<string, unknown> {
  return (
    store.data.accountData as { accounts: Record<string, Record<string, unknown>> }
  ).accounts[id]
}

function persistedCred(id = 'acc-1'): Record<string, unknown> {
  return persisted(id).credentials as Record<string, unknown>
}

async function postRefresh(server: WebPanelServer, cookie: string): Promise<Response> {
  return fetch(`${base(server)}/api/accounts/acc-1/refresh-token`, {
    method: 'POST',
    headers: { cookie, 'X-Panel-Request': '1' }
  })
}

describe('手机端刷新 Token 后 · 盘上的 refreshToken 必须是本次新签发的那个', () => {
  it('IdP 轮换了 refreshToken · 新值必须落盘（旧值已被上游作废，留着它下次续期必失败）', async () => {
    const server = makeServer(runtimeDeps())
    await server.start()
    const cookie = await login(server)

    expect(persistedCred().refreshToken).toBe('refresh-v1')

    const res = await postRefresh(server, cookie)
    expect(res.status).toBe(200)

    // 这一条是本轮的核心断言：HTTP 成功返回 ⇒ 新凭据已 durable
    expect(persistedCred().refreshToken).toBe('refresh-v2')
    expect(persistedCred().accessToken).toBe('access-v2')
    expect(typeof persistedCred().expiresAt).toBe('number')
    expect(persistedCred().expiresAt as number).toBeGreaterThan(Date.now())
  })

  it('IdP 未返回新 refreshToken · 保留原值（`||` 回退语义不变，不得写成 undefined）', async () => {
    const server = makeServer(
      runtimeDeps({
        refresh: { success: true, accessToken: 'access-v2', expiresIn: 3600 }
      })
    )
    await server.start()
    const cookie = await login(server)

    const res = await postRefresh(server, cookie)
    expect(res.status).toBe(200)

    expect(persistedCred().refreshToken).toBe('refresh-v1')
    expect(persistedCred().accessToken).toBe('access-v2')
  })

  it('刷新成功即清错误状态 · 与桌面端基线一致（status/lastError/lastCheckedAt）', async () => {
    const server = makeServer(runtimeDeps())
    await server.start()
    const cookie = await login(server)

    await postRefresh(server, cookie)

    expect(persisted().status).toBe('active')
    expect(persisted().lastError).toBeUndefined()
    expect(typeof persisted().lastCheckedAt).toBe('number')
  })

  it('落盘只碰凭据相关字段 · 桌面端并发写的备注 / 分组 / 标签不被覆盖', async () => {
    const server = makeServer(runtimeDeps())
    await server.start()
    const cookie = await login(server)

    await postRefresh(server, cookie)

    expect(persisted().note).toBe('桌面端写的备注')
    expect(persisted().groupId).toBe('g1')
    expect(persisted().tags).toEqual(['t1'])
    expect(persisted().isActive).toBe(true)
    // 刷新 Token 不碰额度
    expect(persisted().usage).toMatchObject({ current: 10, limit: 100 })
    // OIDC 凭证里非本次刷新的字段原样保留（字段级补丁，不是整条覆盖）
    expect(persistedCred().clientId).toBe('cid')
    expect(persistedCred().clientSecret).toBe('csec')
    expect(persistedCred().authMethod).toBe('social')
  })

  it('落盘走 revision 收口并广播 · 桌面端无需轮询就能得知手机刷了 Token', async () => {
    const server = makeServer(runtimeDeps())
    await server.start()
    const cookie = await login(server)

    await postRefresh(server, cookie)

    expect((store.data.accountData as { revision: number }).revision).toBe(8)
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].revision).toBe(8)
    // payload 白名单：绝不含凭证
    expect(JSON.stringify(broadcasts[0])).not.toContain('refresh-v2')
    expect(JSON.stringify(broadcasts[0])).not.toContain('access-v2')
  })
})

describe('失败与边界 · 不得把失败当成"凭据已更新"写下去', () => {
  it('上游刷新失败 · 零落盘、零广播、不上报成功', async () => {
    const server = makeServer(
      runtimeDeps({ refresh: { success: false, error: 'invalid_grant' } })
    )
    await server.start()
    const cookie = await login(server)

    const res = await postRefresh(server, cookie)
    // 面板层把 success:false 映射成错误响应（既有语义，不在本轮改动）
    expect(res.status).not.toBe(200)

    expect(persistedCred().refreshToken).toBe('refresh-v1')
    expect(persistedCred().accessToken).toBe('access-v1')
    expect(persistedCred().expiresAt).toBe(1_000)
    expect((store.data.accountData as { revision: number }).revision).toBe(7)
    expect(broadcasts).toHaveLength(0)
  })

  it('刷新期间账号已在另一端被删除 · 不得把它写回盘上复活', async () => {
    const server = makeServer(runtimeDeps())
    await server.start()
    const cookie = await login(server)

    await applyAccountDataMutation((prev) => ({ ...prev, accounts: {} }))
    const revAfterDelete = (store.data.accountData as { revision: number }).revision

    // 路由层先 loadAccountsBlob 再调业务函数 ⇒ 账号已不在盘上时 404（既有语义）
    const res = await postRefresh(server, cookie)
    expect(res.status).toBe(404)

    expect((store.data.accountData as { accounts: Record<string, unknown> }).accounts).toEqual({})
    expect((store.data.accountData as { revision: number }).revision).toBe(revAfterDelete)
  })

  it('ksk_ 静态凭证 · no-op 分支不产生落盘（无 refreshToken 可轮换）', async () => {
    await applyAccountDataMutation((prev) => ({
      ...prev,
      accounts: {
        'acc-1': {
          id: 'acc-1',
          email: 'user@example.com',
          credentials: {
            accessToken: 'ksk_static_key_value',
            authMethod: 'api_key',
            provider: 'ApiKey'
          }
        }
      }
    }))
    const revBefore = (store.data.accountData as { revision: number }).revision
    broadcasts.length = 0

    const server = makeServer(runtimeDeps())
    await server.start()
    const cookie = await login(server)

    const res = await postRefresh(server, cookie)
    expect(res.status).toBe(200)

    expect((store.data.accountData as { revision: number }).revision).toBe(revBefore)
    expect(broadcasts).toHaveLength(0)
    expect(persistedCred().accessToken).toBe('ksk_static_key_value')
  })
})

describe('IDE token 文件写入的既有触发条件与副作用不得被扰动', () => {
  it('该账号是 IDE 当前激活账号（磁盘 refreshToken 匹配）· 照旧写 IDE token 文件 + 记签名 + 重排续期', async () => {
    const ideWrites: WriteKiroTokenInput[] = []
    const signatures: (string | null)[] = []
    const renewals: Array<[string, number]> = []
    const server = makeServer(
      runtimeDeps({
        diskToken: { refreshToken: 'refresh-v1', provider: 'Google' },
        onWriteIde: (i) => ideWrites.push(i),
        onSetSignature: (s) => signatures.push(s),
        onScheduleRenewal: (id, ms) => renewals.push([id, ms])
      })
    )
    await server.start()
    const cookie = await login(server)

    const res = await postRefresh(server, cookie)
    expect(res.status).toBe(200)

    expect(ideWrites).toHaveLength(1)
    expect(ideWrites[0]).toMatchObject({ accessToken: 'access-v2', refreshToken: 'refresh-v2' })
    expect(signatures).toEqual(['access-v2|refresh-v2'])
    expect(renewals).toHaveLength(1)
    expect(renewals[0][0]).toBe('acc-1')
    // 落盘照旧发生（两个关注点互不影响）
    expect(persistedCred().refreshToken).toBe('refresh-v2')
  })

  it('该账号不是 IDE 当前激活账号 · 不写 IDE token 文件，但 accountData 仍然落盘', async () => {
    const ideWrites: WriteKiroTokenInput[] = []
    const server = makeServer(
      runtimeDeps({
        diskToken: { refreshToken: '别的账号的-refresh', provider: 'Google' },
        onWriteIde: (i) => ideWrites.push(i)
      })
    )
    await server.start()
    const cookie = await login(server)

    await postRefresh(server, cookie)

    expect(ideWrites).toHaveLength(0)
    expect(persistedCred().refreshToken).toBe('refresh-v2')
  })
})

describe('桌面端 IPC 路径 · 同一业务函数同样落盘（不再依赖 renderer store）', () => {
  it('桌面端点刷新 Token · 业务函数返回时盘上已是新凭据', async () => {
    const account = persisted()

    const result = await refreshAccountToken(runtimeDeps(), account as never)

    expect(result.success).toBe(true)
    expect(persistedCred().refreshToken).toBe('refresh-v2')
    expect(persistedCred().accessToken).toBe('access-v2')
    expect((store.data.accountData as { revision: number }).revision).toBe(8)
  })

  it('Enterprise 刷新拿到的 profileArn · 顶层与 credentials 两处都落盘', async () => {
    await applyAccountDataMutation((prev) => {
      const accounts = prev.accounts as Record<string, Record<string, unknown>>
      const acc = accounts['acc-1']
      return {
        ...prev,
        accounts: {
          'acc-1': {
            ...acc,
            credentials: {
              ...(acc.credentials as Record<string, unknown>),
              authMethod: 'external_idp',
              provider: 'Enterprise',
              tokenEndpoint: 'https://idp.example.com/token'
            }
          }
        }
      }
    })

    const result = await refreshAccountToken(
      runtimeDeps({ enterpriseArn: 'arn:aws:codewhisperer:::profile/ENT1' }),
      persisted() as never
    )

    expect(result.success).toBe(true)
    expect(persisted().profileArn).toBe('arn:aws:codewhisperer:::profile/ENT1')
    expect(persistedCred().profileArn).toBe('arn:aws:codewhisperer:::profile/ENT1')
  })
})
