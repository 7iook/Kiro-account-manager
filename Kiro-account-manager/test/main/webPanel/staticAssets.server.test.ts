/**
 * 静态托管的端到端行为 —— 真 `http.Server` + 真 `fetch`
 *
 * 为什么必须端到端而非只测纯函数:本包最容易的失败方式不是「解析写错」,
 * 而是**「模块写好了但生产路径没接」**(仓内 E-052 母题)。只有真发一次
 * `GET /panel` 才能证明它真的接在 `handleRequest` 上,而不是只被测试调用。
 *
 * `serveStaticAsset` 的资源根来自 `resolveWebPanelAssets()`(基于 `__dirname`),
 * 单测环境里指向不存在的目录。所以这里用 `KIRO_WEB_PANEL_*` 之外的手段:
 * 直接构造临时产物目录并 stub 掉解析函数 —— 见 mockAssets 说明。
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 用真实临时目录当资源根。**不 mock fs** —— 这组用例要证明的正是
 * 「真的从盘上读到了字节、真的按 stat 算了 ETag」,mock fs 会把这些全变成空谈。
 */
let ASSET_ROOT: string
const JS_NAME = 'index-C_sieKU2.js'
const CSS_NAME = 'index-DGSNEg0M.css'
const HTML_MARKER = '<!doctype html><title>panel-shell</title>'
const JS_MARKER = 'console.log("panel-bundle")'

/** 供 stub 使用的可变开关:让「产物未构建」也能被端到端验证 */
let assetsAvailable = true

vi.mock('../../../src/main/utils/webPanelAssetRoot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/utils/webPanelAssetRoot')>()
  return {
    ...actual,
    // 只替换「资源在哪」这一个事实(该模块的唯一职责),其余常量走真实实现 ——
    // 否则 WEB_PANEL_ENTRY_HTML 等契约常量被 mock 掉,测试就不再校验真契约了。
    resolveWebPanelAssets:
      (): import('../../../src/main/utils/webPanelAssetRoot').WebPanelAssets => ({
        root: ASSET_ROOT,
        entryHtml: join(ASSET_ROOT, 'index.html'),
        available: assetsAvailable
      })
  }
})

// 必须在 mock 之后 import,否则拿到未被替换的真实模块
const { WebPanelServer } = await import('../../../src/main/webPanel/server')
const { PanelAuth } = await import('../../../src/main/webPanel/auth')
const { PANEL_PATH_PREFIX } = await import('../../../src/main/webPanel/cookie')
const { ASSETS_MISSING_HINT } = await import('../../../src/main/webPanel/staticAssets')

type ServerType = InstanceType<typeof WebPanelServer>
type RouteDeps = import('../../../src/main/webPanel/routes').PanelRouteDeps

const ADMIN_KEY = 'test-admin-key-0123456789abcdef'

beforeAll(() => {
  ASSET_ROOT = mkdtempSync(join(tmpdir(), 'kam-panel-assets-'))
  mkdirSync(join(ASSET_ROOT, 'assets'), { recursive: true })
  writeFileSync(join(ASSET_ROOT, 'index.html'), HTML_MARKER, 'utf-8')
  writeFileSync(join(ASSET_ROOT, 'assets', JS_NAME), JS_MARKER, 'utf-8')
  writeFileSync(join(ASSET_ROOT, 'assets', CSS_NAME), 'body{color:red}', 'utf-8')
  // 一个「根目录下的敏感文件」—— 用来证明穿越出资源根真的拿不到它
  writeFileSync(join(ASSET_ROOT, '..', 'kam-secret-probe.txt'), 'TOP_SECRET_PROBE', 'utf-8')
})

afterAll(() => {
  try {
    rmSync(ASSET_ROOT, { recursive: true, force: true })
    rmSync(join(ASSET_ROOT, '..', 'kam-secret-probe.txt'), { force: true })
  } catch {
    /* 临时目录清理失败不该让测试红 */
  }
})

function stubRouteDeps(): RouteDeps {
  const blob = { revision: 1, accounts: {} }
  return {
    loadAccountsBlob: async () => blob,
    checkAccountStatus: async () => ({ success: true }),
    refreshAccountToken: async () => ({ success: true }),
    switchAccountToIde: async () => ({ success: true }),
    switchAccountToCli: async () => ({ success: true }),
    logoutFromIde: async () => ({ success: true }),
    getAccountModels: async () => ({ success: true, models: [] }),
    getAccountSubscriptions: async () => ({ success: true, plans: [] }),
    getAccountSubscriptionUrl: async () => ({ success: true, url: 'https://example.com' }),
    setAccountOverage: async () => ({ success: true })
  }
}

const servers: ServerType[] = []

async function startServer(): Promise<ServerType> {
  const auth = new PanelAuth({ get: () => ADMIN_KEY, set: () => undefined })
  const server = new WebPanelServer({
    auth,
    routeDeps: stubRouteDeps(),
    getConfig: () => ({ enabled: true, port: 0, host: '127.0.0.1' })
  })
  servers.push(server)
  await server.start()
  return server
}

function base(server: ServerType): string {
  const addr = server.getListeningAddress()
  if (!addr) throw new Error('server not listening')
  return `http://127.0.0.1:${addr.port}${PANEL_PATH_PREFIX}`
}

afterEach(async () => {
  assetsAvailable = true
  while (servers.length) {
    await servers
      .pop()
      ?.stop()
      .catch(() => undefined)
  }
})

describe('静态托管 · 生产路径真的接上了(治 E-052 建而未接)', () => {
  it('GET /panel → 200 且返回 shell,不再是 404', async () => {
    // 这条就是本包的验收判据本身:「GET /panel 返回应用而不是 404」。
    const server = await startServer()
    const res = await fetch(base(server))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toContain('panel-shell')
  })

  it('GET /panel/ (带尾斜杠) 同样返回 shell', async () => {
    const server = await startServer()
    const res = await fetch(`${base(server)}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('panel-shell')
  })

  it('GET /panel/assets/<hash>.js → 200 + 可执行 MIME + immutable 缓存', async () => {
    const server = await startServer()
    const res = await fetch(`${base(server)}/assets/${JS_NAME}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await res.text()).toContain('panel-bundle')
  })

  it('入口 HTML 的 Cache-Control 与哈希资源不同级(防升级白屏)', async () => {
    const server = await startServer()
    const html = await fetch(base(server))
    const js = await fetch(`${base(server)}/assets/${JS_NAME}`)
    expect(html.headers.get('cache-control')).toBe('no-cache')
    expect(js.headers.get('cache-control')).toContain('immutable')
    expect(html.headers.get('cache-control')).not.toBe(js.headers.get('cache-control'))
  })

  it('带查询串的请求正常(?v=123 不该被当成文件名的一部分)', async () => {
    const server = await startServer()
    const res = await fetch(`${base(server)}/assets/${JS_NAME}?v=123`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('panel-bundle')
  })
})

describe('静态托管 · 安全响应头', () => {
  it('CSP 由响应头下发,且覆盖非 HTML 资源(meta 标签做不到这点)', async () => {
    const server = await startServer()
    for (const path of ['', `/assets/${JS_NAME}`, `/assets/${CSS_NAME}`]) {
      const res = await fetch(`${base(server)}${path}`)
      const csp = res.headers.get('content-security-policy')
      expect(csp, `${path || '/'} 缺少 CSP 头`).toBeTruthy()
      expect(csp).toContain("default-src 'none'")
      expect(csp).toContain("script-src 'self'")
      expect(csp).not.toContain("script-src 'self' 'unsafe-inline'")
    }
  })

  it('nosniff / X-Frame-Options / Referrer-Policy 都在', async () => {
    const server = await startServer()
    const res = await fetch(base(server))
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })
})

describe('静态托管 · 穿越攻击在真实 HTTP 上被拒(不只是纯函数层)', () => {
  // 纯函数层已穷举编码形态(staticAssets.traversal.test.ts)。这里证明的是
  // **经过 Node 的 URL 解析之后**仍然拒绝 —— 服务器可能先替我们做一次归一化,
  // 那会改变到达托管层的字符串形态,只测纯函数是覆盖不到的。
  const PAYLOADS = [
    '/../kam-secret-probe.txt',
    '/../../kam-secret-probe.txt',
    '/%2e%2e%2fkam-secret-probe.txt',
    '/..%2fkam-secret-probe.txt',
    '/%252e%252e%252fkam-secret-probe.txt',
    '/..%5ckam-secret-probe.txt',
    '/assets/../../kam-secret-probe.txt',
    '/index.html%00.txt',
    '/index.html::$DATA',
    '/%2e%2e/%2e%2e/package.json'
  ]

  for (const payload of PAYLOADS) {
    it(`拒绝 ${payload}`, async () => {
      const server = await startServer()
      const res = await fetch(`${base(server)}${payload}`, { redirect: 'manual' })
      const body = await res.text()
      // 判据是**内容没泄漏**,而非状态码 —— 状态码对了但正文是密钥同样是失守。
      expect(body, `穿越成功,泄漏了资源根之外的文件:${payload}`).not.toContain('TOP_SECRET_PROBE')
      expect([400, 403, 404]).toContain(res.status)
    })
  }

  it('对照组:同一个探针文件确实存在且可读(否则上面全是假绿)', async () => {
    // 这条治的是「探针文件根本没写成功,所以怎么测都不泄漏」的假绿。
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(join(ASSET_ROOT, '..', 'kam-secret-probe.txt'), 'utf-8')).toContain(
      'TOP_SECRET_PROBE'
    )
  })
})

describe('静态托管 · SPA 回退边界(真实 HTTP)', () => {
  it('未知页面路径 → 200 + shell(客户端路由能工作)', async () => {
    const server = await startServer()
    const res = await fetch(`${base(server)}/accounts/detail/xyz`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toContain('panel-shell')
  })

  it('未知 /panel/api/* → JSON 404,**不是** HTML(最容易误诊的失败)', async () => {
    const server = await startServer()
    const res = await fetch(`${base(server)}/api/no-such-endpoint`)
    expect(res.status).not.toBe(200)
    const ct = res.headers.get('content-type') ?? ''
    expect(ct, 'API 404 被 SPA 回退成了 HTML —— 前端会报 JSON 解析错').toContain('application/json')
    const body = await res.text()
    expect(body).not.toContain('panel-shell')
    expect(JSON.parse(body).code).toBeTruthy()
  })

  it('缺失的哈希资源 → 404,不伪装成 200 HTML', async () => {
    const server = await startServer()
    const res = await fetch(`${base(server)}/assets/index-DELETED.js`)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('panel-shell')
  })

  it('现有 API 端点行为不变:未登录仍 401 JSON', async () => {
    // 静态层插在闸门之前,必须证明它没顺手放行 API。
    const server = await startServer()
    const res = await fetch(`${base(server)}/api/accounts`)
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('UNAUTHORIZED')
  })

  it('/panel 之外的路径仍 404(与反代命名空间隔离)', async () => {
    const server = await startServer()
    const addr = server.getListeningAddress()!
    const res = await fetch(`http://127.0.0.1:${addr.port}/nope`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
  })
})

describe('静态托管 · 鉴权决策(静态资源无需会话)', () => {
  it('未登录也能拿到 shell 与 bundle —— 否则登录页本身取不到', async () => {
    const server = await startServer()
    expect((await fetch(base(server))).status).toBe(200)
    expect((await fetch(`${base(server)}/assets/${JS_NAME}`)).status).toBe(200)
  })

  it('但账号数据仍然要会话(静态放行没有削弱 API 闸门)', async () => {
    const server = await startServer()
    const res = await fetch(`${base(server)}/api/accounts`)
    expect(res.status).toBe(401)
  })
})

describe('静态托管 · 条件请求与方法', () => {
  it('If-None-Match 命中 → 304 且无 body', async () => {
    const server = await startServer()
    const first = await fetch(`${base(server)}/assets/${JS_NAME}`)
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()

    const second = await fetch(`${base(server)}/assets/${JS_NAME}`, {
      headers: { 'If-None-Match': etag! }
    })
    expect(second.status).toBe(304)
    expect(await second.text()).toBe('')
  })

  it('HEAD → 有头无体,且 Content-Length 如实反映资源大小', async () => {
    const server = await startServer()
    const res = await fetch(`${base(server)}/assets/${JS_NAME}`, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(Number(res.headers.get('content-length'))).toBe(JS_MARKER.length)
    expect(await res.text()).toBe('')
  })

  it('对静态路径用 POST → 405,不当成 SPA 页面返回 200', async () => {
    const server = await startServer()
    const res = await fetch(`${base(server)}/accounts`, {
      method: 'POST',
      headers: { 'X-Panel-Request': '1' }
    })
    expect(res.status).toBe(405)
  })
})

describe('静态托管 · 产物未构建时给可诊断信息', () => {
  it('available=false → 503 + 明确指出跑 npm run build:webpanel(不是裸 404)', async () => {
    assetsAvailable = false
    const server = await startServer()
    const res = await fetch(base(server))
    // 裸 404 会让人以为路由写错了,而真因是「没构建」——
    // 判据必须是**提示词真的出现在响应里**,不只是状态码。
    expect(res.status).toBe(503)
    const body = await res.text()
    expect(body).toBe(ASSETS_MISSING_HINT)
    expect(body).toContain('build:webpanel')
  })

  it('产物未构建时 API 仍然正常工作(静态缺失不该拖垮 API)', async () => {
    assetsAvailable = false
    const server = await startServer()
    const res = await fetch(`${base(server)}/api/accounts`)
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('UNAUTHORIZED')
  })
})
