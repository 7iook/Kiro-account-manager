/**
 * refreshOidcToken 跨 region 自动重试
 *
 * 用户手动填 OIDC 凭证或 SSO 登录时 region 选错 → AWS OIDC endpoint 拒 400
 * "Invalid token provided" / "invalid_request"。老实现直接失败让用户困惑;
 * 本轮改成跨 KNOWN_CW_REGIONS 自动重试,成功时返回 resolvedRegion 供上层
 * 写回 account.region。
 */
import { describe, it, expect, vi } from 'vitest'
import { refreshOidcTokenAcrossRegions } from '@main/oidcRefresh'

const KNOWN = ['us-east-1', 'eu-central-1'] as const

function mkResp(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Err',
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('refreshOidcTokenAcrossRegions cross-region auto-retry', () => {
  it('B1: 主 region 200 → 直接成功,不试其他 region', async () => {
    const fetcher = vi.fn().mockImplementation(async () =>
      mkResp({ accessToken: 'AT', refreshToken: 'RT2', expiresIn: 3600 })
    )

    const result = await refreshOidcTokenAcrossRegions('rt', 'ci', 'cs', 'us-east-1', { fetcher, regions: KNOWN })

    expect(result.success).toBe(true)
    expect(result.accessToken).toBe('AT')
    expect(result.resolvedRegion).toBe('us-east-1')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toContain('oidc.us-east-1.amazonaws.com')
  })

  it('B2: 主 region 400 Invalid token + 备用 region 200 → 走备用,返 resolvedRegion=备用', async () => {
    const fetcher = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('eu-central-1')) {
        return mkResp('{"error":"invalid_request","error_description":"Invalid token provided"}', { status: 400 })
      }
      return mkResp({ accessToken: 'AT_US', refreshToken: 'RT_US', expiresIn: 3600 })
    })

    const result = await refreshOidcTokenAcrossRegions('rt', 'ci', 'cs', 'eu-central-1', { fetcher, regions: KNOWN })

    expect(result.success).toBe(true)
    expect(result.accessToken).toBe('AT_US')
    expect(result.resolvedRegion).toBe('us-east-1')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('B3: 主 region 400 invalid_grant + 备用 region 400 → 最终失败,error 含最后一次响应', async () => {
    const fetcher = vi.fn().mockImplementation(async () =>
      mkResp('{"error":"invalid_grant","error_description":"Invalid refresh token"}', { status: 400 })
    )

    const result = await refreshOidcTokenAcrossRegions('rt', 'ci', 'cs', 'eu-central-1', { fetcher, regions: KNOWN })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/400|invalid_grant/)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('B4: 主 region 5xx (非 region 错) → 不重试其他 region,避免掩盖真实网络故障', async () => {
    const fetcher = vi.fn().mockImplementation(async () =>
      mkResp('Internal Server Error', { status: 500 })
    )

    const result = await refreshOidcTokenAcrossRegions('rt', 'ci', 'cs', 'us-east-1', { fetcher, regions: KNOWN })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/500/)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('B5: 主 region 网络异常(fetcher throw)→ 也不重试', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    const result = await refreshOidcTokenAcrossRegions('rt', 'ci', 'cs', 'us-east-1', { fetcher, regions: KNOWN })

    expect(result.success).toBe(false)
    expect(result.error).toContain('ECONNREFUSED')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('B6: 未知 region(不在 KNOWN_CW_REGIONS 中)也应作为主 region 首先尝试', async () => {
    const fetcher = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('ap-southeast-1')) {
        return mkResp({ accessToken: 'AT_AP', refreshToken: 'RT_AP', expiresIn: 3600 })
      }
      return mkResp('nope', { status: 400 })
    })

    const result = await refreshOidcTokenAcrossRegions('rt', 'ci', 'cs', 'ap-southeast-1', { fetcher, regions: KNOWN })

    expect(result.success).toBe(true)
    expect(result.resolvedRegion).toBe('ap-southeast-1')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
