/**
 * 用量额度归一化（SSOT） · 供 IPC 与 HTTP 面板共用
 *
 * 抽取来源：index.ts 内两份近乎逐字重复的额度合并代码
 *   :3861~:3886 (import-from-sso-token) · :5245~:5290 (verify-account-credentials)
 *
 * ⚠️ 两个调用点存在**一处真实的行为差异**，本函数用参数保留而非"顺手统一"：
 *   - verify-account-credentials：只累计 `bonus.status === 'ACTIVE'` 的赠送额度
 *   - import-from-sso-token：累计**全部** bonus（不看 status）
 *   统一任何一边都会改变用户看到的额度数字（照搬原则 = 语义不得变）。
 *   → `filterActiveBonuses` 显式区分，两种行为各有测试钉死。
 */
import type { UsageApiShape, NormalizedUsage } from './types'

export type NormalizeUsageOpts = {
  /**
   * true  → 只计入 status==='ACTIVE' 的 bonus（verify-account-credentials 的既有行为）
   * false → 计入全部 bonus（import-from-sso-token 的既有行为）
   */
  filterActiveBonuses: boolean
}

/**
 * 从 Kiro 用量 API 响应里取出 CREDIT 明细并合并总额度。
 *
 * 纯函数：不修改入参（有测试断言入参未被篡改 —— 上游轮次曾出现「快照与被改对象共享引用」
 * 类缺陷，这里的 bonuses 是 map 出的新数组，resourceDetail 是新对象字面量，不复用入参引用）。
 */
export function normalizeCreditUsage(
  usageData: UsageApiShape | undefined,
  opts: NormalizeUsageOpts
): NormalizedUsage {
  const creditUsage = usageData?.usageBreakdownList?.find((b) => b.resourceType === 'CREDIT')

  // 基础额度（优先使用带精度的小数字段）
  const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
  const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0

  // 试用额度（仅 ACTIVE 时计入）
  let freeTrialLimit = 0
  let freeTrialCurrent = 0
  let freeTrialExpiry: string | undefined
  if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
    const t = creditUsage.freeTrialInfo
    freeTrialLimit = t.usageLimitWithPrecision ?? t.usageLimit ?? 0
    freeTrialCurrent = t.currentUsageWithPrecision ?? t.currentUsage ?? 0
    freeTrialExpiry = t.freeTrialExpiry
  }

  // 奖励额度（是否过滤 ACTIVE 由调用点决定，见文件头说明）
  const rawBonuses = creditUsage?.bonuses ?? []
  const selected = opts.filterActiveBonuses
    ? rawBonuses.filter((b) => b.status === 'ACTIVE')
    : rawBonuses
  const bonuses = selected.map((b) => ({
    code: b.bonusCode || '',
    name: b.displayName || '',
    current: b.currentUsageWithPrecision ?? b.currentUsage ?? 0,
    limit: b.usageLimitWithPrecision ?? b.usageLimit ?? 0,
    expiresAt: b.expiresAt
  }))

  const limit = baseLimit + freeTrialLimit + bonuses.reduce((s, b) => s + b.limit, 0)
  const current = baseCurrent + freeTrialCurrent + bonuses.reduce((s, b) => s + b.current, 0)

  return {
    current,
    limit,
    baseLimit,
    baseCurrent,
    freeTrialLimit,
    freeTrialCurrent,
    freeTrialExpiry,
    bonuses,
    resourceDetail: creditUsage
      ? {
          displayName: creditUsage.displayName,
          displayNamePlural: creditUsage.displayNamePlural,
          resourceType: creditUsage.resourceType,
          currency: creditUsage.currency,
          unit: creditUsage.unit,
          overageRate: creditUsage.overageRate,
          overageCap: creditUsage.overageCap,
          overageEnabled:
            usageData?.overageConfiguration?.overageStatus === 'ENABLED' ||
            usageData?.overageConfiguration?.overageEnabled === true
        }
      : undefined
  }
}

/**
 * 额度重置剩余天数（向上取整，不返回负数）。
 * 抽取来源：index.ts:3925（sso-import 内联三元）与 :5297~:5301（verify 内联 if）。
 */
export function computeDaysRemaining(nextDateReset: string | undefined): number | undefined {
  if (!nextDateReset) return undefined
  return Math.max(0, Math.ceil((new Date(nextDateReset).getTime() - Date.now()) / 86400000))
}
