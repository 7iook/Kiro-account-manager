/**
 * 凭证验证与导入业务函数 · IPC 与 HTTP 面板共用
 *
 * 抽取来源：
 *   index.ts:3789 (import-from-sso-token)
 *   index.ts:5026 (verify-api-key)
 *   index.ts:5095 (compute-token-fingerprint)
 *   index.ts:5103 (verify-account-credentials)
 *
 * 为什么用注入而不是直接 import：`ssoDeviceAuth` / `getUserInfo` / `getUsageAndLimits` /
 * `refreshTokenByMethod` 都是 index.ts 的**模块级私有函数**（分别 :1108 / :1762 / :1608 / :1030），
 * 且各自闭包引用了 index.ts 的模块级可变状态（currentUsageApiType 切换 REST/CBOR、
 * inFlightRefreshByToken 去重表、machineId 等）。把它们搬出来是另一个 executor 量级的改动，
 * 且会与并行 executor（check-account-status / refresh-account-token 也调这些函数）撞车。
 * → 本轮按 recon §3 的 deps 形态注入，签名与 index.ts 原函数逐一对齐；
 *   `validateApiKeyCredential` / `resolveApiKeyProfileArnIfEligible` / `sha256Fingerprint` /
 *   `resolveProfileArnForVerify` / `parseRegionFromProfileArn` / `fetchEnterpriseProfileArn`
 *   已是独立模块，直接静态 import，不进 deps。
 */
import {
  resolveApiKeyProfileArnIfEligible,
  validateApiKeyCredential,
  parseRegionFromProfileArn,
  fetchEnterpriseProfileArn
} from '../proxy/kiroApi'
import { resolveProfileArnForVerify } from '../proxy/profile-selection'
import { sha256Fingerprint } from '../utils/tokenFingerprint'
import { normalizeSubscriptionType } from './subscription'
import { normalizeCreditUsage, computeDaysRemaining } from './usage'
import type { UsageApiShape } from './types'
import type { VerifyApiKeyResult } from '../../shared/types/credential'

// ============ 注入契约：index.ts 内的模块级 API 函数 ============

/** ssoDeviceAuth 的返回形状（index.ts:1097 SsoAuthResult） */
export type SsoAuthLike = {
  success: boolean
  accessToken?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  region?: string
  expiresIn?: number
  error?: string
}

/** getUserInfo 的返回形状（index.ts:1754 UserInfoResponse） */
export type UserInfoLike = {
  email?: string
  userId?: string
  idp?: string
  status?: string
  featureFlags?: string[]
}

/** refreshTokenByMethod 的返回形状（index.ts:251 OidcRefreshResult） */
export type OidcRefreshLike = {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  error?: string
  resolvedRegion?: string
}

/**
 * 验证/导入路径所需的 Kiro API 依赖（签名与 index.ts 内同名函数逐一对齐）。
 * 不含 electron、不含 preload、不含 IpcMainInvokeEvent。
 */
export interface VerifyApiDeps {
  ssoDeviceAuth: (bearerToken: string, region?: string) => Promise<SsoAuthLike>
  getUserInfo: (
    accessToken: string,
    idp?: string,
    accountMachineId?: string,
    email?: string
  ) => Promise<UserInfoLike>
  getUsageAndLimits: (
    accessToken: string,
    idp?: string,
    profileArn?: string,
    accountMachineId?: string,
    ssoRegion?: string,
    email?: string,
    authMethod?: string
  ) => Promise<unknown>
  refreshTokenByMethod: (
    token: string,
    clientId: string,
    clientSecret: string,
    region?: string,
    authMethod?: string,
    proxyUrl?: string,
    externalIdp?: { tokenEndpoint?: string; scopes?: string }
  ) => Promise<OidcRefreshLike>
}

// ============ compute-token-fingerprint ============

/**
 * accessToken 的 sha256 hex 指纹（前 16 位）· 老账号 tokenFingerprint 补齐迁移用。
 * @throws 空/非字符串入参（原 handler 行为：抛而不是返回空串，让调用点立刻暴露）
 */
export function computeTokenFingerprint(accessToken: string): string {
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('compute-token-fingerprint: accessToken must be a non-empty string')
  }
  return sha256Fingerprint(accessToken)
}

// ============ verify-api-key ============

/**
 * 验证网页 API Key(ksk_)凭据有效性 + 附赠尝试解析 profileArn。
 *
 * Step 1: validateApiKeyCredential → state ∈ {VALID, INVALID, SUSPENDED, INDETERMINATE}
 * Step 2: state=VALID 且非 STANDALONE 类订阅 → resolveApiKeyProfileArn 附赠拿元数据（拿不到不改 state）
 *
 * 契约(SSOT)：@shared/types/credential.ts VerifyApiKeyResult
 * renderer 唯一分类字段是 state · success 只作辅助。
 */
export async function verifyApiKey(params: {
  apiKey: string
  region?: string
}): Promise<VerifyApiKeyResult> {
  const apiKey = (params?.apiKey || '').trim()
  const region = params?.region || 'us-east-1'
  console.log('[IPC] verify-api-key called')
  if (!apiKey.startsWith('ksk_')) {
    return {
      state: 'INVALID',
      success: false,
      error: 'API Key 格式错误：应以 ksk_ 开头'
    }
  }
  try {
    // Step 1: 凭据有效性判定(唯一决策入口)
    const probe = await validateApiKeyCredential(apiKey, region)

    if (probe.state !== 'VALID') {
      // state=INVALID / SUSPENDED / INDETERMINATE:一律不入池,给 renderer 展示原因
      const reasonMap: Record<'INVALID' | 'SUSPENDED' | 'INDETERMINATE', string> = {
        INVALID: '密钥无效或已吊销',
        SUSPENDED: '账号已被 Kiro 暂停',
        INDETERMINATE: '暂时无法验证，请稍后重新提交该密钥'
      }
      const humanReason = reasonMap[probe.state as 'INVALID' | 'SUSPENDED' | 'INDETERMINATE']
      return {
        state: probe.state,
        success: false,
        subscription: probe.subscription, // SUSPENDED 时后端可能仍返 type 供日志诊断
        reason: probe.reason,
        httpStatus: probe.httpStatus,
        error: probe.reason ? `${humanReason}（${probe.reason}）` : humanReason
      }
    }

    // Step 2: VALID 态 · 附赠尝试拿 profileArn(不改变 state · 失败静默)
    // probe.region 是 validateApiKeyCredential 跨区探测实际命中的 region(hint 猜错时会翻转),
    // Step2 GetProfile 必须用该 region,否则同样打错端点空转。
    const effectiveRegion = probe.region || region
    const subscriptionType = probe.subscription?.type
    const profile = await resolveApiKeyProfileArnIfEligible(apiKey, effectiveRegion, subscriptionType)

    const dataPlaneRegion = profile
      ? parseRegionFromProfileArn(profile.profileArn) || effectiveRegion
      : effectiveRegion

    return {
      state: 'VALID',
      success: true,
      subscription: probe.subscription,
      tokenFingerprint: probe.tokenFingerprint,
      httpStatus: probe.httpStatus,
      profileArn: profile?.profileArn,
      profileName: profile?.profileName,
      profileType: profile?.profileType,
      region: dataPlaneRegion
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[IPC] verify-api-key unexpected error:', msg)
    // 未预期的异常 → 归 INDETERMINATE(避免把偶发错误误判成 INVALID)
    return {
      state: 'INDETERMINATE',
      success: false,
      error: `API Key 校验失败（内部错误）：${msg}`
    }
  }
}

// ============ import-from-sso-token ============

/**
 * 从 SSO Token(x-amz-sso_authn) 导入账号。
 *
 * 流程：ssoDeviceAuth 设备授权 → 并行取 userInfo + usage → 归一化订阅与额度。
 * 返回形状与原 handler 逐字一致（error 是 `{ message }` 对象 —— 与 verify 路径的
 * `error: string` **不同**，这是既有的不一致，renderer 已适配，不得"顺手统一"）。
 */
export async function importFromSsoToken(
  deps: VerifyApiDeps,
  bearerToken: string,
  region: string = 'us-east-1'
): Promise<
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: { message: string } }
> {
  console.log('[IPC] import-from-sso-token called')

  try {
    // 执行 SSO 设备授权流程
    const ssoResult = await deps.ssoDeviceAuth(bearerToken, region)

    if (!ssoResult.success || !ssoResult.accessToken) {
      return { success: false, error: { message: ssoResult.error || 'SSO 授权失败' } }
    }

    // 并行获取用户信息和使用量
    let userInfo: UserInfoLike | undefined
    let usageData: UsageApiShape | undefined

    try {
      console.log('[SSO] Fetching user info and usage data...')
      const [userInfoResult, usageResult] = await Promise.all([
        deps.getUserInfo(ssoResult.accessToken).catch((e) => {
          console.error('[SSO] getUserInfo failed:', e)
          return undefined
        }),
        deps
          .getUsageAndLimits(ssoResult.accessToken, 'BuilderId', undefined, undefined, region)
          .catch((e) => {
            console.error('[SSO] getUsageAndLimits failed:', e)
            return undefined
          })
      ])
      userInfo = userInfoResult
      usageData = usageResult as UsageApiShape | undefined
      console.log('[SSO] userInfo:', userInfo?.email)
      console.log('[SSO] usageData:', usageData?.subscriptionInfo?.subscriptionTitle)
    } catch (e) {
      // 保留原 handler 行为：并行取信息失败不阻断导入（凭证已经拿到了），
      // 走下面的 undefined 分支返回空额度。已记录日志，非静默吞。
      console.error('[IPC] API calls failed:', e)
    }

    // 解析订阅与额度
    // ⚠️ 默认标题是 'KIRO'（不是 'Free'）—— 与 verify 路径的默认值不同，是既有差异
    const subscriptionTitle = usageData?.subscriptionInfo?.subscriptionTitle || 'KIRO'
    const subscriptionType = normalizeSubscriptionType(subscriptionTitle)
    // ⚠️ 本路径**不按 status 过滤 bonus**（与 verify 路径相反）—— 见 usage.ts 文件头
    const usage = normalizeCreditUsage(usageData, { filterActiveBonuses: false })

    return {
      success: true,
      data: {
        accessToken: ssoResult.accessToken,
        refreshToken: ssoResult.refreshToken,
        clientId: ssoResult.clientId,
        clientSecret: ssoResult.clientSecret,
        region: ssoResult.region,
        expiresIn: ssoResult.expiresIn,
        email: usageData?.userInfo?.email || userInfo?.email,
        userId: usageData?.userInfo?.userId || userInfo?.userId,
        idp: userInfo?.idp || 'BuilderId',
        status: userInfo?.status,
        subscriptionType,
        subscriptionTitle,
        subscription: {
          managementTarget: usageData?.subscriptionInfo?.subscriptionManagementTarget,
          upgradeCapability: usageData?.subscriptionInfo?.upgradeCapability,
          overageCapability: usageData?.subscriptionInfo?.overageCapability
        },
        usage: {
          current: usage.current,
          limit: usage.limit,
          baseLimit: usage.baseLimit,
          baseCurrent: usage.baseCurrent,
          freeTrialLimit: usage.freeTrialLimit,
          freeTrialCurrent: usage.freeTrialCurrent,
          freeTrialExpiry: usage.freeTrialExpiry,
          bonuses: usage.bonuses,
          nextResetDate: usageData?.nextDateReset,
          resourceDetail: usage.resourceDetail
        },
        daysRemaining: computeDaysRemaining(usageData?.nextDateReset)
      }
    }
  } catch (error) {
    console.error('[IPC] import-from-sso-token error:', error)
    return {
      success: false,
      error: { message: error instanceof Error ? error.message : 'Unknown error' }
    }
  }
}

// ============ verify-account-credentials ============

export type VerifyCredentialsInput = {
  refreshToken: string
  clientId: string
  clientSecret: string
  region?: string
  authMethod?: string
  /** 'BuilderId' | 'Enterprise' | 'Github' | 'Google' | 'ExternalIdp' … */
  provider?: string
  accessToken?: string
  tokenEndpoint?: string
  issuerUrl?: string
  scopes?: string
  profileArn?: string
}

export type VerifyCredentialsResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: string }

/**
 * 验证凭证并获取账号信息（添加账号用）。
 *
 * 步骤（顺序本身是修过 bug 的产物，不得重排）：
 *   1   refreshTokenByMethod 拿 accessToken
 *   1.5 resolveProfileArnForVerify 先拿**真实** profileArn —— 必须在 usage 之前。
 *       老实现先跑 usage 用 fallback ARN(不属于用户组织) → 403 "Invalid token"。
 *   1.6 从 profileArn 解析数据面 region：用户 SSO region(refresh 用)可能 ≠ profile region
 *       (数据面 API 用)。例：身份 SSO 在 eu-central-1，组织 profile 挂在 us-east-1。
 *   2   getUsageAndLimits 取用户信息 + 额度
 *   3   再次 resolveProfileArnForVerify 决定落库的 profileArn
 *
 * ⚠️ Step 1.5 与 Step 3 是**两次独立调用**，原 handler 即如此。二者入参完全相同、
 *    互不消费对方结果，因此对 Enterprise 账号会重复一次 ListAvailableProfiles 网络请求。
 *    本轮**照搬不合并**（照搬原则：语义与副作用次数都不得变）；合并属独立优化，
 *    见文件尾 TODO 与技术债登记。
 *
 * 返回形状与原 handler 逐字一致：失败时 `error` 是 **string**（与 importFromSsoToken 的
 * `{ message }` 不同 —— 既有不一致，renderer 已适配，不得统一）。
 */
export async function verifyAccountCredentials(
  deps: VerifyApiDeps,
  credentials: VerifyCredentialsInput
): Promise<VerifyCredentialsResult> {
  console.log('[IPC] verify-account-credentials called')

  try {
    const {
      refreshToken,
      clientId,
      clientSecret,
      region = 'us-east-1',
      authMethod,
      provider,
      tokenEndpoint,
      scopes
    } = credentials
    // 确定 idp：社交登录使用 provider，IdC 也需要根据 provider 区分 BuilderId 和 Enterprise
    // 注：external_idp (AzureAD/ExternalIdp) 刻意 fallback 到 'BuilderId'，避免把非标准 idp 值拼进
    // kiroApiRequest 的 cookie (`Idp=${idp}`) 触发服务端非 401/403 错误绕过 REST fallback。
    // external_idp 靠 CBOR 401 → REST fallback (accessToken+profileArn) 查用量，与 idp 值无关。
    const idp =
      provider && (provider === 'Enterprise' || provider === 'Github' || provider === 'Google')
        ? provider
        : 'BuilderId'

    // 社交登录只需要 refreshToken，IdC 需要 clientId 和 clientSecret
    if (!refreshToken) {
      return { success: false, error: '请填写 Refresh Token' }
    }
    if (authMethod !== 'social' && authMethod !== 'external_idp' && (!clientId || !clientSecret)) {
      return { success: false, error: '请填写 Client ID 和 Client Secret' }
    }

    // Step 1: 使用合适的方式刷新获取 accessToken
    console.log(`[Verify] Step 1: Refreshing token (authMethod: ${authMethod || 'IdC'})...`)
    const refreshResult = await deps.refreshTokenByMethod(
      refreshToken,
      clientId,
      clientSecret,
      region,
      authMethod,
      undefined,
      { tokenEndpoint, scopes }
    )

    if (!refreshResult.success || !refreshResult.accessToken) {
      return { success: false, error: `Token 刷新失败: ${refreshResult.error}` }
    }

    console.log('[Verify] Step 2: Getting user info...')

    // Step 1.5: 先 resolve 真实 profileArn（见函数头说明）
    const isEntPre = provider === 'Enterprise' || authMethod === 'external_idp'
    const resolvedProfileArn = await resolveProfileArnForVerify(
      {
        providedProfileArn: credentials.profileArn,
        isEnterprise: isEntPre,
        accessToken: refreshResult.accessToken!,
        region: region || 'us-east-1',
        provider,
        authMethod
      },
      (acc) => fetchEnterpriseProfileArn(acc)
    )
    console.log(
      '[Verify] Step 1.5: resolvedProfileArn:',
      resolvedProfileArn || '(undefined · non-Enterprise or fetch failed)'
    )

    // Step 1.6: 从 profileArn 解析真实数据面 region（跨 region 用户支持 · 2026-07-14）
    const parsedProfileRegion = parseRegionFromProfileArn(resolvedProfileArn)
    const dataPlaneRegion = parsedProfileRegion || region || 'us-east-1'
    if (parsedProfileRegion && parsedProfileRegion !== region) {
      console.log(
        `[Verify] Cross-region user: SSO=${region} · profile=${parsedProfileRegion} · using profile region for data-plane API`
      )
    }

    // Step 2: 调用 GetUserUsageAndLimits 获取用户信息
    const usageResult = (await deps.getUsageAndLimits(
      refreshResult.accessToken,
      idp,
      resolvedProfileArn,
      undefined,
      dataPlaneRegion,
      undefined,
      authMethod
    )) as UsageApiShape

    // 解析用户信息
    const email = usageResult.userInfo?.email || ''
    const userId = usageResult.userInfo?.userId || ''

    // 解析订阅类型
    const subscriptionTitle = usageResult.subscriptionInfo?.subscriptionTitle || 'Free'
    const subscriptionType = normalizeSubscriptionType(subscriptionTitle)

    // 解析使用量（详细，使用精确小数）
    // ⚠️ 本路径**只计入 status==='ACTIVE' 的 bonus**（与 importFromSsoToken 相反）—— 见 usage.ts 文件头
    const usage = normalizeCreditUsage(usageResult, { filterActiveBonuses: true })

    // 计算重置剩余天数
    const nextResetDate = usageResult.nextDateReset
    const expiresAt = nextResetDate ? new Date(nextResetDate).getTime() : undefined
    const daysRemaining = computeDaysRemaining(nextResetDate)

    console.log('[Verify] Success! Email:', email)

    // Step 3: Enterprise 账号：验证时决定落库的 profileArn（v2 SSOT · resolveProfileArnForVerify）
    const isEnt = provider === 'Enterprise' || authMethod === 'external_idp'
    const enterpriseProfileArn = await resolveProfileArnForVerify(
      {
        providedProfileArn: credentials.profileArn,
        isEnterprise: isEnt,
        accessToken: refreshResult.accessToken!,
        region: region || 'us-east-1',
        provider,
        authMethod
      },
      (acc) => fetchEnterpriseProfileArn(acc)
    )
    if (enterpriseProfileArn) {
      console.log(`[Verify] Enterprise profileArn resolved: ${enterpriseProfileArn}`)
    }

    return {
      success: true,
      data: {
        email,
        userId,
        accessToken: refreshResult.accessToken,
        refreshToken: refreshResult.refreshToken || refreshToken,
        expiresIn: refreshResult.expiresIn,
        profileArn: enterpriseProfileArn || undefined,
        subscriptionType,
        subscriptionTitle,
        subscription: {
          rawType: usageResult.subscriptionInfo?.type,
          managementTarget: usageResult.subscriptionInfo?.subscriptionManagementTarget,
          upgradeCapability: usageResult.subscriptionInfo?.upgradeCapability,
          overageCapability: usageResult.subscriptionInfo?.overageCapability
        },
        usage: {
          current: usage.current,
          limit: usage.limit,
          baseLimit: usage.baseLimit,
          baseCurrent: usage.baseCurrent,
          freeTrialLimit: usage.freeTrialLimit,
          freeTrialCurrent: usage.freeTrialCurrent,
          freeTrialExpiry: usage.freeTrialExpiry,
          bonuses: usage.bonuses,
          nextResetDate,
          resourceDetail: usage.resourceDetail
        },
        daysRemaining,
        expiresAt
      }
    }
  } catch (error) {
    console.error('[Verify] Error:', error)
    return { success: false, error: error instanceof Error ? error.message : '验证失败' }
  }
}

// TODO(债)：verifyAccountCredentials 的 Step 1.5 与 Step 3 入参完全相同，对 Enterprise
// 账号会重复一次 ListAvailableProfiles 请求。本轮照搬保留（副作用次数不得变）；
// 合并为一次需确认 renderer 无隐式依赖第二次调用的时序，属独立优化轮次。
