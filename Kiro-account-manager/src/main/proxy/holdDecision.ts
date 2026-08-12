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
 * ## 本轮修正的三个缺陷(RCA 2026-08-11 · 生产日志 137 次误挂起)
 *
 * 现场:界面选中账号 `30475c44-…` 不在反代池 → `getAccount()` 返回 null → 严格模式拒绝
 * fallback → 一次上游请求都没发 → `preBodyError = null` → 旧实现
 * `if (!lastPreBodyError) return 'hold'` 命中 → 挂起,界面显示「账号封禁或额度上限」。
 *
 * ① **语义混淆**:旧实现把「无 attempt」一律当成账号问题。但两种成因的正确处置相反:
 *    - 池空 / 池内号被封 → 挂起等换号**有意义**(号可能恢复,或用户会补号)
 *    - UI 指定号不在池 → **配置错误**,没有任何机制会把不存在的 id 变进池里 ⇒ 挂起 = 永久死等
 *    决定性证据:19:56:45 池已热更新到 size=2,同一秒仍报 `not found in pool (pool size=2)`
 *    ⇒ 不是同步延迟,该 id 从来不在池里。
 * ② **原因失真**:`pool-empty` 这一档同时覆盖「池真空」与「指定号不在池」,界面文案把
 *    用户排查方向引向账号状态,而真问题在配置。故新增 `selected-account-missing`。
 * ③ **开关失效**:该挂起路径不检查 `holdWhenNoAccount`,用户关掉门闸后仍被挂起。
 *    门闸开关是用户可见承诺 —— 关了就不该挂,故 `holdEnabled` 成为第一道判据。
 */

/** 挂起原因(与 holdGate.HoldReason 同口径,新增 selected-account-missing)。 */
export type NoAccountHoldReason =
  /** 池内有号被封禁 / 额度耗尽 —— 挂起等其恢复或换号 */
  | 'account-blocked'
  /** 最近的 pre-body 错误是账号级授权失效 —— 挂起等换号 */
  | 'account-auth-failure'
  /** 池空 / 池未同步 —— 挂起等补号 */
  | 'pool-empty'
  /** UI 指定的账号不在池里 —— **配置错误**,立即报错(挂起会永久死等) */
  | 'selected-account-missing'
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
   * 指定的那个 id 在**账号总表**里是否存在(`accountPool.getAccount(id) !== null`)。
   *
   * ## 为什么必须与 `selectedAccountInPool` 分开(RCA 2026-08-12 回归修复)
   * 7c63d4c 只用「是否在池里」判定配置错误,而账号**被上游封禁 / 额度耗尽时也会不在池**
   * (实测日志:`lazy-refill: N 个账号未入反代池 —— xxx: 已被上游拒绝([TEMPORARILY_SUSPENDED])`)。
   * 于是「账号被封」被误判成「用户配错 id」→ giveup,而这恰恰是门闸最该挂起的场景。
   * 用户表现:挂起从 2 小时退化成「立刻 503 + 客户端重试 10 次 ≈ 20 分钟后彻底失败」。
   *
   * 判据分工:
   *   - 总表里**不存在** → 配置错误(残留旧 id / 已删除账号)→ 立即报错
   *   - 总表里存在但不在可用池 → 账号级不可用(封禁/超额/冷却)→ 挂起等恢复
   */
  selectedAccountExists: boolean
  /** 指定的那个号当前是否在**可用池**里(排除封禁/超额/冷却后仍可选) */
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
    selectedAccountExists, selectedAccountInPool, poolHasBlockedAccount, lastPreBodyError
  } = input
  void selectedAccountInPool  // 保留入参用于日志归因;判定只看「总表是否存在」(见字段注释)

  // ③ 开关优先:用户关掉门闸就是不要挂起行为,任何分支都不得越过它。
  if (!holdEnabled) {
    return {
      action: 'giveup',
      reason: 'hold-disabled',
      clientMessage: 'No account available (hold gate disabled)'
    }
  }

  // ① 指定号在**账号总表里都不存在** —— 必须先于 account-blocked 判定。
  // 现场组合正是「池里那个号被封(blocked=true) + UI 选的是另一个不存在的 id」:
  // 若先命中 account-blocked 就继续挂起,用户永远等不到,且原因仍然说错。
  //
  // ⚠️ 判据是「总表不存在」而**不是**「不在可用池」(RCA 2026-08-12 回归):
  // 被封 / 超额的号也不在可用池,但它是账号问题,挂起等恢复才对。
  const selectedId = selectedAccountIds[0]
  if (selectedId && !selectedAccountExists) {
    return {
      action: 'giveup',
      reason: 'selected-account-missing',
      clientMessage:
        `界面选中的账号不在反代池中(id=${selectedId},当前池 ${poolSize} 个号)。` +
        `这是配置问题而非账号问题 —— 挂起也等不到它出现。` +
        `请点「同步账号」或在界面重新选择一个池内账号。`
    }
  }

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
