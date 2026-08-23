/**
 * 用量查询：`getUsageLimitsRest`（REST GetUsageLimits）+ `getUsageAndLimits`（统一入口）
 * + `getUserInfo`（CBOR GetUserInfo）。
 *
 * **这个文件里的注释是业务知识本体，不是说明文字。** 五处（TokenType 分发 /
 * resolveUsageLimitsProfileArn 决策表：BuilderId 固定 ARN 原样、仅 V1 企业废 → V2、
 * api_key 必须排除 / 数据面 host 按真实 profileArn region / social 与 ksk_ 相反处置 /
 * CBOR 401-403 fallback）每一处都是一次 RCA 换来的受控对照结论，
 * 逐字保留 —— 重写或「顺手整理」等于把证据扔掉。
 */
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { classifyProfileArnKind, resolveUsageLimitsProfileArn } from '../kiroAuthSync'
import { normalizeImportAuth } from '../../shared/importAuthIdentity'
import { parseRegionFromProfileArn, isKiroApiDebug } from '../proxy/kiroApi'
import {
  getRestApiBase,
  getFallbackRestApiBase,
  getKiroUserAgent,
  getKiroAmzUserAgent,
  type UpstreamTransport
} from './transport'
import type { UsageApiType, UsageLimitsResponse, UnifiedUsageResponse, UserInfoResponse } from './types'

// 辅助函数：将 Unix 时间戳（秒）或 ISO 字符串转换为 ISO 字符串
export function normalizeResetDate(value: number | string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') {
    // Unix 时间戳（秒），转换为毫秒后创建 Date
    return new Date(value * 1000).toISOString()
  }
  return value
}

export interface UpstreamUsage {
  getUsageLimitsRest: (
    accessToken: string,
    profileArn?: string,
    accountMachineId?: string,
    ssoRegion?: string,
    email?: string,
    authMethod?: string
  ) => Promise<UsageLimitsResponse>
  getUsageAndLimits: (
    accessToken: string,
    idp?: string,
    profileArn?: string,
    accountMachineId?: string,
    ssoRegion?: string,
    email?: string,
    authMethod?: string
  ) => Promise<UnifiedUsageResponse>
  getUserInfo: (
    accessToken: string,
    idp?: string,
    accountMachineId?: string,
    email?: string
  ) => Promise<UserInfoResponse>
}

export function createUsage(
  transport: UpstreamTransport,
  getUsageApiType: () => UsageApiType
): UpstreamUsage {
  const { fetchWithAppProxy, kiroApiRequest, getNetworkAgent } = transport

  async function fetchRestApi(
    baseUrl: string,
    path: string,
    accessToken: string,
    machineId?: string,
    authMethod?: string  // external_idp 需 TokenType: EXTERNAL_IDP header，否则 CW REST 403
  ): Promise<Response> {
    const agent = getNetworkAgent()
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

  async function getUsageLimitsRest(
    accessToken: string,
    profileArn?: string,
    accountMachineId?: string,  // 账户绑定的设备 ID
    ssoRegion?: string,         // SSO 区域，用于选择正确的 REST API 端点
    email?: string,             // 用于日志标识
    authMethod?: string         // external_idp (Azure AD) 需传入以加 TokenType header
  ): Promise<UsageLimitsResponse> {
    // 优先使用账户绑定的设备 ID，其次使用 K-Proxy 全局设备 ID
    const machineId = accountMachineId || transport.getDeviceIdForUa()
    const logTag = email || `token:${accessToken?.slice(-6) || '?'}`
    console.log(`[Kiro REST API] GetUsageLimits [${logTag}] region=${ssoRegion || 'default'}`)

    // 上层 getUsageAndLimits 已按 idp+authMethod 收口过 ARN。这里只处理：
    // 1) 仍是 V1 企业废 ARN → V2；2) 仍缺 ARN → 用 authMethod 再走决策表。
    // 不得拿「只有 authMethod、没有 idp」的不完整身份去覆盖已经算好的社交/真实 ARN。
    const incomingKind = classifyProfileArnKind(profileArn)
    if (incomingKind === 'enterprise_legacy_v1' || incomingKind === 'none') {
      const { identity } = normalizeImportAuth({ authMethod })
      profileArn = resolveUsageLimitsProfileArn({
        identity,
        providedProfileArn: profileArn,
        ssoRegion
      })
    }
    
    const params = new URLSearchParams({
      origin: 'AI_EDITOR',
      resourceType: 'AGENTIC_REQUEST',
      isEmailRequired: 'true'
    })
    if (profileArn) {
      params.set('profileArn', profileArn)
    }
    const path = `/getUsageLimits?${params.toString()}`

    // 跨 region 账户修复:host 必须按 profileArn 的真实数据面 region 选,而非 account.region(ssoRegion)。
    // 与 stream 路径(kiroApi.callKiroApiStream 的 dataPlaneRegion)保持一致的 SSOT。
    // Bug 现场:account.region=us-east-2 但 profile 在 eu-central-1 → 用 ssoRegion 选 us 主机 403 →
    //          回退 q.us-east-1 → 400 "Improperly formed request"(间歇性,每次用量刷新都触发)。
    // 此处覆盖所有走 getUsageAndLimits → getUsageLimitsRest 的调用方(check-status/批量/verify/订阅)。
    // ⚠️ 仅对"真实" profileArn 生效:社交固定 ARN 与 BuilderId 固定 ARN
    //    恒为 us-east-1,不代表账户真实 region,必须排除,否则 EU 社交/BuilderId 账户被误路由到 us 而 403。
    const arnKind = classifyProfileArnKind(profileArn)
    const isFixedOrPlaceholderArn =
      arnKind === 'builder_id_fixed' || arnKind === 'social_fixed' || arnKind === 'enterprise_legacy_v1'
    const arnRegion = isFixedOrPlaceholderArn ? undefined : parseRegionFromProfileArn(profileArn)
    const effectiveRegion = arnRegion || ssoRegion
    if (effectiveRegion !== ssoRegion && isKiroApiDebug()) {
      console.log(`[Kiro REST API] GetUsageLimits [${logTag}] region override: ssoRegion=${ssoRegion} → dataPlaneRegion=${effectiveRegion} (from profileArn)`)
    }

    // 根据数据面 region 选择主端点
    const primaryBase = getRestApiBase(effectiveRegion)
    const fallbackBase = getFallbackRestApiBase(effectiveRegion)
    
    let response = await fetchRestApi(primaryBase, path, accessToken, machineId, authMethod)

    // 如果主端点返回 403，尝试备用端点
    if (response.status === 403) {
      console.log(`[Kiro REST API] Primary 403, fallback → ${fallbackBase}`)
      response = await fetchRestApi(fallbackBase, path, accessToken, machineId, authMethod)
    }

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[Kiro REST API] GetUsageLimits failed: ${response.status}`, errorText)
      throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
    
    const result = await response.json()
    console.log(`[Kiro REST API] GetUsageLimits [${logTag}] → ${response.status}`, result)
    return result
  }

  async function getUsageAndLimits(
    accessToken: string,
    idp: string = 'BuilderId',
    profileArn?: string,
    accountMachineId?: string,  // 账户绑定的设备 ID
    ssoRegion?: string,         // SSO 区域，用于选择正确的 REST API 端点
    email?: string,             // 用于日志标识
    authMethod?: string         // external_idp (Azure AD) 需传入以加 TokenType header
  ): Promise<UnifiedUsageResponse> {
    // 社交 / BuilderId / ksk / 企业 的 ARN 注入收口到 resolveUsageLimitsProfileArn。
    // 社交缺 ARN → KIRO_SOCIAL_PROFILE_ARN(RCA 2026-07-14 usage-refresh-zero)。
    // BuilderId 缺 ARN → BuilderId 固定 ARN(RCA 2026-08-23 builderid-placeholder-arn;对照 200)。
    // ksk 绝不注入(RCA 2026-08-02 ksk-eu-fallback-arn)。
    const isApiKey = authMethod === 'api_key' || idp === 'ApiKey'
    const effectiveAuthMethod = isApiKey ? 'api_key' : authMethod
    const { identity } = normalizeImportAuth({ authMethod: effectiveAuthMethod, provider: idp })
    profileArn = resolveUsageLimitsProfileArn({
      identity,
      providedProfileArn: profileArn,
      ssoRegion
    })
    if (getUsageApiType() === 'rest') {
      // 使用 REST API (GetUsageLimits)
      const result = await getUsageLimitsRest(accessToken, profileArn, accountMachineId, ssoRegion, email, effectiveAuthMethod)
      // REST API 返回的字段名和 CBOR API 相同，直接返回
      return {
        usageBreakdownList: result.usageBreakdownList?.map(b => ({
          resourceType: b.resourceType || b.type,
          displayName: b.displayName,
          displayNamePlural: b.displayNamePlural,
          currentUsage: b.currentUsage,
          currentUsageWithPrecision: b.currentUsageWithPrecision,
          usageLimit: b.usageLimit,
          usageLimitWithPrecision: b.usageLimitWithPrecision,
          currency: b.currency,
          unit: b.unit,
          overageRate: b.overageRate,
          overageCap: b.overageCap,
          type: b.type,
          // REST API 直接返回 freeTrialInfo，CBOR API 返回 freeTrialUsage
          freeTrialInfo: b.freeTrialInfo ? {
            freeTrialStatus: b.freeTrialInfo.freeTrialStatus,
            usageLimit: b.freeTrialInfo.usageLimit,
            usageLimitWithPrecision: b.freeTrialInfo.usageLimitWithPrecision,
            currentUsage: b.freeTrialInfo.currentUsage,
            currentUsageWithPrecision: b.freeTrialInfo.currentUsageWithPrecision,
            // REST API 返回数字时间戳，需要转换为 ISO 字符串
            freeTrialExpiry: typeof b.freeTrialInfo.freeTrialExpiry === 'number' 
              ? new Date(b.freeTrialInfo.freeTrialExpiry * 1000).toISOString() 
              : b.freeTrialInfo.freeTrialExpiry
          } : (b.freeTrialUsage ? {
            freeTrialStatus: b.freeTrialUsage.freeTrialStatus,
            usageLimit: b.freeTrialUsage.usageLimit,
            usageLimitWithPrecision: b.freeTrialUsage.usageLimitWithPrecision,
            currentUsage: b.freeTrialUsage.currentUsage,
            currentUsageWithPrecision: b.freeTrialUsage.currentUsageWithPrecision,
            freeTrialExpiry: b.freeTrialUsage.freeTrialExpiry
          } : undefined),
          // 转换 bonuses 中的时间戳为 ISO 字符串
          bonuses: b.bonuses?.map(bonus => ({
            ...bonus,
            expiresAt: typeof bonus.expiresAt === 'number' 
              ? new Date(bonus.expiresAt * 1000).toISOString() 
              : bonus.expiresAt
          }))
        })),
        // REST API 返回的 nextDateReset 是 Unix 时间戳（秒），需要转换为 ISO 字符串
        nextDateReset: normalizeResetDate(result.nextDateReset),
        subscriptionInfo: result.subscriptionInfo,
        overageConfiguration: result.overageConfiguration,
        userInfo: result.userInfo
      }
    } else {
      // 使用 CBOR API (GetUserUsageAndLimits)
      // CBOR API (app.kiro.dev) 是网页端门户，仅支持 BuilderId 认证
      // Enterprise/IdC 账号可能返回 401，需要 fallback 到 REST API
      try {
        return await kiroApiRequest<UnifiedUsageResponse>(
          'GetUserUsageAndLimits',
          { isEmailRequired: true, origin: 'KIRO_IDE' },
          accessToken,
          idp,
          accountMachineId,
          email
        )
      } catch (cborError) {
        const errorMsg = cborError instanceof Error ? cborError.message : ''
        // CBOR 401/403 时自动 fallback 到 REST API
        if (errorMsg.includes('401') || errorMsg.includes('403')) {
          console.log(`[API] CBOR API failed (${errorMsg}), falling back to REST API...`)
          const result = await getUsageLimitsRest(accessToken, profileArn, accountMachineId, ssoRegion, email, effectiveAuthMethod)
          return {
            usageBreakdownList: result.usageBreakdownList?.map(b => ({
              resourceType: b.resourceType || b.type,
              displayName: b.displayName,
              displayNamePlural: b.displayNamePlural,
              currentUsage: b.currentUsage,
              currentUsageWithPrecision: b.currentUsageWithPrecision,
              usageLimit: b.usageLimit,
              usageLimitWithPrecision: b.usageLimitWithPrecision,
              currency: b.currency,
              unit: b.unit,
              overageRate: b.overageRate,
              overageCap: b.overageCap,
              type: b.type,
              freeTrialInfo: b.freeTrialInfo ? {
                freeTrialStatus: b.freeTrialInfo.freeTrialStatus,
                usageLimit: b.freeTrialInfo.usageLimit,
                usageLimitWithPrecision: b.freeTrialInfo.usageLimitWithPrecision,
                currentUsage: b.freeTrialInfo.currentUsage,
                currentUsageWithPrecision: b.freeTrialInfo.currentUsageWithPrecision,
                freeTrialExpiry: typeof b.freeTrialInfo.freeTrialExpiry === 'number' 
                  ? new Date(b.freeTrialInfo.freeTrialExpiry * 1000).toISOString() 
                  : b.freeTrialInfo.freeTrialExpiry
              } : (b.freeTrialUsage ? {
                freeTrialStatus: b.freeTrialUsage.freeTrialStatus,
                usageLimit: b.freeTrialUsage.usageLimit,
                usageLimitWithPrecision: b.freeTrialUsage.usageLimitWithPrecision,
                currentUsage: b.freeTrialUsage.currentUsage,
                currentUsageWithPrecision: b.freeTrialUsage.currentUsageWithPrecision,
                freeTrialExpiry: b.freeTrialUsage.freeTrialExpiry
              } : undefined),
              bonuses: b.bonuses?.map(bonus => ({
                ...bonus,
                expiresAt: typeof bonus.expiresAt === 'number' 
                  ? new Date(bonus.expiresAt * 1000).toISOString() 
                  : bonus.expiresAt
              }))
            })),
            nextDateReset: normalizeResetDate(result.nextDateReset as unknown as number | string),
            subscriptionInfo: result.subscriptionInfo,
            overageConfiguration: result.overageConfiguration,
            userInfo: result.userInfo
          }
        }
        throw cborError
      }
    }
  }

  // GetUserInfo API - 只需要 accessToken 即可调用
  async function getUserInfo(accessToken: string, idp: string = 'BuilderId', accountMachineId?: string, email?: string): Promise<UserInfoResponse> {
    return kiroApiRequest<UserInfoResponse>('GetUserInfo', { origin: 'KIRO_IDE' }, accessToken, idp, accountMachineId, email)
  }

  return { getUsageLimitsRest, getUsageAndLimits, getUserInfo }
}
