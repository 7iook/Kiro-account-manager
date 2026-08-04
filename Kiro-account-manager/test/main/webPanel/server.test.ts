/**
 * WebPanelServer —— HTTP 服务器 + 路由 + 鉴权闸门的端到端行为
 *
 * 用真 `http.Server` + 真 `fetch`,不 mock socket —— 这些用例要证明的正是
 * 「cookie 是否真的被浏览器语义接受」「端口是否真的被释放」这类只有真实
 * 传输层才暴露的问题(决策卡 §3:`Path=/panel` 与路由前缀不一致 → 静默 401)。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { networkInterfaces } from 'node:os'
import { WebPanelServer, type WebPanelConfig } from '../../../src/main/webPanel/server'
import { PanelAuth, type AdminKeyStore } from '../../../src/main/webPanel/auth'
import { PANEL_PATH_PREFIX, SESSION_COOKIE_NAME } from '../../../src/main/webPanel/cookie'
import type { PanelRouteDeps } from '../../../src/main/webPanel/routes'

const ADMIN_KEY = 'test-admin-key-0123456789abcdef'

function memoryKeyStore(initial: string | null = ADMIN_KEY): AdminKeyStore {
  let key = initial
  return {
    get: () => key,
    set: (k: string) => {
      key = k
    }
  }
}

/** 一个带明文凭据的账号 blob —— 用来证明列表响应里不含任何 token 子串 */
const TOKEN_SECRET = 'ZZaccessTokenSecretValueZZ'
const REFRESH_SECRET = 'ZZrefreshTokenSecretValueZZ'
const KSK_SECRET = 'ksk_ZZZZZZZZZZZZZZZZZZZZZZZZ'

function fixtureBlob(): unknown {
  return {
    revision: 7,
    proxyUrl: 'http://user:pass@127.0.0.1:1080',
    accounts: {
      'acc-1': {
        id: 'acc-1',
        email: 'a@example.com',
        nickname: 'Account One',
        idp: 'BuilderId',
        status: 'active',
        isActive: true,
        tags: ['t1'],
        subscription: { type: 'Pro', title: 'Kiro Pro', daysRemaining: 12 },
        usage: { current: 30, limit: 100, percentUsed: 30 },
        credentials: {
          accessToken: TOKEN_SECRET,
          refreshToken: REFRESH_SECRET,
          clientId: 'cid',
          clientSecret: 'csecret',
          csrfToken: 'csrf-value',
          expiresAt: 1893456000000,
          authMethod: 'IdC'
        }
      },
      'acc-2': {
        id: 'acc-2',
        email: 'b@example.com',
        status: 'active',
        isActive: false,
        credentials: { accessToken: KSK_SECRET, authMethod: 'api_key', provider: 'ApiKey' }
      }
    }
  }
}

function stubRouteDeps(overrides: Partial<PanelRouteDeps> = {}): PanelRouteDeps {
  const blob = fixtureBlob()
  return {
    loadAccountsBlob: async () => blob,
    checkAccountStatus: async () => ({ success: true, data: { status: 'active' } }),
    refreshAccountToken: async () => ({ success: true, data: { accessToken: 'x' } }),
    switchAccountToIde: async () => ({ success: true }),
    switchAccountToCli: async () => ({ success: true }),
    logoutFromIde: async () => ({ success: true }),
    getAccountModels: async () => ({ success: true, models: [] }),
    getAccountSubscriptions: async () => ({ success: true, plans: [] }),
    getAccountSubscriptionUrl: async () => ({ success: true, url: 'https://example.com/manage' }),
    setAccountOverage: async () => ({ success: true }),
    ...overrides
  }
}

const servers: WebPanelServer[] = []

function makeServer(
  config: Partial<WebPanelConfig> = {},
  opts: { keyStore?: AdminKeyStore; deps?: Partial<PanelRouteDeps> } = {}
): { server: WebPanelServer; auth: PanelAuth } {
  const auth = new PanelAuth(opts.keyStore ?? memoryKeyStore())
  const server = new WebPanelServer({
    auth,
    routeDeps: stubRouteDeps(opts.deps),
    getConfig: () => ({
      enabled: true,
      // port 0 = 让内核分配空闲端口,避免测试互相抢端口
      port: 0,
      host: '127.0.0.1',
      ...config
    })
  })
  servers.push(server)
  return { server, auth }
}

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()
    await s?.stop().catch(() => undefined)
  }
})

function base(server: WebPanelServer): string {
  const addr = server.getListeningAddress()
  if (!addr) throw new Error('server not listening')
  return `http://127.0.0.1:${addr.port}${PANEL_PATH_PREFIX}`
}

async function login(server: WebPanelServer, key = ADMIN_KEY): Promise<string> {
  const res = await fetch(`${base(server)}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Panel-Request': '1' },
    body: JSON.stringify({ adminKey: key })
  })
  const setCookie = res.headers.get('set-cookie')
  if (!res.ok || !setCookie) throw new Error(`login failed: ${res.status}`)
  return setCookie.split(';')[0]
}

describe('WebPanelServer · 外网绑定护栏(安全红线)', () => {
  it('绑定 0.0.0.0 且未配置 adminKey → 拒绝启动', async () => {
    const { server } = makeServer({ host: '0.0.0.0' }, { keyStore: memoryKeyStore(null) })
    await expect(server.start()).rejects.toThrow(/Refused to start/i)
    expect(server.isRunning()).toBe(false)
  })

  it('绑定 0.0.0.0 但已配置 adminKey → 允许启动', async () => {
    const { server } = makeServer({ host: '0.0.0.0' })
    await expect(server.start()).resolves.toBeUndefined()
    expect(server.isRunning()).toBe(true)
  })

  it('绑定 127.0.0.1 且无 adminKey → 允许启动(本机不暴露)', async () => {
    const { server } = makeServer({ host: '127.0.0.1' }, { keyStore: memoryKeyStore(null) })
    await expect(server.start()).resolves.toBeUndefined()
    expect(server.isRunning()).toBe(true)
  })
})

describe('WebPanelServer · 鉴权闸门', () => {
  it('未登录访问 /panel/api/accounts → 401 UNAUTHORIZED', async () => {
    const { server } = makeServer()
    await server.start()
    const res = await fetch(`${base(server)}/api/accounts`)
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('UNAUTHORIZED')
  })

  it('已登录但写操作缺 X-Panel-Request 头 → 被拒(CSRF 第二道)', async () => {
    const { server } = makeServer()
    await server.start()
    const cookie = await login(server)

    const denied = await fetch(`${base(server)}/api/accounts/acc-1/check`, {
      method: 'POST',
      headers: { cookie }
    })
    expect(denied.status).toBe(401)
    expect((await denied.json()).code).toBe('UNAUTHORIZED')

    const allowed = await fetch(`${base(server)}/api/accounts/acc-1/check`, {
      method: 'POST',
      headers: { cookie, 'X-Panel-Request': '1' }
    })
    expect(allowed.status).toBe(200)
  })

  it('拒绝原因不回传浏览器 —— 过期会话与缺 CSRF 头的响应体一致', async () => {
    const { server } = makeServer()
    await server.start()
    const cookie = await login(server)

    const noSession = await fetch(`${base(server)}/api/accounts`)
    const noCsrf = await fetch(`${base(server)}/api/accounts/acc-1/check`, {
      method: 'POST',
      headers: { cookie }
    })
    expect(await noSession.json()).toEqual(await noCsrf.json())
  })

  it('错误 adminKey → 401,连续失败达阈值 → 429 且带 Retry-After', async () => {
    const { server } = makeServer()
    await server.start()
    let last: Response | undefined
    for (let i = 0; i < 6; i++) {
      last = await fetch(`${base(server)}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Panel-Request': '1' },
        body: JSON.stringify({ adminKey: 'wrong-key' })
      })
    }
    expect(last!.status).toBe(429)
    expect((await last!.json()).code).toBe('RATE_LIMITED')
    expect(Number(last!.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('登录 cookie 的 Path 与路由前缀一致(否则浏览器静默不发送)', async () => {
    const { server } = makeServer()
    await server.start()
    const res = await fetch(`${base(server)}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Panel-Request': '1' },
      body: JSON.stringify({ adminKey: ADMIN_KEY })
    })
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(`Path=${PANEL_PATH_PREFIX}`)
    expect(setCookie).toContain(SESSION_COOKIE_NAME)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
  })

  it('adminKey 轮换后旧会话立即失效', async () => {
    const { server, auth } = makeServer()
    await server.start()
    const cookie = await login(server)
    expect((await fetch(`${base(server)}/api/accounts`, { headers: { cookie } })).status).toBe(200)

    auth.rotateAdminKey()
    expect((await fetch(`${base(server)}/api/accounts`, { headers: { cookie } })).status).toBe(401)
  })
})

describe('WebPanelServer · 登录后端到端取列表', () => {
  it('登录 → 带 cookie 取账号列表 → 条数与盘上一致', async () => {
    const { server } = makeServer()
    await server.start()
    const cookie = await login(server)

    const res = await fetch(`${base(server)}/api/accounts`, { headers: { cookie } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.accounts).toHaveLength(2)
    expect(body.revision).toBe(7)
    expect(body.accounts.map((a: { id: string }) => a.id).sort()).toEqual(['acc-1', 'acc-2'])
  })

  it('列表响应的序列化形态中不含任何 token 子串', async () => {
    const { server } = makeServer()
    await server.start()
    const cookie = await login(server)

    const raw = await (await fetch(`${base(server)}/api/accounts`, { headers: { cookie } })).text()
    expect(raw).not.toContain(TOKEN_SECRET)
    expect(raw).not.toContain(REFRESH_SECRET)
    expect(raw).not.toContain(KSK_SECRET)
    expect(raw).not.toContain('csecret')
    expect(raw).not.toContain('csrf-value')
    // 顶层设置项也不透传(proxyUrl 可能含代理账密)
    expect(raw).not.toContain('user:pass')
    // 但白名单字段必须在
    expect(raw).toContain('a@example.com')
  })

  it('凭据字段连"打码后的残迹"都不出现 —— 白名单投影不依赖 redact 兜底', async () => {
    // 这条治的是「投影层被绕过，但 redactValue 把 token 打成 abc***xy，
    // 于是子串断言仍然绿」的假绿：打码值仍泄漏长度与首尾字符，
    // 且它证明的是外层兜底在工作，不是内层白名单在工作。
    // 判据改为**键名根本不存在**（投影是加法白名单，凭据键从不入结果）。
    const { server } = makeServer()
    await server.start()
    const cookie = await login(server)

    const body = await (await fetch(`${base(server)}/api/accounts`, { headers: { cookie } })).json()
    for (const account of body.accounts) {
      expect(Object.keys(account)).not.toContain('credentials')
      expect(Object.keys(account)).not.toContain('accessToken')
      expect(Object.keys(account)).not.toContain('refreshToken')
      expect(Object.keys(account)).not.toContain('clientSecret')
    }
    // 顶层只出 accounts + revision，26 个设置项一律不透传
    expect(Object.keys(body).sort()).toEqual(['accounts', 'revision'])
    // 存在性布尔替代原料（送结论不送原料）
    expect(body.accounts.find((a: { id: string }) => a.id === 'acc-1').hasRefreshToken).toBe(true)
  })

  it('端点按 accountId 寻址 —— 路径与请求体里都不需要出现 token', async () => {
    let seenIdentity: unknown = null
    const { server } = makeServer(
      {},
      {
        deps: {
          getAccountModels: async (identity) => {
            seenIdentity = identity
            return { success: true, models: [] }
          }
        }
      }
    )
    await server.start()
    const cookie = await login(server)

    const res = await fetch(`${base(server)}/api/accounts/acc-1/models`, { headers: { cookie } })
    expect(res.status).toBe(200)
    // 主进程内部按 id 取出了 token 再调 accountService
    expect((seenIdentity as { accessToken?: string })?.accessToken).toBe(TOKEN_SECRET)
  })

  it('未知 accountId → 404 ACCOUNT_NOT_FOUND', async () => {
    const { server } = makeServer()
    await server.start()
    const cookie = await login(server)
    const res = await fetch(`${base(server)}/api/accounts/nope/check`, {
      method: 'POST',
      headers: { cookie, 'X-Panel-Request': '1' }
    })
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('ACCOUNT_NOT_FOUND')
  })

  it('登出后 cookie 失效', async () => {
    const { server } = makeServer()
    await server.start()
    const cookie = await login(server)
    const out = await fetch(`${base(server)}/api/logout`, {
      method: 'POST',
      headers: { cookie, 'X-Panel-Request': '1' }
    })
    expect(out.status).toBe(200)
    expect((await fetch(`${base(server)}/api/accounts`, { headers: { cookie } })).status).toBe(401)
  })
})

describe('WebPanelServer · IP 门禁与生命周期', () => {
  it('deniedIPs 命中 → 403,且不进入鉴权流程', async () => {
    const { server } = makeServer({ deniedIPs: ['127.0.0.1'] })
    await server.start()
    const res = await fetch(`${base(server)}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Panel-Request': '1' },
      body: JSON.stringify({ adminKey: ADMIN_KEY })
    })
    expect(res.status).toBe(403)
  })

  it('开→关→再开一轮:端口正确释放并重新监听(决策卡 §5 生命周期)', async () => {
    const { server } = makeServer()
    await server.start()
    const first = server.getListeningAddress()?.port
    await server.stop()
    expect(server.isRunning()).toBe(false)
    expect(server.getListeningAddress()).toBeNull()

    await server.start()
    expect(server.isRunning()).toBe(true)
    expect(server.getListeningAddress()?.port).toBeGreaterThan(0)
    expect(first).toBeGreaterThan(0)
  })

  it('stop() 不被 keep-alive 长连接拖住(强制 destroy socket)', async () => {
    const { server } = makeServer()
    await server.start()
    const cookie = await login(server)
    // keep-alive 连接:默认 fetch 会复用连接,stop() 必须主动 destroy 否则挂 ~60s
    await fetch(`${base(server)}/api/accounts`, { headers: { cookie } })
    const started = Date.now()
    await server.stop()
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('未知路径 → 404,且响应仍经 sendError 出口', async () => {
    const { server } = makeServer()
    await server.start()
    const res = await fetch(`http://127.0.0.1:${server.getListeningAddress()!.port}/nope`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
  })
})

/**
 * 局域网可达性 —— 受控对照(RCA 2026-08-05 web-panel-lan-no-bind-control)
 *
 * 用户报障:「即使连着同一个局域网,手机也无法访问」。设置页当时把 host 永久留在
 * 默认 `127.0.0.1`(界面没有任何修改绑定地址的控件),所以服务器只绑回环。
 *
 * 这两条用例把「host 决定手机能不能连」钉成可执行事实:**只改 host 一个变量**,
 * 从本机真实网卡 IP 发真请求,可达性必须翻转。它是 WebPanelCard 那侧
 * 「开关会写 host='0.0.0.0'」的下半段 —— 两段合起来才覆盖完整链路。
 */
describe('WebPanelServer · 局域网可达性由 host 决定(受控对照)', () => {
  /**
   * 挑一个**真实**的私网 IPv4。刻意排除:
   *   - `169.254.x`  link-local(RFC 3927),手机永远连不上
   *   - 非私网段     公网/伪接口地址,不该拿来当局域网自测目标
   * 本机实测有 11 个 IPv4(WSL / Hyper-V / VMware / Tailscale / 4 个 link-local),
   * 只有 WLAN 那个是手机真能用的 —— 所以这里必须挑,不能拿第一个。
   */
  function pickPrivateLanIp(): string | null {
    for (const entries of Object.values(networkInterfaces())) {
      for (const e of entries ?? []) {
        if (e.family !== 'IPv4' || e.internal) continue
        const ip = e.address
        if (ip.startsWith('169.254.')) continue
        const isPrivate =
          ip.startsWith('192.168.') ||
          ip.startsWith('10.') ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
        if (isPrivate) return ip
      }
    }
    return null
  }

  it('host=0.0.0.0 ⇒ 从本机真实局域网 IP 能连上(手机能访问的前提)', async () => {
    const lanIp = pickPrivateLanIp()
    if (!lanIp) return // 无私网网卡的环境(纯 CI)跳过,不伪造结论

    const { server } = makeServer({ host: '0.0.0.0' })
    await server.start()
    const addr = server.getListeningAddress()
    expect(addr).not.toBeNull()

    // 关键判据是「连上了」,不是「拿到 200」—— 未登录返 401 同样证明 TCP+HTTP 通了
    const res = await fetch(`http://${lanIp}:${addr!.port}${PANEL_PATH_PREFIX}/api/session`)
    expect(res.status).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(500)
  })

  it('host=127.0.0.1 ⇒ 从同一个局域网 IP 必须连不上(这正是用户报障的现象)', async () => {
    const lanIp = pickPrivateLanIp()
    if (!lanIp) return

    const { server } = makeServer({ host: '127.0.0.1' })
    await server.start()
    const addr = server.getListeningAddress()
    expect(addr).not.toBeNull()

    // 只改了 host,同一个 IP、同一段代码 → 必须连不上。
    // 这条翻转才让上一条成为「根因证据」而非「碰巧能连」(§0.14 门3)
    await expect(
      fetch(`http://${lanIp}:${addr!.port}${PANEL_PATH_PREFIX}/api/session`)
    ).rejects.toThrow()
  })
})
