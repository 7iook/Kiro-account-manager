async function refreshTokenByMethodInner(
  token: string,
  clientId: string,
  clientSecret: string,
  region: string = 'us-east-1',
  authMethod?: string,
  proxyUrl?: string,  // 账号绑定的代理 URL（可选，优先级最高）
  externalIdp?: { tokenEndpoint?: string; scopes?: string }  // external_idp 刷新专用
): Promise<OidcRefreshResult> {
  // external_idp (Azure AD 等外部 IdP)：走微软 tokenEndpoint 刷新。
  // 必须优先于 social 判定——external_idp 与 social 都无 clientSecret，否则会被误判为 social 走错端点。
  if (authMethod === 'external_idp') {
    return refreshExternalIdpToken(token, clientId, externalIdp?.tokenEndpoint, externalIdp?.scopes, proxyUrl)
  }
  // 如果是社交登录，使用 Kiro Auth Service 刷新
  if (authMethod === 'social') {
    return refreshSocialToken(token, proxyUrl)
  }
  // 否则使用 OIDC 刷新 (IdC/BuilderId)
  return refreshOidcToken(token, clientId, clientSecret, region, proxyUrl)
}
