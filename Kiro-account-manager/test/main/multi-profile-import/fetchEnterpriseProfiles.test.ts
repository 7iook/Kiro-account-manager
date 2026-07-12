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
    const fetcher = vi.fn().mockResolvedValue(makeResponse(backendPayload))

    const profiles = await fetchEnterpriseProfiles(baseAccount, { fetcher })

    expect(fetcher).toHaveBeenCalledOnce()
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
    const fetcher = vi.fn().mockResolvedValue(makeResponse({ profiles: [] }))

    await expect(fetchEnterpriseProfiles(baseAccount, { fetcher })).rejects.toThrow(NO_PROFILES_AVAILABLE)
  })

  it('A2 变体: 后端返 undefined profiles 字段时同样抛 NO_PROFILES_AVAILABLE', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeResponse({}))

    await expect(fetchEnterpriseProfiles(baseAccount, { fetcher })).rejects.toThrow(NO_PROFILES_AVAILABLE)
  })

  it('A3: 后端返 4xx 时抛错并透传 status + backend errorMessage(不吞)', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse('{"errorMessage":"Invalid token"}', { status: 403, statusText: 'Forbidden' })
    )

    await expect(fetchEnterpriseProfiles(baseAccount, { fetcher })).rejects.toMatchObject({
      message: expect.stringMatching(/403|Invalid token/)
    })
  })

  it('A3 变体: 后端返 5xx 时抛错并透传 status', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse('Internal Server Error', { status: 500, statusText: 'Internal Server Error' })
    )

    await expect(fetchEnterpriseProfiles(baseAccount, { fetcher })).rejects.toMatchObject({
      message: expect.stringMatching(/500/)
    })
  })

  it('A3 变体: 单 profile 场景也返数组(不"退化"成单值,类型稳定)', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse({ profiles: [{ arn: 'arn:aws:codewhisperer:us-east-1:1:profile/only', profileName: 'Only' }] })
    )

    const profiles: KiroProfile[] = await fetchEnterpriseProfiles(baseAccount, { fetcher })

    expect(Array.isArray(profiles)).toBe(true)
    expect(profiles).toHaveLength(1)
    expect(profiles[0].profileArn).toBe('arn:aws:codewhisperer:us-east-1:1:profile/only')
  })
})
