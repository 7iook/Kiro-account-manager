/**
 * 面板端点封装 —— 每个函数对应 `main/webPanel/routes.ts` 里的一条路由。
 *
 * ## 账号类型为什么直接 import 主进程的 DTO
 *
 * `AccountListItem` 从 `src/main/webPanel/dto.ts` **直接 import type**，不在浏览器侧
 * 手抄一份。手抄 + 「Keep in sync」注释是已知的漂移源（Globalrules §4.3 SSOT）：
 * dto.ts 加一个字段，面板类型不会自动知道，编译期零保护。
 *
 * 只 import `type` 不 import 值，所以 `node:fs` 等主进程依赖不会被打进浏览器 bundle
 * （dto.ts 本身零 import，纯函数 + 接口，这一点已实测）。
 *
 * ## 登录 / 会话为什么不在 routes.ts 里
 *
 * `/api/login`、`/api/logout`、`/api/session` 三条由 `server.ts:handleRequest` 直接处理
 * （登录必须在鉴权闸门**之前**，登出/会话在闸门之后），没进 `routePanelApi`。
 * 这不影响客户端 —— 对浏览器它们和其他端点同一形状。
 */
import type { AccountListItem, AccountListPayload } from '../../main/webPanel/dto'
import { panelRequest, PanelApiError } from './client'

export type { AccountListItem, AccountListPayload }

/**
 * 登录。
 *
 * 服务端对「密钥错」与「面板未设密钥」返回**同一个** 401（不泄漏可利用信息），
 * 所以这里也只能报「密钥不正确」。429 带 `Retry-After`，由 PanelApiError.retryAfterSec 承载。
 */
export async function login(adminKey: string): Promise<void> {
  await panelRequest<{ ok: true }>('POST', '/login', { adminKey })
}

export async function logout(): Promise<void> {
  await panelRequest<{ ok: true }>('POST', '/logout')
}

/**
 * 查询当前 cookie 是否仍是有效会话。
 *
 * ⚠️ 该端点在服务端**位于鉴权闸门之后**（`server.ts:handleRequest` 先 guard 再判路径），
 * 所以未登录时它返回 **401，而不是 `{ authenticated: false }`**。
 * 因此「是否已登录」的判据是**请求成功与否**，不是响应体里的布尔值。
 * 把 401 转成 `false` 而不是抛异常，是因为「没登录」是启动时的正常状态，不是错误。
 */
export async function checkSession(): Promise<boolean> {
  try {
    await panelRequest<{ ok: true; authenticated: boolean }>('GET', '/session')
    return true
  } catch (error) {
    if (error instanceof PanelApiError && error.isUnauthorized) return false
    // 网络不通等其它失败要如实抛出 —— 静默当成「未登录」会让用户以为会话过期，
    // 反复输密钥却依然失败（真因是连不上）。
    throw error
  }
}

/** 账号列表（读，无副作用） */
export async function fetchAccounts(): Promise<AccountListPayload> {
  return panelRequest<AccountListPayload>('GET', '/accounts')
}

/**
 * 刷新额度 / 检查账户信息 —— 用户日常最高频的操作。
 *
 * ⚠️ **服务端不落盘**：`accountService/check.ts:checkAccountStatus` 只返回结果，
 * 持久化由桌面端 renderer store 完成（`store/accounts.ts:1996` 收到结果后 set + 落盘）。
 * 面板这条路径没有那个 store，所以刷新结果**只存在于本次响应里**。
 * 这就是为什么 UI 必须把返回的 usage 就地合并进本地列表状态，
 * 而不能「刷完再拉一次 /accounts」—— 重拉只会拿回盘上的旧值。
 */
export async function checkAccount(id: string): Promise<CheckAccountResponse> {
  return panelRequest<CheckAccountResponse>('POST', `/accounts/${encodeURIComponent(id)}/check`)
}

/** `check` 的响应形状（`accountService/check.ts:buildCheckResult` 的 data 段，取面板用到的字段） */
export interface CheckAccountResponse {
  success?: boolean
  data?: {
    status?: string
    email?: string
    userId?: string
    subscriptionTitle?: string
    usage?: {
      current?: number
      limit?: number
      percentUsed?: number
      baseLimit?: number
      baseCurrent?: number
      freeTrialLimit?: number
      freeTrialCurrent?: number
      nextResetDate?: string
    }
    subscription?: {
      type?: string
      title?: string
      daysRemaining?: number
    }
  }
}

/** 刷新 Token */
export async function refreshToken(id: string): Promise<void> {
  await panelRequest('POST', `/accounts/${encodeURIComponent(id)}/refresh-token`)
}

/**
 * 切换到该账号（写本机 IDE 的 SSO 缓存）。
 *
 * ⚠️ 写的是**运行桌面端那台电脑**的登录态，不是手机。routes.ts 已注明这是照搬的既有语义。
 * UI 必须把这一点说清楚，否则用户会以为是在手机上登录。
 */
export async function switchToIde(id: string): Promise<void> {
  await panelRequest('POST', `/accounts/${encodeURIComponent(id)}/switch`)
}

/** 切换到该账号（CLI 侧） */
export async function switchToCli(id: string): Promise<void> {
  await panelRequest('POST', `/accounts/${encodeURIComponent(id)}/switch-cli`)
}

/** 退出本机 IDE 登录态（清 SSO 缓存），无 accountId */
export async function logoutLocalIde(): Promise<void> {
  await panelRequest('POST', '/local/logout')
}

/** 账号可用模型列表 */
export async function fetchModels(id: string): Promise<ModelsResponse> {
  return panelRequest<ModelsResponse>('GET', `/accounts/${encodeURIComponent(id)}/models`)
}

export interface ModelsResponse {
  success?: boolean
  error?: string
  models?: Array<{
    id: string
    name?: string
    rateMultiplier?: number
    rateUnit?: string
  }>
}

/** 可用订阅方案 */
export async function fetchSubscriptions(id: string): Promise<SubscriptionsResponse> {
  return panelRequest<SubscriptionsResponse>(
    'GET',
    `/accounts/${encodeURIComponent(id)}/subscriptions`
  )
}

export interface SubscriptionsResponse {
  success?: boolean
  error?: string
  plans?: unknown
  disclaimer?: unknown
}

/**
 * 超额开关。
 *
 * 服务端 `setAccountOverage` **原样透传上游结果**（不包 `{success}`），
 * 所以这里不能断言 `success === true`；只要 HTTP 2xx 就算调用成功。
 */
export async function setOverage(id: string, enabled: boolean): Promise<void> {
  await panelRequest('POST', `/accounts/${encodeURIComponent(id)}/overage`, { enabled })
}
