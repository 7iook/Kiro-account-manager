/**
 * Profile 决策 SSOT helper(2026-07-13 新增)
 *
 * 场景:external_idp + IdC 多 profile 登录改造(决策卡 v2)。
 * 目的:把"决定使用哪个 profileArn"和"拼装登录返回体"两处纯逻辑从 index.ts handler 内抽出为
 *       可测的 pure function,让 vitest 无需拉起 electron 也能覆盖 handler 层核心分支。
 *
 * 参见:.agent-workspace/.archive/2026-07-13/multi-profile-import/multi-profile-import-decision-card.md
 */

import type { ProxyAccount } from './types'
import type { KiroProfile } from './kiroApi'

// ============ verify-account-credentials: profileArn 决策 ============

/** resolveProfileArnForVerify 的输入(与 credentials payload 里 profile 相关字段一致) */
export interface ResolveProfileArnOpts {
  /** renderer 侧多 profile 场景传入(用户已选定的 profileArn);单 profile / 老路径不传 */
  providedProfileArn?: string
  /** 是否为 Enterprise 系账户(Enterprise / external_idp),非 Enterprise 不调 fetcher */
  isEnterprise: boolean
  accessToken: string
  region: string
  provider?: string
  authMethod?: string
}

/**
 * verify-account-credentials handler 内决定使用哪个 profileArn 的 SSOT 逻辑。
 *
 * 决策卡 v2 修订 2 + 修订 3:
 * - 传入 providedProfileArn(非空) → 直接使用,不再调 fetchEnterpriseProfileArn 兜底
 *   (renderer 侧多 profile 场景 M 次独立 verify 时用它精准指向某个 profile)
 * - 未传 + isEnterprise → 走 fetcher 兜底(向后兼容原行为)
 * - 未传 + 非 Enterprise → 返 undefined(BuilderId / Social 不需要)
 * - fetcher 抛异常 → 吞异常返 undefined(与老 handler line 4691-4707 兜底行为一致,避免登录整体失败)
 */
export async function resolveProfileArnForVerify(
  opts: ResolveProfileArnOpts,
  fetcher: (account: ProxyAccount) => Promise<string | undefined>
): Promise<string | undefined> {
  // 空字符串视为未传(避免 renderer 传 '' 误命中)
  if (typeof opts.providedProfileArn === 'string' && opts.providedProfileArn.length > 0) {
    return opts.providedProfileArn
  }

  if (!opts.isEnterprise) {
    return undefined
  }

  try {
    return await fetcher({
      id: '',
      accessToken: opts.accessToken,
      region: opts.region,
      provider: opts.provider as ProxyAccount['provider'],
      authMethod: opts.authMethod as ProxyAccount['authMethod']
    })
  } catch (e) {
    console.warn('[ProfileSelection] resolveProfileArnForVerify fetcher failed:', e)
    return undefined
  }
}

// ============ complete-external-idp-login: 返回体拼装 ============

export interface CompleteLoginTokenData {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
}

export interface CompleteLoginSavedState {
  tokenEndpoint: string
  issuerUrl: string
  clientId: string
  scopes: string[]
  email: string
}

/** complete-external-idp-login handler 的成功返回体(与老契约兼容 + profiles 新字段) */
export interface CompleteLoginResult {
  success: true
  accessToken: string
  refreshToken: string
  expiresIn: number
  tokenEndpoint: string
  issuerUrl: string
  clientId: string
  scopes: string
  /** 老字段(N=1 时 = profiles[0].profileArn,向后兼容 renderer 旧代码单 profile 路径) */
  profileArn?: string
  /** 新字段(2026-07-13):所有可用 profile,renderer 用它做单/多 profile 分叉 */
  profiles: Array<KiroProfile>
  email: string
}

/**
 * complete-external-idp-login handler 的返回体拼装 SSOT。
 *
 * 决策卡 v2 §3:
 * - profiles 为主字段,renderer 消费此数组决定 UI 分叉(N=1 自动导入 / N≥2 弹选择框)
 * - profileArn = profiles[0].profileArn(向后兼容 renderer 旧代码,N=1 时无损)
 * - 单/多 profile 场景类型稳定统一(profiles 永远是数组)
 */
export function buildCompleteLoginResult(
  tokenData: CompleteLoginTokenData,
  profiles: KiroProfile[],
  saved: CompleteLoginSavedState
): CompleteLoginResult {
  return {
    success: true,
    accessToken: tokenData.accessToken,
    refreshToken: tokenData.refreshToken || '',
    expiresIn: tokenData.expiresIn ?? 3600,
    tokenEndpoint: saved.tokenEndpoint,
    issuerUrl: saved.issuerUrl,
    clientId: saved.clientId,
    scopes: saved.scopes.join(' '),
    profileArn: profiles[0]?.profileArn,
    profiles,
    email: saved.email
  }
}
