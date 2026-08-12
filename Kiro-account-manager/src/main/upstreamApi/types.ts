/**
 * 上游 Kiro / AWS API 的类型契约。
 *
 * 这些类型原本内联在 `src/main/index.ts`（一个 import electron 的文件）里，
 * 于是服务端形态（`node out/server/index.js`，纯 node、无 Electron 运行时）
 * 拿不到它们所描述的那套能力。搬到这里是**零行为变化**的抽取：
 * 类型逐字照搬，字段名 / 可选性 / 联合类型一个不改 —— 上游返什么形状是既定事实，
 * 「顺手规整一下」等于改契约。
 */

/** 用量查询走 REST(GetUsageLimits) 还是 CBOR(GetUserUsageAndLimits) */
export type UsageApiType = 'rest' | 'cbor'

export interface OidcRefreshResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  error?: string
  /** 成功时的 region;当传入 region 错误、通过跨 region 重试成功时,该字段带回真实 region,让上层写回 account.credentials.region 避免下次再走弯路 */
  resolvedRegion?: string
}

export interface SsoAuthResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  region?: string
  expiresIn?: number
  error?: string
}

export interface UsageLimitsResponse {
  // REST API 实际返回 usageBreakdownList（不是 usageBreakdowns）
  usageBreakdownList?: Array<{
    type?: string
    resourceType?: string
    displayName?: string
    displayNamePlural?: string
    currentUsage?: number
    currentUsageWithPrecision?: number
    usageLimit?: number
    usageLimitWithPrecision?: number
    currency?: string
    unit?: string
    overageRate?: number
    overageCap?: number
    overageCharges?: number
    currentOverages?: number
    freeTrialUsage?: {
      currentUsage?: number
      currentUsageWithPrecision?: number
      usageLimit?: number
      usageLimitWithPrecision?: number
      freeTrialStatus?: string
      freeTrialExpiry?: string
    }
    // REST API 直接返回 freeTrialInfo（与 freeTrialUsage 结构相同）
    freeTrialInfo?: {
      currentUsage?: number
      currentUsageWithPrecision?: number
      usageLimit?: number
      usageLimitWithPrecision?: number
      freeTrialStatus?: string
      freeTrialExpiry?: number | string
    }
    bonuses?: Array<{
      bonusCode?: string
      displayName?: string
      description?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      expiresAt?: number | string  // REST API 返回数字时间戳
      redeemedAt?: number | string
      status?: string
    }>
  }>
  nextDateReset?: number | string  // Unix 时间戳（秒）或 ISO 字符串
  subscriptionInfo?: {
    subscriptionName?: string
    subscriptionTitle?: string
    subscriptionType?: string
    status?: string
    subscriptionManagementTarget?: string
    upgradeCapability?: string
    overageCapability?: string
  }
  overageSettings?: {
    overageStatus?: string
  }
  overageConfiguration?: {
    overageEnabled?: boolean
    overageStatus?: string
  }
  userInfo?: {
    email?: string
    userId?: string
  }
}

export interface UnifiedUsageResponse {
  usageBreakdownList?: Array<{
    resourceType?: string
    displayName?: string
    displayNamePlural?: string
    currentUsage?: number
    currentUsageWithPrecision?: number
    usageLimit?: number
    usageLimitWithPrecision?: number
    currency?: string
    unit?: string
    overageRate?: number
    overageCap?: number
    type?: string
    freeTrialInfo?: {
      freeTrialStatus?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      freeTrialExpiry?: string
    }
    bonuses?: Array<{
      bonusCode?: string
      displayName?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      expiresAt?: string
      status?: string
    }>
  }>
  nextDateReset?: string
  subscriptionInfo?: {
    subscriptionName?: string
    subscriptionTitle?: string
    subscriptionType?: string
    status?: string
    type?: string
    subscriptionManagementTarget?: string
    upgradeCapability?: string
    overageCapability?: string
  }
  overageConfiguration?: {
    overageEnabled?: boolean
    overageStatus?: string
  }
  userInfo?: {
    email?: string
    userId?: string
  }
}

export interface UserInfoResponse {
  email?: string
  userId?: string
  idp?: string
  status?: string
  featureFlags?: string[]
}
