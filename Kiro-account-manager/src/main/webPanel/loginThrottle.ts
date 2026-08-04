/**
 * 登录端点按 IP 限流（内存态 · 无 electron 依赖）
 *
 * 为什么必须有：adminKey 是面板的**唯一凭据**，不限流等于开放暴力破解。
 * 决策卡 §3「W5 recon 补充」明确要求。
 *
 * 形态选择 —— **失败计数 + 指数退避锁定**，而非代理侧的「滑动窗口计数」
 * （`proxyServer.ts:4715 checkRateLimit`）：
 *   - 代理限的是**正常调用频次**（保护配额），成功请求也计数，超了退避 1 分钟。
 *   - 登录限的是**猜密码**：合法用户一次就成功，攻击者反复失败。
 *     因此只对**失败**计数、成功即清零 —— 用对了 key 的人永远不被锁，
 *     而猜错的人锁定时间随失败次数指数增长。
 *   两者语义不同，共用一个实现会让「输错一次密码」和「正常调用一次」等价，
 *   要么误锁用户，要么锁不住攻击者。故这里独立实现，不复用代理的桶。
 */

/** 触发锁定的连续失败次数 */
export const MAX_FAILED_ATTEMPTS = 5
/** 首次锁定时长 */
export const BASE_LOCKOUT_MS = 60 * 1000
/** 锁定时长上限（指数退避封顶） */
export const MAX_LOCKOUT_MS = 30 * 60 * 1000
/** 无活动多久后遗忘该 IP 的记录 */
const ENTRY_TTL_MS = 60 * 60 * 1000

interface AttemptRecord {
  /** 自上次成功/解锁以来的连续失败次数 */
  failures: number
  /** 锁定到期时刻（0 = 未锁定） */
  lockedUntil: number
  /** 最后一次活动时刻（清扫依据） */
  lastAt: number
}

export interface LoginThrottleOptions {
  now?: () => number
  maxFailedAttempts?: number
  baseLockoutMs?: number
  maxLockoutMs?: number
}

/** 限流判定结果 */
export interface ThrottleDecision {
  allowed: boolean
  /** 被拒时的建议重试等待（毫秒），用于 `Retry-After` 头 */
  retryAfterMs: number
}

export class LoginThrottle {
  private entries = new Map<string, AttemptRecord>()
  private readonly now: () => number
  private readonly maxFailedAttempts: number
  private readonly baseLockoutMs: number
  private readonly maxLockoutMs: number

  constructor(options: LoginThrottleOptions = {}) {
    this.now = options.now ?? Date.now
    this.maxFailedAttempts = options.maxFailedAttempts ?? MAX_FAILED_ATTEMPTS
    this.baseLockoutMs = options.baseLockoutMs ?? BASE_LOCKOUT_MS
    this.maxLockoutMs = options.maxLockoutMs ?? MAX_LOCKOUT_MS
  }

  /**
   * 尝试前询问：该 IP 现在允许提交登录吗？
   * **只读判定，不计数** —— 计数发生在知道结果之后（`recordFailure` / `recordSuccess`）。
   */
  check(ip: string): ThrottleDecision {
    const e = this.entries.get(ip)
    if (!e || e.lockedUntil === 0) return { allowed: true, retryAfterMs: 0 }
    const t = this.now()
    if (t >= e.lockedUntil) {
      // 锁定已到期：解锁，但**保留失败计数**，
      // 使下一轮失败的退避时长继续指数增长（否则攻击者可每轮锁定后重置到 1 分钟）
      e.lockedUntil = 0
      e.lastAt = t
      return { allowed: true, retryAfterMs: 0 }
    }
    return { allowed: false, retryAfterMs: e.lockedUntil - t }
  }

  /** 记录一次失败；达到阈值则锁定（时长指数退避、封顶） */
  recordFailure(ip: string): ThrottleDecision {
    const t = this.now()
    const e = this.entries.get(ip) ?? { failures: 0, lockedUntil: 0, lastAt: t }
    e.failures += 1
    e.lastAt = t
    if (e.failures >= this.maxFailedAttempts) {
      // 第 N 次失败锁 base，第 N+1 次锁 2×base，第 N+2 次锁 4×base…… 封顶 maxLockoutMs
      const overshoot = e.failures - this.maxFailedAttempts
      const lockMs = Math.min(this.baseLockoutMs * 2 ** overshoot, this.maxLockoutMs)
      e.lockedUntil = t + lockMs
    }
    this.entries.set(ip, e)
    return e.lockedUntil > t
      ? { allowed: false, retryAfterMs: e.lockedUntil - t }
      : { allowed: true, retryAfterMs: 0 }
  }

  /** 记录一次成功：清零该 IP（合法用户永不被自己的历史失败拖累） */
  recordSuccess(ip: string): void {
    this.entries.delete(ip)
  }

  /** 当前失败计数（可观测量，便于测试与审计） */
  failureCount(ip: string): number {
    return this.entries.get(ip)?.failures ?? 0
  }

  /** 清扫长期无活动的记录，防止 Map 随 IP 数无界增长 */
  sweep(): void {
    const t = this.now()
    for (const [ip, e] of this.entries) {
      if (t - e.lastAt > ENTRY_TTL_MS && t >= e.lockedUntil) this.entries.delete(ip)
    }
  }
}
