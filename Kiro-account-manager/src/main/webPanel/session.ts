/**
 * Web 面板会话存储（内存态 · 不落盘 · 无 electron 依赖）
 *
 * 决策卡 §3「授权模型」：面板拥有**独立授权域**，与反代 API Key 无关。
 * 反代 API Key 是调用侧凭据（配额 / 按 key 限流 / 账号白名单），
 * 不代表管理员身份；复用即权限提升。
 *
 * 设计要点（均有实证依据，见 recon-http-layer.md §2）：
 *   - token 用 `crypto.randomBytes(32).toString('base64url')`（256 bit）。
 *     **不用**已装的 `uuid` —— v4 仅 122 bit 随机且格式可预测。
 *   - 会话**不落盘**：易失状态持久化只增加凭据泄漏面，重启失效是正确行为。
 *   - 定期清理照抄 `proxyServer.ts:552` 的 `setInterval + unref` 先例
 *     （unref 让 Node 退出时不被 timer 阻塞）。
 *   - 校验与滑动续期在**同一次调用**内完成，不给调用方拆开的机会。
 */
import * as crypto from 'node:crypto'

/** 24h 绝对过期（决策卡 §3） */
export const ABSOLUTE_TTL_MS = 24 * 60 * 60 * 1000
/** 2h 空闲过期（决策卡 §3） */
export const IDLE_TTL_MS = 2 * 60 * 60 * 1000
/** 过期会话清扫间隔 */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000

interface SessionRecord {
  /** 创建时刻（绝对过期基准，续期时**不**更新） */
  createdAt: number
  /** 最后一次成功校验时刻（空闲过期基准，续期时更新） */
  lastSeenAt: number
}

/** 注入时钟以便测试推进时间；生产用 `Date.now` */
export interface SessionStoreOptions {
  now?: () => number
  absoluteTtlMs?: number
  idleTtlMs?: number
}

export class PanelSessionStore {
  private sessions = new Map<string, SessionRecord>()
  private sweepTimer: NodeJS.Timeout | null = null
  private readonly now: () => number
  private readonly absoluteTtlMs: number
  private readonly idleTtlMs: number

  constructor(options: SessionStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.absoluteTtlMs = options.absoluteTtlMs ?? ABSOLUTE_TTL_MS
    this.idleTtlMs = options.idleTtlMs ?? IDLE_TTL_MS
  }

  /**
   * 签发新会话。
   * @returns 会话 id（256 bit 随机，base64url 无需转义即可放进 cookie）
   */
  create(): string {
    const sid = crypto.randomBytes(32).toString('base64url')
    const t = this.now()
    this.sessions.set(sid, { createdAt: t, lastSeenAt: t })
    return sid
  }

  /**
   * 校验会话并滑动续期。**校验与续期不可分离** —— 分开会让调用方
   * 有机会「只校验不续期」或「先续期后校验」。
   *
   * 过期会话即时删除（不等清扫），避免过期 id 在 Map 里继续占位。
   *
   * @returns 会话有效且已续期 → true；不存在 / 绝对过期 / 空闲过期 → false
   */
  validate(sid: string | undefined | null): boolean {
    if (!sid) return false
    const s = this.sessions.get(sid)
    if (!s) return false
    const t = this.now()
    if (t - s.createdAt >= this.absoluteTtlMs || t - s.lastSeenAt >= this.idleTtlMs) {
      this.sessions.delete(sid)
      return false
    }
    s.lastSeenAt = t
    return true
  }

  /** 销毁单个会话（面板退出按钮）。@returns 是否确有该会话被销毁 */
  destroy(sid: string | undefined | null): boolean {
    if (!sid) return false
    return this.sessions.delete(sid)
  }

  /**
   * 失效**所有**既存会话。
   *
   * ⚠️ 决策卡 §3「轮换/退出」：adminKey 重新生成时必须调用它，
   * 否则旧 key 签发的会话在轮换后继续可用 —— 轮换等于没做。
   * 该接线点在 `auth.ts:PanelAuth.rotateAdminKey()`。
   */
  invalidateAll(): void {
    this.sessions.clear()
  }

  /** 当前活跃会话数（测试与设置页可观测量；不含已过期未清扫的） */
  get activeCount(): number {
    return this.sessions.size
  }

  /** 清扫过期会话，防止 Map 无界增长（长期运行的主进程） */
  sweep(): void {
    const t = this.now()
    for (const [sid, s] of this.sessions) {
      if (t - s.createdAt >= this.absoluteTtlMs || t - s.lastSeenAt >= this.idleTtlMs) {
        this.sessions.delete(sid)
      }
    }
  }

  /** 启动周期清扫（幂等；照抄 `proxyServer.ts:552` 的 setInterval + unref） */
  startSweeping(intervalMs = SWEEP_INTERVAL_MS): void {
    this.stopSweeping()
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs)
    // 让 timer 在 Node 退出时不阻塞（与代理侧一致）
    this.sweepTimer.unref?.()
  }

  /** 停止周期清扫（应用退出 / 面板关闭时调用，避免 timer 泄漏） */
  stopSweeping(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }
}
