/**
 * 「刷新额度」结果落盘 · IPC 与 HTTP 面板共用的持久化层
 *
 * ## 为什么需要这一层
 *
 * `check.ts:checkAccountStatus` 原先**只返回数据、不落盘**。落盘发生在 renderer store
 * （`store/accounts.ts:2013` 写内存 → `:2079 saveToStorage()` 落盘）—— 那是 renderer 独有的。
 * web 面板的 HTTP 路由（`webPanel/routes.ts:242`）调同一个业务函数却没有那个 store，
 * 于是手机端刷出的新数字只活在浏览器内存里：**重载页面即回旧值，桌面端也不知情**。
 *
 * 把落盘放到业务层后，两个调用方（IPC / HTTP）都自动获得持久化，无需各自实现一份。
 *
 * ## 字段清单的来源（不是重新设计的）
 *
 * 行为基线 = renderer store `checkAccountStatus` 那次 `set()`（`store/accounts.ts:2013-2073`）
 * 实际写进内存、随后被 `buildPersistBlob` 整表落盘的字段，逐字段对齐：
 *
 * | 字段 | renderer 的语义 | 这里 |
 * |---|---|---|
 * | `email` / `userId` | `data.x ?? acc.x` | 同 |
 * | `idp` | 仅在能识别成已知枚举时更新，未知保留原值 | 同（`mapIdp`） |
 * | `status` | 直接取 `data.status` | 同 |
 * | `usage` | **重建整个对象**（不 spread 旧 usage） | 同（见 `buildUsage` 注释） |
 * | `subscription` | `{ ...acc.subscription, ...data.subscription }` | 同 |
 * | `credentials` | 仅当 `data.newCredentials` 存在时更新三个字段 | 同 |
 * | `lastCheckedAt` | `Date.now()` | 同 |
 * | `lastError` | `undefined`（刷新成功即清错误） | 同 |
 *
 * **刻意不落盘**的三个 DTO 字段：`subscriptionTitle` / `userStatus` / `featureFlags`。
 * renderer 从不把它们写进账号记录（`subscription.title` 才是显示用的那个），
 * 这里跟着基线走 —— "顺手多存一点"会让盘上出现桌面端从未产生过的字段。
 *
 * ## 为什么是「字段级补丁」而不是整条记录覆盖
 *
 * `checkAccountStatus` 的入参是**调用方给的账号快照**，可能已经陈旧（手机端发起时，
 * 快照来自那一刻的盘面；期间桌面端可能改了备注 / 分组 / 标签）。整条覆盖会把这些
 * 并发编辑按回旧值。所以这里在收口的 mutator 内部**重新读盘**，只覆盖上表那几个键。
 */

import { applyAccountDataMutation, type AccountsBlob } from './state'
import { persistAccountPatch, asRecord, type PersistOutcome } from './persistAccountPatch'
import type { CheckAccountStatusData } from './check'

/**
 * 落盘结果 —— 调用方（业务函数）据此决定日志级别，不用 try/catch 猜。
 *
 * 单账号路径的语义已收敛到 `./persistAccountPatch`（与「刷新 Token」共用同一条路径）；
 * 这里保留别名以免改动现有调用方的类型引用。
 */
export type PersistCheckOutcome = PersistOutcome

/**
 * 中止收口用的私有哨兵。
 *
 * 为什么用抛出而不是「返回 prev 原样」：`applyAccountDataMutation` 无论内容是否变化都会
 * `revision + 1` 并广播（state.ts:186-196）。账号已被删除时返回原样 = 一次**无意义的
 * revision 递增 + 广播**，而每条广播都可能让桌面端整表 reload 一次。mutator 抛错时
 * 收口在 `const next = await mutate(prev)` 处就中断，`storeRef.set` 与广播都不会执行，
 * revision 保持不变 —— 这是零副作用的中止方式，且不需要改动写入 SSOT 的契约。
 *
 * 哨兵**不跨层**：在本文件抛出、在本文件捕获，对外仍是返回值语义
 * （§4.4「预期失败用返回值而非异常」的边界内）。
 *
 * 单账号路径的同款哨兵已收敛进 `./persistAccountPatch`；这里保留的这一份专供**批量**
 * 路径（它一次写 N 条，遍历逻辑与单条补丁不同源，不能共用那个收口）。
 */
class SkipPersist extends Error {
  constructor(readonly reason: 'account-not-found') {
    super(`skip persist: ${reason}`)
  }
}

/**
 * 把 API 返回的 idp 映射成账号记录里的已知枚举。
 * 逐字照搬 `store/accounts.ts:2045-2054`：**未知类型保留原值**，不强制改成 Internal。
 */
function mapIdp(apiIdp: string | undefined, current: unknown): unknown {
  if (!apiIdp) return current
  if (apiIdp === 'BuilderId') return 'BuilderId'
  if (apiIdp === 'Google') return 'Google'
  if (apiIdp === 'Github') return 'Github'
  if (apiIdp === 'AWSIdC') return 'AWSIdC'
  if (apiIdp === 'Enterprise' || apiIdp === 'Internal') return 'Enterprise'
  return current
}

/**
 * 组装新的 usage 对象。
 *
 * ⚠️ 刻意**不** spread 旧 usage —— 这不是遗漏，而是对齐 renderer 基线
 * （`store/accounts.ts:2029` 的 `mergedUsage` 也是从零构造）。若在这里 spread 旧值，
 * 盘上会保留桌面端本来会丢掉的字段，两端产出的记录形状就不一致了。
 *
 * `current` / `limit` 用 `??` 回落旧值（与基线一致：上游偶发缺字段时不把额度清零），
 * 其余字段直接取 API 值（基线亦如此）。
 */
function buildUsage(
  apiUsage: CheckAccountStatusData['usage'],
  prevUsage: Record<string, unknown> | undefined,
  now: number
): Record<string, unknown> {
  const prev = prevUsage ?? {}
  const current = apiUsage.current ?? (prev.current as number | undefined)
  const limit = apiUsage.limit ?? (prev.limit as number | undefined)
  return {
    current,
    limit,
    // 基线用 apiUsage 自己的 limit/current 算，不用回落后的值（store/accounts.ts:2032）
    percentUsed: apiUsage.limit > 0 ? apiUsage.current / apiUsage.limit : 0,
    lastUpdated: apiUsage.lastUpdated ?? now,
    baseLimit: apiUsage.baseLimit,
    baseCurrent: apiUsage.baseCurrent,
    freeTrialLimit: apiUsage.freeTrialLimit,
    freeTrialCurrent: apiUsage.freeTrialCurrent,
    freeTrialExpiry: apiUsage.freeTrialExpiry,
    bonuses: apiUsage.bonuses,
    nextResetDate: apiUsage.nextResetDate,
    resourceDetail: apiUsage.resourceDetail
  }
}

/** 把 check 结果合并进一条账号记录（纯函数，便于单测逐字段固定） */
export function patchAccountWithCheckResult(
  account: Record<string, unknown>,
  data: CheckAccountStatusData,
  now: number = Date.now()
): Record<string, unknown> {
  const prevCred = asRecord(account.credentials) ?? {}
  const nextCred = data.newCredentials
    ? {
        ...prevCred,
        accessToken: data.newCredentials.accessToken,
        refreshToken: data.newCredentials.refreshToken ?? prevCred.refreshToken,
        expiresAt: data.newCredentials.expiresAt ?? prevCred.expiresAt
      }
    : prevCred

  return {
    ...account,
    email: data.email ?? account.email,
    userId: data.userId ?? account.userId,
    idp: mapIdp(data.idp, account.idp),
    status: data.status,
    usage: data.usage ? buildUsage(data.usage, asRecord(account.usage), now) : account.usage,
    subscription: data.subscription
      ? { ...(asRecord(account.subscription) ?? {}), ...data.subscription }
      : account.subscription,
    credentials: nextCred,
    lastCheckedAt: now,
    // 刷新成功即视为当前无错误（基线 store/accounts.ts:2071）。
    // JSON 落盘时 undefined 键会被丢弃 ⇒ 等价于清除。
    lastError: undefined
  }
}

/**
 * 把一次「刷新额度」的结果落到盘上。
 *
 * 写入**必须**经 `applyAccountDataMutation`（`state.ts` 的 revision 乐观锁收口）——
 * 那个收口存在的理由正是让手机端与桌面端不互相覆盖，且它成功后会广播
 * `accounts-data-changed`，桌面端因此无需轮询即可得知手机刷了额度。
 *
 * **不传 `expectedRevision`**：与其它 main 侧自动写路径一致（ProactiveRenewal
 * `index.ts:2234` / IDE 反向同步 `:2089` / 解封 `:6306` 都不传）。语义是「无仲裁直写」：
 * main 侧刚从上游拿到的额度就是权威值，没有"客户端持有的旧快照"可供仲裁。
 * 安全性由 mutator 内部**重新读盘 + 只改指定字段**保证 —— 收口的串行锁（state.ts:131）
 * 让这个读-改-写是原子的，不会覆盖并发写入的其它账号 / 其它字段。
 *
 * @param accountId 账号 id（调用方入参快照里的 id）
 * @param data 成功的 check 结果
 * @throws 写盘异常向上抛 —— 调用方负责记录（绝不在这里吞掉后假装成功）
 */
export async function persistCheckResult(
  accountId: string | undefined,
  data: CheckAccountStatusData
): Promise<PersistCheckOutcome> {
  const now = Date.now()
  // 盘面遍历 / 账号不存在的中止 / 仲裁结果异常，全部收在 ./persistAccountPatch
  // （与「刷新 Token」共用同一条持久化路径）。这里只提供「覆盖哪几个键」。
  return persistAccountPatch(
    accountId,
    (current) => patchAccountWithCheckResult(current, data, now),
    'persistCheckResult'
  )
}

// ============ 批量检查（background-batch-check）的落盘 ============
//
// ## 为什么按「批」写而不是按「账号」写，也不是「最后统一写一次」
//
// `backgroundBatchCheck` 已经按 `concurrency` 切片串行处理，每切片结束推一次
// `background-check-progress`。落盘挂在同一个节奏上（每切片一次）是唯一同时满足三条的方案：
//
//   - **逐账号写**：1000 账号 = 1000 次 revision 递增 + 1000 条广播。每条广播都会让桌面端
//     走一次 `syncIfRevisionDrifted` → 整表 `loadAccounts` + 整表 set + re-render。
//     那正是 2026-07-23「前端卡死」RCA 的病灶形状（见 `utils/emitToRenderer.ts` 文件头）。
//   - **最后统一写一次**：中途失败（用户关窗 / 上游挂 / 进程崩）⇒ 已成功的部分全丢，
//     用户白烧一轮上游额度。这是本轮交付契约明确列出的负条件。
//   - **按切片写**：广播数 = ⌈账号数 / concurrency⌉（默认 concurrency=100 ⇒ 1000 账号 10 次），
//     失败最多只丢**当前这一片**已完成的结果，前面的片已在盘上。
//
// ## 失败语义
//
// 单片落盘失败**不中断整个批量**：批量的价值在于「尽可能多刷到」，为一片写盘失败
// 放弃后面 900 个账号是更差的选择。失败记 `console.error` 并继续下一片；
// 那一片的结果仍已经通过 `background-check-result` 事件到达 UI（用户看得到数字），
// 只是没落盘 —— 下次刷新会重新取到。**绝不静默**：错误日志是唯一的可观测出口。

/** `background-check-result` 事件里 `data` 的形状（与 check.ts 发射的逐字段一致） */
export interface BatchCheckResultData {
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
  } | null
  subscription?: {
    type?: string
    title?: string
    daysRemaining?: number
    expiresAt?: number
    overageCapability?: string
    upgradeCapability?: string
    subscriptionManagementTarget?: string
  } | null
  userInfo?: { email?: string; userId?: string; status?: string } | null
  status?: string
  errorMessage?: string
}

/** 一条批量结果（成功 / 失败两种形状，与 emit 的 payload 同构） */
export type BatchCheckItem =
  | { id: string; success: true; data: BatchCheckResultData }
  | { id: string; success: false; error?: string }

/**
 * 把一条批量结果合并进账号记录（纯函数）。
 *
 * 行为基线 = renderer `applyBackgroundCheckResults`（`store/accounts.ts:3513-3610`）逐字段对齐：
 *   - 失败项 → `status:'error'` + `lastError` + `lastCheckedAt`，**不动 usage**
 *     （失败不能被当成"额度归零"写下去）
 *   - 成功项 → status 三态映射（error / expired / active）；usage **spread 旧值再覆盖**
 *     （⚠️ 与单个检查相反：批量基线用 `...account.usage` + 逐字段 `??` 回落，
 *      因为批量返回的字段比单个检查少，不 spread 会把 percentUsed 之外的字段抹掉）
 *   - email / userId 用 `||`（空串也回落，基线如此），不是 `??`
 */
export function patchAccountWithBatchResult(
  account: Record<string, unknown>,
  item: BatchCheckItem,
  now: number = Date.now()
): Record<string, unknown> {
  if (!item.success) {
    return { ...account, status: 'error', lastError: item.error, lastCheckedAt: now }
  }

  const d = item.data
  // 状态三态映射（基线 store/accounts.ts:3564-3570）
  let status = 'active'
  if (d?.status === 'error') status = 'error'
  else if (d?.status === 'expired') status = 'expired'

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
        managementTarget:
          d.subscription.subscriptionManagementTarget ?? prevSub.managementTarget
      }
    : account.subscription

  return {
    ...account,
    usage: nextUsage,
    subscription: nextSub,
    email: d?.userInfo?.email || account.email,
    userId: d?.userInfo?.userId || account.userId,
    status,
    lastError: d?.errorMessage,
    lastCheckedAt: now
  }
}

/**
 * 把一批（一个 concurrency 切片）的检查结果一次性落盘。
 *
 * 单次 `applyAccountDataMutation` 覆盖 N 个账号 ⇒ 一次 revision 递增 + 一条广播。
 *
 * @returns 实际写进盘的账号数；`0` 表示这一片没有任何账号仍在盘上（全被删了）—— 不写盘、不广播
 * @throws 写盘异常向上抛，调用方决定是否中断
 */
export async function persistBatchCheckResults(items: BatchCheckItem[]): Promise<number> {
  if (items.length === 0) return 0

  const now = Date.now()
  try {
    let applied = 0
    const result = await applyAccountDataMutation((prev) => {
      const accounts = asRecord(prev.accounts)
      if (!accounts) throw new SkipPersist('account-not-found')

      const next: Record<string, unknown> = { ...accounts }
      for (const item of items) {
        const target = asRecord(next[item.id])
        // 盘上已无此账号 = 另一端删了它。跳过，绝不重建。
        if (!target) continue
        next[item.id] = patchAccountWithBatchResult(target, item, now)
        applied++
      }

      // 一个都没命中 ⇒ 中止，避免无意义的 revision 递增 + 广播（见 SkipPersist 注释）
      if (applied === 0) throw new SkipPersist('account-not-found')

      return { ...prev, accounts: next } as AccountsBlob
    })

    if (result.ok) return applied
    throw new Error(
      `[accountService/persistBatchCheckResults] unexpected arbitration result: ${result.code}`
    )
  } catch (e) {
    if (e instanceof SkipPersist) return 0
    throw e
  }
}
