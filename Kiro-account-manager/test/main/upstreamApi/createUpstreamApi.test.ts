/**
 * `createUpstreamApi` 工厂契约测试。
 *
 * 这里测的**不是** HTTP 行为（那是逐字节抽取，由函数体 diff 作证 —— 见
 * `.agent-workspace/.archive/2026-08-12/upstream-api-extract/findings.md`），
 * 而是抽取**引入的那一层**：注入的四个 getter 是否真被读到、single-flight 是否
 * 仍然按 refreshToken 去重、以及两个实例是否真的各自独立（这条同时说明了
 * 为什么装配层必须只建一次）。
 *
 * 判据都落在**可观测的真实副作用**上（真发出的请求 URL / header / dispatcher 选择 /
 * 上游被调次数），不断言 mock 自身存在。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// undici 的 fetch 是「有 agent 时」的出网口，在这里拦住即可观察那条路径的请求。
const undiciFetchMock = vi.fn()
vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => undiciFetchMock(...args),
  Agent: class {},
  ProxyAgent: class {}
}))

// 代理层必须 mock，否则测试结果取决于**跑测试这台机器有没有系统代理**：
// 本机实测有(7897)，于是 getNetworkAgent() 返回真 agent、请求走 undiciFetch 而非
// globalThis.fetch —— 首轮 25 红就是这个原因。这里让代理选择变成可控的确定行为：
// 只有显式给了 URL 才产出一个哨兵 agent，系统代理恒为空。
const PROXY_AGENT = { __sentinelProxyAgent: true }
vi.mock('../../../src/main/proxy/systemProxy', () => ({
  getSystemProxy: () => undefined,
  safeCreateProxyAgent: (url?: string) => (url ? PROXY_AGENT : undefined)
}))

import { createUpstreamApi, type UpstreamApiDeps } from '../../../src/main/upstreamApi'

/** 造一个 200 + JSON body 的响应（REST 路径用）。 */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response
}

function makeDeps(over: Partial<UpstreamApiDeps> = {}): UpstreamApiDeps {
  return {
    useKProxy: () => false,
    getKProxyService: () => null,
    getUsageApiType: () => 'rest',
    getDeviceIdForUa: () => undefined,
    ...over
  }
}

describe('createUpstreamApi:工厂契约', () => {
  const realFetch = globalThis.fetch
  const savedEnv: Record<string, string | undefined> = {}
  const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']

  beforeEach(() => {
    undiciFetchMock.mockReset()
    // env 代理同样会让 getNetworkAgent 产出 agent → 请求改走 undiciFetch。
    // 清掉，保证「默认 deps ⇒ 无 agent ⇒ 走 globalThis.fetch」这个前提成立。
    for (const k of PROXY_ENV) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
    globalThis.fetch = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch
  })
  afterEach(() => {
    for (const k of PROXY_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
  })

  describe('注入的 getter 真的被读到（而不是被硬编码/忽略）', () => {
    it('getUsageApiType 返 rest 时走 REST getUsageLimits;返 cbor 时走 CBOR RPC', async () => {
      // rest 分支:请求打到 management.*.kiro.dev/getUsageLimits
      const restApi = createUpstreamApi(makeDeps({ getUsageApiType: () => 'rest' }))
      globalThis.fetch = vi.fn(async () => jsonResponse({ usageBreakdownList: [] })) as unknown as typeof fetch
      await restApi.getUsageAndLimits('tok-rest')
      const restUrl = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(String(restUrl)).toContain('/getUsageLimits')
      expect(String(restUrl)).toContain('management.us-east-1.kiro.dev')

      // cbor 分支:请求打到 app.kiro.dev 的 GetUserUsageAndLimits
      const cborApi = createUpstreamApi(makeDeps({ getUsageApiType: () => 'cbor' }))
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([0xa0]).buffer // CBOR 空 map
      })) as unknown as typeof fetch
      await cborApi.getUsageAndLimits('tok-cbor')
      const cborUrl = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(String(cborUrl)).toContain('GetUserUsageAndLimits')
    })

    it('getUsageApiType 是每次调用现读，不是工厂实例化时快照', async () => {
      // 这条守的是「注入 getter 而非注入值」那个裁决:桌面端 IPC 可以中途切换类型,
      // 若工厂把它读成快照,设置页改了而实际发的请求不变 —— 且不会报任何错。
      let type: 'rest' | 'cbor' = 'rest'
      const api = createUpstreamApi(makeDeps({ getUsageApiType: () => type }))

      globalThis.fetch = vi.fn(async () => jsonResponse({ usageBreakdownList: [] })) as unknown as typeof fetch
      await api.getUsageAndLimits('tok')
      expect(String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain('/getUsageLimits')

      type = 'cbor'
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([0xa0]).buffer
      })) as unknown as typeof fetch
      await api.getUsageAndLimits('tok')
      expect(String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain('GetUserUsageAndLimits')
    })

    it('getDeviceIdForUa 的返回值进 User-Agent（设备 ID 改写的承重路径）', async () => {
      // 64 hex 才是账号绑定域的设备 ID 形态 —— UUID 形态曾导致 kproxy KIRO_UA_REGEX
      // 匹配不上、ksk_ 账号设备 ID 改写静默失效(commit fce8c89)。故这里用真实形态。
      const deviceId = 'a'.repeat(64)
      const api = createUpstreamApi(makeDeps({ getDeviceIdForUa: () => deviceId }))
      globalThis.fetch = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch

      await api.getUsageLimitsRest('tok')
      const init = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as { headers: Record<string, string> }
      expect(init.headers['User-Agent']).toContain(deviceId)
      expect(init.headers['x-amz-user-agent']).toContain(deviceId)
    })

    it('accountMachineId 优先于注入的全局设备 ID', async () => {
      const api = createUpstreamApi(makeDeps({ getDeviceIdForUa: () => 'g'.repeat(64) }))
      globalThis.fetch = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch

      await api.getUsageLimitsRest('tok', undefined, 'b'.repeat(64))
      const init = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as { headers: Record<string, string> }
      expect(init.headers['User-Agent']).toContain('b'.repeat(64))
      expect(init.headers['User-Agent']).not.toContain('g'.repeat(64))
    })

    it('useKProxy=false 时不去问 K-Proxy 服务；=true 且服务在跑时才用它的地址', async () => {
      const getKProxyService = vi.fn(() => ({ isRunning: () => true, getConfig: () => ({ host: '127.0.0.1', port: 8899 }) }))

      const off = createUpstreamApi(makeDeps({ useKProxy: () => false, getKProxyService }))
      expect(off.getNetworkAgent()).toBeUndefined() // 无 K-Proxy / 无 env / 无系统代理 ⇒ 直连
      expect(getKProxyService).not.toHaveBeenCalled()

      const on = createUpstreamApi(makeDeps({ useKProxy: () => true, getKProxyService }))
      expect(on.getNetworkAgent()).toBe(PROXY_AGENT) // 真的用上了 K-Proxy 地址
      expect(getKProxyService).toHaveBeenCalled()
    })

    it('useKProxy=true 但服务未启动时不炸，回落到后续优先级（服务端形态的真实处境）', () => {
      const api = createUpstreamApi(
        makeDeps({ useKProxy: () => true, getKProxyService: () => ({ isRunning: () => false, getConfig: () => ({ host: 'x', port: 1 }) }) })
      )
      expect(() => api.getNetworkAgent()).not.toThrow()
      expect(api.getNetworkAgent()).toBeUndefined()
    })

    it('账号绑定代理优先级最高：给了 overrideProxyUrl 就走它，不看 K-Proxy', async () => {
      const api = createUpstreamApi(
        makeDeps({ useKProxy: () => true, getKProxyService: () => ({ isRunning: () => true, getConfig: () => ({ host: 'k', port: 1 }) }) })
      )
      undiciFetchMock.mockResolvedValue(jsonResponse({}))
      await api.fetchWithAppProxy('https://example.com/x', { method: 'GET' }, 'http://127.0.0.1:1080')
      // 走的是 undici + dispatcher，而非全局 fetch
      expect(undiciFetchMock).toHaveBeenCalledTimes(1)
      expect((undiciFetchMock.mock.calls[0][1] as { dispatcher?: unknown }).dispatcher).toBe(PROXY_AGENT)
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    it('env 代理在无 K-Proxy 时被采用（四级优先级的第三级）', () => {
      process.env.HTTPS_PROXY = 'http://127.0.0.1:7897'
      const api = createUpstreamApi(makeDeps())
      expect(api.getNetworkAgent()).toBe(PROXY_AGENT)
    })
  })

  describe('single-flight：同一 refreshToken 并发只刷一次', () => {
    it('并发调用复用同一个 Promise，上游只被打一次', async () => {
      const api = createUpstreamApi(makeDeps())
      let upstreamCalls = 0
      globalThis.fetch = vi.fn(async () => {
        upstreamCalls++
        await new Promise((r) => setTimeout(r, 10))
        return jsonResponse({ accessToken: 'new-at', refreshToken: 'new-rt', expiresIn: 3600 })
      }) as unknown as typeof fetch

      const [a, b, c] = await Promise.all([
        api.refreshTokenByMethod('same-rt', 'cid', '', 'us-east-1', 'social'),
        api.refreshTokenByMethod('same-rt', 'cid', '', 'us-east-1', 'social'),
        api.refreshTokenByMethod('same-rt', 'cid', '', 'us-east-1', 'social')
      ])

      expect(upstreamCalls).toBe(1)
      expect(a.accessToken).toBe('new-at')
      expect(b.accessToken).toBe('new-at')
      expect(c.accessToken).toBe('new-at')
    })

    it('不同 refreshToken 不会被误合并', async () => {
      const api = createUpstreamApi(makeDeps())
      let n = 0
      globalThis.fetch = vi.fn(async () => {
        n++
        return jsonResponse({ accessToken: `at-${n}`, refreshToken: 'rt', expiresIn: 60 })
      }) as unknown as typeof fetch

      await Promise.all([
        api.refreshTokenByMethod('rt-1', 'cid', '', 'us-east-1', 'social'),
        api.refreshTokenByMethod('rt-2', 'cid', '', 'us-east-1', 'social')
      ])
      expect(n).toBe(2)
    })

    it('刷新完成后表项被清掉（否则第二次刷新会拿到过期的旧 Promise）', async () => {
      const api = createUpstreamApi(makeDeps())
      let n = 0
      globalThis.fetch = vi.fn(async () => {
        n++
        return jsonResponse({ accessToken: `at-${n}`, refreshToken: 'rt', expiresIn: 60 })
      }) as unknown as typeof fetch

      const first = await api.refreshTokenByMethod('rt', 'cid', '', 'us-east-1', 'social')
      const second = await api.refreshTokenByMethod('rt', 'cid', '', 'us-east-1', 'social')
      expect(first.accessToken).toBe('at-1')
      expect(second.accessToken).toBe('at-2') // 串行两次 = 真的刷了两次
      expect(n).toBe(2)
    })

    it('失败的刷新也会清表（否则一次失败会把该 token 永久钉死）', async () => {
      const api = createUpstreamApi(makeDeps())
      let n = 0
      globalThis.fetch = vi.fn(async () => {
        n++
        if (n === 1) return jsonResponse({ error: 'boom' }, 500)
        return jsonResponse({ accessToken: 'at-ok', refreshToken: 'rt', expiresIn: 60 })
      }) as unknown as typeof fetch

      const bad = await api.refreshTokenByMethod('rt', 'cid', '', 'us-east-1', 'social')
      expect(bad.success).toBe(false)
      const good = await api.refreshTokenByMethod('rt', 'cid', '', 'us-east-1', 'social')
      expect(good.success).toBe(true)
    })

    it('两个实例各有独立的 single-flight 表（这正是「一进程一实例」的原因）', async () => {
      // 本条不是在鼓励建两个实例 —— 相反,它把「建两个的后果」钉成可见事实:
      // 同一个 rotating refreshToken 被并发刷两次 → 后到的用已作废 token → 401 → 账号掉线。
      // 装配层的单例约束由 upstream_api_single_instance.test.ts 守。
      const a = createUpstreamApi(makeDeps())
      const b = createUpstreamApi(makeDeps())
      let calls = 0
      globalThis.fetch = vi.fn(async () => {
        calls++
        await new Promise((r) => setTimeout(r, 10))
        return jsonResponse({ accessToken: 'at', refreshToken: 'rt', expiresIn: 60 })
      }) as unknown as typeof fetch

      await Promise.all([
        a.refreshTokenByMethod('shared-rt', 'cid', '', 'us-east-1', 'social'),
        b.refreshTokenByMethod('shared-rt', 'cid', '', 'us-east-1', 'social')
      ])
      expect(calls).toBe(2) // 去重没跨实例生效
    })
  })

  describe('刷新分支路由：external_idp 必须先于 social 判定', () => {
    it("authMethod='external_idp'（同样无 clientSecret）走微软端点，而不是 Kiro Auth", async () => {
      // 两者都无 clientSecret,判定顺序反了 external_idp 会被当 social 发到 Kiro Auth。
      const api = createUpstreamApi(makeDeps())
      globalThis.fetch = vi.fn(async () =>
        jsonResponse({ access_token: 'ms-at', refresh_token: 'ms-rt', expires_in: 3600 })
      ) as unknown as typeof fetch

      const r = await api.refreshTokenByMethod(
        'rt',
        'client-id',
        '', // 无 clientSecret —— 与 social 同形
        'us-east-1',
        'external_idp',
        undefined,
        { tokenEndpoint: 'https://login.microsoftonline.com/tid/oauth2/v2.0/token' }
      )
      const url = String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])
      expect(url).toContain('login.microsoftonline.com')
      expect(url).not.toContain('auth.desktop.kiro.dev')
      expect(r.accessToken).toBe('ms-at') // snake_case 已归一
    })

    it("authMethod='social' 走 Kiro Auth /refreshToken", async () => {
      const api = createUpstreamApi(makeDeps())
      globalThis.fetch = vi.fn(async () => jsonResponse({ accessToken: 'at', expiresIn: 60 })) as unknown as typeof fetch
      await api.refreshTokenByMethod('rt', 'cid', '', 'us-east-1', 'social')
      expect(String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain(
        'auth.desktop.kiro.dev/refreshToken'
      )
    })

    it('external_idp 的 tokenEndpoint 非微软域名时直接拒绝，不发请求（防 SSRF）', async () => {
      const api = createUpstreamApi(makeDeps())
      globalThis.fetch = vi.fn() as unknown as typeof fetch
      const r = await api.refreshTokenByMethod('rt', 'cid', '', 'us-east-1', 'external_idp', undefined, {
        tokenEndpoint: 'https://evil.example.com/token'
      })
      expect(r.success).toBe(false)
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })
  })

  describe('TokenType 分发（2026-07 迁移后后端严格校验，缺/错 header 被拒 403）', () => {
    it.each([
      ['external_idp', 'EXTERNAL_IDP'],
      ['api_key', 'API_KEY'],
      ['social', 'SSO_OIDC'],
      [undefined, 'SSO_OIDC']
    ])('authMethod=%s → TokenType: %s', async (authMethod, expected) => {
      const api = createUpstreamApi(makeDeps())
      globalThis.fetch = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch
      await api.getUsageLimitsRest('tok', undefined, undefined, 'us-east-1', undefined, authMethod as string | undefined)
      const init = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as { headers: Record<string, string> }
      expect(init.headers['TokenType']).toBe(expected)
    })
  })

  describe('ksk_(api_key) 与 social 在兜底 ARN 上的相反处置', () => {
    it('EU + api_key：不注入 Enterprise 兜底 ARN（注入会 403 —— RCA 2026-08-02）', async () => {
      const api = createUpstreamApi(makeDeps())
      globalThis.fetch = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch
      await api.getUsageAndLimits('ksk-tok', 'ApiKey', undefined, undefined, 'eu-central-1')
      const url = String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])
      expect(url).not.toContain('profileArn')
      expect(url).toContain('management.eu-central-1.kiro.dev')
    })

    it('EU + 非 api_key 且无 ARN：注入 EU V2 兜底 ARN（EU 后端强制要求）', async () => {
      const api = createUpstreamApi(makeDeps())
      globalThis.fetch = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch
      await api.getUsageLimitsRest('tok', undefined, undefined, 'eu-central-1', undefined, 'IdC')
      const url = String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])
      expect(url).toContain('profileArn')
    })

    it('社交账号无 ARN 时注入固定社交 ARN（与 ksk_ 相反）', async () => {
      const api = createUpstreamApi(makeDeps())
      globalThis.fetch = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch
      await api.getUsageAndLimits('tok', 'Google')
      const url = String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])
      expect(decodeURIComponent(url)).toContain('arn:aws:codewhisperer')
    })

    it('历史 ksk_ 账号（authMethod 为 undefined、仅 idp=ApiKey）也被归一为 api_key', async () => {
      // 双判据归一化:否则历史账号会走进 EU 兜底 ARN 分支 → 403。
      const api = createUpstreamApi(makeDeps())
      globalThis.fetch = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch
      await api.getUsageAndLimits('tok', 'ApiKey', undefined, undefined, 'eu-central-1', undefined, undefined)
      const init = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as { headers: Record<string, string> }
      expect(init.headers['TokenType']).toBe('API_KEY')
    })
  })

  describe('数据面 host 按 profileArn 的真实 region 选（而非 account.region）', () => {
    it('account.region=us-east-2 但 profile 在 eu-central-1 → 打 EU host', async () => {
      const api = createUpstreamApi(makeDeps())
      globalThis.fetch = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch
      await api.getUsageLimitsRest(
        'tok',
        'arn:aws:codewhisperer:eu-central-1:316704942615:profile/H3A4HCGR4WEC',
        undefined,
        'us-east-2'
      )
      expect(String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain(
        'management.eu-central-1.kiro.dev'
      )
    })

    it('主端点 403 时回落到 V1 备用 host', async () => {
      const api = createUpstreamApi(makeDeps())
      let n = 0
      globalThis.fetch = vi.fn(async () => {
        n++
        return n === 1 ? jsonResponse({}, 403) : jsonResponse({ usageBreakdownList: [] })
      }) as unknown as typeof fetch

      await api.getUsageLimitsRest('tok', undefined, undefined, 'us-east-1')
      const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      expect(String(calls[0][0])).toContain('management.us-east-1.kiro.dev')
      expect(String(calls[1][0])).toContain('q.us-east-1.amazonaws.com')
    })
  })

  describe('REST → 统一形状的归一（时间戳 / freeTrial 字段）', () => {
    it('nextDateReset 的 Unix 秒被转成 ISO；freeTrialInfo/bonuses 时间戳同款', async () => {
      const api = createUpstreamApi(makeDeps())
      globalThis.fetch = vi.fn(async () =>
        jsonResponse({
          nextDateReset: 1767225600,
          usageBreakdownList: [
            {
              type: 'AGENTIC_REQUEST',
              currentUsage: 10,
              freeTrialInfo: { freeTrialExpiry: 1767225600, currentUsage: 1 },
              bonuses: [{ bonusCode: 'B1', expiresAt: 1767225600 }]
            }
          ]
        })
      ) as unknown as typeof fetch

      const r = await api.getUsageAndLimits('tok')
      expect(r.nextDateReset).toBe(new Date(1767225600 * 1000).toISOString())
      expect(r.usageBreakdownList?.[0].freeTrialInfo?.freeTrialExpiry).toBe(new Date(1767225600 * 1000).toISOString())
      expect(r.usageBreakdownList?.[0].bonuses?.[0].expiresAt).toBe(new Date(1767225600 * 1000).toISOString())
      // resourceType 缺失时回落到 type
      expect(r.usageBreakdownList?.[0].resourceType).toBe('AGENTIC_REQUEST')
    })

    it('CBOR 401 时自动回落 REST（Enterprise/IdC 账号在 CBOR 门户上会 401）', async () => {
      const api = createUpstreamApi(makeDeps({ getUsageApiType: () => 'cbor' }))
      let n = 0
      globalThis.fetch = vi.fn(async () => {
        n++
        if (n === 1) {
          return {
            ok: false,
            status: 401,
            arrayBuffer: async () => new Uint8Array([0xa0]).buffer
          } as unknown as Response
        }
        return jsonResponse({ usageBreakdownList: [{ type: 'X' }] })
      }) as unknown as typeof fetch

      const r = await api.getUsageAndLimits('tok')
      expect(String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1][0])).toContain('/getUsageLimits')
      expect(r.usageBreakdownList?.[0].resourceType).toBe('X')
    })

    it('CBOR 非 401/403 的错误不吞不回落，原样抛出', async () => {
      const api = createUpstreamApi(makeDeps({ getUsageApiType: () => 'cbor' }))
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 500,
        arrayBuffer: async () => new Uint8Array([0xa0]).buffer
      })) as unknown as typeof fetch

      await expect(api.getUsageAndLimits('tok')).rejects.toThrow(/500/)
    })
  })

  it('getUserInfo 走 CBOR GetUserInfo RPC', async () => {
    const api = createUpstreamApi(makeDeps())
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([0xa0]).buffer
    })) as unknown as typeof fetch
    await api.getUserInfo('tok')
    expect(String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain('GetUserInfo')
  })
})
