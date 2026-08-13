/**
 * 面板反代端点 —— 端到端（真 HTTP + 真 AccountPool + 真编排）
 *
 * ## 这批测试为什么不断言「返回 200」
 *
 * 交付契约的负条件里有一条已实证的失效：只动池指针而不写
 * `config.selectedAccountIds`，在单账号模式下会让 `/api/proxy/*` 返回 200、
 * 池里也真有那个账号，但反代下一个请求仍打旧号（`proxyServer.ts:1582-1584`
 * 在单账号模式取号读 `selectedAccountIds[0]`，`currentIndex` 不被消费）。
 *
 * 所以选号的判据必须是「池里有该账号 **且** `selectedAccountIds[0] === 该 id`」
 * 两条一起 —— 只断言其中任一条都无法排除那个失效。
 *
 * 启停的判据同理不是「接口成功」而是 `isRunning()` 的真实读数
 * （它读 server 句柄，不是"我发了启动请求所以应该在跑"）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { WebPanelServer, type WebPanelConfig } from '../../../src/main/webPanel/server'
import { PanelAuth, type AdminKeyStore } from '../../../src/main/webPanel/auth'
import { PANEL_PATH_PREFIX } from '../../../src/main/webPanel/cookie'
import type { PanelRouteDeps } from '../../../src/main/webPanel/routes'
import { setStoreRef } from '../../../src/main/accountService/state'
import type { AccountStorePort } from '../../../src/main/persistence/accountStorePort'
import { AccountPool } from '../../../src/main/proxy/accountPool'
import {
  activateProxyAccount,
  buildProxyAccountsFromStore,
  type ProxyActivationHost
} from '../../../src/main/proxy/activation'
import type { ProxyConfig } from '../../../src/main/proxy/types'
import { buildPanelProxyDeps, type ProxyServerRef } from '../../../src/main/ipc/panelProxyDeps'

const ADMIN_KEY = 'test-admin-key-0123456789abcdef'
const TOKEN_A = 'ZZtokenAsecretZZ'
const TOKEN_B = 'ZZtokenBsecretZZ'

function memoryKeyStore(): AdminKeyStore {
  let key: string | null = ADMIN_KEY
  return {
    get: () => key,
    set: (k) => {
      key = k
    }
  }
}

function accountRecords(): Record<string, unknown> {
  return {
    'acc-a': {
      id: 'acc-a',
      email: 'a@example.com',
      status: 'active',
      groupId: 'g1',
      credentials: { accessToken: TOKEN_A, refreshToken: 'rt-a', authMethod: 'IdC' }
    },
    'acc-b': {
      id: 'acc-b',
      email: 'b@example.com',
      status: 'active',
      credentials: { accessToken: TOKEN_B, refreshToken: 'rt-b', authMethod: 'social' }
    },
    // 被挡在池外的号：判据是 lastError 里的封禁原文，不是 status
    // （`activation.ts checkPoolAdmission`）。只有 status:'error' 的号是
    // 「上次测活时网没通」，那种必须照常入池。
    'acc-dead': {
      id: 'acc-dead',
      email: 'dead@example.com',
      status: 'error',
      lastError: 'AccountSuspendedException: account is suspended',
      credentials: { accessToken: 'ZZdeadZZ' }
    }
  }
}

/**
 * 反代替身 —— 真 AccountPool + 真实的 running 状态机（绑一个真 TCP 端口）。
 *
 * 用真 pool 而不是 mock：这批用例要证明的是「池里到底有没有那个账号」，
 * 对 mock 断言等于什么都没证明。
 */
interface ProxyStub {
  pool: AccountPool
  config: Partial<ProxyConfig>
  host: ProxyActivationHost
  records: Record<string, unknown>
  readonly affinityDrops: number
  readonly releaseCalls: number
  readonly heldCount: number
  readonly persistedConfig: Partial<ProxyConfig>
  readonly persistCalls: number
  isRunning: () => boolean
  start: () => Promise<void>
  stop: () => Promise<void>
  blockRelease: () => void
  openRelease: () => void
  releaseHeld: () => Promise<number>
  syncFromStore: () => number
  persistConfig: (next: ProxyConfig) => void
}

function makeProxyStub(opts: { enableMultiAccount?: boolean; heldCount?: number } = {}): ProxyStub {
  const pool = new AccountPool()
  const config: Partial<ProxyConfig> = {
    port: 5580,
    host: '127.0.0.1',
    enableMultiAccount: opts.enableMultiAccount ?? false,
    selectedAccountIds: []
  }
  let running = false
  let affinityDrops = 0
  const records = accountRecords()
  // 挂起门闸替身:放行 = 把当前挂起条目全部认领并清空(与 HoldGate.releaseAll 的幂等语义一致)
  let held = opts.heldCount ?? 0
  let releaseCalls = 0
  // 放行闸门:装上后放行会卡住,用于制造两个请求**真正重叠**的窗口。
  // 不装时放行是同步的 —— 那种情况下两次连点不会重叠,singleFlight 也就无从去重。
  let releaseGate: Promise<void> | null = null
  let openGate: (() => void) | null = null
  let persistedConfig: Partial<ProxyConfig> = { ...config }
  let persistCalls = 0

  const host: ProxyActivationHost = {
    isRunning: () => running,
    getAccountPool: () => pool,
    getConfig: () => config as ProxyConfig,
    updateConfig: (patch) => Object.assign(config, patch),
    invalidateSessionAffinity: () => {
      affinityDrops++
      return affinityDrops
    },
    loadAccountRecords: () => records
  }

  return {
    pool,
    config,
    host,
    records,
    get affinityDrops() {
      return affinityDrops
    },
    get releaseCalls() {
      return releaseCalls
    },
    get heldCount() {
      return held
    },
    get persistedConfig() {
      return persistedConfig
    },
    get persistCalls() {
      return persistCalls
    },
    isRunning: () => running,
    start: async () => {
      running = true
    },
    stop: async () => {
      running = false
    },
    /** 让后续放行卡住，直到 openRelease() 被调用（制造真实重叠窗口） */
    blockRelease: () => {
      releaseGate = new Promise<void>((resolve) => {
        openGate = resolve
      })
    },
    openRelease: () => {
      openGate?.()
    },
    /** 放行:认领全部挂起条目。已空时返回 0(幂等,不报错) */
    releaseHeld: async () => {
      releaseCalls++
      if (releaseGate) await releaseGate
      const n = held
      held = 0
      return n
    },
    syncFromStore: () => {
      const accounts = buildProxyAccountsFromStore(records)
      pool.clear()
      for (const a of accounts) pool.addAccount(a)
      return pool.size
    },
    persistConfig: (next: ProxyConfig) => {
      persistCalls++
      persistedConfig = { ...next }
    }
  }
}

/** 把反代替身接成 PanelRouteDeps 的 proxy 侧实现（镜像生产装配的形状） */
function proxyDeps(
  stub: ReturnType<typeof makeProxyStub>
): Pick<
  PanelRouteDeps,
  | 'proxyGetStatus'
  | 'proxySyncPool'
  | 'proxyActivateAccount'
  | 'proxyStart'
  | 'proxyStop'
  | 'proxyReleaseHeld'
> {
  return {
    proxyGetStatus: async () => ({
      success: true,
      running: stub.isRunning(),
      port: stub.config.port,
      host: stub.config.host,
      enableMultiAccount: stub.config.enableMultiAccount === true,
      selectedAccountId: stub.config.selectedAccountIds?.[0],
      poolSize: stub.pool.size,
      availableCount: stub.pool.availableCount,
      inFlightRequests: 0,
      // 自动放行读数(决策卡 §3 三字段):null = 没有下一次,绝不用 0 表达「无」
      autoReleaseEnabled: stub.isRunning() && stub.heldCount > 0,
      nextAutoReleaseAt: stub.isRunning() && stub.heldCount > 0 ? 1_800_000_000_000 : null,
      autoReleaseCount: 2
    }),
    proxySyncPool: async () => ({ success: true, poolSize: stub.syncFromStore() }),
    proxyActivateAccount: async (accountId: string) => {
      const r = activateProxyAccount(accountId, stub.host)
      return r.applied ? { success: true, ...r } : { success: false, error: r.reason }
    },
    proxyStart: async () => {
      const synced = stub.syncFromStore()
      // 空池启动是负条件之一：起来了、状态正常、每个请求都失败
      if (synced === 0) return { success: false, error: 'EMPTY_POOL' }
      await stub.start()
      return { success: true, running: stub.isRunning(), port: stub.config.port }
    },
    proxyStop: async () => {
      await stub.stop()
      return { success: true, running: stub.isRunning() }
    },
    proxyReleaseHeld: async () => {
      // 反代没跑就没有挂起集合。不隐式启动 —— 与其它写端点一致的 409 语义
      if (!stub.isRunning()) return { success: false, error: 'PROXY_NOT_RUNNING' }
      return { success: true, released: await stub.releaseHeld() }
    }
  }
}

function stubRouteDeps(
  stub: ReturnType<typeof makeProxyStub>,
  loadAccountsBlob: () => Promise<unknown> = async () => ({
    revision: 1,
    accounts: stub.records
  }),
  loadAccountData: () => Record<string, unknown> = () => ({ accounts: stub.records })
): PanelRouteDeps {
  const serverRef: ProxyServerRef = {
    isRunning: stub.isRunning,
    getAccountPool: () => stub.pool,
    getConfig: () => stub.config as ProxyConfig,
    updateConfig: (patch) => Object.assign(stub.config, patch),
    invalidateSessionAffinity: () => 0,
    start: stub.start,
    stop: stub.stop,
    restartServer: async () => {
      await stub.stop()
      await stub.start()
    },
    needsRestart: () => false,
    getStats: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0 }),
    getHoldAutoReleaseState: () => ({
      autoReleaseEnabled: false,
      nextAutoReleaseAt: null,
      autoReleaseCount: 0
    }),
    getHeldRequestsInfo: () => ({
      count: stub.heldCount,
      autoReleaseEnabled: false,
      nextAutoReleaseAt: null,
      autoReleaseCount: 0,
      currentEpisode: null,
      recentEpisodes: []
    }),
    releaseHeldRequests: () => 0
  }
  const configDeps = buildPanelProxyDeps({
    getProxyServer: () => serverRef,
    initProxyServer: () => serverRef,
    getLatestProxyConfig: () => stub.config as ProxyConfig,
    loadAccountData: () => loadAccountData() as { accounts?: Record<string, unknown> },
    persistProxyConfig: stub.persistConfig
  })
  return {
    loadAccountsBlob,
    checkAccountStatus: async () => ({ success: true }),
    refreshAccountToken: async () => ({ success: true }),
    switchAccountToIde: async () => ({ success: true }),
    switchAccountToCli: async () => ({ success: true }),
    logoutFromIde: async () => ({ success: true }),
    getAccountModels: async () => ({ success: true, models: [] }),
    getAccountSubscriptions: async () => ({ success: true }),
    getAccountSubscriptionUrl: async () => ({ success: true }),
    setAccountOverage: async () => ({ success: true }),
    ...proxyDeps(stub),
    proxyGetConfig: configDeps.proxyGetConfig,
    proxyUpdateConfig: configDeps.proxyUpdateConfig,
    proxyChangePort: configDeps.proxyChangePort,
    proxyListApiKeys: configDeps.proxyListApiKeys,
    proxyCreateApiKey: configDeps.proxyCreateApiKey,
    proxyVerifyApiKey: configDeps.proxyVerifyApiKey,
    proxyRevokeApiKey: configDeps.proxyRevokeApiKey,
    proxyClearAccountSuspended: (
      configDeps as unknown as {
        proxyClearAccountSuspended?: (accountId: string) => Promise<Record<string, unknown>>
      }
    ).proxyClearAccountSuspended
  } as PanelRouteDeps
}

const servers: WebPanelServer[] = []

function makeServer(
  stub: ReturnType<typeof makeProxyStub>,
  config: Partial<WebPanelConfig> = {},
  loadAccountsBlob?: () => Promise<unknown>,
  loadAccountData?: () => Record<string, unknown>
): WebPanelServer {
  const server = new WebPanelServer({
    auth: new PanelAuth(memoryKeyStore()),
    routeDeps: stubRouteDeps(stub, loadAccountsBlob, loadAccountData),
    getConfig: () => ({ enabled: true, port: 0, host: '127.0.0.1', ...config })
  })
  servers.push(server)
  return server
}

afterEach(async () => {
  while (servers.length)
    await servers
      .pop()
      ?.stop()
      .catch(() => undefined)
})

function base(server: WebPanelServer): string {
  const addr = server.getListeningAddress()
  if (!addr) throw new Error('not listening')
  return `http://127.0.0.1:${addr.port}${PANEL_PATH_PREFIX}`
}

async function login(server: WebPanelServer, adminKey = ADMIN_KEY): Promise<string> {
  const res = await fetch(`${base(server)}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Panel-Request': '1' },
    body: JSON.stringify({ adminKey })
  })
  const c = res.headers.get('set-cookie')
  if (!c) throw new Error(`login failed ${res.status}`)
  return c.split(';')[0]
}

function authed(cookie: string): Record<string, string> {
  return { Cookie: cookie, 'X-Panel-Request': '1', 'Content-Type': 'application/json' }
}

describe('面板反代端点 · 鉴权闸门（启停是高影响操作）', () => {
  it('未登录访问 proxy 端点一律 401（不泄漏运行态）', async () => {
    const stub = makeProxyStub()
    const server = makeServer(stub)
    await server.start()
    for (const [method, path] of [
      ['GET', '/api/proxy/status'],
      ['POST', '/api/proxy/start'],
      ['POST', '/api/proxy/stop'],
      ['POST', '/api/proxy/active-account'],
      ['POST', '/api/proxy/release-held'],
      ['GET', '/api/proxy/config'],
      ['POST', '/api/proxy/config'],
      ['POST', '/api/proxy/config/port'],
      ['GET', '/api/proxy/api-keys'],
      ['POST', '/api/proxy/api-keys/create'],
      ['POST', '/api/proxy/api-keys/verify'],
      ['POST', '/api/proxy/api-keys/revoke'],
      ['POST', '/api/accounts/acc-a/unsuspend']
    ] as const) {
      const res = await fetch(`${base(server)}${path}`, {
        method,
        headers: { 'X-Panel-Request': '1', 'Content-Type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({ accountId: 'acc-a' }) : undefined
      })
      expect(res.status, `${method} ${path}`).toBe(401)
    }
    expect(stub.isRunning()).toBe(false)
  })

  it('写操作缺 CSRF 头 → 401，且没有产生副作用', async () => {
    const stub = makeProxyStub()
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)
    const res = await fetch(`${base(server)}/api/proxy/start`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' }
    })
    expect(res.status).toBe(401)
    expect(stub.isRunning()).toBe(false)
  })
})

describe('C6 · adminKey 轮换端点', () => {
  it('统一 guard 拒绝未登录和缺 CSRF；成功只交付一次新 key 并失效旧会话与旧密钥', async () => {
    const server = makeServer(makeProxyStub())
    await server.start()

    const anonymous = await fetch(`${base(server)}/api/admin-key/rotate`, {
      method: 'POST',
      headers: { 'X-Panel-Request': '1' }
    })
    expect(anonymous.status).toBe(401)

    const oldCookie = await login(server)
    const missingCsrf = await fetch(`${base(server)}/api/admin-key/rotate`, {
      method: 'POST',
      headers: { Cookie: oldCookie }
    })
    expect(missingCsrf.status).toBe(401)
    expect(
      (await fetch(`${base(server)}/api/accounts`, { headers: { Cookie: oldCookie } })).status
    ).toBe(200)

    const rotated = await fetch(`${base(server)}/api/admin-key/rotate`, {
      method: 'POST',
      headers: authed(oldCookie)
    })
    expect(rotated.status).toBe(200)
    expect(rotated.headers.get('cache-control')).toBe('no-store')
    const payload = (await rotated.json()) as Record<string, unknown>
    expect(payload).not.toHaveProperty('adminKey')
    expect(typeof payload.key).toBe('string')
    expect((payload.key as string).length).toBeGreaterThanOrEqual(40)

    expect(
      (await fetch(`${base(server)}/api/accounts`, { headers: { Cookie: oldCookie } })).status
    ).toBe(401)
    const oldKeyLogin = await fetch(`${base(server)}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Panel-Request': '1' },
      body: JSON.stringify({ adminKey: ADMIN_KEY })
    })
    expect(oldKeyLogin.status).toBe(401)
    const newCookie = await login(server, payload.key as string)
    expect(
      (await fetch(`${base(server)}/api/accounts`, { headers: { Cookie: newCookie } })).status
    ).toBe(200)
  })
})

describe('面板反代端点 · 选号（单账号模式）', () => {
  it('选号后：池里有该账号 **且** selectedAccountIds[0] 是它（两条一起才排除已实证失效）', async () => {
    const stub = makeProxyStub({ enableMultiAccount: false })
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)

    // 先启动（编排要求先同步池）
    const startRes = await fetch(`${base(server)}/api/proxy/start`, {
      method: 'POST',
      headers: authed(cookie)
    })
    expect(startRes.status).toBe(200)
    expect(stub.isRunning(), '反代必须真的在运行').toBe(true)

    const res = await fetch(`${base(server)}/api/proxy/active-account`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ accountId: 'acc-b' })
    })
    expect(res.status).toBe(200)

    // 判据 1：池里真有它，且凭据是盘上现读的那份
    expect(stub.pool.getAccount('acc-b')?.accessToken).toBe(TOKEN_B)
    // 判据 2：单账号模式的真开关 —— 缺这条就是「接口成功但反代打旧号」
    expect(stub.config.selectedAccountIds).toEqual(['acc-b'])
    // 判据 3：会话粘性已作废（否则带固定 session id 的客户端粘在旧号）
    expect(stub.affinityDrops).toBeGreaterThan(0)
  })

  it('反代未运行时选号 → 明确失败，不静默成功', async () => {
    const stub = makeProxyStub()
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)
    const res = await fetch(`${base(server)}/api/proxy/active-account`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ accountId: 'acc-a' })
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(stub.config.selectedAccountIds).toEqual([])
  })

  it('选一个不存在的账号 → 失败且不写 config', async () => {
    const stub = makeProxyStub()
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)
    await fetch(`${base(server)}/api/proxy/start`, { method: 'POST', headers: authed(cookie) })
    const res = await fetch(`${base(server)}/api/proxy/active-account`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ accountId: 'ghost' })
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(stub.config.selectedAccountIds).toEqual([])
  })

  it('缺 accountId → 400（不把 undefined 当"清空指定"）', async () => {
    const stub = makeProxyStub()
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)
    const res = await fetch(`${base(server)}/api/proxy/active-account`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({})
    })
    expect(res.status).toBe(400)
  })
})

describe('面板反代端点 · 启停（真实状态，非乐观更新）', () => {
  it('启动前先同步池 —— 池里有账号才算启动成功（防空池启动）', async () => {
    const stub = makeProxyStub()
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)
    expect(stub.pool.size, '启动前池是空的').toBe(0)

    const res = await fetch(`${base(server)}/api/proxy/start`, {
      method: 'POST',
      headers: authed(cookie)
    })
    expect(res.status).toBe(200)
    // 只收有凭据且未被后端拒绝的两个，acc-dead（封禁）被过滤
    expect(stub.pool.size).toBe(2)
    expect(stub.isRunning()).toBe(true)
  })

  it('状态端点读的是真实运行态，不是"我发过启动请求"', async () => {
    const stub = makeProxyStub()
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)

    const before = await (
      await fetch(`${base(server)}/api/proxy/status`, { headers: authed(cookie) })
    ).json()
    expect(before.running).toBe(false)

    await fetch(`${base(server)}/api/proxy/start`, { method: 'POST', headers: authed(cookie) })
    const after = await (
      await fetch(`${base(server)}/api/proxy/status`, { headers: authed(cookie) })
    ).json()
    expect(after.running).toBe(true)
    expect(after.port).toBe(5580)
    expect(after.poolSize).toBe(2)
  })

  it('状态端点回传当前选中账号（手机上要能看到"正在用哪个号"）', async () => {
    const stub = makeProxyStub({ enableMultiAccount: false })
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)
    await fetch(`${base(server)}/api/proxy/start`, { method: 'POST', headers: authed(cookie) })
    await fetch(`${base(server)}/api/proxy/active-account`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ accountId: 'acc-a' })
    })
    const status = await (
      await fetch(`${base(server)}/api/proxy/status`, { headers: authed(cookie) })
    ).json()
    expect(status.selectedAccountId).toBe('acc-a')
  })

  it('停止后运行态变 false（判据来自真实读数）', async () => {
    const stub = makeProxyStub()
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)
    await fetch(`${base(server)}/api/proxy/start`, { method: 'POST', headers: authed(cookie) })
    expect(stub.isRunning()).toBe(true)

    const res = await fetch(`${base(server)}/api/proxy/stop`, {
      method: 'POST',
      headers: authed(cookie)
    })
    expect(res.status).toBe(200)
    expect(stub.isRunning()).toBe(false)
    const status = await (
      await fetch(`${base(server)}/api/proxy/status`, { headers: authed(cookie) })
    ).json()
    expect(status.running).toBe(false)
  })

  it('连点启动两次是幂等的（单飞去重，不产生两个服务）', async () => {
    const stub = makeProxyStub()
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)
    const [r1, r2] = await Promise.all([
      fetch(`${base(server)}/api/proxy/start`, { method: 'POST', headers: authed(cookie) }),
      fetch(`${base(server)}/api/proxy/start`, { method: 'POST', headers: authed(cookie) })
    ])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(stub.pool.size).toBe(2)
    expect(stub.isRunning()).toBe(true)
  })
})

describe('面板反代端点 · 手动放行挂起请求（决策卡 §3 手机端契约）', () => {
  it('放行返回实际放行数，且挂起集合被清空', async () => {
    const stub = makeProxyStub({ heldCount: 3 })
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)
    await fetch(`${base(server)}/api/proxy/start`, { method: 'POST', headers: authed(cookie) })

    const res = await fetch(`${base(server)}/api/proxy/release-held`, {
      method: 'POST',
      headers: authed(cookie)
    })
    expect(res.status).toBe(200)
    expect((await res.json()).released).toBe(3)
    // 判据不是「接口成功」而是真实副作用:集合真的空了
    expect(stub.heldCount).toBe(0)
  })

  it('无挂起条目时放行 → 200 released=0，不是错误（放行本身幂等）', async () => {
    const stub = makeProxyStub({ heldCount: 0 })
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)
    await fetch(`${base(server)}/api/proxy/start`, { method: 'POST', headers: authed(cookie) })

    const res = await fetch(`${base(server)}/api/proxy/release-held`, {
      method: 'POST',
      headers: authed(cookie)
    })
    expect(res.status).toBe(200)
    expect((await res.json()).released).toBe(0)
  })

  it('反代未运行时放行 → 409 PROXY_NOT_RUNNING，不静默成功', async () => {
    const stub = makeProxyStub({ heldCount: 2 })
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)

    const res = await fetch(`${base(server)}/api/proxy/release-held`, {
      method: 'POST',
      headers: authed(cookie)
    })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('PROXY_NOT_RUNNING')
    // 没跑就不该产生副作用
    expect(stub.releaseCalls).toBe(0)
  })

  it('手机连点放行 → 单飞去重，只真执行一次', async () => {
    const stub = makeProxyStub({ heldCount: 5 })
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)
    await fetch(`${base(server)}/api/proxy/start`, { method: 'POST', headers: authed(cookie) })

    // 制造真实重叠窗口：放行卡住不返回，第二次连点必然落在第一次执行期间。
    // 不卡住就无法测出 singleFlight —— 同步放行下第一次早已 finally 清掉去重键，
    // 第二次是全新执行，`releaseCalls` 必然是 2。这个测试要证明的是
    // 「重叠时共享一次执行」，所以重叠必须真实存在（详见交付报告的评审发现）。
    stub.blockRelease()
    const p1 = fetch(`${base(server)}/api/proxy/release-held`, {
      method: 'POST',
      headers: authed(cookie)
    })
    const p2 = fetch(`${base(server)}/api/proxy/release-held`, {
      method: 'POST',
      headers: authed(cookie)
    })
    // 让两个请求都到达路由层并进入 singleFlight，再放开闸门
    await new Promise((r) => setTimeout(r, 30))
    stub.openRelease()
    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    // 承重判据:两个请求共享同一次执行。若各自执行,底层会被调两次,
    // 且第二次拿到的是已被清空的集合 → released=0。
    expect(stub.releaseCalls).toBe(1)
    expect((await r1.json()).released).toBe(5)
    expect((await r2.json()).released).toBe(5)
  })

  it('写操作缺 CSRF 头 → 401，且没有产生放行副作用', async () => {
    const stub = makeProxyStub({ heldCount: 4 })
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)
    await fetch(`${base(server)}/api/proxy/start`, { method: 'POST', headers: authed(cookie) })

    const res = await fetch(`${base(server)}/api/proxy/release-held`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' }
    })
    expect(res.status).toBe(401)
    expect(stub.heldCount).toBe(4)
  })

  it('GET 该路径不被当作放行处理（写操作只认 POST）', async () => {
    const stub = makeProxyStub({ heldCount: 4 })
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)
    await fetch(`${base(server)}/api/proxy/start`, { method: 'POST', headers: authed(cookie) })

    const res = await fetch(`${base(server)}/api/proxy/release-held`, { headers: authed(cookie) })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(stub.releaseCalls).toBe(0)
  })
})

describe('面板反代端点 · 自动放行读数（倒计时靠绝对时间戳，不靠轮询数值）', () => {
  it('status 带三字段：enabled / 绝对时间戳 / 累计次数', async () => {
    const stub = makeProxyStub({ heldCount: 1 })
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)
    await fetch(`${base(server)}/api/proxy/start`, { method: 'POST', headers: authed(cookie) })

    const status = await (
      await fetch(`${base(server)}/api/proxy/status`, { headers: authed(cookie) })
    ).json()
    expect(status.autoReleaseEnabled).toBe(true)
    // 绝对 epoch ms —— 前端本地自减渲染倒计时,主进程不推倒计时数值
    expect(status.nextAutoReleaseAt).toBe(1_800_000_000_000)
    expect(status.autoReleaseCount).toBe(2)
  })

  it('无下一次放行时 nextAutoReleaseAt 是 null 而不是 0（0 是合法 epoch）', async () => {
    const stub = makeProxyStub({ heldCount: 0 })
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)

    const status = await (
      await fetch(`${base(server)}/api/proxy/status`, { headers: authed(cookie) })
    ).json()
    expect(status.nextAutoReleaseAt).toBeNull()
    expect(status.nextAutoReleaseAt).not.toBe(0)
  })
})

describe('面板反代端点 · 输出脱敏（凭据绝不出网）', () => {
  it('status / 选号响应里不含任何 token 子串', async () => {
    const stub = makeProxyStub()
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)
    await fetch(`${base(server)}/api/proxy/start`, { method: 'POST', headers: authed(cookie) })
    const activate = await fetch(`${base(server)}/api/proxy/active-account`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ accountId: 'acc-a' })
    })
    const statusText = await (
      await fetch(`${base(server)}/api/proxy/status`, { headers: authed(cookie) })
    ).text()
    const activateText = await activate.text()
    for (const body of [statusText, activateText]) {
      expect(body).not.toContain(TOKEN_A)
      expect(body).not.toContain(TOKEN_B)
      expect(body).not.toContain('rt-a')
    }
  })
})

interface MemoryAccountStore extends AccountStorePort {
  snapshot: () => Record<string, unknown>
}

function memoryAccountStore(initial: Record<string, unknown>): MemoryAccountStore {
  let accountData = structuredClone(initial)
  return {
    path: 'F:\\test\\kiro-accounts.json',
    get: (key: string, defaultValue?: unknown) =>
      key === 'accountData' ? structuredClone(accountData) : defaultValue,
    set: (key: string, value: unknown) => {
      if (key === 'accountData') accountData = structuredClone(value) as Record<string, unknown>
    },
    snapshot: () => structuredClone(accountData)
  }
}

function accountManagementFixture(): Record<string, unknown> {
  return {
    revision: 4,
    groups: {
      g1: { id: 'g1', name: '主力', color: '#10b981', order: 1, createdAt: 1 },
      g2: { id: 'g2', name: '备用', color: '#64748b', order: 2, createdAt: 2 }
    },
    accounts: {
      ...accountRecords(),
      'acc-a': {
        ...accountRecords()['acc-a'],
        nickname: '旧备注',
        groupId: 'g1',
        isActive: true
      }
    },
    activeAccountId: 'acc-a',
    accountProxyBindings: { 'acc-a': 'proxy-1', 'acc-b': 'proxy-2' }
  }
}

describe('面板账号管理端点 · 鉴权与 revision 仲裁', () => {
  it('每条新增路由在未登录时都被统一 guard 拒绝，且没有副作用', async () => {
    const store = memoryAccountStore(accountManagementFixture())
    setStoreRef(store)
    const stub = makeProxyStub()
    const server = makeServer(stub, {}, async () => store.get('accountData'))
    await server.start()
    const before = store.snapshot()

    for (const [method, path, body] of [
      ['GET', '/api/account-groups', undefined],
      [
        'PATCH',
        '/api/accounts/acc-a',
        { expectedRevision: 4, nickname: '未授权修改', groupId: 'g2' }
      ],
      ['POST', '/api/accounts/acc-a/delete', { expectedRevision: 4 }],
      ['POST', '/api/accounts/acc-a/restore', undefined]
    ] as const) {
      const res = await fetch(`${base(server)}${path}`, {
        method,
        headers: { 'X-Panel-Request': '1', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
      expect(res.status, `${method} ${path}`).toBe(401)
    }
    expect(store.snapshot()).toEqual(before)
  })

  it('每条新增写路由即使有会话，缺 CSRF 头也被统一 guard 拒绝', async () => {
    const store = memoryAccountStore(accountManagementFixture())
    setStoreRef(store)
    const stub = makeProxyStub()
    const server = makeServer(stub, {}, async () => store.get('accountData'))
    await server.start()
    const cookie = await login(server)
    const before = store.snapshot()

    for (const [method, path, body] of [
      [
        'PATCH',
        '/api/accounts/acc-a',
        { expectedRevision: 4, nickname: '绕过 CSRF', groupId: 'g2' }
      ],
      ['POST', '/api/accounts/acc-a/delete', { expectedRevision: 4 }],
      ['POST', '/api/accounts/acc-a/restore', undefined]
    ] as const) {
      const res = await fetch(`${base(server)}${path}`, {
        method,
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
      expect(res.status, `${method} ${path}`).toBe(401)
    }
    expect(store.snapshot()).toEqual(before)
  })

  it('编辑只改备注和分组、保留凭据，并用 expectedRevision 拒绝陈旧覆盖', async () => {
    const store = memoryAccountStore(accountManagementFixture())
    setStoreRef(store)
    const stub = makeProxyStub()
    const server = makeServer(stub, {}, async () => store.get('accountData'))
    await server.start()
    const cookie = await login(server)

    const edited = await fetch(`${base(server)}/api/accounts/acc-a`, {
      method: 'PATCH',
      headers: authed(cookie),
      body: JSON.stringify({ expectedRevision: 4, nickname: '手机备注', groupId: 'g2' })
    })
    expect(edited.status).toBe(200)
    expect(await edited.json()).toMatchObject({
      success: true,
      revision: 5,
      account: { id: 'acc-a', nickname: '手机备注', groupId: 'g2' }
    })

    const afterEdit = store.snapshot()
    const editedAccount = (afterEdit.accounts as Record<string, Record<string, unknown>>)['acc-a']
    expect(editedAccount.nickname).toBe('手机备注')
    expect(editedAccount.groupId).toBe('g2')
    expect(editedAccount.credentials).toEqual({
      accessToken: TOKEN_A,
      refreshToken: 'rt-a',
      authMethod: 'IdC'
    })

    const stale = await fetch(`${base(server)}/api/accounts/acc-a`, {
      method: 'PATCH',
      headers: authed(cookie),
      body: JSON.stringify({ expectedRevision: 4, nickname: '陈旧覆盖' })
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ code: 'STALE_REVISION' })
    const afterStale = store.snapshot()
    expect((afterStale.accounts as Record<string, Record<string, unknown>>)['acc-a'].nickname).toBe(
      '手机备注'
    )

    const credentialEdit = await fetch(`${base(server)}/api/accounts/acc-a`, {
      method: 'PATCH',
      headers: authed(cookie),
      body: JSON.stringify({
        expectedRevision: 5,
        credentials: { accessToken: 'attacker-controlled-token' }
      })
    })
    expect(credentialEdit.status).toBe(400)
    expect(
      (
        (store.snapshot().accounts as Record<string, Record<string, unknown>>)['acc-a']
          .credentials as Record<string, unknown>
      ).accessToken
    ).toBe(TOKEN_A)
  })

  it('删除清理激活态和代理绑定，并可在当前服务进程的 10 分钟窗口内撤销', async () => {
    const store = memoryAccountStore(accountManagementFixture())
    setStoreRef(store)
    const stub = makeProxyStub()
    // 让反代替身与该用例的持久化端口读同一份真值。删除若只改盘、不重建运行中池，
    // 旧 accessToken 仍会继续被反代选中，是「接口成功但最终消费者没变」的半接线。
    stub.syncFromStore = () => {
      const records = store.snapshot().accounts as Record<string, unknown>
      return stub.pool.replaceAll(buildProxyAccountsFromStore(records))
    }
    stub.syncFromStore()
    expect(stub.pool.getAccount('acc-a')).toBeDefined()
    const server = makeServer(stub, {}, async () => store.get('accountData'))
    await server.start()
    const cookie = await login(server)

    const deleted = await fetch(`${base(server)}/api/accounts/acc-a/delete`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ expectedRevision: 4 })
    })
    expect(deleted.status).toBe(200)
    const deletedBody = (await deleted.json()) as {
      revision: number
      undoUntil: number
      proxyPoolSyncPending: boolean
    }
    expect(deletedBody.revision).toBe(5)
    expect(deletedBody.undoUntil).toBeGreaterThan(Date.now())
    expect(deletedBody.proxyPoolSyncPending).toBe(false)

    const afterDelete = store.snapshot()
    expect((afterDelete.accounts as Record<string, unknown>)['acc-a']).toBeUndefined()
    expect(afterDelete.activeAccountId).toBeNull()
    expect((afterDelete.accountProxyBindings as Record<string, unknown>)['acc-a']).toBeUndefined()
    expect((afterDelete.accountProxyBindings as Record<string, unknown>)['acc-b']).toBe('proxy-2')
    expect(stub.pool.getAccount('acc-a')).toBeNull()

    const restored = await fetch(`${base(server)}/api/accounts/acc-a/restore`, {
      method: 'POST',
      headers: authed(cookie)
    })
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({
      success: true,
      revision: 6,
      account: { id: 'acc-a', nickname: '旧备注', groupId: 'g1', isActive: false },
      proxyPoolSyncPending: false
    })

    const afterRestore = store.snapshot()
    expect((afterRestore.accounts as Record<string, unknown>)['acc-a']).toBeDefined()
    expect(afterRestore.activeAccountId).toBeNull()
    expect((afterRestore.accountProxyBindings as Record<string, unknown>)['acc-a']).toBe('proxy-1')
    expect(stub.pool.getAccount('acc-a')?.accessToken).toBe(TOKEN_A)
  })

  it('账号已落盘但运行池同步失败时仍如实返回成功，并标出待手动同步', async () => {
    const store = memoryAccountStore(accountManagementFixture())
    setStoreRef(store)
    const stub = makeProxyStub()
    stub.syncFromStore = () => {
      throw new Error('synthetic pool rebuild failure')
    }
    const server = makeServer(stub, {}, async () => store.get('accountData'))
    await server.start()
    const cookie = await login(server)

    const deleted = await fetch(`${base(server)}/api/accounts/acc-a/delete`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ expectedRevision: 4 })
    })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toMatchObject({
      success: true,
      revision: 5,
      proxyPoolSyncPending: true
    })
    expect((store.snapshot().accounts as Record<string, unknown>)['acc-a']).toBeUndefined()
  })

  it('分组选项只返回手机编辑所需白名单字段', async () => {
    const store = memoryAccountStore(accountManagementFixture())
    setStoreRef(store)
    const stub = makeProxyStub()
    const server = makeServer(stub, {}, async () => store.get('accountData'))
    await server.start()
    const cookie = await login(server)

    const res = await fetch(`${base(server)}/api/account-groups`, {
      headers: authed(cookie)
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      groups: [
        { id: 'g1', name: '主力', color: '#10b981', order: 1 },
        { id: 'g2', name: '备用', color: '#64748b', order: 2 }
      ]
    })
  })

  it('强制解除封禁路由拒绝未认证请求；认证后同时清盘上标记和真实 AccountPool 闩锁', async () => {
    const fixture = accountManagementFixture()
    const accounts = fixture.accounts as Record<string, Record<string, unknown>>
    accounts['acc-a'] = {
      ...accounts['acc-a'],
      status: 'error',
      lastError: '[TEMPORARILY_SUSPENDED] Account blocked by upstream'
    }
    const store = memoryAccountStore(fixture)
    setStoreRef(store)
    const stub = makeProxyStub()
    stub.pool.addAccount({
      id: 'acc-a',
      email: 'a@example.com',
      accessToken: TOKEN_A,
      isAvailable: false,
      suspendedAt: Date.now(),
      suspendReason: 'TEMPORARILY_SUSPENDED'
    })
    const server = makeServer(
      stub,
      {},
      async () => store.get('accountData'),
      () => store.get('accountData') as Record<string, unknown>
    )
    await server.start()

    const anonymous = await fetch(`${base(server)}/api/accounts/acc-a/unsuspend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Panel-Request': '1' },
      body: JSON.stringify({ confirmation: 'FORCE_UNSUSPEND' })
    })
    expect(anonymous.status).toBe(401)
    expect(stub.pool.isSuspended(stub.pool.getAccount('acc-a')!)).toBe(true)
    expect(
      (store.snapshot().accounts as Record<string, Record<string, unknown>>)['acc-a']
        .lastError as string
    ).toContain('TEMPORARILY_SUSPENDED')

    const cookie = await login(server)
    const rejectedConfirmation = await fetch(`${base(server)}/api/accounts/acc-a/unsuspend`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ confirmation: 'WRONG' })
    })
    expect(rejectedConfirmation.status).toBe(400)
    expect(stub.pool.isSuspended(stub.pool.getAccount('acc-a')!)).toBe(true)

    const cleared = await fetch(`${base(server)}/api/accounts/acc-a/unsuspend`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ confirmation: 'FORCE_UNSUSPEND' })
    })

    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toMatchObject({
      success: true,
      cleared: true,
      upstreamVerified: false,
      account: { id: 'acc-a', status: 'active' },
      runtime: {
        proxyInitialized: true,
        inProxyPool: true,
        suspended: false,
        proxyPoolSyncPending: false
      }
    })
    const persisted = (store.snapshot().accounts as Record<string, Record<string, unknown>>)[
      'acc-a'
    ]
    expect(persisted.status).toBe('active')
    expect(persisted.lastError).toBeUndefined()
    const runtime = stub.pool.getAccount('acc-a')
    expect(runtime).not.toBeNull()
    expect(stub.pool.isSuspended(runtime!)).toBe(false)

    const genericFailureSnapshot = store.snapshot()
    const genericFailure = (
      genericFailureSnapshot.accounts as Record<string, Record<string, unknown>>
    )['acc-b']
    genericFailure.status = 'error'
    genericFailure.lastError = 'temporary network failure'
    await store.set('accountData', genericFailureSnapshot)

    const noSuspensionToClear = await fetch(`${base(server)}/api/accounts/acc-b/unsuspend`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ confirmation: 'FORCE_UNSUSPEND' })
    })
    expect(noSuspensionToClear.status).toBe(200)
    expect(await noSuspensionToClear.json()).toMatchObject({
      success: true,
      cleared: false,
      upstreamVerified: false,
      account: {
        id: 'acc-b',
        status: 'error',
        lastError: 'temporary network failure'
      }
    })
    expect(
      (store.snapshot().accounts as Record<string, Record<string, unknown>>)['acc-b']
    ).toMatchObject({
      status: 'error',
      lastError: 'temporary network failure'
    })
  })
})

describe('C1 · 手机面板反代配置', () => {
  it('GET /api/proxy/config 返回显式安全投影而不是内部 ProxyConfig', async () => {
    const stub = makeProxyStub()
    stub.config.logRequests = false
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)

    const res = await fetch(`${base(server)}/api/proxy/config`, {
      headers: authed(cookie)
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      editable: { logRequests: false },
      apiKeys: { configured: false, count: 0, hints: [] },
      proxyListen: { host: '127.0.0.1', port: 5580, requiresRestart: false }
    })
  })

  it('POST /api/proxy/config 走统一 auth/CSRF，合法 patch 真实更新运行态与盘上值', async () => {
    const stub = makeProxyStub()
    stub.config.logRequests = true
    const server = makeServer(stub)
    await server.start()

    const anonymous = await fetch(`${base(server)}/api/proxy/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Panel-Request': '1' },
      body: JSON.stringify({ changes: { logRequests: false } })
    })
    expect(anonymous.status).toBe(401)

    const cookie = await login(server)
    const missingCsrf = await fetch(`${base(server)}/api/proxy/config`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes: { logRequests: false } })
    })
    expect(missingCsrf.status).toBe(401)

    const applied = await fetch(`${base(server)}/api/proxy/config`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ changes: { logRequests: false } })
    })
    expect(applied.status).toBe(200)
    expect(await applied.json()).toMatchObject({
      appliedFields: ['logRequests'],
      requiresRestart: false,
      config: { editable: { logRequests: false } }
    })
    expect(stub.config.logRequests).toBe(false)
    expect(stub.persistedConfig.logRequests).toBe(false)
  })

  it('unknown key 返回 400 INVALID_CONFIG 且运行态与盘上都零副作用', async () => {
    const stub = makeProxyStub()
    stub.config.logRequests = true
    const beforeRuntime = JSON.stringify(stub.config)
    const beforePersisted = JSON.stringify(stub.persistedConfig)
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)

    const res = await fetch(`${base(server)}/api/proxy/config`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ changes: { trustedTlsProxyIPs: ['203.0.113.10'] } })
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringContaining('禁止远程修改')
    })
    expect(JSON.stringify(stub.config)).toBe(beforeRuntime)
    expect(JSON.stringify(stub.persistedConfig)).toBe(beforePersisted)
    expect(stub.persistCalls).toBe(0)
  })

  it('GET 原始响应与普通 POST 响应都不含任何 API key 原值', async () => {
    const secret = 'sk-RAW_RESPONSE_SECRET_01234567890123456789'
    const legacy = 'legacy-RAW_RESPONSE_SECRET'
    const stub = makeProxyStub()
    stub.config.apiKey = legacy
    stub.config.apiKeys = [
      {
        id: 'safe-id-1',
        name: 'must-not-cross-network',
        key: secret,
        format: 'sk',
        enabled: true,
        createdAt: 100,
        usage: {
          totalRequests: 0,
          totalCredits: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          daily: {}
        }
      }
    ]
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)

    const getText = await (
      await fetch(`${base(server)}/api/proxy/config`, { headers: authed(cookie) })
    ).text()
    const postText = await (
      await fetch(`${base(server)}/api/proxy/config`, {
        method: 'POST',
        headers: authed(cookie),
        body: JSON.stringify({ changes: { logRequests: false } })
      })
    ).text()

    for (const text of [getText, postText]) {
      expect(text).not.toContain(secret)
      expect(text).not.toContain(legacy)
      expect(text).not.toContain('must-not-cross-network')
      const payload = JSON.parse(text) as Record<string, unknown>
      expect((payload.config as Record<string, unknown> | undefined) ?? payload).toMatchObject({
        apiKeys: { configured: true, count: 2 }
      })
    }
  })

  it('API Key 创建端点只在成功响应展示一次完整 key，后续列表只回 hint', async () => {
    const stub = makeProxyStub()
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)

    const created = await fetch(`${base(server)}/api/proxy/api-keys/create`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({ confirmation: 'CREATE_PROXY_API_KEY' })
    })
    expect(created.status).toBe(200)
    expect(created.headers.get('cache-control')).toBe('no-store')
    const createdText = await created.text()
    const payload = JSON.parse(createdText) as { key: string; id: string; hint: string }
    expect(payload.key).toMatch(/^sk-[a-f0-9]{48}$/)

    const listedText = await (
      await fetch(`${base(server)}/api/proxy/api-keys`, { headers: authed(cookie) })
    ).text()
    const configText = await (
      await fetch(`${base(server)}/api/proxy/config`, { headers: authed(cookie) })
    ).text()
    expect(listedText).not.toContain(payload.key)
    expect(configText).not.toContain(payload.key)
    expect(listedText).toContain(payload.hint)
  })

  it('端口专用动作完成真实重启后才回新端口，不留下 requiresRestart 假状态', async () => {
    const stub = makeProxyStub()
    await stub.start()
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)

    const changed = await fetch(`${base(server)}/api/proxy/config/port`, {
      method: 'POST',
      headers: authed(cookie),
      body: JSON.stringify({
        port: 5599,
        expectedCurrentPort: 5580,
        confirmation: 'CHANGE_PROXY_PORT'
      })
    })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toMatchObject({
      previousPort: 5580,
      port: 5599,
      restarted: true,
      requiresRestart: false,
      config: { proxyListen: { port: 5599, requiresRestart: false } }
    })
    expect(stub.config.port).toBe(5599)
    expect(stub.persistedConfig.port).toBe(5599)
    expect(stub.isRunning()).toBe(true)
  })
})
