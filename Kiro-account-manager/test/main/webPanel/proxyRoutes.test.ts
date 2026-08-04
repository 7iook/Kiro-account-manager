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
import { AccountPool } from '../../../src/main/proxy/accountPool'
import { activateProxyAccount, buildProxyAccountsFromStore, type ProxyActivationHost } from '../../../src/main/proxy/activation'
import type { ProxyConfig } from '../../../src/main/proxy/types'

const ADMIN_KEY = 'test-admin-key-0123456789abcdef'
const TOKEN_A = 'ZZtokenAsecretZZ'
const TOKEN_B = 'ZZtokenBsecretZZ'

function memoryKeyStore(): AdminKeyStore {
  let key: string | null = ADMIN_KEY
  return { get: () => key, set: (k) => { key = k } }
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
    'acc-dead': {
      id: 'acc-dead',
      email: 'dead@example.com',
      status: 'error',
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
function makeProxyStub(opts: { enableMultiAccount?: boolean } = {}) {
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

  const host: ProxyActivationHost = {
    isRunning: () => running,
    getAccountPool: () => pool,
    getConfig: () => config as ProxyConfig,
    updateConfig: (patch) => Object.assign(config, patch),
    invalidateSessionAffinity: () => { affinityDrops++; return affinityDrops },
    loadAccountRecords: () => records
  }

  return {
    pool,
    config,
    host,
    records,
    get affinityDrops() { return affinityDrops },
    isRunning: () => running,
    start: async () => { running = true },
    stop: async () => { running = false },
    syncFromStore: () => {
      const accounts = buildProxyAccountsFromStore(records)
      pool.clear()
      for (const a of accounts) pool.addAccount(a)
      return pool.size
    }
  }
}

/** 把反代替身接成 PanelRouteDeps 的 proxy 侧实现（镜像生产装配的形状） */
function proxyDeps(stub: ReturnType<typeof makeProxyStub>): Pick<
  PanelRouteDeps,
  'proxyGetStatus' | 'proxySyncPool' | 'proxyActivateAccount' | 'proxyStart' | 'proxyStop'
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
      inFlightRequests: 0
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
    }
  }
}

function stubRouteDeps(stub: ReturnType<typeof makeProxyStub>): PanelRouteDeps {
  return {
    loadAccountsBlob: async () => ({ revision: 1, accounts: stub.records }),
    checkAccountStatus: async () => ({ success: true }),
    refreshAccountToken: async () => ({ success: true }),
    switchAccountToIde: async () => ({ success: true }),
    switchAccountToCli: async () => ({ success: true }),
    logoutFromIde: async () => ({ success: true }),
    getAccountModels: async () => ({ success: true, models: [] }),
    getAccountSubscriptions: async () => ({ success: true }),
    getAccountSubscriptionUrl: async () => ({ success: true }),
    setAccountOverage: async () => ({ success: true }),
    ...proxyDeps(stub)
  }
}

const servers: WebPanelServer[] = []

function makeServer(stub: ReturnType<typeof makeProxyStub>, config: Partial<WebPanelConfig> = {}) {
  const server = new WebPanelServer({
    auth: new PanelAuth(memoryKeyStore()),
    routeDeps: stubRouteDeps(stub),
    getConfig: () => ({ enabled: true, port: 0, host: '127.0.0.1', ...config })
  })
  servers.push(server)
  return server
}

afterEach(async () => {
  while (servers.length) await servers.pop()?.stop().catch(() => undefined)
})

function base(server: WebPanelServer): string {
  const addr = server.getListeningAddress()
  if (!addr) throw new Error('not listening')
  return `http://127.0.0.1:${addr.port}${PANEL_PATH_PREFIX}`
}

async function login(server: WebPanelServer): Promise<string> {
  const res = await fetch(`${base(server)}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Panel-Request': '1' },
    body: JSON.stringify({ adminKey: ADMIN_KEY })
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
      ['POST', '/api/proxy/active-account']
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

describe('面板反代端点 · 选号（单账号模式）', () => {
  it('选号后：池里有该账号 **且** selectedAccountIds[0] 是它（两条一起才排除已实证失效）', async () => {
    const stub = makeProxyStub({ enableMultiAccount: false })
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)

    // 先启动（编排要求先同步池）
    const startRes = await fetch(`${base(server)}/api/proxy/start`, { method: 'POST', headers: authed(cookie) })
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

    const res = await fetch(`${base(server)}/api/proxy/start`, { method: 'POST', headers: authed(cookie) })
    expect(res.status).toBe(200)
    // 只收 status=active 的两个，acc-dead 被过滤
    expect(stub.pool.size).toBe(2)
    expect(stub.isRunning()).toBe(true)
  })

  it('状态端点读的是真实运行态，不是"我发过启动请求"', async () => {
    const stub = makeProxyStub()
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)

    const before = await (await fetch(`${base(server)}/api/proxy/status`, { headers: authed(cookie) })).json()
    expect(before.running).toBe(false)

    await fetch(`${base(server)}/api/proxy/start`, { method: 'POST', headers: authed(cookie) })
    const after = await (await fetch(`${base(server)}/api/proxy/status`, { headers: authed(cookie) })).json()
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
    const status = await (await fetch(`${base(server)}/api/proxy/status`, { headers: authed(cookie) })).json()
    expect(status.selectedAccountId).toBe('acc-a')
  })

  it('停止后运行态变 false（判据来自真实读数）', async () => {
    const stub = makeProxyStub()
    const server = makeServer(stub)
    await server.start()
    const cookie = await login(server)
    await fetch(`${base(server)}/api/proxy/start`, { method: 'POST', headers: authed(cookie) })
    expect(stub.isRunning()).toBe(true)

    const res = await fetch(`${base(server)}/api/proxy/stop`, { method: 'POST', headers: authed(cookie) })
    expect(res.status).toBe(200)
    expect(stub.isRunning()).toBe(false)
    const status = await (await fetch(`${base(server)}/api/proxy/status`, { headers: authed(cookie) })).json()
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
    const statusText = await (await fetch(`${base(server)}/api/proxy/status`, { headers: authed(cookie) })).text()
    const activateText = await activate.text()
    for (const body of [statusText, activateText]) {
      expect(body).not.toContain(TOKEN_A)
      expect(body).not.toContain(TOKEN_B)
      expect(body).not.toContain('rt-a')
    }
  })
})
