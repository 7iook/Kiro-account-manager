/**
 * 单元测试:validateApiKeyCredential 跨 region 探测
 * (RCA 2026-08-02 · ksk-region-adaptation)
 *
 * 覆盖:hint region 403 时自动回退到 KNOWN_CW_DATA_REGIONS 另一 region;
 *       其他终态(VALID / SUSPENDED / INDETERMINATE)直接短路不试第二区。
 *
 * 关键契约:
 * - state=VALID 时 result.region 必填,值 = 实际命中 region
 * - INVALID 才回退,其他 state 与 region 无关
 * - 两 region 都 INVALID → 最终 INVALID(密钥真的无效)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

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

function mockResponse(status: number, body: unknown | string): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
  } as unknown as Response
}

/** 完整的 VALID 响应体骨架 */
const VALID_BODY = {
  subscriptionInfo: {
    type: 'Q_DEVELOPER_STANDALONE_POWER',
    subscriptionTitle: 'KIRO POWER',
    subscriptionManagementTarget: 'MANAGE'
  },
  usageBreakdownList: [{ resourceType: 'AGENTIC_REQUEST', currentUsage: 948, usageLimit: 10000 }]
}

describe('validateApiKeyCredential · 跨 region 探测', () => {
  it('hint=us-east-1 且 US 200 VALID → 只调一次 fetch · region=us-east-1', async () => {
    const fetchMock = vi.fn(async () => mockResponse(200, VALID_BODY))
    vi.stubGlobal('fetch', fetchMock)
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('VALID')
    expect(r.region).toBe('us-east-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 确认打的是 us-east-1 host
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('management.us-east-1.kiro.dev')
  })

  it('hint=us-east-1 US 401 + EU 200 → 试两次 · 最终 VALID · region=eu-central-1', async () => {
    // 真实用户场景:EU ksk 密钥,用户默认 hint us-east-1 → US 端 401/403 → EU 端 200
    let call = 0
    const fetchMock = vi.fn(async (url: string) => {
      call++
      if (url.includes('us-east-1')) return mockResponse(403, { message: 'Invalid token', reason: null })
      if (url.includes('eu-central-1')) return mockResponse(200, VALID_BODY)
      throw new Error('unexpected url: ' + url)
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('VALID')
    expect(r.region).toBe('eu-central-1')
    expect(r.subscription?.title).toBe('KIRO POWER')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(call).toBe(2)
  })

  it('hint=eu-central-1 EU 200 → 只调一次 · 不试 us-east-1', async () => {
    // 用户主动选 EU → 一次就命中,不做无谓探测
    const fetchMock = vi.fn(async () => mockResponse(200, VALID_BODY))
    vi.stubGlobal('fetch', fetchMock)
    const r = await validateApiKeyCredential('ksk_test', 'eu-central-1')
    expect(r.state).toBe('VALID')
    expect(r.region).toBe('eu-central-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('management.eu-central-1.kiro.dev')
  })

  it('两个 region 都 401 InvalidToken → 最终 INVALID(密钥真的无效)', async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse(401, { __type: 'InvalidTokenException', message: 'Invalid token' })
    )
    vi.stubGlobal('fetch', fetchMock)
    const r = await validateApiKeyCredential('ksk_revoked', 'us-east-1')
    expect(r.state).toBe('INVALID')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('两个 region 都 403 InvalidToken(明确 __type)→ 最终 INVALID', async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse(403, { __type: 'InvalidTokenException', message: 'Invalid token' })
    )
    vi.stubGlobal('fetch', fetchMock)
    const r = await validateApiKeyCredential('ksk_revoked', 'us-east-1')
    expect(r.state).toBe('INVALID')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('hint region 5xx → 直接 INDETERMINATE · 不试第二区(服务器错误与 region 无关)', async () => {
    const fetchMock = vi.fn(async () => mockResponse(503, {}))
    vi.stubGlobal('fetch', fetchMock)
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('INDETERMINATE')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('hint region 429 → 直接 INDETERMINATE · 不试第二区(限流与 region 无关)', async () => {
    const fetchMock = vi.fn(async () => mockResponse(429, {}))
    vi.stubGlobal('fetch', fetchMock)
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('INDETERMINATE')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('hint region 423 Locked → 直接 SUSPENDED · 不试第二区', async () => {
    const fetchMock = vi.fn(async () => mockResponse(423, {}))
    vi.stubGlobal('fetch', fetchMock)
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('SUSPENDED')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('hint region 8b 裸 AccessDenied 403 → INDETERMINATE · 不试第二区(feature gate 未知,与 region 无关)', async () => {
    // 8b 分支不算 INVALID(可能是 feature gate),不该触发跨区探测,否则浪费一次请求
    const fetchMock = vi.fn(async () => mockResponse(403, { __type: 'AccessDeniedException' }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('INDETERMINATE')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('网络错误 → 直接 INDETERMINATE · 不试第二区', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')))
    vi.stubGlobal('fetch', fetchMock)
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.state).toBe('INDETERMINATE')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('VALID 时 region 字段是实际命中的 region,非用户 hint', async () => {
    // 契约锁:CredentialProbeResult.region 语义是"实际生效",不是"用户输入"
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('us-east-1')) return mockResponse(401, { __type: 'InvalidTokenException' })
      return mockResponse(200, VALID_BODY)
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await validateApiKeyCredential('ksk_test', 'us-east-1')
    expect(r.region).toBe('eu-central-1')
    expect(r.region).not.toBe('us-east-1') // 明确断言:非 hint
  })
})
