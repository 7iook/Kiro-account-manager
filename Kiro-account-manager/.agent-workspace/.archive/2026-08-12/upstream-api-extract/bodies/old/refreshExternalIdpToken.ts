async function refreshExternalIdpToken(
  refreshToken: string,
  clientId: string,
  tokenEndpoint?: string,
  scopes?: string,
  proxyUrl?: string
): Promise<OidcRefreshResult> {
  console.log(`[ExternalIdp] Refreshing token via Microsoft endpoint...${proxyUrl ? ' [via bound proxy]' : ''}`)

  let endpoint: string
  try {
    endpoint = validateMicrosoftTokenEndpoint(tokenEndpoint)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[ExternalIdp] Invalid tokenEndpoint: ${msg}`)
    return { success: false, error: msg }
  }
  if (!clientId) return { success: false, error: 'external_idp 刷新缺少 clientId' }
  if (!refreshToken) return { success: false, error: 'external_idp 刷新缺少 refreshToken' }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken
  })
  if (scopes) body.set('scope', scopes)

  try {
    const response = await fetchWithAppProxy(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: body.toString()
    }, proxyUrl)

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[ExternalIdp] Refresh failed: ${response.status} - ${errorText}`)
      return { success: false, error: `HTTP ${response.status}: ${errorText}` }
    }

    // 微软端点返回 snake_case: access_token / refresh_token / expires_in
    const data = await response.json()
    if (!data.access_token) {
      return { success: false, error: `刷新响应缺少 access_token: ${JSON.stringify(data).slice(0, 200)}` }
    }
    console.log(`[ExternalIdp] Token refreshed successfully, expires in ${data.expires_in}s`)
    return {
      success: true,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresIn: data.expires_in
    }
  } catch (error) {
    console.error(`[ExternalIdp] Refresh error:`, error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}
