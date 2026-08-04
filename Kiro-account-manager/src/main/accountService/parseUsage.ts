/**
 * usageBreakdownList / subscriptionInfo 解析 · SSOT
 *
 * 收口对象:同一份解析逻辑原先在 src/main/index.ts 内联了 **三份**:
 *   A · check-account-status     (原 :4008 内联 parseUsageResponse)  —— 用户日常"刷新额度"路径
 *   B · background-batch-check   (原 :4798 内联)
 *   C · backgroundBatchRefresh   (原 :4482 内联)
 *
 * 三份逐字段 diff 出 4 处分歧,处理方式(逐项见下,测试固定在
 * test/main/accountService/parseUsage.test.ts):
 *
 *   D1 · 订阅类型未识别 PRO+/POWER —— **修正 A 的漏传播**。
 *        v1.4.5 commit d9c3784 标题即「修复 PRO+/POWER 订阅类型未正确识别的问题」,
 *        同一 commit 补了 4 处解析点(现 :3848 / :4536 / :4861 / :5236),唯独漏了 A。
 *        A 恰是用户最常用的路径 ⇒ PRO+ 账号点"检查账户信息"一直被降级显示为 Pro。
 *        SSOT 采用修复后的判据(PRO+ 先于 PRO 判定)。
 *
 *   D2 · CREDIT 条目筛选判据 —— **采用宽判据**(A/B 的 `resourceType==='CREDIT' ||
 *        displayName==='Credits'`)。C 原先只认 resourceType,窄判据在 resourceType
 *        缺失时额度恒为 0 —— 与 2026-07-14 RCA(usage-refresh-zero)同一病灶。
 *        宽判据是严格超集:resourceType 命中时行为不变。
 *
 *   D3 · 订阅类型兜底值 —— **参数化保留双方语义**。A 用 `account.subscription?.type ?? 'Free'`
 *        (标题无关键词时保留账号已知类型,不降级),B/C 恒 'Free'。
 *        对 A 是承重的,不能静默改成 'Free'(会把已知 Pro 账号显示成 Free),
 *        故做成 `fallbackType` 显式入参,而非二选一。
 *
 *   D4 · 空标题兜底 —— **参数化保留双方语义**。A/B 用 `?? 'Free'`(空串原样保留),
 *        C 用 `|| 'Free'`(空串兜成 'Free')。仅影响 title 展示串,type 两者都算 Free。
 *        做成 `emptyTitleAsDefault` 显式入参。
 *
 * 本模块是纯函数,无 electron / store / 网络依赖,可直接单测。
 */

/** Kiro GetUsageLimits 响应中单条额度明细(REST 与 CBOR 字段名一致) */
export interface RawUsageBreakdownItem {
  resourceType?: string
  displayName?: string
  displayNamePlural?: string
  currency?: string
  unit?: string
  overageRate?: number
  overageCap?: number
  usageLimit?: number
  usageLimitWithPrecision?: number
  currentUsage?: number
  currentUsageWithPrecision?: number
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
}

/**
 * 解析所需的最小响应形状。
 * 刻意比 index.ts 的 UnifiedUsageResponse 宽松(全部 optional),
 * 以便三个调用点各自的 inline 类型都能结构化赋值进来。
 */
export interface RawUsageResponse {
  daysUntilReset?: number
  nextDateReset?: string
  usageBreakdownList?: RawUsageBreakdownItem[]
  overageConfiguration?: {
    overageEnabled?: boolean
    overageStatus?: string
    overageLimit?: number | null
  }
  subscriptionInfo?: {
    subscriptionTitle?: string
    type?: string
    upgradeCapability?: string
    overageCapability?: string
    subscriptionManagementTarget?: string
  }
  userInfo?: {
    email?: string
    userId?: string
  }
}

/** 单条奖励额度(已展平为 UI 消费形状) */
export interface ParsedBonus {
  code: string
  name: string
  current: number
  limit: number
  expiresAt?: string
}

/** 额度资源的计费展示详情 */
export interface ParsedResourceDetail {
  resourceType?: string
  displayName?: string
  displayNamePlural?: string
  currency?: string
  unit?: string
  overageRate?: number
  overageCap?: number
  overageEnabled?: boolean
}

export interface ParsedCreditUsage {
  /** 基础额度上限 / 已用(优先取带小数精度的字段) */
  baseLimit: number
  baseCurrent: number
  /** 生效中(freeTrialStatus==='ACTIVE')的试用额度;未生效为 0 */
  freeTrialLimit: number
  freeTrialCurrent: number
  freeTrialExpiry?: string
  /** 仅 status==='ACTIVE' 的奖励 */
  bonuses: ParsedBonus[]
  /** 基础 + 试用 + 生效奖励 */
  totalLimit: number
  totalCurrent: number
  nextResetDate?: string
  /** 无 CREDIT 条目时为 undefined */
  resourceDetail?: ParsedResourceDetail
}

/** 渲染层的订阅类型值域(SSOT: renderer/src/types/account.ts:7 SubscriptionType) */
export type SubscriptionTypeName = 'Free' | 'Pro' | 'Pro_Plus' | 'Enterprise' | 'Teams'

export interface ParsedSubscription {
  type: SubscriptionTypeName | string
  title: string
  rawType?: string
  expiresAt?: number
  daysRemaining?: number
  upgradeCapability?: string
  overageCapability?: string
  managementTarget?: string
}

const MS_PER_DAY = 1000 * 60 * 60 * 24

/**
 * 定位 CREDIT 额度条目。
 * D2:宽判据 —— resourceType 或 displayName 任一命中(resourceType 缺失的响应也能取到额度)。
 */
function findCreditUsage(
  result: RawUsageResponse
): RawUsageBreakdownItem | undefined {
  return result.usageBreakdownList?.find(
    (b) => b.resourceType === 'CREDIT' || b.displayName === 'Credits'
  )
}

/**
 * 解析额度(基础 + 试用 + 奖励)。
 * 精度优先:`*WithPrecision` 存在时优先,否则回退整数字段,再否则 0。
 */
export function parseCreditUsage(result: RawUsageResponse): ParsedCreditUsage {
  const creditUsage = findCreditUsage(result)

  const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
  const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0

  // 试用额度:仅 ACTIVE 计入(过期试用不能算进总额,否则额度虚高)
  let freeTrialLimit = 0
  let freeTrialCurrent = 0
  let freeTrialExpiry: string | undefined
  const trial = creditUsage?.freeTrialInfo
  if (trial?.freeTrialStatus === 'ACTIVE') {
    freeTrialLimit = trial.usageLimitWithPrecision ?? trial.usageLimit ?? 0
    freeTrialCurrent = trial.currentUsageWithPrecision ?? trial.currentUsage ?? 0
    freeTrialExpiry = trial.freeTrialExpiry
  }

  // 奖励额度:仅 ACTIVE 计入
  const bonuses: ParsedBonus[] = []
  if (creditUsage?.bonuses) {
    for (const bonus of creditUsage.bonuses) {
      if (bonus.status === 'ACTIVE') {
        bonuses.push({
          code: bonus.bonusCode || '',
          name: bonus.displayName || '',
          current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
          limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
          expiresAt: bonus.expiresAt
        })
      }
    }
  }

  const bonusLimit = bonuses.reduce((sum, b) => sum + b.limit, 0)
  const bonusCurrent = bonuses.reduce((sum, b) => sum + b.current, 0)

  return {
    baseLimit,
    baseCurrent,
    freeTrialLimit,
    freeTrialCurrent,
    freeTrialExpiry,
    bonuses,
    totalLimit: baseLimit + freeTrialLimit + bonusLimit,
    totalCurrent: baseCurrent + freeTrialCurrent + bonusCurrent,
    nextResetDate: result.nextDateReset,
    resourceDetail: creditUsage
      ? {
          resourceType: creditUsage.resourceType,
          displayName: creditUsage.displayName,
          displayNamePlural: creditUsage.displayNamePlural,
          currency: creditUsage.currency,
          unit: creditUsage.unit,
          overageRate: creditUsage.overageRate,
          overageCap: creditUsage.overageCap,
          overageEnabled:
            result.overageConfiguration?.overageStatus === 'ENABLED' ||
            result.overageConfiguration?.overageEnabled === true
        }
      : undefined
  }
}

/**
 * 订阅标题 → 订阅类型。
 *
 * D1:判定顺序是承重的 —— PRO+ / PRO_PLUS / PROPLUS 必须先于 PRO,
 * 否则 'KIRO PRO+' 会先命中 includes('PRO') 被降级为 Pro(v1.4.5 d9c3784 修的正是这个)。
 * POWER 亦须先于 PRO(无包含关系,但保持与既有 4 处一致的判定链顺序)。
 *
 * D3:`fallbackType` —— 标题无任何可识别关键词时的返回值。
 * check-account-status 传入账号已知的 subscription.type(避免把已知 Pro 降级为 Free);
 * 批量路径不传 ⇒ 'Free'。
 */
export function classifySubscriptionType(
  subscriptionTitle: string,
  fallbackType: string = 'Free'
): string {
  const titleUpper = (subscriptionTitle || '').toUpperCase()

  if (
    titleUpper.includes('PRO+') ||
    titleUpper.includes('PRO_PLUS') ||
    titleUpper.includes('PROPLUS')
  ) {
    return 'Pro_Plus'
  }
  if (titleUpper.includes('POWER')) return 'Enterprise'
  if (titleUpper.includes('PRO')) return 'Pro'
  if (titleUpper.includes('ENTERPRISE')) return 'Enterprise'
  if (titleUpper.includes('TEAMS')) return 'Teams'
  return fallbackType
}

export interface ParseSubscriptionOptions {
  /** D3:标题无可识别关键词时的兜底类型;缺省 'Free' */
  fallbackType?: string
  /**
   * D4:空标题('' / undefined)是否兜成 'Free'。
   * 缺省 false = 保留 A/B 的 `?? 'Free'` 语义(仅 undefined 兜底,空串原样);
   * true = C 的 `|| 'Free'` 语义。
   */
  emptyTitleAsDefault?: boolean
  /** 便于测试注入固定时间;缺省 Date.now() */
  now?: number
}

/** 解析订阅信息(类型 / 标题 / 到期时间 / 剩余天数 / 能力字段) */
export function parseSubscription(
  result: RawUsageResponse,
  opts: ParseSubscriptionOptions = {}
): ParsedSubscription {
  const rawTitle = result.subscriptionInfo?.subscriptionTitle
  const title = opts.emptyTitleAsDefault ? rawTitle || 'Free' : rawTitle ?? 'Free'

  const type = classifySubscriptionType(title, opts.fallbackType ?? 'Free')

  // 到期时间与剩余天数由额度重置日期推导(Kiro 无独立订阅到期字段)
  let expiresAt: number | undefined
  let daysRemaining: number | undefined
  if (result.nextDateReset) {
    expiresAt = new Date(result.nextDateReset).getTime()
    const now = opts.now ?? Date.now()
    daysRemaining = Math.max(0, Math.ceil((expiresAt - now) / MS_PER_DAY))
  }

  return {
    type,
    title,
    rawType: result.subscriptionInfo?.type,
    expiresAt,
    daysRemaining,
    upgradeCapability: result.subscriptionInfo?.upgradeCapability,
    overageCapability: result.subscriptionInfo?.overageCapability,
    managementTarget: result.subscriptionInfo?.subscriptionManagementTarget
  }
}
