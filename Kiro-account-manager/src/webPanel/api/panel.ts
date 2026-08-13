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

/** 手机编辑账号时的分组选项；服务端只返回这四个白名单字段。 */
export interface PanelAccountGroup {
  id: string
  name: string
  color?: string
  order: number
}

export async function fetchAccountGroups(): Promise<{ groups: PanelAccountGroup[] }> {
  return panelRequest('GET', '/account-groups')
}

export interface AccountMutationSummary {
  id: string
  nickname?: string
  groupId?: string
  isActive: boolean
}

export interface AccountMutationResponse {
  success: true
  revision: number
  account: AccountMutationSummary
  /** 写盘成功，但已初始化的运行中反代池未能重建；UI 应提示手动同步。 */
  proxyPoolSyncPending?: boolean
}

/**
 * 编辑账号元数据。
 *
 * 刻意只开放 nickname/groupId；凭据不从手机编辑，避免误填 token 后把唯一可用账号
 * 覆盖掉。expectedRevision 来自操作前新拉的 `/accounts` 快照，桌面端同时改动时服务端
 * 返回 STALE_REVISION，而不是让后到的手机请求静默覆盖。
 */
export async function updateAccountMetadata(
  id: string,
  expectedRevision: number,
  patch: { nickname?: string | null; groupId?: string | null }
): Promise<AccountMutationResponse> {
  return panelRequest('PATCH', `/accounts/${encodeURIComponent(id)}`, {
    expectedRevision,
    ...patch
  })
}

export interface AccountDeleteResponse {
  success: true
  revision: number
  /** 当前服务进程内可撤销到何时（epoch ms）。服务重启会提前失效。 */
  undoUntil: number
  /** 写盘成功，但已初始化的运行中反代池未能重建；UI 应提示手动同步。 */
  proxyPoolSyncPending: boolean
}

export async function deleteAccount(
  id: string,
  expectedRevision: number
): Promise<AccountDeleteResponse> {
  return panelRequest('POST', `/accounts/${encodeURIComponent(id)}/delete`, {
    expectedRevision
  })
}

export async function restoreDeletedAccount(id: string): Promise<AccountMutationResponse> {
  return panelRequest('POST', `/accounts/${encodeURIComponent(id)}/restore`)
}

/**
 * 轮换唯一 adminKey。
 *
 * 成功响应后当前会话已经失效；`key` 只交付这一次。调用方必须先让用户保存新值，
 * 再切回登录页，不能收到响应就立刻卸载界面（那会把用户永久锁在门外）。
 */
export async function rotateAdminKey(): Promise<{ key: string }> {
  return panelRequest('POST', '/admin-key/rotate')
}

/**
 * 导入 ksk_ 密钥。
 *
 * 服务端调的是 `accountService/importApiKey.ts` —— 与桌面端「添加账号」**同一份用例**。
 * 所以判重语义在两端完全一致：同一个密钥在手机上导入过，桌面端再导就是 `ALREADY_EXISTS`。
 *
 * ⚠️ 密钥经局域网发往主进程，这是不可避免的（用户就是在手机上粘贴它）。
 * 面板整体已在 HTTP 上，adminKey + 会话 cookie 是这条链的保护。
 * 但**返回体里的 `label` 是掩码**，密钥不会再回显到浏览器。
 *
 * 即使一条都没成功也是 200 —— 「3 个里 2 个已存在」是要逐条展示的业务结果，不是请求失败。
 */
export async function importApiKeys(
  rawInput: string,
  region?: string
): Promise<ApiKeyImportResponse> {
  return panelRequest<ApiKeyImportResponse>('POST', '/accounts', {
    apiKeys: rawInput,
    ...(region !== undefined ? { region } : {})
  })
}

/** 单条密钥的处理结果码。**分支只看 code，不看文案** */
export type ApiKeyImportCode =
  | 'IMPORTED'
  | 'BAD_FORMAT'
  | 'INVALID'
  | 'SUSPENDED'
  | 'INDETERMINATE'
  | 'MISSING_FINGERPRINT'
  | 'ALREADY_EXISTS'
  | 'VERIFY_ERROR'
  | 'WRITE_CONFLICT'

/** `main/accountService/importApiKey.ts:ApiKeyImportResult` 的浏览器侧形状 */
export interface ApiKeyImportResponse {
  total: number
  imported: number
  failed: number
  results: Array<{
    /** 掩码标签（`ksk_abcd…wxyz`）—— 服务端保证不含明文 */
    label: string
    code: ApiKeyImportCode
    reason?: string
    accountId?: string
  }>
  emptyInput?: boolean
  revision?: number
  staleRevision?: number
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

// ============ 反代（用户日常的第三、四步）============

/**
 * 反代状态。
 *
 * `running` 是**真实读数** —— 服务端读 `ProxyServer.isRunning()`（即 server 句柄
 * 是否存在），不是「客户端发过启动请求所以应该在跑」。UI 必须以它为准，
 * 绝不能在发出启动请求后乐观地把开关拨到「运行中」。
 */
/**
 * One release action inside a hold round.
 *
 * `outcome` is the field that matters most when reading this on a phone:
 * `resumed-and-served` means the release actually got an account and forwarded the
 * request, so the client received real content; `re-held` means it found no account
 * and the request went straight back to being held, so the client only saw heartbeats.
 * A run of `re-held` rows tells you the release count is not keeping the request alive.
 */
export interface PanelHoldRelease {
  at: number
  trigger: 'auto' | 'manual' | 'pool-available' | 'poll'
  outcome: 'pending' | 'resumed-and-served' | 're-held' | 'ended'
  outcomeAt: number | null
}

/** One round of holding: from "nothing held" to "nothing held" again. */
export interface PanelHoldEpisode {
  id: number
  reason: 'account-blocked' | 'account-auth-failure' | 'pool-empty'
  detail: string[]
  startedAt: number
  endedAt: number | null
  /** 本轮全部放行动作数；不会随 releases 展示明细的 50 条上限截断。 */
  totalReleaseCount: number
  /** 本轮由定时器触发的放行动作数。 */
  totalAutoReleaseCount: number
  releases: PanelHoldRelease[]
}

export interface ProxyStatus {
  success?: boolean
  running: boolean
  port?: number
  host?: string
  /** 多账号轮询是否开启。面板只做单账号指定，此值为 true 时选号按钮应说明它只移动轮询起点 */
  enableMultiAccount: boolean
  /** 单账号模式下用户指定的账号 id；多账号模式为 undefined */
  selectedAccountId?: string
  selectedAccountEmail?: string
  poolSize: number
  availableCount: number
  /** 已服务请求数 —— 停止前展示给用户，让他自己判断现在停是否合适 */
  totalRequests: number
  successRequests: number
  failedRequests: number

  /**
   * 自动定时放行是否启用。
   *
   * 这是**调度器的真实读数**，不是配置值 —— 「配置开着」与「调度器真的在跑」是
   * 两件事（挂起门闸本身关掉时，自动放行没有对象可放）。所以界面显示「已开启」
   * 的判据只能是它。
   *
   * 三个自动放行字段**必填**：服务端 `panelProxyDeps.ts:PanelProxyStatus` 在所有
   * 分支（含反代未初始化）都发全字段，这里如实照抄那个契约。留 `?` 会让「将来
   * 某次改动漏发字段」编译期无声，而 UI 的 `?? 0` / 默认关闭会把契约漂移渲染成
   * 一个合法业务态（「未开启」「已放行 0 次」）—— 用户看到一个平静的错误读数。
   */
  autoReleaseEnabled: boolean
  /**
   * 下次自动放行的**绝对** epoch ms；`null` = 没有下一次。
   *
   * ⚠️ 倒计时由本地 `nextAutoReleaseAt - Date.now()` 每秒渲染，**不轮询服务端**。
   * 服务端只给绝对时间戳：倒计时是连续量，轮询它会让请求频率被刷新率绑架。
   *
   * `null` 是**取值**而非「字段缺失」，故必填且保留 `| null` —— 「没有下一次」由
   * 服务端明确表态，不靠字段不存在暗示。`null` 与 `0` 语义也不同：`0` 是合法
   * epoch（1970），把「无」表达成 `0` 会渲染出一个巨大的负倒计时。
   * 判空必须用 `== null`，不能用 falsy 判断。
   */
  nextAutoReleaseAt: number | null
  /** 本次反代启动以来自动放行的**周期次数**（不是条目数）；手动放行不计入 */
  autoReleaseCount: number
  /**
   * Hold timeline: the round in progress plus recently finished rounds.
   * Required for the same reason as the three fields above -- the server sends them
   * on every branch, so a missing field means the contract drifted, and that must
   * fail at compile time instead of rendering as a calm "nothing held".
   */
  currentEpisode: PanelHoldEpisode | null
  recentEpisodes: PanelHoldEpisode[]
}

export async function fetchProxyStatus(): Promise<ProxyStatus> {
  return panelRequest<ProxyStatus>('GET', '/proxy/status')
}

/**
 * 启动反代。
 *
 * **不接受任何参数** —— 端口 / API Key / 模型映射留在桌面端（一次性配置，
 * 且 `proxy-update-config` 的副作用分支多，手机误触代价大）。
 * 服务端内部会先同步账号池再启动；池为空时返回 `EMPTY_POOL` 而**不是**启动成功
 * （空池启动会「起来了、状态正常、每个请求都失败」）。
 */
export async function startProxy(): Promise<{
  running?: boolean
  port?: number
  poolSize?: number
}> {
  return panelRequest('POST', '/proxy/start')
}

/**
 * 停止反代。
 *
 * ⚠️ 会掐断在飞请求 —— 与桌面端行为一致（桌面端 `ProxyPanel.tsx:352` 也是直接停）。
 * 面板刻意**不**引入独有的优雅停止：那会让两端行为分叉。取而代之，UI 在停止前
 * 展示 `totalRequests`，让用户自己判断。
 */
export async function stopProxy(): Promise<{ running?: boolean }> {
  return panelRequest('POST', '/proxy/stop')
}

/** 重新同步账号池（改了账号后刷新池，不启停） */
export async function syncProxyPool(): Promise<{ poolSize?: number }> {
  return panelRequest('POST', '/proxy/sync-pool')
}

/**
 * 指定反代使用某个账号。
 *
 * 服务端内部是**三步**（入池刷凭据 → 单账号模式写 `selectedAccountIds` → 移指针并
 * 作废会话粘性）。只做其中任一步会产生「接口返回成功、池里也有这个号、但反代
 * 仍打旧号」的失效，所以客户端只调这一个端点，绝不自己拆开编排。
 */
export async function setProxyActiveAccount(
  accountId: string
): Promise<{ mode?: 'single' | 'multi'; accountId?: string; email?: string }> {
  return panelRequest('POST', '/proxy/active-account', { accountId })
}

/**
 * 立刻放行全部挂起请求。
 *
 * 账号不可用时反代会把客户端请求挂起等待恢复；「放行」让它们立刻用新号重试。
 * 服务端调的是与桌面端按钮、自动放行调度器**同一个**入口（`releaseAll()`）。
 *
 * **不接受任何参数** —— 手机端只有「立刻放一次」这一个动作，改间隔 / 改开关留在
 * 桌面端（与 `startProxy` 同一理由：配置类副作用从手机误触代价大于收益）。
 *
 * 语义要点：
 * - 没有挂起条目时返回 `{ released: 0 }` 而**不是错误** —— 放行本身是幂等的。
 *   所以 UI 不能把 `released === 0` 当失败处理，它只是「当时没东西可放」。
 * - 反代未运行 → 409 `PROXY_NOT_RUNNING`（由 `PanelApiError` 承载）。
 *
 * `released` **必填**：`panelRequest` 已把所有非 2xx 归一成抛异常，所以本函数只在
 * 成功路径 resolve，而服务端成功路径（`panelProxyDeps.ts:proxyReleaseHeld`）恒带
 * 该字段。留 `?` 会让「将来漏发它」编译期无声，UI 的 `?? 0` 再把它渲染成
 * 「当前没有挂起的请求」—— 一句看起来完全正常的话，掩盖掉放行数其实未知这件事。
 */
export async function releaseHeldRequests(): Promise<{ released: number }> {
  return panelRequest('POST', '/proxy/release-held')
}
