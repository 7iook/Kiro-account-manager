/**
 * 「按 id 给单条账号记录打字段级补丁」的共用收口 · IPC 与 HTTP 面板共用
 *
 * ## 为什么抽出来
 *
 * `persistCheckResult`（刷新额度）与 `persistRefreshResult`（刷新 Token）要做的**盘面动作
 * 完全一致**：过 `applyAccountDataMutation` → 在 mutator 内部重新读盘 → 找到那条记录 →
 * 只覆盖自己那几个键 → 记录不存在就零副作用中止。差别只在「覆盖哪几个键」。
 *
 * 第二个调用方出现时把这段traversal复制一遍，就会有两份「账号不存在怎么办 / 数组形状怎么办 /
 * 仲裁结果异常怎么办」的判断各自漂移（§4.3 SSOT）。故收在这里，调用方只提供纯函数补丁。
 *
 * ## 为什么是「字段级补丁」而不是整条记录覆盖
 *
 * 业务函数的入参是**调用方给的账号快照**，可能已经陈旧（手机端发起时，快照来自那一刻的盘面；
 * 期间桌面端可能改了备注 / 分组 / 标签）。整条覆盖会把这些并发编辑按回旧值。所以在收口的
 * mutator 内部**重新读盘**，只覆盖调用方声明的那几个键。
 *
 * ## 为什么不传 `expectedRevision`
 *
 * 与其它 main 侧自动写路径一致（ProactiveRenewal / IDE 反向同步 / 解封都不传）。
 * 语义是「无仲裁直写」：main 侧刚从上游拿到的值就是权威值，没有"客户端持有的旧快照"可仲裁。
 * 安全性由 mutator 内部**重新读盘 + 只改指定字段**保证 —— 收口的串行锁（state.ts:131）
 * 让这个读-改-写是原子的。
 */

import { applyAccountDataMutation, type AccountsBlob } from './state'

/** 落盘结果 —— 调用方据此决定日志级别，不用 try/catch 猜 */
export type PersistOutcome =
  | { persisted: true; revision: number }
  /**
   * 没写盘，且**这是正确行为**：
   *   - `no-account-id`：调用方没给 id（无法定位记录）
   *   - `account-not-found`：盘上已无此账号（用户刚在另一端删了它）——
   *     **绝不能顺手创建**，那正是 C1/C3 「已删账号复活」的病灶
   */
  | { persisted: false; reason: 'no-account-id' | 'account-not-found' }

/**
 * 中止收口用的私有哨兵。
 *
 * 为什么用抛出而不是「返回 prev 原样」：`applyAccountDataMutation` 无论内容是否变化都会
 * `revision + 1` 并广播（state.ts:186-196）。账号已被删除时返回原样 = 一次**无意义的
 * revision 递增 + 广播**，而每条广播都可能让桌面端整表 reload 一次。mutator 抛错时
 * 收口在 `const next = await mutate(prev)` 处就中断，`storeRef.set` 与广播都不会执行，
 * revision 保持不变 —— 这是零副作用的中止方式。
 *
 * 哨兵**不跨层**：在本文件抛出、在本文件捕获，对外仍是 `PersistOutcome` 返回值语义。
 */
class SkipPersist extends Error {
  constructor(readonly reason: 'account-not-found') {
    super(`skip persist: ${reason}`)
  }
}

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
  return v as Record<string, unknown>
}

/**
 * 把一条账号记录按 `patch` 更新后落盘。
 *
 * @param accountId 账号 id（调用方入参快照里的 id）
 * @param patch 纯函数：收**盘上当前**的记录，返回更新后的记录。绝不要在这里读入参快照的字段，
 *   那正是"整条覆盖把并发编辑按回旧值"的来源；要回退就回退到这个参数里的值。
 * @param label 异常信息前缀，便于定位是哪条写路径（如 `persistRefreshResult`）
 * @throws 写盘异常向上抛 —— 调用方负责处理（绝不在这里吞掉后假装成功）
 */
export async function persistAccountPatch(
  accountId: string | undefined,
  patch: (current: Record<string, unknown>) => Record<string, unknown>,
  label: string
): Promise<PersistOutcome> {
  if (!accountId) return { persisted: false, reason: 'no-account-id' }

  try {
    const result = await applyAccountDataMutation((prev) => {
      // 在收口内部重新读盘：入参快照可能已陈旧（见文件头「字段级补丁」）
      const accountsRaw = prev.accounts

      // 历史数据 / 导入路径可能是数组形状（dto.ts:196 同样两种都吃）。
      // 只支持 Record 会让这批用户静默不落盘 —— 那正是本类修复要治的病。
      if (Array.isArray(accountsRaw)) {
        const idx = accountsRaw.findIndex((e) => asRecord(e)?.id === accountId)
        if (idx < 0) throw new SkipPersist('account-not-found')
        const nextArr = [...accountsRaw]
        nextArr[idx] = patch(asRecord(accountsRaw[idx]) as Record<string, unknown>)
        return { ...prev, accounts: nextArr } as AccountsBlob
      }

      const accounts = asRecord(accountsRaw)
      const target = asRecord(accounts?.[accountId])
      // 盘上已无此账号 = 另一端刚删了它。绝不重建（C1/C3「已删账号复活」）。
      if (!accounts || !target) throw new SkipPersist('account-not-found')

      return {
        ...prev,
        accounts: { ...accounts, [accountId]: patch(target) }
      } as AccountsBlob
    })

    if (result.ok) return { persisted: true, revision: result.revision }
    // 不传 expectedRevision ⇒ 收口不会返回 STALE_REVISION（state.ts:170 的仲裁分支
    // 只在 expectedRevision !== undefined 时进入）。走到这里说明收口语义变了，必须让它响。
    throw new Error(`[accountService/${label}] unexpected arbitration result: ${result.code}`)
  } catch (e) {
    if (e instanceof SkipPersist) return { persisted: false, reason: e.reason }
    throw e
  }
}
