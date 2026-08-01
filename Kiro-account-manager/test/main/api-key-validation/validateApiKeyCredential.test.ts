/**
 * 单元测试:validateApiKeyCredential 决策表(RCA §6 · A5-R1 状态机测试台账)
 *
 * 覆盖 11 行决策表 · 每行都是"一次响应 → 一个 state"的互斥断言。
 * 通过 vi.stubGlobal('fetch') 拦截 undici 底层调用(kiroApi.fetchWithProxy 在无 agent 时
 * 走 global fetch)。
 *
 * 每个 case 只调 validateApiKeyCredential 一次,只断言 state 值(不做正则/串匹配),
 * 严格锁住状态机契约。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// systemProxy 会读 Windows 注册表,测试环境需要屏蔽 · 强制 fetchWithProxy 走 global fetch 分支
// vi.mock 必须在 import kiroApi 之前(hoisted)
vi.mock('@main/proxy/systemProxy', () => ({
  getSystemProxy: () => null,
  safeCreateProxyAgent: () => undefined
}))

import { validateApiKeyCredential } from '@main/proxy/kiroApi'

const originalEnv = { ...process.env }

beforeEach(() => {
  delete process.env.HTTPS_PROXY
  delete process.env.https_proxy
  delete process.env.HTTP_PROXY
  delete process.env.http_proxy
  delete process.env.NO_PROXY
  delete process.env.no_proxy
})

afterEach(() => {
  vi.unstubAllGlobals()
  process.env = { ...originalEnv }
})

/** 构造一个 mock Response · Node fetch 兼容形态 */
function mockResponse(status: number, body: unknown | string, ok = status >= 200 && status < 300): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok,
    status,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
  } as unknown as Response
}

describe('validateApiKeyCredential · 决策表 11 行', () => {
  it('Row 1: 网络错误 → INDETERMINATE', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))))
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('INDETERMINATE')
    expect(r.reason).toMatch(/ECONNREFUSED/)
  })

  it('Row 2: HTTP 500 → INDETERMINATE(不解析 body,避免误判 SUSPENDED)', async () => {
    // 即使 body 提到 SUSPENDED 字样,5xx 也一律归 INDETERMINATE(避免服务器错误页面
    // 中的"suspended" 字串误伤 → 拒绝入池)
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse(500, 'internal error TEMPORARILY_SUSPENDED')))
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('INDETERMINATE')
    expect(r.httpStatus).toBe(500)
  })

  it('Row 2: HTTP 503 → INDETERMINATE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse(503, {})))
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('INDETERMINATE')
  })

  it('Row 3: HTTP 429 → INDETERMINATE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse(429, { __type: 'ThrottlingException' })))
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('INDETERMINATE')
    expect(r.httpStatus).toBe(429)
  })

  it('Row 4: HTTP 423 → SUSPENDED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse(423, { __type: 'AccountSuspended' })))
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('SUSPENDED')
    expect(r.httpStatus).toBe(423)
  })

  it('Row 5: HTTP 200 + subscriptionInfo.status=SUSPENDED → SUSPENDED', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse(200, {
          subscriptionInfo: {
            type: 'Q_DEVELOPER_STANDALONE_PRO',
            subscriptionTitle: 'KIRO PRO',
            status: 'SUSPENDED'
          }
        })
      )
    )
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('SUSPENDED')
    // 决策表 SUSPENDED 优先级高于 VALID · 200 + subscriptionInfo.type 存在也不进入 VALID
  })

  it('Row 5: HTTP 200 + __type=TEMPORARILY_SUSPENDED → SUSPENDED', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse(200, { __type: 'TEMPORARILY_SUSPENDED', message: 'account paused' })
      )
    )
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('SUSPENDED')
  })

  it('Row 6: HTTP 400 + __type 含 AccountSuspended → SUSPENDED', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse(400, { __type: 'AccountSuspendedException', message: 'suspended' })
      )
    )
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('SUSPENDED')
  })

  it('Row 7: HTTP 401 → INVALID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse(401, { __type: 'UnauthorizedException', message: 'invalid credentials' })
      )
    )
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('INVALID')
    expect(r.httpStatus).toBe(401)
  })

  it('Row 8: HTTP 403 + __type=InvalidTokenException → INVALID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse(403, { __type: 'InvalidTokenException', message: 'Invalid token' })
      )
    )
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('INVALID')
  })

  it('Row 8: HTTP 403 + message 含 "Invalid token" → INVALID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse(403, { __type: 'SomeException', message: 'Invalid token provided' })
      )
    )
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('INVALID')
  })

  it('Row 8b: HTTP 403 裸 AccessDeniedException → INDETERMINATE(feature gate 未知,不误判)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse(403, { __type: 'AccessDeniedException', message: 'access denied' })
      )
    )
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('INDETERMINATE')
    // 关键契约:403 单看 AccessDenied 不能判 INVALID(可能是 STANDALONE 的 feature gate)
  })

  it('Row 9: HTTP 200 + subscriptionInfo.type + 非 SUSPENDED → VALID(带 fingerprint)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse(200, {
          subscriptionInfo: {
            type: 'Q_DEVELOPER_STANDALONE_POWER',
            subscriptionTitle: 'KIRO POWER',
            status: 'ACTIVE',
            subscriptionManagementTarget: 'MANAGE'
          },
          usageBreakdownList: [
            {
              resourceType: 'AGENTIC_REQUEST',
              currentUsage: 42,
              usageLimit: 1000
            }
          ]
        })
      )
    )
    const r = await validateApiKeyCredential('ksk_valid_key_hello_world', 'us-east-1')
    expect(r.state).toBe('VALID')
    expect(r.subscription?.type).toBe('Q_DEVELOPER_STANDALONE_POWER')
    expect(r.subscription?.title).toBe('KIRO POWER')
    expect(r.subscription?.currentUsage).toBe(42)
    expect(r.subscription?.usageLimit).toBe(1000)
    // VALID 一定带 tokenFingerprint(16 位 hex)
    expect(r.tokenFingerprint).toMatch(/^[0-9a-f]{16}$/)
  })

  it('Row 10: HTTP 200 但缺 subscriptionInfo.type → INDETERMINATE(不冒然入池)', async () => {
    // 关键:200 + 空 body / 结构不完整 时严禁归 VALID (会污染池)
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse(200, { userInfo: { email: 'x@y.com' } })))
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('INDETERMINATE')
  })

  it('Row 11: HTTP 400 无 SUSPENDED 结构字段 → INDETERMINATE', async () => {
    // 未知的 400 拒绝语义一律归 INDETERMINATE · 不误判为 INVALID
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse(400, { __type: 'ValidationException', message: 'malformed request' })
      )
    )
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('INDETERMINATE')
  })

  it('Row 11: HTTP 404 无 SUSPENDED → INDETERMINATE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse(404, { message: 'not found' })))
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('INDETERMINATE')
  })

  it('每次探测只发一次 HTTP 请求(不 fallback 链)', async () => {
    const spy = vi.fn(async () =>
      mockResponse(200, { subscriptionInfo: { type: 'Q_DEVELOPER_STANDALONE_PRO', status: 'ACTIVE' } })
    )
    vi.stubGlobal('fetch', spy)
    await validateApiKeyCredential('ksk_test', 'us-east-1')
    // 契约:一次响应 → 一个 state · 不重试 · 不 fallback
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('validateApiKeyCredential · state 与 tokenFingerprint 契约', () => {
  it('VALID 态必须带 tokenFingerprint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse(200, {
          subscriptionInfo: { type: 'Q_DEVELOPER_STANDALONE_PRO', status: 'ACTIVE' }
        })
      )
    )
    const r = await validateApiKeyCredential('ksk_abc', 'us-east-1')
    expect(r.state).toBe('VALID')
    expect(r.tokenFingerprint).toBeDefined()
    expect(r.tokenFingerprint).toHaveLength(16)
  })

  it('非 VALID 态一定不带 tokenFingerprint', async () => {
    const cases: Array<[number, Record<string, unknown>]> = [
      [401, { __type: 'Unauthorized' }],
      [423, {}],
      [500, {}],
      [429, {}],
      [200, { userInfo: {} }] // INDETERMINATE (missing subscriptionInfo.type)
    ]
    for (const [status, body] of cases) {
      vi.unstubAllGlobals()
      vi.stubGlobal('fetch', vi.fn(async () => mockResponse(status, body)))
      const r = await validateApiKeyCredential('ksk_x', 'us-east-1')
      expect(r.state).not.toBe('VALID')
      expect(r.tokenFingerprint).toBeUndefined()
    }
  })

  it('相同 accessToken → 相同 fingerprint(sha256 确定性)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse(200, {
          subscriptionInfo: { type: 'Q_DEVELOPER_STANDALONE_PRO', status: 'ACTIVE' }
        })
      )
    )
    const r1 = await validateApiKeyCredential('ksk_same_key', 'us-east-1')
    const r2 = await validateApiKeyCredential('ksk_same_key', 'us-east-1')
    expect(r1.tokenFingerprint).toBe(r2.tokenFingerprint)
  })

  it('不同 accessToken → 不同 fingerprint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse(200, {
          subscriptionInfo: { type: 'Q_DEVELOPER_STANDALONE_PRO', status: 'ACTIVE' }
        })
      )
    )
    const r1 = await validateApiKeyCredential('ksk_key_A', 'us-east-1')
    const r2 = await validateApiKeyCredential('ksk_key_B_totally_different', 'us-east-1')
    expect(r1.tokenFingerprint).not.toBe(r2.tokenFingerprint)
  })
})
