/**
 * webPanel 路由表 —— 桌面端操作到 HTTP 端点的一对一映射
 *
 * 决策卡 §1 不变量 1：**本文件不含任何业务逻辑**。每个 handler 只做三件事：
 *   ① 从 accountId 解析出账号（含内部取 token）② 调 `accountService` 的对应函数
 *   ③ 把结果经 `respond.ts` 出口写回，并把业务层的错误形状归一成稳定错误码。
 *
 * ## 为什么端点按 accountId 寻址（决策卡 §3 第二处照搬豁免）
 *
 * 桌面端多个 handler 把 `accessToken` 作为**第一个入参**
 * （`account-get-models` / `account-get-subscriptions` / `account-get-subscription-url` /
 * `account-set-overage`）。renderer 与 main 同机走 IPC，这没问题。
 *
 * 但 HTTP 端点若照抄这个签名，浏览器就必须把 token 经局域网发过来 —— 直接违反
 * §1 负条件 4。所以面板一律 `/:accountId/...` 寻址，token 由主进程内部按 id 从
 * store 取出后再交给 `accountService`。这是**有意分歧**，不是不一致的疏漏：
 * 照抄签名恰好是最省力、且看起来最「忠于原实现」的做法，所以必须写明。
 *
 * ## 错误码归一收在这里，不下沉业务层
 *
 * `accountService/types.ts:214` 已明确：业务层刻意保留现有 IPC 响应的**不统一**形状
 * （有的 `error` 是 string，有的是 `{ message }`），26 个 renderer 组件已适配它。
 * 面板的稳定错误码契约（决策卡 §3）在这一层做，不改业务层返回值。
 */
import type http from 'node:http'
import { sendJson, sendError, type PanelErrorCode } from './respond'
import { projectAccountsBlob, type AccountListPayload } from './dto'

/** 业务层的通用返回形状 —— 两种 error 形状都要能吃（见文件头说明） */
type ServiceLike = {
  success?: boolean
  error?: string | { message?: string; isBanned?: boolean }
  [k: string]: unknown
}

/**
 * 路由层需要的账号能力。全部由 `index.ts` 注入实际实现（`accountService/*` 的函数
 * 加上已装配好的 deps），因此本文件**不 import electron、不碰 store**。
 *
 * 注意 identity 形状：调用方传的是 `AccountApiIdentity`（含 accessToken）——
 * token 是**主进程内部**从 store 取的，从未过网。
 */
export interface PanelAccountIdentity {
  accessToken: string
  region?: string
  profileArn?: string
  machineId?: string
  provider?: string
  authMethod?: string
  accountId?: string
}

export interface PanelRouteDeps {
  /** `accountService/accounts.ts:loadAccounts` —— 返回整表 blob（含明文凭据，绝不直出） */
  loadAccountsBlob: () => Promise<unknown>
  /** `accountService/check.ts:checkAccountStatus` —— 用户日常的「刷新额度」 */
  checkAccountStatus: (account: unknown) => Promise<ServiceLike>
  /** `accountService/refresh.ts:refreshAccountToken` */
  refreshAccountToken: (account: unknown) => Promise<ServiceLike>
  /** `accountService/switch.ts:switchAccountToIde` —— ⚠️ 写的是主进程所在机器的 SSO 缓存 */
  switchAccountToIde: (credentials: unknown) => Promise<ServiceLike>
  /** `accountService/switchCli.ts:switchAccountToCli` */
  switchAccountToCli: (credentials: unknown) => Promise<ServiceLike>
  /** `accountService/switch.ts:logoutAccount` */
  logoutFromIde: () => Promise<ServiceLike>
  /** `accountService/subscription.ts:getAccountModels` */
  getAccountModels: (identity: PanelAccountIdentity) => Promise<ServiceLike>
  /** `accountService/subscription.ts:getAccountSubscriptions` */
  getAccountSubscriptions: (identity: PanelAccountIdentity) => Promise<ServiceLike>
  /** `accountService/subscription.ts:getAccountSubscriptionUrl` */
  getAccountSubscriptionUrl: (
    identity: PanelAccountIdentity,
    subscriptionType?: string
  ) => Promise<ServiceLike>
  /** `accountService/subscription.ts:setAccountOverage` */
  setAccountOverage: (identity: PanelAccountIdentity, enabled: boolean) => Promise<ServiceLike>
}

/** 已解析的请求上下文（路径已去掉 `/panel` 前缀） */
export interface PanelRequestContext {
  method: string
  /** 去前缀后的路径，例如 `/api/accounts/acc-1/check` */
  path: string
  /** 已解析的 JSON body（非 JSON / 空 body → undefined） */
  body?: Record<string, unknown>
}

/** 业务层返回的 error 归一成一句话（两种形状都吃） */
function errorMessage(result: ServiceLike | undefined): string | undefined {
  const e = result?.error
  if (typeof e === 'string') return e
  if (e && typeof e === 'object' && typeof e.message === 'string') return e.message
  return undefined
}

/**
 * 业务层失败 → 稳定错误码 + HTTP 状态。
 *
 * 归一规则刻意保守：只有能确定语义的才细分，其余一律 `INTERNAL_ERROR` 500。
 * **绝不回传上游原始报文** —— message 只给已归一的短句（`sendJson` 的强制脱敏是第二道）。
 */
function mapServiceFailure(result: ServiceLike | undefined): {
  status: number
  code: PanelErrorCode
  message?: string
} {
  const msg = errorMessage(result)
  const e = result?.error
  const isBanned = typeof e === 'object' && e !== null && e.isBanned === true
  if (isBanned) {
    // 封禁不是可重试失败，语义上属凭据不可用
    return { status: 400, code: 'INVALID_CREDENTIAL', message: msg }
  }
  if (msg && /refresh\s*token|刷新/i.test(msg)) {
    return { status: 502, code: 'TOKEN_REFRESH_FAILED', message: msg }
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: msg }
}

/** 统一把 `accountService` 的 ServiceLike 结果写回 */
function respondService(res: http.ServerResponse, result: ServiceLike | undefined): void {
  if (result?.success === false) {
    const { status, code, message } = mapServiceFailure(result)
    sendError(res, status, code, message)
    return
  }
  sendJson(res, 200, result ?? { success: true })
}

/** 从整表 blob 里取出某个账号的原始记录（含凭据，仅供主进程内部使用） */
function findAccountRecord(blob: unknown, accountId: string): Record<string, unknown> | null {
  if (!blob || typeof blob !== 'object') return null
  const raw = (blob as Record<string, unknown>).accounts
  if (!raw || typeof raw !== 'object') return null
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry && typeof entry === 'object' && (entry as Record<string, unknown>).id === accountId) {
        return entry as Record<string, unknown>
      }
    }
    return null
  }
  const hit = (raw as Record<string, unknown>)[accountId]
  return hit && typeof hit === 'object' ? (hit as Record<string, unknown>) : null
}

/**
 * 把账号记录组装成 `accountService/subscription.ts` 需要的 identity。
 *
 * **token 在这里第一次也是唯一一次离开 store，去向是同进程内的函数调用，不是网络。**
 */
function toIdentity(
  accountId: string,
  account: Record<string, unknown>
): PanelAccountIdentity | null {
  const cred = (account.credentials ?? {}) as Record<string, unknown>
  const accessToken = typeof cred.accessToken === 'string' ? cred.accessToken : undefined
  if (!accessToken) return null
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  return {
    accessToken,
    accountId,
    region: str(cred.region),
    profileArn: str(account.profileArn) ?? str(cred.profileArn),
    machineId: str(account.machineId),
    provider: str(cred.provider) ?? str(account.idp),
    authMethod: str(cred.authMethod)
  }
}

/** `/api/accounts/:id/...` 的路径解析 → { accountId, action } */
function parseAccountPath(path: string): { accountId: string; action: string } | null {
  const m = /^\/api\/accounts\/([^/]+)(?:\/([^/]+))?$/.exec(path)
  if (!m) return null
  return { accountId: decodeURIComponent(m[1]), action: m[2] ?? '' }
}

/** 单飞去重键 → 进行中的 promise（防手机端连点重复执行副作用，决策卡 §3 幂等） */
const inFlight = new Map<string, Promise<ServiceLike>>()

/**
 * 同一 key 的并发请求共享同一次执行（single-flight）。
 *
 * 决策卡 §3：有副作用的操作（切换 / 删除 / 刷新）同一 id 的并发或重复请求必须去重，
 * 否则手机端双击会真的执行两次。
 */
async function singleFlight(key: string, run: () => Promise<ServiceLike>): Promise<ServiceLike> {
  const existing = inFlight.get(key)
  if (existing) return existing
  const task = run().finally(() => inFlight.delete(key))
  inFlight.set(key, task)
  return task
}

/** 列表：`load-accounts` → 白名单投影后出网 */
async function handleList(res: http.ServerResponse, deps: PanelRouteDeps): Promise<void> {
  const blob = await deps.loadAccountsBlob()
  const payload: AccountListPayload = projectAccountsBlob(blob)
  sendJson(res, 200, payload)
}

/**
 * 路由分派。
 *
 * @returns true = 本函数已处理（响应已写出）；false = 路径不属于 API 命名空间，交给调用方兜底
 */
export async function routePanelApi(
  ctx: PanelRequestContext,
  res: http.ServerResponse,
  deps: PanelRouteDeps
): Promise<boolean> {
  const { method, path } = ctx

  // 账号列表（读）
  if (path === '/api/accounts' && method === 'GET') {
    await handleList(res, deps)
    return true
  }

  // 退出本机 IDE 登录态（写，无 accountId）
  if (path === '/api/local/logout' && method === 'POST') {
    respondService(res, await singleFlight('local-logout', () => deps.logoutFromIde()))
    return true
  }

  const parsed = parseAccountPath(path)
  if (!parsed) return false

  const { accountId, action } = parsed
  const blob = await deps.loadAccountsBlob()
  const account = findAccountRecord(blob, accountId)
  if (!account) {
    sendError(res, 404, 'ACCOUNT_NOT_FOUND')
    return true
  }

  // 需要凭据的端点统一在这里取 identity —— 取不到 accessToken 说明账号数据不完整
  const identity = toIdentity(accountId, account)

  switch (`${method} ${action}`) {
    // 刷新额度 / 检查账户信息（桌面端「检查账户信息」）
    case 'POST check':
      respondService(
        res,
        await singleFlight(`check:${accountId}`, () => deps.checkAccountStatus(account))
      )
      return true

    // 刷新 Token（桌面端「刷新 Token」）
    case 'POST refresh-token':
      respondService(
        res,
        await singleFlight(`refresh:${accountId}`, () => deps.refreshAccountToken(account))
      )
      return true

    // 切换到此账号（桌面端「切换到此账号」）
    // ⚠️ 写的是**运行主进程那台机器**的 SSO 缓存，不是浏览器所在设备。
    //    这是照搬原则下的既有语义（switch.ts 文件头已注明），不在本轮改动。
    case 'POST switch':
      respondService(
        res,
        await singleFlight(`switch:${accountId}`, () =>
          deps.switchAccountToIde({ ...(account.credentials as object), accountId })
        )
      )
      return true

    case 'POST switch-cli':
      respondService(
        res,
        await singleFlight(`switch-cli:${accountId}`, () =>
          deps.switchAccountToCli({ ...(account.credentials as object), accountId })
        )
      )
      return true

    // 以下四个是「桌面端把 accessToken 当第一个入参」的那批 —— 面板按 id 寻址
    case 'GET models':
      if (!identity) {
        sendError(res, 400, 'INVALID_CREDENTIAL', '账号缺少可用凭据')
        return true
      }
      respondService(res, await deps.getAccountModels(identity))
      return true

    case 'GET subscriptions':
      if (!identity) {
        sendError(res, 400, 'INVALID_CREDENTIAL', '账号缺少可用凭据')
        return true
      }
      respondService(res, await deps.getAccountSubscriptions(identity))
      return true

    case 'GET subscription-url':
      if (!identity) {
        sendError(res, 400, 'INVALID_CREDENTIAL', '账号缺少可用凭据')
        return true
      }
      respondService(
        res,
        await deps.getAccountSubscriptionUrl(
          identity,
          typeof ctx.body?.subscriptionType === 'string' ? ctx.body.subscriptionType : undefined
        )
      )
      return true

    case 'POST overage':
      if (!identity) {
        sendError(res, 400, 'INVALID_CREDENTIAL', '账号缺少可用凭据')
        return true
      }
      respondService(res, await deps.setAccountOverage(identity, ctx.body?.enabled === true))
      return true

    default:
      return false
  }
}
