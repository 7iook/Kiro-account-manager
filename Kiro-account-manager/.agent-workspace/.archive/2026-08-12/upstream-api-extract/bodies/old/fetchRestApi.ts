async function fetchRestApi(
  baseUrl: string,
  path: string,
  accessToken: string,
  machineId?: string,
  authMethod?: string  // external_idp 需 TokenType: EXTERNAL_IDP header，否则 CW REST 403
): Promise<Response> {
  const agent = getKProxyAgent()
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': getKiroUserAgent(machineId),
    'x-amz-user-agent': getKiroAmzUserAgent(machineId)
  }
  // TokenType 分发(2026-07 迁移铁律 · 与 kiroApi.fetchEnterpriseProfileArn 保持一致):
  // - external_idp (Azure AD) → 'EXTERNAL_IDP' 走外部 IdP 校验路径
  // - 其他(IdC/BuilderId/Social) → 'SSO_OIDC' 走 AWS SSO OIDC 校验路径
  // - api_key (网页 ksk_) → 'API_KEY' 走 key→profile 查找路径
  //   实测(2026-07-21):getUsageLimits?profileArn=... + TokenType: API_KEY 返 200 完整额度(currentUsage/usageLimit/subscriptionInfo/userInfo)。
  //   注:之前"额度对 API_KEY 返 403"的判断把不存在的 CBOR GetUsage RPC(400 UnknownOperation)与可用的 REST getUsageLimits 混淆了。
  // 后端在 2026-07 迁移后开始严格校验 TokenType header,缺 header 被当 legacy 拒 403 "Invalid token"
  headers['TokenType'] =
    authMethod === 'external_idp' ? 'EXTERNAL_IDP' : authMethod === 'api_key' ? 'API_KEY' : 'SSO_OIDC'
  const url = `${baseUrl}${path}`
  if (agent) {
    return await undiciFetch(url, {
      method: 'GET',
      headers,
      dispatcher: agent
    } as UndiciRequestInit) as unknown as Response
  }
  return await fetchWithAppProxy(url, { method: 'GET', headers })
}
