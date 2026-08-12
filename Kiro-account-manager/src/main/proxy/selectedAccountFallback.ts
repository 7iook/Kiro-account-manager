/**
 * 「界面选中账号」的语义:**偏好,不是硬约束**(RCA 2026-08-12)。
 *
 * ## 为什么要有这个文件
 *
 * 原实现(`proxyServer.getAvailableAccount` 单账号分支)把选中项当硬约束:选中号拿不到
 * 就返回 null,注释理由是「避免用户配了只用 A 却静默用 B(可能是死账号或已封号)」。
 * 该考虑在**手动挑号**场景成立,但在长期运行的反代里是灾难 —— 账号会被封、会被换、
 * id 会随重新导入而漂移,而池里明明有健康号,却因为选中项指向一个过期 id 就整体拒绝服务。
 *
 * 生产实证(2026-08-12,10290 行日志):
 * ```
 *   185x  Selected account d0520f20-… not found in pool (pool size=1)
 *    92x  decision=giveup · reason=selected-account-missing
 *     1x  一轮挂起结束 · 持续 77.6 分钟 · 原因=account-blocked   ← 挂起本身是好的
 * ```
 * `pool size=1` 说明池里有一个健康号可用,但因为选中项是另一个已不存在的 id,
 * 92 次请求被直接 giveup → 客户端收 503 HOLD_TIMEOUT。
 * **挂起功能从未损坏(它挂了 77.6 分钟);损坏的是「拿不到选中号就拒绝服务」。**
 *
 * ## 修正后的语义
 *
 * ```
 *   选中号在池里且可用   → 用它                    (尊重偏好)
 *   选中号拿不到         → 池里还有别的可用号?
 *                            ├ 有 → 用那个 + 告警   (服务优先)
 *                            └ 无 → 交回调用方按池状态决定挂起/报错
 * ```
 *
 * 「用户配了只用 A 却用了 B」这个担心用**告警**表达即可,不该用拒绝服务来强制 ——
 * 拒绝服务的代价(整个反代不可用)远大于它要防的问题(用了另一个自己池里的号)。
 *
 * ## 与挂起门闸的分工
 *
 * 本模块只回答「能不能拿到号」。拿不到时**不做**挂起/报错决策 —— 那是
 * `holdDecision.classifyNoAccountHold` 的职责。两者混在一起正是前两次修错的原因:
 * 我把「选中号不在池」塞进挂起判据,于是它压过了「有号被封 → 挂起」这个正确分支。
 */

export interface SelectedPreferenceInput<T> {
  /** UI 选中的账号 id(单账号模式;空/未设时视为无偏好) */
  selectedId: string | undefined
  /** 按 id 取号(总表视角,可能返回被封/冷却的号) */
  getById: (id: string) => T | null
  /** 该号此刻是否真的可用(未封禁、未超额、不在冷却) */
  isUsable: (acc: T) => boolean
  /** 池里任意一个当前可用的号(无则 null) */
  pickAnyUsable: () => T | null
}

export type SelectedPreferenceOutcome<T> =
  /** 用选中号(偏好命中) */
  | { kind: 'selected'; account: T }
  /** 选中号拿不到,回退到池里另一个可用号 —— 需告警,但**必须服务** */
  | { kind: 'fallback'; account: T; why: 'missing' | 'unusable' }
  /** 池里一个可用号都没有 → 交回调用方走挂起/报错决策 */
  | { kind: 'none'; why: 'missing' | 'unusable' | 'no-preference' }

/**
 * 按「偏好优先、服务优先」解析该用哪个号。
 *
 * 纯函数(依赖以回调注入),便于穷举单测 —— 前两次修错都是因为判据内联在
 * 800 行的转发方法里,只能靠端到端复现。
 */
export function resolveSelectedPreference<T>(
  input: SelectedPreferenceInput<T>
): SelectedPreferenceOutcome<T> {
  const { selectedId, getById, isUsable, pickAnyUsable } = input

  if (!selectedId) {
    const any = pickAnyUsable()
    return any && isUsable(any)
      ? { kind: 'selected', account: any }
      : { kind: 'none', why: 'no-preference' }
  }

  const selected = getById(selectedId)
  if (selected && isUsable(selected)) {
    return { kind: 'selected', account: selected }
  }

  // 区分两种拿不到:id 根本不存在(配置漂移) vs 存在但当前不可用(被封/超额/冷却)。
  // 两者都回退,但告警文案不同 —— 前者要提示用户去同步/重选,后者是运行期常态。
  const why: 'missing' | 'unusable' = selected ? 'unusable' : 'missing'

  const alternative = pickAnyUsable()
  // 候选选择器可能只负责排序/初筛；安全边界仍以同一个 isUsable 判据为准。
  // 尤其 API Key 账号绑定必须在这里二次确认，不能信任 pickAnyUsable 的返回值。
  if (alternative && isUsable(alternative)) {
    return { kind: 'fallback', account: alternative, why }
  }

  return { kind: 'none', why }
}
