/**
 * Web 面板鉴权（adminKey 生成/轮换 + 登录 + 单一请求闸门 + 登出）
 *
 * 授权域独立（决策卡 §3）：面板用自己的 `webPanel.adminKey`，
 * **绝不**复用反代 API Key —— 后者是调用侧凭据（配额 / 按 key 限流 /
 * `apiKeyAccountBindings` 账号白名单），语义是「这个调用方能用哪些账号」，
 * 与「能否删账号 / 改配置」的管理员身份正交。复用即权限提升。
 *
 * 本文件**不含 HTTP 服务器 / 路由 / 静态资源**（属后续包）；
 * 也**不 import electron**（面板路径无 BrowserWindow，且 vitest node env 加载不了 electron）。
 * adminKey 的持久化由调用方通过 `AdminKeyStore` 注入，避免本模块反向依赖 index.ts。
 */
import * as crypto from 'node:crypto'
import { safeStringEq } from '../utils/netGuard'
import { PanelSessionStore, ABSOLUTE_TTL_MS } from './session'
import { LoginThrottle, type ThrottleDecision } from './loginThrottle'
import { SESSION_COOKIE_NAME, readCookie, buildSessionCookie, buildClearedSessionCookie } from './cookie'

/** adminKey 字节数（32B → base64url 43 字符，256 bit 熵） */
const ADMIN_KEY_BYTES = 32

/**
 * adminKey 持久化端口。由 index.ts 用 electron-store 实现并注入。
 * 用 getter 而非直接传值 —— 与 `accountService/types.ts:176 AccountStoreDeps`
 * 同一理由：store 惰性初始化，直接传值会永久捕获 null。
 */
export interface AdminKeyStore {
  /** 读当前 adminKey；从未生成过 → null */
  get: () => string | null
  /** 写入 adminKey（轮换与首次生成共用） */
  set: (key: string) => void
}

/** 请求侧最小抽象 —— 只取闸门需要的两样，不让 http.IncomingMessage 形状渗进来 */
export interface GuardedRequest {
  /** HTTP 方法（判定是否为写操作） */
  method?: string
  /** 请求头（读 cookie 与 `X-Panel-Request`） */
  headers: Record<string, string | string[] | undefined>
}

/** 闸门拒绝原因（供路由层映射稳定错误码 / 审计日志，不回传给浏览器细节） */
export type GuardDenyReason = 'NO_SESSION' | 'SESSION_EXPIRED' | 'CSRF_HEADER_MISSING'

export interface GuardResult {
  /** 唯一判定位 —— 路由层只该看这一个布尔 */
  ok: boolean
  reason?: GuardDenyReason
}

export interface LoginResult {
  ok: boolean
  /** 成功时的 `Set-Cookie` 头值 */
  setCookie?: string
  /** 失败原因：凭据错 / 被限流 / 面板未设 adminKey */
  reason?: 'INVALID_KEY' | 'RATE_LIMITED' | 'NO_ADMIN_KEY'
  /** 被限流时的建议等待毫秒（供 `Retry-After`） */
  retryAfterMs?: number
}

export interface PanelAuthOptions {
  /** 是否走 TLS —— 决定 cookie 是否带 `Secure` */
  isHttps?: () => boolean
  sessions?: PanelSessionStore
  throttle?: LoginThrottle
}

/** 写操作必须携带的自定义头（CSRF 第二道；跨源简单请求无法伪造自定义头） */
const CSRF_HEADER = 'x-panel-request'
const CSRF_HEADER_VALUE = '1'

/** 非写方法（不要求 CSRF 头） */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export class PanelAuth {
  private readonly keyStore: AdminKeyStore
  private readonly sessions: PanelSessionStore
  private readonly throttle: LoginThrottle
  private readonly isHttps: () => boolean

  constructor(keyStore: AdminKeyStore, options: PanelAuthOptions = {}) {
    this.keyStore = keyStore
    this.sessions = options.sessions ?? new PanelSessionStore()
    this.throttle = options.throttle ?? new LoginThrottle()
    this.isHttps = options.isHttps ?? ((): boolean => false)
  }

  /** 暴露会话存储供服务包接生命周期（startSweeping / stopSweeping） */
  get sessionStore(): PanelSessionStore {
    return this.sessions
  }

  /**
   * 确保存在 adminKey：已有则原样返回，从未生成过则生成并落盘。
   *
   * **不设默认密码** —— 同类项目 `kiro-reverse-api` 出厂 `changeme` 是反面教材。
   * 首次启用时生成的 key 由桌面端设置页显示（连同局域网地址）。
   *
   * ⚠️ 首次生成**不**失效会话（此时不可能有会话）；轮换才失效，见 `rotateAdminKey`。
   */
  ensureAdminKey(): string {
    const existing = this.keyStore.get()
    if (existing) return existing
    const generated = generateAdminKey()
    this.keyStore.set(generated)
    return generated
  }

  /** 当前是否已配置 adminKey（外网绑定拒启动判据由服务包调用） */
  hasAdminKey(): boolean {
    return !!this.keyStore.get()
  }

  /**
   * 轮换 adminKey：生成新 key、落盘，并**立即失效所有既存会话**。
   *
   * 失效是轮换语义的一部分，不是可选项 —— 若旧 key 签发的会话在轮换后仍可用，
   * 「重新生成密钥」对已被泄漏的会话毫无补救作用（决策卡 §3「轮换/退出」）。
   *
   * @returns 新的 adminKey（供设置页显示）
   */
  rotateAdminKey(): string {
    const next = generateAdminKey()
    this.keyStore.set(next)
    this.sessions.invalidateAll()
    return next
  }

  /**
   * 登录：按 IP 限流 → 常数时间比较 adminKey → 签发会话 cookie。
   *
   * 顺序不可调换：限流必须在比较**之前**，否则攻击者仍能无限次触发比较。
   */
  login(providedKey: string | undefined, clientIP: string): LoginResult {
    const gate: ThrottleDecision = this.throttle.check(clientIP)
    if (!gate.allowed) {
      return { ok: false, reason: 'RATE_LIMITED', retryAfterMs: gate.retryAfterMs }
    }

    const adminKey = this.keyStore.get()
    if (!adminKey) {
      // 未配置 adminKey 时**不得**放行（否则空 key 等于无鉴权）
      return { ok: false, reason: 'NO_ADMIN_KEY' }
    }

    // 即便 providedKey 缺失也走一次比较，避免「缺参数」与「key 错误」耗时可区分
    if (!safeStringEq(adminKey, providedKey ?? '')) {
      const after = this.throttle.recordFailure(clientIP)
      return after.allowed
        ? { ok: false, reason: 'INVALID_KEY' }
        : { ok: false, reason: 'RATE_LIMITED', retryAfterMs: after.retryAfterMs }
    }

    this.throttle.recordSuccess(clientIP)
    const sid = this.sessions.create()
    return {
      ok: true,
      setCookie: buildSessionCookie(sid, {
        isHttps: this.isHttps(),
        maxAgeSec: ABSOLUTE_TTL_MS / 1000
      })
    }
  }

  /**
   * **唯一请求闸门** —— 会话有效性与 CSRF 头检查在这里合并成单一布尔。
   *
   * 为什么必须合一（recon-http-layer.md §2.3）：拆成两处判断，
   * 迟早有新端点只调了会话校验而漏了 CSRF 头。路由层只该看 `result.ok`，
   * 没有任何理由单独调用会话校验。
   *
   * CSRF 双重防护：`SameSite=Strict` cookie（浏览器侧）+ 自定义头（服务端侧）。
   * 自定义头对跨源请求会触发预检，攻击页面无法在简单请求里带上它。
   * 读方法不要求该头（GET 无副作用，且需允许直接打开面板页面）。
   */
  guard(req: GuardedRequest): GuardResult {
    const sid = readCookie(req.headers?.cookie, SESSION_COOKIE_NAME)
    if (!sid) return { ok: false, reason: 'NO_SESSION' }

    const sessionOk = this.sessions.validate(sid)
    const method = (req.method ?? 'GET').toUpperCase()
    const isWrite = !READ_METHODS.has(method)
    const csrfOk = !isWrite || headerValue(req.headers?.[CSRF_HEADER]) === CSRF_HEADER_VALUE

    // 单一返回点：两个条件都过才 ok。先算完再判，避免短路造成可区分耗时。
    if (!sessionOk) return { ok: false, reason: 'SESSION_EXPIRED' }
    if (!csrfOk) return { ok: false, reason: 'CSRF_HEADER_MISSING' }
    return { ok: true }
  }

  /**
   * 登出：服务端销毁会话 + 返回清除 cookie 头。
   * 服务端销毁是关键 —— 只清浏览器 cookie 的话，已泄漏的 sid 仍然有效。
   */
  logout(req: GuardedRequest): { setCookie: string; destroyed: boolean } {
    const sid = readCookie(req.headers?.cookie, SESSION_COOKIE_NAME)
    const destroyed = this.sessions.destroy(sid)
    return { setCookie: buildClearedSessionCookie({ isHttps: this.isHttps() }), destroyed }
  }
}

/** 生成 256 bit 随机 adminKey（base64url：可直接放 URL / 输入框，无转义问题） */
export function generateAdminKey(): string {
  return crypto.randomBytes(ADMIN_KEY_BYTES).toString('base64url')
}

/** 取单值头（Node 对重复头会给数组） */
function headerValue(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0]
  return v
}
