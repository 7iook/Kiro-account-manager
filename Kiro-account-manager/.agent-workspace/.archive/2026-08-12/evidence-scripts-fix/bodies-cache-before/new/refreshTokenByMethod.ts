async function refreshTokenByMethod(
  token: string,
  clientId: string,
  clientSecret: string,
  region: string = 'us-east-1',
  authMethod?: string,
  proxyUrl?: string,  // 账号绑定的代理 URL（可选，优先级最高）
  externalIdp?: { tokenEndpoint?: string; scopes?: string }  // external_idp 刷新专用
): Promise<OidcRefreshResult> {
  const existing = inFlightRefreshByToken.get(token)
  if (existing) return existing
  const p = refreshTokenByMethodInner(token, clientId, clientSecret, region, authMethod, proxyUrl, externalIdp)
    .finally(() => { inFlightRefreshByToken.delete(token) })
  inFlightRefreshByToken.set(token, p)
  return p
}
