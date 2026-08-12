/**
 * Token 刷新的三条分支（IdC/BuilderId OIDC · 社交 · external_idp）+ single-flight 协调器。
 *
 * single-flight 表是**工厂闭包内的私有状态**，不接受注入 —— 理由见 `transport.ts` 头部第 1 项：
 * 它的不变量作用域就是实例本身，做成注入项后任何调用方漏传就静默失去去重，
 * 而后果是账号被上游踢下线。
 */
import { refreshOidcTokenAcrossRegions } from '../oidcRefresh'
import { KNOWN_SSO_OIDC_REGIONS } from '../proxy/kiroApi'
import { KIRO_AUTH_ENDPOINT, getKiroUserAgent, type UpstreamTransport } from './transport'
import type { OidcRefreshResult } from './types'

// external_idp (微软 Azure AD 等外部 IdP) Token 刷新
// 走账户自带的微软 tokenEndpoint（form-urlencoded），不走 AWS OIDC。
// 参考 9router kiroExternalIdp.js + kiro-switch oidc.py。
const MICROSOFT_TOKEN_ENDPOINT_HOSTS = new Set([
  'login.microsoftonline.com',
  'login.microsoft.com',
  'login.windows.net'
])

// 校验 tokenEndpoint 必须是微软登录端点（https + 域名白名单），防 SSRF / 误配
export function validateMicrosoftTokenEndpoint(rawEndpoint?: string): string {
  const tokenEndpoint = (rawEndpoint || '').trim()
  if (!tokenEndpoint) throw new Error('缺少 tokenEndpoint')
  let parsed: URL
  try {
    parsed = new URL(tokenEndpoint)
  } catch {
    throw new Error('tokenEndpoint 不是合法 URL')
  }
  if (parsed.protocol !== 'https:') throw new Error('tokenEndpoint 必须使用 https')
  if (!MICROSOFT_TOKEN_ENDPOINT_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('tokenEndpoint 必须是微软登录端点 (login.microsoftonline.com 等)')
  }
  return parsed.toString()
}

/** 刷新能力的对外形状（`ssoDeviceAuth` 在 sso.ts，用量在 usage.ts）。 */
export interface UpstreamRefresh {
  refreshTokenByMethod: (
    token: string,
    clientId: string,
    clientSecret: string,
    region?: string,
    authMethod?: string,
    proxyUrl?: string,
    externalIdp?: { tokenEndpoint?: string; scopes?: string }
  ) => Promise<OidcRefreshResult>
}

export function createRefresh(transport: UpstreamTransport): UpstreamRefresh {
  const { fetchWithAppProxy } = transport

  // IdC (BuilderId) 的 OIDC Token 刷新
  // 跨 region 自动重试 + resolvedRegion 回写详见 ./oidcRefresh.ts(pure fn,可测)
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

  // 社交登录 (GitHub/Google) 的 Token 刷新
  async function refreshSocialToken(
    refreshToken: string,
    proxyUrl?: string  // 账号绑定的代理 URL（可选，优先级最高）
  ): Promise<OidcRefreshResult> {
    console.log(`[Social] Refreshing token...${proxyUrl ? ' [via bound proxy]' : ''}`)

    const url = `${KIRO_AUTH_ENDPOINT}/refreshToken`
    const machineId = transport.getDeviceIdForUa()

    try {
      const response = await fetchWithAppProxy(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': getKiroUserAgent(machineId)
        },
        body: JSON.stringify({ refreshToken })
      }, proxyUrl)
      
      if (!response.ok) {
        const errorText = await response.text()
        console.error(`[Social] Refresh failed: ${response.status} - ${errorText}`)
        return { success: false, error: `HTTP ${response.status}: ${errorText}` }
      }
      
      const data = await response.json()
      console.log(`[Social] Token refreshed successfully, expires in ${data.expiresIn}s`)
      
      return {
        success: true,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || refreshToken,
        expiresIn: data.expiresIn
      }
    } catch (error) {
      console.error(`[Social] Refresh error:`, error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  }

  // external_idp 的 Token 刷新：POST 微软 tokenEndpoint，form-urlencoded
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

  // 通用 Token 刷新 - 根据 authMethod 选择刷新方式
  /**
   * 统一刷新协调器（single-flight，按 refresh token 去重）。
   * 主进程内的后台批量刷新 / 主动续期 / IPC 手动刷新 / 代理 403 恢复等多个入口，
   * 之前可能并发刷新同一个 rotating refresh token——先返回的把 token 轮换掉后，
   * 后到的请求再用已作废的旧 token 刷新 → 401 → 账户被踢下线。
   * 这里让同一 token 的并发刷新复用同一个 Promise，彻底消除该竞态窗口。
   */
  const inFlightRefreshByToken = new Map<string, Promise<OidcRefreshResult>>()

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

  return { refreshTokenByMethod }
}
