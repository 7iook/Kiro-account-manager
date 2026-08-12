/**
 * 无号可用时的挂起决策(SSOT)。
 *
 * ## 为什么抽成纯函数
 *
 * 原判据内联在 `ProxyServer.decideHoldAction` + 调用点的 `holdReason` 计算里,分两处:
 * 一处决定「挂不挂」,另一处决定「界面显示什么原因」。两者用同一组变量各算一遍,
 * 结果 2026-08-11 现场出现了「决策挂起、原因说成账号封禁、真因其实是配置错误」的三方不一致。
 * 收口成一个函数后,`action` / `reason` / `clientMessage` 由同一次判定产出,
 * 结构上不可能再各说各话;且可脱离 http/Electron 单测。
 *
 * ## 已修正的缺陷
 *
 * ① **开关失效**:该挂起路径曾不检查 `holdWhenNoAccount`,用户关掉门闸后仍被挂起。
 *    门闸开关是用户可见承诺 —— 关了就不该挂,故 `holdEnabled` 是第一道判据。
 * ② **决策与文案分裂**:「挂不挂」与「界面显示什么原因」曾分两处各算一遍同一组变量,
 *    出现过「决策挂起、原因说成账号封禁、真因其实是别的」的三方不一致。现在同一次判定
 *    产出 action/reason/clientMessage,结构上不可能再各说各话。
 *
 * ## 一条走过的弯路(2026-08-12,两次修错后回退)
 *
 * 曾在这里加过「UI 选中号不在池 → 判为配置错误、立即报错」,并让它**优先于**
 * account-blocked。结果它压过了「有号被封 → 挂起」这条正确分支:生产实测 92 次请求
 * 因此直接 giveup(客户端收 503),而同期门闸本身工作正常(挂了 77.6 分钟)。
 *
 * 根本错误是**分层**:「拿不到选中号」是选号阶段的问题,不是挂起判据该回答的。
 * 选中项只是**偏好** —— 拿不到就回退到池内其它可用号并告警
 * (见 `selectedAccountFallback.ts`)。只有池里一个可用号都没有时才走到本函数,
 * 那时该看的只有池状态,与「选中项是谁」无关。
 */

/** 挂起原因(与 holdGate.HoldReason 同口径)。 */
export type NoAccountHoldReason =
  /** 池内有号被封禁 / 额度耗尽 —— 挂起等其恢复或换号 */
  | 'account-blocked'
  /** 最近的 pre-body 错误是账号级授权失效 —— 挂起等换号 */
  | 'account-auth-failure'
  /** 池空 / 池未同步 —— 挂起等补号 */
  | 'pool-empty'
  /** 有 attempt 且是非账号级瞬时错误(429/5xx/400/网络)—— 立即报错 */
  | 'transient-error'
  /** 门闸开关关闭 —— 不挂起 */
  | 'hold-disabled'

export interface NoAccountHoldInput {
  /** `config.holdWhenNoAccount === true` */
  holdEnabled: boolean
  /** 当前反代池大小 */
  poolSize: number
  /** `config.selectedAccountIds`(单账号模式下 UI 指定的号) */
  selectedAccountIds: string[]
  /**
   * 选中号是否在**可用池**里。**仅用于日志归因,不参与判定**。
   *
   * 判定刻意不看它:选号阶段已由 `selectedAccountFallback` 处理过「选中号拿不到就回退」,
   * 能走到本函数说明池里一个可用号都没有 —— 此时「选中项是谁」已无关。
   * 曾用它做判定并优先于 account-blocked,导致被封账号被误判为配置错误(见文件头「弯路」)。
   */
  selectedAccountInPool: boolean
  /** `accountPool.hasBlockedAccount()` */
  poolHasBlockedAccount: boolean
  /** 本请求最近一次 pre-body 错误(null = 一次上游请求都没发出) */
  lastPreBodyError: Error | null
}

export interface NoAccountHoldDecision {
  action: 'hold' | 'giveup'
  reason: NoAccountHoldReason
  /** giveup 时报给客户端的原因(hold 时为 undefined) —— 必须点名真因 + 可执行的下一步 */
  clientMessage?: string
}

/**
 * 账号级授权失效判据(从 ProxyServer.isAccountLevelAuthFailure 平移,保持同一口径)。
 *
 * 只认「明确的密钥失效」:裸 401 可能是别的短暂问题,不算(RCA 2026-08-02/03:
 * 判据放宽会让瞬时 429/5xx 也被挂起 10-20 分钟)。
 */
export function isAccountLevelAuthFailure(err: Error | null): boolean {
  if (!err) return false
  const msg = err.message || ''
  if (/InvalidTokenException|UnauthorizedException/i.test(msg)) return true
  if (/\b401\b/.test(msg) && /revoked|expired|invalid credentials|Bad credentials/i.test(msg)) return true
  return false
}

export function classifyNoAccountHold(input: NoAccountHoldInput): NoAccountHoldDecision {
  const {
    holdEnabled, poolSize, selectedAccountIds,
    selectedAccountInPool, poolHasBlockedAccount, lastPreBodyError
  } = input

  // ③ 开关优先:用户关掉门闸就是不要挂起行为,任何分支都不得越过它。
  if (!holdEnabled) {
    return {
      action: 'giveup',
      reason: 'hold-disabled',
      clientMessage: 'No account available (hold gate disabled)'
    }
  }

  // ⚠️ 这里**刻意不判定**「选中号不在池 → 配置错误」(见文件头「弯路」)。
  // 能走到本函数 = 池里一个可用号都没有,此时只该看池状态。
  // 以下三个入参仅供日志归因,不参与判定。
  void selectedAccountInPool
  void selectedAccountIds
  void poolSize

  // 池内有号被封禁 / 额度耗尽 → 挂起等恢复或换号(门闸原始设计意图)
  if (poolHasBlockedAccount) {
    return { action: 'hold', reason: 'account-blocked' }
  }

  // 账号级授权失效 → 挂起等换号
  if (isAccountLevelAuthFailure(lastPreBodyError)) {
    return { action: 'hold', reason: 'account-auth-failure' }
  }

  // 有 attempt 但是非账号级瞬时错误(429/5xx/400/网络)→ 立即报错。
  // 用户明确要求:「429 只需要重试,不需要挂起」(RCA 2026-08-03)。
  if (lastPreBodyError) {
    return {
      action: 'giveup',
      reason: 'transient-error',
      clientMessage: lastPreBodyError.message
    }
  }

  // 无 attempt 且指定号正常/未指定 → 池空或池未同步 → 挂起等补号
  return { action: 'hold', reason: 'pool-empty' }
}
