/**
 * 「后台批量刷新 Token」结果落盘 · 主进程调度器与 IPC 共用
 *
 * ## 治的病灶
 *
 * `backgroundBatchRefresh` 刷新成功后只 `emit('background-refresh-result', …)` 把新凭据
 * 推给渲染进程,由 `store/accounts.ts:applyBackgroundRefreshResults` 接收 ——
 * 而那个 reducer 只改 zustand 内存,尾部**没有** `saveToStorage()`。
 *
 * 服务器形态上没有渲染进程(`mainWindow` 为 undefined ⇒ send 是静默 no-op),
 * 于是新签发的 refreshToken 连内存都进不去。IdP 轮换时旧 refreshToken 一签发新的
 * 就当场作废 ⇒ 盘上留着死凭据 ⇒ 重启后账号全部失效,而日志里每分钟都报"刷新成功"。
 *
 * ## 为什么按「切片」写,而不是逐账号 / 最后统一写一次
 *
 * 与 `persistCheckResult.ts:persistBatchCheckResults` 同一权衡(那边的注释是本判断的出处):
 *   - **逐账号写**:1000 账号 = 1000 次 revision 递增 + 1000 条广播,每条都会让桌面端
 *     整表 reload ⇒ 2026-07-23「前端卡死」RCA 的病灶形状。
 *   - **最后统一写一次**:中途失败(进程崩 / 上游挂)⇒ 已成功刷新的凭据全丢,
 *     而那些 refreshToken **已经被上游作废了** —— 比不刷更糟。
 *   - **按切片写**:广播数 = ⌈账号数 / concurrency⌉,失败最多只丢当前这一片。
 *
 * ## 字段清单的来源(不是重新设计的)
 *
 * 行为基线 = renderer `applyBackgroundRefreshResults`(`store/accounts.ts:3461-3569`)
 * 实际写进内存的字段,逐字段对齐。与单账号的 `patchAccountWithRefreshResult` 的**差异**
 * 是刻意的,因为两条路的基线本来就不同:
 *
 * | 字段 | 单账号(refresh.ts) | 批量(这里) | 依据 |
 * |---|---|---|---|
 * | `accessToken` | 直接取新值 | `新值 \|\| 旧值` | 基线 `:3526` 用 `\|\|` |
 * | `expiresAt` | `now + expiresIn*1000` | 有 expiresIn 才更新,否则保留 | 基线 `:3528` 三元 |
 * | `profileArn` | 顶层 + credentials 都写 | 仅当非空才写(空值不落 undefined) | 基线 `:3521` 的 `...(x ? {} : {})` |
 * | `usage` / `subscription` | 不碰 | `syncInfo` 带回来时按字段 `??` 合并 | 基线 `:3535-3560` |
 * | `status` | 恒 `'active'` | `data.status === 'error' ? 'error' : 'active'` | 基线 `:3517` 封禁检测 |
 * | `lastError` | 恒 `undefined` | 取 `data.errorMessage`(可为 undefined) | 基线 `:3518` |
 *
 * ⚠️ 失败项(`success:false`)只写 `status:'error'` + `lastError` + `lastCheckedAt`,
 * **绝不碰凭据与额度** —— 刷新失败不能被当成"凭据已更新"或"额度归零"写下去(基线 `:3474`)。
 */

import { applyAccountDataMutation, type AccountsBlob } from './state'
import { asRecord } from './persistAccountPatch'

/** `background-refresh-result` 事件里 `data` 的形状(与 backgroundRefresh 发射的逐字段一致) */
export interface BatchRefreshResultData {
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  profileArn?: string
  usage?: {
    current?: number
    limit?: number
    baseCurrent?: number
    baseLimit?: number
    freeTrialCurrent?: number
    freeTrialLimit?: number
    freeTrialExpiry?: string
    bonuses?: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }>
    nextResetDate?: string
    resourceDetail?: Record<string, unknown>
  }
  subscription?: {
    type?: string
    title?: string
    daysRemaining?: number
    expiresAt?: number
    overageCapability?: string
    upgradeCapability?: string
    subscriptionManagementTarget?: string
  }
  userInfo?: { email?: string; userId?: string }
  status?: string
  errorMessage?: string
}

/** 一条批量刷新结果(成功 / 失败两种形状,与 emit 的 payload 同构) */
export type BatchRefreshItem =
  | { id: string; success: true; data: BatchRefreshResultData }
  | { id: string; success: false; error?: string }

/**
 * 中止收口用的私有哨兵。
 *
 * 为什么用抛出而不是「返回 prev 原样」:`applyAccountDataMutation` 无论内容是否变化都会
 * `revision + 1` 并广播。这一片的账号全被另一端删掉时返回原样 = 一次**无意义的
 * revision 递增 + 广播**,而每条广播都可能让桌面端整表 reload 一次。
 * mutator 抛错时收口在 `await mutate(prev)` 处就中断,`set` 与广播都不执行 —— 零副作用。
 */
class SkipPersist extends Error {
  constructor() {
    super('skip persist: account-not-found')
  }
}

/**
 * 把一条批量刷新结果合并进账号记录(纯函数,便于单测逐字段固定)。
 *
 * 回退值一律取自 `account`(**盘面当前值**),不取调用方入参快照 ——
 * 快照可能已陈旧(桌面端期间可能补上了 profileArn),用它回退会把新值按回旧值。
 */
export function patchAccountWithRefreshBatchResult(
  account: Record<string, unknown>,
  item: BatchRefreshItem,
  now: number = Date.now()
): Record<string, unknown> {
  // 失败项:只标错误状态,绝不碰凭据/额度（基线 store/accounts.ts:3474）
  if (!item.success) {
    return { ...account, status: 'error', lastError: item.error, lastCheckedAt: now }
  }

  const d = item.data
  const prevCred = asRecord(account.credentials) ?? {}

  // 基线 :3521 的回退次序:本次拿到的 > credentials 里的 > 顶层的。
  // 空值不写 undefined（基线用 `...(bgProfileArn ? {...} : {})` 表达同一意图）。
  const bgProfileArn = d?.profileArn || prevCred.profileArn || account.profileArn

  const nextCred: Record<string, unknown> = {
    ...prevCred,
    // 基线 :3526-3527 用 `||` 回退（不是 `??`）—— 空串也回退到旧值
    accessToken: d?.accessToken || prevCred.accessToken,
    refreshToken: d?.refreshToken || prevCred.refreshToken,
    // 基线 :3528:有 expiresIn 才重算，否则保留旧值（缺字段不把过期时间清掉）
    expiresAt: d?.expiresIn ? now + d.expiresIn * 1000 : prevCred.expiresAt,
    ...(bgProfileArn ? { profileArn: bgProfileArn } : {})
  }

  // 基线 :3516 封禁检测：上游标了 error 才是 error，其余一律 active
  const status = d?.status === 'error' ? 'error' : 'active'

  const prevUsage = asRecord(account.usage) ?? {}
  const nextUsage = d?.usage
    ? (() => {
        const current = d.usage.current ?? (prevUsage.current as number | undefined)
        const limit = d.usage.limit ?? (prevUsage.limit as number | undefined)
        return {
          ...prevUsage,
          current,
          limit,
          percentUsed: typeof limit === 'number' && limit > 0 ? (current ?? 0) / limit : 0,
          baseCurrent: d.usage.baseCurrent ?? prevUsage.baseCurrent,
          baseLimit: d.usage.baseLimit ?? prevUsage.baseLimit,
          freeTrialCurrent: d.usage.freeTrialCurrent ?? prevUsage.freeTrialCurrent,
          freeTrialLimit: d.usage.freeTrialLimit ?? prevUsage.freeTrialLimit,
          freeTrialExpiry: d.usage.freeTrialExpiry ?? prevUsage.freeTrialExpiry,
          bonuses: d.usage.bonuses ?? prevUsage.bonuses,
          nextResetDate: d.usage.nextResetDate ?? prevUsage.nextResetDate,
          resourceDetail: d.usage.resourceDetail ?? prevUsage.resourceDetail,
          lastUpdated: now
        }
      })()
    : account.usage

  const prevSub = asRecord(account.subscription) ?? {}
  const nextSub = d?.subscription
    ? {
        ...prevSub,
        type: d.subscription.type ?? prevSub.type,
        title: d.subscription.title ?? prevSub.title,
        daysRemaining: d.subscription.daysRemaining ?? prevSub.daysRemaining,
        expiresAt: d.subscription.expiresAt ?? prevSub.expiresAt,
        overageCapability: d.subscription.overageCapability ?? prevSub.overageCapability,
        upgradeCapability: d.subscription.upgradeCapability ?? prevSub.upgradeCapability,
        // 基线把上游的 subscriptionManagementTarget 存成 managementTarget（字段名有意不同）
        managementTarget: d.subscription.subscriptionManagementTarget ?? prevSub.managementTarget
      }
    : account.subscription

  return {
    ...account,
    ...(bgProfileArn ? { profileArn: bgProfileArn } : {}),
    credentials: nextCred,
    usage: nextUsage,
    subscription: nextSub,
    // 基线 :3563-3564 用 `||`（空串回退）
    email: d?.userInfo?.email || account.email,
    userId: d?.userInfo?.userId || account.userId,
    status,
    lastError: d?.errorMessage,
    lastCheckedAt: now
  }
}

/**
 * 把一片(一个 concurrency 切片)的刷新结果一次性落盘。
 *
 * 单次 `applyAccountDataMutation` 覆盖 N 个账号 ⇒ 一次 revision 递增 + 一条广播。
 * 盘上已无的账号跳过(另一端刚删了它),**绝不重建** —— 那是「已删账号复活」。
 *
 * @returns 实际写进盘的账号数;`0` = 这一片没有任何账号仍在盘上 ⇒ 不写盘、不广播
 * @throws 写盘异常向上抛,调用方决定是否中断(绝不在这里吞掉后假装成功)
 */
export async function persistBatchRefreshResults(items: BatchRefreshItem[]): Promise<number> {
  if (items.length === 0) return 0

  const now = Date.now()
  try {
    let applied = 0
    const result = await applyAccountDataMutation((prev) => {
      const accounts = asRecord(prev.accounts)
      if (!accounts) throw new SkipPersist()

      const next: Record<string, unknown> = { ...accounts }
      applied = 0
      for (const item of items) {
        const target = asRecord(next[item.id])
        // 盘上已无此账号 = 另一端删了它。跳过，绝不重建。
        if (!target) continue
        next[item.id] = patchAccountWithRefreshBatchResult(target, item, now)
        applied++
      }

      // 一个都没命中 ⇒ 中止，避免无意义的 revision 递增 + 广播
      if (applied === 0) throw new SkipPersist()

      return { ...prev, accounts: next } as AccountsBlob
    })

    if (result.ok) return applied
    // 不传 expectedRevision ⇒ 收口不会返回 STALE_REVISION。
    // 走到这里说明收口语义变了，必须让它响（不静默）。
    throw new Error(
      `[accountService/persistBatchRefreshResults] unexpected arbitration result: ${result.code}`
    )
  } catch (e) {
    if (e instanceof SkipPersist) return 0
    throw e
  }
}
