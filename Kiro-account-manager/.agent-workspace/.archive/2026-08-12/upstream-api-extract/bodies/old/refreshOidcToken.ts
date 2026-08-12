async function refreshOidcToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  region: string = 'us-east-1',
  proxyUrl?: string  // 账号绑定的代理 URL（可选，优先级最高）
): Promise<OidcRefreshResult> {
  console.log(`[OIDC] Refreshing token with clientId: ${clientId.substring(0, 20)}...${proxyUrl ? ' [via bound proxy]' : ''} primary region: ${region}`)

  const result = await refreshOidcTokenAcrossRegions(refreshToken, clientId, clientSecret, region, {
    fetcher: fetchWithAppProxy,
    // SSO OIDC 在每个 AWS region 有独立实例(含 us-east-2 等),不受 CW 数据面二选一限制。
    // 要 CW 数据面 region 请用 KNOWN_CW_DATA_REGIONS;这里确定属 SSO 用途。
    regions: KNOWN_SSO_OIDC_REGIONS,
    proxyUrl
  })

  if (result.success) {
    if (result.resolvedRegion && result.resolvedRegion !== region) {
      console.warn(`[OIDC] Refreshed via fallback region ${result.resolvedRegion}(primary=${region});上层应写回 account.credentials.region`)
    } else {
      console.log(`[OIDC] Token refreshed @${result.resolvedRegion}, expires in ${result.expiresIn}s`)
    }
  } else {
    console.error(`[OIDC] Refresh failed across all probed regions: ${result.error}`)
  }

  return result as OidcRefreshResult
}
