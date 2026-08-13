/**
 * 面板 HTTP 客户端 —— 浏览器侧访问 `/panel/api/*` 的**唯一**出口。
 *
 * 三件事收在这一层，任何组件都不该自己调 `fetch`：
 *   ① 写操作自动带 `X-Panel-Request: 1`（CSRF 第二道，见 `main/webPanel/auth.ts:70`）
 *   ② 会话失效（401）归一成一个可识别的异常，由 App 顶层统一踢回登录页
 *   ③ 服务端的稳定错误码（`main/webPanel/respond.ts:PanelErrorCode`）翻译成中文文案
 *
 * 为什么必须收口而不是各组件自己 fetch：漏一个 CSRF 头 = 那个按钮永远 401，
 * 而 401 与「会话过期」在服务端是**同一个响应**（auth.ts 刻意不区分），
 * 所以漏头的表现是「点了就被踢回登录页」，极难定位到是缺 header。
 */

/** 与 `src/main/webPanel/respond.ts` 的 PanelErrorCode 一一对应 */
export type { PanelErrorCode } from '../../main/webPanel/respond'
import type { PanelErrorCode } from '../../main/webPanel/respond'

/** 面板 API 前缀。与 `main/webPanel/cookie.ts:PANEL_PATH_PREFIX` 同一契约 */
const API_BASE = '/panel/api'

/**
 * 写操作必须携带的头。
 *
 * 导出是为了让 `test/main/webPanel/panelClientCsrfContract.test.ts` 能把它喂给
 * **真实的** `PanelAuth.guard()` —— 客户端发的头与服务端判据是同一个契约的两处消费点，
 * 靠「两边都写了 1」的巧合维持是会漂移的。测试锁住它，改一边就红。
 */
export const CSRF_HEADER = 'X-Panel-Request'
export const CSRF_HEADER_VALUE = '1'

/** 非写方法 —— 与服务端 `auth.ts:READ_METHODS` 保持同一集合 */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * 面板 API 失败。
 *
 * `code` 是分支依据，`message` 只用于展示 —— 服务端明确「客户端按 code 分支，
 * 不按 message 文案」（respond.ts:sendError 的注释）。
 */
export class PanelApiError extends Error {
  readonly code: PanelErrorCode
  readonly status: number
  /** 429 时服务端 `Retry-After` 头给的秒数 */
  readonly retryAfterSec?: number
  /** 服务端经统一脱敏出口返回的补充说明；稳定分支仍只看 code。 */
  readonly serverMessage?: string

  constructor(
    status: number,
    code: PanelErrorCode,
    message: string,
    retryAfterSec?: number,
    cause?: unknown,
    serverMessage?: string
  ) {
    super(message)
    this.name = 'PanelApiError'
    this.status = status
    this.code = code
    if (retryAfterSec !== undefined) this.retryAfterSec = retryAfterSec
    if (serverMessage !== undefined) this.serverMessage = serverMessage
    // 网络层原始错误挂在标准 cause 上，不丢根因（§4.4：不得静默吞异常）
    if (cause !== undefined) this.cause = cause
  }

  /** 会话失效 —— App 顶层据此踢回登录页 */
  get isUnauthorized(): boolean {
    return this.status === 401
  }
}

/** 错误码 → 用户能看懂的中文。未知码兜底给通用文案，不把英文码直接甩给用户 */
const ERROR_TEXT: Record<PanelErrorCode, string> = {
  UNAUTHORIZED: '登录已失效，请重新输入管理密钥',
  INVALID_CREDENTIAL: '账号凭据不可用（可能已失效或缺少刷新凭证）',
  ACCOUNT_ALREADY_EXISTS: '账号已存在',
  ACCOUNT_NOT_FOUND: '账号不存在，请刷新列表',
  PROXY_UPSTREAM_NOT_FOUND: '上游代理不存在，请刷新代理池',
  TOKEN_REFRESH_FAILED: '刷新 Token 失败，请稍后重试',
  STALE_REVISION: '数据已被其他端修改，请刷新后重试',
  RATE_LIMITED: '操作过于频繁，请稍候再试',
  INTERNAL_ERROR: '操作失败，请稍后重试',
  INVALID_CONFIG: '配置内容无效，请检查后重试',
  // 反代编排（W8）。这张表是 `isPanelErrorCode` 的判据（`in ERROR_TEXT`），
  // 漏补会让新错误码静默退化成 INTERNAL_ERROR —— 用户看到「操作失败」而不是
  // 「没有可用账号」，真因被抹掉。
  PROXY_NOT_RUNNING: '反代未在运行，请先启动',
  ACCOUNT_NOT_IN_POOL: '该账号不在反代池里（可能凭据缺失或状态非正常）',
  ACCOUNT_NOT_AVAILABLE: '该账号当前不可用（被风控封禁或额度耗尽）',
  EMPTY_POOL: '没有可用账号，反代未启动',
  PROXY_START_FAILED: '反代启动失败（端口可能被占用）'
}

function isPanelErrorCode(v: unknown): v is PanelErrorCode {
  return typeof v === 'string' && v in ERROR_TEXT
}

/**
 * 发一个面板 API 请求。
 *
 * @param method HTTP 方法。**非读方法自动补 CSRF 头** —— 这是本函数存在的首要理由
 * @param path `/panel/api` 之后的路径，例如 `/accounts`
 * @param body 请求体（会 JSON 序列化）。GET 不传
 *
 * @throws {PanelApiError} 非 2xx 响应，或响应不是合法 JSON
 */
export async function panelRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const upper = method.toUpperCase()
  const headers: Record<string, string> = {}

  // CSRF 头只在写操作上加。读操作加了也无害，但与服务端判据保持同一形状更好排查。
  if (!READ_METHODS.has(upper)) headers[CSRF_HEADER] = CSRF_HEADER_VALUE
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: upper,
      headers,
      // 同源请求，但显式声明 —— 会话是 HttpOnly cookie，缺了它整个面板都不认人
      credentials: 'same-origin',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    })
  } catch (error) {
    // 网络层失败（手机切了 Wi-Fi / 桌面端把面板关了）。这不是服务端错误码，
    // 但调用方只该处理一种异常类型，所以归一成 PanelApiError。
    // 原始 error 保留在 cause 里 —— 不吞掉根因，手机端排查时能在控制台看到。
    throw new PanelApiError(
      0,
      'INTERNAL_ERROR',
      '连不上面板服务，请确认电脑端面板仍在运行且手机在同一局域网',
      undefined,
      error
    )
  }

  // 响应体可能为空（理论上不会 —— sendJson 恒写 JSON），解析失败不能当成功
  const text = await response.text()
  let parsed: unknown = undefined
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new PanelApiError(response.status, 'INTERNAL_ERROR', '服务端返回了无法解析的响应')
    }
  }

  if (!response.ok) {
    const rawCode = (parsed as { code?: unknown } | undefined)?.code
    const rawMessage = (parsed as { message?: unknown } | undefined)?.message
    const code: PanelErrorCode = isPanelErrorCode(rawCode) ? rawCode : 'INTERNAL_ERROR'
    const retryAfterRaw = response.headers.get('Retry-After')
    const retryAfterSec = retryAfterRaw ? Number.parseInt(retryAfterRaw, 10) : undefined
    throw new PanelApiError(
      response.status,
      code,
      ERROR_TEXT[code],
      Number.isFinite(retryAfterSec) ? retryAfterSec : undefined,
      undefined,
      typeof rawMessage === 'string' && rawMessage.length > 0 ? rawMessage : undefined
    )
  }

  return parsed as T
}
