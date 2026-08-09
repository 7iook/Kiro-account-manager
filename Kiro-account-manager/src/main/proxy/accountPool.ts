// 多账号智能轮询管理器
// 参考 Kiro Gateway 的 Circuit Breaker + Sticky + 指数退避 + 概率重试机制
import type { ProxyAccount, AccountStats } from './types'
import { SmoothWeightedRoundRobin } from '../utils/smoothWeightedRoundRobin'

// 错误类型分类（决定 failover 策略）
export enum ErrorType {
  FATAL = 'fatal',           // 请求本身有问题 → 直接返回客户端，不切号
  RECOVERABLE = 'recoverable' // 账号问题 → 切换到下一个账号
}

// 根据 HTTP 状态码和错误原因分类错误
/**
 * 从错误消息里提取 HTTP 状态码 —— 只认 HTTP 语义位置,绝不裸抓「第一个 3 位数字」。
 *
 * 状态码提取与 {@link classifyError} 同属一个语义域(状态码 → 处置),故收口在这里(SSOT):
 * 此前 proxyServer 有 4 处各自写 `error.message.match(/(\d{3})/)`,散落且判据一致地错。
 *
 * RCA 2026-08-04 hold-gate-429-quota-false-positive · 旧实现会把任意 3 位数字当状态码:
 *   - `Connect Timeout Error (... kiro.dev:443, timeout: 10000ms)` → 抓成 443(端口号)
 *   - `Payload size: 402913 bytes`                                → 抓成 402 → 被判额度耗尽
 *     → hasBlockedAccount → HoldGate 挂起后续请求(账号其实完全正常)
 *   - `read ECONNRESET errno -4077`                               → 抓成 407
 *
 * 认可的位置(kiroApi 的抛错格式 + 常见 SDK 措辞):
 *   `API error NNN:` / `Auth error NNN:` / `status=NNN` / `statusCode: NNN` / `HTTP NNN`
 *
 * @returns 100-599 范围内的状态码;提取不到返回 undefined(调用方按 RECOVERABLE 兜底)
 */
export function extractHttpStatusCode(message: string): number | undefined {
  if (!message) return undefined
  const m = message.match(/\b(?:API|Auth) error (\d{3})\b/)
    || message.match(/\bstatus(?:Code)?\s*[=:]\s*(\d{3})\b/i)
    || message.match(/\bHTTP\/?\s*(\d{3})\b/i)
  if (!m) return undefined
  const code = parseInt(m[1], 10)
  return code >= 100 && code <= 599 ? code : undefined
}

export function classifyError(statusCode: number, reason?: string): ErrorType {
  // RECOVERABLE: 配额/计费问题
  if (statusCode === 402) return ErrorType.RECOVERABLE
  // RECOVERABLE: Token 过期/无效
  if (statusCode === 403) return ErrorType.RECOVERABLE
  // RECOVERABLE: 限流
  if (statusCode === 429) return ErrorType.RECOVERABLE
  // 400: 根据原因细分
  if (statusCode === 400) {
    // 上下文超限 → 所有账号都会失败
    if (reason === 'CONTENT_LENGTH_EXCEEDS_THRESHOLD') return ErrorType.FATAL
    return ErrorType.FATAL
  }
  // 422: 请求格式错误
  if (statusCode === 422) return ErrorType.FATAL
  // 5xx: 服务端错误
  if (statusCode >= 500) return ErrorType.FATAL
  return ErrorType.FATAL
}

export interface AccountPoolConfig {
  baseCooldownMs: number      // 基础冷却时间（指数退避的基数）
  maxBackoffMultiplier: number // 最大退避倍数
  quotaResetMs: number        // 配额耗尽冷却时间
  probabilisticRetryChance: number // 概率重试几率（0-1）
}

const DEFAULT_CONFIG: AccountPoolConfig = {
  baseCooldownMs: 60000,        // 60s 基础冷却
  maxBackoffMultiplier: 1440,   // 最大 1440 倍 = 24h
  quotaResetMs: 3600000,        // 1h 配额重置
  probabilisticRetryChance: 0.1 // 10% 概率重试
}

export type AccountSelectionStrategy = 'round-robin' | 'sticky' | 'weighted'

export class AccountPool {
  private accounts: Map<string, ProxyAccount> = new Map()
  private accountStats: Map<string, AccountStats> = new Map()
  private currentIndex: number = 0
  private config: AccountPoolConfig
  // 默认 round-robin: 每次成功后指针前进 (满足负载均衡期望)
  // sticky: 一个账号成功就粘住 (保留 prompt cache 命中)
  // weighted: SWRR 加权轮询 (按 account.weight 字段按比例分流)
  private strategy: AccountSelectionStrategy = 'round-robin'
  // SWRR instance (仅 strategy='weighted' 使用，持久化累积 credit)
  private swrr: SmoothWeightedRoundRobin<ProxyAccount> = new SmoothWeightedRoundRobin({
    getId: (a) => a.id,
    getWeight: (a) => (typeof a.weight === 'number' ? a.weight : 100)
  })
  // 可用性变化监听器(HoldGate.tryResume 订阅):仅当池可用号数 0→>0 才触发(去抖)。
  // 见 .archive/2026-07-28/hold-gate-blocking/hold-gate-blocking-design.md §5 A4 + availability-paths.md
  private availabilityListener: (() => void) | null = null

  constructor(config: Partial<AccountPoolConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 注入可用性变化监听器(HoldGate 用它实现"事件即时唤醒")。覆盖式:后注入的替换前者。
   * 传 null 可解绑。注意:配额时间衰减恢复(isQuotaExhausted 时间到点)是纯被动、无写方法
   * 触发,不在本出口覆盖范围内 —— 那部分由 HoldGate 内部低频轮询兜底(方案 §5 A4)。
   */
  setAvailabilityListener(listener: (() => void) | null): void {
    this.availabilityListener = listener
  }

  /**
   * 在"可能让池从全挂→出现可用号"的写入路径中包裹此方法:
   * 记录写入前 availableCount,执行 mutate,再比较写入后;仅当 0→>0 才 emit(去抖,
   * 避免无关字段刷新 / 1→2 等非关键变化频繁唤醒 HoldGate)。
   * HoldGate.tryResume 内部还会再查一次池状态,幂等叠加保险。
   */
  private notifyIfBecameAvailable(mutate: () => void): void {
    if (!this.availabilityListener) {
      mutate()
      return
    }
    const before = this.availableCount
    mutate()
    if (before === 0 && this.availableCount > 0) {
      this.availabilityListener()
    }
  }

  // 切换账号选择策略
  setStrategy(strategy: AccountSelectionStrategy): void {
    if (this.strategy !== strategy) {
      console.log(`[AccountPool] Strategy changed: ${this.strategy} → ${strategy}`)
      this.strategy = strategy
    }
  }

  getStrategy(): AccountSelectionStrategy {
    return this.strategy
  }

  // 添加账号
  // 如果传入的 account 已带 suspended 字段（启动复原场景），保留其 suspended 状态
  addAccount(account: ProxyAccount): void {
    const suspended = this.isSuspended(account)
    // 已在池的账号被重复 addAccount = 一次**全量重同步**（启动 / 改配置 / 面板 syncPool /
    // 热切换，共 6 个生产调用点）。入参来自盘上映射 `toProxyAccountShared`，它**不产出任何
    // quota 字段** —— 于是重置式写入会把运行期积累的额度状态抹回 undefined。
    //
    // 后果是「改完就静默失效」那一类：真实额度刚喂进池，下一次同步就没了，
    // isQuotaExhausted 的第三条判据重新变成永远为 false，本轮交付等于没做。
    // 402 打的 quotaExhaustedAt 同族同理 —— 抹掉它等于「重同步一下就把耗尽的号放回轮询」。
    //
    // 用 `??` 而非无条件保留：启动复原时入参**自带** quota 字段（那是盘上的权威值），
    // 必须以入参为准；只有入参没说的时候才保留池内既有值。
    // 与 upsertAccount(:201-219) 剔除运行期状态字段是同一意图，这里是它的 addAccount 侧对偶。
    const prev = this.accounts.get(account.id)
    this.notifyIfBecameAvailable(() => {
      this.accounts.set(account.id, {
        ...account,
        quotaUsed: account.quotaUsed ?? prev?.quotaUsed,
        quotaLimit: account.quotaLimit ?? prev?.quotaLimit,
        quotaResetAt: account.quotaResetAt ?? prev?.quotaResetAt,
        quotaUpdatedAt: account.quotaUpdatedAt ?? prev?.quotaUpdatedAt,
        quotaExhaustedAt: account.quotaExhaustedAt ?? prev?.quotaExhaustedAt,
        isAvailable: !suspended,
        requestCount: 0,
        errorCount: 0,
        lastUsed: 0
      })
    })
    this.accountStats.set(account.id, {
      requests: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      errors: 0,
      lastUsed: 0,
      avgResponseTime: 0,
      totalResponseTime: 0
    })
    if (suspended) {
      console.warn(`[AccountPool] Added SUSPENDED account: ${account.email || account.id} (${account.suspendReason})`)
    } else {
      console.log(`[AccountPool] Added account: ${account.email || account.id}`)
    }
  }

  // 移除账号
  removeAccount(accountId: string): void {
    this.accounts.delete(accountId)
    this.accountStats.delete(accountId)
    this.swrr.forget(accountId)
    console.log(`[AccountPool] Removed account: ${accountId}`)
  }

  // 更新账号
  updateAccount(accountId: string, updates: Partial<ProxyAccount>): void {
    const account = this.accounts.get(accountId)
    if (!account) return
    // 仅当 updates 触及可用性判定字段时,才走去抖通知包裹(避免统计/lastUsed 等无关字段刷新误触发)。
    // 可用性字段见 availability-paths.md §0:isAvailable / suspendedAt / quotaExhaustedAt / quotaResetAt / expiresAt / refreshToken
    const AVAILABILITY_FIELDS: Array<keyof ProxyAccount> = [
      'isAvailable', 'suspendedAt', 'quotaExhaustedAt', 'quotaResetAt', 'expiresAt', 'refreshToken'
    ]
    const touchesAvailability = AVAILABILITY_FIELDS.some(f => f in updates)
    const apply = (): void => {
      this.accounts.set(accountId, { ...account, ...updates })
    }
    if (touchesAvailability) {
      this.notifyIfBecameAvailable(apply)
    } else {
      apply()
    }
  }

  // 热切换入池:已在池只覆盖凭据类字段,不在池等价 addAccount
  // 为何不能直接 addAccount:它是重置式——按入参重算 isAvailable(前端 mapper 不带
  // suspendedAt ⇒ 算出 true)并清零 errorCount/requestCount/统计,于是“切一下账号”会静默
  // 解除运行期风控封禁,并让 proxy-set-active-account 的 ACCOUNT_NOT_AVAILABLE 守卫失效。
  // 详见 RCA §4.2b:.archive/2026-07-28/proxy-hot-switch-single-account/
  // @returns 'added' 新入池 | 'updated' 已在池仅刷新凭据
  upsertAccount(account: ProxyAccount): 'added' | 'updated' {
    if (!this.accounts.has(account.id)) {
      this.addAccount(account)
      return 'added'
    }
    // 剔除运行期状态字段,只把凭据/路由类字段覆盖进去
    const {
      isAvailable: _isAvailable,
      suspendedAt: _suspendedAt,
      suspendReason: _suspendReason,
      suspendMessage: _suspendMessage,
      requestCount: _requestCount,
      errorCount: _errorCount,
      lastUsed: _lastUsed,
      ...mutable
    } = account
    this.updateAccount(account.id, mutable)
    console.log(`[AccountPool] Refreshed credentials for: ${account.email || account.id}`)
    return 'updated'
  }

  // 热切换:强制下一次请求使用指定账号(round-robin 模式下"从此账号开始轮")
  // 详见 2026-07-23 hot-swap-accounts 决策卡 §3
  // @returns true 切换成功;false 账号不在池内
  setActiveAccount(accountId: string): boolean {
    const list = Array.from(this.accounts.keys())
    const idx = list.indexOf(accountId)
    if (idx < 0) return false
    this.currentIndex = idx
    // SWRR credit 状态重置,避免残留倾斜(仅 weighted 策略生效,其它策略无害)
    this.swrr.reset()
    return true
  }

  // 获取下一个可用账号（粘滞 + 断路器 + 指数退避 + 概率重试）
  getNextAccount(excludeIds?: Set<string>): ProxyAccount | null {
    const accountList = Array.from(this.accounts.values())
    if (accountList.length === 0) {
      return null
    }

    // 单账号特殊处理：绕过断路器，直接返回（让用户看到真实 API 错误）
    if (accountList.length === 1) {
      const account = accountList[0]
      if (excludeIds?.has(account.id)) return null
      return account
    }

    const now = Date.now()
    // 从当前粘滞索引开始遍历所有账号
    const startIndex = this.currentIndex

    for (let i = 0; i < accountList.length; i++) {
      const idx = (startIndex + i) % accountList.length
      const account = accountList[idx]

      // 跳过当前请求已试过的账号
      if (excludeIds?.has(account.id)) continue

      // 检查账号是否可用（含断路器状态）
      if (this.isAccountAvailable(account, now)) {
        return account
      }
    }

    // 没有可用账号：检查是否全部因配额耗尽
    const candidates = excludeIds
      ? accountList.filter(a => !excludeIds.has(a.id))
      : accountList
    const allExhausted = candidates.length > 0 && candidates.every(a => this.isQuotaExhausted(a, now))
    if (allExhausted) {
      console.log(`[AccountPool] All ${candidates.length} accounts quota exhausted, no fallback available`)
      return null
    }

    // 还有非配额原因不可用的账号，返回冷却时间最短的
    const nonExhausted = candidates.filter(a => !this.isQuotaExhausted(a, now))
    return this.getAccountWithShortestCooldown(nonExhausted, now)
  }

  // 获取特定账号
  getAccount(accountId: string): ProxyAccount | null {
    return this.accounts.get(accountId) || null
  }

  // 获取下一个可用账号（排除指定账号；支持单 ID 或 ID 集合）
  // 集合形式用于「请求级累计已试账号」，避免重试时循环命中已经失败过的账号
  getNextAvailableAccount(exclude: string | Set<string>): ProxyAccount | null {
    const excludeSet = typeof exclude === 'string' ? new Set([exclude]) : exclude
    const accountList = Array.from(this.accounts.values())
    if (accountList.length === 0) return null

    const now = Date.now()

    // 尝试找到一个可用的账号（排除指定账号）
    for (const account of accountList) {
      if (!excludeSet.has(account.id) && this.isAccountAvailable(account, now)) {
        return account
      }
    }

    // 没有立即可用的账号，返回冷却时间最短的（排除指定账号）
    const otherAccounts = accountList.filter(a => !excludeSet.has(a.id))
    if (otherAccounts.length === 0) return null
    return this.getAccountWithShortestCooldown(otherAccounts, now)
  }

  // 获取所有账号
  getAllAccounts(): ProxyAccount[] {
    return Array.from(this.accounts.values())
  }

  // 检查账号是否可用（断路器 + 指数退避 + 概率重试）
  // allowProbabilisticRetry=false 用于统计/计数场景：冷却中一律视为不可用，
  // 避免 Math.random() 让 availableCount / getQuotaStatus 的数字来回抖动
  private isAccountAvailable(account: ProxyAccount, now: number, allowProbabilisticRetry = true): boolean {
    // 检查是否被 Kiro 后端封禁（需人工解封）
    if (this.isSuspended(account)) {
      return false
    }

    // 检查配额是否耗尽
    if (this.isQuotaExhausted(account, now)) {
      return false
    }

    // 检查 token 是否过期
    // - 无 refreshToken 时直接判为不可用（无法刷新）
    // - 有 refreshToken 时让账号通过 —— proxyServer.getAvailableAccount 会检测
    //   isTokenExpiringSoon 并主动调用 refreshToken；若刷新失败会通过 markNeedsRefresh
    //   设置 isAvailable=false，下次循环再被本函数 line 210 跳过，形成闭环
    if (account.expiresAt && account.expiresAt < now && !account.refreshToken) {
      return false
    }

    if (account.isAvailable === false) {
      return false
    }

    // 断路器检查：指数退避 + 概率重试
    const failures = account.errorCount || 0
    if (failures > 0 && account.lastUsed) {
      const timeSinceFailure = now - account.lastUsed
      // 指数退避：base * 2^(failures-1)，封顶为 maxBackoffMultiplier
      const backoffMultiplier = Math.min(Math.pow(2, failures - 1), this.config.maxBackoffMultiplier)
      const effectiveCooldown = this.config.baseCooldownMs * backoffMultiplier

      if (timeSinceFailure < effectiveCooldown) {
        // 统计场景：冷却中确定性地视为不可用
        if (!allowProbabilisticRetry) {
          return false
        }
        // 未超出冷却期，用概率重试
        if (Math.random() > this.config.probabilisticRetryChance) {
          return false
        }
        console.log(`[AccountPool] Probabilistic retry for ${account.email || account.id} (failures=${failures}, cooldown=${Math.round(effectiveCooldown / 1000)}s)`)
      }
      // else: 冷却期已过，Half-Open 状态，允许重试
    }

    return true
  }

  // 检查账号是否被长期封禁（TEMPORARILY_SUSPENDED / AccountSuspendedException 等风控触发）
  // 不同于临时 errorCount 冷却，需要人工解封或调用 clearSuspended
  isSuspended(account: ProxyAccount): boolean {
    return typeof account.suspendedAt === 'number' && account.suspendedAt > 0
  }

  // 标记账号为被封禁状态，账号池会持续跳过该账号直到 clearSuspended
  markSuspended(accountId: string, reason: string, message?: string): boolean {
    const account = this.accounts.get(accountId)
    if (!account) return false
    if (this.isSuspended(account) && account.suspendReason === reason) {
      // 已标记过同样原因，不重复记录
      return false
    }
    this.accounts.set(accountId, {
      ...account,
      suspendedAt: Date.now(),
      suspendReason: reason,
      suspendMessage: message,
      isAvailable: false
    })
    console.warn(`[AccountPool] Account ${account.email || accountId} SUSPENDED (${reason})`)
    return true
  }

  // 解除账号封禁标记（供手动重置或检测到被解封后调用）
  clearSuspended(accountId: string): void {
    const account = this.accounts.get(accountId)
    if (!account || !this.isSuspended(account)) return
    this.notifyIfBecameAvailable(() => {
      this.accounts.set(accountId, {
        ...account,
        suspendedAt: undefined,
        suspendReason: undefined,
        suspendMessage: undefined,
        isAvailable: true,
        errorCount: 0
      })
    })
    console.log(`[AccountPool] Account ${account.email || accountId} unsuspended`)
  }

  // 检查账号配额是否耗尽
  isQuotaExhausted(account: ProxyAccount, now: number = Date.now()): boolean {
    // 如果配额已重置（过了重置时间），不再视为耗尽
    if (account.quotaResetAt && account.quotaResetAt <= now) {
      return false
    }
    // 有明确的耗尽标记
    if (account.quotaExhaustedAt && account.quotaExhaustedAt > 0) {
      return true
    }
    // 有配额数据且已用尽
    if (account.quotaLimit && account.quotaLimit > 0 && (account.quotaUsed ?? 0) >= account.quotaLimit) {
      return true
    }
    return false
  }

  /**
   * 池中是否存在「真·长期不可用」的账号 —— 挂起门闸(HoldGate)的权威判据。
   *
   * 只认两种池状态(需要人工换号 / 等配额自然恢复,挂起等放行才有意义):
   *   - isSuspended:被 Kiro 后端封禁(suspendedAt > 0),需人工解封或换号
   *   - isQuotaExhausted:额度耗尽(quotaExhaustedAt / quotaUsed >= quotaLimit),需等 quotaResetAt
   *
   * 明确**不认** errorCount 退避冷却(429 限流 / 上游 5xx 等瞬时错误触发)——
   * 那类失败重试几秒就好,挂起 10-20 分钟纯属误伤(RCA 2026-08-02 hold-gate-false-positive)。
   *
   * @returns true = 确有账号被封禁/额度耗尽 → 挂起请求等换号才合理
   */
  hasBlockedAccount(now: number = Date.now()): boolean {
    for (const account of this.accounts.values()) {
      if (this.isSuspended(account) || this.isQuotaExhausted(account, now)) return true
    }
    return false
  }

  /**
   * 解释「池里哪些号被判长期不可用、各自为什么」—— HoldGate 挂起日志的可观测性出口。
   *
   * 与 {@link hasBlockedAccount} 共用同一套判据(SSOT),保证日志说的和决策做的是同一件事。
   *
   * RCA 2026-08-04:此前 holdGate.ts 一行日志都没有、决策日志又只在 HOLD_DEBUG=1 下走
   * console(不进 proxyLogger),用户报「账号明明正常却被闸门拦住」时后端查不到任何现场,
   * 只能靠翻源码反推。挂起是用户可感知的强干预(请求被冻结等换号),必须能自证原因。
   *
   * @returns 形如 `['a@x.com: quotaExhausted(markedAt=... resetAt=...)']`;无则空数组
   */
  describeBlockedAccounts(now: number = Date.now()): string[] {
    const out: string[] = []
    for (const a of this.accounts.values()) {
      const who = a.email || a.id?.slice(0, 8) || '?'
      if (this.isSuspended(a)) {
        out.push(`${who}: suspended(${a.suspendReason || '?'})`)
        continue
      }
      if (this.isQuotaExhausted(a, now)) {
        // 区分两种来源:真实额度数据用尽(权威) vs 仅有耗尽标记(可能是误标)
        const byRealData = !!a.quotaLimit && a.quotaLimit > 0 && (a.quotaUsed ?? 0) >= a.quotaLimit
        const why = byRealData
          ? `quotaUsed=${a.quotaUsed}/${a.quotaLimit}`
          : `markedAt=${a.quotaExhaustedAt ? new Date(a.quotaExhaustedAt).toISOString() : '?'}` +
            ` resetAt=${a.quotaResetAt ? new Date(a.quotaResetAt).toISOString() : 'none'}`
        out.push(`${who}: quotaExhausted(${why})`)
      }
    }
    return out
  }

  // 获取冷却时间最短的账号
  private getAccountWithShortestCooldown(accounts: ProxyAccount[], now: number): ProxyAccount | null {
    let bestAccount: ProxyAccount | null = null
    let shortestWait = Infinity

    for (const account of accounts) {
      const cooldownUntil = account.cooldownUntil || 0
      const wait = Math.max(0, cooldownUntil - now)
      
      if (wait < shortestWait) {
        shortestWait = wait
        bestAccount = account
      }
    }

    return bestAccount
  }

  // 记录请求成功（重置断路器 + 清除额度耗尽误标 + 粘滞到当前账号）
  recordSuccess(accountId: string, tokens: number = 0): void {
    const account = this.accounts.get(accountId)
    if (account) {
      // 成功 = 上游确实放行了这个账号,是「账号可用」的最硬证据 → 清除 quotaExhausted 误标。
      //
      // RCA 2026-08-04:此前只重置 errorCount,quotaExhaustedAt 原封不动 —— 于是一次误标
      // 之后即使同账号连续请求成功,也要干等 quotaResetMs(1h)走完才恢复,期间
      // hasBlockedAccount 恒为 true → HoldGate 持续误伤。用户原话:「同一个账号下一秒
      // 能够请求成功,多次请求成功应该自动放行」。
      //
      // 但**不动**这两样 —— 它们不是误标,一次成功不该抹掉:
      //   - quotaUsed/quotaLimit:updateQuota 从上游权威写入的真实额度数据
      //   - suspendedAt:封禁需人工或后端解除(clearSuspended)
      //   - quotaResetAt:上游给的真实配额重置时刻,保留供 isQuotaExhausted 第一条判据用
      const realQuotaUsedUp = !!account.quotaLimit && account.quotaLimit > 0
        && (account.quotaUsed ?? 0) >= account.quotaLimit
      this.accounts.set(accountId, {
        ...account,
        requestCount: (account.requestCount || 0) + 1,
        errorCount: 0, // 重置断路器失败计数
        // 真实额度数据仍显示用尽 → 保留标记;否则认定为误标并清除
        quotaExhaustedAt: realQuotaUsedUp ? account.quotaExhaustedAt : undefined,
        lastUsed: Date.now(),
        isAvailable: true
      })

      const accountList = Array.from(this.accounts.keys())
      const successIndex = accountList.indexOf(accountId)
      if (successIndex >= 0 && accountList.length > 0) {
        if (this.strategy === 'sticky') {
          // 粘滞: 成功后将全局索引固定在这个账号 (保留 prompt cache 命中)
          this.currentIndex = successIndex
        } else {
          // round-robin: 成功后指向下一个账号 (满足负载均衡)
          this.currentIndex = (successIndex + 1) % accountList.length
        }
      }
    }

    const stats = this.accountStats.get(accountId)
    if (stats) {
      this.accountStats.set(accountId, {
        ...stats,
        requests: stats.requests + 1,
        tokens: stats.tokens + tokens,
        lastUsed: Date.now()
      })
    }
  }

  // 记录请求失败（区分错误类型）
  recordError(accountId: string, errorType: ErrorType = ErrorType.RECOVERABLE, statusCode?: number): void {
    const account = this.accounts.get(accountId)
    if (!account) return

    const now = Date.now()
    const stats = this.accountStats.get(accountId)
    if (stats) {
      this.accountStats.set(accountId, { ...stats, errors: stats.errors + 1, lastUsed: now })
    }

    // FATAL 错误不增加失败计数（是请求的问题，不是账号的问题）
    if (errorType === ErrorType.FATAL) return

    // RECOVERABLE: 增加失败计数，断路器指数退避自动生效
    const errorCount = (account.errorCount || 0) + 1
    let quotaExhaustedAt = account.quotaExhaustedAt
    let quotaResetAt = account.quotaResetAt

    // 配额类错误额外标记耗尽，并按配置的 quotaResetMs 设定自动恢复时间。
    // 否则 quotaExhaustedAt 一直 > 0，isQuotaExhausted 永远为 true，
    // 该账号会被永久跳过（直到 updateQuota/reset 被显式调用）。
    //
    // ⚠️ 只认 402,**绝不认 429**(RCA 2026-08-04 hold-gate-429-quota-false-positive):
    // 429 是 Kiro 后端的概率式限流窗口(见 kiroApi 429 重试段注释:「不是真 QPS 上限,
    // 窗口随机开关」),不是额度问题。实测 proxy-logs UTC 10:30-11:07 单账号 147 次 429,
    // 其中 146 次(99.3%)在 60 秒内同一账号就有 200 成功。
    // 把 429 标成 quotaExhausted 会让 isQuotaExhausted 真 1 小时(quotaResetMs),
    // 进而 hasBlockedAccount → true → decideHoldAction 第一条命中 → 此后任何 pre-body
    // 错误(哪怕 400 malformed)都被 HoldGate 挂起 = 用户看到「账号明明正常却被拦住」。
    // 429 的正确处置是下面的 errorCount 指数退避,几秒级,而非池级 1 小时封锁。
    const isQuotaError = statusCode === 402
    if (isQuotaError) {
      quotaExhaustedAt = now
      // 仅在没有更明确的重置时间，或已有重置时间已过期时，按冷却窗口顺延
      if (!quotaResetAt || quotaResetAt <= now) {
        quotaResetAt = now + this.config.quotaResetMs
      }
    }

    // 计算当前退避时间用于日志
    const backoffMultiplier = Math.min(Math.pow(2, errorCount - 1), this.config.maxBackoffMultiplier)
    const effectiveCooldown = this.config.baseCooldownMs * backoffMultiplier
    const cooldownStr = effectiveCooldown < 60000 ? `${Math.round(effectiveCooldown / 1000)}s`
      : effectiveCooldown < 3600000 ? `${Math.round(effectiveCooldown / 60000)}m`
      : `${Math.round(effectiveCooldown / 3600000)}h`

    console.log(`[AccountPool] Account ${account.email || accountId} failure #${errorCount}: status=${statusCode || '?'}, cooldown=${cooldownStr}`)

    this.accounts.set(accountId, {
      ...account,
      errorCount,
      quotaExhaustedAt,
      quotaResetAt,
      lastUsed: now
    })
  }

  /**
   * 从上游权威额度数据更新账号配额 —— 「账号已用光」这条判据的**唯一**主动数据源。
   *
   * 生产调用方唯一:`accountService/persistCheckResult` 落盘收口(经注入的 sink)。
   * 刻意只有一个写者:`quotaUsed/quotaLimit` 与 `quotaExhaustedAt` 是同一状态机的字段,
   * 而 `recordError`(402 打标)/ `recordSuccess`(清误标)已经是两个写者。再加不同新鲜度的
   * 第三个写者就会出现「A 说 90/100、B 说 20/100,谁赢取决于调度顺序」,而赢错一次的代价是
   * 账号被钉死到 quotaResetAt(recordSuccess 的 realQuotaUsedUp 短路刻意不清真实额度数据)。
   *
   * @param used 已用额度(credits,可带小数)
   * @param limit 额度上限(credits)
   * @param resetAt 上游给的下次重置时刻(**epoch ms**;盘上/上游是 ISO string,转换在调用方做)
   * @param observedAt 这份数据的**观测版本**;用于丢弃并发刷新中迟到的旧响应。
   *   由调用方在**上游请求发出前**铸造(`utils/observationClock.nextObservationVersion`),
   *   不是写入时刻 —— 写入时刻表示完成顺序,而先发出的慢响应会晚于后发出的快响应完成,
   *   于是旧数据反而拿到更大的值。这个值**只可用于互相比较**,不是时间(同毫秒并发时会
   *   比真实墙钟大),绝不可拿去显示或算时间差。
   */
  updateQuota(accountId: string, used: number, limit: number, resetAt?: number, observedAt: number = Date.now()): void {
    const account = this.accounts.get(accountId)
    if (!account) return

    // ---- 准入:坏数据一律不写(守在入口,而不是靠远处的判据兜住)----
    //
    // limit <= 0 不是「额度为零」而是「还没查过」:importApiKey 导入 ksk_ 后额度是占位的
    // {current:0, limit:0}(webPanel/routes.ts:297 注释)。把它当额度写入 = 凭空造一个额度事实;
    // 更要紧的是「一池未刷新的新账号」会整池看起来全部耗尽 → availableCount 归零 →
    // 挂起门闸冻结所有请求(RCA 2026-08-04 的用户可感知形态:「账号明明正常却被拦住」)。
    //
    // NaN 同样必须拒:它会让 `used >= limit` 恒为 false,判据静默失效而无任何报错。
    if (!Number.isFinite(limit) || limit <= 0) return
    if (!Number.isFinite(used) || used < 0) return

    // ---- 时序仲裁:迟到的旧响应不得覆盖新数据 ----
    // checkAccountStatus 并发执行,singleFlight 只按 id 去重、跨轮次不保序 ⇒ 一个慢响应
    // 回来就能把新数字按回旧值。相等放行(同毫秒不算迟到)。
    if (account.quotaUpdatedAt !== undefined && observedAt < account.quotaUpdatedAt) return

    const wasExhausted = this.isQuotaExhausted(account)
    this.notifyIfBecameAvailable(() => {
      this.accounts.set(accountId, {
        ...account,
        quotaUsed: used,
        quotaLimit: limit,
        quotaUpdatedAt: observedAt,
        // 上游给了重置时刻就以它为准;没给则**保留既有值**,绝不抹成 undefined。
        // quotaResetAt 是 isQuotaExhausted 的第一条判据(见 :410),也是 recordError
        // 在 402 时按 quotaResetMs 写入的唯一自动恢复时刻 —— 无条件覆盖会让调用方
        // 在拿不到上游 nextResetDate 时(按现签名调 updateQuota(id,used,limit))
        // 悄悄抹掉它,该账号退化成「只能靠 used<limit 或人工 reset 恢复」,时间到点永不自愈。
        // 与同文件既定约定一致:recordSuccess(:507) 刻意保留该字段、recordError(:578)
        // 仅在缺失/已过期时才顺延、AVAILABILITY_FIELDS(:182) 将其列为受保护可用性字段。
        quotaResetAt: resetAt ?? account.quotaResetAt,
        // 如果配额从耗尽恢复，清除耗尽标记
        quotaExhaustedAt: (used < limit) ? undefined : account.quotaExhaustedAt
      })
    })

    if (!wasExhausted && used >= limit) {
      console.log(`[AccountPool] Account ${account.email || accountId} quota reached: ${used}/${limit}`)
    } else if (wasExhausted && used < limit) {
      console.log(`[AccountPool] Account ${account.email || accountId} quota recovered: ${used}/${limit}`)
    }
  }

  // 获取配额状态摘要
  getQuotaStatus(): { total: number; available: number; exhausted: number; cooldown: number } {
    const now = Date.now()
    const all = Array.from(this.accounts.values())
    let available = 0
    let exhausted = 0
    let cooldown = 0

    for (const account of all) {
      if (this.isQuotaExhausted(account, now)) {
        exhausted++
      } else if (account.cooldownUntil && account.cooldownUntil > now) {
        cooldown++
      } else if (this.isAccountAvailable(account, now, false)) {
        available++
      }
    }

    return { total: all.length, available, exhausted, cooldown }
  }

  // 标记账号需要刷新 Token
  markNeedsRefresh(accountId: string): void {
    const account = this.accounts.get(accountId)
    if (account) {
      this.accounts.set(accountId, {
        ...account,
        isAvailable: false
      })
    }
  }

  // 获取统计信息
  getStats(): { accounts: Map<string, AccountStats>; total: { requests: number; tokens: number; errors: number } } {
    let totalRequests = 0
    let totalTokens = 0
    let totalErrors = 0

    for (const stats of this.accountStats.values()) {
      totalRequests += stats.requests
      totalTokens += stats.tokens
      totalErrors += stats.errors
    }

    return {
      accounts: new Map(this.accountStats),
      total: {
        requests: totalRequests,
        tokens: totalTokens,
        errors: totalErrors
      }
    }
  }

  // 重置所有账号状态（含封禁标记 — 手动重置表示用户已确认可用）
  reset(): void {
    this.notifyIfBecameAvailable(() => {
      for (const [id, account] of this.accounts) {
        this.accounts.set(id, {
          ...account,
          isAvailable: true,
          errorCount: 0,
          cooldownUntil: undefined,
          quotaExhaustedAt: undefined,
          suspendedAt: undefined,
          suspendReason: undefined,
          suspendMessage: undefined
        })
      }
    })
    this.currentIndex = 0
    this.swrr.reset()
  }

  // 清空所有账号
  //
  // ⚠️ 全量重同步(clear→addAccount)**不要**直接用这个方法 —— 用 {@link replaceAll}。
  // 本方法是无条件遗忘:清空后 addAccount 里的 `prev` 必然为 undefined,于是那里的
  // `?? prev` 保留法结构上失效,运行期状态(真实额度 / 402 耗尽标记 / 风控挂起 /
  // 断路器计数)全部随之消失。留它是因为"忘掉一切"本身是合法语义(测试 / 显式清池)。
  clear(): void {
    this.accounts.clear()
    this.accountStats.clear()
    this.swrr.reset()
    this.currentIndex = 0
  }

  /**
   * 按新名单**整池重建**,并按 id 迁移运行期状态 —— 全量重同步的唯一入口。
   *
   * ## 为什么必须是池自己的方法,而不是调用方各自 clear + addAccount
   *
   * 生产有四个「按盘上账号重建整池」的点(自启动 / replace 热替换 /
   * `proxy-sync-accounts` IPC / 面板 syncPool)。它们此前各写一遍
   * `pool.clear(); accounts.forEach(a => pool.addAccount(a))`,而 `clear()` 清空了
   * `accounts` ⇒ `addAccount` 的 `?? prev` 无源可读 ⇒ 每次重同步抹掉全部运行期状态。
   * 那个缺陷的用户可感知形态是:面板点一次「同步池」,刚喂进去的真实额度和 402
   * 打的耗尽标记一起消失,已耗尽的号重新进入轮询,而挂起门闸的「池空了吗」判据
   * 从一份被抹干净的状态上算出来。
   *
   * 收口成一个方法而不是在四处各自记得保留:调用方"记得"是靠不住的,
   * 第五个调用点出现时又会漏一次(Globalrules §4.3 SSOT)。
   *
   * ## 迁移哪些字段:判据是「谁是这份数据的权威源」
   *
   * 入参来自 `toProxyAccountShared`(activation.ts:223-265),它只产出**凭据与路由**
   * (token / region / profileArn / proxyUrl / weight / groupId)。凡是它不产出、
   * 只有运行期才知道的字段,盘上就没有权威值,重建时抹掉等于凭空丢事实:
   *
   *   - 额度四件套 `quotaUsed/quotaLimit/quotaResetAt/quotaUpdatedAt` —— 唯一来源是
   *     上游测活(`updateQuota`);`quotaUpdatedAt` 必须一起迁,否则时序仲裁失去基准,
   *     一个迟到的旧响应就能把新数字按回去。
   *   - `quotaExhaustedAt` —— 402 打的耗尽标记。
   *   - 风控挂起三件套 `suspendedAt/suspendReason/suspendMessage` + `isAvailable` ——
   *     需人工解封,抹掉 = 「同步一下池就把封号放回轮询」(RCA §4.2b,
   *     `.archive/2026-07-28/proxy-hot-switch-single-account/`)。与额度同等对待,
   *     因为两者都是"只有运行期知道、且抹掉会让坏号被选中"的状态。
   *   - 断路器 `errorCount` + `lastUsed` —— 必须**成对**迁移:退避窗口是
   *     `now - lastUsed < base * 2^(errorCount-1)`(见 :356-372),只迁一个会让
   *     窗口算错。抹掉 = 每次重同步都免费清零重试预算,一个持续失败的号
   *     被无限重试而永远等不到退避。
   *   - `modelCapabilities/lastListModelsAt/lastListModelsStatus` —— 来自
   *     ListAvailableModels 探测,抹掉会让已探明的号退回 unknown 态并重新探测一轮。
   *
   * **刻意不迁移**(有意归零,不是遗漏):
   *   - `requestCount` 与 `accountStats` —— 它们是"本轮池的统计",重建整池即新一轮;
   *     `addAccount` 一直是这个语义,这里不改。注意 `lastUsed` 不属此列:它同时是
   *     退避时钟,不是纯统计。
   *   - `cooldownUntil` —— 全仓无写入点(只在 `describeBlockedAccounts` / `getQuotaStatus`
   *     读、`reset()` 清),迁一个恒为 undefined 的字段是假装在处理它。真正生效的
   *     冷却是 errorCount 指数退避。若将来有了写入点,它属于断路器族,应一起迁。
   *   - 会话粘性(`proxyServer.sessionAffinity`)—— 不在账号对象里,由
   *     `invalidateSessionAffinity` 独立管理,换号语义各调用点不同,不该由池代劳。
   *
   * @param accounts 新名单(通常是 `buildProxyAccountsFromStore` 的产物)
   * @returns 本次重建后的池大小
   */
  replaceAll(accounts: readonly ProxyAccount[]): number {
    // 迁移源必须在清空**之前**取快照 —— 这正是原缺陷的成因
    const carry = new Map(this.accounts)
    const carryStats = new Map(this.accountStats)

    this.notifyIfBecameAvailable(() => {
      // clear/addAccount 各自都带 notifyIfBecameAvailable,嵌套会在中间态(池已清空)
      // 上算 availableCount。这里在外层包一次,内部走不通知的私有写入。
      this.accounts.clear()
      this.accountStats.clear()
      this.swrr.reset()
      this.currentIndex = 0

      for (const account of accounts) {
        const prev = carry.get(account.id)
        this.accounts.set(account.id, this.mergeRuntimeState(account, prev))
        // 统计沿用旧条目里的 requests/tokens/errors 归零语义,与 addAccount 一致,
        // 但 lastUsed 跟随账号对象上的退避时钟,避免两处时间基准分叉。
        this.accountStats.set(account.id, {
          requests: 0,
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          errors: 0,
          lastUsed: carryStats.get(account.id)?.lastUsed ?? 0,
          avgResponseTime: 0,
          totalResponseTime: 0
        })
      }
    })

    const migrated = accounts.filter((a) => carry.has(a.id)).length
    console.log(
      `[AccountPool] Pool rebuilt: ${accounts.length} accounts ` +
      `(${migrated} kept runtime state, ${accounts.length - migrated} new, ${carry.size - migrated} dropped)`
    )
    return this.accounts.size
  }

  /**
   * 把旧成员的运行期状态并进新映射产物。字段取舍的理由见 {@link replaceAll}。
   *
   * 一律用 `入参 ?? 旧值`:入参**说了**就以入参为准(启动复原时盘上带的是权威值),
   * 只有入参没说的时候才保留池内既有值。
   */
  private mergeRuntimeState(account: ProxyAccount, prev: ProxyAccount | undefined): ProxyAccount {
    if (!prev) {
      // 新号入池:与 addAccount 同语义(按入参重算可用性,统计归零)
      return { ...account, isAvailable: !this.isSuspended(account), requestCount: 0, errorCount: 0, lastUsed: 0 }
    }
    const merged: ProxyAccount = {
      ...account,
      // 额度族
      quotaUsed: account.quotaUsed ?? prev.quotaUsed,
      quotaLimit: account.quotaLimit ?? prev.quotaLimit,
      quotaResetAt: account.quotaResetAt ?? prev.quotaResetAt,
      quotaUpdatedAt: account.quotaUpdatedAt ?? prev.quotaUpdatedAt,
      quotaExhaustedAt: account.quotaExhaustedAt ?? prev.quotaExhaustedAt,
      // 风控挂起族(与额度同等对待,理由见 replaceAll 文档)
      suspendedAt: account.suspendedAt ?? prev.suspendedAt,
      suspendReason: account.suspendReason ?? prev.suspendReason,
      suspendMessage: account.suspendMessage ?? prev.suspendMessage,
      // 断路器族:成对迁移,否则退避窗口算错
      errorCount: account.errorCount ?? prev.errorCount,
      lastUsed: account.lastUsed ?? prev.lastUsed,
      // 能力探测族
      modelCapabilities: account.modelCapabilities ?? prev.modelCapabilities,
      lastListModelsAt: account.lastListModelsAt ?? prev.lastListModelsAt,
      lastListModelsStatus: account.lastListModelsStatus ?? prev.lastListModelsStatus,
      // 刻意归零:本轮池的统计(见 replaceAll「刻意不迁移」)
      requestCount: 0
    }
    // isAvailable 由合并后的挂起状态决定,不能按入参重算 —— 盘上映射不带 suspendedAt,
    // 按它算会得出 true,那正是「切一下账号就静默解除风控封禁」那条 RCA 的成因。
    merged.isAvailable = this.isSuspended(merged) ? false : (account.isAvailable ?? prev.isAvailable ?? true)
    return merged
  }

  // 获取账号数量
  get size(): number {
    return this.accounts.size
  }

  // 获取可用账号数量（统计用：不带概率重试抖动）
  get availableCount(): number {
    const now = Date.now()
    let count = 0
    for (const account of this.accounts.values()) {
      if (this.isAccountAvailable(account, now, false)) {
        count++
      }
    }
    return count
  }

  // ============ v1.7.6 新增: 权重 SWRR + 三态能力状态机 ============

  /**
   * SWRR 加权挑选:从给定候选中按 weight 字段(默认 100)分配
   * 与 round-robin/sticky 平行的第三种策略,不改动 currentIndex
   * @returns 挑中的账号;候选空 或 全 0 权重 返回 null
   */
  pickWeighted(candidates: readonly ProxyAccount[]): ProxyAccount | null {
    return this.swrr.pick(candidates)
  }

  /**
   * 按 modelId 前置过滤账号池,返回三类:
   *   candidates: 已确认支持该 model 的账号(可直接路由)
   *   unknownAccounts: 未同步 或 无该 model 记录的账号(未知态,配合 probe-once 使用)
   *   unsupportedCount: 已明确 unsupported 的账号数(仅用于日志/统计)
   *
   * @param allowedIds 可选白名单(API Key 绑定 / group filter);为空表示不限制
   */
  filterByModel(modelId: string, allowedIds?: Set<string>): {
    candidates: ProxyAccount[]
    unknownAccounts: ProxyAccount[]
    unsupportedCount: number
  } {
    const candidates: ProxyAccount[] = []
    const unknownAccounts: ProxyAccount[] = []
    let unsupportedCount = 0

    for (const account of this.accounts.values()) {
      if (allowedIds && !allowedIds.has(account.id)) continue
      // 用户手工强制排除
      if (account.excludedModels && account.excludedModels.includes(modelId)) {
        unsupportedCount++
        continue
      }
      const cap = account.modelCapabilities?.[modelId]
      if (cap === 'confirmed') {
        candidates.push(account)
      } else if (cap === 'unsupported') {
        unsupportedCount++
      } else {
        unknownAccounts.push(account)
      }
    }
    return { candidates, unknownAccounts, unsupportedCount }
  }

  /**
   * 应用 ListAvailableModels 同步结果.
   * - status='ok': 把 models 里出现的每个 modelId 标 'confirmed';**不主动写 unsupported**
   *   (API 短暂漂移 / 服务端分批 rollout 都会让某次同步少返回某些 model, 不能据此判 unsupported)
   * - status='failed': 只更新 lastListModelsStatus,能力标记保持原值不变
   */
  applyModelListResult(accountId: string, models: string[], status: 'ok' | 'failed'): void {
    const account = this.accounts.get(accountId)
    if (!account) return // 账号已删除, 静默丢弃

    const now = Date.now()
    if (status === 'failed') {
      this.accounts.set(accountId, {
        ...account,
        lastListModelsAt: now,
        lastListModelsStatus: 'failed'
      })
      return
    }
    // status = 'ok': 合并 confirmed(不删除任何已有 unsupported 标记, 除非 models 里显式包含它 → 覆盖为 confirmed)
    const caps: Record<string, 'confirmed' | 'unsupported'> = { ...(account.modelCapabilities || {}) }
    for (const m of models) {
      caps[m] = 'confirmed'
    }
    this.accounts.set(accountId, {
      ...account,
      modelCapabilities: caps,
      lastListModelsAt: now,
      lastListModelsStatus: 'ok'
    })
  }

  /** Runtime 反哺:stream 成功后升级 confirmed */
  markModelConfirmed(accountId: string, modelId: string): void {
    const account = this.accounts.get(accountId)
    if (!account) return
    const caps = { ...(account.modelCapabilities || {}) }
    if (caps[modelId] === 'confirmed') return // 幂等
    caps[modelId] = 'confirmed'
    this.accounts.set(accountId, { ...account, modelCapabilities: caps })
  }

  /** Runtime 反哺:stream 返 "unsupported model" 时降级 */
  markModelUnsupported(accountId: string, modelId: string): void {
    const account = this.accounts.get(accountId)
    if (!account) return
    const caps = { ...(account.modelCapabilities || {}) }
    if (caps[modelId] === 'unsupported') return
    caps[modelId] = 'unsupported'
    this.accounts.set(accountId, { ...account, modelCapabilities: caps })
    console.log(`[AccountPool] Account ${account.email || accountId} marked UNSUPPORTED for ${modelId}`)
  }
}
