/**
 * A1-A3: fetchEnterpriseProfiles 核心行为测试
 *
 * 新函数与老 fetchEnterpriseProfileArn 并存,专给多 profile 登录路径(external_idp + IdC 共用)。
 * 通过 fetcher 依赖注入避免真实网络 —— 老 fetchEnterpriseProfileArn 一行不动。
 */
import { describe, it, expect, vi } from 'vitest'
import { fetchEnterpriseProfiles, NO_PROFILES_AVAILABLE, type KiroProfile } from '@main/proxy/kiroApi'
import type { ProxyAccount } from '@main/proxy/types'

// helper: 构造一个可控的 Response(避免依赖真实 undici / node 全局)
function makeResponse(body: unknown, init: { status?: number; ok?: boolean; statusText?: string } = {}): Response {
  const status = init.status ?? 200
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    statusText: init.statusText ?? (status === 200 ? 'OK' : 'Err'),
    headers: { 'Content-Type': 'application/json' }
  })
}

const baseAccount: ProxyAccount = {
  id: 'test-acct',
  accessToken: 'fake-access-token',
  region: 'us-east-1',
  provider: 'ExternalIdp',
  authMethod: 'external_idp'
}

describe('fetchEnterpriseProfiles', () => {
  it('A1: 后端返 N 个 profile 应无损保留全部元素(不取 [0])', async () => {
    const backendPayload = {
      profiles: [
        { arn: 'arn:aws:codewhisperer:us-east-1:111:profile/dev-profile', profileName: 'Dev', accountName: 'AcctA' },
        { arn: 'arn:aws:codewhisperer:us-east-1:222:profile/prod-profile', profileName: 'Prod', accountName: 'AcctB' },
        { arn: 'arn:aws:codewhisperer:eu-central-1:333:profile/eu-profile', profileName: 'EU', accountName: 'AcctC' }
      ]
    }
    // 用 mockImplementation 而不是 mockResolvedValue,每次调用返回新 Response(否则 body 只能读一次)
    const fetcher = vi.fn().mockImplementation(async () => makeResponse(backendPayload))

    const profiles = await fetchEnterpriseProfiles(baseAccount, { fetcher })

    // 跨 region 探测会调 2 次(主 + 备用),两个 region 都返同批 profile,按 arn 去重后仍 3 个
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(profiles).toHaveLength(3)
    // 无损保留:每个 profile 的 arn + 展示字段都应带回
    expect(profiles.map((p) => p.profileArn)).toEqual([
      'arn:aws:codewhisperer:us-east-1:111:profile/dev-profile',
      'arn:aws:codewhisperer:us-east-1:222:profile/prod-profile',
      'arn:aws:codewhisperer:eu-central-1:333:profile/eu-profile'
    ])
    expect(profiles[0].profileName).toBe('Dev')
    expect(profiles[1].accountName).toBe('AcctB')
    // 顺序保留
    expect(profiles[2].profileArn).toContain('eu-profile')
  })

  it('A2: 后端返空 profiles 数组时应抛 NO_PROFILES_AVAILABLE(不返空数组给上游)', async () => {
    const fetcher = vi.fn().mockImplementation(async () => makeResponse({ profiles: [] }))

    await expect(fetchEnterpriseProfiles(baseAccount, { fetcher })).rejects.toThrow(NO_PROFILES_AVAILABLE)
  })

  it('A2 变体: 后端返 undefined profiles 字段时同样抛 NO_PROFILES_AVAILABLE', async () => {
    const fetcher = vi.fn().mockImplementation(async () => makeResponse({}))

    await expect(fetchEnterpriseProfiles(baseAccount, { fetcher })).rejects.toThrow(NO_PROFILES_AVAILABLE)
  })

  it('A3: 后端返 4xx 时抛错并透传 status + backend errorMessage(不吞)', async () => {
    const fetcher = vi.fn().mockImplementation(async () =>
      makeResponse('{"errorMessage":"Invalid token"}', { status: 403, statusText: 'Forbidden' })
    )

    await expect(fetchEnterpriseProfiles(baseAccount, { fetcher })).rejects.toMatchObject({
      message: expect.stringMatching(/403|Invalid token/)
    })
  })

  it('A3 变体: 后端返 5xx 时抛错并透传 status', async () => {
    const fetcher = vi.fn().mockImplementation(async () =>
      makeResponse('Internal Server Error', { status: 500, statusText: 'Internal Server Error' })
    )

    await expect(fetchEnterpriseProfiles(baseAccount, { fetcher })).rejects.toMatchObject({
      message: expect.stringMatching(/500/)
    })
  })

  it('A3 变体: 单 profile 场景也返数组(不"退化"成单值,类型稳定)', async () => {
    const fetcher = vi.fn().mockImplementation(async () =>
      makeResponse({ profiles: [{ arn: 'arn:aws:codewhisperer:us-east-1:1:profile/only', profileName: 'Only' }] })
    )

    const profiles: KiroProfile[] = await fetchEnterpriseProfiles(baseAccount, { fetcher })

    expect(Array.isArray(profiles)).toBe(true)
    // 两 region 都返同 arn,去重后 1 个
    expect(profiles).toHaveLength(1)
    expect(profiles[0].profileArn).toBe('arn:aws:codewhisperer:us-east-1:1:profile/only')
  })

  // Cross-region 探测:同一 SSO 账户挂多 region 的 Kiro Profile,应全部合并返回
  // 参见 6ab368b commit 未修变体 + 用户真实场景(us-east-1 + eu-central-1 各挂 1 profile)
  describe('A4: cross-region 合并', () => {
    it('A4-1: account.region=eu-central-1 但 us-east-1 也有 profile 时应合并两个 region 结果', async () => {
      const euAccount: ProxyAccount = { ...baseAccount, region: 'eu-central-1' }
      const fetcher = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('eu-central-1')) {
          return makeResponse({
            profiles: [{ arn: 'arn:aws:codewhisperer:eu-central-1:672:profile/EU_PROFILE', profileName: 'EU', accountName: 'OrgA', region: 'eu-central-1' }]
          })
        }
        if (url.includes('us-east-1')) {
          return makeResponse({
            profiles: [{ arn: 'arn:aws:codewhisperer:us-east-1:672:profile/US_PROFILE', profileName: 'US', accountName: 'OrgA', region: 'us-east-1' }]
          })
        }
        return makeResponse({ profiles: [] })
      })

      const profiles = await fetchEnterpriseProfiles(euAccount, { fetcher })

      // 两个 region 都应被探测
      expect(fetcher).toHaveBeenCalledTimes(2)
      // 合并保留两个 profile
      expect(profiles).toHaveLength(2)
      const arns = profiles.map((p) => p.profileArn).sort()
      expect(arns).toContain('arn:aws:codewhisperer:eu-central-1:672:profile/EU_PROFILE')
      expect(arns).toContain('arn:aws:codewhisperer:us-east-1:672:profile/US_PROFILE')
    })

    it('A4-2: 主 region 有 profile 且备用 region 也返同一 arn 时按 arn 去重', async () => {
      // 有些环境两个 region 都能查到同一 arn(镜像返回);去重避免 UI 显示重复项
      const dupArn = 'arn:aws:codewhisperer:us-east-1:672:profile/SAME'
      const fetcher = vi.fn().mockResolvedValue(
        makeResponse({ profiles: [{ arn: dupArn, profileName: 'Same' }] })
      )

      const profiles = await fetchEnterpriseProfiles(baseAccount, { fetcher })

      // 两个 region 都探,但同 arn 只留一份
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(profiles).toHaveLength(1)
      expect(profiles[0].profileArn).toBe(dupArn)
    })

    it('A4-3: 备用 region 返 4xx 时不阻塞主 region 结果', async () => {
      const fetcher = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('us-east-1')) {
          return makeResponse({
            profiles: [{ arn: 'arn:aws:codewhisperer:us-east-1:1:profile/US', profileName: 'US' }]
          })
        }
        // eu 拒了
        return makeResponse('{"errorMessage":"Access denied"}', { status: 403, statusText: 'Forbidden' })
      })

      const profiles = await fetchEnterpriseProfiles(baseAccount, { fetcher })

      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(profiles).toHaveLength(1)
      expect(profiles[0].profileArn).toContain('US')
    })

    it('A4-4: 主 region 4xx + 备用 region 有 profile → 抛错(与主要 region 保持透明,一致行为)', async () => {
      // 说明:主 region 拒 = 请求本身有问题(token/权限);不应通过"备用 region 恰好能拿到"来掩盖主 region 的失败
      // 但为了兼容用户跨 region 场景(主是 EU 空,US 有),关键判据是主 region "空 vs 拒":空可以跨,拒不跨
      const euAccount: ProxyAccount = { ...baseAccount, region: 'eu-central-1' }
      const fetcher = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('eu-central-1')) {
          return makeResponse('{"errorMessage":"Invalid token"}', { status: 403, statusText: 'Forbidden' })
        }
        return makeResponse({ profiles: [{ arn: 'arn:aws:codewhisperer:us-east-1:1:profile/US' }] })
      })

      await expect(fetchEnterpriseProfiles(euAccount, { fetcher })).rejects.toMatchObject({
        message: expect.stringMatching(/403|Invalid token/)
      })
    })

    it('A4-5: 所有 region 都空时抛 NO_PROFILES_AVAILABLE', async () => {
      const fetcher = vi.fn().mockResolvedValue(makeResponse({ profiles: [] }))

      await expect(fetchEnterpriseProfiles(baseAccount, { fetcher })).rejects.toThrow(NO_PROFILES_AVAILABLE)
      expect(fetcher).toHaveBeenCalledTimes(2)
    })
  })
})
