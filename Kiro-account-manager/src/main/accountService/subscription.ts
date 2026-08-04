/**
 * accountService/subscription.ts · 账号模型 / 订阅 / 超额偏好的可复用业务实现
 *
 * 从 `index.ts` 的 `account-get-models` / `account-get-subscriptions` /
 * `account-get-subscription-url` / `account-set-overage` 四个 handler 抽出。
 *
 * 这四个都是「转发到 kiroApi + 整形响应」的薄函数,自身无副作用、不碰磁盘、不碰
 * 模块级状态,故 deps 只需注入四个 kiroApi 函数(注入而非直接 import,便于单测替身)。
 *
 * 返回形状逐字保留 —— 包括「有的 error 是 string、失败时 models/plans 给空数组、
 * `account-set-overage` 直接透传上游结果」这些不统一之处。renderer 已在多个组件里
 * 适配了这种不一致(recon §7.2 第 6 条),顺手统一会让调用方全线炸。
 *
 * ⚠️ 订阅管理链接:本函数只**返回 URL**,不负责打开。桌面端由 `open-subscription-window`
 *    调 `openBrowserInPrivateMode` 拉起本机浏览器无痕窗口(宿主机能力);web 端拿到 URL
 *    由浏览器自行打开(决策卡 §3 豁免清单:无法保证无痕)。该差异是适配层的事,不在此处。
 */

import type { ProxyAccount } from '../proxy'

/**
 * kiroApi.fetchKiroModels 返回的模型条目(只声明本文件用到的字段)。
 *
 * `tokenLimits` 的两个字段可为 null —— 上游 `KiroModel` 就是 `number | null | undefined`。
 * 原实现直接透传,前端拿到的可能是 null;此处保留 null 而不收窄成 undefined,否则会改变
 * renderer 收到的值(`null` 与 `undefined` 在 JSON 序列化与 `??` 判定下行为不同)。
 */
export interface KiroModelLike {
  modelId: string
  modelName?: string
  description?: string
  supportedInputTypes?: string[]
  tokenLimits?: { maxInputTokens?: number | null; maxOutputTokens?: number | null }
  rateMultiplier?: number
  rateUnit?: string
}

/** 传入的账号标识 —— 与四个 IPC handler 的位置参数一一对应 */
export interface AccountApiIdentity {
  accessToken: string
  region?: string
  profileArn?: string
  machineId?: string
  provider?: string
  authMethod?: string
  accountId?: string
}

export interface GetModelsDeps {
  fetchKiroModels: (account: ProxyAccount) => Promise<KiroModelLike[]>
}

export interface GetSubscriptionsDeps {
  fetchAvailableSubscriptions: (account: ProxyAccount) => Promise<{
    subscriptionPlans?: unknown
    disclaimer?: unknown
  }>
}

export interface GetSubscriptionUrlDeps {
  fetchSubscriptionToken: (
    account: ProxyAccount,
    subscriptionType?: string
  ) => Promise<{ encodedVerificationUrl?: string; status?: unknown; message?: string }>
}

export interface SetOverageDeps {
  setUserPreference: (
    account: ProxyAccount,
    overageStatus: 'ENABLED' | 'DISABLED'
  ) => Promise<unknown>
}

/**
 * 组装 kiroApi 需要的 ProxyAccount 形状。
 *
 * `id` 的占位值(`'model-list-request'` / `'subscription-request'`)沿用原实现 —— 它只用于
 * kiroApi 内部日志与限流分桶,不是真账号 id。
 */
function toProxyAccount(identity: AccountApiIdentity, fallbackId: string): ProxyAccount {
  return {
    id: identity.accountId || fallbackId,
    accessToken: identity.accessToken,
    region: identity.region || 'us-east-1',
    profileArn: identity.profileArn,
    machineId: identity.machineId,
    provider: identity.provider,
    authMethod: identity.authMethod as ProxyAccount['authMethod']
  } as ProxyAccount
}

/** 获取账户可用模型列表 */
export async function getAccountModels(
  deps: GetModelsDeps,
  identity: AccountApiIdentity
): Promise<{
  success: boolean
  error?: string
  models: Array<{
    id: string
    name?: string
    description?: string
    inputTypes?: string[]
    maxInputTokens?: number | null
    maxOutputTokens?: number | null
    rateMultiplier?: number
    rateUnit?: string
  }>
}> {
  try {
    const models = await deps.fetchKiroModels(toProxyAccount(identity, 'model-list-request'))
    return {
      success: true,
      models: models.map((m) => ({
        id: m.modelId,
        name: m.modelName,
        description: m.description,
        inputTypes: m.supportedInputTypes,
        maxInputTokens: m.tokenLimits?.maxInputTokens,
        maxOutputTokens: m.tokenLimits?.maxOutputTokens,
        rateMultiplier: m.rateMultiplier,
        rateUnit: m.rateUnit
      }))
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get models',
      models: []
    }
  }
}

/** 获取可用订阅列表 */
export async function getAccountSubscriptions(
  deps: GetSubscriptionsDeps,
  identity: AccountApiIdentity
): Promise<{ success: boolean; plans?: unknown; disclaimer?: unknown; error?: string }> {
  try {
    const result = await deps.fetchAvailableSubscriptions(
      toProxyAccount(identity, 'subscription-request')
    )
    if (result.subscriptionPlans) {
      return {
        success: true,
        plans: result.subscriptionPlans,
        disclaimer: result.disclaimer
      }
    }
    return { success: false, error: 'No subscription plans returned', plans: [] }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get subscriptions',
      plans: []
    }
  }
}

/**
 * 获取订阅管理/支付链接。
 *
 * 只返回 URL,不打开 —— 打开方式是调用方的事(桌面端本机无痕窗口 / web 端浏览器新标签页)。
 */
export async function getAccountSubscriptionUrl(
  deps: GetSubscriptionUrlDeps,
  identity: AccountApiIdentity,
  subscriptionType?: string
): Promise<{ success: boolean; url?: string; status?: unknown; error?: string }> {
  try {
    const result = await deps.fetchSubscriptionToken(
      toProxyAccount(identity, 'subscription-request'),
      subscriptionType
    )
    if (result.encodedVerificationUrl) {
      return { success: true, url: result.encodedVerificationUrl, status: result.status }
    }
    return { success: false, error: result.message || 'No subscription URL returned' }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get subscription URL'
    }
  }
}

/**
 * 设置用户偏好(超额开启/关闭)。
 *
 * 成功时**原样透传**上游结果(原实现 `return result`),不包一层 `{ success: true, ... }` —— 
 * renderer 直接消费上游形状,包装会改变契约。
 */
export async function setAccountOverage(
  deps: SetOverageDeps,
  identity: AccountApiIdentity,
  overageStatus: 'ENABLED' | 'DISABLED'
): Promise<unknown> {
  try {
    return await deps.setUserPreference(
      toProxyAccount(identity, 'subscription-request'),
      overageStatus
    )
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to set overage'
    }
  }
}
