/**
 * OIDC Token 刷新 · 跨 region 自动重试(pure TS,无 electron 依赖,可测)
 *
 * 用户传入的 region 可能与 refresh_token 实际注册的 IdC 实例 region 不匹配
 * (例如手动填 OIDC 凭证时选错 UI 下拉),AWS SSO OIDC endpoint 会拒 400
 * "Invalid token provided" / "invalid_request"。这里跨 KNOWN_SSO_OIDC_REGIONS 自动
 * 重试;成功时 resolvedRegion 带回真实 region 让上层写回 account.region。
 *
 * ⚠ 历史补证(2026-07-22):早期代码把 KNOWN_CW_REGIONS(仅 2 个 CW 数据面 region)
 * 混用到这里,导致 sso=us-east-2 账户跨 region fallback 探不到 → token 过期后
 * 永久失活。修法拆两个常量:KNOWN_CW_DATA_REGIONS 仅数据面,KNOWN_SSO_OIDC_REGIONS
 * 含全 21 个商用 region(SSO OIDC 在每个 AWS region 有独立实例)。
 * 见 .agent-workspace/.archive/2026-07-22/account-weighted-capability-routing/
 *
 * 参见 RCA: .agent-workspace/.archive/2026-07-16/oidc-refresh-cross-region/
 */

export interface OidcTokenRefreshResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  error?: string
  /** 成功时的真实 region;供上层写回 account.credentials.region 避免下次再走弯路 */
  resolvedRegion?: string
}

export type OidcFetcher = (
  url: string,
  options: RequestInit,
  proxyUrl?: string
) => Promise<Response>

/** 单 region attempt · 不涉及跨 region 逻辑,方便单元测试独立各 region 行为 */
export async function attemptOidcRefreshAtRegion(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  region: string,
  fetcher: OidcFetcher,
  proxyUrl?: string
): Promise<OidcTokenRefreshResult> {
  const url = `https://oidc.${region}.amazonaws.com/token`
  const payload = { clientId, clientSecret, refreshToken, grantType: 'refresh_token' }

  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, proxyUrl)

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      return { success: false, error: `HTTP ${response.status}: ${errorText}`, resolvedRegion: region }
    }

    const data = await response.json() as { accessToken?: string; refreshToken?: string; expiresIn?: number }
    return {
      success: true,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken,
      expiresIn: data.expiresIn,
      resolvedRegion: region
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      resolvedRegion: region
    }
  }
}

/**
 * 判断错误是否是"region 选错"信号 —— 主 region 拒这类错时跨 region 重试。
 * 5xx / 网络错误不重试,避免掩盖真实故障。
 */
export function isOidcRegionMismatchError(error: string | undefined): boolean {
  if (!error) return false
  const lower = error.toLowerCase()
  return (
    lower.includes('invalid_grant') ||
    lower.includes('invalid_request') ||
    lower.includes('invalid_client') ||
    lower.includes('invalid token') ||
    lower.includes('unauthorized') ||
    lower.includes('http 400') ||
    lower.includes('http 401')
  )
}

export interface RefreshOidcTokenAcrossRegionsOptions {
  fetcher: OidcFetcher
  regions: readonly string[]
  proxyUrl?: string
}

/**
 * 跨 KNOWN_SSO_OIDC_REGIONS 顺序探测,主 region 优先,只在 region-mismatch 错误时才走
 * fallback,保持网络/5xx 立即失败的语义。
 */
export async function refreshOidcTokenAcrossRegions(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  primaryRegion: string,
  options: RefreshOidcTokenAcrossRegionsOptions
): Promise<OidcTokenRefreshResult> {
  const probeRegions: string[] = [primaryRegion, ...options.regions.filter((r) => r !== primaryRegion)]

  let lastResult: OidcTokenRefreshResult | null = null
  for (let i = 0; i < probeRegions.length; i++) {
    const r = probeRegions[i]
    const result = await attemptOidcRefreshAtRegion(refreshToken, clientId, clientSecret, r, options.fetcher, options.proxyUrl)

    if (result.success) {
      return result
    }
    lastResult = result

    // 非 region-mismatch 错误(5xx / 网络)→ 立即失败,不再重试
    if (!isOidcRegionMismatchError(result.error)) {
      break
    }
  }

  return lastResult ?? { success: false, error: 'unknown', resolvedRegion: primaryRegion }
}
